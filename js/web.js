// Captura de páginas web para leerlas sin conexión.
// Los navegadores no dejan descargar páginas de otros sitios (CORS), así que si la
// descarga directa falla se usa un proxy público configurable.

export const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url=';
export const getProxy = () => localStorage.getItem('pb.proxy') ?? DEFAULT_PROXY;
export const setProxy = (v) => localStorage.setItem('pb.proxy', v);

async function get(url, ms = 15000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), credentials: 'omit' });
    if (r.ok) return r;
  } catch {}
  const proxy = getProxy();
  if (!proxy) throw new Error('El sitio no permite la descarga directa y no hay proxy configurado.');
  const r = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(ms * 2), credentials: 'omit' });
  if (!r.ok) throw new Error(`No se pudo descargar (${r.status}).`);
  return r;
}

async function getText(url) {
  const r = await get(url);
  const buf = await r.arrayBuffer();
  let cs = /charset=([\w-]+)/i.exec(r.headers.get('content-type') || '')?.[1];
  if (!cs) {
    const headTxt = new TextDecoder('latin1').decode(buf.slice(0, 2048));
    cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(headTxt)?.[1];
  }
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

const toDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch {}
    }
  }));
}

/** Limpia HTML: quita scripts, marcos y manejadores de eventos. */
export function sanitize(html, baseUrl) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv], link[rel~="preload"], link[rel~="modulepreload"], link[rel~="prefetch"], link[rel~="manifest"]')
    .forEach((n) => n.remove());
  for (const n of d.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|action|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
        n.removeAttribute(a.name);
      }
    }
  }
  for (const img of d.querySelectorAll('img')) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazy && (!img.getAttribute('src') || /^data:/.test(img.getAttribute('src')))) img.setAttribute('src', lazy);
    img.removeAttribute('loading');
  }
  const head = d.head || d.documentElement.insertBefore(d.createElement('head'), d.body);
  const cs = d.createElement('meta');
  cs.setAttribute('charset', 'utf-8');
  head.prepend(cs);
  if (baseUrl) {
    const b = d.createElement('base');
    b.href = baseUrl;
    b.target = '_blank';
    head.prepend(b);
  }
  const st = d.createElement('style');
  st.textContent = 'html,body{height:auto!important;min-height:0!important;overflow:visible!important}body{overflow-wrap:break-word}img,video{max-width:100%;height:auto}';
  head.append(st);
  return d;
}

const serialize = (d) => '<!doctype html>\n' + d.documentElement.outerHTML;

/** Descarga una página y la empaqueta (imágenes y estilos incluidos cuando es posible). */
export async function capture(url, onProgress = () => {}) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  new URL(url); // valida
  onProgress('Descargando la página…');
  const d = sanitize(await getText(url), url);
  const abs = (u) => { try { return new URL(u, url).href; } catch { return null; } };

  const sheets = [...d.querySelectorAll('link[rel~="stylesheet"][href]')].slice(0, 15);
  onProgress('Guardando estilos…');
  await pool(sheets, 5, async (link) => {
    const href = abs(link.getAttribute('href'));
    if (!href) return;
    let css = await (await get(href)).text();
    css = css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|#)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      try { return `url("${new URL(u, href).href}")`; } catch { return m; }
    });
    const st = d.createElement('style');
    if (link.media) st.media = link.media;
    st.textContent = css;
    link.replaceWith(st);
  });

  const imgs = [...d.querySelectorAll('img[src]')].filter((i) => !/^data:/.test(i.getAttribute('src'))).slice(0, 80);
  d.querySelectorAll('picture source').forEach((s) => s.remove());
  let done = 0;
  await pool(imgs, 6, async (img) => {
    const src = abs(img.getAttribute('src'));
    if (src) {
      const blob = await (await get(src, 10000)).blob();
      if (blob.size <= 2.5e6 && /^image\//.test(blob.type)) {
        img.setAttribute('src', await toDataUrl(blob));
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
      }
    }
    onProgress(`Guardando imágenes… ${++done}/${imgs.length}`);
  });

  const title = (d.title || '').trim() || new URL(url).hostname;
  return { title, blob: new Blob([serialize(d)], { type: 'text/html' }) };
}

/** Prepara un archivo .html importado desde el dispositivo. */
export async function fromHtmlFile(file) {
  const d = sanitize(await file.text(), null);
  return { title: (d.title || '').trim(), blob: new Blob([serialize(d)], { type: 'text/html' }) };
}
