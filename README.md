# RT Kita — Aplikasi Administrasi RT

Aplikasi web/PWA untuk Ketua RT dan warga. Fitur utama meliputi login, data warga dan keluarga, dashboard, kas RT, iuran, pembayaran QRIS, pengajuan surat, pengaduan, pengumuman, aspirasi warga, serta akses melalui HP.

## Konfigurasi wajib

Atur variabel berikut melalui pengaturan Environment Variables pada layanan hosting. Jangan menaruh nilai rahasia di dalam kode atau repository.

- `SUPABASE_URL`: URL proyek Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role key Supabase. Kunci ini bersifat rahasia dan hanya boleh digunakan di server.
- `SESSION_SECRET`: rahasia acak yang kuat untuk menandatangani sesi. Gunakan minimal 32 byte acak.
- `ADMIN_PASSWORD`: password Ketua RT. Wajib diisi; aplikasi tidak menyediakan password admin bawaan.
- `ADMIN_USER`: nama pengguna Ketua RT; jika tidak diatur, nilainya `admin`.

Untuk pembayaran QRIS Sandbox, atur `MIDTRANS_SERVER_KEY`. Aplikasi saat ini menolak mode produksi Midtrans; jangan mengatur `MIDTRANS_IS_PRODUCTION=true` sebelum alur produksi disiapkan dan diuji.

## Menjalankan aplikasi

```bash
npm install
npm start
```

Aplikasi membutuhkan koneksi Supabase dan variabel lingkungan yang disebutkan di atas. Endpoint pemeriksaan kesehatan tersedia di `/health`.

## Keamanan

- Password warga baru disimpan menggunakan hash scrypt dengan salt acak.
- Sesi ditandatangani dengan HMAC dan cookie HttpOnly, Secure, serta SameSite=Lax.
- Jangan membagikan `SUPABASE_SERVICE_ROLE_KEY`, `MIDTRANS_SERVER_KEY`, atau `SESSION_SECRET`.
- Jika sebelumnya pernah membagikan kunci rahasia di tempat umum, segera rotasi kunci tersebut melalui dashboard penyedia layanan.
