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
 * - Validasi payload lebih ketat sebelum proses foto (gagal cepat, tidak buang
 *   waktu upload ke Drive kalau data jelas tidak lengkap).
 * - Semua error dibungkus rapi jadi respons JSON yang konsisten, supaya app
 *   frontend selalu tahu persis kenapa gagal (bukan cuma "error" generik).
 */

const SHEET_KARYAWAN = 'Karyawan';
const SHEET_LOG = 'Log';
const FOLDER_NAME = 'Absensi - Foto Selfie'; // folder Drive otomatis dibuat di My Drive
const TZ = 'Asia/Jakarta';
const EMPLOYEE_CACHE_SECONDS = 360;

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'employees') return jsonOut({ employees: getEmployeesCached() });
    if (action === 'today') return jsonOut(getTodayStatus(e.parameter.employeeId));
    if (action === 'history') return jsonOut({ history: getHistory(e.parameter.employeeId, Number(e.parameter.limit) || 50) });
    return jsonOut({ error: 'Unknown action' });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
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

    const photoUrl = `https://drive.google.com/uc?export=view&id=${file.getId()}`;
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) return { masuk: null, keluar: null };

  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { masuk: null, keluar: null };

  const rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const result = { masuk: null, keluar: null };

  // Scan dari bawah (data terbaru) supaya kalau ada duplikat lama, yang dipakai
  // tetap entri paling akhir/terbaru.
  for (let i = rows.length - 1; i >= 0; i--) {
    const [id, name, tipe, tanggal, jam, lat, lng, akurasi, alamat, fotoUrl, mapsLink] = rows[i];
    if (String(id) !== String(employeeId)) continue;
    if (tanggal !== today) continue;

    const entry = { time: jam, address: alamat, photoUrl: fotoUrl, mapsLink };
    if (tipe === 'Masuk' && !result.masuk) result.masuk = entry;
    if (tipe === 'Keluar' && !result.keluar) result.keluar = entry;
    if (result.masuk && result.keluar) break;
  }
  return result;
}

/* ============================================
   HISTORY
   ============================================ */
function getHistory(employeeId, limit) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const out = [];

  for (let i = rows.length - 1; i >= 0; i--) {
    const [id, name, tipe, tanggal, jam, lat, lng, akurasi, alamat, fotoUrl, mapsLink] = rows[i];
    if (String(id) !== String(employeeId)) continue;
    out.push({
      type: tipe,
      date: tanggal,
      time: jam,
      address: alamat,
      photoUrl: fotoUrl,
      mapsLink: mapsLink
    });
    if (out.length >= limit) break;
  }
  return out;
}
