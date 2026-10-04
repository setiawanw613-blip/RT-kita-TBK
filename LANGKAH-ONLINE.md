# Membuat RT Kita Online

Saya sudah menyiapkan konfigurasi Render di `render.yaml`.

## Yang perlu dilakukan satu kali oleh pemilik aplikasi

1. Buat akun GitHub dan akun Render.
2. Buat repository baru di GitHub, misalnya `rt-kita`.
3. Upload seluruh isi folder aplikasi ini ke repository tersebut.
4. Di Render pilih **New > Web Service** dan hubungkan repository.
5. Render dapat membaca `render.yaml` atau masukkan:
   - Build: `npm install`
   - Start: `npm start`
6. Pastikan persistent disk terpasang pada `/var/data`.
7. Setelah deploy selesai, Render memberikan alamat `*.onrender.com`.
8. Buka alamat tersebut dari HP dan pilih "Add to Home Screen" untuk memasangnya seperti aplikasi.

## Akun awal
Username: admin
Password: admin123

Segera ganti password admin setelah login pertama.

## Penting
Database berisi data pribadi. Jangan membagikan password admin. Untuk produksi, gunakan HTTPS (Render menyediakan TLS untuk web service).

## Catatan biaya
Ketersediaan dan batas paket hosting dapat berubah. Render mendukung Node/Express dan persistent disk, tetapi disk persisten memerlukan paket berbayar menurut dokumentasi Render saat ini.
