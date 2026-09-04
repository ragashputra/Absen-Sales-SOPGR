'use strict';

/* ============================================
   STATE
   ============================================ */
const state = {
  employee: null,        // {id, name, branch}
  employees: [],
  currentType: null,     // 'masuk' | 'keluar'
  gps: null,             // {lat, lng, accuracy, address}
  gpsWatchId: null,
  gpsLocked: false,
  stream: null,
  capturedPhoto: null,   // base64 dataURL
  captureTime: null,
  todayStatus: { masuk: null, keluar: null }
};

const STORAGE_KEY = 'absen_employee';

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

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ============================================
   CLOCK
   ============================================ */
function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}
function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('live-clock');
  const dateEl = document.getElementById('live-date');
  if (timeEl) timeEl.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  if (dateEl) dateEl.textContent = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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
    const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=employees`);
    const data = await res.json();
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

  list.forEach(emp => {
    const btn = document.createElement('button');
    btn.className = 'employee-item';
    btn.innerHTML = `
      <div class="employee-avatar">${initials(emp.name)}</div>
      <div class="employee-info">
        <div class="employee-name">${escapeHtml(emp.name)}</div>
        <div class="employee-branch">${escapeHtml(emp.branch || '')}</div>
      </div>
    `;
    btn.addEventListener('click', () => selectEmployee(emp));
    container.appendChild(btn);
  });
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
  try {
    const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=today&employeeId=${encodeURIComponent(state.employee.id)}`);
    const data = await res.json();
    state.todayStatus = data;
    renderTodayStatus(data);
  } catch (e) { /* offline, keep last known */ }
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
  document.getElementById('camera-mode-chip').textContent = type === 'masuk' ? 'ABSEN MASUK' : 'ABSEN KELUAR';
  showScreen('screen-camera');
  resetGpsPanel();
  startGpsWatch();

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    document.getElementById('camera-video').srcObject = state.stream;
  } catch (err) {
    showModal({
      icon: 'error',
      title: 'Tidak bisa akses kamera',
      message: 'Izinkan akses kamera di pengaturan browser untuk melanjutkan absensi.',
      actions: [{ label: 'Kembali', style: 'solid', onClick: closeCamera }]
    });
  }

  updateCameraTimestamp();
  state.timestampInterval = setInterval(updateCameraTimestamp, 1000);
}

function updateCameraTimestamp() {
  const el = document.getElementById('camera-timestamp');
  if (el) el.textContent = new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
}

function resetGpsPanel() {
  state.gps = null;
  state.gpsLocked = false;
  document.getElementById('gps-pulse').classList.remove('locked');
  document.getElementById('gps-status-text').textContent = 'Mencari sinyal GPS…';
  document.getElementById('gps-coords').textContent = '—';
  document.getElementById('gps-address').textContent = 'Menunggu lokasi akurat…';
  document.getElementById('btn-shutter').disabled = true;
  document.getElementById('camera-hint').textContent = 'Menunggu GPS akurat';
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
}

async function onGpsUpdate(position) {
  const { latitude, longitude, accuracy } = position.coords;
  state.gps = { lat: latitude, lng: longitude, accuracy: Math.round(accuracy) };

  document.getElementById('gps-coords').textContent =
    `${latitude.toFixed(6)}, ${longitude.toFixed(6)} · ±${Math.round(accuracy)}m`;

  const isAccurate = accuracy <= CONFIG.GPS_ACCURACY_THRESHOLD;
  state.gpsLocked = isAccurate;

  const pulse = document.getElementById('gps-pulse');
  const statusText = document.getElementById('gps-status-text');
  const shutterBtn = document.getElementById('btn-shutter');
  const hint = document.getElementById('camera-hint');

  if (isAccurate) {
    pulse.classList.add('locked');
    statusText.textContent = 'Lokasi terkunci — akurat';
    shutterBtn.disabled = false;
    hint.textContent = 'Ketuk untuk ambil foto';
  } else {
    pulse.classList.remove('locked');
    statusText.textContent = `Menyempurnakan akurasi (±${Math.round(accuracy)}m)`;
    shutterBtn.disabled = false; // tetap bisa dipakai kalau GPS lemah tapi ada sinyal
    hint.textContent = 'Akurasi masih rendah, tunggu sebentar untuk hasil terbaik';
  }

  // Reverse geocode sekali saja / saat akurasi membaik signifikan
  if (!state.gpsAddressFetched || accuracy < (state.lastAccuracy || 9999) - 20) {
    state.gpsAddressFetched = true;
    state.lastAccuracy = accuracy;
    reverseGeocode(latitude, longitude);
  }
}

function onGpsError(err) {
  const statusText = document.getElementById('gps-status-text');
  const shutterBtn = document.getElementById('btn-shutter');
  if (err.code === 1) {
    statusText.textContent = 'Izin lokasi ditolak — aktifkan di pengaturan';
  } else {
    statusText.textContent = 'Gagal mendapat lokasi, coba lagi';
  }
  shutterBtn.disabled = true;
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, {
      headers: { 'Accept-Language': 'id' }
    });
    const data = await res.json();
    const addr = data.display_name || '';
    state.gps.address = addr;
    document.getElementById('gps-address').textContent = addr || 'Alamat tidak ditemukan';
  } catch (e) {
    document.getElementById('gps-address').textContent = 'Alamat tidak dapat dimuat (offline)';
  }
}

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

function capturePhoto() {
  if (!state.gps) return;

  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const size = Math.min(video.videoWidth, video.videoHeight);
  canvas.width = 900;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');

  // crop tengah (square), flip horizontal biar sesuai preview mirror
  const sx = (video.videoWidth - size) / 2;
  const sy = (video.videoHeight - size) / 2;
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, size, size, 0, 0, canvas.width, canvas.height);

  state.capturedPhoto = canvas.toDataURL('image/jpeg', 0.85);
  state.captureTime = new Date();

  stopCameraStream();
  stopGpsWatch();
  clearInterval(state.timestampInterval);

  showPreview();
}

function showPreview() {
  document.getElementById('preview-image').src = state.capturedPhoto;
  document.getElementById('preview-time').textContent =
    state.captureTime.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'medium' });
  document.getElementById('preview-address').textContent = state.gps.address || `${state.gps.lat.toFixed(6)}, ${state.gps.lng.toFixed(6)}`;
  document.getElementById('preview-accuracy').textContent = `Akurasi GPS ±${state.gps.accuracy} meter`;
  showScreen('screen-preview');
}

function retakePhoto() {
  showScreen('screen-camera');
  document.getElementById('camera-mode-chip').textContent = state.currentType === 'masuk' ? 'ABSEN MASUK' : 'ABSEN KELUAR';
  resetGpsPanel();
  startGpsWatch();
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false })
    .then(stream => {
      state.stream = stream;
      document.getElementById('camera-video').srcObject = stream;
    });
  updateCameraTimestamp();
  state.timestampInterval = setInterval(updateCameraTimestamp, 1000);
}

/* ============================================
   SUBMIT
   ============================================ */
async function submitAttendance() {
  const btn = document.getElementById('btn-submit');
  const btnText = document.getElementById('btn-submit-text');
  const spinner = document.getElementById('btn-submit-spinner');

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) {
    showModal({
      icon: 'warn',
      title: 'Backend belum terhubung',
      message: 'URL Apps Script di config.js belum diisi, jadi absen belum bisa dikirim ke Google Sheets. Ikuti panduan di README.md untuk menghubungkannya.',
      actions: [{ label: 'Oke', style: 'solid' }]
    });
    return;
  }

  btn.disabled = true;
  btnText.textContent = 'Mengirim…';
  spinner.classList.remove('hidden');

  const payload = {
    type: state.currentType,
    employeeId: state.employee.id,
    employeeName: state.employee.name,
    photoBase64: state.capturedPhoto,
    latitude: state.gps.lat,
    longitude: state.gps.lng,
    accuracy: state.gps.accuracy,
    address: state.gps.address || ''
  };

  try {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.ok) {
      showSuccess(data);
    } else {
      throw new Error(data.error || 'Gagal mengirim absen');
    }
  } catch (err) {
    showModal({
      icon: 'error',
      title: 'Gagal mengirim absen',
      message: err.message === 'Failed to fetch'
        ? 'Periksa koneksi internet kamu, lalu coba lagi.'
        : err.message,
      actions: [{ label: 'Coba Lagi', style: 'solid' }]
    });
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Kirim Absen';
    spinner.classList.add('hidden');
  }
}

function showSuccess(data) {
  const type = state.currentType;
  document.getElementById('success-title').textContent =
    type === 'masuk' ? 'Absen masuk berhasil' : 'Absen keluar berhasil';
  document.getElementById('success-sub').textContent =
    `${data.data.time} · ${data.data.address}`;
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

  container.innerHTML = '<div class="history-empty">Memuat riwayat…</div>';

  try {
    const res = await fetch(`${CONFIG.APPS_SCRIPT_URL}?action=history&employeeId=${encodeURIComponent(state.employee.id)}&limit=50`);
    const data = await res.json();
    renderHistory(data.history || []);
  } catch (e) {
    container.innerHTML = '<div class="history-empty">Gagal memuat riwayat. Periksa koneksi internet.</div>';
  }
}

function renderHistory(list) {
  const container = document.getElementById('history-list');
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<div class="history-empty">Belum ada riwayat absensi.</div>';
    return;
  }

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
    container.appendChild(div);
  });
}

function formatHistoryDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  } catch (e) { return dateStr; }
}

/* ============================================
   SCREEN NAVIGATION
   ============================================ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
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
  toastTimeout = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
