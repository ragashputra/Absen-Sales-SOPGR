// ====== KONFIGURASI ABSEN ======
// Ganti dengan Web App URL dari deployment Google Apps Script kamu.
// Selama masih 'GANTI_DENGAN_URL_WEB_APP_APPS_SCRIPT' (atau kalau request ke
// backend gagal/offline), app otomatis pakai EMPLOYEES di bawah ini sebagai
// daftar nama — jadi app tetap bisa dipakai penuh walau backend belum siap.
const CONFIG = {
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwCMdNnq60rkzt0Fz2UbR3xUXFndKpm6gDVv1uifkyMfoG9E4Mc0Z6ZIwgj1jRrvmepIA/exec',
  APP_NAME: 'Absen',
  COMPANY_NAME: 'PT Capella Dinamik Nusantara',
  GPS_ACCURACY_THRESHOLD: 100, // meter — di atas ini dianggap kurang akurat
  GPS_TIMEOUT: 20000,
  GPS_MAX_AGE: 0,

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
