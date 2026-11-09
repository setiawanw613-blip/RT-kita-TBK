# Catatan migrasi database RT TBK

Dokumen ini mencatat hasil rekonsiliasi baca-saja pada proyek Supabase produksi tanggal 9 November 2026.

## Kondisi yang teramati

- Riwayat migrasi Supabase produksi mencatat 11 versi.
- Direktori `supabase/migrations/` pada branch `main` hanya berisi 7 file SQL.
- Empat versi yang tercatat di produksi tetapi file sumbernya tidak ditemukan pada branch `main`:
  - `20261105095208_add_staff_roles_and_gang_qris_attribution`
  - `20261105100729_atomic_gang_qris_setoran_attribution`
  - `20261105102602_link_rt_officers_to_existing_residents`
  - `20261105102637_auto_link_staff_to_existing_resident`

## Aturan keselamatan

1. Jangan menjalankan ulang empat migrasi tersebut berdasarkan nama atau dugaan isi SQL.
2. Jangan menghapus atau mengubah baris riwayat migrasi Supabase produksi untuk menyamakan hitungan.
3. Jangan membuat file SQL tiruan yang hanya berisi `IF NOT EXISTS` atau komentar untuk menggantikan migrasi asli.
4. Pulihkan isi SQL asli dari commit/backup/arsip penerapan yang tepercaya, kemudian cocokkan dengan definisi tabel, indeks, trigger, function, dan constraint produksi.
5. Setelah sumber asli dipulihkan, lakukan pemeriksaan diff schema di lingkungan non-produksi sebelum menyinkronkan repository.
6. Pertahankan data warga, iuran, kas, surat, aspirasi, dan objek Storage yang sudah ada.

## Keamanan yang teramati

Semua 11 tabel publik yang diperiksa memiliki Row Level Security aktif dan tidak ada policy tabel publik. Ini sesuai pola aplikasi saat ini yang mengakses database melalui server menggunakan service-role key, sementara grant langsung untuk role `anon` dan `authenticated` dicabut. Jangan menambahkan policy publik hanya untuk menghilangkan temuan INFO dari Supabase Advisor.

## Temuan yang tidak boleh otomatis dibersihkan

- Supabase Advisor menandai 5 indeks sebagai belum pernah digunakan. Ini informasi statistik, bukan bukti bahwa indeks aman dihapus.
- Ditemukan 10 objek di bucket `bukti-pengeluaran`, sementara 6 baris kas saat audit tidak memiliki `bukti_path`. Jangan hapus objek tersebut sebelum rekonsiliasi manual membuktikan bahwa semuanya yatim dan tidak diperlukan sebagai arsip.
- Data uji/produksi yang sudah ada harus dipertahankan; audit tidak boleh membuat transaksi palsu untuk menguji alur kas.

## Pengujian yang masih memerlukan kondisi nyata

- Pengujian end-to-end pembayaran Midtrans Sandbox dan callback webhook.
- Pengujian unduh surat dari perangkat warga.
- Pengujian pencatatan pengeluaran dengan bukti foto yang sah.
- Pengujian akun bendahara, sekretaris, dan ketua gang dengan identitas serta wilayah yang telah ditetapkan pengurus.
