// Índice de texto de los documentos, para buscar dentro de ellos desde la biblioteca.
import { store, foldText } from './store.js';
import { loadPdf } from './viewer.js';

const MAX_CHARS = 4e6;
const INDEXABLE = new Set(['pdf', 'web']);

/** Extrae el texto de un documento como lista de páginas. */
export async function extract(type, blob) {
  if (type === 'pdf') {
    const pdf = await loadPdf(blob);
    const pages = [];
    let total = 0;
    try {
      for (let i = 1; i <= pdf.numPages && total < MAX_CHARS; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const s = tc.items.map((it) => it.str + (it.hasEOL ? ' ' : '')).join('').normalize('NFC');
        pages.push(s);
        total += s.length;
        page.cleanup();
      }
    } finally {
      pdf.destroy();
    }
    return pages;
  }
  if (type === 'web') {
    const d = new DOMParser().parseFromString(await blob.text(), 'text/html');
    d.querySelectorAll('style, script, noscript, template').forEach((n) => n.remove());
    const parts = [];
    const w = d.createTreeWalker(d.body || d.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.data);
    return [parts.join(' ').replace(/\s+/g, ' ').normalize('NFC').slice(0, MAX_CHARS)];
  }
  return null;
}

let cache = null; // id → { pages, folded }
const entry = (pages) => ({ pages, folded: pages.map(foldText) });

async function indexDoc(d) {
  if (d.indexed || d.deleted || d.noBlob || !INDEXABLE.has(d.type)) return;
  const blob = await store.getBlob(d.id);
  if (!blob) return;
  let pages = [];
  try { pages = (await extract(d.type, blob)) || []; } catch (e) { console.warn('index', e); }
  if (!store.docs.has(d.id)) return;
  await store.putText(d.id, pages);
  cache?.set(d.id, entry(pages));
  d.indexed = true;
  await store.saveDoc(d, { local: true });
}

let queue = Promise.resolve();
/** Indexa en segundo plano, de uno en uno. */
export function indexSoon(d) {
  queue = queue.then(() => indexDoc(d)).catch(() => {});
  return queue;
}

export function indexPending() {
  for (const d of store.visible()) if (!d.indexed && INDEXABLE.has(d.type)) indexSoon(d);
}

/** Busca en el contenido. Devuelve Map id → { n, page, snip }. */
export async function searchContent(q) {
  const nq = foldText(q).trim();
  const out = new Map();
  if (nq.length < 3) return out;
  if (!cache) {
    const c = new Map();
    for (const d of store.visible()) {
      if (!d.indexed) continue;
      const pages = await store.getText(d.id);
      if (pages) c.set(d.id, entry(pages));
    }
    cache ||= c;
  }
  for (const [id, e] of cache) {
    let n = 0, first = null;
    e.folded.forEach((t, i) => {
      let k = t.indexOf(nq);
      if (k >= 0 && !first) first = { page: i, k };
      while (k >= 0) { n++; k = t.indexOf(nq, k + nq.length); }
    });
    if (!n) continue;
    const src = e.pages[first.page];
    const a = Math.max(0, first.k - 40);
    out.set(id, { n, page: first.page, snip: (a ? '…' : '') + src.slice(a, first.k + nq.length + 70).trim() + '…' });
  }
  return out;
}
