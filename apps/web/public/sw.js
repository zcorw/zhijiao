const CACHE = 'zhijiao-shell-v1';
async function cacheShell(cache, response) {
  if (!response.ok) return response;
  const html = await response.clone().text();
  const resources = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(match => match[1]);
  await cache.addAll([...new Set(resources), '/icon.svg', '/manifest.webmanifest']);
  await cache.put('/', response.clone());
  return response;
}
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(async cache => cacheShell(cache, await fetch('/', {cache:'no-cache'})))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => fetch(event.request).then(response => cacheShell(cache, response)).catch(() => cache.match('/').then(response => response || Response.error()))));
  } else if (url.pathname.startsWith('/assets/') || ['/icon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }));
  }
});
