'use strict';

// Naikkan versi ini setiap kali file di-update & di-redeploy, supaya cache lama
// otomatis dibuang dan semua HP karyawan langsung dapat versi terbaru.
const CACHE_NAME = 'absensi-v27';

// File yang JARANG berubah (aman di-cache-first, biar buka instan & tetap
// bisa dipakai offline).
const STATIC_ASSETS = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

// File KODE yang harus SELALU diambil dari network dulu (network-first).
// Ini file yang paling sering kamu edit (terutama config.js pas ganti URL
// backend) — kalau di-cache-first, edit kamu gak akan pernah nyampe ke HP
// karyawan sampai mereka hapus cache manual.
const NETWORK_FIRST_PATHS = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/config.js',
  '/sw.js'
];

function isNetworkFirst(url) {
  return NETWORK_FIRST_PATHS.some((p) => url.endsWith(p)) || url.endsWith('/');
}

// Domain yang TIDAK BOLEH pernah diintercept/di-cache oleh service worker:
// backend Apps Script (harus selalu fresh), Drive (foto), dan kedua provider
// reverse-geocoding (lokasi harus selalu real-time, bukan basi dari cache).
const NEVER_INTERCEPT_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'drive.google.com',
  'nominatim.openstreetmap.org',
  'api.bigdatacloud.net'
];

// Install: cache aset statis saja
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

// Activate: bersihkan SEMUA cache versi lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Apps Script, Nominatim, BigDataCloud, Drive, non-GET -> selalu langsung ke network, jangan diintercept.
// - File kode (html/js/css) -> NETWORK-FIRST: coba network dulu (biar selalu versi terbaru),
//   fallback ke cache cuma kalau offline.
// - Aset statis (manifest, icon) -> cache-first, biar buka instan.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (
    NEVER_INTERCEPT_HOSTS.some((host) => url.includes(host)) ||
    event.request.method !== 'GET'
  ) {
    return; // biarkan browser handle langsung ke network
  }

  if (isNetworkFirst(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first untuk aset statis
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
