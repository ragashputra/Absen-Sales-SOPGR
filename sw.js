'use strict';

const CACHE_NAME = 'absen-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
  );
});

// Activate: bersihkan cache versi lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Untuk request ke Apps Script (data absensi, GPS, foto upload) & Nominatim (reverse geocode): SELALU network, jangan cache, jangan intercept offline fallback yang aneh.
// - Untuk app shell (html/css/js/manifest/icon): cache-first supaya buka instan, dengan fallback network.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Jangan sentuh request eksternal krusial (Apps Script, geocoding, Google APIs)
  if (
    url.includes('script.google.com') ||
    url.includes('script.googleusercontent.com') ||
    url.includes('nominatim.openstreetmap.org') ||
    url.includes('drive.google.com') ||
    event.request.method !== 'GET'
  ) {
    return; // biarkan browser handle langsung ke network
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
