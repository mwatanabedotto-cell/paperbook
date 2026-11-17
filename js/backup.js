// Copia en un solo archivo: la forma de pasar documentos y anotaciones entre
// dispositivos sin configurar nada. Al cargarla se FUSIONA con lo que ya hay
// (misma lógica que la sincronización), así que nunca borra trabajo.
import { store, mergeAnn, emptyAnn } from './store.js';
import { makeThumb } from './viewer.js';
import { indexSoon } from './search.js';

const MAGIC = 'PBK1';
const FIELDS = ['id', 'title', 'type', 'mime', 'folder', 'createdAt', 'updatedAt', 'size', 'sourceUrl', 'pages', 'paper', 'tags'];

/** Crea el archivo de copia. `full` incluye los PDF, imágenes y páginas; si no, solo anotaciones y lienzos. */
export async function exportBackup({ full }) {
  const entries = [];
  const blobs = [];
  for (const d of store.visible()) {
    const doc = {};
    for (const k of FIELDS) if (d[k] != null) doc[k] = d[k];
    let size = 0;
    if (full && d.type !== 'canvas' && !d.noBlob) {
      const blob = await store.getBlob(d.id);
      if (blob) { size = blob.size; blobs.push(blob); }
    }
    entries.push({ doc, ann: await store.getAnn(d.id), size });
  }
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, full, at: Date.now(), entries }));
  const day = new Date().toISOString().slice(0, 10);
  const name = `Paperbook-${full ? 'copia' : 'anotaciones'}-${day}.paperbook`;
  return new File([MAGIC + String(header.length).padStart(12, '0'), header, ...blobs], name, { type: 'application/octet-stream' });
}

/** Entrega el archivo: hoja de compartir del sistema si admite archivos, o descarga. */
export async function deliver(file) {
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    }
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return 'downloaded';
}

const norm = (v) => (v == null ? '' : v);

/** Firma del estado sincronizable de un documento: si coincide en dos dispositivos, están al día. */
export function docSig(d, ann) {
  let n = 0, last = '';
  for (const arr of Object.values(ann?.strokes || {})) {
    n += arr.length;
    for (const s of arr) if (s.id > last) last = s.id;
  }
  return [norm(d.updatedAt), norm(d.title), norm(d.folder), norm(d.paper), (d.tags || []).join(','), d.pages || 0, n, last,
    Object.keys(ann?.removed || {}).length].join('|');
}

export function metaOf(d) {
  const doc = {};
  for (const k of FIELDS) if (d[k] != null) doc[k] = d[k];
  return doc;
}

/**
 * Fusiona un documento recibido (de una copia o de otro dispositivo) con el local.
 * Devuelve 'added' | 'merged' | 'same' | 'missing' | 'skipped'.
 */
export async function mergeIncoming(meta, ann, blob) {
  const id = meta?.id;
  if (!id) return 'skipped';
  const L = store.docs.get(id);
  if (L?.deleted) return 'skipped'; // eliminado aquí: no se resucita

  if (L) {
    const mine = await store.getAnn(id);
    const before = docSig(L, mine);
    const key = (d) => JSON.stringify([norm(d.title), norm(d.folder), norm(d.paper), d.tags || []]);
    const ru = meta.updatedAt || 0, lu = L.updatedAt || 0;
    if (ru > lu || (ru === lu && key(meta) > key(L))) {
      for (const k of ['title', 'folder', 'paper', 'tags', 'updatedAt']) L[k] = meta[k];
    }
    L.pages = Math.max(L.pages || 0, meta.pages || 0) || undefined;
    const merged = mergeAnn(mine, ann);
    const gotBlob = !!(L.noBlob && blob);
    if (!gotBlob && docSig(L, merged) === before) return 'same';
    await store.putAnn(id, merged, { replaced: true });
    if (gotBlob) {
      await store.putBlob(id, blob);
      L.noBlob = false;
      L.thumb = await makeThumb(L.type, blob);
    }
    await store.saveDoc(L);
    indexSoon(L);
    return 'merged';
  }
  if (meta.type !== 'canvas' && !blob) return 'missing';
  const d = { ...meta };
  if (blob) {
    await store.putBlob(id, blob);
    d.thumb = await makeThumb(d.type, blob);
  }
  await store.putAnn(id, ann || emptyAnn());
  await store.saveDoc(d);
  indexSoon(d);
  return 'added';
}

/** Carga una copia y la fusiona. Devuelve { added, merged, missing }. */
export async function importBackup(file) {
  const head = await file.slice(0, 16).text();
  const n = parseInt(head.slice(4), 10);
  if (!head.startsWith(MAGIC) || !(n > 0)) throw new Error('Este archivo no es una copia de Paperbook.');
  let data;
  try { data = JSON.parse(await file.slice(16, 16 + n).text()); } catch { throw new Error('La copia está dañada o incompleta.'); }
  let off = 16 + n;
  const out = { added: 0, merged: 0, missing: 0, same: 0, skipped: 0 };
  for (const e of data.entries || []) {
    const slice = e.size ? file.slice(off, off + e.size) : null;
    off += e.size || 0;
    const blob = slice ? new Blob([await slice.arrayBuffer()], { type: e.doc?.mime || '' }) : null;
    out[await mergeIncoming(e.doc, e.ann, blob)]++;
  }
  out.merged += out.same;
  return out;
}
