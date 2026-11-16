// Paperbook: biblioteca, importación y orquestación de la sincronización.
import { store, newId, foldText } from './store.js';
import { Viewer, makeThumb } from './viewer.js';
import { drive } from './drive.js';
import { indexSoon, indexPending, searchContent } from './search.js';
import { capture, fromHtmlFile, getProxy, setProxy, DEFAULT_PROXY } from './web.js';
import { icon, el, toast, menu, dialog, askText, askConfirm } from './ui.js';

const $lib = document.getElementById('library');
const $viewer = document.getElementById('viewer');
const TYPES = { pdf: ['PDF', 'file'], web: ['Web', 'globe'], image: ['Imagen', 'image'], canvas: ['Lienzo', 'canvas'] };
const ui = { type: '', folder: '', q: '', raw: '', hits: new Map() };
let searchTimer, searchSeq = 0;
let viewer = null;

// ---------- biblioteca ----------
const $grid = el('div', { class: 'grid' });
const $chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por tipo' });
const $folder = el('select', { class: 'folder', 'aria-label': 'Carpeta', onchange: (e) => { ui.folder = e.target.value; renderLib(); } });
const $drive = el('button', { class: 'btn drive', onclick: () => driveDialog() });
const $install = el('button', { class: 'btn install', hidden: true, html: icon('download') + '<span>Instalar app</span>', onclick: () => installApp() });
let installEvent = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function installApp() {
  if (installEvent) {
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;
    if (outcome === 'accepted') $install.hidden = true;
    return;
  }
  dialog('Instalar Paperbook', (d, close) => {
    d.append(
      el('p', {}, isIOS()
        ? 'En iPad o iPhone, abre esta página en Safari, toca el botón Compartir (el cuadrado con la flecha) y elige «Añadir a pantalla de inicio».'
        : 'Abre el menú del navegador (⋮) y elige «Instalar aplicación» o «Añadir a pantalla de inicio». Funciona en Chrome, Edge y Samsung Internet.'),
      el('p', { class: 'hint' }, 'Una vez instalada, Paperbook se abre a pantalla completa con su propio icono y funciona sin conexión.'),
      el('div', { class: 'row end' }, el('button', { class: 'btn primary', onclick: () => close(null) }, 'Entendido')));
  });
}

function setupInstall() {
  if (standalone()) return;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $install.hidden = false; });
  addEventListener('appinstalled', () => { $install.hidden = true; toast('Paperbook instalada.'); });
  if (isIOS()) $install.hidden = false; // Safari no ofrece instalación automática
}

const $file = el('input', {
  type: 'file', multiple: true, hidden: true, accept: 'application/pdf,image/*,.html,.htm,text/html',
  onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; },
});

function buildLib() {
  $lib.append(
    el('header', { class: 'top' },
      el('h1', { class: 'brand' }, 'Paperbook'),
      el('label', { class: 'search', html: icon('search') },
        el('input', {
          type: 'search', placeholder: 'Buscar en títulos y contenido…', 'aria-label': 'Buscar en títulos y contenido',
          oninput: (e) => {
            ui.raw = e.target.value.trim();
            ui.q = foldText(ui.raw);
            ui.hits = new Map();
            renderLib();
            clearTimeout(searchTimer);
            const seq = ++searchSeq;
            searchTimer = setTimeout(async () => {
              const hits = await searchContent(ui.raw);
              if (seq === searchSeq) { ui.hits = hits; renderLib(); }
            }, 250);
          },
        })),
      $install, $drive,
      el('button', { class: 'btn primary', html: icon('plus') + '<span>Añadir</span>', onclick: (e) => addMenu(e.currentTarget) })),
    el('div', { class: 'filters' }, $chips, $folder),
    $grid, $file);
  for (const [id, label] of [['', 'Todos'], ...Object.entries(TYPES).map(([k, v]) => [k, v[0]])]) {
    $chips.append(el('button', { class: 'chip', 'data-t': id, onclick: () => { ui.type = id; renderLib(); } }, label));
  }
  // arrastrar y soltar archivos
  addEventListener('dragover', (e) => { if (!viewer) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (viewer) return;
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });
}

const fmtDate = (t) => new Date(t).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
const recency = (d) => Math.max(d.openedAt || 0, d.updatedAt || 0, d.createdAt || 0);

function renderLib() {
  const all = store.visible();
  const folders = [...new Set(all.map((d) => d.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (ui.folder && !folders.includes(ui.folder)) ui.folder = '';
  $folder.replaceChildren(el('option', { value: '' }, 'Todas las carpetas'),
    ...folders.map((f) => el('option', { value: f, selected: f === ui.folder }, f)));
  $folder.hidden = !folders.length;
  for (const c of $chips.children) c.setAttribute('aria-pressed', c.dataset.t === ui.type);

  const docs = all
    .filter((d) => (!ui.type || d.type === ui.type) && (!ui.folder || d.folder === ui.folder) &&
      (!ui.q || foldText(d.title).includes(ui.q) || foldText(d.folder || '').includes(ui.q) || ui.hits.has(d.id)))
    .sort((a, b) => recency(b) - recency(a));

  if (!docs.length) {
    $grid.replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, all.length ? 'Nada coincide con el filtro' : 'Tu biblioteca está vacía'),
      el('p', {}, all.length ? 'Prueba con otra búsqueda o cambia de carpeta.'
        : 'Sube un PDF, guarda una página web o abre un lienzo en blanco para empezar a escribir.'),
      all.length ? null : el('div', { class: 'row' },
        el('button', { class: 'btn primary', html: icon('upload') + '<span>Subir archivos</span>', onclick: () => $file.click() }),
        el('button', { class: 'btn', html: icon('globe') + '<span>Guardar página web</span>', onclick: () => webDialog() }),
        el('button', { class: 'btn', html: icon('canvas') + '<span>Nuevo lienzo</span>', onclick: () => newCanvas() }))));
    return;
  }
  $grid.replaceChildren(...docs.map(card));
}

function card(d) {
  const [label, ic] = TYPES[d.type] || ['Archivo', 'file'];
  const thumb = d.thumb
    ? el('img', { src: d.thumb, alt: '', loading: 'lazy' })
    : el('div', { class: 'ph ' + d.type, html: icon(ic) });
  const hit = ui.q ? ui.hits.get(d.id) : null;
  const href = '#/d/' + d.id + (hit ? '?q=' + encodeURIComponent(ui.raw) : '');
  const c = el('article', { class: 'card' },
    el('a', { class: 'open', href, 'aria-label': 'Abrir ' + d.title },
      el('div', { class: 'thumb' }, thumb),
      el('div', { class: 'info' },
        el('h3', {}, d.title),
        el('p', {}, [label, d.folder, fmtDate(recency(d)), d.noBlob ? 'pendiente de descarga' : null].filter(Boolean).join(' · ')),
        hit ? el('p', { class: 'snip' },
          el('strong', {}, `${hit.n} ${hit.n === 1 ? 'coincidencia' : 'coincidencias'}${d.type === 'pdf' ? ' · p. ' + (hit.page + 1) : ''}`),
          ' ' + hit.snip) : null)),
    el('button', { class: 'ib kebab', title: 'Opciones', 'aria-label': 'Opciones de ' + d.title, html: icon('more'), onclick: (e) => cardMenu(e.currentTarget, d) }));
  return c;
}

function cardMenu(anchor, d) {
  menu(anchor, [
    {
      icon: 'edit', label: 'Renombrar', onClick: async () => {
        const v = await askText('Renombrar', { value: d.title });
        if (v) { d.title = v; d.updatedAt = Date.now(); await store.saveDoc(d); }
      },
    },
    {
      icon: 'folder', label: 'Mover a carpeta…', onClick: async () => {
        const fs = [...new Set(store.visible().map((x) => x.folder).filter(Boolean))];
        const v = await askText('Carpeta', {
          value: d.folder || '', placeholder: 'p. ej. Cirugía',
          hint: fs.length ? 'Carpetas existentes: ' + fs.join(', ') + '. Déjalo vacío para quitarla.' : 'Escribe un nombre para crear la carpeta.',
        });
        if (v != null) { d.folder = v; d.updatedAt = Date.now(); await store.saveDoc(d); }
      },
    },
    d.type !== 'canvas' && !d.noBlob && {
      icon: 'download', label: 'Descargar original', onClick: async () => {
        const blob = await store.getBlob(d.id);
        const ext = { pdf: '.pdf', web: '.html' }[d.type] || '';
        const a = el('a', { href: URL.createObjectURL(blob), download: d.title + ext });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      },
    },
    '-',
    {
      icon: 'trash', danger: true, label: 'Eliminar', onClick: async () => {
        const where = drive.connected ? ' Se eliminará también de Google Drive y de tus otros dispositivos.' : '';
        if (!(await askConfirm('Eliminar documento', `«${d.title}» y sus anotaciones se eliminarán.${where}`))) return;
        if (!d.drive?.metaId && !d.drive?.contentId) return store.purgeDoc(d.id).then(renderLib);
        d.deleted = true;
        d.updatedAt = Date.now();
        d.thumb = null;
        await store.delBlob(d.id);
        await store.delAnn(d.id);
        await store.delText(d.id);
        await store.saveDoc(d);
      },
    },
  ]);
}

// ---------- añadir documentos ----------
function addMenu(anchor) {
  menu(anchor, [
    { icon: 'upload', label: 'Subir archivos (PDF, imágenes, HTML)', onClick: () => $file.click() },
    { icon: 'globe', label: 'Guardar página web…', onClick: () => webDialog() },
    { icon: 'canvas', label: 'Nuevo lienzo en blanco', onClick: () => newCanvas() },
  ]);
}

async function createDoc(fields, blob) {
  const now = Date.now();
  const d = { id: newId(), createdAt: now, updatedAt: now, folder: ui.folder || '', ...fields };
  if (blob) {
    d.size = blob.size;
    d.mime = blob.type;
    await store.putBlob(d.id, blob);
    d.thumb = await makeThumb(d.type, blob);
  }
  await store.saveDoc(d);
  indexSoon(d);
  return d;
}

async function addFiles(files) {
  let ok = 0;
  const t = files.length ? toast('Importando…', { ms: 0 }) : null;
  for (const f of files) {
    const name = f.name.replace(/\.[^.]+$/, '');
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        await createDoc({ title: name, type: 'pdf' }, new Blob([f], { type: 'application/pdf' }));
      } else if (f.type.startsWith('image/')) {
        await createDoc({ title: name, type: 'image' }, f);
      } else if (f.type === 'text/html' || /\.html?$/i.test(f.name)) {
        const w = await fromHtmlFile(f);
        await createDoc({ title: w.title || name, type: 'web' }, w.blob);
      } else {
        toast(`«${f.name}»: formato no compatible. Usa PDF, imagen o HTML.`, { error: true });
        continue;
      }
      ok++;
    } catch (e) {
      console.warn(e);
      toast(`No se pudo importar «${f.name}»: ${e.message}`, { error: true });
    }
  }
  t?.close();
  if (ok) toast(ok === 1 ? 'Documento añadido.' : `${ok} documentos añadidos.`);
}

async function newCanvas() {
  const title = await askText('Nuevo lienzo', { value: 'Notas ' + fmtDate(Date.now()), ok: 'Crear' });
  if (!title) return;
  const d = await createDoc({ title, type: 'canvas', pages: 1, paper: 'lines' });
  location.hash = '#/d/' + d.id;
}

function webDialog(prefill = '') {
  return dialog('Guardar página web', (dlg, close) => {
    const input = el('input', { type: 'url', placeholder: 'https://…', value: prefill, required: true, inputmode: 'url' });
    const status = el('p', { class: 'hint', 'aria-live': 'polite' },
      'Se guarda una copia para leerla y anotarla sin conexión. Si el sitio bloquea la descarga directa, se usa el proxy configurado en Ajustes' +
      (getProxy() ? ` (${new URL(getProxy()).hostname}).` : ' (ninguno).') +
      ' Las páginas que requieren iniciar sesión no se pueden capturar: guárdalas como PDF desde el navegador y súbelas.');
    const go = el('button', { type: 'submit', class: 'btn primary' }, 'Guardar');
    dlg.append(el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        try {
          const w = await capture(input.value.trim(), (m) => (status.textContent = m));
          await createDoc({ title: w.title, type: 'web', sourceUrl: /^https?:/i.test(input.value.trim()) ? input.value.trim() : 'https://' + input.value.trim() }, w.blob);
          toast('Página guardada.');
          close(true);
        } catch (err) {
          status.textContent = 'No se pudo guardar: ' + (err.message || err) + ' Alternativa: en el navegador usa «Imprimir → Guardar como PDF» y sube el PDF.';
          status.classList.add('error');
          go.disabled = false;
        }
      },
    }, input, status,
      el('div', { class: 'row end' },
        el('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancelar'), go)));
  });
}

// ---------- Google Drive ----------
function renderDrive() {
  const s = drive.state;
  const text = {
    off: 'Conectar Drive', idle: 'Sincronizado', syncing: 'Sincronizando…', error: 'Error de Drive', auth: 'Reconectar Drive',
  }[s];
  $drive.innerHTML = icon('cloud') + `<span>${text}</span>`;
  $drive.dataset.state = s;
  $drive.title = drive.message || (drive.lastSync ? 'Última sincronización: ' + new Date(drive.lastSync).toLocaleString('es') : 'Google Drive');
}

function driveDialog() {
  return dialog('Google Drive', (dlg, close) => {
    const id = el('input', { type: 'text', value: drive.clientId, placeholder: 'xxxxxxxx.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false' });
    const proxy = el('input', { type: 'url', value: getProxy(), placeholder: 'vacío = sin proxy' });
    const status = el('p', { class: 'hint' + (drive.state === 'error' || drive.state === 'auth' ? ' error' : '') },
      drive.connected
        ? (drive.message || (drive.lastSync ? 'Conectado. Última sincronización: ' + new Date(drive.lastSync).toLocaleString('es') : 'Conectado.'))
        : 'Tus documentos y anotaciones se guardan en la carpeta «Paperbook» de tu Drive y se sincronizan entre tu tablet y tu computadora.');
    const run = async (fn) => {
      status.classList.remove('error');
      status.textContent = 'Conectando…';
      try {
        await fn();
        status.textContent = 'Sincronizado correctamente.';
        setTimeout(() => close(true), 900);
      } catch (e) {
        status.textContent = e.message || String(e);
        status.classList.add('error');
      }
    };
    dlg.append(
      status,
      el('label', {}, 'ID de cliente OAuth de Google',
        id),
      el('p', { class: 'hint' }, 'Solo se configura una vez. ',
        el('a', { href: 'https://github.com/mwatanabedotto-cell/paperbook#sincronizar-con-google-drive', target: '_blank', rel: 'noopener' }, 'Cómo obtenerlo (5 minutos)')),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn primary', onclick: () => {
            drive.clientId = id.value.trim();
            run(() => drive.connect());
          },
        }, drive.connected ? 'Sincronizar ahora' : 'Conectar con Google'),
        drive.connected ? el('button', { class: 'btn', onclick: () => { drive.disconnect(); close(null); toast('Drive desconectado. Tus documentos siguen en este dispositivo.'); } }, 'Desconectar') : null),
      el('hr'),
      el('label', {}, 'Proxy para guardar páginas web', proxy),
      el('p', { class: 'hint' }, `Recibe la dirección de las páginas que guardas. Predeterminado: ${DEFAULT_PROXY}`),
      el('div', { class: 'row end' },
        el('button', { class: 'btn', onclick: () => { setProxy(proxy.value.trim()); close(null); } }, 'Cerrar')));
  });
}

// ---------- navegación ----------
async function route() {
  const [, id, qs] = /^#\/d\/([^?]+)(?:\?(.*))?$/.exec(location.hash) || [];
  const q = new URLSearchParams(qs || '').get('q') || '';
  if (viewer && viewer.doc.id !== id) {
    const v = viewer;
    viewer = null;
    await v.close();
  }
  if (id && !viewer) {
    const d = store.docs.get(id);
    if (!d || d.deleted) { location.hash = ''; return; }
    $lib.hidden = true;
    $viewer.hidden = false;
    const v = (viewer = new Viewer($viewer, d, () => { if (viewer === v) { viewer = null; location.hash = ''; } }, { q }));
    try {
      await v.init();
      document.title = d.title + ' · Paperbook';
    } catch (e) {
      console.error(e);
      toast('No se pudo abrir: ' + (e.message || e), { error: true });
      viewer = null;
      try { await v.close(); } catch {}
      location.hash = '';
    }
    return;
  }
  if (!id) {
    $viewer.hidden = true;
    $lib.hidden = false;
    document.title = 'Paperbook';
    renderLib();
  }
}

async function main() {
  buildLib();
  await store.init();
  let rt;
  store.on((type) => {
    if (type === 'change') drive.schedule();
    if (type !== 'ann' && !viewer) { clearTimeout(rt); rt = setTimeout(renderLib, 60); }
  });
  drive.onState = renderDrive;
  drive.init();
  addEventListener('hashchange', route);
  await route();

  indexPending(); // indexa el texto de documentos añadidos antes de existir la búsqueda

  // sincronización automática
  if (drive.connected) drive.sync().catch(() => {});
  addEventListener('online', () => drive.schedule(500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - drive.lastSync > 120_000) drive.schedule(500);
    else if (document.visibilityState === 'hidden') viewer?.flush();
  });
  setInterval(() => drive.schedule(0), 5 * 60_000);

  setupInstall();
  // "Abrir con Paperbook" desde el explorador de archivos (app instalada)
  window.launchQueue?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    const before = new Set(store.docs.keys());
    await addFiles(files);
    const added = [...store.docs.keys()].filter((id) => !before.has(id));
    if (added.length === 1) location.hash = '#/d/' + added[0];
  });

  // "Compartir con Paperbook" (Android) o ?url=…
  const sp = new URLSearchParams(location.search);
  const shared = [sp.get('url'), sp.get('text'), sp.get('title')].map((s) => /https?:\/\/\S+/.exec(s || '')?.[0]).find(Boolean);
  if (sp.get('new') === 'canvas') {
    history.replaceState(null, '', location.pathname + location.hash);
    newCanvas();
  }
  if (shared) {
    history.replaceState(null, '', location.pathname + location.hash);
    webDialog(shared);
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
    navigator.serviceWorker?.register('sw.js').catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  toast('Error al iniciar: ' + (e.message || e), { error: true, ms: 0 });
});
