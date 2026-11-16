// Almacenamiento local (IndexedDB) + estado en memoria compartido por toda la app.
const DB_NAME = 'paperbook';
let dbp;

function open() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: 'id' });
      d.createObjectStore('blobs');
      d.createObjectStore('ann');
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
    await Promise.all([idb.del('docs', id), idb.del('blobs', id), idb.del('ann', id)]);
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
};
