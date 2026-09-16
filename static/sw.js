// Service Worker for Timeline PWA
const CACHE_NAME = 'timeline-cache-v1';
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Pass-through fetch
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
