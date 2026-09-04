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
 */

const SHEET_KARYAWAN = 'Karyawan';
const SHEET_LOG = 'Log';
const FOLDER_NAME = 'Absen - Foto Selfie'; // folder Drive otomatis dibuat di My Drive

function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'employees') return jsonOut({ employees: getEmployees() });
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
   EMPLOYEES
   ============================================ */
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

  if (!type || !employeeId || !photoBase64 || latitude == null || longitude == null) {
    return { ok: false, error: 'Data tidak lengkap' };
  }

  // Cegah double-absen tipe yang sama di hari yang sama
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const existing = getTodayStatus(employeeId);
  const typeKey = type === 'masuk' ? 'masuk' : 'keluar';
  if (existing[typeKey]) {
    return { ok: false, error: `Sudah absen ${typeKey} hari ini` };
  }

  // Simpan foto ke Drive
  const folder = getOrCreateFolder();
  const now = new Date();
  const timeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss');
  const fileName = `${today}_${timeStr}_${type}_${employeeName}.jpg`.replace(/[\/\\?%*:|"<>]/g, '-');

  const base64Data = photoBase64.split(',')[1] || photoBase64;
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const photoUrl = `https://drive.google.com/uc?export=view&id=${file.getId()}`;
  const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;

  // Tulis ke sheet Log
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
      address: address || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      photoUrl,
      mapsLink
    }
  };
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

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rows = sheet.getDataRange().getValues();
  const result = { masuk: null, keluar: null };

  for (let i = 1; i < rows.length; i++) {
    const [id, name, tipe, tanggal, jam, lat, lng, akurasi, alamat, fotoUrl, mapsLink] = rows[i];
    if (String(id) !== String(employeeId)) continue;
    if (tanggal !== today) continue;

    const entry = { time: jam, address: alamat, photoUrl: fotoUrl, mapsLink };
    if (tipe === 'Masuk') result.masuk = entry;
    if (tipe === 'Keluar') result.keluar = entry;
  }
  return result;
}

/* ============================================
   HISTORY
   ============================================ */
function getHistory(employeeId, limit) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const out = [];

  for (let i = rows.length - 1; i >= 1; i--) {
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
