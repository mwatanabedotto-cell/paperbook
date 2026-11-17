// Paperbook: biblioteca, importación y orquestación de la sincronización.
import { store, newId, foldText } from './store.js';
import { Viewer, makeThumb } from './viewer.js';
import { drive } from './drive.js';
import { indexSoon, indexPending, searchContent } from './search.js';
import { p2p } from './p2p.js';
import { spaces, me, MAX_MEMBERS, personHue } from './spaces.js';
import { exportBackup, importBackup, deliver } from './backup.js';
import { capture, fromHtmlFile, getProxy, setProxy, DEFAULT_PROXY } from './web.js';
import { icon, el, toast, menu, dialog, askText, askConfirm } from './ui.js';

const $lib = document.getElementById('library');
const $viewer = document.getElementById('viewer');
const TYPES = { pdf: ['PDF', 'file'], web: ['Web', 'globe'], image: ['Imagen', 'image'], canvas: ['Lienzo', 'canvas'] };
const ui = { type: '', folder: '', tag: '', space: '', q: '', raw: '', hits: new Map() };
let searchTimer, searchSeq = 0;
let viewer = null;

// ---------- biblioteca ----------
const $grid = el('div', { class: 'grid' });
const $chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por tipo' });
const $tagRow = el('div', { class: 'tagrow', role: 'group', 'aria-label': 'Filtrar por etiqueta' });

/** Color estable para cada etiqueta (el mismo en todos los dispositivos). */
function tagHue(t) {
  let h = 0;
  for (const ch of foldText(t)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
const tagChip = (t, attrs = {}) => el(attrs.onclick ? 'button' : 'span', { class: 'tag', style: `--h:${tagHue(t)}`, ...attrs }, t);
const allTags = () => {
  const m = new Map();
  for (const d of store.visible()) for (const t of d.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m].sort((a, b) => a[0].localeCompare(b[0], 'es'));
};
const normTags = (list) => {
  const seen = new Map();
  for (const raw of list) {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (t && !seen.has(foldText(t))) seen.set(foldText(t), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'es'));
};

/** Diálogo para poner y quitar etiquetas de un documento. */
function tagDialog(d) {
  return dialog('Etiquetas', (dlg, close) => {
    const chosen = new Set(d.tags || []);
    const known = allTags().map(([t]) => t);
    const list = el('div', { class: 'tagpick' });
    const draw = () => {
      const tags = normTags([...known, ...chosen]);
      list.replaceChildren(...tags.map((t) => tagChip(t, {
        type: 'button', 'aria-pressed': String(chosen.has(t)),
        onclick: () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); draw(); },
      })));
      if (!tags.length) list.append(el('p', { class: 'hint' }, 'Aún no tienes etiquetas. Escribe la primera abajo.'));
    };
    const input = el('input', { type: 'text', id: 'tag-new', placeholder: 'Nueva etiqueta: p. ej. Cirugía, Revalida, Repasar', autocomplete: 'off', enterkeyhint: 'done' });
    const addTyped = () => {
      const parts = input.value.split(',').map((x) => x.trim()).filter(Boolean);
      for (const t of normTags(parts)) {
        const same = [...known, ...chosen].find((k) => foldText(k) === foldText(t));
        chosen.add(same || t);
      }
      input.value = '';
      draw();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });
    dlg.append(
      el('p', { class: 'hint' }, `«${d.title}». Toca una etiqueta para ponerla o quitarla.`),
      list,
      el('div', { class: 'row tagadd' }, input, el('button', { type: 'button', class: 'btn', onclick: addTyped }, 'Añadir')),
      el('div', { class: 'row end' },
        el('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancelar'),
        el('button', {
          type: 'button', class: 'btn primary', onclick: async () => {
            if (input.value.trim()) addTyped();
            const next = normTags([...chosen]);
            if (JSON.stringify(next) !== JSON.stringify(d.tags || [])) {
              d.tags = next.length ? next : undefined;
              d.updatedAt = Date.now();
              await store.saveDoc(d);
            }
            close(true);
          },
        }, 'Guardar')));
    draw();
  });
}

const $folder = el('select', { class: 'folder', 'aria-label': 'Carpeta', onchange: (e) => { ui.folder = e.target.value; renderLib(); } });
const $drive = el('button', { class: 'btn drive', onclick: () => driveDialog() });
const $groupsBtn = el('button', { class: 'btn groupsbtn', html: icon('users') + '<span>Grupos</span>', onclick: () => groupsDialog() });
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
      $install, $groupsBtn, $drive,
      el('button', { class: 'btn primary', html: icon('plus') + '<span>Añadir</span>', onclick: (e) => addMenu(e.currentTarget) })),
    el('div', { class: 'filters' }, $chips, $folder),
    $tagRow,
    $grid, $file,
    el('p', { class: 'foot' },
      el('a', { href: 'ayuda.html' }, 'Cómo se usa'),
      window.paperbookNative ? null : ' · ',
      window.paperbookNative ? null : el('a', { href: 'descargar.html' }, 'Descargar la app para Android, Windows y Linux')));
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
  const tags = allTags();
  if (ui.tag && !tags.some(([t]) => t === ui.tag)) ui.tag = '';
  const groupList = spaces.list().filter((g) => g.kind === 'group');
  if (ui.space && !spaces.get(ui.space)) ui.space = '';
  $tagRow.hidden = !tags.length && !groupList.length;
  $tagRow.replaceChildren(
    ...groupList.map((g) => el('button', {
      class: 'groupchip', type: 'button', 'aria-pressed': String(ui.space === g.id), html: icon('users'),
      onclick: () => { ui.space = ui.space === g.id ? '' : g.id; renderLib(); },
    }, g.name)),
    ...(tags.length ? [el('span', { class: 'tagrow-label', html: icon('tag') })] : []),
    ...tags.map(([t, n]) => tagChip(t, {
      type: 'button', 'aria-pressed': String(ui.tag === t), title: `${n} ${n === 1 ? 'documento' : 'documentos'}`,
      onclick: () => { ui.tag = ui.tag === t ? '' : t; renderLib(); },
    })));

  const docs = all
    .filter((d) => (!ui.type || d.type === ui.type) && (!ui.folder || d.folder === ui.folder) &&
      (!ui.tag || (d.tags || []).includes(ui.tag)) && (!ui.space || d.space === ui.space) &&
      (!ui.q || foldText(d.title).includes(ui.q) || foldText(d.folder || '').includes(ui.q) ||
        (d.tags || []).some((t) => foldText(t).includes(ui.q)) || ui.hits.has(d.id)))
    .sort((a, b) => recency(b) - recency(a));

  if (!docs.length) {
    $grid.replaceChildren(el('div', { class: 'empty' },
      el('h2', {}, all.length ? 'Nada coincide con el filtro' : 'Tu biblioteca está vacía'),
      el('p', {}, all.length ? 'Prueba con otra búsqueda, carpeta, etiqueta o grupo.'
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
        d.space || d.tags?.length ? el('div', { class: 'tags' },
          d.space ? el('span', { class: 'shared', html: icon('users') }, spaces.get(d.space)?.name || 'Compartido') : null,
          ...(d.tags || []).map((t) => tagChip(t))) : null,
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
    { icon: 'users', label: d.space ? 'Compartido…' : 'Compartir…', onClick: () => shareDialog(d) },
    { icon: 'tag', label: 'Etiquetas…', onClick: () => tagDialog(d) },
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
        const sp = spaces.get(d.space);
        const where = (sp ? ` También se eliminará para las personas de «${sp.name}».` : '') +
          (drive.connected ? ' Se eliminará también de Google Drive y de tus otros dispositivos.' : '');
        if (!(await askConfirm('Eliminar documento', `«${d.title}» y sus anotaciones se eliminarán.${where}`))) return;
        if (!d.drive?.metaId && !d.drive?.contentId && !p2p.paired && !d.space) return store.purgeDoc(d.id).then(renderLib);
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
      'Se guarda una copia para leerla y anotarla sin conexión.' + (window.paperbookNative ? '' :
        ' Si el sitio bloquea la descarga directa, se usa el proxy configurado en Ajustes' +
        (getProxy() ? ` (${new URL(getProxy()).hostname}).` : ' (ninguno).')) +
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
  const text = s === 'off' && p2p.paired ? (p2p.online ? 'Conectado' : 'Emparejado') : {
    off: 'Sincronizar', idle: 'Sincronizado', syncing: 'Sincronizando…', error: 'Error de Drive', auth: 'Reconectar Drive',
  }[s];
  $drive.innerHTML = icon('cloud') + `<span>${text}</span>`;
  $drive.dataset.state = s === 'off' && p2p.online ? 'idle' : s;
  $drive.title = drive.message || (drive.lastSync ? 'Última sincronización: ' + new Date(drive.lastSync).toLocaleString('es') : 'Google Drive');
}

function driveDialog() {
  return dialog('Sincronizar', (dlg, close) => {
    const id = el('input', { type: 'text', value: drive.clientId, placeholder: 'xxxxxxxx.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false' });
    const proxy = el('input', { type: 'url', value: getProxy(), placeholder: 'vacío = sin proxy' });
    const native = !!window.paperbookNative;
    const secret = el('input', { type: 'password', value: drive.clientSecret, placeholder: 'GOCSPX-…', autocomplete: 'off' });
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
      el('label', {}, native ? 'ID de cliente OAuth (tipo «App de escritorio»)' : 'ID de cliente OAuth de Google',
        id),
      native ? el('label', {}, 'Secreto del cliente', secret) : null,
      el('p', { class: 'hint' }, native ? 'Se abrirá tu navegador para iniciar sesión; solo se hace una vez. ' : 'Solo se configura una vez. ',
        el('a', { href: 'https://github.com/mwatanabedotto-cell/paperbook#sincronizar-con-google-drive', target: '_blank', rel: 'noopener' }, 'Cómo obtenerlo (5 minutos)')),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn primary', onclick: () => {
            const changed = drive.clientId !== id.value.trim() || (native && drive.clientSecret !== secret.value.trim());
            drive.clientId = id.value.trim();
            if (native) drive.clientSecret = secret.value.trim();
            run(() => (drive.connected && !changed && drive.state !== 'auth' ? drive.sync() : drive.connect()));
          },
        }, drive.connected ? 'Sincronizar ahora' : 'Conectar con Google'),
        drive.connected ? el('button', { class: 'btn', onclick: () => { drive.disconnect(); close(null); toast('Drive desconectado. Tus documentos siguen en este dispositivo.'); } }, 'Desconectar') : null),
      native ? null : el('hr'),
      native ? null : el('label', {}, 'Proxy para guardar páginas web', proxy),
      native ? null : el('p', { class: 'hint' }, `Recibe la dirección de las páginas que guardas. Predeterminado: ${DEFAULT_PROXY}`),
      el('div', { class: 'row end' },
        el('button', { class: 'btn', onclick: () => { setProxy(proxy.value.trim()); close(null); } }, 'Cerrar')));
    // Drive automático queda plegado; arriba va la forma sencilla (archivo de copia).
    for (const n of [...dlg.childNodes]) if (n.nodeType === 3) n.remove(); // append(null) deja texto «null»
    const adv = el('details', { class: 'adv' }, el('summary', {}, 'Sincronización automática con Google Drive'));
    adv.open = drive.connected;
    const closeRow = dlg.lastElementChild;
    adv.append(...[...dlg.children].slice(1, -1));
    dlg.insertBefore(adv, closeRow);
    const files = el('details', { class: 'adv' }, el('summary', {}, 'Pasar todo con un archivo de copia'), backupSection());
    dlg.insertBefore(files, adv);
    dlg.insertBefore(pairSection(dlg), files);
  });
}

// ---------- grupos y documentos compartidos ----------
let groupsRender = null;

async function ensureName() {
  if (me.name) return true;
  const v = await askText('¿Cómo te llamas?', { hint: 'Lo verán las personas con las que compartas documentos.', placeholder: 'Tu nombre', ok: 'Continuar' });
  if (!v) return false;
  me.name = v;
  return true;
}

const avatar = (m) => el('span', {
  class: 'av' + (m.online === false ? ' off' : ''), style: `--h:${personHue(m.device)}`,
  title: (m.name || 'Sin nombre') + (m.online === false ? ' (desconectado)' : m.online ? ' (en línea)' : ''),
}, (m.name || '?').trim().slice(0, 1).toUpperCase());

function spaceMembers(s) {
  const mesh = spaces.meshes.get(s.id);
  const on = new Set((mesh?.people() || []).map((p) => p.device));
  return s.members.map((m) => ({ ...m, online: m.device === me.device ? true : on.has(m.device), isMe: m.device === me.device }));
}

/** Muestra un código de invitación y gestiona la respuesta (se crea una sola vez por invitación). */
function inviteBlock(spaceId, onDone) {
  const box = el('div', { class: 'invite' });
  let code = '', ask = null, error = '', live = true;
  const render = () => {
    if (!live) return;
    box.replaceChildren(...[
      el('p', {}, 'La otra persona abre Paperbook, pulsa «Grupos → Unirme con un código» y escribe:'),
      el('div', { class: 'code', 'aria-label': 'Código de invitación' }, code ? code.slice(0, 3) + ' ' + code.slice(3) : '··· ···'),
      ask
        ? el('p', {}, el('strong', {}, `${ask.name || 'Alguien'} quiere unirse. ¿Lo aceptas?`))
        : el('p', { class: 'hint' }, code ? 'Esperando… Mantén esta ventana abierta. El código sirve para una persona.' : 'Generando código…'),
      ask
        ? el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: () => { ask.res(true); ask = null; render(); } }, 'Aceptar'),
          el('button', { class: 'btn', onclick: () => { ask.res(false); ask = null; render(); } }, 'Rechazar'))
        : el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { stop(); onDone(false); } }, 'Listo')),
      error ? el('p', { class: 'hint error' }, error) : null,
    ].filter(Boolean));
  };
  const stop = () => { if (live) { live = false; spaces.cancelInvite(); } };
  render();
  spaces.invite(spaceId, {
    onCode: (c) => { code = c; render(); },
    confirm: (name) => new Promise((res) => { ask = { name, res }; render(); }),
  }).then((m) => {
    live = false;
    toast(`${m.name || 'La otra persona'} se unió.`);
    onDone(true);
  }).catch((e) => {
    if (e.message !== 'cancelado') { error = e.message; render(); }
  });
  box.stop = stop;
  return box;
}

function joinBlock(onDone) {
  const input = el('input', { type: 'text', id: 'join-code', inputmode: 'numeric', autocomplete: 'off', maxlength: 7, placeholder: '000 000', class: 'codein', 'aria-label': 'Código de 6 cifras' });
  const go = el('button', { type: 'submit', class: 'btn primary' }, 'Unirme');
  const msg = el('p', { class: 'hint', 'aria-live': 'polite' }, '');
  const form = el('form', {
    class: 'joinform',
    onsubmit: async (e) => {
      e.preventDefault();
      go.disabled = true;
      go.textContent = 'Conectando…';
      msg.classList.remove('error');
      msg.textContent = '';
      try {
        const s = await spaces.join(input.value);
        toast(`Te uniste a «${s.name}». Los documentos llegan en unos segundos.`, { ms: 5000 });
        onDone(true);
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add('error');
        go.disabled = false;
        go.textContent = 'Unirme';
      }
    },
  }, el('p', {}, 'Escribe el código de 6 cifras que te muestra la otra persona.'),
    el('div', { class: 'row' }, input, go,
      el('button', { type: 'button', class: 'btn', onclick: () => { spaces.cancelInvite(); onDone(false); } }, 'Cancelar')),
    msg);
  setTimeout(() => input.focus(), 30);
  return form;
}

function spaceCard(s, { onInvite, close }) {
  const people = spaceMembers(s);
  const docs = spaces.docs(s.id);
  const online = people.filter((m) => !m.isMe && m.online).length;
  return el('div', { class: 'space' },
    el('div', { class: 'space-head' },
      el('div', {},
        el('strong', {}, s.name),
        el('span', { class: 'hint' }, ` · ${s.kind === 'doc' ? 'Documento compartido' : 'Grupo de estudio'}`)),
      el('div', { class: 'avs' }, ...people.map(avatar))),
    el('p', { class: 'hint' },
      `${people.length} de ${MAX_MEMBERS} personas · ${docs.length} ${docs.length === 1 ? 'documento' : 'documentos'} · ` +
      (people.length < 2 ? 'aún no has invitado a nadie' : online ? `${online} en línea` : 'nadie más en línea')),
    el('div', { class: 'row' },
      docs.length ? el('button', { class: 'btn', onclick: () => {
        if (s.kind === 'doc' && docs.length === 1) { close(); location.hash = '#/d/' + docs[0].id; return; }
        ui.space = s.id; close(); renderLib();
      } }, s.kind === 'doc' ? 'Abrir' : 'Ver documentos') : null,
      people.length < MAX_MEMBERS ? el('button', { class: 'btn', onclick: () => onInvite(s.id) }, 'Invitar') : null,
      el('button', { class: 'btn ghostdanger', onclick: async () => {
        const ok = await askConfirm(s.kind === 'doc' ? 'Dejar de compartir' : 'Salir del grupo',
          `Dejarás de recibir y enviar cambios de «${s.name}». Te quedas con una copia de sus documentos tal como están ahora.`, 'Salir');
        if (ok) { await spaces.leave(s.id); toast('Saliste de «' + s.name + '».'); }
      } }, 'Salir')));
}

/** Diálogo principal de grupos. view: 'list' | 'join' | 'new' | { invite: spaceId } */
async function groupsDialog(view = 'list') {
  if (!(await ensureName())) return;
  return dialog('Grupos y documentos compartidos', (dlg, close) => {
    const body = el('div', { class: 'groups' });
    let mode = view, block = null;
    const go = (m) => {
      block?.stop?.();
      mode = m;
      block = typeof m === 'object' && m.invite ? inviteBlock(m.invite, () => go('list')) : m === 'join' ? joinBlock(() => go('list')) : null;
      render();
    };
    const render = () => {
      const kids = [];
      if (block) {
        if (mode.invite) kids.push(el('h3', {}, `Invitar a «${spaces.get(mode.invite)?.name || ''}»`));
        else kids.push(el('h3', {}, 'Unirme con un código'));
        kids.push(block);
      } else if (mode === 'new') {
        const name = el('input', { type: 'text', id: 'group-name', placeholder: 'p. ej. Revalida — Clínica médica', autocomplete: 'off' });
        kids.push(el('form', {
          class: 'joinform',
          onsubmit: (e) => {
            e.preventDefault();
            const s = spaces.create('group', name.value || 'Grupo de estudio');
            go({ invite: s.id });
          },
        }, el('h3', {}, 'Nuevo grupo de estudio'),
          el('p', { class: 'hint' }, `Hasta ${MAX_MEMBERS} personas. Cada una puede añadir documentos al grupo, y todas los ven y los editan a la vez.`),
          name,
          el('div', { class: 'row' },
            el('button', { type: 'submit', class: 'btn primary' }, 'Crear e invitar'),
            el('button', { type: 'button', class: 'btn', onclick: () => go('list') }, 'Cancelar'))));
        setTimeout(() => name.focus(), 30);
      } else {
        const list = spaces.list();
        if (!list.length) {
          kids.push(el('p', {}, 'Edita documentos con otras personas al mismo tiempo: cada trazo aparece en las pantallas de todos al instante.'),
            el('ul', { class: 'hint' },
              el('li', {}, el('strong', {}, 'Compartir un documento: '), 'ábrelo y pulsa ⋯ → «Compartir». Solo ven ese documento.'),
              el('li', {}, el('strong', {}, 'Grupo de estudio: '), `hasta ${MAX_MEMBERS} personas comparten varios documentos.`)));
        }
        for (const s of list) kids.push(spaceCard(s, { onInvite: (id) => go({ invite: id }), close }));
        kids.push(el('div', { class: 'row' },
          el('button', { class: 'btn primary', html: icon('plus') + '<span>Crear grupo de estudio</span>', onclick: () => go('new') }),
          el('button', { class: 'btn', onclick: () => go('join') }, 'Unirme con un código')));
        kids.push(el('p', { class: 'hint' }, `Tu nombre: ${me.name} · `,
          el('a', { href: '#', onclick: async (e) => {
            e.preventDefault();
            const v = await askText('Tu nombre', { value: me.name, hint: 'Lo verán las personas de tus grupos.' });
            if (v) { me.name = v; render(); }
          } }, 'Cambiar')));
      }
      body.replaceChildren(...kids);
    };
    groupsRender = () => { if (!block && mode === 'list') render(); };
    dlg.addEventListener('close', () => { groupsRender = null; block?.stop?.(); });
    dlg.append(body, el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cerrar')));
    go(view);
  });
}

/** Compartir un documento: solo él, o dentro de un grupo. */
async function shareDialog(doc) {
  const s = spaces.forDoc(doc);
  if (s) return groupsDialog('list');
  if (doc.space) {
    return dialog('Documento compartido', (dlg, close) => dlg.append(
      el('p', {}, 'Este documento está compartido desde otro de tus dispositivos. Para invitar a alguien, hazlo desde ese dispositivo.'),
      el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cerrar'))));
  }
  if (!(await ensureName())) return;
  const groups = spaces.list().filter((g) => g.kind === 'group');
  return dialog(`Compartir «${doc.title}»`, (dlg, close) => {
    const body = el('div', { class: 'groups' });
    let block = null;
    const invite = (id) => {
      block = inviteBlock(id, () => close(true));
      body.replaceChildren(el('h3', {}, 'Invita a otra persona'), block);
    };
    body.append(
      el('button', { class: 'choice', onclick: () => invite(spaces.create('doc', doc.title, doc.id).id) },
        el('span', { class: 'choice-ic', html: icon('canvas') }),
        el('span', {}, el('strong', {}, 'Compartir solo este documento'),
          el('span', { class: 'hint' }, `Hasta ${MAX_MEMBERS} personas lo editan a la vez. No ven el resto de tu biblioteca.`))),
      el('div', { class: 'choice static' },
        el('span', { class: 'choice-ic', html: icon('users') }),
        el('span', {}, el('strong', {}, 'Añadirlo a un grupo de estudio'),
          el('span', { class: 'hint' }, groups.length ? 'Lo verán y editarán todas las personas del grupo.' : 'Aún no tienes grupos.'),
          el('span', { class: 'row' },
            ...groups.map((g) => el('button', { class: 'btn', onclick: async () => {
              await spaces.addDoc(doc.id, g.id);
              toast(`«${doc.title}» se comparte ahora con «${g.name}».`);
              close(true);
            } }, g.name)),
            el('button', { class: 'btn', html: icon('plus') + '<span>Grupo nuevo</span>', onclick: async () => {
              const name = await askText('Nuevo grupo de estudio', { placeholder: 'p. ej. Revalida — Clínica médica', ok: 'Crear' });
              if (name) invite(spaces.create('group', name, doc.id).id);
            } })))));
    dlg.addEventListener('close', () => block?.stop?.());
    dlg.append(body, el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cerrar')));
  });
}

let pairRender = null;

/** Emparejar dispositivos con un código: sincronización directa, sin cuentas. */
function pairSection(dlg) {
  const box = el('section', { class: 'pair' });
  let mode = 'idle', code = '', ask = null, error = '';
  const cancel = () => { p2p.cancelPairing(); mode = 'idle'; ask = null; render(); };
  const render = () => {
    const kids = [];
    if (mode === 'host') {
      kids.push(
        el('p', {}, 'En el otro dispositivo abre Paperbook, pulsa Sincronizar → «Tengo un código» y escribe:'),
        el('div', { class: 'code', 'aria-label': 'Código de emparejamiento' }, code ? code.slice(0, 3) + ' ' + code.slice(3) : '··· ···'),
        ask
          ? el('p', {}, el('strong', {}, 'Un dispositivo quiere conectarse. ¿Lo aceptas?'))
          : el('p', { class: 'hint' }, code ? 'Esperando al otro dispositivo… Mantén esta ventana abierta.' : 'Generando código…'),
        ask
          ? el('div', { class: 'row' },
            el('button', { class: 'btn primary', onclick: () => { ask(true); ask = null; render(); } }, 'Aceptar'),
            el('button', { class: 'btn', onclick: () => { ask(false); ask = null; render(); } }, 'Rechazar'))
          : el('div', { class: 'row' }, el('button', { class: 'btn', onclick: cancel }, 'Cancelar')));
    } else if (mode === 'join') {
      const input = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: 7, placeholder: '000 000', class: 'codein', 'aria-label': 'Código de 6 cifras' });
      const go = el('button', { type: 'submit', class: 'btn primary' }, 'Conectar');
      kids.push(el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          go.disabled = true;
          go.textContent = 'Conectando…';
          try {
            await p2p.join(input.value);
            mode = 'idle'; error = '';
            toast('Dispositivos emparejados.');
          } catch (err) { error = err.message; }
          render();
        },
      }, el('p', {}, 'Escribe el código de 6 cifras que muestra el otro dispositivo.'),
        el('div', { class: 'row' }, input, go, el('button', { type: 'button', class: 'btn', onclick: () => { error = ''; cancel(); } }, 'Cancelar'))));
      setTimeout(() => input.focus(), 30);
    } else if (p2p.paired) {
      const n = p2p.group.peers.length;
      kids.push(
        el('p', { class: 'pstate' + (p2p.online ? ' on' : '') }, p2p.online
          ? 'Conectado. Los cambios se envían solos entre tus dispositivos.'
          : `Emparejado con ${n} ${n === 1 ? 'dispositivo' : 'dispositivos'}. Se sincroniza cuando los dos tienen Paperbook abierto.`),
        p2p.message ? el('p', { class: 'hint' }, p2p.message) : null,
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: () => startHost() }, 'Añadir otro dispositivo'),
          el('button', { class: 'btn', onclick: () => { p2p.unpair(); toast('Dispositivos desemparejados. Tus documentos siguen aquí.'); render(); } }, 'Desemparejar')));
    } else {
      kids.push(
        el('p', {}, 'Empareja tu tablet y tu computadora con un código. Sin cuentas ni configuración: se sincronizan solos cuando los dos tienen Paperbook abierto.'),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: () => startHost() }, 'Mostrar un código'),
          el('button', { class: 'btn', onclick: () => { mode = 'join'; error = ''; render(); } }, 'Tengo un código')));
    }
    if (error) kids.push(el('p', { class: 'hint error' }, error));
    box.replaceChildren(...kids.filter(Boolean));
  };
  const startHost = async () => {
    mode = 'host'; code = ''; error = ''; ask = null;
    render();
    try {
      await p2p.host({
        onCode: (c) => { code = c; render(); },
        confirm: () => new Promise((res) => { ask = res; render(); }),
      });
      toast('Dispositivos emparejados.');
    } catch (err) {
      if (err.message !== 'cancelado') error = err.message;
    }
    mode = 'idle';
    render();
  };
  pairRender = render;
  dlg.addEventListener('close', () => { pairRender = null; if (mode !== 'idle') p2p.cancelPairing(); });
  render();
  return box;
}

function backupSection() {
  const msg = el('p', { class: 'hint', 'aria-live': 'polite' }, '');
  const say = (t, err) => { msg.textContent = t; msg.classList.toggle('error', !!err); };
  const pick = el('input', {
    type: 'file', hidden: true,
    onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      say('Cargando copia…');
      try {
        const r = await importBackup(f);
        const parts = [];
        if (r.added) parts.push(`${r.added} ${r.added === 1 ? 'documento nuevo' : 'documentos nuevos'}`);
        if (r.merged) parts.push(`${r.merged} ${r.merged === 1 ? 'actualizado' : 'actualizados'}`);
        say((parts.join(', ') || 'No había nada nuevo') + '.' +
          (r.missing ? ` ${r.missing} no están en este dispositivo: para traerlos, guarda en el otro una «copia completa».` : ''), !!r.missing && !parts.length);
        renderLib();
      } catch (err) {
        say(err.message || String(err), true);
      }
    },
  });
  const save = async (full) => {
    say('Preparando copia…');
    try {
      const file = await exportBackup({ full });
      const how = await deliver(file);
      say(how === 'cancelled' ? '' : how === 'shared' ? 'Copia enviada.'
        : `Copia descargada: ${file.name} (${file.size < 1e6 ? Math.max(1, Math.round(file.size / 1e3)) + ' KB' : (file.size / 1e6).toFixed(1).replace('.', ',') + ' MB'}). Súbela a tu Drive para abrirla en el otro dispositivo.`);
    } catch (err) {
      say(err.message || String(err), true);
    }
  };
  return el('section', { class: 'backup' },
    el('p', {}, 'Útil si los dispositivos no pueden estar abiertos a la vez, o como copia de seguridad.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', html: icon('upload') + '<span>Guardar copia</span>', onclick: (e) => menu(e.currentTarget, [
        { icon: 'file', label: 'Copia completa (documentos y anotaciones)', onClick: () => save(true) },
        { icon: 'pen', label: 'Solo anotaciones y lienzos (archivo pequeño)', onClick: () => save(false) },
      ]) }),
      el('button', { class: 'btn', html: icon('download') + '<span>Cargar copia</span>', onclick: () => pick.click() })),
    el('p', { class: 'hint' }, 'En el otro dispositivo pulsa «Cargar copia» y elige el archivo (puedes tomarlo directamente de Google Drive). Lo cargado se combina con lo que ya tienes: no borra nada.'),
    msg, pick);
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
    const v = (viewer = new Viewer($viewer, d, () => { if (viewer === v) { viewer = null; location.hash = ''; } }, { q, onTags: tagDialog, onShare: shareDialog, presence: (id) => spaces.presence(id) }));
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

/** Portada: al entrar por el navegador solo se ofrece descargar o usar ahora. */
function welcome() {
  const $w = document.getElementById('welcome');
  const sp = new URLSearchParams(location.search);
  const skip = window.paperbookNative || standalone() || location.hash.startsWith('#/d/') ||
    sp.has('url') || sp.has('text') || sp.has('new') || localStorage.getItem('pb.entered');
  if (skip) return Promise.resolve();
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Linux|X11/i.test(ua) && !isIOS() ? 'Linux' : '';
  if (os) document.getElementById('w-download').textContent = 'Descargar para ' + os;
  $lib.hidden = true;
  $w.hidden = false;
  return new Promise((res) => {
    document.getElementById('w-use').addEventListener('click', () => {
      localStorage.setItem('pb.entered', '1');
      $w.hidden = true;
      $lib.hidden = false;
      res();
    }, { once: true });
  });
}

async function main() {
  await welcome();
  buildLib();
  await store.init();
  let rt;
  store.on((type) => {
    if (type === 'change') drive.schedule();
    if (type !== 'ann' && !viewer) { clearTimeout(rt); rt = setTimeout(renderLib, 60); }
  });
  drive.onState = renderDrive;
  p2p.onState = () => { renderDrive(); pairRender?.(); };
  p2p.start().catch((e) => console.warn(e));
  let srt;
  spaces.onState = () => {
    groupsRender?.();
    if (!viewer) { clearTimeout(srt); srt = setTimeout(renderLib, 80); }
  };
  spaces.start();
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
  // app de escritorio: archivos abiertos con «Abrir con Paperbook»
  const nat = window.paperbookNative;
  if (nat?.takeOpenFiles) {
    const take = async () => {
      const fs = await nat.takeOpenFiles();
      if (!fs.length) return;
      const before = new Set(store.docs.keys());
      await addFiles(fs.map((f) => new File([f.data], f.name, { type: f.type })));
      const added = [...store.docs.keys()].filter((id) => !before.has(id));
      if (added.length === 1) location.hash = '#/d/' + added[0];
    };
    nat.onOpenFiles(take);
    take();
  }
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
