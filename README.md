# RT TBK — Aplikasi Administrasi RT

Aplikasi web/PWA untuk Ketua RT dan warga. Fitur utama meliputi login, data warga dan keluarga, dashboard, kas RT, iuran, pembayaran QRIS, pengajuan surat, pengaduan, pengumuman, aspirasi warga, serta akses melalui HP.

## Konfigurasi wajib

Atur variabel berikut melalui pengaturan Environment Variables pada layanan hosting. Jangan menaruh nilai rahasia di dalam kode atau repository.

- `SUPABASE_URL`: URL proyek Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role key Supabase. Kunci ini bersifat rahasia dan hanya boleh digunakan di server.
- `SESSION_SECRET`: rahasia acak yang kuat untuk menandatangani sesi. Gunakan minimal 32 byte acak.
- `ADMIN_PASSWORD`: password Ketua RT. Wajib diisi; aplikasi tidak menyediakan password admin bawaan.
- `ADMIN_USER`: nama pengguna Ketua RT; jika tidak diatur, nilainya `admin`.

## Pembayaran QRIS Midtrans

- Mode Sandbox menggunakan `MIDTRANS_SERVER_KEY` (atau `MIDTRANS_SANDBOX_SERVER_KEY`).
- Mode produksi hanya aktif jika `MIDTRANS_IS_PRODUCTION=true` dan menggunakan `MIDTRANS_PRODUCTION_SERVER_KEY`.
- Jangan mengaktifkan mode produksi sebelum kredensial resmi tersedia, URL webhook sudah terdaftar di dashboard Midtrans, serta transaksi uji dan rekonsiliasi sudah diverifikasi. Jangan pernah menaruh Server Key di kode atau membagikannya kepada warga.
- Kunci Sandbox tidak digunakan sebagai pengganti kunci produksi.

## Menjalankan aplikasi

```bash
npm install
npm start
```

Aplikasi membutuhkan koneksi Supabase dan variabel lingkungan yang disebutkan di atas. Endpoint pemeriksaan kesehatan tersedia di `/health`.

## Keamanan

- Password warga baru disimpan menggunakan hash scrypt dengan salt acak.
- Sesi ditandatangani dengan HMAC dan cookie HttpOnly, Secure, serta SameSite=Lax.
- Tabel warga dan keuangan tidak dibuka untuk akses langsung peran `anon` atau `authenticated`; aplikasi mengakses data melalui server.
- Jangan membagikan `SUPABASE_SERVICE_ROLE_KEY`, `MIDTRANS_SERVER_KEY`, `MIDTRANS_PRODUCTION_SERVER_KEY`, atau `SESSION_SECRET`. Jika pernah terekspos, segera rotasi melalui dashboard penyedia layanan.

## Pemeriksaan kode

GitHub Actions memeriksa sintaks file JavaScript, konfigurasi, dan pengujian otomatis setiap kali ada perubahan pada repository atau pull request.


## Arsip KK dan KTP (fitur baru)

- Menu Ketua RT: **Arsip KK & KTP**.
- Satu keluarga dapat menyimpan satu scan KK dan beberapa scan KTP anggota keluarga.
- Dokumen disimpan di bucket Supabase Storage **private** `dokumen-identitas`; browser tidak menerima service-role key.
- Unggahan memakai signed upload URL langsung ke Supabase Storage agar file tidak melewati batas ukuran request serverless Vercel.
- File yang didukung: JPG, PNG, WebP, PDF; maksimal 8 MB per file; maksimal 20 file KTP per pengiriman.
- Gambar dapat dibaca OCR di browser menggunakan Tesseract.js Bahasa Indonesia + Inggris. PDF disimpan dan dapat dicetak, tetapi OCR otomatis PDF belum diaktifkan.
- OCR hanya menghasilkan teks/kandidat NIK. Ketua RT wajib mencocokkan data dengan dokumen asli; sistem tidak melakukan validasi Dukcapil dan tidak otomatis membuat/mengubah data warga.
- Tombol **Lihat / Cetak** membuka dokumen asli melalui tautan bertanda tangan yang berlaku 5 menit. Tombol **Cetak Salinan Data Keluarga** membuat PDF administratif dari database warga, bukan dokumen identitas resmi.
- Migrasi: `supabase/migrations/20261111063759_create_private_resident_identity_documents.sql`.
