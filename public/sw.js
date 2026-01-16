const CACHE_VERSION = 'cashutube-v20260116c';
const CACHE_NAME = `${CACHE_VERSION}`;
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/favicon.ico',
  '/main.js',
  '/utils.js',
  '/blossom.html',
  '/upload-form.js',
  '/open-blob-form.js',
  '/list-blobs.js',
  '/mirror-blobs.js',
  '/lib/tailwind.min.css',
  '/lib/window.nostr.js',
  '/lib/lit.min.js',
  '/lib/@noble/hashes/_md.js',
  '/lib/@noble/hashes/utils.js',
  '/lib/@noble/hashes/sha256.js',
  '/lib/@noble/hashes/crypto.js',
  '/lib/@noble/hashes/_assert.js',
  '/wasm/cdk_wasm.js',
  '/wasm/cdk_wasm.d.ts',
  '/wasm/cdk_wasm_bg.wasm',
  '/wasm/cdk_wasm_bg.wasm.d.ts',
  '/wasm/package.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/channel') || url.pathname.startsWith('/api')) {
    return;
  }

  if (/^\/[0-9a-f]{64}$/i.test(url.pathname)) {
    return;
  }

  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
