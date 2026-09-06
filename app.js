'use strict';

/* ============================================
   STATE
   ============================================ */
const state = {
  employee: null,        // {id, name, branch}
  employees: [],
  currentType: null,     // 'masuk' | 'keluar'
  cameraMode: 'attendance', // 'attendance' | 'profile' — menentukan alur kamera & preview mana yang aktif
  gps: null,             // {lat, lng, accuracy, address, addressSource}
  gpsWatchId: null,
  gpsLocked: false,
  gpsStartedAt: null,
  gpsForceReadyTimer: null,
  gpsBestAccuracySeen: Infinity,
  geocodeInFlightKey: null,
  stream: null,
  faceDetector: null,        // instance FaceDetector (kalau browser mendukung)
  faceDistanceActive: false, // apakah loop peringatan jarak wajah sedang jalan
  faceDistanceTimer: null,
  faceTooFarStreak: 0,
  faceOkStreak: 0,
  capturedPhoto: null,   // base64 dataURL (compressed)
  captureTime: null,
  todayStatus: { masuk: null, keluar: null },
  timestampInterval: null,
  submitting: false
};

const STORAGE_KEY = 'absen_employee';
const QUEUE_KEY = 'absen_pending_queue';
const EMPLOYEE_QUEUE_KEY = 'absen_pending_employees'; // nama yang ditambah pas offline, menunggu sinkron ke Sheets
const GEOCODE_CACHE_KEY = 'absen_geocode_cache';
const THEME_KEY = 'absen_theme';
const HOME_CACHE_PREFIX = 'absen_home_cache_';
const HISTORY_CACHE_PREFIX = 'absen_history_cache_';
const PROFILE_PHOTO_PREFIX = 'absen_profile_photo_'; // + employeeId -> base64 dataURL (cache lokal, sumber utama tetap server)
const PROFILE_PHOTO_QUEUE_KEY = 'absen_pending_profile_photos'; // antrian foto profil yang gagal/belum sempat ke-upload ke server
const PROFILE_PHOTO_DELETED_PREFIX = 'absen_profile_photo_deleted_'; // + employeeId -> '1' selama penghapusan belum dikonfirmasi server, biar tidak "muncul lagi" dari cache employees lama
const PROFILE_PHOTO_DELETE_QUEUE_KEY = 'absen_pending_profile_photo_deletes'; // antrian employeeId yang minta hapus foto profil tapi gagal/belum sempat sampai ke server

/* ============================================
   FOTO PROFIL — disimpan per-employeeId di localStorage supaya kalau ganti
   pengguna di HP yang sama, foto tidak pernah tertukar/bocor ke akun lain.
   ============================================ */
function isProfilePhotoDeletedLocally(employeeId) {
  try { return localStorage.getItem(PROFILE_PHOTO_DELETED_PREFIX + employeeId) === '1'; }
  catch (e) { return false; }
}
function getProfilePhoto(employeeId, employee) {
  try {
    const cached = localStorage.getItem(PROFILE_PHOTO_PREFIX + employeeId);
    if (cached) return cached;
  } catch (e) { /* localStorage disabled — lanjut fallback ke server di bawah */ }

  // Baru saja dihapus di perangkat ini tapi server belum sempat/berhasil
  // dikonfirmasi (mis. offline) — JANGAN fallback ke profilePhotoUrl lama
  // dari respons "employees"/"home", supaya foto yang sudah diminta hapus
  // tidak "muncul lagi" gara-gara data server belum sinkron.
  if (isProfilePhotoDeletedLocally(employeeId)) return null;

  // Tidak ada cache lokal (mis. device/browser baru) — fallback ke URL foto
  // profil dari server, kalau data karyawan yang diberikan memuatnya.
  // Ini KUNCI kenapa foto profil sekarang sinkron lintas device: begitu
  // employees ke-fetch dari Apps Script (lihat loadEmployees), profilePhotoUrl
  // ikut terbawa, jadi device manapun bisa langsung tahu foto sudah ada.
  if (employee && employee.profilePhotoUrl) {
    try { localStorage.setItem(PROFILE_PHOTO_PREFIX + employeeId, employee.profilePhotoUrl); } catch (e) { /* abaikan */ }
    return employee.profilePhotoUrl;
  }
  return null;
}
function setProfilePhoto(employeeId, dataUrl) {
  clearProfilePhotoDeletedFlag(employeeId); // foto baru diambil -> batalkan status "terhapus" sebelumnya kalau ada
  try { localStorage.setItem(PROFILE_PHOTO_PREFIX + employeeId, dataUrl); return true; }
  catch (e) { return false; } // storage penuh/disabled — ditangani di pemanggil
}
function removeLocalProfilePhoto(employeeId) {
  try { localStorage.removeItem(PROFILE_PHOTO_PREFIX + employeeId); } catch (e) { /* abaikan */ }
  try { localStorage.setItem(PROFILE_PHOTO_DELETED_PREFIX + employeeId, '1'); } catch (e) { /* abaikan */ }
}
function clearProfilePhotoDeletedFlag(employeeId) {
  try { localStorage.removeItem(PROFILE_PHOTO_DELETED_PREFIX + employeeId); } catch (e) { /* abaikan */ }
}

/* ============================================
   CACHE LOKAL (stale-while-revalidate)
   ------------------------------------------------
   Kenapa perlu ini: tanpa cache, tiap buka Home/Riwayat HARUS nunggu round-trip
   ke Apps Script dulu sebelum ada apa-apa yang tampil — kerasa "lama kali
   muncul" walau internetnya bagus, apalagi Apps Script sendiri punya cold-start.
   Solusinya pola stale-while-revalidate: data terakhir yang berhasil diambil
   disimpan di localStorage dan langsung dirender SEKETIKA saat layar dibuka
   (tanpa nunggu network sama sekali), lalu di baliknya app tetap fetch data
   terbaru dan diam-diam update begitu selesai. Hasilnya: layar Home/Riwayat
   SELALU langsung keisi begitu dibuka (kalau pernah dibuka sebelumnya),
   dan tetap selalu sinkron dengan data server dalam hitungan detik.
   ============================================ */
function readLocalCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeLocalCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { /* storage penuh/disabled, abaikan */ }
}

/* ============================================
   TEMA — light / dark / system
   ------------------------------------------------
   Preferensi disimpan di localStorage. Atribut data-theme
   di <html> sudah di-set SEBELUM app.js jalan (lihat inline
   script kecil di index.html) supaya tidak ada flash warna
   salah sesaat sebelum app siap.
   ============================================ */
function getSystemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(choice) {
  const isDark = choice === 'dark' || (choice === 'system' && getSystemPrefersDark());
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', isDark ? '#0A0B0D' : '#F7F5F1');

  // Update indikator & label aktif di segmented control (kalau screen Profil sudah dirender)
  const switchEl = document.getElementById('theme-switch');
  if (switchEl) {
    const opts = Array.from(switchEl.querySelectorAll('.theme-switch-opt'));
    const activeIdx = opts.findIndex(o => o.dataset.themeChoice === choice);
    opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    const indicator = document.getElementById('theme-switch-indicator');
    if (indicator && activeIdx >= 0) indicator.style.transform = `translateX(${activeIdx * 100}%)`;
  }
}

function setTheme(choice) {
  localStorage.setItem(THEME_KEY, choice);
  applyTheme(choice);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'system';
  applyTheme(saved);
}

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
  initTheme();
  startClock();
  attachEventListeners(); // HARUS selalu jalan, apa pun jalur login di bawah ini
  attachConnectivityListeners();

  await loadEmployees();
  if (navigator.onLine) {
    flushPendingEmployeeQueue();
    flushPendingProfilePhotoQueue();
    flushPendingProfilePhotoDeleteQueue();
  }

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
  document.getElementById('btn-add-employee').addEventListener('click', openAddEmployeeModal);
  document.getElementById('btn-cancel-add-employee').addEventListener('click', closeAddEmployeeModal);
  document.getElementById('btn-confirm-add-employee').addEventListener('click', onConfirmAddEmployee);
  document.getElementById('input-new-employee-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirmAddEmployee(); }
  });
  document.getElementById('input-new-employee-branch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirmAddEmployee(); }
  });
  document.getElementById('btn-logout').addEventListener('click', onLogout);
  document.getElementById('btn-camera-close').addEventListener('click', closeCamera);
  document.getElementById('btn-shutter').addEventListener('click', capturePhoto);
  document.getElementById('btn-retake').addEventListener('click', retakePhoto);
  document.getElementById('btn-submit').addEventListener('click', onSubmitPreview);
  document.getElementById('btn-back-home').addEventListener('click', goToHome);
  document.getElementById('btn-start-profile-photo').addEventListener('click', startProfilePhotoCapture);
  document.getElementById('btn-edit-profile-photo').addEventListener('click', onEditProfilePhotoClick);
  document.getElementById('btn-remove-profile-photo').addEventListener('click', onRemoveProfilePhotoClick);

  // Bottom nav — ada 3 salinan (di screen-home, screen-history & screen-profile)
  // supaya nav selalu tampil di setiap layar; semuanya terhubung ke fungsi yang sama.
  ['nav-home', 'nav-home-2', 'nav-home-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', goToHome);
  });
  ['nav-history', 'nav-history-2', 'nav-history-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      setBottomNavActive('history');
      openHistory();
    });
  });
  ['nav-profile', 'nav-profile-2', 'nav-profile-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', goToProfile);
  });
  ['nav-logout', 'nav-logout-2', 'nav-logout-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', onLogout);
  });
  ['btn-open-absen', 'btn-open-absen-2', 'btn-open-absen-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', openAbsenSheet);
  });

  // Kartu "Masuk" & "Pulang" di Home: jalan pintas langsung ke kamera dengan
  // tipe yang sesuai, tanpa perlu buka action sheet dulu. Aturan validasi
  // SAMA PERSIS dengan tombol kamera (lihat openAbsenSheet/isTypeTappable):
  // - Masuk sudah tercatat -> ketuk kartu Masuk tidak melakukan apa-apa
  // - Pulang sudah tercatat, ATAU Masuk belum dilakukan -> ketuk kartu
  //   Pulang tidak melakukan apa-apa (silent, tanpa toast/error) supaya
  //   konsisten dengan perilaku tombol "Absen Keluar" di action sheet yang
  //   memang di-disable pada kondisi sama.
  document.getElementById('card-masuk').addEventListener('click', () => tapAttendanceCard('masuk'));
  document.getElementById('card-keluar').addEventListener('click', () => tapAttendanceCard('keluar'));
  // Dukungan keyboard (Enter/Space) karena kartu ini role="button" tapi
  // bukan elemen <button> asli — supaya tetap bisa dioperasikan lewat
  // keyboard/switch-access, bukan cuma sentuhan/klik mouse.
  [['card-masuk', 'masuk'], ['card-keluar', 'keluar']].forEach(([id, type]) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        tapAttendanceCard(type);
      }
    });
  });

  // Action sheet: pilih Absen Masuk / Absen Keluar
  document.getElementById('sheet-btn-masuk').addEventListener('click', () => {
    closeAbsenSheet();
    openCamera('masuk');
  });
  document.getElementById('sheet-btn-keluar').addEventListener('click', () => {
    closeAbsenSheet();
    openCamera('keluar');
  });
  document.getElementById('sheet-btn-cancel').addEventListener('click', closeAbsenSheet);
  document.getElementById('sheet-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'sheet-overlay') closeAbsenSheet();
  });

  // Ganti tema — tiga pilihan: terang / gelap / ikuti sistem
  document.querySelectorAll('.theme-switch-opt').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice));
  });

  // Kalau user pilih "Sistem", tetap responsif kalau OS berganti tema saat app terbuka
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
    });
  }
}

function goToHome() {
  setBottomNavActive('home');
  showScreen('screen-home');
  refreshHome();
}

function goToProfile() {
  setBottomNavActive('profile');
  showScreen('screen-profile');
}

/* ============================================
   ACTION SHEET — pilih Absen Masuk / Keluar
   ============================================ */
// Satu-satunya tempat aturan validasi "boleh absen tipe X atau tidak"
// didefinisikan — dipakai bareng oleh action sheet (untuk disable tombol)
// dan kartu Masuk/Pulang di Home (untuk tap-langsung-ke-kamera), supaya
// keduanya SELALU konsisten dan tidak pernah punya aturan yang beda-beda.
function isAttendanceTypeAllowed(type) {
  const masukDone = !!(state.todayStatus && state.todayStatus.masuk);
  const keluarDone = !!(state.todayStatus && state.todayStatus.keluar);
  if (type === 'masuk') return !masukDone;
  return !keluarDone && masukDone; // 'keluar' butuh masuk sudah tercatat dulu
}

// Foto profil wajib diselesaikan dulu sebelum absen — dicek di SEMUA pintu
// masuk ke kamera absensi (kartu Home, action sheet) supaya user tidak bisa
// "melewati" kewajiban lewat jalur mana pun.
function isProfilePhotoRequired() {
  return !!(state.employee && !getProfilePhoto(state.employee.id, state.employee));
}

// Dipanggil saat kartu "Masuk"/"Pulang" di Home diketuk. Kalau kondisi
// belum valid (sudah absen tipe ini, atau keluar sebelum masuk), sengaja
// TIDAK melakukan apa-apa — sama seperti tombol senama di action sheet yang
// memang di-disable pada kondisi itu, jadi tidak butuh toast/error terpisah.
function tapAttendanceCard(type) {
  // Selagi status hari ini masih di-refresh dari server (card berlabel
  // .loading), JANGAN proses tap dulu — cache lokal yang lagi ditampilkan
  // bisa saja sudah basi (mis. baru absen dari HP lain), jadi kartu bisa
  // memicu openCamera dengan asumsi status yang salah sesaat.
  if (document.getElementById('card-masuk').classList.contains('loading')) return;
  if (isProfilePhotoRequired()) { requireProfilePhoto(); return; }
  if (!isAttendanceTypeAllowed(type)) return;
  openCamera(type);
}

function openAbsenSheet() {
  // Foto profil belum ada -> tampilkan lagi modal wajib, jangan buka sheet
  // absen sama sekali (mencegah lubang: user absen dulu, baru "kebetulan"
  // isi foto profil belakangan).
  if (isProfilePhotoRequired()) { requireProfilePhoto(); return; }

  // Sinkronkan status tombol di sheet dengan status hari ini
  const btnMasuk = document.getElementById('sheet-btn-masuk');
  const btnKeluar = document.getElementById('sheet-btn-keluar');
  btnMasuk.disabled = !isAttendanceTypeAllowed('masuk');
  btnKeluar.disabled = !isAttendanceTypeAllowed('keluar');

  document.getElementById('sheet-overlay').classList.remove('hidden');
}
function closeAbsenSheet() {
  const overlay = document.getElementById('sheet-overlay');
  overlay.classList.add('leaving'); // trigger transisi keluar (opacity + slide down) dulu
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('leaving');
  }, 260); // cocok dengan durasi transform sheet-box (0.26s)
}

function setBottomNavActive(target) {
  // target: 'home' | 'history' | 'profile' — mengatur SEMUA salinan nav
  // (muncul di screen-home, screen-history, screen-profile) sekaligus,
  // termasuk menggeser indicator pill aktif ke posisi tab yang benar.
  // Catatan: "Keluar" BUKAN target navigasi (dia cuma tombol aksi/modal),
  // jadi tidak pernah ikut dihitung di sini — indicator tidak akan pernah
  // nyasar ke slot Keluar.
  const indexByTarget = { home: 0, profile: 1, history: 3 };
  const activeIndex = indexByTarget[target] ?? 0;

  document.querySelectorAll('.nav-item:not(.nav-item-logout)').forEach(el => {
    const isHome = el.id.startsWith('nav-home');
    const isHistory = el.id.startsWith('nav-history');
    const isProfile = el.id.startsWith('nav-profile');
    el.classList.toggle('active',
      (target === 'home' && isHome) ||
      (target === 'history' && isHistory) ||
      (target === 'profile' && isProfile)
    );
  });

  // Setiap layar punya nav-indicator sendiri (satu per bottom-nav), geser semuanya
  document.querySelectorAll('.nav-indicator').forEach(el => {
    el.style.transform = `translateX(${activeIndex * 100}%)`;
  });
}

function attachConnectivityListeners() {
  window.addEventListener('online', () => {
    showToast('Koneksi kembali — mencoba kirim absensi tertunda…');
    flushPendingQueue();
    flushPendingEmployeeQueue();
    flushPendingProfilePhotoQueue();
    flushPendingProfilePhotoDeleteQueue();
  });
  window.addEventListener('offline', () => {
    showToast('Kamu sedang offline. Absensi akan dikirim otomatis saat online.', true);
  });
  // Coba flush setiap kali app dibuka kembali (misal dari background)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      flushPendingQueue();
      flushPendingEmployeeQueue();
      flushPendingProfilePhotoQueue();
      flushPendingProfilePhotoDeleteQueue();
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
  const dateEl = document.getElementById('home-date');
  if (timeEl) timeEl.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
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
  state.employees = mergeWithPendingEmployees(fallback);
  renderEmployeeList(state.employees);

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) return; // tetap pakai fallback, tidak perlu fetch

  // Coba ambil data terbaru dari Sheets di background; kalau berhasil dan
  // ada isinya, itu jadi sumber utama (menimpa fallback).
  try {
    const data = await fetchJsonWithTimeout(`${CONFIG.APPS_SCRIPT_URL}?action=employees`, {}, 8000);
    if (Array.isArray(data.employees) && data.employees.length) {
      state.employees = mergeWithPendingEmployees(data.employees);
      renderEmployeeList(state.employees);
    }
  } catch (e) {
    // offline / backend belum jalan → tetap pakai fallback yang sudah tampil
  }
}

// Menggabungkan daftar karyawan "resmi" (dari server/fallback config) dengan
// nama-nama yang baru ditambah pas offline dan masih menunggu sinkron ke
// Sheets. Supaya nama itu tetap bisa langsung dipakai buat absen SEKARANG
// (tidak perlu menunggu koneksi balik dulu), dan tidak hilang begitu app
// dibuka ulang sebelum sempat tersinkron.
function mergeWithPendingEmployees(list) {
  const pending = readEmployeeQueue();
  if (!pending.length) return list;
  const existingNames = new Set(list.map(e => e.name.trim().toLowerCase()));
  const extra = pending
    .filter(p => !existingNames.has(p.name.trim().toLowerCase()))
    .map(p => ({ id: p.localId, name: p.name, branch: p.branch || '', pending: true }));
  return list.concat(extra);
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
    const branchLine = emp.pending
      ? `<span class="employee-pending-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.3"/></svg>Menunggu sinkron</span>`
      : escapeHtml(emp.branch || '');
    // Tampilkan foto profil asli di daftar pilih nama kalau sudah ada
    // (dari server ATAU cache lokal, lihat getProfilePhoto) — supaya
    // karyawan bisa langsung kenali namanya sendiri dari foto, bukan cuma
    // inisial huruf. Fallback ke inisial tetap dipakai kalau belum ada foto
    // sama sekali (mis. karyawan baru yang belum sempat verifikasi).
    const photo = getProfilePhoto(emp.id, emp);
    const avatarInner = photo
      ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(emp.name)}" loading="lazy">`
      : initials(emp.name);
    btn.innerHTML = `
      <div class="employee-avatar${photo ? ' has-photo' : ''}">${avatarInner}</div>
      <div class="employee-info">
        <div class="employee-name">${escapeHtml(emp.name)}</div>
        <div class="employee-branch">${branchLine}</div>
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

/* ============================================
   TAMBAH NAMA BARU DARI PWA
   ------------------------------------------------
   Alur:
   1. User ketuk "Tambah Nama Baru" -> modal input nama.
   2. Kalau online: POST langsung ke Apps Script (action=addEmployee),
      tunggu hasilnya, lalu masukkan ke state.employees & auto-pilih.
   3. Kalau offline (atau request gagal karena jaringan): simpan ke
      EMPLOYEE_QUEUE_KEY dengan id lokal sementara ("local_<timestamp>"),
      tetap tampil di daftar (dengan badge "Menunggu sinkron") dan tetap
      bisa langsung dipakai absen — begitu koneksi kembali, antrian ini
      otomatis dikirim ke Sheets lewat flushPendingEmployeeQueue() dan
      ID lokal diganti ID asli dari server.
   ============================================ */
function openAddEmployeeModal() {
  const input = document.getElementById('input-new-employee-name');
  const branchInput = document.getElementById('input-new-employee-branch');
  const errorEl = document.getElementById('add-employee-error');
  input.value = '';
  branchInput.value = '';
  input.classList.remove('input-error');
  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  document.getElementById('add-employee-overlay').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeAddEmployeeModal() {
  document.getElementById('add-employee-overlay').classList.add('hidden');
}

function setAddEmployeeError(message) {
  const input = document.getElementById('input-new-employee-name');
  const errorEl = document.getElementById('add-employee-error');
  input.classList.add('input-error');
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

let addEmployeeSubmitting = false;
async function onConfirmAddEmployee() {
  if (addEmployeeSubmitting) return;

  const input = document.getElementById('input-new-employee-name');
  const name = input.value.trim().replace(/\s+/g, ' ');
  const branch = document.getElementById('input-new-employee-branch').value.trim().replace(/\s+/g, ' ');

  if (!name) {
    setAddEmployeeError('Nama tidak boleh kosong.');
    return;
  }
  if (name.length < 2) {
    setAddEmployeeError('Nama terlalu pendek.');
    return;
  }
  if (name.length > 100) {
    setAddEmployeeError('Nama terlalu panjang.');
    return;
  }
  // Cek duplikat lokal dulu (termasuk yang masih pending) supaya tidak
  // menembak backend untuk nama yang jelas-jelas sudah ada di layar ini.
  const already = state.employees.find(e => e.name.trim().toLowerCase() === name.toLowerCase());
  if (already) {
    setAddEmployeeError('Nama ini sudah ada di daftar.');
    return;
  }

  addEmployeeSubmitting = true;
  const btn = document.getElementById('btn-confirm-add-employee');
  const btnOriginalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  document.getElementById('btn-cancel-add-employee').disabled = true;

  try {
    if (!isBackendConfigured() || !navigator.onLine) {
      queueEmployeeOffline(name, branch);
      closeAddEmployeeModal();
      showToast('Kamu sedang offline — nama disimpan & akan disinkronkan otomatis nanti.');
      return;
    }

    try {
      const data = await fetchJsonWithTimeout(
        `${CONFIG.APPS_SCRIPT_URL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // hindari CORS preflight ke Apps Script
          body: JSON.stringify({ action: 'addEmployee', name, branch })
        },
        12000
      );

      if (!data.ok) {
        setAddEmployeeError(data.error || 'Gagal menyimpan nama. Coba lagi.');
        return;
      }

      const emp = data.employee;
      const exists = state.employees.find(e => e.id === emp.id);
      if (!exists) {
        state.employees.push(emp);
        renderEmployeeList(state.employees);
      }
      closeAddEmployeeModal();
      showToast(data.duplicate ? 'Nama sudah terdaftar sebelumnya — langsung dipilih.' : 'Nama baru berhasil ditambahkan.');
      selectEmployee(emp);
    } catch (networkErr) {
      // Gagal karena jaringan (timeout/offline mendadak) -> jangan buang
      // input user, simpan sebagai pending supaya tetap bisa dipakai & akan
      // otomatis dicoba lagi begitu online.
      queueEmployeeOffline(name, branch);
      closeAddEmployeeModal();
      showToast('Jaringan bermasalah — nama disimpan & akan disinkronkan otomatis nanti.');
    }
  } finally {
    addEmployeeSubmitting = false;
    btn.disabled = false;
    btn.textContent = btnOriginalText;
    document.getElementById('btn-cancel-add-employee').disabled = false;
  }
}

function queueEmployeeOffline(name, branch) {
  const localId = 'local_' + Date.now();
  const queue = readEmployeeQueue();
  queue.push({ localId, name, branch: branch || '', queuedAt: Date.now() });
  writeEmployeeQueue(queue);

  const emp = { id: localId, name, branch: branch || '', pending: true };
  state.employees.push(emp);
  renderEmployeeList(state.employees);
  selectEmployee(emp);
}

function readEmployeeQueue() {
  try { return JSON.parse(localStorage.getItem(EMPLOYEE_QUEUE_KEY)) || []; }
  catch (e) { return []; }
}
function writeEmployeeQueue(queue) {
  try { localStorage.setItem(EMPLOYEE_QUEUE_KEY, JSON.stringify(queue)); }
  catch (e) { /* storage penuh/disabled, abaikan — jarang terjadi utk data sekecil ini */ }
}

let employeeFlushInProgress = false;
async function flushPendingEmployeeQueue() {
  if (employeeFlushInProgress) return;
  const queue = readEmployeeQueue();
  if (!queue.length || !isBackendConfigured() || !navigator.onLine) return;

  employeeFlushInProgress = true;
  const remaining = [];
  let syncedCount = 0;

  for (const item of queue) {
    try {
      const data = await fetchJsonWithTimeout(
        `${CONFIG.APPS_SCRIPT_URL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'addEmployee', name: item.name, branch: item.branch })
        },
        12000
      );

      if (data.ok) {
        syncedCount++;
        replaceLocalEmployeeId(item.localId, data.employee);
      } else {
        remaining.push(item); // ditolak server (mis. nama tidak valid), simpan utk dicek manual
      }
    } catch (e) {
      remaining.push(item); // masih gagal jaringan, coba lagi nanti
    }
  }

  writeEmployeeQueue(remaining);
  employeeFlushInProgress = false;

  if (syncedCount > 0) {
    showToast(`${syncedCount} nama baru berhasil disinkronkan ke server.`);
  }
}

// Setelah nama lokal berhasil disinkronkan, ganti ID sementara ("local_...")
// dengan ID asli dari Sheets di state.employees, daftar yang sedang tampil,
// DAN sesi yang sedang login (STORAGE_KEY) kalau kebetulan user itu sendiri
// yang sedang aktif memakai app — supaya semua rujukan konsisten dan absen
// berikutnya tersimpan dengan employeeId yang benar/permanen di Sheets.
function replaceLocalEmployeeId(localId, newEmp) {
  const idx = state.employees.findIndex(e => e.id === localId);
  if (idx !== -1) state.employees[idx] = newEmp;

  if (document.getElementById('screen-login').classList.contains('active')) {
    renderEmployeeList(state.employees);
  }

  if (state.employee && state.employee.id === localId) {
    state.employee = newEmp;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newEmp));
  }

  // PENTING (fix bug foto profil hilang): karyawan yang ditambah offline
  // sempat dapat foto profil WAJIB dengan employeeId lokal sementara
  // ("local_..."). Kalau ID lokal itu tidak ikut dipindah ke ID asli di
  // sini, cache foto lokal & antrian upload (PROFILE_PHOTO_QUEUE_KEY) jadi
  // "yatim" — nempel selamanya di ID yang sudah tidak dipakai lagi, tidak
  // pernah ketemu baris di sheet Karyawan (ID asli beda), dan tidak pernah
  // ke-retry dengan ID yang benar. Foto pun terlihat "hilang".
  migrateProfilePhotoLocalId(localId, newEmp.id);
}

// Memindahkan SEMUA jejak lokal foto profil (cache tampilan + antrian upload
// yang masih pending) dari ID sementara ke ID permanen dari server, supaya
// upload background bisa lanjut jalan dengan ID yang benar-benar ada di sheet.
function migrateProfilePhotoLocalId(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;

  // 1) Cache tampilan lokal (dataURL) — pindahkan kuncinya.
  try {
    const cachedPhoto = localStorage.getItem(PROFILE_PHOTO_PREFIX + oldId);
    if (cachedPhoto) {
      localStorage.setItem(PROFILE_PHOTO_PREFIX + newId, cachedPhoto);
      localStorage.removeItem(PROFILE_PHOTO_PREFIX + oldId);
    }
    if (isProfilePhotoDeletedLocally(oldId)) {
      localStorage.setItem(PROFILE_PHOTO_DELETED_PREFIX + newId, '1');
      localStorage.removeItem(PROFILE_PHOTO_DELETED_PREFIX + oldId);
    }
  } catch (e) { /* storage disabled — abaikan, tidak fatal */ }

  // 2) Antrian upload yang masih pending — ganti employeeId-nya, JANGAN
  // dihapus, supaya begitu online foto tetap otomatis ke-upload ke baris
  // sheet yang benar (bukan hilang begitu saja).
  const queue = readProfilePhotoQueue();
  let changed = false;
  const migrated = queue.map(item => {
    if (item.employeeId === oldId) { changed = true; return { ...item, employeeId: newId }; }
    return item;
  });
  if (changed) {
    writeProfilePhotoQueue(migrated);
    // Langsung coba kirim sekarang kalau online — tidak perlu nunggu trigger lain.
    if (navigator.onLine) flushPendingProfilePhotoQueue();
  }
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Menerapkan avatar (foto profil kalau sudah ada, fallback ke inisial) ke
// SEMUA salinan avatar di app (topbar Home & hero Profil) sekaligus, supaya
// keduanya selalu sinkron tanpa perlu dipanggil manual berkali-kali.
function renderAvatar(emp) {
  const photo = emp ? getProfilePhoto(emp.id, emp) : null;
  const targets = [
    { container: 'home-employee-avatar', textEl: 'home-employee-avatar-text' },
    { container: 'profile-avatar', textEl: 'profile-avatar-text' }
  ];
  targets.forEach(({ container, textEl }) => {
    const el = document.getElementById(container);
    if (!el) return;
    const existingImg = el.querySelector('img');
    if (photo) {
      if (existingImg) {
        existingImg.src = photo;
      } else {
        const img = document.createElement('img');
        img.src = photo;
        img.alt = 'Foto profil';
        el.appendChild(img);
      }
    } else if (existingImg) {
      existingImg.remove();
    }
    const span = document.getElementById(textEl);
    if (span) span.textContent = emp ? initials(emp.name) : '—';
  });

  // Tombol hapus foto di layar Profil: HANYA tampil kalau foto profil
  // memang SUDAH terpasang. Untuk akun yang belum pernah punya foto sama
  // sekali (masih inisial), tombol ini tetap disembunyikan — sesuai
  // permintaan: yang belum ada fotonya tidak dikasih opsi hapus.
  const removeBtn = document.getElementById('btn-remove-profile-photo');
  if (removeBtn) removeBtn.classList.toggle('hidden', !photo);
}

function selectEmployee(emp) {
  state.employee = emp;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(emp));
  document.getElementById('home-employee-name').textContent = emp.name;
  document.getElementById('home-employee-branch').textContent = emp.branch || CONFIG.COMPANY_NAME;
  document.getElementById('profile-name').textContent = emp.name;
  document.getElementById('profile-branch').textContent = emp.branch || CONFIG.COMPANY_NAME;
  renderAvatar(emp);
  setBottomNavActive('home');
  showScreen('screen-home');
  refreshHome();
  flushPendingQueue();

  // WAJIB: kalau akun ini belum pernah punya foto profil sama sekali,
  // paksa user mengambil selfie dulu sebelum bisa memakai app lebih jauh.
  // Dicek SETELAH layar Home ditampilkan (bukan sebelum) supaya transisi
  // tetap mulus — modal wajib ini tampil MENGAMBANG di atas Home yang
  // sudah termuat, bukan menggantikan alur navigasi normal.
  if (!getProfilePhoto(emp.id, emp)) {
    requireProfilePhoto();
  }
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
   HOME (status hari ini + riwayat ringkas) — SATU fetch gabungan + cache instan
   ============================================ */
function homeCacheKey() {
  return HOME_CACHE_PREFIX + (state.employee ? state.employee.id : 'anon');
}

// Render SEKETIKA dari cache lokal (kalau ada) — tanpa nunggu network sama
// sekali — supaya Home tidak pernah kelihatan kosong/loading lama saat dibuka.
function paintHomeFromCache() {
  const cached = readLocalCache(homeCacheKey());
  if (!cached) return false;
  state.todayStatus = cached.today || { masuk: null, keluar: null };
  renderTodayStatus(state.todayStatus);
  renderRecentHistory(cached.history || []);
  return true;
}

async function refreshHome() {
  if (!state.employee) return;
  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) {
    const container = document.getElementById('recent-history');
    if (container) container.innerHTML = '<div class="recent-history-empty">Riwayat akan muncul setelah backend Google Sheets terhubung.</div>';
    return; // belum ada backend, biarkan status default "Belum absen"
  }

  const hadCache = paintHomeFromCache();
  // Skeleton shimmer cuma ditampilkan kalau BENAR-BENAR belum ada data apa pun
  // di layar (pertama kali buka, belum pernah ke-cache) — kalau sudah ada data
  // lama dari cache, refresh terjadi diam-diam di belakang layar tanpa kedip.
  if (!hadCache) setStatusLoading(true);

  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}?action=home&employeeId=${encodeURIComponent(state.employee.id)}&limit=50`,
      {}, 10000
    );
    state.todayStatus = data.today || { masuk: null, keluar: null };
    renderTodayStatus(state.todayStatus);
    renderRecentHistory(data.history || []);
    writeLocalCache(homeCacheKey(), { today: state.todayStatus, history: data.history || [] });
  } catch (e) { /* offline, biarkan data cache/terakhir yang tetap tampil */ } finally {
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
  const windowMasuk = document.getElementById('status-masuk-window');
  const windowKeluar = document.getElementById('status-keluar-window');

  if (data.masuk) {
    const t = safeTimeText(data.masuk.time);
    cardMasuk.classList.add('filled');
    document.getElementById('status-masuk-time').textContent = t;
    windowMasuk.textContent = `Tercatat ${t} WIB`;
    windowMasuk.title = data.masuk.address || '';
  } else {
    cardMasuk.classList.remove('filled');
    document.getElementById('status-masuk-time').textContent = '--:--';
    windowMasuk.textContent = 'Belum absen';
    windowMasuk.removeAttribute('title');
  }

  if (data.keluar) {
    const t = safeTimeText(data.keluar.time);
    cardKeluar.classList.add('filled');
    document.getElementById('status-keluar-time').textContent = t;
    windowKeluar.textContent = `Tercatat ${t} WIB`;
    windowKeluar.title = data.keluar.address || '';
  } else {
    cardKeluar.classList.remove('filled');
    document.getElementById('status-keluar-time').textContent = '--:--';
    windowKeluar.textContent = 'Belum absen';
    windowKeluar.removeAttribute('title');
  }

  // Kartu Pulang belum boleh diketuk selama Masuk belum tercatat — kasih
  // penanda visual (dim + cursor not-allowed) yang beda dari "sudah terisi",
  // supaya user paham ALASAN kenapa ketukannya tidak merespons.
  cardKeluar.classList.toggle('locked', !data.masuk && !data.keluar);
  // Tombol Absen Masuk/Keluar kini ada di action sheet (tombol + bottom nav),
  // status enable/disable-nya diatur di openAbsenSheet() berdasarkan state.todayStatus.
}

/* ============================================
   CAMERA + GPS FLOW
   ============================================ */
async function openCamera(type) {
  state.currentType = type;
  state.cameraMode = 'attendance';
  document.getElementById('camera-mode-chip').textContent = type === 'masuk' ? 'ABSENSI MASUK' : 'ABSENSI KELUAR';
  document.getElementById('gps-panel').classList.remove('hidden');
  document.getElementById('profile-photo-hint').classList.add('hidden');
  // Tombol close kembali ke perilaku normal (batalkan & pulang ke Home) —
  // lihat requireProfilePhoto() untuk kondisi WAJIB yang menyembunyikannya.
  document.getElementById('btn-camera-close').classList.remove('invisible-slot');
  showScreen('screen-camera');
  resetGpsPanel();
  startGpsWatch();
  startCameraStream();

  updateCameraTimestamp();
  state.timestampInterval = setInterval(updateCameraTimestamp, 1000);
}

/* ============================================
   FOTO PROFIL WAJIB (pertama kali login)
   ------------------------------------------------
   Alur terpisah dari absensi masuk/keluar: tidak butuh GPS sama sekali,
   dan tidak boleh dibatalkan sebelum foto benar-benar tersimpan (sesuai
   kebutuhan "wajib"). Reuse layar kamera & preview yang sama supaya app
   tidak perlu screen duplikat, tapi lewat state.cameraMode = 'profile'
   semua elemen yang GPS-dependent (panel, tombol close, dsb) disembunyikan
   otomatis dan capturePhoto()/showPreview() bercabang sesuai mode.
   ============================================ */
function requireProfilePhoto() {
  document.getElementById('required-photo-overlay').classList.remove('hidden');
}

// Tombol kamera kecil di avatar layar Profil: dipakai baik untuk mengambil
// foto pertama kali maupun mengganti foto yang sudah ada — keduanya reuse
// startProfilePhotoCapture() yang sama (upload akan menimpa foto lama).
function onEditProfilePhotoClick() {
  if (!state.employee) return;
  startProfilePhotoCapture();
}

/* ============================================
   HAPUS FOTO PROFIL
   ------------------------------------------------
   Cuma bisa dipicu kalau foto memang sudah ada (tombolnya disembunyikan
   selain itu, lihat renderAvatar). Alur:
   1. Konfirmasi dulu (aksi destruktif, foto asli di Drive ikut terhapus).
   2. Optimistic: hapus dari tampilan + cache lokal + antrian pending duluan,
      supaya user langsung lihat hasilnya tanpa nunggu network.
   3. Kalau online & backend siap: minta server hapus file Drive & kosongkan
      kolom FotoProfilURL. Kalau gagal/offline, foto tetap terhapus di HP
      ini (privasi user diutamakan), tapi dicoba lagi otomatis biar server
      ikut sinkron begitu koneksi kembali.
   ============================================ */
function onRemoveProfilePhotoClick() {
  if (!state.employee) return;
  const emp = state.employee;
  if (!getProfilePhoto(emp.id, emp)) return; // jaga-jaga, seharusnya tombol sudah tersembunyi

  showModal({
    icon: 'warn',
    title: 'Hapus foto profil?',
    message: 'Foto profil kamu akan dihapus dari perangkat ini dan dari server. Kamu bisa mengambil foto baru kapan saja setelahnya.',
    actions: [
      { label: 'Batal', style: 'ghost' },
      { label: 'Hapus', style: 'solid', onClick: () => deleteProfilePhoto(emp) }
    ]
  });
}

function deleteProfilePhoto(emp) {
  const employeeId = emp.id;

  // 1) Optimistic lokal — langsung hilang dari layar & tidak akan tampil
  // lagi biar user tidak nunggu, tanpa peduli hasil server.
  removeLocalProfilePhoto(employeeId);
  emp.profilePhotoUrl = '';
  const listedEmp = state.employees.find(e => e.id === employeeId);
  if (listedEmp) listedEmp.profilePhotoUrl = '';
  // Foto yang belum sempat ke-upload (masih di antrian) juga dibuang —
  // tidak ada gunanya lagi diupload kalau user baru saja memintanya dihapus.
  const remainingQueue = readProfilePhotoQueue().filter(item => item.employeeId !== employeeId);
  writeProfilePhotoQueue(remainingQueue);

  renderAvatar(state.employee);
  showToast('Foto profil dihapus.');

  // 2) Hapus di server juga (foto asli + kolom sheet), diam-diam di
  // belakang layar. Kalau gagal, foto tetap terhapus di HP ini — tidak
  // memblokir user, karena yang terpenting privasinya di perangkat sendiri
  // sudah terjaga; sinkronisasi server menyusul kapan saja koneksi ada.
  requestServerDeleteProfilePhoto(employeeId);
}

function readProfilePhotoDeleteQueue() {
  try { return JSON.parse(localStorage.getItem(PROFILE_PHOTO_DELETE_QUEUE_KEY)) || []; }
  catch (e) { return []; }
}
function writeProfilePhotoDeleteQueue(queue) {
  try { localStorage.setItem(PROFILE_PHOTO_DELETE_QUEUE_KEY, JSON.stringify(queue)); }
  catch (e) { /* storage penuh/disabled — jarang, isinya cuma daftar ID */ }
}

// Meminta server menghapus foto (file Drive + kolom sheet). Kalau gagal
// (offline/timeout), permintaan masuk antrian PROFILE_PHOTO_DELETE_QUEUE_KEY
// dan otomatis dicoba lagi lewat flushPendingProfilePhotoDeleteQueue() —
// disamakan polanya dengan antrian upload/tambah-karyawan yang sudah ada,
// supaya konsisten dan tidak ada permintaan hapus yang diam-diam hilang.
async function requestServerDeleteProfilePhoto(employeeId) {
  if (!isBackendConfigured() || !navigator.onLine) {
    queueProfilePhotoDelete(employeeId);
    return;
  }
  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'deleteProfilePhoto', employeeId })
      },
      15000
    );
    if (data.ok) {
      clearProfilePhotoDeletedFlag(employeeId); // server sudah konfirmasi -> aman, tidak perlu ditahan lagi
      const remaining = readProfilePhotoDeleteQueue().filter(id => id !== employeeId);
      writeProfilePhotoDeleteQueue(remaining);
    } else {
      queueProfilePhotoDelete(employeeId);
    }
  } catch (e) {
    queueProfilePhotoDelete(employeeId); // gagal jaringan -> coba lagi nanti otomatis
  }
}

function queueProfilePhotoDelete(employeeId) {
  const queue = readProfilePhotoDeleteQueue();
  if (!queue.includes(employeeId)) queue.push(employeeId);
  writeProfilePhotoDeleteQueue(queue);
}

let profilePhotoDeleteFlushInProgress = false;
async function flushPendingProfilePhotoDeleteQueue() {
  if (profilePhotoDeleteFlushInProgress) return;
  const queue = readProfilePhotoDeleteQueue();
  if (!queue.length || !isBackendConfigured() || !navigator.onLine) return;

  profilePhotoDeleteFlushInProgress = true;
  const remaining = [];

  for (const employeeId of queue) {
    try {
      const data = await fetchJsonWithTimeout(
        `${CONFIG.APPS_SCRIPT_URL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'deleteProfilePhoto', employeeId })
        },
        15000
      );
      if (data.ok) {
        clearProfilePhotoDeletedFlag(employeeId);
      } else {
        remaining.push(employeeId);
      }
    } catch (e) {
      remaining.push(employeeId);
    }
  }

  writeProfilePhotoDeleteQueue(remaining);
  profilePhotoDeleteFlushInProgress = false;
}

function startProfilePhotoCapture() {
  document.getElementById('required-photo-overlay').classList.add('hidden');
  state.cameraMode = 'profile';
  state.currentType = null;
  document.getElementById('camera-mode-chip').textContent = 'FOTO PROFIL';
  // GPS panel & tombol close disembunyikan: foto profil tidak butuh lokasi,
  // dan TIDAK BOLEH dibatalkan begitu saja di tengah jalan (wajib selesai).
  document.getElementById('gps-panel').classList.add('hidden');
  document.getElementById('profile-photo-hint').classList.remove('hidden');
  // "invisible-slot" (BUKAN .hidden/display:none) sengaja dipakai di sini:
  // tombol close tetap makan ruang layout yang sama seperti biasa, cuma
  // tidak terlihat & tidak bisa diklik. Kalau pakai display:none, ruang
  // yang ditinggalkannya hilang sementara .topbar-spacer di kanan tetap
  // ada lebarnya -> chip "FOTO PROFIL" jadi tidak center, ketarik ke kiri.
  document.getElementById('btn-camera-close').classList.add('invisible-slot');
  showScreen('screen-camera');

  // Shutter langsung aktif (tidak menunggu GPS sama sekali) karena foto
  // profil murni cuma butuh video feed kamera.
  const shutterBtn = document.getElementById('btn-shutter');
  shutterBtn.disabled = false;
  document.getElementById('camera-hint').textContent = 'Ketuk tombol untuk mengambil foto profil';

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
    const video = document.getElementById('camera-video');
    video.srcObject = stream;
    startFaceDistanceWatch(video);
  }).catch(() => {
    // Kalau mode profil (wajib) dan kamera gagal diakses, tombol "Kembali"
    // TIDAK BOLEH langsung pulang ke Home (itu akan membiarkan foto profil
    // tetap kosong selamanya) — arahkan balik ke modal wajib supaya user
    // bisa coba lagi memberi izin kamera, bukan lolos dari kewajibannya.
    const isProfileMode = state.cameraMode === 'profile';
    showModal({
      icon: 'error',
      title: 'Tidak bisa akses kamera',
      message: isProfileMode
        ? 'Izinkan akses kamera di pengaturan browser untuk melengkapi foto profil.'
        : 'Izinkan akses kamera di pengaturan browser untuk melanjutkan absensi.',
      actions: [{ label: 'Kembali', style: 'solid', onClick: () => {
        if (isProfileMode) {
          showScreen('screen-home');
          requireProfilePhoto();
        } else {
          closeCamera();
        }
      } }]
    });
  });
}

/* ============================================
   PERINGATAN JARAK WAJAH (opsional, non-blocking)
   ------------------------------------------------
   Tidak ada bingkai/oval yang membatasi komposisi foto — user bebas selfie
   senormal kamera bawaan. Yang dibatasi HANYA jarak wajah supaya tidak
   terlalu jauh dari kamera (foto absen jadi terlalu kecil/kurang jelas
   untuk verifikasi). Dipakai FaceDetector API bawaan browser (Chrome
   Android) kalau tersedia; kalau tidak, fitur ini diam-diam nonaktif sama
   sekali — TIDAK PERNAH memblokir shutter, cuma peringatan visual halus.
   ============================================ */
function startFaceDistanceWatch(video) {
  stopFaceDistanceWatch(); // pastikan tidak ada loop lama nyangkut

  if (typeof FaceDetector === 'undefined') return; // browser tidak dukung, skip total

  let detector;
  try {
    detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
  } catch (e) {
    return; // gagal inisialisasi (mis. permission/flag khusus), skip diam-diam
  }

  state.faceDetector = detector;
  state.faceDistanceActive = true;
  state.faceTooFarStreak = 0;
  state.faceOkStreak = 0;

  // Throttle deteksi tiap ~450ms — cukup responsif tapi ringan di CPU,
  // tidak mengganggu kelancaran preview video sama sekali.
  const DETECT_INTERVAL_MS = 450;
  // Ambang: wajah dianggap "terlalu jauh" kalau tinggi bounding-box wajah
  // kurang dari ~22% tinggi frame video — nilai ini dikalibrasi longgar
  // supaya TIDAK mudah false-positive selama masih dalam jarak selfie wajar.
  const FACE_TOO_FAR_RATIO = 0.22;
  // Butuh beberapa deteksi berturut-turut sebelum toggle tampilan, supaya
  // tip tidak "kedip-kedip" tiap frame gara-gara noise deteksi.
  const STREAK_TO_TOGGLE = 2;

  async function tick() {
    if (!state.faceDistanceActive) return;
    try {
      if (video.readyState >= 2 && video.videoHeight > 0) {
        const faces = await detector.detect(video);
        if (faces && faces.length > 0) {
          const box = faces[0].boundingBox;
          const ratio = box.height / video.videoHeight;
          if (ratio < FACE_TOO_FAR_RATIO) {
            state.faceTooFarStreak++;
            state.faceOkStreak = 0;
          } else {
            state.faceOkStreak++;
            state.faceTooFarStreak = 0;
          }
          if (state.faceTooFarStreak >= STREAK_TO_TOGGLE) setDistanceTipVisible(true);
          else if (state.faceOkStreak >= STREAK_TO_TOGGLE) setDistanceTipVisible(false);
        } else {
          // Tidak ada wajah kedetek sama sekali (mis. HP belum diarahkan ke
          // wajah) — jangan tampilkan peringatan "terlalu jauh" yang keliru,
          // cukup sembunyikan dan tunggu deteksi berikutnya.
          setDistanceTipVisible(false);
        }
      }
    } catch (e) {
      // Deteksi gagal di frame ini (jarang, biasanya sesaat) — abaikan dan
      // coba lagi di tick berikutnya, jangan hentikan loop atau ganggu user.
    }
    state.faceDistanceTimer = setTimeout(tick, DETECT_INTERVAL_MS);
  }
  tick();
}

function setDistanceTipVisible(visible) {
  const tip = document.getElementById('camera-distance-tip');
  if (tip) tip.classList.toggle('hidden', !visible);
}

function stopFaceDistanceWatch() {
  state.faceDistanceActive = false;
  clearTimeout(state.faceDistanceTimer);
  state.faceDistanceTimer = null;
  setDistanceTipVisible(false);
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
  // Guard defensif: di mode profil (wajib), tombol close ini disembunyikan
  // dari UI (lihat startProfilePhotoCapture), tapi kalau tetap terpanggil
  // lewat jalur lain, JANGAN biarkan user lolos tanpa foto profil — arahkan
  // balik ke modal wajib alih-alih pulang ke Home dengan tangan kosong.
  if (state.cameraMode === 'profile') {
    stopCameraStream();
    clearInterval(state.timestampInterval);
    showScreen('screen-home');
    requireProfilePhoto();
    return;
  }
  stopCameraStream();
  stopGpsWatch();
  clearInterval(state.timestampInterval);
  goToHome();
}

function stopCameraStream() {
  stopFaceDistanceWatch();
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
  // Mode profil tidak butuh GPS sama sekali; mode absensi tetap wajib
  // punya titik GPS sebelum shutter boleh benar-benar memotret.
  if (state.cameraMode === 'attendance' && !state.gps) return;

  const video = document.getElementById('camera-video');
  // Guard: video feed belum siap (mis. getUserMedia masih pending/gagal,
  // atau ditekan sepersekian detik terlalu cepat) -> videoWidth/Height masih
  // 0, yang akan menghasilkan canvas kosong 0x0 kalau diteruskan. Diamkan
  // saja ketukannya daripada menyimpan foto rusak/blank.
  if (!video.videoWidth || !video.videoHeight) return;

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
  state.captureTime = new Date();
  if (state.cameraMode === 'attendance') {
    state.capturedGps = { ...state.gps }; // bekukan titik GPS persis saat shutter ditekan
    stopGpsWatch();
  }

  stopCameraStream();
  clearInterval(state.timestampInterval);

  showPreview();
}

function showPreview() {
  document.getElementById('preview-image').src = state.capturedPhoto;
  const infoPanel = document.getElementById('preview-info');
  const btnSubmitText = document.getElementById('btn-submit-text');
  const btnRetake = document.getElementById('btn-retake');

  if (state.cameraMode === 'profile') {
    // Preview foto profil: tanpa info GPS/waktu (tidak relevan), label
    // tombol disesuaikan supaya jelas ini menyimpan foto profil, BUKAN
    // mengirim absensi.
    infoPanel.classList.add('hidden');
    btnSubmitText.textContent = 'Gunakan Foto Ini';
    btnRetake.textContent = 'Ambil Ulang';
  } else {
    infoPanel.classList.remove('hidden');
    document.getElementById('preview-time').textContent = formatDateTimeWIB(state.captureTime);
    document.getElementById('preview-address').textContent =
      state.capturedGps.address || `${state.capturedGps.lat.toFixed(6)}, ${state.capturedGps.lng.toFixed(6)}`;
    document.getElementById('preview-accuracy').textContent = `Akurasi GPS ±${state.capturedGps.accuracy} meter`;
    btnSubmitText.textContent = 'Kirim Absensi';
    btnRetake.textContent = 'Ambil ulang';
  }
  showScreen('screen-preview');
}

function retakePhoto() {
  if (state.cameraMode === 'profile') {
    startProfilePhotoCapture();
    return;
  }
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
// Tombol "Kirim Absensi"/"Gunakan Foto Ini" di layar preview memicu alur
// berbeda tergantung mode kamera saat ini — router kecil ini memastikan
// klik yang sama selalu diarahkan ke logic yang benar.
function onSubmitPreview() {
  if (state.cameraMode === 'profile') {
    saveProfilePhotoFromCapture();
  } else {
    submitAttendance();
  }
}

/* ============================================
   SIMPAN FOTO PROFIL (mode profil)
   ------------------------------------------------
   Foto profil di-UPLOAD ke server (Drive + kolom "FotoProfilURL" di sheet
   Karyawan) — BUKAN cuma disimpan lokal — supaya begitu karyawan buka app
   di HP lain atau browser lain, fotonya sudah ada dan tidak diminta ambil
   ulang. localStorage tetap dipakai sebagai CACHE lokal saja (biar avatar
   di app langsung berubah instan tanpa nunggu upload selesai, dan tetap
   ada tampilan sesuatu walau sedang offline).

   Alur:
   1. Update localStorage & avatar SEKETIKA (optimistic) — UX tetap terasa
      instan meski uploadnya di background.
   2. Kalau online & backend siap: upload ke server. Berhasil -> selesai,
      URL server jadi sumber kebenaran utama untuk device lain.
   3. Kalau offline/gagal jaringan: masuk antrian PROFILE_PHOTO_QUEUE_KEY,
      otomatis dicoba lagi lewat flushPendingProfilePhotoQueue() begitu
      koneksi kembali (dipanggil dari listener online yang sama dengan
      antrian absensi & antrian tambah nama, supaya semua sinkronisasi
      terjadi bersamaan & konsisten).
   4. Foto profil TIDAK PERNAH dianggap wajib berhasil upload sebelum user
      bisa lanjut pakai app — kalau uploadnya gagal, user tetap lanjut ke
      Home dengan foto tersimpan lokal, dan sinkronisasi menyusul otomatis.
   ============================================ */
function saveProfilePhotoFromCapture() {
  const employeeId = state.employee.id;
  const employeeName = state.employee.name;
  const employeeBranch = state.employee.branch;
  const photoDataUrl = state.capturedPhoto;

  // 1) Optimistic: langsung terasa di UI, tidak nunggu network sama sekali.
  const savedLocally = setProfilePhoto(employeeId, photoDataUrl);
  renderAvatar(state.employee);
  clearInterval(state.timestampInterval);
  state.cameraMode = 'attendance';
  goToHome();

  if (!savedLocally) {
    showToast('Foto profil belum tersimpan di perangkat ini, silakan coba lagi dari halaman Profil', true);
  }

  // 2) Upload ke server di background, tanpa mengunci navigasi user.
  // Nama & cabang ikut dikirim (bukan cuma ID): kalau backend belum punya
  // baris untuk karyawan ini (lihat catatan fallback di uploadProfilePhoto),
  // baris baru bisa langsung dibuat dengan nama yang benar, bukan placeholder.
  uploadProfilePhoto(employeeId, photoDataUrl, employeeName, employeeBranch);
}

async function uploadProfilePhoto(employeeId, photoDataUrl, employeeName, employeeBranch) {
  if (!isBackendConfigured() || !navigator.onLine) {
    queueProfilePhotoOffline(employeeId, photoDataUrl, employeeName, employeeBranch);
    showToast('Kamu sedang offline — foto profil akan disinkronkan otomatis nanti.');
    return;
  }

  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'saveProfilePhoto', employeeId, photoBase64: photoDataUrl, employeeName, employeeBranch })
      },
      25000 // foto profil relatif kecil (sudah dikompres sama seperti foto absen), tapi kasih ruang cukup utk jaringan lambat
    );

    if (data.ok) {
      showToast('Verifikasi identitas berhasil — foto profil tersinkron ke server.');
      // Backend bisa saja membuatkan baris & ID BARU (fallback kalau ID lama
      // belum ada di sheet, mis. race dengan sinkronisasi karyawan offline) —
      // kalau itu terjadi, samakan ID di device ini juga supaya konsisten
      // dengan yang tersimpan di sheet, bukan cuma foto & URL-nya saja.
      if (data.employeeId && data.employeeId !== employeeId) {
        migrateProfilePhotoLocalId(employeeId, data.employeeId);
        if (state.employee && state.employee.id === employeeId) {
          state.employee.id = data.employeeId;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.employee));
        }
        const listedEmp = state.employees.find(e => e.id === employeeId);
        if (listedEmp) listedEmp.id = data.employeeId;
        employeeId = data.employeeId;
      }
      applyServerProfilePhoto(employeeId, data.profilePhotoUrl);
    } else {
      // Ditolak server (bukan soal jaringan) -> tetap simpan sebagai pending
      // supaya tidak hilang, sambil kasih tahu apa alasannya kalau perlu dicek.
      queueProfilePhotoOffline(employeeId, photoDataUrl, employeeName, employeeBranch);
    }
  } catch (err) {
    // Gagal jaringan/timeout -> antrian, dicoba lagi otomatis nanti.
    queueProfilePhotoOffline(employeeId, photoDataUrl, employeeName, employeeBranch);
    showToast('Jaringan bermasalah — foto profil akan disinkronkan otomatis nanti.');
  }
}

function queueProfilePhotoOffline(employeeId, photoDataUrl, employeeName, employeeBranch) {
  const queue = readProfilePhotoQueue();
  // Satu karyawan cukup satu entri antrian — kalau sebelumnya sudah ada
  // (mis. ganti foto lagi sebelum sempat sinkron), timpa saja yang lama,
  // jangan menumpuk banyak entri untuk orang yang sama.
  const filtered = queue.filter(item => item.employeeId !== employeeId);
  filtered.push({ employeeId, photoDataUrl, employeeName, employeeBranch, queuedAt: Date.now() });
  writeProfilePhotoQueue(filtered);
}

function readProfilePhotoQueue() {
  try { return JSON.parse(localStorage.getItem(PROFILE_PHOTO_QUEUE_KEY)) || []; }
  catch (e) { return []; }
}
function writeProfilePhotoQueue(queue) {
  try { localStorage.setItem(PROFILE_PHOTO_QUEUE_KEY, JSON.stringify(queue)); }
  catch (e) { /* storage penuh/disabled — jarang terjadi, foto sudah terkompresi kecil */ }
}

let profilePhotoFlushInProgress = false;
async function flushPendingProfilePhotoQueue() {
  if (profilePhotoFlushInProgress) return;
  const queue = readProfilePhotoQueue();
  if (!queue.length || !isBackendConfigured() || !navigator.onLine) return;

  profilePhotoFlushInProgress = true;
  const remaining = [];
  let syncedCount = 0;

  for (const item of queue) {
    try {
      const data = await fetchJsonWithTimeout(
        `${CONFIG.APPS_SCRIPT_URL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'saveProfilePhoto',
            employeeId: item.employeeId,
            photoBase64: item.photoDataUrl,
            employeeName: item.employeeName,
            employeeBranch: item.employeeBranch
          })
        },
        25000
      );
      if (data.ok) {
        syncedCount++;
        let finalId = item.employeeId;
        if (data.employeeId && data.employeeId !== item.employeeId) {
          migrateProfilePhotoLocalId(item.employeeId, data.employeeId);
          if (state.employee && state.employee.id === item.employeeId) {
            state.employee.id = data.employeeId;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.employee));
          }
          const listedEmp = state.employees.find(e => e.id === item.employeeId);
          if (listedEmp) listedEmp.id = data.employeeId;
          finalId = data.employeeId;
        }
        applyServerProfilePhoto(finalId, data.profilePhotoUrl);
      } else {
        remaining.push(item);
      }
    } catch (e) {
      remaining.push(item); // masih gagal jaringan, coba lagi nanti
    }
  }

  writeProfilePhotoQueue(remaining);
  profilePhotoFlushInProgress = false;

  if (syncedCount > 0) {
    showToast(`Foto profil (${syncedCount}) berhasil disinkronkan ke server.`);
  }
}

// Setelah foto profil berhasil tersimpan/tersinkron ke server, samakan
// data URL-nya di state.employees (dipakai daftar pilih nama) supaya
// avatar di layar login ikut ter-update tanpa perlu reload manual.
function applyServerProfilePhoto(employeeId, profilePhotoUrl) {
  const emp = state.employees.find(e => e.id === employeeId);
  if (emp) emp.profilePhotoUrl = profilePhotoUrl;
  if (document.getElementById('screen-login').classList.contains('active')) {
    renderEmployeeList(state.employees);
  }
}

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
        actions: [{ label: 'Oke', style: 'solid', onClick: goToHome }]
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
      refreshHome();
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
    `${safeTimeText(data.data.time)} WIB · ${data.data.address}`;
  showScreen('screen-success');
}

/* ============================================
   RIWAYAT RINGKAS DI HOME (7 hari terakhir)
   ============================================ */
function renderRecentHistory(list) {
  const container = document.getElementById('recent-history');

  // Kelompokkan per tanggal, urut terbaru dulu, ambil 7 tanggal unik terakhir
  const byDate = new Map();
  list.forEach(item => {
    if (!byDate.has(item.date)) byDate.set(item.date, { masuk: null, keluar: null });
    const group = byDate.get(item.date);
    if (item.type === 'Masuk' && !group.masuk) group.masuk = item;
    if (item.type === 'Keluar' && !group.keluar) group.keluar = item;
  });

  const dates = Array.from(byDate.keys())
    .sort((a, b) => new Date(b) - new Date(a))
    .slice(0, 7);

  if (!dates.length) {
    container.innerHTML = '<div class="recent-history-empty">Belum ada riwayat absensi.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  dates.forEach(date => {
    const group = byDate.get(date);
    const div = document.createElement('div');
    div.className = 'recent-day-group';
    div.innerHTML = `
      <div class="recent-day-date">${formatFullHistoryDate(date)}</div>
      <div class="recent-day-rows">
        ${renderRecentRow('in', 'Masuk', group.masuk)}
        ${renderRecentRow('out', 'Pulang', group.keluar)}
      </div>
    `;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}

function renderRecentRow(kind, label, entry) {
  const icon = kind === 'in'
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 3H19a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const time = entry ? safeTimeText(entry.time) : '—';
  return `
    <div class="recent-row">
      <span class="recent-row-icon ${kind}">${icon}</span>
      <span class="recent-row-label">${label}</span>
      <span class="recent-row-time">${time}</span>
    </div>
  `;
}

function formatFullHistoryDate(dateStr) {
  const d = parseDateSafe(dateStr);
  if (!d) return dateStr || '—';
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}

// Backend seharusnya selalu kirim jam sebagai string "HH:mm:ss" murni.
// Fungsi ini jaga-jaga kalau ada baris data LAMA di sheet yang sempat
// tersimpan sebelum backend diperbaiki (masih berbentuk timestamp aneh
// gaya "1899-12-30T03:45:36.000Z") — supaya tetap tampil sebagai jam,
// bukan raw ISO string yang membingungkan.
function safeTimeText(value) {
  if (!value) return '—';
  const str = String(value).trim();
  // Sudah format jam bersih (HH:mm atau HH:mm:ss) -> tampilkan langsung
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(str)) return str;
  // Timestamp ISO (termasuk epoch 1899-12-30 dari Google Sheets) -> ambil jamnya saja
  const d = new Date(str);
  if (!isNaN(d)) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ });
  }
  return str;
}

function parseDateSafe(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  // Format "yyyy-MM-dd" murni -> parse manual biar tidak kena pergeseran timezone
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

/* ============================================
   HISTORY (halaman penuh, dibuka dari bottom nav)
   ============================================ */
function historyCacheKey() {
  return HISTORY_CACHE_PREFIX + (state.employee ? state.employee.id : 'anon');
}

async function openHistory() {
  showScreen('screen-history');
  const container = document.getElementById('history-list');

  const backendConfigured = isBackendConfigured();
  if (!backendConfigured) {
    container.innerHTML = '<div class="history-empty">Riwayat akan muncul di sini setelah backend Google Sheets terhubung (lihat README.md).</div>';
    return;
  }

  // Tampilkan cache lokal SEKETIKA kalau ada (halaman ini pernah dibuka
  // sebelumnya) — jauh lebih responsif daripada nunggu skeleton lalu network.
  // Skeleton shimmer cuma dipakai kalau memang belum pernah ada data sama sekali.
  const cachedList = readLocalCache(historyCacheKey());
  if (cachedList && cachedList.length) {
    renderHistory(cachedList);
  } else {
    container.innerHTML = renderHistorySkeleton();
  }

  try {
    const data = await fetchJsonWithTimeout(
      `${CONFIG.APPS_SCRIPT_URL}?action=history&employeeId=${encodeURIComponent(state.employee.id)}&limit=50`,
      {}, 12000
    );
    renderHistory(data.history || []);
    writeLocalCache(historyCacheKey(), data.history || []);
  } catch (e) {
    // Kalau sudah ada data cache yang tampil, biarkan tetap tampil (lebih
    // berguna daripada diganti pesan error) — cukup diam-diam gagal di
    // belakang layar. Pesan error cuma ditunjukkan kalau memang belum ada
    // data apa pun yang bisa ditampilkan sama sekali.
    if (!cachedList || !cachedList.length) {
      container.innerHTML = '<div class="history-empty">Gagal memuat riwayat. Periksa koneksi internet.</div>';
    }
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
      <img class="history-thumb" src="${toThumbnailUrl(item.photoUrl)}" loading="lazy" alt="Foto selfie absensi">
      <div class="history-info">
        <div class="history-top-row">
          <span class="history-type ${item.type === 'Masuk' ? 'masuk' : 'keluar'}">${item.type}</span>
          <span class="history-date">${formatHistoryDate(item.date)}</span>
        </div>
        <div class="history-addr">${escapeHtml(item.address || '')}</div>
      </div>
      <div class="history-time">${safeTimeText(item.time)}</div>
    `;
    const img = div.querySelector('.history-thumb');
    // Fallback berlapis kalau foto gagal dimuat (link lama format "uc?export=view",
    // foto dihapus manual dari Drive, atau lagi offline): jangan biarkan ikon
    // broken-image jelek nongol — ganti jadi ikon kamera netral yang tetap rapi.
    img.addEventListener('error', () => {
      img.classList.add('history-thumb-fallback');
      img.removeAttribute('src');
    }, { once: true });
    div.addEventListener('click', () => window.open(item.mapsLink, '_blank'));
    frag.appendChild(div);
  });
  container.appendChild(frag);
}

// Menormalkan URL foto Drive lama ("uc?export=view", link "open?id=", dsb.) ke
// format "thumbnail?id=" yang jauh lebih stabil di-render sebagai <img src>
// di browser/PWA — supaya riwayat lama pun tetap tampil, bukan cuma yang baru.
function toThumbnailUrl(url) {
  if (!url) return '';
  const match = String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/) || String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w400`;
  }
  return url;
}

function formatHistoryDate(dateStr) {
  const d = parseDateSafe(dateStr);
  if (!d) return dateStr || '—';
  return d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
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
let toastLeaveTimeout;
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimeout);
  clearTimeout(toastLeaveTimeout);

  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : ''); // reset: hapus 'leaving'/'hidden', munculkan lagi dgn animasi toast-in

  toastTimeout = setTimeout(() => {
    toast.classList.add('leaving'); // mulai animasi fade-out halus
    toastLeaveTimeout = setTimeout(() => {
      toast.classList.add('hidden'); // baru display:none setelah animasi selesai
      toast.classList.remove('leaving');
    }, 220);
  }, 3500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
