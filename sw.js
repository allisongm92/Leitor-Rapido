/* Speed Reader RSVP — Service Worker v3
   Local: cache-first | CDN: network-first com fallback
*/
const CACHE = 'rsvp-v4';
const LOCAL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];
const CDN   = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // CORREÇÃO: Promise.all garante que se um arquivo falhar, a instalação falha.
      // Isso evita um PWA "zumbi" que parece funcionar mas quebra offline.
      Promise.all([c.addAll(LOCAL), c.addAll(CDN)])
    )
  );
  self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Ignora requisições não-GET e chrome-extension
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  const isCDN = CDN.some(u => req.url.startsWith(new URL(u).origin));

  if (isCDN) {
    // Network-first: CDN pode atualizar; fallback para cache se offline
    e.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return res;
      }).catch(() => caches.match(req))
    );
  } else {
    // Cache-first: assets locais servidos instantaneamente
    e.respondWith(
      caches.match(req).then(cached => cached ||
        fetch(req).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
          return res;
        })
      )
    );
  }
});
