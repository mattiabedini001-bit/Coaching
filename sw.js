/* Service worker: tiene in memoria l'app per aprirla anche senza rete. I dati passano sempre dallo script Google. */
const CACHE = 'scheda-v4';
const ASSETS = ['./', './index.html', './app.js', './style.css', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = url.origin + url.pathname;
  const fromCache = () => caches.match(key).then((r) => r || caches.match(req, { ignoreSearch: true })).then((r) => r || caches.match('./index.html'));
  // rete prima (per ricevere gli aggiornamenti), cache se la rete manca o è lenta
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { fromCache().then((r) => { if (!done && r) { done = true; resolve(r); } }); }, 3500);
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((r) => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  }));
});
