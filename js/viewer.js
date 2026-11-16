// Visor de documentos con capa de tinta (PDF, imagen, página web guardada y lienzo en blanco).
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { store, newId } from './store.js';
import { drawStroke, hit, bounds } from './ink.js';
import { icon, el, toast, menu, askText, askConfirm } from './ui.js';

const vend = (p) => new URL('../vendor/pdfjs/' + p, import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = vend('pdf.worker.min.mjs');

export async function loadPdf(blob) {
  return pdfjs.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: vend('cmaps/'), cMapPacked: true,
    standardFontDataUrl: vend('standard_fonts/'),
  }).promise;
}

/** Miniatura (data URL) para la biblioteca. */
export async function makeThumb(type, blob) {
  try {
    const c = document.createElement('canvas');
    const TW = 320;
    if (type === 'pdf') {
      const pdf = await loadPdf(blob);
      const page = await pdf.getPage(1);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: TW / v1.width });
      c.width = TW; c.height = Math.min(Math.round(vp.height), TW * 1.5);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pdf.destroy();
    } else if (type === 'image') {
      const bmp = await createImageBitmap(blob);
      c.width = TW; c.height = Math.min(Math.round((TW * bmp.height) / bmp.width), TW * 1.5);
      c.getContext('2d').drawImage(bmp, 0, 0, TW, (TW * bmp.height) / bmp.width);
    } else return null;
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

const TOOLS = [
  ['hand', 'Mover / desplazar'], ['pen', 'Bolígrafo'], ['hl', 'Resaltador'], ['eraser', 'Borrador'],
  ['line', 'Línea'], ['arrow', 'Flecha'], ['rect', 'Rectángulo'], ['ellipse', 'Elipse'], ['text', 'Texto'],
];
const COLORS = ['#1b1b1f', '#d92d20', '#1f6feb', '#1a7f37', '#f08c00', '#8250df', '#ffd400', '#ff5fa2'];
const PAPERS = [['blank', 'Liso'], ['lines', 'Rayado'], ['grid', 'Cuadrícula'], ['dots', 'Puntos']];
const MAX_AREA = 12e6; // píxeles máximos por lienzo (límite seguro en tabletas)
const WEB_W = 860;     // ancho fijo de maquetación de páginas web (mantiene alineadas las anotaciones)
const WEB_TILE = 1.25; // alto de cada tramo de tinta, relativo al ancho
const A4 = 1.4142;
const ERASE_R = 0.012;

const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem('pb.ink')) || {}; } catch { return {}; }
};

export class Viewer {
  constructor(root, doc, onClose) {
    this.root = root;
    this.doc = doc;
    this.onClose = onClose;
    this.pages = [];
    this.zoom = 1;
    this.undo = [];
    this.redo = [];
    this.touches = new Map();
    this.ac = new AbortController();
    const p = loadPrefs();
    this.tool = p.tool || 'pen';
    this.finger = p.finger ?? true;
    this.sets = { pen: { c: COLORS[0], w: 3 }, hl: { c: COLORS[6], w: 5 }, ...p.sets };
  }

  get set() { return this.sets[this.tool === 'hl' ? 'hl' : 'pen']; }

  savePrefs() {
    localStorage.setItem('pb.ink', JSON.stringify({ tool: this.tool, finger: this.finger, sets: this.sets }));
  }

  // ---------- construcción ----------
  async init() {
    const { doc, root } = this;
    const sig = { signal: this.ac.signal };
    root.innerHTML = '';
    const b = (ic, title, fn, cls = '') =>
      el('button', { class: 'ib ' + cls, title, 'aria-label': title, html: icon(ic), onclick: fn });

    this.$title = el('div', { class: 'vtitle' }, doc.title);
    this.$page = el('button', { class: 'chip', title: 'Ir a la página…', onclick: () => this.askPage() }, '');
    this.$zoom = el('button', { class: 'chip', title: 'Ajustar al ancho', onclick: () => this.setZoom(1) }, '100%');
    this.$undo = b('undo', 'Deshacer', () => this.doUndo());
    this.$redo = b('redo', 'Rehacer', () => this.doRedo());
    const bar = el('header', { class: 'vbar' },
      b('back', 'Volver a la biblioteca', () => this.close()),
      this.$title, this.$page,
      b('minus', 'Alejar', () => this.setZoom(this.zoom / 1.2)),
      this.$zoom,
      b('plus', 'Acercar', () => this.setZoom(this.zoom * 1.2)),
      this.$undo, this.$redo,
      b('more', 'Más opciones', (e) => this.moreMenu(e.currentTarget)));

    this.$tools = el('div', { class: 'tools', role: 'toolbar', 'aria-label': 'Herramientas de dibujo' });
    for (const [id, label] of TOOLS) {
      this.$tools.append(el('button', {
        class: 'ib tool', 'data-tool': id, title: label, 'aria-label': label, html: icon(id),
        onclick: () => this.setTool(id),
      }));
    }
    this.$tools.append(el('span', { class: 'sep' }));
    for (const c of COLORS) {
      this.$tools.append(el('button', {
        class: 'sw', 'data-c': c, style: `--c:${c}`, title: 'Color', 'aria-label': 'Color ' + c,
        onclick: () => this.setColor(c),
      }));
    }
    this.$custom = el('input', {
      type: 'color', class: 'sw custom', title: 'Color personalizado', 'aria-label': 'Color personalizado',
      oninput: (e) => this.setColor(e.target.value),
    });
    this.$width = el('input', {
      type: 'range', min: 1, max: 12, step: 1, class: 'wd', title: 'Grosor', 'aria-label': 'Grosor',
      oninput: (e) => { this.set.w = +e.target.value; this.savePrefs(); },
    });
    this.$tools.append(this.$custom, el('span', { class: 'sep' }), this.$width);

    this.$sheet = el('div', { class: 'sheet ' + doc.type });
    this.$stage = el('div', { class: 'stage' }, this.$sheet);
    this.$scroll = el('div', { class: 'scroller' }, this.$stage);
    root.append(bar, this.$tools, this.$scroll);

    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const p = this.pages[+e.target.dataset.i];
        if (!p) continue;
        if (e.isIntersecting) this.mount(p); else this.unmount(p);
      }
    }, { root: this.$scroll, rootMargin: '120% 0px' });

    this.ann = await store.holdAnn(doc.id);
    this.offStore = store.on((type, d) => {
      if (type === 'ann' && d.id === doc.id) { this.ann = d.ann; this.redrawAll(); }
    });

    await this.loadContent();
    this.layout();
    this.refreshTools();
    this.updateUndo();

    const st = this.$stage;
    st.addEventListener('pointerdown', (e) => this.onDown(e), sig);
    st.addEventListener('pointermove', (e) => this.onMove(e), sig);
    st.addEventListener('pointerup', (e) => this.onUp(e), sig);
    st.addEventListener('pointercancel', (e) => this.onUp(e, true), sig);
    st.addEventListener('contextmenu', (e) => { if (this.tool !== 'hand') e.preventDefault(); }, sig);
    this.$scroll.addEventListener('scroll', () => this.onScroll(), { ...sig, passive: true });
    this.$scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = this.$scroll.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
    }, { ...sig, passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), sig);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.$scroll);

    // volver a la última posición de lectura
    const lp = doc.lastPos;
    if (lp && this.pages[lp.i]) {
      const pe = this.pages[lp.i].el;
      this.$scroll.scrollTop = pe.offsetTop + (lp.f || 0) * pe.offsetHeight - 8;
    }
    this.onScroll();
    return this;
  }

  async loadContent() {
    const { doc } = this;
    const blob = doc.type === 'canvas' ? null : await store.getBlob(doc.id);
    if (doc.type !== 'canvas' && !blob) throw new Error('El contenido aún no se ha descargado de Drive.');

    if (doc.type === 'pdf') {
      this.pdf = await loadPdf(blob);
      const v = (await this.pdf.getPage(1)).getViewport({ scale: 1 });
      const aspect = v.height / v.width;
      this.buildPages(Array.from({ length: this.pdf.numPages }, (_, i) => ({ key: i, offY: 0, aspect })));
    } else if (doc.type === 'image') {
      this.url = URL.createObjectURL(blob);
      this.img = new Image();
      this.img.src = this.url;
      await this.img.decode();
      this.buildPages([{ key: 0, offY: 0, aspect: this.img.naturalHeight / this.img.naturalWidth }]);
    } else if (doc.type === 'canvas') {
      this.buildCanvasPages();
      this.$stage.append(el('button', {
        class: 'btn addpage', html: icon('plus') + '<span>Añadir página</span>',
        onclick: () => {
          doc.pages = (doc.pages || 1) + 1;
          store.saveDoc(doc);
          this.buildCanvasPages();
          this.pages.at(-1).el.scrollIntoView({ behavior: 'smooth' });
        },
      }));
    } else if (doc.type === 'web') {
      const html = await blob.text();
      // Sin "allow-scripts": el HTML guardado nunca ejecuta código.
      this.frame = el('iframe', { sandbox: 'allow-same-origin', title: doc.title, tabindex: '-1' });
      this.frame.style.height = '200px';
      this.$bg = el('div', { class: 'webbg' }, this.frame);
      this.$bg.style.width = WEB_W + 'px';
      this.$sheet.append(this.$bg);
      this.webH = 0;
      this.setWebHeight(WEB_W * WEB_TILE);
      await new Promise((res) => {
        this.frame.addEventListener('load', res, { once: true });
        this.frame.srcdoc = html;
        setTimeout(res, 4000);
      });
      const d = this.frame.contentDocument;
      const measure = () => {
        if (!d?.documentElement) return;
        this.setWebHeight(Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0));
      };
      measure();
      if (d?.documentElement) {
        this.wro = new ResizeObserver(measure);
        this.wro.observe(d.documentElement);
        if (d.body) this.wro.observe(d.body);
      }
    }
  }

  setWebHeight(h) {
    if (h <= this.webH) return; // solo crece (imágenes que terminan de cargar)
    this.webH = h;
    this.frame.style.height = h + 'px';
    const total = h / WEB_W;
    const specs = [];
    for (let y = 0; y < total - 1e-6; y += WEB_TILE) {
      specs.push({ key: 0, offY: y, aspect: Math.min(WEB_TILE, total - y) });
    }
    this.buildPages(specs);
  }

  buildCanvasPages() {
    const n = Math.max(1, this.doc.pages || 1);
    this.buildPages(Array.from({ length: n }, (_, i) => ({ key: i, offY: 0, aspect: A4 })));
  }

  buildPages(specs) {
    for (const p of this.pages) { this.io.unobserve(p.el); this.unmount(p); p.el.remove(); }
    this.pages = specs.map((s, i) => {
      const pe = el('div', { class: 'page', 'data-i': i });
      pe.style.aspectRatio = `1 / ${s.aspect}`;
      if (this.doc.type === 'canvas') pe.dataset.paper = this.doc.paper || 'blank';
      this.$sheet.append(pe);
      this.io.observe(pe);
      return { ...s, i, el: pe, mounted: false, gen: 0 };
    });
    this.onScroll();
  }

  // ---------- maquetación y renderizado ----------
  layout() {
    const cw = this.$scroll.clientWidth;
    if (!cw) return;
    this.pw = Math.round(Math.max(120, Math.min(cw - 16, 1000) * this.zoom));
    this.$stage.style.setProperty('--pw', this.pw + 'px');
    if (this.$bg) this.$bg.style.transform = `scale(${this.pw / WEB_W})`;
    this.$zoom.textContent = Math.round(this.zoom * 100) + '%';
    clearTimeout(this.rt);
    this.rt = setTimeout(() => { for (const p of this.pages) if (p.mounted) this.render(p); }, 140);
  }

  setZoom(z, cx, cy) {
    z = Math.max(0.4, Math.min(5, z));
    if (Math.abs(z - 1) < 0.04) z = 1;
    const s = this.$scroll;
    cx ??= s.clientWidth / 2;
    cy ??= s.clientHeight / 2;
    const fx = (s.scrollLeft + cx) / s.scrollWidth;
    const fy = (s.scrollTop + cy) / s.scrollHeight;
    this.zoom = z;
    this.layout();
    s.scrollLeft = fx * s.scrollWidth - cx;
    s.scrollTop = fy * s.scrollHeight - cy;
  }

  sizeCanvas(c, p) {
    const w = this.pw, h = this.pw * p.aspect;
    const k = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_AREA / (w * h)));
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
  }

  mount(p) {
    if (p.mounted) return;
    p.mounted = true;
    if (this.doc.type === 'image') p.el.append(el('img', { class: 'bg', src: this.url, alt: '', draggable: 'false' }));
    p.ink = el('canvas', { class: 'ink' });
    p.el.append(p.ink);
    this.render(p);
  }

  unmount(p) {
    if (!p.mounted || this.cur?.p === p) return;
    if (this.textEdit?.p === p) this.commitText();
    p.mounted = false;
    p.gen++;
    p.task?.cancel();
    p.task = p.ink = p.bg = p.base = null;
    p.el.replaceChildren();
  }

  async render(p) {
    const gen = ++p.gen;
    if (p.ink) { this.sizeCanvas(p.ink, p); this.redraw(p); }
    if (this.doc.type !== 'pdf') return;
    try {
      const page = await this.pdf.getPage(p.i + 1);
      if (gen !== p.gen || !p.mounted) return;
      const v1 = page.getViewport({ scale: 1 });
      const aspect = v1.height / v1.width;
      if (Math.abs(aspect - p.aspect) > 0.001) {
        p.aspect = aspect;
        p.el.style.aspectRatio = `1 / ${aspect}`;
        this.sizeCanvas(p.ink, p);
        this.redraw(p);
      }
      const c = el('canvas', { class: 'bg' });
      this.sizeCanvas(c, p);
      p.task?.cancel();
      p.task = page.render({ canvasContext: c.getContext('2d'), viewport: page.getViewport({ scale: c.width / v1.width }) });
      await p.task.promise;
      if (gen !== p.gen || !p.mounted) return;
      p.bg?.remove();
      p.bg = c;
      p.el.prepend(c);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(e);
    }
  }

  strokesOf(p) { return this.ann.strokes[p.key] || []; }

  redraw(p, live) {
    if (!p.ink) return;
    const ctx = p.ink.getContext('2d');
    const W = p.ink.width;
    ctx.clearRect(0, 0, W, p.ink.height);
    if (live && p.base) {
      ctx.drawImage(p.base, 0, 0);
    } else {
      const y0 = p.offY, y1 = p.offY + p.aspect;
      for (const s of this.strokesOf(p)) {
        if (p.offY || this.doc.type === 'web') {
          const b = bounds(s);
          if (b[3] < y0 || b[1] > y1) continue;
        }
        drawStroke(ctx, s, W, p.offY);
      }
    }
    if (live) drawStroke(ctx, live, W, p.offY);
  }

  surfaces(key) { return this.pages.filter((p) => p.mounted && p.key === key); }
  redrawKey(key, live) { for (const p of this.surfaces(key)) this.redraw(p, live); }
  redrawAll() { for (const p of this.pages) if (p.mounted) this.redraw(p); }

  // ---------- entrada ----------
  point(e, c) {
    const pr = e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : undefined;
    const x = (e.clientX - c.rect.left) / c.rect.width;
    const y = (e.clientY - c.rect.top) / c.rect.width + c.p.offY;
    const r = (n) => Math.round(n * 1e5) / 1e5;
    return pr == null ? [r(x), r(y)] : [r(x), r(y), pr];
  }

  onDown(e) {
    if (e.target.closest('textarea') || this.tool === 'hand') return;
    if (e.pointerType === 'touch') {
      const drawingWithFinger = this.cur?.type === 'touch';
      if (drawingWithFinger) { // segundo dedo: pasar a mover / zoom
        const c = this.cur;
        this.cancelStroke();
        this.touches.set(c.id, { x: c.x, y: c.y });
      }
      if (!this.finger || drawingWithFinger || this.touches.size || this.cur) return this.touchDown(e);
    } else if (e.pointerType === 'pen' && this.finger && !this.penSeen) {
      this.penSeen = true;
      this.finger = false; // lápiz detectado: el dedo pasa a desplazar
      this.savePrefs();
      toast('Lápiz detectado: el dedo ahora desplaza y el lápiz dibuja.');
    }
    const pe = e.target.closest('.page');
    if (!pe || this.cur || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.commitText();
    const p = this.pages[+pe.dataset.i];
    try { this.$stage.setPointerCapture(e.pointerId); } catch {}
    const c = (this.cur = { id: e.pointerId, type: e.pointerType, p, rect: pe.getBoundingClientRect(), t: this.tool, x: e.clientX, y: e.clientY });
    const pt = this.point(e, c);
    if (c.t === 'eraser') { c.gone = []; this.eraseAt(c, pt); return; }
    if (c.t === 'text') { c.pt = pt; return; }
    const hl = c.t === 'hl';
    c.s = { id: newId(), t: c.t, c: this.set.c, w: (this.set.w / 1000) * (hl ? 4 : 1), p: [pt] };
    if (c.t !== 'pen' && c.t !== 'hl') c.s.p.push(pt.slice(0, 2));
    for (const s of this.surfaces(p.key)) {
      s.base = el('canvas');
      s.base.width = s.ink.width; s.base.height = s.ink.height;
      s.base.getContext('2d').drawImage(s.ink, 0, 0);
    }
    this.redrawKey(p.key, c.s);
  }

  onMove(e) {
    if (this.touches.has(e.pointerId)) return this.touchMove(e);
    const c = this.cur;
    if (!c || c.id !== e.pointerId) return;
    c.x = e.clientX; c.y = e.clientY;
    if (c.t === 'text') return;
    const evs = c.t === 'pen' || c.t === 'hl' ? (e.getCoalescedEvents?.() || [e]) : [e];
    for (const ev of evs.length ? evs : [e]) {
      const pt = this.point(ev, c);
      if (c.t === 'eraser') { this.eraseAt(c, pt); continue; }
      const P = c.s.p;
      if (c.t === 'pen' || c.t === 'hl') {
        const l = P[P.length - 1];
        if (Math.hypot(pt[0] - l[0], pt[1] - l[1]) > 0.0007) P.push(pt);
      } else {
        P[1] = pt.slice(0, 2);
      }
    }
    if (c.s && !c.raf) {
      c.raf = requestAnimationFrame(() => { c.raf = 0; if (this.cur === c) this.redrawKey(c.p.key, c.s); });
    }
  }

  onUp(e, cancelled) {
    if (this.touches.has(e.pointerId)) { this.touches.delete(e.pointerId); return; }
    const c = this.cur;
    if (!c || c.id !== e.pointerId) return;
    this.cur = null;
    cancelAnimationFrame(c.raf);
    for (const s of this.surfaces(c.p.key)) s.base = null;
    if (c.t === 'text') { if (!cancelled) this.openText(c.p, c.pt); return; }
    if (c.t === 'eraser') {
      if (c.gone.length) { this.undo.push({ add: c.gone, del: [] }); this.redo = []; this.changed(); }
      return;
    }
    const P = c.s.p;
    const shape = c.t !== 'pen' && c.t !== 'hl';
    const tiny = shape && Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) < 0.004;
    if (!cancelled && !tiny) {
      (this.ann.strokes[c.p.key] ||= []).push(c.s);
      this.undo.push({ add: [], del: [{ key: c.p.key, s: c.s }] });
      this.redo = [];
      this.changed();
    }
    this.redrawKey(c.p.key);
  }

  cancelStroke() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    cancelAnimationFrame(c.raf);
    for (const s of this.surfaces(c.p.key)) s.base = null;
    this.redrawKey(c.p.key);
  }

  eraseAt(c, pt) {
    const arr = this.ann.strokes[c.p.key];
    if (!arr) return;
    const keep = [];
    let n = 0;
    for (const s of arr) {
      if (hit(s, pt[0], pt[1], ERASE_R)) {
        this.ann.removed[s.id] = Date.now();
        c.gone.push({ key: c.p.key, s });
        n++;
      } else keep.push(s);
    }
    if (n) { this.ann.strokes[c.p.key] = keep; this.redrawKey(c.p.key); }
  }

  // un dedo mueve, dos dedos mueven + zoom (cuando el dedo no dibuja)
  touchDown(e) {
    try { this.$stage.setPointerCapture(e.pointerId); } catch {}
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinch = null;
  }

  touchMove(e) {
    const t = this.touches.get(e.pointerId);
    const s = this.$scroll;
    if (this.touches.size === 1) {
      s.scrollBy(t.x - e.clientX, t.y - e.clientY);
      t.x = e.clientX; t.y = e.clientY;
      return;
    }
    t.x = e.clientX; t.y = e.clientY;
    const [a, b] = [...this.touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    if (!this.pinch) { this.pinch = { d, z: this.zoom, cx, cy }; return; }
    s.scrollBy(this.pinch.cx - cx, this.pinch.cy - cy);
    this.pinch.cx = cx; this.pinch.cy = cy;
    const r = s.getBoundingClientRect();
    const z = (this.pinch.z * d) / this.pinch.d;
    if (Math.abs(z - this.zoom) / this.zoom > 0.01) this.setZoom(z, cx - r.left, cy - r.top);
  }

  // ---------- texto ----------
  openText(p, pt) {
    const size = (10 + this.set.w * 2) / 800;
    const ta = el('textarea', { class: 'ink-text', rows: 1, cols: 12, spellcheck: 'false', placeholder: 'Texto…' });
    ta.style.left = pt[0] * 100 + '%';
    ta.style.top = `calc(var(--pw) * ${pt[1] - p.offY})`;
    ta.style.fontSize = `calc(var(--pw) * ${size})`;
    ta.style.color = this.set.c;
    ta.addEventListener('input', () => {
      const lines = ta.value.split('\n');
      ta.rows = lines.length;
      ta.cols = Math.max(12, ...lines.map((l) => l.length + 2));
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { ta.value = ''; ta.blur(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
    });
    ta.addEventListener('blur', () => this.commitText());
    p.el.append(ta);
    this.textEdit = { ta, p, pt, size, c: this.set.c };
    setTimeout(() => ta.focus(), 30);
  }

  commitText() {
    const t = this.textEdit;
    if (!t) return;
    this.textEdit = null;
    const text = t.ta.value.replace(/\s+$/, '');
    t.ta.remove();
    if (!text) return;
    const s = { id: newId(), t: 'text', c: t.c, w: t.size, p: [t.pt.slice(0, 2)], text };
    (this.ann.strokes[t.p.key] ||= []).push(s);
    this.undo.push({ add: [], del: [{ key: t.p.key, s }] });
    this.redo = [];
    this.changed();
    this.redrawKey(t.p.key);
  }

  // ---------- deshacer / rehacer ----------
  apply(op) {
    for (const e of op.del) {
      this.ann.strokes[e.key] = (this.ann.strokes[e.key] || []).filter((s) => s.id !== e.s.id);
      this.ann.removed[e.s.id] = Date.now();
    }
    for (const e of op.add) {
      e.s = { ...e.s, id: newId() }; // id nuevo: el anterior quedó marcado como borrado
      (this.ann.strokes[e.key] ||= []).push(e.s);
    }
    this.changed();
    this.redrawAll();
    return { add: op.del, del: op.add };
  }
  doUndo() { if (this.undo.length) this.redo.push(this.apply(this.undo.pop())); this.updateUndo(); }
  doRedo() { if (this.redo.length) this.undo.push(this.apply(this.redo.pop())); this.updateUndo(); }
  updateUndo() {
    this.$undo.disabled = !this.undo.length;
    this.$redo.disabled = !this.redo.length;
  }

  changed() {
    this.updateUndo();
    clearTimeout(this.st);
    this.pending = true;
    this.st = setTimeout(() => this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.st);
    if (!this.pending) return;
    this.pending = false;
    await store.putAnn(this.doc.id, this.ann);
    await store.saveDoc(this.doc);
  }

  // ---------- barra de herramientas ----------
  setTool(t) {
    this.commitText();
    this.tool = t;
    this.savePrefs();
    this.refreshTools();
  }
  setColor(c) {
    this.set.c = c;
    if (this.tool === 'hand' || this.tool === 'eraser') this.tool = 'pen';
    this.savePrefs();
    this.refreshTools();
  }
  refreshTools() {
    for (const b of this.$tools.querySelectorAll('.tool')) {
      b.setAttribute('aria-pressed', b.dataset.tool === this.tool);
    }
    const c = this.set.c;
    let found = false;
    for (const b of this.$tools.querySelectorAll('button.sw')) {
      const on = b.dataset.c === c;
      found ||= on;
      b.setAttribute('aria-pressed', on);
    }
    this.$custom.classList.toggle('on', !found);
    if (!found) this.$custom.value = c;
    this.$width.value = this.set.w;
    this.$stage.dataset.tool = this.tool;
    this.$stage.style.touchAction = this.tool === 'hand' ? 'pan-x pan-y' : 'none';
  }

  moreMenu(anchor) {
    const { doc } = this;
    menu(anchor, [
      {
        icon: 'finger', label: this.finger ? 'Dibujar con el dedo: sí (tocar para desactivar)' : 'Dibujar con el dedo: no (tocar para activar)',
        onClick: () => {
          this.finger = !this.finger; this.penSeen = true; this.savePrefs();
          toast(this.finger ? 'El dedo dibuja. Usa dos dedos para mover y hacer zoom.' : 'El dedo desplaza; el lápiz o el ratón dibujan.');
        },
      },
      doc.type === 'canvas' && {
        icon: 'page', label: 'Tipo de papel…',
        onClick: () => menu(anchor, PAPERS.map(([id, label]) => ({
          label, onClick: () => {
            doc.paper = id;
            store.saveDoc(doc);
            for (const p of this.pages) p.el.dataset.paper = id;
          },
        }))),
      },
      doc.type !== 'web' && { icon: 'download', label: 'Exportar esta página como imagen', onClick: () => this.exportPage() },
      doc.sourceUrl && { icon: 'link', label: 'Abrir página original', onClick: () => window.open(doc.sourceUrl, '_blank', 'noopener') },
      '-',
      { icon: 'trash', danger: true, label: 'Borrar anotaciones de esta página', onClick: () => this.clearPage() },
    ]);
  }

  async clearPage() {
    const p = this.pages[this.curPage || 0];
    const arr = p && this.ann.strokes[p.key];
    if (!arr?.length) return toast('Esta página no tiene anotaciones.');
    if (!(await askConfirm('Borrar anotaciones', 'Se borrarán todas las anotaciones de esta página. Puedes deshacerlo.', 'Borrar'))) return;
    this.undo.push(this.apply({ add: [], del: arr.map((s) => ({ key: p.key, s })) }));
    this.redo = [];
    this.updateUndo();
  }

  async exportPage() {
    const p = this.pages[this.curPage || 0];
    if (!p) return;
    const W = 1800, H = Math.round(W * p.aspect);
    const c = el('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (this.doc.type === 'pdf') {
      const page = await this.pdf.getPage(p.i + 1);
      const v1 = page.getViewport({ scale: 1 });
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: W / v1.width }) }).promise;
    } else if (this.doc.type === 'image') ctx.drawImage(this.img, 0, 0, W, H);
    for (const s of this.strokesOf(p)) drawStroke(ctx, s, W, p.offY);
    c.toBlob((blob) => {
      const a = el('a', { href: URL.createObjectURL(blob), download: `${this.doc.title} - p${p.i + 1}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  }

  // ---------- navegación ----------
  onScroll() {
    if (this.sraf) return;
    this.sraf = requestAnimationFrame(() => {
      this.sraf = 0;
      const n = this.pages.length;
      if (!n || !this.$scroll) return;
      const y = this.$scroll.scrollTop + this.$scroll.clientHeight * 0.35;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.pages[mid].el.offsetTop <= y) lo = mid; else hi = mid - 1;
      }
      this.curPage = lo;
      const web = this.doc.type === 'web';
      this.$page.hidden = web || (n === 1 && this.doc.type !== 'canvas');
      this.$page.textContent = `${lo + 1} / ${n}`;
      clearTimeout(this.pt);
      this.pt = setTimeout(() => this.savePos(), 800);
    });
  }

  savePos() {
    const p = this.pages[this.curPage];
    if (!p || !this.$scroll) return;
    const f = (this.$scroll.scrollTop - p.el.offsetTop) / (p.el.offsetHeight || 1);
    this.doc.lastPos = { i: p.i, f: Math.max(0, Math.min(1, f)) };
    this.doc.openedAt = Date.now();
    store.saveDoc(this.doc, { local: true });
  }

  async askPage() {
    const v = await askText('Ir a la página', { type: 'number', ok: 'Ir', value: String((this.curPage || 0) + 1), hint: `De 1 a ${this.pages.length}` });
    const n = parseInt(v, 10);
    if (n >= 1 && n <= this.pages.length) this.$scroll.scrollTop = this.pages[n - 1].el.offsetTop - 8;
  }

  onKey(e) {
    if (e.target.closest('input, textarea, dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.doRedo(); }
    else if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.setZoom(this.zoom * 1.2); }
    else if (mod && e.key === '-') { e.preventDefault(); this.setZoom(this.zoom / 1.2); }
    else if (mod && e.key === '0') { e.preventDefault(); this.setZoom(1); }
  }

  async close() {
    this.commitText();
    this.cancelStroke();
    this.savePos();
    clearTimeout(this.pt);
    clearTimeout(this.rt);
    await this.flush();
    this.ac.abort();
    this.offStore?.();
    this.io.disconnect();
    this.ro?.disconnect();
    this.wro?.disconnect();
    for (const p of this.pages) p.task?.cancel();
    this.pdf?.destroy();
    if (this.url) URL.revokeObjectURL(this.url);
    store.releaseAnn(this.doc.id);
    this.root.innerHTML = '';
    this.$scroll = null;
    this.onClose?.();
  }
}
