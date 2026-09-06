/**
 * ============================================
 * ABSEN — Backend (Google Apps Script)
 * ============================================
 * Cara pasang:
 * 1. Buka https://sheet.new  → buat Google Sheet baru, kasih nama "Absen DB".
 * 2. Di sheet itu, buat 2 tab (sheet) dengan nama PERSIS:
 *      - "Karyawan"  → kolom: ID | Nama | Cabang
 *      - "Log"       → kolom: ID | Nama | Tipe | Tanggal | Jam | Lat | Lng | Akurasi | Alamat | FotoURL | MapsLink
 *    (Baris pertama = header, boleh diisi manual atau biarkan kosong, script akan tetap nulis dari baris ke-2)
 * 3. Isi tab "Karyawan" dengan daftar nama sales freelance kamu.
 * 4. Buka menu Extensions → Apps Script di Google Sheet ini.
 * 5. Hapus isi default, paste seluruh isi file ini.
 * 6. Klik Deploy → New deployment → pilih tipe "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 7. Copy "Web app URL" hasil deploy, paste ke config.js → APPS_SCRIPT_URL
 * 8. Setiap kali edit script, deploy ulang lewat Deploy → Manage deployments → Edit → New version.
 *
 * ---- Kenapa versi ini lebih cepat & stabil dari versi awal ----
 * - LockService mencegah dua absen nyaris bersamaan saling tabrak/duplikat.
 * - Cache karyawan (6 menit) di CacheService supaya endpoint "employees" tidak
 *   selalu baca ulang seluruh sheet Karyawan.
 * - Cache LOG per-karyawan (2 menit) di CacheService: sheet Log cuma dibaca
 *   sekali dari Google Sheets, lalu dipakai ulang utk "today" & "history" —
 *   otomatis dihapus tiap ada absen baru supaya datanya tidak pernah basi.
 * - Endpoint gabungan "home" (today + riwayat ringkas 7 hari sekaligus dalam
 *   SATU request) supaya HP karyawan tidak perlu 2x round-trip network saat
 *   buka halaman Home — ini yang paling kerasa bikin app kerasa jauh lebih
 *   responsif dibanding versi sebelumnya.
 * - Validasi payload lebih ketat sebelum proses foto (gagal cepat, tidak buang
 *   waktu upload ke Drive kalau data jelas tidak lengkap).
 * - Semua error dibungkus rapi jadi respons JSON yang konsisten, supaya app
 *   frontend selalu tahu persis kenapa gagal (bukan cuma "error" generik).
 * - Endpoint "addEmployee": karyawan baru bisa didaftarkan LANGSUNG dari PWA
 *   (tombol "Tambah Nama Baru" di layar pilih nama) tanpa perlu buka Google
 *   Sheet manual. ID baru dibuat otomatis, nama duplikat tidak akan membuat
 *   baris ganda, dan aman dipanggil dua kali beruntun (idempotent by name).
 */

const SHEET_KARYAWAN = 'Karyawan';
const SHEET_LOG = 'Log';
const FOLDER_NAME = 'Absensi - Foto Selfie'; // folder Drive otomatis dibuat di My Drive
const TZ = 'Asia/Jakarta';
const EMPLOYEE_CACHE_SECONDS = 360;
const LOG_CACHE_SECONDS = 120; // 2 menit — cukup singkat agar tetap akurat, cukup lama utk hindari baca sheet berulang

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'employees') return jsonOut({ employees: getEmployeesCached() });
    if (action === 'today') return jsonOut(getTodayStatus(e.parameter.employeeId));
    if (action === 'history') return jsonOut({ history: getHistory(e.parameter.employeeId, Number(e.parameter.limit) || 50) });
    // "home": gabungan today + history dalam SATU response, cukup 1x baca sheet
    // (lewat cache log bersama) — dipakai layar Home biar cuma 1x round-trip.
    if (action === 'home') {
      const employeeId = e.parameter.employeeId;
      const rows = getEmployeeLogRowsCached(employeeId);
      const limit = Number(e.parameter.limit) || 50;
      return jsonOut({
        today: computeTodayStatus(rows),
        history: rows.slice(0, limit)
      });
    }
    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    if (action === 'addEmployee') return jsonOut(addEmployee(payload.name, payload.branch));
    const result = recordAttendance(payload);
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================
   NORMALISASI TANGGAL/JAM DARI SHEET
   ------------------------------------------------
   Kenapa perlu ini: kalau kolom "Jam" atau "Tanggal" di Google Sheet
   ke-format sebagai tipe Time/Date (baik manual oleh user, atau otomatis
   oleh Sheets saat appendRow menulis string "HH:mm:ss"/"yyyy-MM-dd"),
   maka sheet.getValues() akan mengembalikan objek Date JS asli, BUKAN
   string. Objek Date "pure time" dari Sheets punya tanggal dasar
   1899-12-30 (epoch khusus Lotus/Sheets). Kalau ini lolos ke JSON.stringify
   tanpa diformat ulang, frontend akan menerima "1899-12-30T03:45:36.000Z"
   alih-alih "10:45:36" — persis bug yang bikin Riwayat Presensi berantakan.
   Fungsi di bawah ini memastikan APAPUN bentuk datanya (string bersih,
   Date object, atau angka serial Sheets), yang dikirim ke frontend SELALU
   string yang sudah diformat rapi di timezone Asia/Jakarta.
   ============================================ */
function normalizeTime(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, TZ, 'HH:mm:ss');
  }
  return String(value);
}

function normalizeDate(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  }
  return String(value);
}

/* ============================================
   EMPLOYEES (dengan cache singkat biar endpoint ini instan)
   ============================================ */
function getEmployeesCached() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('employees_v1');
  if (cached) return JSON.parse(cached);

  const employees = getEmployees();
  try {
    cache.put('employees_v1', JSON.stringify(employees), EMPLOYEE_CACHE_SECONDS);
  } catch (e) { /* payload terlalu besar utk cache, abaikan */ }
  return employees;
}

function getEmployees() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_KARYAWAN);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, name, branch] = rows[i];
    if (!name) continue;
    out.push({ id: String(id || i), name: String(name), branch: String(branch || '') });
  }
  return out;
}

/* ============================================
   TAMBAH KARYAWAN BARU (dari PWA, tanpa perlu buka Sheet manual)
   ------------------------------------------------
   - Lock supaya dua orang daftar nyaris bersamaan tidak mendapat ID sama
     atau saling menimpa baris.
   - ID baru = ID numerik terbesar yang sudah ada + 1 (aman walau ada baris
     lama yang ID-nya manual/tidak berurutan).
   - Cek duplikat nama (case-insensitive, spasi berlebih diabaikan) supaya
     tidak ada dua baris untuk orang yang sama karena double-tap atau typo
     tambah dua kali; kalau sudah ada, kembalikan data yang sudah ada saja
     (idempotent) alih-alih error.
   - Cache "employees_v1" dihapus supaya endpoint "employees" berikutnya
     langsung dapat data terbaru, bukan cache basi 6 menit.
   ============================================ */
function addEmployee(rawName, rawBranch) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    return { ok: false, error: 'Nama tidak boleh kosong' };
  }
  if (name.length > 100) {
    return { ok: false, error: 'Nama terlalu panjang' };
  }
  const branch = String(rawBranch || '').trim();

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return { ok: false, error: 'Sistem sedang sibuk, coba lagi sebentar' };
  }

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_KARYAWAN);
    if (!sheet) {
      return { ok: false, error: 'Sheet "Karyawan" tidak ditemukan' };
    }

    const rows = sheet.getDataRange().getValues();
    let maxId = 0;
    const normalizedTarget = name.toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      const [id, existingName] = rows[i];
      const idNum = parseInt(id, 10);
      if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
      if (existingName && String(existingName).trim().replace(/\s+/g, ' ').toLowerCase() === normalizedTarget) {
        // Nama sudah ada — jangan buat duplikat, kembalikan data yang ada.
        return {
          ok: true,
          duplicate: true,
          employee: { id: String(id || i), name: String(existingName), branch: String(rows[i][2] || '') }
        };
      }
    }

    const newId = String(maxId + 1);
    sheet.appendRow([newId, name, branch]);
    invalidateEmployeeCache();

    return { ok: true, duplicate: false, employee: { id: newId, name: name, branch: branch } };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function invalidateEmployeeCache() {
  try { CacheService.getScriptCache().remove('employees_v1'); } catch (e) { /* abaikan */ }
}

/* ============================================
   ATTENDANCE
   ============================================ */
function recordAttendance(payload) {
  const { type, employeeId, employeeName, photoBase64, latitude, longitude, accuracy, address } = payload;

  // Validasi cepat dulu — gagal di sini jauh lebih murah daripada gagal
  // setelah upload foto ke Drive.
  if (!type || (type !== 'masuk' && type !== 'keluar')) {
    return { ok: false, error: 'Tipe absensi tidak valid' };
  }
  if (!employeeId || !employeeName) {
    return { ok: false, error: 'Data karyawan tidak lengkap' };
  }
  if (!photoBase64 || photoBase64.length < 100) {
    return { ok: false, error: 'Foto tidak valid atau kosong' };
  }
  if (latitude == null || longitude == null || isNaN(latitude) || isNaN(longitude)) {
    return { ok: false, error: 'Lokasi GPS tidak valid' };
  }

  // Lock supaya dua request nyaris bersamaan (misal double-tap tombol kirim,
  // atau retry otomatis dari app yang tumpang-tindih) tidak menghasilkan
  // baris log ganda untuk absen tipe yang sama di hari yang sama.
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    return { ok: false, error: 'Sistem sedang sibuk, coba lagi sebentar' };
  }

  try {
    const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    const typeKey = type === 'masuk' ? 'masuk' : 'keluar';
    const existing = getTodayStatus(employeeId);
    if (existing[typeKey]) {
      return { ok: false, error: `Sudah absensi ${typeKey} hari ini` };
    }

    // Simpan foto ke Drive
    const folder = getOrCreateFolder();
    const now = new Date();
    const timeStr = Utilities.formatDate(now, TZ, 'HH:mm:ss');
    const safeName = String(employeeName).replace(/[\/\\?%*:|"<>]/g, '-');
    const fileName = `${today}_${timeStr}_${type}_${safeName}.jpg`;

    const base64Data = photoBase64.indexOf(',') !== -1 ? photoBase64.split(',')[1] : photoBase64;
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', fileName);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // Format thumbnail Google Drive (bukan "uc?export=view") — jauh lebih stabil
    // dipakai sebagai <img src> di browser/PWA karena tidak diarahkan ke halaman
    // preview Drive dan jarang kena blokir hotlink seperti format "uc?export=view".
    // "sz=w1000" artinya lebar render maksimum ~1000px (cukup tajam utk thumbnail riwayat).
    const photoUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1000`;
    const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    sheet.appendRow([
      employeeId,
      employeeName,
      type === 'masuk' ? 'Masuk' : 'Keluar',
      today,
      timeStr,
      latitude,
      longitude,
      accuracy || '',
      address || '',
      photoUrl,
      mapsLink
    ]);

    // Hapus cache Log milik karyawan ini supaya request "today"/"history"/"home"
    // BERIKUTNYA langsung baca data terbaru dari sheet, bukan data basi 2 menit lalu.
    invalidateLogCache(employeeId);

    return {
      ok: true,
      data: {
        type: typeKey,
        time: timeStr,
        date: today,
        address: address || `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`,
        photoUrl,
        mapsLink
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateFolder() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

/* ============================================
   TODAY STATUS
   ============================================ */
function getTodayStatus(employeeId) {
  return computeTodayStatus(getEmployeeLogRowsCached(employeeId));
}

function computeTodayStatus(rows) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const result = { masuk: null, keluar: null };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.date !== today) continue;
    const entry = { time: row.time, address: row.address, photoUrl: row.photoUrl, mapsLink: row.mapsLink };
    if (row.type === 'Masuk' && !result.masuk) result.masuk = entry;
    if (row.type === 'Keluar' && !result.keluar) result.keluar = entry;
    if (result.masuk && result.keluar) break;
  }
  return result;
}

/* ============================================
   HISTORY
   ============================================ */
function getHistory(employeeId, limit) {
  return getEmployeeLogRowsCached(employeeId).slice(0, limit);
}

/* ============================================
   LOG CACHE (per-karyawan)
   ------------------------------------------------
   Kenapa perlu ini: endpoint "today", "history", dan "home" semuanya butuh
   baca baris Log milik karyawan yang sama, dan dipanggil BERKALI-KALI dalam
   waktu singkat (tiap buka Home, tiap buka Riwayat, tiap refresh). Tanpa
   cache, setiap panggilan baca ULANG seluruh sheet Log dari awal — ini bagian
   paling lambat di seluruh alur, apalagi kalau sheet Log sudah berisi ribuan
   baris. Dengan cache 2 menit per-karyawan, baca sheet cuma terjadi sekali
   per 2 menit per orang, sisanya diambil instan dari memori CacheService.
   Cache otomatis dihapus (lihat invalidateLogCache) begitu ada absen baru
   supaya data yang ditampilkan tidak pernah basi/telat.
   ============================================ */
function getEmployeeLogRowsCached(employeeId) {
  const cache = CacheService.getScriptCache();
  const key = 'log_rows_v1_' + String(employeeId);
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  const rows = readEmployeeLogRows(employeeId);
  try {
    cache.put(key, JSON.stringify(rows), LOG_CACHE_SECONDS);
  } catch (e) { /* payload terlalu besar utk cache, abaikan */ }
  return rows;
}

function invalidateLogCache(employeeId) {
  try { CacheService.getScriptCache().remove('log_rows_v1_' + String(employeeId)); } catch (e) { /* abaikan */ }
}

// Baca SATU KALI seluruh baris Log milik satu karyawan, sudah terurut dari
// yang PALING BARU ke paling lama, sudah dinormalisasi tanggal/jamnya.
// Inilah satu-satunya tempat yang benar-benar menyentuh Sheets untuk data Log.
function readEmployeeLogRows(employeeId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const [id, name, tipe, tanggalRaw, jamRaw, lat, lng, akurasi, alamat, fotoUrl, mapsLink] = rows[i];
    if (String(id) !== String(employeeId)) continue;
    out.push({
      type: tipe,
      date: normalizeDate(tanggalRaw),
      time: normalizeTime(jamRaw),
      address: alamat,
      photoUrl: fotoUrl,
      mapsLink: mapsLink
    });
  }
  return out;
}
