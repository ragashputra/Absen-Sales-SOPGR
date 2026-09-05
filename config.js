// ====== KONFIGURASI ABSEN ======
// Ganti dengan Web App URL dari deployment Google Apps Script kamu.
// Selama masih 'GANTI_DENGAN_URL_WEB_APP_APPS_SCRIPT' (atau kalau request ke
// backend gagal/offline), app otomatis pakai EMPLOYEES di bawah ini sebagai
// daftar nama — jadi app tetap bisa dipakai penuh walau backend belum siap.
const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwCMdNnq60rkzt0Fz2UbR3xUXFndKpm6gDVv1uifkyMfoG9E4Mc0Z6ZIwgj1jRrvmepIA/exec',
  APP_NAME: 'Absen',
  COMPANY_NAME: 'PT Capella Dinamik Nusantara',
  TIMEZONE: 'Asia/Jakarta', // WIB — dipakai untuk semua tampilan jam/tanggal di app

  // ---- GPS ----
  GPS_ACCURACY_THRESHOLD: 100, // meter — di atas ini dianggap kurang akurat
  GPS_ACCURACY_GOOD: 30,       // meter — di bawah ini dianggap "sangat akurat" (badge hijau penuh)
  GPS_TIMEOUT: 15000,          // ms — per attempt watchPosition
  GPS_MAX_AGE: 0,
  GPS_MAX_WAIT: 12000,         // ms — batas maksimum nunggu sebelum tombol shutter dipaksa aktif walau akurasi belum ideal

  // ---- Reverse geocoding (alamat dari koordinat) ----
  // Dua provider gratis dipakai berlapis (tanpa API key, tanpa biaya):
  // 1) Nominatim (OpenStreetMap) — paling detail nama jalannya di Indonesia.
  // 2) BigDataCloud client-reverse-geocode — backup kalau Nominatim lambat/limit,
  //    lebih longgar rate-limit-nya.
  // Alamat yang sama (dibulatkan ~10m) di-cache di HP supaya lokasi yang dikunjungi
  // berulang (kantor, rumah karyawan) langsung tampil instan tanpa nunggu jaringan.
  GEOCODE_TIMEOUT: 5000,       // ms per provider sebelum dianggap gagal & lanjut ke provider berikutnya
  GEOCODE_CACHE_PRECISION: 4,  // jumlah desimal koordinat untuk kunci cache (~11m)
  GEOCODE_CACHE_MAX_ENTRIES: 200,
  GEOCODE_CACHE_TTL_DAYS: 30,

  // ---- Foto ----
  PHOTO_MAX_DIMENSION: 720,    // px — cukup jelas untuk verifikasi wajah, jauh lebih ringan & cepat upload
  PHOTO_QUALITY: 0.72,         // kualitas JPEG (0-1) — dipilih agar file ±60-120KB, upload cepat di jaringan lemah
  UPLOAD_TIMEOUT: 25000,       // ms sebelum submit dianggap timeout & bisa di-retry
  UPLOAD_MAX_RETRY: 2,         // percobaan ulang otomatis kalau gagal karena jaringan

  // Daftar karyawan default (dipakai kalau backend Apps Script belum di-setup
  // atau sedang tidak terjangkau). Begitu backend aktif dan mengembalikan
  // daftar karyawan, app akan pakai data dari Sheets sebagai prioritas utama.
  EMPLOYEES: [
    { id: '1', name: 'Vebi Rahmatullah', branch: 'PT Capella Dinamik Nusantara' },
    { id: '2', name: 'Maria Mahdalena Wijayanti', branch: 'PT Capella Dinamik Nusantara' },
    { id: '3', name: 'Rosmauli Sihombing', branch: 'PT Capella Dinamik Nusantara' },
    { id: '4', name: 'Rosmauli Gurning', branch: 'PT Capella Dinamik Nusantara' },
    { id: '5', name: 'Citra Adek Melani', branch: 'PT Capella Dinamik Nusantara' },
    { id: '6', name: 'Klaransia Nainggolan', branch: 'PT Capella Dinamik Nusantara' }
  ]
};
