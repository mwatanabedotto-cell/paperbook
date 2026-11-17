// Service worker: deja la app disponible sin conexión.
const CACHE = 'paperbook-v5';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg',
  'js/app.js', 'js/store.js', 'js/ink.js', 'js/ui.js', 'js/viewer.js', 'js/drive.js', 'js/web.js', 'js/search.js', 'descargar.html',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Sirve de caché al instante y actualiza en segundo plano.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // la app (raíz o index.html) comparte una entrada; el resto de páginas van por su URL
      const isApp = e.request.mode === 'navigate' && /\/(index\.html)?$/.test(url.pathname);
      const key = isApp ? './' : e.request;
      const hit = await cache.match(key, { ignoreSearch: isApp });
      const net = fetch(e.request).then((r) => {
        if (r.ok) cache.put(key, r.clone());
        return r;
      });
      if (hit) { net.catch(() => {}); return hit; }
      return net;
    }));
});
