# Absen — PWA Absensi Selfie + GPS untuk Sales Freelance

Aplikasi absensi berbasis PWA (installable di HP, tanpa perlu App Store) dengan foto selfie
dan lokasi GPS akurat (auto reverse-geocode ke alamat + link Google Maps), untuk absen masuk
dan absen keluar. Data tersimpan otomatis ke Google Sheets, foto ke Google Drive.

## Isi folder
```
index.html      → struktur halaman (semua screen dalam 1 file: login, home, kamera, preview, sukses, riwayat)
style.css       → desain visual (dark, tema field-survey, hijau teknikal)
app.js          → seluruh logic: GPS, kamera, capture, submit, riwayat
config.js       → satu-satunya file yang perlu kamu EDIT (isi URL backend)
manifest.json   → metadata PWA (nama app, ikon, warna)
sw.js           → service worker (bikin app installable & buka cepat)
icons/          → ikon app (192px, 512px, + versi maskable utk Android adaptive icon)
Code.gs         → backend Google Apps Script (taruh di Google Sheets, BUKAN di folder web hosting)
```

## Langkah setup (± 10 menit)

### 1. Siapkan Google Sheet sebagai database
1. Buka https://sheet.new → beri nama misalnya **"Absen DB"**.
2. Buat 2 tab (klik tanda `+` di kiri bawah), beri nama **persis**:
   - `Karyawan` → isi kolom A: ID, B: Nama, C: Cabang (baris 1 boleh header)
     ```
     ID    Nama              Cabang
     1     Budi Santoso      Pekanbaru
     2     Siti Aminah       Duri
     ```
   - `Log` → biarkan kosong, akan terisi otomatis oleh script. Opsional isi header di baris 1:
     ```
     ID | Nama | Tipe | Tanggal | Jam | Lat | Lng | Akurasi | Alamat | FotoURL | MapsLink
     ```

### 2. Deploy backend (Apps Script)
1. Di Google Sheet tadi: menu **Extensions → Apps Script**.
2. Hapus semua isi default, **paste isi file `Code.gs`**.
3. Klik **Deploy → New deployment**.
4. Pilih tipe **Web app**. Set:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Klik **Deploy**, izinkan akses (klik akun Google kamu → Advanced → Go to project (unsafe) →
   Allow — ini normal karena script belum diverifikasi Google, tapi ini punyamu sendiri, aman).
6. Copy **Web app URL** yang muncul (formatnya `https://script.google.com/macros/s/xxxxx/exec`).

### 3. Hubungkan frontend ke backend
Buka `config.js`, ganti baris:
```js
APPS_SCRIPT_URL: 'GANTI_DENGAN_URL_WEB_APP_APPS_SCRIPT',
```
dengan URL yang kamu copy tadi.

### 4. Hosting PWA
Upload semua file **kecuali `Code.gs` dan `gen_icons.py`** ke hosting statis apa pun:
- **GitHub Pages** (gratis, direkomendasikan): buat repo baru → upload semua file → Settings →
  Pages → aktifkan dari branch `main` folder root.
- Alternatif: Netlify, Vercel, Firebase Hosting — tinggal drag & drop folder ini.

**Wajib HTTPS** — kamera & GPS di browser hanya jalan di HTTPS (atau localhost). Semua opsi
hosting di atas otomatis HTTPS.

### 5. Install di HP karyawan
1. Buka link hosting-nya via Chrome (Android) atau Safari (iOS).
2. Android: akan muncul prompt "Tambahkan ke layar utama" / tap menu (⋮) → **Install app**.
3. iOS Safari: tap tombol **Share** → **Add to Home Screen**.
4. Icon app akan muncul di home screen seperti aplikasi native, full-screen tanpa address bar.

## Cara kerja fitur lokasi akurat
- Menggunakan `navigator.geolocation.watchPosition` dengan `enableHighAccuracy: true`.
- Panel GPS di layar kamera menunjukkan status real-time: mencari sinyal → akurasi (meter) →
  "Lokasi terkunci" saat akurasi ≤ 100m (bisa diubah di `config.js` → `GPS_ACCURACY_THRESHOLD`).
  Kalau setelah 12 detik akurasi masih rendah (misal di dalam gedung), tombol foto tetap
  diaktifkan supaya karyawan tidak stuck — lebih baik absen dengan akurasi menengah daripada
  tidak bisa absen sama sekali.
- Reverse-geocode (ubah koordinat jadi nama jalan) dibuat berlapis dan cepat, tanpa API key:
  1. **Cache lokal** — lokasi yang pernah dikunjungi (radius ±11m) langsung tampil instan dari
     HP, tanpa nunggu jaringan sama sekali.
  2. **Nominatim (OpenStreetMap)** — provider utama, detail nama jalan paling baik untuk
     Indonesia, dengan timeout ketat 5 detik.
  3. **BigDataCloud** — backup otomatis kalau Nominatim lambat/limit, tanpa API key juga.
  4. Kalau kedua provider gagal, koordinat GPS mentah tetap ditampilkan — **absen tidak pernah
     terblokir** hanya karena nama jalan gagal dimuat.
  Proses geocoding dipicu di titik GPS **pertama** yang masuk (bukan menunggu status
  "terkunci"), lalu diperbarui lagi kalau akurasi membaik signifikan — inilah yang membuat
  alamat tidak lagi terasa lama muncul.
- Foto, koordinat, akurasi, alamat, dan waktu capture semuanya dikunci bersamaan saat user
  menekan tombol shutter — tidak bisa foto duluan lalu ambil lokasi belakangan.
- Setiap absen otomatis dapat link Google Maps langsung ke titik itu (bisa dibuka admin dari
  Sheet atau dari halaman Riwayat di app).

## Kenapa upload absen sekarang jauh lebih cepat
- Foto dikompres ke maksimum 720px dengan kualitas JPEG 72% (bisa diubah di `config.js` →
  `PHOTO_MAX_DIMENSION` / `PHOTO_QUALITY`) — cukup jelas untuk verifikasi wajah, tapi ukuran
  file jauh lebih kecil (±60-120KB) sehingga proses kirim ke Apps Script + Drive jadi jauh
  lebih ringan, terutama di jaringan seluler yang lemah.
- Backend (`Code.gs`) memakai `LockService` supaya tidak ada proses tabrakan, dan cache
  singkat untuk daftar karyawan supaya layar login selalu terasa instan.
- **Antrian offline**: kalau saat submit ternyata tidak ada koneksi (atau koneksi terputus di
  tengah jalan), absen (foto + lokasi) **tidak hilang** — otomatis disimpan di HP dan dikirim
  ulang otomatis begitu koneksi kembali, baik saat app dibuka lagi maupun saat event "online"
  terdeteksi browser.
- Percobaan kirim otomatis diulang (retry) sampai 2x sebelum dianggap gagal karena jaringan.

## Kustomisasi cepat
| Yang mau diubah | Dimana |
|---|---|
| Nama perusahaan, ambang akurasi GPS | `config.js` |
| Warna, font, ukuran tombol | `style.css` bagian `:root` (design tokens di paling atas) |
| Logo/icon app | Ganti file di `icons/` (ukuran sama: 192x192 & 512x512) |
| Radius toleransi lokasi kantor tertentu (geofence) | Belum ada — bisa ditambahkan kalau perlu |

## Catatan keamanan & operasional
- Karena tanpa password (sesuai kebutuhan), siapa pun yang pegang HP bisa pilih nama siapa saja.
  Kalau ke depan perlu PIN sederhana per karyawan, kasih tahu saya, gampang ditambahkan.
- Foto tersimpan di Google Drive akun kamu dengan sharing "Anyone with link – view only" supaya
  bisa ditampilkan di riwayat & sheet; tidak public/searchable.
- Google Apps Script Web App gratis punya kuota (± beberapa ribu request/hari untuk akun biasa),
  lebih dari cukup untuk tim sales freelance skala puluhan orang absen 2x/hari.
