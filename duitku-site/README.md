# Website Pembayaran RT TBK — Duitku Sandbox

Paket website PHP mandiri untuk kebutuhan verifikasi awal Duitku. Paket ini **hanya mengizinkan Sandbox**; tidak ada mode produksi dan tidak terhubung ke tabel iuran warga RT TBK. Transaksi di sini adalah simulasi checkout untuk pengujian merchant, bukan bukti pembayaran iuran warga.

## Fitur
- Profil layanan pengelolaan iuran RT 004/RW 01 – Taman Bali Kahuripan.
- Informasi layanan dan kontak yang diambil dari konfigurasi.
- Checkout simulasi nominal tetap Rp35.000 dalam Rupiah.
- Create Invoice melalui Duitku POP API Sandbox.
- Redirect ke halaman pembayaran Duitku.
- Callback server-to-server dengan verifikasi HMAC-SHA256, validasi merchant, nominal, dan order ID.
- Penyimpanan status dan referensi transaksi Duitku pada MySQL.
- Halaman kembali hanya membaca status database; parameter redirect browser tidak pernah dianggap bukti lunas.

## Persyaratan hosting
- PHP 8.1 atau lebih baru.
- Ekstensi PHP: cURL, PDO, PDO MySQL, OpenSSL, JSON.
- MySQL/MariaDB.
- Domain/subdomain publik dengan HTTPS aktif.
- Outbound HTTPS ke `api-sandbox.duitku.com` dan inbound HTTPS callback Duitku.
- Hosting mandiri/cPanel atau VPS yang dapat menjalankan PHP dan MySQL.

## Struktur deploy
- Isi folder `public/` menjadi document root subdomain (misalnya `bayar.domain-RT-anda`).
- Folder `app/` harus diletakkan di luar document root agar konfigurasi dan kode internal tidak dapat diunduh publik.
- Salin `app/config.example.php` menjadi `app/config.php`, lalu isi konfigurasi lokal.
- Jalankan `database/schema.sql` pada database MySQL.
- Atur path absolut `RTTBK_APP_PATH` di environment hosting agar menunjuk ke folder `app/`. Jika hosting tidak mendukung environment variable, sesuaikan satu baris di `public/_bootstrap.php` dan jangan simpan `app/` di dalam document root.
- Jangan pernah mengunggah `config.php` ke GitHub.

## Konfigurasi
Isi `app/config.php`:
- Kredensial Sandbox `DUITKU_MERCHANT_CODE` dan `DUITKU_API_KEY`.
- URL website HTTPS `SITE_BASE_URL`.
- Nama pengelola, area layanan, alamat sekretariat/area kerja, telepon, dan email resmi.
- Detail MySQL.

Kredensial merchant harus diperoleh dari proyek Sandbox Duitku. Jangan memakai kredensial produksi pada paket ini.

## URL callback
Setelah subdomain aktif, callback yang didaftarkan/dikirim pada invoice adalah:
`https://SUBDOMAIN-ANDA/callback.php`

Return URL:
`https://SUBDOMAIN-ANDA/return.php`

Duitku callback menggunakan POST `application/x-www-form-urlencoded`. Website memverifikasi:
`HMAC_SHA256(merchantCode + amount + merchantOrderId, apiKey)`.
Status hanya berubah menjadi paid setelah signature valid, merchant code cocok, order ada, nominal cocok, dan resultCode = `00`.

## Langkah uji
1. Pasang website pada hosting mandiri dan aktifkan HTTPS.
2. Isi kredensial Sandbox dari Duitku.
3. Buka halaman utama, lalu buat simulasi checkout.
4. Selesaikan transaksi dengan kanal/metode uji yang disediakan Duitku.
5. Pastikan callback diterima dan halaman kembali menampilkan status dari database.
6. Periksa nomor order dan reference Duitku pada tabel `duitku_sandbox_orders`.

Dokumentasi resmi:
- POP API: https://docs.duitku.com/pop/id/
- Create Invoice: https://docs.duitku.com/pop/id/#create-invoice
- Callback: https://docs.duitku.com/pop/id/#callback
- Uji coba: https://docs.duitku.com/pop/id/#uji-coba

## Batasan yang disengaja
- Tidak ada kredensial Duitku di repository.
- Tidak ada transaksi produksi.
- Tidak mengubah saldo kas, status iuran, atau data warga RT TBK.
- Integrasi sinkronisasi pembayaran ke aplikasi RT TBK baru boleh ditambahkan setelah merchant disetujui, kredensial produksi resmi tersedia, dan rancangan sinkronisasi ditinjau.
