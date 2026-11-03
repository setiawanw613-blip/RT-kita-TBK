# Membuat RT Kita Online dengan Render

Aplikasi menggunakan Supabase untuk database dan penyimpanan file. Karena itu, aplikasi tidak membutuhkan persistent disk Render untuk menyimpan database.

## Pengaturan satu kali

1. Pastikan repository GitHub RT Kita terhubung ke akun Render.
2. Di Render pilih **New > Web Service**, lalu pilih repository.
3. Render membaca konfigurasi dari `render.yaml`.
4. Isi variabel rahasia yang diminta di pengaturan Environment:
   - `SUPABASE_URL`: URL proyek Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service-role key Supabase.
   - `ADMIN_PASSWORD`: password baru untuk Ketua RT.
   - `MIDTRANS_SERVER_KEY`: server key Midtrans Sandbox jika fitur QRIS digunakan.
5. `SESSION_SECRET` dibuat otomatis oleh konfigurasi Render. `ADMIN_USER` menggunakan nilai `admin` jika tidak diubah.
6. Tunggu proses deploy selesai, lalu buka alamat `*.onrender.com` dari HP.
7. Untuk memasang aplikasi, pilih **Add to Home Screen** dari menu browser.

## Keamanan penting

- Tidak ada akun atau password admin bawaan. Jangan gunakan password `admin123`.
- Jangan menaruh service-role key, password admin, atau server key Midtrans di file kode maupun repository.
- Gunakan HTTPS. Render menyediakan HTTPS untuk alamat web service.
- Aplikasi ini saat ini menggunakan Midtrans Sandbox; mode produksi belum diaktifkan.

## Catatan biaya

Database dan file disimpan di Supabase, bukan di disk lokal Render. Dengan demikian, konfigurasi aplikasi tidak meminta persistent disk berbayar. Paket gratis hosting dapat memiliki batas penggunaan, waktu tidur layanan, atau perubahan kebijakan; periksa ketentuan Render terbaru sebelum digunakan.
