/* Mana Tape service worker — an installable shell that is never stale after a deploy.
   The server pins every asset URL in index.html to its content (`?v=<sha256 prefix>`), so:
   - a pinned asset is immutable: cache first;
   - the shell (index.html) and anything unpinned (fonts, icons, manifest): network first, cache only offline;
   - a shell that the network cannot give in time, or a 5xx in its place (the SSH launcher's 502 while the
     tunnel is down), is answered with the cached shell, so the panel shows its own «Повторити» screen;
   - /api/* is never touched: the panel must see a failed request as offline, never as stale data;
   - each fresh shell warms the assets it names and drops pinned assets it no longer names;
   - a new CACHE name (a changed worker) drops every older cache on activate. */
const CACHE = 'forge-shell-v46';
const PINNED = /(?:src|href)="(\/[^"?#]+\?v=[^"]+)"/g;

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(fetch('/', {cache: 'no-store'}).then(r => r.ok && keepShell(r)).catch(() => {}));
});

self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(url.searchParams.has('v') ? cacheFirst(request) : networkFirst(event, url));
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

const SHELL_WAIT = 4000;

async function networkFirst(event, url) {
  const request = event.request;
  const shell = request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const network = fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(shell ? keepShell(copy) : caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  });
  if (!shell) {
    try { return await network; } catch (error) { const hit = await caches.match(request); if (hit) return hit; throw error; }
  }
  const cached = await caches.match('/');
  if (!cached) return network;
  // A hung link must not keep the page blank: the cached shell answers after SHELL_WAIT, and a late
  // response still refreshes the cache for the next load.
  event.waitUntil(network.then(() => {}, () => {}));
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, SHELL_WAIT, cached); });
  try {
    const response = await Promise.race([network, late]);
    return response.status >= 500 ? cached : response;
  } catch {
    return cached;
  } finally {
    clearTimeout(timer);
  }
}

/* Store the shell under '/', fetch the pinned assets it names, drop pinned assets of earlier deploys. */
async function keepShell(response) {
  const cache = await caches.open(CACHE);
  const text = await response.clone().text();
  await cache.put('/', response);
  const wanted = new Set([...text.matchAll(PINNED)].map(m => new URL(m[1], location.origin).href));
  for (const key of await cache.keys()) {
    if (new URL(key.url).searchParams.has('v') && !wanted.has(key.url)) await cache.delete(key);
  }
  await Promise.all([...wanted].map(href => cache.match(href).then(hit => hit || cache.add(href)).catch(() => {})));
}
