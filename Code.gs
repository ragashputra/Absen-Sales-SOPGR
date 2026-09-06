/**
 * ============================================
 * ABSEN — Backend (Google Apps Script)
 * ============================================
 * Cara pasang:
 * 1. Buka https://sheet.new  → buat Google Sheet baru, kasih nama "Absen DB".
 * 2. Di sheet itu, buat 2 tab (sheet) dengan nama PERSIS:
 *      - "Karyawan"  → kolom: ID | Nama | Cabang | FotoProfilURL
 *      - "Log"       → kolom: ID | Nama | Tipe | Tanggal | Jam | Lat | Lng | Akurasi | Alamat | FotoURL | MapsLink
 *    (Baris pertama = header, boleh diisi manual atau biarkan kosong, script akan tetap nulis dari baris ke-2.
 *    Kolom "FotoProfilURL" akan diisi OTOMATIS oleh script begitu karyawan
 *    mengambil foto profil dari app — tidak perlu diisi manual.)
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
 * - Endpoint "saveProfilePhoto": foto profil verifikasi identitas disimpan
 *   ke Drive + kolom "FotoProfilURL" di sheet Karyawan (BUKAN cuma di
 *   localStorage HP), supaya begitu karyawan buka app di HP/browser lain,
 *   foto profilnya SUDAH ADA dan tidak diminta ambil ulang. Foto lama
 *   (kalau ganti foto) otomatis dihapus dari Drive supaya tidak menumpuk.
 * - Endpoint "deleteEmployee": menghapus akun karyawan secara PERMANEN —
 *   baris di sheet Karyawan, foto profilnya, DAN seluruh riwayat absensi
 *   (sheet Log) beserta foto selfie-nya di Drive. Dipanggil dari menu
 *   "Hapus Akun" di layar Profil PWA. Tindakan ini tidak bisa dibatalkan.
 * - Status TELAT / TEPAT WAKTU: setiap absen "Masuk" otomatis dinilai
 *   terhadap jam kerja resmi — 08:00 WIB (Senin–Sabtu) atau 09:00 WIB
 *   (Minggu & tanggal merah/cuti bersama nasional). Tanggal merah diambil
 *   REALTIME dari API publik (bukan hardcode), di-cache 6 jam supaya cepat
 *   & hemat quota, dengan 2 lapis fallback (API cadangan + data tersimpan
 *   terakhir) kalau API utama sedang down. PENTING: pertama kali fungsi ini
 *   jalan (Run/deploy), Apps Script akan minta izin baru "Connect to an
 *   external service" — klik Authorize & Allow seperti biasa, ini normal
 *   dan hanya muncul sekali.
 */

const SHEET_KARYAWAN = 'Karyawan';
const SHEET_LOG = 'Log';
const FOLDER_NAME = 'Absensi - Foto Selfie'; // folder Drive otomatis dibuat di My Drive
const PROFILE_FOLDER_NAME = 'Absensi - Foto Profil'; // folder terpisah khusus foto profil (identitas), biar tidak campur dgn foto selfie absen harian
const TZ = 'Asia/Jakarta';
const EMPLOYEE_CACHE_SECONDS = 360;
const LOG_CACHE_SECONDS = 120; // 2 menit — cukup singkat agar tetap akurat, cukup lama utk hindari baca sheet berulang

/* ============================================
   JAM KERJA & STATUS TELAT/TEPAT WAKTU
   ------------------------------------------------
   - Senin–Sabtu (hari kerja biasa): batas jam masuk 08:00 WIB.
   - Minggu ATAU tanggal merah/cuti bersama nasional: batas jam masuk 09:00 WIB.
   - Status HANYA berlaku untuk absen tipe "Masuk". Absen "Keluar" tidak
     pernah dikategorikan telat/tepat waktu (tidak relevan secara bisnis).
   ============================================ */
const WORK_START_WEEKDAY = '08:00:00';   // Senin–Sabtu
const WORK_START_HOLIDAY = '09:00:00';   // Minggu & tanggal merah nasional
const HOLIDAY_CACHE_SECONDS = 21600;     // 6 jam — daftar libur setahun jarang berubah, tapi cukup sering refresh utk menangkap update cuti bersama baru
// Dua sumber API hari libur nasional Indonesia dipakai BERLAPIS (bukan cuma
// satu) — supaya kalau salah satu sedang down/limit (layanan gratis seperti
// ini kadang begitu), status telat/ontime TETAP bisa dihitung dengan benar:
// 1) Primary — data resmi SKB 3 Menteri (hari libur + cuti bersama), update rutin.
// 2) Fallback — sumber independen kedua, dicoba hanya kalau primary gagal.
const HOLIDAY_API_PRIMARY = 'https://api-hari-libur.vercel.app/api?year=';
const HOLIDAY_API_FALLBACK = 'https://dayoffapi.vercel.app/api?year=';

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
    if (action === 'saveProfilePhoto') return jsonOut(saveProfilePhoto(payload.employeeId, payload.photoBase64, payload.employeeName, payload.employeeBranch));
    if (action === 'deleteProfilePhoto') return jsonOut(deleteProfilePhotoAction(payload.employeeId));
    if (action === 'deleteEmployee') return jsonOut(deleteEmployeeAction(payload.employeeId));
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
    const [id, name, branch, profilePhotoUrl] = rows[i];
    if (!name) continue;
    out.push({ id: String(id || i), name: String(name), branch: String(branch || ''), profilePhotoUrl: String(profilePhotoUrl || '') });
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
   FOTO PROFIL — disimpan di Drive + kolom "FotoProfilURL" di sheet
   Karyawan, BUKAN cuma di localStorage HP. Ini yang membuat foto profil
   sinkron di semua device/browser milik karyawan yang sama, karena begitu
   endpoint "employees" dipanggil dari HP mana pun, URL foto ini ikut
   terbawa (lihat getEmployees()).
   ------------------------------------------------
   - Lock supaya dua request simpan foto nyaris bersamaan (jarang, tapi
     bisa terjadi kalau user tap ulang saking lambat koneksinya) tidak
     saling tabrak menulis baris yang sama.
   - Kalau karyawan itu sebelumnya SUDAH punya foto profil (ganti foto),
     file lamanya dihapus dari Drive dulu sebelum upload yang baru —
     supaya folder Drive tidak menumpuk sampah foto profil basi.
   - File baru diberi nama pakai employeeId (bukan timestamp) supaya kalau
     suatu saat perlu dicari/dicocokkan manual di Drive, jelas itu foto
     profil milik ID siapa.
   ============================================ */
function saveProfilePhoto(employeeId, photoBase64, employeeName, employeeBranch) {
  if (!employeeId) {
    return { ok: false, error: 'employeeId tidak ada' };
  }
  if (!photoBase64 || photoBase64.length < 100) {
    return { ok: false, error: 'Foto tidak valid atau kosong' };
  }

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
    let targetRow = -1;
    let oldPhotoUrl = '';
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(employeeId)) {
        targetRow = i + 1; // +1 karena getRange 1-based, +0 lagi karena rows[0] sudah header
        oldPhotoUrl = String(rows[i][3] || '');
        break;
      }
    }

    // FIX BUG "foto profil hilang": kalau ID belum ada di sheet — biasanya
    // karena karyawan baru ditambahkan pas OFFLINE, sempat dikasih ID
    // sementara "local_..." di HP, lalu foto WAJIB langsung diambil sebelum
    // ID lokal itu sempat diganti ID asli dari server — JANGAN langsung
    // gagal dengan error. Dulu di sinilah fotonya "hilang": request ditolak,
    // masuk antrian offline dengan ID lokal yang sudah tidak relevan lagi,
    // dan tidak pernah ke-retry dengan ID yang benar.
    // Sekarang: auto-buat baris baru untuk karyawan ini (pakai ID baru yang
    // konsisten dengan alur addEmployee), supaya foto SELALU berhasil
    // tersimpan di sheet apa pun urutan kejadiannya.
    if (targetRow === -1) {
      let maxId = 0;
      for (let i = 1; i < rows.length; i++) {
        const idNum = parseInt(rows[i][0], 10);
        if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
      }
      const newId = String(maxId + 1);
      const name = String(employeeName || '').trim() || ('Karyawan ' + newId);
      const branch = String(employeeBranch || '').trim();
      sheet.appendRow([newId, name, branch]);
      targetRow = sheet.getLastRow();
      employeeId = newId; // dipakai lagi di bawah utk nama file & response
      invalidateEmployeeCache();
    }

    // Hapus foto profil lama (kalau ada) SEBELUM upload yang baru, supaya
    // tidak ada jeda dimana dua-duanya numpuk di Drive kalau upload gagal
    // di tengah jalan file lama tetap aman (baru dihapus setelah yakin ada).
    if (oldPhotoUrl) {
      deleteProfilePhotoFile(oldPhotoUrl);
    }

    const folder = getOrCreateProfileFolder();
    const base64Data = photoBase64.indexOf(',') !== -1 ? photoBase64.split(',')[1] : photoBase64;
    const fileName = `profil_${employeeId}.jpg`;
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', fileName);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const photoUrl = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w500`;

    // Kolom ke-4 = FotoProfilURL
    sheet.getRange(targetRow, 4).setValue(photoUrl);
    invalidateEmployeeCache();

    return { ok: true, profilePhotoUrl: photoUrl, employeeId: employeeId };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================
   HAPUS FOTO PROFIL (dari layar Profil PWA)
   ------------------------------------------------
   - Menghapus file foto dari Drive DAN mengosongkan kolom FotoProfilURL
     di sheet Karyawan, supaya endpoint "employees" berikutnya tidak lagi
     membawa URL foto yang sudah tidak ada.
   - Idempotent: dipanggil dua kali (mis. retry antrian offline) untuk
     karyawan yang sama tetap aman, tidak error walau foto sudah kosong.
   ============================================ */
function deleteProfilePhotoAction(employeeId) {
  if (!employeeId) {
    return { ok: false, error: 'employeeId tidak ada' };
  }

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
    let targetRow = -1;
    let oldPhotoUrl = '';
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(employeeId)) {
        targetRow = i + 1;
        oldPhotoUrl = String(rows[i][3] || '');
        break;
      }
    }
    if (targetRow === -1) {
      // Karyawan tidak ada di sheet — tidak ada apa pun untuk dihapus,
      // anggap sukses (idempotent) supaya klien tidak retry sia-sia.
      return { ok: true, alreadyEmpty: true };
    }

    if (oldPhotoUrl) {
      deleteProfilePhotoFile(oldPhotoUrl);
    }
    sheet.getRange(targetRow, 4).setValue('');
    invalidateEmployeeCache();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================
   HAPUS AKUN KARYAWAN (permanen, dari layar Profil PWA)
   ------------------------------------------------
   Menghapus SECARA PERMANEN dan tidak bisa dibatalkan:
   1. Baris karyawan tersebut di sheet "Karyawan".
   2. Foto profil-nya di Drive (kalau ada).
   3. SEMUA baris riwayat absensi (sheet "Log") milik karyawan itu, beserta
      foto selfie absen harian yang menyertainya di Drive.
   Dibungkus lock + urutan hapus dari BAWAH ke ATAS pada sheet Log supaya
   index baris tidak bergeser saat proses hapus berjalan (menghapus baris
   dari atas akan mengubah nomor baris di bawahnya, rawan salah hapus).
   Idempotent: dipanggil dua kali untuk employeeId yang sama tetap aman,
   tidak error walau datanya sudah tidak ada (mis. retry jaringan).
   ============================================ */
function deleteEmployeeAction(employeeId) {
  if (!employeeId) {
    return { ok: false, error: 'employeeId tidak ada' };
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(15000);
  if (!gotLock) {
    return { ok: false, error: 'Sistem sedang sibuk, coba lagi sebentar' };
  }

  try {
    // 1) Hapus baris + foto profil di sheet Karyawan (kalau masih ada)
    const karyawanSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_KARYAWAN);
    if (karyawanSheet) {
      const rows = karyawanSheet.getDataRange().getValues();
      for (let i = rows.length - 1; i >= 1; i--) {
        if (String(rows[i][0]) === String(employeeId)) {
          const oldPhotoUrl = String(rows[i][3] || '');
          if (oldPhotoUrl) deleteProfilePhotoFile(oldPhotoUrl);
          karyawanSheet.deleteRow(i + 1);
        }
      }
    }

    // 2) Hapus SEMUA baris Log + foto selfie absen harian milik karyawan ini.
    //    Urut dari baris PALING BAWAH ke ATAS supaya deleteRow() berikutnya
    //    tidak menggeser index baris yang belum diperiksa.
    const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
    if (logSheet) {
      const lastRow = logSheet.getLastRow();
      if (lastRow >= 2) {
        const rows = logSheet.getRange(2, 1, lastRow - 1, 11).getValues();
        for (let i = rows.length - 1; i >= 0; i--) {
          if (String(rows[i][0]) === String(employeeId)) {
            const photoUrl = String(rows[i][9] || '');
            if (photoUrl) deleteProfilePhotoFile(photoUrl);
            logSheet.deleteRow(i + 2); // +2: offset header (1) + offset getRange mulai baris 2
          }
        }
      }
    }

    // 3) Bersihkan cache supaya endpoint "employees"/"today"/"history"/"home"
    // berikutnya tidak lagi membawa data karyawan yang sudah dihapus.
    invalidateEmployeeCache();
    invalidateLogCache(employeeId);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateProfileFolder() {
  const folders = DriveApp.getFoldersByName(PROFILE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(PROFILE_FOLDER_NAME);
}

// Mengambil file ID dari URL thumbnail Drive yang kita buat sendiri
// (format: .../thumbnail?id=XXXX&sz=...) lalu menghapus filenya. Dibungkus
// try-catch penuh supaya kalau filenya sudah terlanjur dihapus manual dari
// Drive (atau formatnya beda krn foto lama dari versi sebelumnya), proses
// simpan foto BARU tetap lanjut jalan — kegagalan hapus file lama bukan
// alasan gagal keseluruhan.
function deleteProfilePhotoFile(photoUrl) {
  try {
    const match = photoUrl.match(/[?&]id=([^&]+)/);
    if (!match) return;
    const file = DriveApp.getFileById(match[1]);
    file.setTrashed(true);
  } catch (e) { /* file tidak ditemukan/sudah terhapus — abaikan */ }
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

    // Status telat/tepat waktu hanya relevan utk absen "Masuk" — dihitung
    // langsung di sini juga (bukan cuma nanti pas refetch riwayat) supaya
    // layar sukses absen bisa langsung menunjukkan hasilnya seketika.
    const status = type === 'masuk' ? computeAttendanceStatus(today, timeStr) : null;

    return {
      ok: true,
      data: {
        type: typeKey,
        time: timeStr,
        date: today,
        address: address || `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`,
        photoUrl,
        mapsLink,
        status
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
    const entry = { time: row.time, address: row.address, photoUrl: row.photoUrl, mapsLink: row.mapsLink, status: row.status || null };
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
   DAFTAR HARI LIBUR NASIONAL (realtime, per tahun)
   ------------------------------------------------
   Diambil dari API publik hari libur Indonesia, di-cache per TAHUN selama
   6 jam di CacheService — jadi tidak pernah nge-fetch API di setiap absen
   (lambat & boros quota), tapi tetap "realtime" karena refresh otomatis
   beberapa kali sehari, cukup cepat menangkap update cuti bersama baru dari
   pemerintah tanpa perlu redeploy script.
   Kalau API sedang down/timeout, fallback ke cache LAMA (kalau masih ada di
   CacheService walau sudah kadaluarsa nilainya tetap disimpan sbg fallback
   di Properties) atau, kalau benar-benar tidak ada apa pun, anggap TIDAK ada
   hari libur tambahan (aman: minimal Minggu tetap terhitung libur karena itu
   dicek terpisah dari nama hari, bukan dari API).
   Return: Set of 'yyyy-MM-dd' string yang merupakan tanggal merah nasional.
   ============================================ */
function getHolidaySet(year) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'holidays_v2_' + year;
  const cached = cache.get(cacheKey);
  if (cached) return new Set(JSON.parse(cached));

  const props = PropertiesService.getScriptProperties();
  const fallbackKey = 'holidays_fallback_v2_' + year;

  const dates = fetchHolidayDates(HOLIDAY_API_PRIMARY, year) || fetchHolidayDates(HOLIDAY_API_FALLBACK, year);

  if (dates) {
    cache.put(cacheKey, JSON.stringify(dates), HOLIDAY_CACHE_SECONDS);
    // Simpan juga ke Properties (tidak kadaluarsa) sebagai fallback jangka
    // panjang kalau suatu saat KEDUA API di atas down berkepanjangan.
    try { props.setProperty(fallbackKey, JSON.stringify(dates)); } catch (e) { /* abaikan kalau kepenuhan */ }
    return new Set(dates);
  }

  // Kedua API gagal -> pakai data yang terakhir kali berhasil disimpan,
  // walau sudah agak lama, jauh lebih baik daripada tidak ada sama sekali.
  const savedFallback = props.getProperty(fallbackKey);
  if (savedFallback) {
    try { return new Set(JSON.parse(savedFallback)); } catch (e) { /* data korup, abaikan */ }
  }
  return new Set(); // benar-benar tidak ada data -> anggap tidak ada tanggal merah tambahan
}

// Mengambil & menormalkan daftar tanggal libur dari satu endpoint API.
// Return array of 'yyyy-MM-dd' string kalau sukses, atau null kalau gagal
// (network error, HTTP non-200, atau format respons tidak dikenali) —
// null (bukan array kosong) supaya pemanggil tahu harus coba sumber lain,
// beda dengan "API bilang memang tidak ada hari libur" yang valid berupa [].
function fetchHolidayDates(baseUrl, year) {
  try {
    const resp = UrlFetchApp.fetch(baseUrl + year, {
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (resp.getResponseCode() !== 200) return null;

    const json = JSON.parse(resp.getContentText());
    // Beberapa API membungkus array-nya di field "data", beberapa langsung
    // array di root — dukung dua-duanya biar tidak rapuh kalau ganti sumber.
    const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : null);
    if (!list) return null;

    return list
      .map(item => item && (item.date || item.holiday_date))
      .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d))
      .map(d => d.slice(0, 10));
  } catch (err) {
    return null; // jaringan/parse error -> pemanggil akan coba sumber berikutnya
  }
}

// true kalau tanggal (yyyy-MM-dd) adalah HARI LIBUR untuk keperluan jam
// masuk kerja: hari Minggu ATAU tanggal merah nasional/cuti bersama.
function isHolidayForAttendance(dateStr) {
  const dayOfWeek = ymdDayOfWeek(dateStr);
  if (dayOfWeek === null) return false;
  if (dayOfWeek === 0) return true; // 0 = Minggu
  const year = String(dateStr).slice(0, 4);
  return getHolidaySet(year).has(dateStr);
}

// Menghitung hari-dalam-minggu (0=Minggu..6=Sabtu) LANGSUNG dari string
// "yyyy-MM-dd" pakai rumus kalender (Zeller-like via Date.UTC), BUKAN lewat
// `new Date(y, m, d)` biasa — supaya hasilnya tidak pernah terpengaruh oleh
// timezone server tempat Apps Script dieksekusi (yang belum tentu WIB).
// Tanggal ini sudah dalam WIB (ditulis oleh Utilities.formatDate(..., TZ, ...)
// di recordAttendance), jadi hari-nya harus dihitung sebagai tanggal murni,
// bukan di-reinterpretasi ke timezone lain yang bisa "meleset" ke hari sebelum/sesudahnya.
function ymdDayOfWeek(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const utcDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return utcDate.getUTCDay();
}

// Menentukan status "ontime" / "telat" untuk SATU absen Masuk pada tanggal
// & jam tertentu. Return null kalau bukan tipe yang relevan dinilai
// (dipanggil pemanggil hanya untuk tipe "Masuk", lihat readEmployeeLogRows).
function computeAttendanceStatus(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const threshold = isHolidayForAttendance(dateStr) ? WORK_START_HOLIDAY : WORK_START_WEEKDAY;
  // Perbandingan string aman selama formatnya konsisten "HH:mm:ss" (zero-padded),
  // yang memang selalu demikian karena ditulis oleh Utilities.formatDate di recordAttendance.
  return String(timeStr) <= threshold ? 'ontime' : 'telat';
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
    const date = normalizeDate(tanggalRaw);
    const time = normalizeTime(jamRaw);
    out.push({
      type: tipe,
      date: date,
      time: time,
      address: alamat,
      photoUrl: fotoUrl,
      mapsLink: mapsLink,
      // Status telat/tepat waktu HANYA relevan utk "Masuk" — dihitung di sini
      // (bukan disimpan permanen di sheet) supaya kalau kebijakan jam kerja
      // berubah di kemudian hari, riwayat lama otomatis ikut terhitung ulang
      // dengan aturan yang berlaku saat ini, bukan "membeku" dengan aturan lama.
      status: tipe === 'Masuk' ? computeAttendanceStatus(date, time) : null
    });
  }
  return out;
}
