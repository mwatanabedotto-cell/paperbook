// Lectura en voz alta (síntesis de voz del sistema).
// Lee frase a frase desde donde estás mirando, resalta la frase y sigue la lectura con la vista.
import { bounds } from './ink.js';
import { icon, el, toast } from './ui.js';

const synth = window.speechSynthesis;
export const ttsSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

const RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const MAX = 220; // caracteres por frase (Chrome corta las frases muy largas)
const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,section,article,figcaption,caption,dt,dd,header,footer,main,aside,nav,table,tr,ul,ol,br';
const LANG_NAMES = { es: 'Español', pt: 'Português', en: 'English' };

const prefs = () => { try { return JSON.parse(localStorage.getItem('pb.tts')) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem('pb.tts', JSON.stringify({ ...prefs(), ...p })); } catch {} };

/** Divide un texto en frases. Devuelve rangos [a, b) sobre el texto original. */
export function sentences(str) {
  const out = [];
  const re = /[^.!?…;:\n]+(?:[.!?…;:]+["»”')\]]*|\n|$)/g;
  let m;
  while ((m = re.exec(str))) {
    if (!m[0]) { re.lastIndex++; continue; }
    let a = m.index, b = m.index + m[0].length;
    while (a < b && /\s/.test(str[a])) a++;
    while (b > a && /\s/.test(str[b - 1])) b--;
    // frases demasiado largas: cortar en comas o espacios
    while (b - a > MAX) {
      const chunk = str.slice(a, a + MAX);
      let cut = Math.max(chunk.lastIndexOf(', '), chunk.lastIndexOf(' — '));
      if (cut < MAX * 0.4) cut = chunk.lastIndexOf(' ');
      if (cut < MAX * 0.4) cut = MAX;
      out.push([a, a + cut + 1]);
      a += cut + 1;
      while (a < b && /\s/.test(str[a])) a++;
    }
    if (b > a && /[\p{L}\p{N}]/u.test(str.slice(a, b))) out.push([a, b]);
  }
  return out;
}

/** Idioma probable de un texto: 'pt', 'es' o 'en'. */
export function detectLang(text) {
  const t = ' ' + text.toLowerCase().slice(0, 4000) + ' ';
  const count = (re) => (t.match(re) || []).length;
  const pt = count(/\b(não|são|também|você|pelo|pela|dos|das|uma|com|em|ao|aos|seu|sua)\b|ção\b|ções\b|ã|õ/g);
  const es = count(/\b(el|los|las|del|una|con|en|al|su|sus|pero|también|está)\b|ción\b|ciones\b|ñ/g);
  const en = count(/\b(the|and|of|with|is|are|this|that|for|from)\b/g);
  if (en > pt && en > es) return 'en';
  return pt > es ? 'pt' : 'es';
}

function voicesNow() {
  return synth ? synth.getVoices() : [];
}

function waitVoices() {
  return new Promise((res) => {
    if (voicesNow().length) return res(voicesNow());
    const done = () => { synth.removeEventListener?.('voiceschanged', done); res(voicesNow()); };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1500);
  });
}

function bestVoice(lang) {
  const vs = voicesNow().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
  if (!vs.length) return null;
  const pref = { pt: ['pt-br'], es: ['es-us', 'es-mx', 'es-419', 'es-es'], en: ['en-us', 'en-gb'] }[lang] || [];
  const score = (v) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    let s = 0;
    const i = pref.indexOf(l);
    if (i >= 0) s += 10 - i;
    if (/google|natural|neural|online/i.test(v.name)) s += 5;
    if (v.default) s += 1;
    return s;
  };
  return vs.sort((a, b) => score(b) - score(a))[0];
}

/** Controlador de lectura conectado a un visor. */
export class Reader {
  constructor(viewer) {
    this.v = viewer;
    this.state = 'off'; // off | playing | paused
    this.units = [];
    this.i = 0;
    this.page = 0;
    this.tok = 0;
    this.webUnits = null;
    const p = prefs();
    this.rate = RATES.includes(p.rate) ? p.rate : 1;
    this.voiceName = p.voice || '';
    this.buildBar();
  }

  // ---------- interfaz ----------
  buildBar() {
    const b = (ic, title, fn) => el('button', { class: 'ib', title, 'aria-label': title, html: icon(ic), onclick: fn });
    this.$play = b('play', 'Leer', () => this.toggle());
    this.$status = el('span', { class: 'tstatus', 'aria-live': 'polite' }, '');
    this.$rate = el('select', {
      class: 'tsel', title: 'Velocidad', 'aria-label': 'Velocidad de lectura',
      onchange: (e) => { this.rate = +e.target.value; savePrefs({ rate: this.rate }); this.restartUnit(); },
    }, ...RATES.map((r) => el('option', { value: r, selected: r === this.rate }, String(r).replace('.', ',') + '×')));
    this.$voice = el('select', {
      class: 'tsel voice', title: 'Voz', 'aria-label': 'Voz',
      onchange: (e) => { this.voiceName = e.target.value; savePrefs({ voice: this.voiceName }); this.restartUnit(); },
    });
    this.$bar = el('div', { class: 'ttsbar', hidden: true, role: 'region', 'aria-label': 'Lectura en voz alta' },
      b('prev', 'Frase anterior', () => this.step(-1)),
      this.$play,
      b('next', 'Frase siguiente', () => this.step(1)),
      this.$status,
      this.$rate, this.$voice,
      b('close', 'Cerrar lectura', () => this.close()));
  }

  async fillVoices() {
    const vs = await waitVoices();
    const groups = new Map();
    for (const v of vs) {
      const l = v.lang.slice(0, 2).toLowerCase();
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(v);
    }
    const order = ['es', 'pt', 'en', ...[...groups.keys()].filter((k) => !['es', 'pt', 'en'].includes(k)).sort()];
    this.$voice.replaceChildren(el('option', { value: '' }, 'Voz automática (según el idioma)'));
    for (const l of order) {
      if (!groups.has(l)) continue;
      const og = el('optgroup', { label: LANG_NAMES[l] || l });
      for (const v of groups.get(l).sort((a, b) => a.name.localeCompare(b.name))) {
        og.append(el('option', { value: v.name, selected: v.name === this.voiceName }, `${v.name} (${v.lang})`));
      }
      this.$voice.append(og);
    }
    return vs.length;
  }

  status(t) { this.$status.textContent = t; }

  setState(s) {
    this.state = s;
    const playing = s === 'playing';
    this.$play.innerHTML = icon(playing ? 'pause' : 'play');
    this.$play.title = playing ? 'Pausar' : 'Leer';
    this.$play.setAttribute('aria-label', this.$play.title);
    this.v.$ttsBtn?.setAttribute('aria-pressed', s !== 'off');
  }

  async open() {
    if (!ttsSupported) return toast('Este navegador no puede leer en voz alta.', { error: true });
    this.$bar.hidden = false;
    this.v.$ttsBtn?.setAttribute('aria-pressed', 'true');
    this.status('Preparando…');
    const n = await this.fillVoices();
    if (!n) {
      this.status('No hay voces instaladas en este dispositivo.');
      toast(/Android/i.test(navigator.userAgent)
        ? 'Instala o activa una voz en Ajustes → Accesibilidad → Texto a voz (por ejemplo, «Servicios de voz de Google»).'
        : 'Este dispositivo no tiene voces de lectura. En Linux instala «speech-dispatcher» y «espeak-ng».', { error: true, ms: 9000 });
      return;
    }
    await this.start();
  }

  close() {
    this.stop();
    this.$bar.hidden = true;
    this.setState('off');
    this.v.$ttsBtn?.setAttribute('aria-pressed', 'false');
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else this.start();
  }

  // ---------- texto ----------
  /** Frases de una página: { text, key, rects (normalizados), y } */
  async pageUnits(i) {
    const v = this.v;
    if (v.doc.type === 'pdf') {
      const c = await v.pageText(i);
      return sentences(c.str).map(([a, b]) => {
        const rects = [];
        for (const sg of c.segs) {
          if (sg.s + sg.n <= a || sg.s >= b) continue;
          const f0 = (Math.max(a, sg.s) - sg.s) / sg.n, f1 = (Math.min(b, sg.s + sg.n) - sg.s) / sg.n;
          rects.push({ x: sg.x + sg.w * f0, y: sg.y, w: sg.w * (f1 - f0), h: sg.h });
        }
        return { text: c.str.slice(a, b), key: i, rects, y: rects[0]?.y ?? 0 };
      });
    }
    if (v.doc.type === 'web') return this.webText();
    // lienzo o imagen: las notas de texto, de arriba abajo
    const key = v.pages[i]?.key ?? i;
    return (v.ann.strokes[key] || [])
      .filter((s) => s.t === 'text' && s.text?.trim())
      .map((s) => {
        const b = bounds(s);
        return { text: s.text, key, rects: [{ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }], y: b[1] };
      })
      .sort((a, b) => a.y - b.y);
  }

  webText() {
    if (this.webUnits) return this.webUnits;
    const d = this.v.frame?.contentDocument;
    const out = [];
    if (!d?.body) return (this.webUnits = out);
    const parts = []; // { node, start }
    let str = '', lastBlock = null;
    const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (/^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/.test(n.parentNode?.nodeName) || !n.data.trim()) continue;
      const block = n.parentElement?.closest(BLOCK);
      if (block !== lastBlock && str) str += '\n';
      lastBlock = block;
      parts.push({ node: n, start: str.length });
      str += n.data;
    }
    const W = this.v.webWidth;
    const range = d.createRange();
    for (const [a, b] of sentences(str)) {
      const rects = [];
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k], end = p.start + p.node.data.length;
        if (end <= a || p.start >= b) continue;
        range.setStart(p.node, Math.max(a, p.start) - p.start);
        range.setEnd(p.node, Math.min(b, end) - p.start);
        for (const r of range.getClientRects()) {
          if (r.width > 0 && r.height > 0) rects.push({ x: r.left / W, y: r.top / W, w: r.width / W, h: r.height / W });
        }
      }
      if (rects.length) out.push({ text: str.slice(a, b).replace(/\s+/g, ' '), key: 0, rects, y: rects[0].y });
    }
    return (this.webUnits = out);
  }

  pageCount() {
    const t = this.v.doc.type;
    return t === 'pdf' ? this.v.pdf.numPages : t === 'web' ? 1 : this.v.pages.length;
  }

  /** Posición de lectura inicial: la primera frase visible. */
  async start() {
    const v = this.v;
    this.stopSpeech();
    const s = v.$scroll;
    let page = 0, yTop = 0;
    if (v.doc.type === 'web') {
      yTop = (s.scrollTop - (v.pages[0]?.el.offsetTop || 0)) / v.pw;
    } else {
      page = v.curPage || 0;
      const pe = v.pages[page]?.el;
      if (pe) yTop = (s.scrollTop - pe.offsetTop) / v.pw;
    }
    await this.loadPage(page);
    let i = this.units.findIndex((u) => u.y >= yTop - 0.005);
    if (i < 0) i = this.units.length;
    this.i = i;
    if (!this.lang) {
      const sample = this.units.slice(0, 40).map((u) => u.text).join(' ');
      this.lang = detectLang(sample || '');
    }
    this.setState('playing');
    this.speakCurrent();
  }

  async loadPage(page) {
    this.page = page;
    this.units = await this.pageUnits(page);
  }

  pickVoice() {
    if (this.voiceName) {
      const v = voicesNow().find((x) => x.name === this.voiceName);
      if (v) return v;
    }
    return bestVoice(this.lang || 'es') || null;
  }

  async speakCurrent() {
    const tok = ++this.tok;
    // fin de página: pasar a la siguiente con texto
    while (this.i >= this.units.length) {
      if (this.page + 1 >= this.pageCount()) {
        this.status('Fin del documento');
        this.v.setTtsMark(null);
        this.setState('off');
        this.i = 0;
        this.page = 0;
        this.units = [];
        return;
      }
      await this.loadPage(this.page + 1);
      this.i = 0;
      if (tok !== this.tok) return;
    }
    const u = this.units[this.i];
    this.v.setTtsMark(u, true);
    const n = this.pageCount();
    this.status(n > 1 ? `Página ${this.page + 1} de ${n}` : 'Leyendo');
    const ut = new SpeechSynthesisUtterance(u.text);
    const voice = this.pickVoice();
    if (voice) { ut.voice = voice; ut.lang = voice.lang; } else ut.lang = { pt: 'pt-BR', en: 'en-US' }[this.lang] || 'es-ES';
    ut.rate = this.rate;
    ut.onend = () => {
      if (tok !== this.tok || this.state !== 'playing') return;
      this.i++;
      this.speakCurrent();
    };
    ut.onerror = (e) => {
      if (tok !== this.tok || e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') {
        this.setState('paused');
        this.status('Toca ▶ para empezar');
        return;
      }
      this.i++;
      if (this.state === 'playing') this.speakCurrent();
    };
    this.current = ut; // evita que el navegador lo descarte antes de tiempo
    synth.speak(ut);
  }

  stopSpeech() {
    this.tok++;
    try { synth.cancel(); } catch {}
  }

  pause() {
    this.stopSpeech();
    this.setState('paused');
    this.status('En pausa');
  }

  resume() {
    this.setState('playing');
    this.speakCurrent();
  }

  restartUnit() {
    if (this.state !== 'playing') return;
    this.stopSpeech();
    setTimeout(() => this.speakCurrent(), 60);
  }

  async step(dir) {
    if (this.state === 'off') return this.start();
    this.stopSpeech();
    this.i += dir;
    if (this.i < 0) {
      if (this.page > 0) {
        await this.loadPage(this.page - 1);
        this.i = Math.max(0, this.units.length - 1);
      } else this.i = 0;
    }
    if (this.state === 'playing') this.speakCurrent();
    else {
      const u = this.units[this.i];
      if (u) this.v.setTtsMark(u, true);
    }
  }

  stop() {
    this.stopSpeech();
    this.v.setTtsMark(null);
  }

  /** Al cambiar la maquetación de una página web, las posiciones cambian. */
  invalidate() { this.webUnits = null; }
}
