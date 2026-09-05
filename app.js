'use strict';

/* ============================================
   STATE
   ============================================ */
const state = {
  employee: null,        // {id, name, branch}
  employees: [],
  currentType: null,     // 'masuk' | 'keluar'
  gps: null,             // {lat, lng, accuracy, address, addressSource}
  gpsWatchId: null,
  gpsLocked: false,
  gpsStartedAt: null,
  gpsForceReadyTimer: null,
  gpsBestAccuracySeen: Infinity,
  geocodeInFlightKey: null,
  stream: null,
  capturedPhoto: null,   // base64 dataURL (compressed)
  captureTime: null,
  todayStatus: { masuk: null, keluar: null },
  timestampInterval: null,
  submitting: false
};

const STORAGE_KEY = 'absen_employee';
const QUEUE_KEY = 'absen_pending_queue';
const GEOCODE_CACHE_KEY = 'absen_geocode_cache';

function isBackendConfigured() {
  const url = (CONFIG.APPS_SCRIPT_URL || '').trim();
  return url.length > 0 && !url.includes('GANTI_DENGAN_URL');
}

/* ============================================
   INIT
   ============================================ */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  registerServiceWorker();
  startClock();
  attachEventListeners(); // HARUS selalu jalan, apa pun jalur login di bawah ini
  attachConnectivityListeners();

  await loadEmployees();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const emp = JSON.parse(saved);
      const stillValid = state.employees.find(e => e.id === emp.id);
      if (stillValid) {
        selectEmployee(stillValid);
        return;
      }
    } catch (e) { /* ignore */ }
  }
  showScreen('screen-login');
}

function attachEventListeners() {
  document.getElementById('employee-search').addEventListener('input', onSearchInput);
  document.getElementById('btn-logout').addEventListener('click', onLogout);
  document.getElementById('btn-absen-masuk').addEventListener('click', () => openCamera('masuk'));
  document.getElementById('btn-absen-keluar').addEventListener('click', () => openCamera('keluar'));
  document.getElementById('btn-camera-close').addEventListener('click', closeCamera);
  document.getElementById('btn-shutter').addEventListener('click', capturePhoto);
  document.getElementById('btn-retake').addEventListener('click', retakePhoto);
  document.getElementById('btn-submit').addEventListener('click', submitAttendance);
  document.getElementById('btn-back-home').addEventListener('click', () => {
    showScreen('screen-home');
    refreshTodayStatus();
  });
  document.getElementById('btn-history').addEventListener('click', openHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('screen-home'));
}

function attachConnectivityListeners() {
  window.addEventListener('online', () => {
    showToast('Koneksi kembali — mencoba kirim absensi tertunda…');
    flushPendingQueue();
  });
  window.addEventListener('offline', () => {
    showToast('Kamu sedang offline. Absensi akan dikirim otomatis saat online.', true);
  });
  // Coba flush setiap kali app dibuka kembali (misal dari background)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      flushPendingQueue();
    }
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ============================================
   CLOCK (WIB / Asia-Jakarta, konsisten di seluruh app)
   ============================================ */
const TZ = CONFIG.TIMEZONE || 'Asia/Jakarta';

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}
function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('live-clock');
  const dateEl = document.getElementById('live-date');
  if (timeEl) timeEl.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  if (dateEl) dateEl.textContent = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}
function formatDateTimeWIB(date) {
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium', timeZone: TZ }) + ' WIB';
}

/* ============================================
   EMPLOYEE LIST
   ============================================ */
async function loadEmployees() {
  // Tampilkan dulu daftar default (instan, tanpa nunggu jaringan) supaya
  // layar tidak pernah kosong walau backend belum di-setup atau offline.
  const fallback = Array.isArray(CONFIG.EMPLOYEES) ? CONFIG.EMPLOYEES : [];
  state.employees = fallback;
  renderEmployeeList(state.employees);

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) return; // tetap pakai fallback, tidak perlu fetch

  // Coba ambil data terbaru dari Sheets di background; kalau berhasil dan
  // ada isinya, itu jadi sumber utama (menimpa fallback).
  try {
    const data = await fetchJsonWithTimeout(`${CONFIG.APPS_SCRIPT_URL}?action=employees`, {}, 8000);
    if (Array.isArray(data.employees) && data.employees.length) {
      state.employees = data.employees;
      renderEmployeeList(state.employees);
    }
  } catch (e) {
    // offline / backend belum jalan → tetap pakai fallback yang sudah tampil
  }
}

function renderEmployeeList(list) {
  const container = document.getElementById('employee-list');
  const empty = document.getElementById('employee-empty');
  container.innerHTML = '';

  if (!list.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const frag = document.createDocumentFragment();
  list.forEach(emp => {
    const btn = document.createElement('button');
    btn.className = 'employee-item';
    btn.innerHTML = `
      <div class="employee-avatar">${initials(emp.name)}</div>
      <div class="employee-info">
        <div class="employee-name">${escapeHtml(emp.name)}</div>
        <div class="employee-branch">${escapeHtml(emp.branch || '')}</div>
      </div>
      <svg class="employee-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    `;
    btn.addEventListener('click', () => selectEmployee(emp));
    frag.appendChild(btn);
  });
  container.appendChild(frag);
}

function onSearchInput(e) {
  const q = e.target.value.toLowerCase().trim();
  const filtered = state.employees.filter(emp => emp.name.toLowerCase().includes(q));
  renderEmployeeList(filtered);
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function selectEmployee(emp) {
  state.employee = emp;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(emp));
  document.getElementById('home-employee-name').textContent = emp.name;
  document.getElementById('home-employee-branch').textContent = emp.branch || CONFIG.COMPANY_NAME;
  showScreen('screen-home');
  refreshTodayStatus();
  flushPendingQueue();
}

function onLogout() {
  showModal({
    icon: 'warn',
    title: 'Ganti pengguna?',
    message: 'Kamu akan keluar dan bisa memilih nama lain.',
    actions: [
      { label: 'Batal', style: 'ghost' },
      { label: 'Ganti', style: 'solid', onClick: () => {
        localStorage.removeItem(STORAGE_KEY);
        state.employee = null;
        showScreen('screen-login');
      }}
    ]
  });
}

/* ============================================
   TODAY STATUS
   ============================================ */
async function refreshTodayStatus() {
  if (!state.employee) return;
  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) return; // belum ada backend, biarkan status default "Belum absen"

  setStatusLoading(true);
  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}?action=today&employeeId=${encodeURIComponent(state.employee.id)}`,
      {}, 10000
    );
    state.todayStatus = data;
    renderTodayStatus(data);
  } catch (e) { /* offline, keep last known */ } finally {
    setStatusLoading(false);
  }
}

function setStatusLoading(isLoading) {
  document.getElementById('card-masuk').classList.toggle('loading', isLoading);
  document.getElementById('card-keluar').classList.toggle('loading', isLoading);
}

function renderTodayStatus(data) {
  const cardMasuk = document.getElementById('card-masuk');
  const cardKeluar = document.getElementById('card-keluar');
  const btnMasuk = document.getElementById('btn-absen-masuk');
  const btnKeluar = document.getElementById('btn-absen-keluar');

  if (data.masuk) {
    cardMasuk.classList.add('filled');
    document.getElementById('status-masuk-time').textContent = data.masuk.time;
    document.getElementById('status-masuk-addr').textContent = data.masuk.address || '';
    btnMasuk.disabled = true;
  } else {
    cardMasuk.classList.remove('filled');
    document.getElementById('status-masuk-time').textContent = 'Belum absen';
    document.getElementById('status-masuk-addr').textContent = '';
    btnMasuk.disabled = false;
  }

  if (data.keluar) {
    cardKeluar.classList.add('filled');
    document.getElementById('status-keluar-time').textContent = data.keluar.time;
    document.getElementById('status-keluar-addr').textContent = data.keluar.address || '';
    btnKeluar.disabled = true;
  } else {
    cardKeluar.classList.remove('filled');
    document.getElementById('status-keluar-time').textContent = 'Belum absen';
    document.getElementById('status-keluar-addr').textContent = '';
    btnKeluar.disabled = !data.masuk; // harus absen masuk dulu
  }
}

/* ============================================
   CAMERA + GPS FLOW
   ============================================ */
async function openCamera(type) {
  state.currentType = type;
  document.getElementById('camera-mode-chip').textContent = type === 'masuk' ? 'ABSENSI MASUK' : 'ABSENSI KELUAR';
  showScreen('screen-camera');
  resetGpsPanel();
  startGpsWatch();
  startCameraStream();

  updateCameraTimestamp();
  state.timestampInterval = setInterval(updateCameraTimestamp, 1000);
}

function startCameraStream() {
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false
  }).then(stream => {
    state.stream = stream;
    document.getElementById('camera-video').srcObject = stream;
  }).catch(() => {
    showModal({
      icon: 'error',
      title: 'Tidak bisa akses kamera',
      message: 'Izinkan akses kamera di pengaturan browser untuk melanjutkan absensi.',
      actions: [{ label: 'Kembali', style: 'solid', onClick: closeCamera }]
    });
  });
}

function updateCameraTimestamp() {
  const el = document.getElementById('camera-timestamp');
  if (el) el.textContent = formatDateTimeWIB(new Date());
}

function resetGpsPanel() {
  state.gps = null;
  state.gpsLocked = false;
  state.gpsStartedAt = Date.now();
  state.gpsBestAccuracySeen = Infinity;
  state.geocodeInFlightKey = null;
  clearTimeout(state.gpsForceReadyTimer);

  document.getElementById('gps-pulse').classList.remove('locked');
  document.getElementById('gps-status-text').textContent = 'Mencari sinyal GPS…';
  document.getElementById('gps-coords').textContent = '—';
  document.getElementById('gps-address').textContent = 'Menunggu lokasi akurat…';
  document.getElementById('gps-panel').classList.remove('accurate');
  document.getElementById('btn-shutter').disabled = true;
  document.getElementById('camera-hint').textContent = 'Menunggu GPS akurat';

  // Kalau setelah GPS_MAX_WAIT akurasi belum ideal, tetap izinkan foto
  // (lebih baik absen dengan akurasi menengah daripada karyawan stuck tak bisa absen
  // di area dengan sinyal GPS lemah, seperti dalam ruangan/gedung).
  state.gpsForceReadyTimer = setTimeout(() => {
    if (!state.gps) return; // belum ada titik sama sekali, biarkan nunggu
    const shutterBtn = document.getElementById('btn-shutter');
    if (shutterBtn.disabled) {
      shutterBtn.disabled = false;
      document.getElementById('camera-hint').textContent = 'Bisa lanjut foto dengan akurasi saat ini';
    }
  }, CONFIG.GPS_MAX_WAIT);
}

function startGpsWatch() {
  if (!navigator.geolocation) {
    document.getElementById('gps-status-text').textContent = 'GPS tidak didukung perangkat ini';
    return;
  }

  state.gpsWatchId = navigator.geolocation.watchPosition(
    onGpsUpdate,
    onGpsError,
    { enableHighAccuracy: true, timeout: CONFIG.GPS_TIMEOUT, maximumAge: CONFIG.GPS_MAX_AGE }
  );
}

function stopGpsWatch() {
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
  clearTimeout(state.gpsForceReadyTimer);
}

function onGpsUpdate(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const roundedAcc = Math.round(accuracy);

  // Simpan alamat lama kalau titik baru cuma sedikit bergeser & masih dalam radius cache,
  // supaya panel tidak "flicker" balik ke placeholder tiap update GPS.
  const prevAddress = state.gps ? state.gps.address : null;
  const prevAddressSource = state.gps ? state.gps.addressSource : null;
  state.gps = { lat: latitude, lng: longitude, accuracy: roundedAcc, address: prevAddress, addressSource: prevAddressSource };

  document.getElementById('gps-coords').textContent =
    `${latitude.toFixed(6)}, ${longitude.toFixed(6)} · ±${roundedAcc}m`;

  const isAccurate = accuracy <= CONFIG.GPS_ACCURACY_THRESHOLD;
  const isGreat = accuracy <= CONFIG.GPS_ACCURACY_GOOD;
  state.gpsLocked = isAccurate;

  const pulse = document.getElementById('gps-pulse');
  const statusText = document.getElementById('gps-status-text');
  const shutterBtn = document.getElementById('btn-shutter');
  const hint = document.getElementById('camera-hint');
  const panel = document.getElementById('gps-panel');

  panel.classList.toggle('accurate', isGreat);

  if (isAccurate) {
    pulse.classList.add('locked');
    statusText.textContent = isGreat ? 'Lokasi terkunci — sangat akurat' : 'Lokasi terkunci — akurat';
    shutterBtn.disabled = false;
    hint.textContent = 'Ketuk untuk ambil foto';
  } else {
    pulse.classList.remove('locked');
    statusText.textContent = `Menyempurnakan akurasi (±${roundedAcc}m)`;
    shutterBtn.disabled = false; // tetap bisa dipakai kalau GPS lemah tapi ada sinyal
    hint.textContent = 'Akurasi masih rendah, tunggu sebentar untuk hasil terbaik';
  }

  // Reverse geocode: dipicu di titik GPS PERTAMA (jangan nunggu "locked" — ini
  // penyebab utama alamat lama/telat muncul), lalu diperbarui lagi kalau akurasi
  // membaik signifikan (>20m improvement) dibanding saat terakhir geocode jalan.
  const shouldGeocode =
    accuracy < state.gpsBestAccuracySeen - 20 || state.gpsBestAccuracySeen === Infinity;

  if (shouldGeocode) {
    state.gpsBestAccuracySeen = Math.min(state.gpsBestAccuracySeen, accuracy);
    resolveAddress(latitude, longitude);
  }
}

function onGpsError(err) {
  const statusText = document.getElementById('gps-status-text');
  const shutterBtn = document.getElementById('btn-shutter');
  if (err.code === 1) {
    statusText.textContent = 'Izin lokasi ditolak — aktifkan di pengaturan';
  } else if (err.code === 3) {
    statusText.textContent = 'Sinyal GPS lemah, mencari ulang…';
  } else {
    statusText.textContent = 'Gagal mendapat lokasi, coba lagi';
  }
  // Jangan matikan shutter kalau sudah pernah dapat titik sebelumnya
  if (!state.gps) shutterBtn.disabled = true;
}

/* ============================================
   REVERSE GEOCODING — berlapis, cache, cepat
   Strategi:
   1. Cek cache lokal (localStorage) dulu — kalau ada titik yang sama persis
      (dibulatkan ~11m) dan belum kedaluwarsa, tampilkan INSTAN tanpa network.
   2. Kalau tidak ada cache: coba Nominatim (detail nama jalan paling baik utk
      Indonesia) dengan timeout ketat.
   3. Kalau Nominatim gagal/timeout: fallback ke BigDataCloud (gratis, tanpa
      API key, rate limit lebih longgar) sebagai jaring pengaman kedua.
   4. Kalau kedua-duanya gagal: tampilkan koordinat GPS mentah — absen TETAP
      bisa jalan, alamat text hanyalah pelengkap bacaan, bukan syarat submit.
   ============================================ */
function geocodeCacheKey(lat, lng) {
  const p = CONFIG.GEOCODE_CACHE_PRECISION;
  return `${lat.toFixed(p)},${lng.toFixed(p)}`;
}

function readGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY)) || {};
  } catch (e) { return {}; }
}

function writeGeocodeCache(cache) {
  const entries = Object.entries(cache);
  const max = CONFIG.GEOCODE_CACHE_MAX_ENTRIES;
  const trimmed = entries.length > max
    ? Object.fromEntries(entries.sort((a, b) => b[1].ts - a[1].ts).slice(0, max))
    : cache;
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(trimmed));
  } catch (e) { /* storage full, abaikan */ }
}

function getCachedAddress(lat, lng) {
  const cache = readGeocodeCache();
  const entry = cache[geocodeCacheKey(lat, lng)];
  if (!entry) return null;
  const ageDays = (Date.now() - entry.ts) / (1000 * 60 * 60 * 24);
  if (ageDays > CONFIG.GEOCODE_CACHE_TTL_DAYS) return null;
  return entry;
}

function setCachedAddress(lat, lng, address, source) {
  const cache = readGeocodeCache();
  cache[geocodeCacheKey(lat, lng)] = { address, source, ts: Date.now() };
  writeGeocodeCache(cache);
}

async function resolveAddress(lat, lng) {
  const key = geocodeCacheKey(lat, lng);
  if (state.geocodeInFlightKey === key) return; // sudah diproses, jangan dobel request
  state.geocodeInFlightKey = key;

  const addressEl = document.getElementById('gps-address');

  // 1) Cache instan
  const cached = getCachedAddress(lat, lng);
  if (cached) {
    applyAddress(lat, lng, cached.address, cached.source, /*fromCache*/ true);
    return;
  }

  addressEl.textContent = 'Mencari nama jalan…';

  // 2) Nominatim
  try {
    const addr = await geocodeNominatim(lat, lng);
    if (addr) {
      applyAddress(lat, lng, addr, 'osm');
      return;
    }
  } catch (e) { /* lanjut ke fallback */ }

  // 3) BigDataCloud (fallback)
  try {
    const addr = await geocodeBigDataCloud(lat, lng);
    if (addr) {
      applyAddress(lat, lng, addr, 'bdc');
      return;
    }
  } catch (e) { /* lanjut ke fallback terakhir */ }

  // 4) Gagal total — tetap tampilkan koordinat, absen tidak terblokir
  if (state.gps && state.gps.lat === lat && state.gps.lng === lng) {
    addressEl.textContent = `Nama jalan tidak ditemukan · ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }
}

function applyAddress(lat, lng, address, source, fromCache) {
  setCachedAddress(lat, lng, address, source);
  // Hanya update UI kalau titik GPS belum berubah drastis sejak request dikirim
  if (state.gps) {
    state.gps.address = address;
    state.gps.addressSource = source;
  }
  const addressEl = document.getElementById('gps-address');
  addressEl.textContent = address;
  addressEl.classList.toggle('from-cache', !!fromCache);
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  return res.json();
}

async function geocodeNominatim(lat, lng) {
  const res = await fetchWithTimeout(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
    { headers: { 'Accept-Language': 'id' } },
    CONFIG.GEOCODE_TIMEOUT
  );
  if (!res.ok) throw new Error('nominatim_http_' + res.status);
  const data = await res.json();
  return data.display_name || null;
}

async function geocodeBigDataCloud(lat, lng) {
  const res = await fetchWithTimeout(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=id`,
    {},
    CONFIG.GEOCODE_TIMEOUT
  );
  if (!res.ok) throw new Error('bdc_http_' + res.status);
  const data = await res.json();
  const parts = [
    data.locality,
    data.city && data.city !== data.locality ? data.city : null,
    data.principalSubdivision,
    data.countryName
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/* ============================================
   CAMERA LIFECYCLE
   ============================================ */
function closeCamera() {
  stopCameraStream();
  stopGpsWatch();
  clearInterval(state.timestampInterval);
  showScreen('screen-home');
}

function stopCameraStream() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
}

/* ============================================
   CAPTURE — foto dikompres agresif tapi tetap jelas,
   supaya proses "capture -> siap kirim" secepat mungkin.
   ============================================ */
function capturePhoto() {
  if (!state.gps) return;

  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const size = Math.min(video.videoWidth, video.videoHeight);
  const target = CONFIG.PHOTO_MAX_DIMENSION || 720;
  canvas.width = target;
  canvas.height = target;
  const ctx = canvas.getContext('2d');

  // crop tengah (square), flip horizontal biar sesuai preview mirror
  const sx = (video.videoWidth - size) / 2;
  const sy = (video.videoHeight - size) / 2;
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, size, size, 0, 0, canvas.width, canvas.height);

  state.capturedPhoto = canvas.toDataURL('image/jpeg', CONFIG.PHOTO_QUALITY || 0.72);
  state.capturedGps = { ...state.gps }; // bekukan titik GPS persis saat shutter ditekan
  state.captureTime = new Date();

  stopCameraStream();
  stopGpsWatch();
  clearInterval(state.timestampInterval);

  showPreview();
}

function showPreview() {
  document.getElementById('preview-image').src = state.capturedPhoto;
  document.getElementById('preview-time').textContent = formatDateTimeWIB(state.captureTime);
  document.getElementById('preview-address').textContent =
    state.capturedGps.address || `${state.capturedGps.lat.toFixed(6)}, ${state.capturedGps.lng.toFixed(6)}`;
  document.getElementById('preview-accuracy').textContent = `Akurasi GPS ±${state.capturedGps.accuracy} meter`;
  showScreen('screen-preview');
}

function retakePhoto() {
  showScreen('screen-camera');
  document.getElementById('camera-mode-chip').textContent = state.currentType === 'masuk' ? 'ABSENSI MASUK' : 'ABSENSI KELUAR';
  resetGpsPanel();
  startGpsWatch();
  startCameraStream();
  updateCameraTimestamp();
  state.timestampInterval = setInterval(updateCameraTimestamp, 1000);
}

/* ============================================
   SUBMIT — kirim cepat dengan timeout, auto-retry,
   dan antrian offline (kalau gagal karena jaringan,
   absen TIDAK hilang: disimpan lalu dikirim otomatis
   begitu koneksi kembali).
   ============================================ */
async function submitAttendance() {
  if (state.submitting) return;

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) {
    showModal({
      icon: 'warn',
      title: 'Backend belum terhubung',
      message: 'URL Apps Script di config.js belum diisi, jadi absensi belum bisa dikirim ke Google Sheets. Ikuti panduan di README.md untuk menghubungkannya.',
      actions: [{ label: 'Oke', style: 'solid' }]
    });
    return;
  }

  const payload = {
    type: state.currentType,
    employeeId: state.employee.id,
    employeeName: state.employee.name,
    photoBase64: state.capturedPhoto,
    latitude: state.capturedGps.lat,
    longitude: state.capturedGps.lng,
    accuracy: state.capturedGps.accuracy,
    address: state.capturedGps.address || '',
    clientCapturedAt: state.captureTime.toISOString()
  };

  // Kalau memang sedang offline, jangan buang waktu nunggu timeout fetch —
  // langsung masuk antrian dan kasih tahu user.
  if (!navigator.onLine) {
    queueAttendance(payload);
    showQueuedSuccess();
    return;
  }

  setSubmitLoading(true);
  try {
    const data = await sendAttendanceWithRetry(payload, CONFIG.UPLOAD_MAX_RETRY);
    if (data.ok) {
      showSuccess(data);
    } else if (data.error && data.error.includes('Sudah absen')) {
      // Sudah tercatat (mungkin submit sebelumnya sempat nyampe walau koneksi putus
      // sebelum respons balik) — anggap ini bukan kegagalan, langsung refresh status.
      showModal({
        icon: 'warn',
        title: 'Absensi sudah tercatat',
        message: data.error,
        actions: [{ label: 'Oke', style: 'solid', onClick: () => { showScreen('screen-home'); refreshTodayStatus(); } }]
      });
    } else {
      throw new Error(data.error || 'Gagal mengirim absen');
    }
  } catch (err) {
    // Gagal karena jaringan (bukan ditolak server) -> simpan ke antrian offline
    // supaya foto & lokasi yang sudah diambil tidak hilang sia-sia.
    if (isNetworkError(err)) {
      queueAttendance(payload);
      showQueuedSuccess();
    } else {
      showModal({
        icon: 'error',
        title: 'Gagal mengirim absen',
        message: err.message,
        actions: [{ label: 'Coba Lagi', style: 'solid' }]
      });
    }
  } finally {
    setSubmitLoading(false);
  }
}

function setSubmitLoading(isLoading) {
  state.submitting = isLoading;
  const btn = document.getElementById('btn-submit');
  const btnText = document.getElementById('btn-submit-text');
  const spinner = document.getElementById('btn-submit-spinner');
  btn.disabled = isLoading;
  btnText.textContent = isLoading ? 'Mengirim…' : 'Kirim Absensi';
  spinner.classList.toggle('hidden', !isLoading);
}

function isNetworkError(err) {
  return err.name === 'AbortError' || err.message === 'Failed to fetch' || err.message === 'network_error';
}

async function sendAttendanceWithRetry(payload, retriesLeft) {
  try {
    const res = await fetchWithTimeout(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
      body: JSON.stringify(payload)
    }, CONFIG.UPLOAD_TIMEOUT);
    if (!res.ok) throw new Error('http_' + res.status);
    return await res.json();
  } catch (err) {
    if (retriesLeft > 0 && isNetworkError(err)) {
      await sleep(1200);
      return sendAttendanceWithRetry(payload, retriesLeft - 1);
    }
    throw err;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---- Antrian offline: disimpan di localStorage, di-flush otomatis ---- */
function queueAttendance(payload) {
  const queue = readQueue();
  queue.push({ ...payload, queuedAt: Date.now() });
  writeQueue(queue);
}

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
  catch (e) { return []; }
}

function writeQueue(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
  catch (e) { /* storage penuh — kasus sangat jarang karena foto sudah dikompres kecil */ }
}

let flushInProgress = false;
async function flushPendingQueue() {
  if (flushInProgress) return;
  const queue = readQueue();
  if (!queue.length || !navigator.onLine) return;

  flushInProgress = true;
  const remaining = [];
  let sentCount = 0;

  for (const item of queue) {
    try {
      const { queuedAt, ...payload } = item;
      const data = await sendAttendanceWithRetry(payload, 1);
      if (data.ok || (data.error && data.error.includes('Sudah absen'))) {
        sentCount++;
      } else {
        remaining.push(item); // ditolak server karena alasan lain, simpan utk dicek manual
      }
    } catch (e) {
      remaining.push(item); // masih gagal, coba lagi nanti
    }
  }

  writeQueue(remaining);
  flushInProgress = false;

  if (sentCount > 0) {
    showToast(`${sentCount} absensi tertunda berhasil dikirim.`);
    if (document.getElementById('screen-home').classList.contains('active')) {
      refreshTodayStatus();
    }
  }
}

function showQueuedSuccess() {
  const type = state.currentType;
  document.getElementById('success-title').textContent =
    type === 'masuk' ? 'Absensi masuk tersimpan' : 'Absensi keluar tersimpan';
  document.getElementById('success-sub').textContent =
    'Kamu sedang offline — foto & lokasi sudah diamankan dan akan terkirim otomatis begitu koneksi kembali.';
  showScreen('screen-success');
}

function showSuccess(data) {
  const type = state.currentType;
  document.getElementById('success-title').textContent =
    type === 'masuk' ? 'Absensi masuk berhasil' : 'Absensi keluar berhasil';
  document.getElementById('success-sub').textContent =
    `${data.data.time} WIB · ${data.data.address}`;
  showScreen('screen-success');
}

/* ============================================
   HISTORY
   ============================================ */
async function openHistory() {
  showScreen('screen-history');
  const container = document.getElementById('history-list');

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) {
    container.innerHTML = '<div class="history-empty">Riwayat akan muncul di sini setelah backend Google Sheets terhubung (lihat README.md).</div>';
    return;
  }

  container.innerHTML = renderHistorySkeleton();

  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}?action=history&employeeId=${encodeURIComponent(state.employee.id)}&limit=50`,
      {}, 12000
    );
    renderHistory(data.history || []);
  } catch (e) {
    container.innerHTML = '<div class="history-empty">Gagal memuat riwayat. Periksa koneksi internet.</div>';
  }
}

function renderHistorySkeleton() {
  return Array.from({ length: 4 }).map(() => `
    <div class="history-item skeleton">
      <div class="history-thumb"></div>
      <div class="history-info">
        <div class="skeleton-line" style="width:40%"></div>
        <div class="skeleton-line" style="width:70%; margin-top:6px;"></div>
      </div>
    </div>
  `).join('');
}

function renderHistory(list) {
  const container = document.getElementById('history-list');
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<div class="history-empty">Belum ada riwayat absensi.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <img class="history-thumb" src="${item.photoUrl}" loading="lazy" alt="">
      <div class="history-info">
        <div class="history-top-row">
          <span class="history-type ${item.type === 'Masuk' ? 'masuk' : 'keluar'}">${item.type}</span>
          <span class="history-date">${formatHistoryDate(item.date)}</span>
        </div>
        <div class="history-addr">${escapeHtml(item.address || '')}</div>
      </div>
      <div class="history-time">${item.time}</div>
    `;
    div.addEventListener('click', () => window.open(item.mapsLink, '_blank'));
    frag.appendChild(div);
  });
  container.appendChild(frag);
}

function formatHistoryDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: TZ });
  } catch (e) { return dateStr; }
}

/* ============================================
   SCREEN NAVIGATION (dengan transisi halus)
   ============================================ */
function showScreen(id) {
  const current = document.querySelector('.screen.active');
  const next = document.getElementById(id);
  if (current === next) return;

  if (current) {
    current.classList.add('leaving');
    current.classList.remove('active');
    setTimeout(() => current.classList.remove('leaving'), 220);
  }
  next.classList.add('active');
}

/* ============================================
   MODAL / TOAST HELPERS
   ============================================ */
function showModal({ icon, title, message, actions }) {
  const overlay = document.getElementById('modal-overlay');
  const iconEl = document.getElementById('modal-icon');
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const actionsEl = document.getElementById('modal-actions');

  const icons = {
    warn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D9A441" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
    error: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#C1543D" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
  };
  iconEl.innerHTML = icons[icon] || '';
  titleEl.textContent = title;
  msgEl.textContent = message;
  actionsEl.innerHTML = '';

  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.className = a.style === 'solid' ? 'modal-btn-solid' : 'modal-btn-ghost';
    btn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      if (a.onClick) a.onClick();
    });
    actionsEl.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

let toastTimeout;
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
