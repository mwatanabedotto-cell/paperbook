// Almacenamiento local (IndexedDB) + estado en memoria compartido por toda la app.
const DB_NAME = 'paperbook';
let dbp;

function open() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      const has = (n) => d.objectStoreNames.contains(n);
      if (!has('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      for (const n of ['blobs', 'ann', 'text']) if (!has(n)) d.createObjectStore(n);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

const idb = {
  get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
  all: (s) => tx(s, 'readonly', (o) => o.getAll()),
  put: (s, v, k) => tx(s, 'readwrite', (o) => o.put(v, k)),
  del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
};

export const newId = () =>
  Date.now().toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 8);

/** Texto sin acentos ni mayúsculas, para comparar ("Apéndice" = "apendice"). */
export const foldText = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Igual que foldText, pero conserva la correspondencia con el texto original. */
export function fold(str) {
  const map = [];
  let t = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const c = code < 128 ? (code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : str[i]) : foldText(str[i]);
    for (let j = 0; j < c.length; j++) { t += c[j]; map.push(i); }
  }
  return { t, map };
}

export const emptyAnn = () => ({ v: 1, strokes: {}, removed: {} });

/** Une dos conjuntos de anotaciones: unión de trazos por id, menos los borrados. */
export function mergeAnn(a, b) {
  a ||= emptyAnn();
  b ||= emptyAnn();
  const removed = { ...a.removed, ...b.removed };
  const strokes = {};
  for (const key of new Set([...Object.keys(a.strokes), ...Object.keys(b.strokes)])) {
    const byId = new Map();
    for (const s of [...(a.strokes[key] || []), ...(b.strokes[key] || [])]) {
      if (!removed[s.id]) byId.set(s.id, s);
    }
    if (byId.size) strokes[key] = [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : 1));
  }
  return { v: 1, strokes, removed };
}

const listeners = new Set();
const openAnn = new Map(); // anotaciones "vivas" del documento abierto

export const store = {
  docs: new Map(),

  async init() {
    for (const d of await idb.all('docs')) this.docs.set(d.id, d);
    navigator.storage?.persist?.().catch(() => {});
  },

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(type, detail) { for (const fn of listeners) fn(type, detail); },

  visible() {
    return [...this.docs.values()].filter((d) => !d.deleted);
  },

  /** Guarda el documento. `local` = cambio que no hace falta subir a Drive. */
  async saveDoc(doc, { local = false } = {}) {
    if (!local) {
      doc.dirty = true;
      doc.rev = (doc.rev || 0) + 1;
    }
    this.docs.set(doc.id, doc);
    await idb.put('docs', doc);
    this.emit(local ? 'local' : 'change', doc);
  },

  async purgeDoc(id) {
    this.docs.delete(id);
    openAnn.delete(id);
    await Promise.all(['docs', 'blobs', 'ann', 'text'].map((s) => idb.del(s, id)));
  },

  getBlob: (id) => idb.get('blobs', id),
  putBlob: (id, blob) => idb.put('blobs', blob, id),
  delBlob: (id) => idb.del('blobs', id),

  async getAnn(id) {
    return openAnn.get(id) || (await idb.get('ann', id)) || emptyAnn();
  },
  /** Marca las anotaciones de un documento como abiertas (objeto compartido). */
  async holdAnn(id) {
    const a = await this.getAnn(id);
    openAnn.set(id, a);
    return a;
  },
  releaseAnn(id) { openAnn.delete(id); },
  async putAnn(id, ann, { replaced = false } = {}) {
    if (openAnn.has(id)) openAnn.set(id, ann);
    await idb.put('ann', ann, id);
    if (replaced) this.emit('ann', { id, ann });
  },
  delAnn: (id) => idb.del('ann', id),

  getText: (id) => idb.get('text', id),
  putText: (id, pages) => idb.put('text', pages, id),
  delText: (id) => idb.del('text', id),
};
