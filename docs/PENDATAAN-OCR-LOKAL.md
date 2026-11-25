# Rancangan Pendataan Warga dengan OCR Lokal

Status dokumen: rancangan persiapan; belum aktif di aplikasi produksi.

## Keputusan dan batasan

- OCR diproses secara lokal di browser/perangkat petugas RT. Foto KK/KTP tidak dikirim ke API OCR pihak ketiga.
- Data hasil OCR tidak langsung masuk ke tabel `warga` atau `keluarga`. Semua hasil masuk ke antrean pemeriksaan Ketua RT.
- Persetujuan petugas menjadi satu-satunya langkah yang boleh membuat data warga/keluarga baru.
- Sebelum persetujuan, sistem memeriksa NIK dan nomor KK untuk mencegah duplikasi. Jika NIK sudah terdaftar, sistem menolak membuat baris baru dan menawarkan pencocokan/review; tidak melakukan update otomatis.
- Foto dokumen harus disimpan di penyimpanan privat, bukan bucket publik, dengan akses khusus Ketua RT dan kebijakan penghapusan/retensi yang jelas.
- Jangan mencatat NIK/nomor KK lengkap pada log aplikasi, URL, notifikasi, atau pesan error.

## Alur utama yang disarankan di aplikasi RT TBK

1. Ketua RT membuka menu **Pendataan Warga (OCR)**.
2. Petugas memilih foto KK dan KTP. File dibatasi ke JPEG/PNG/WebP, ukuran dan jumlah dibatasi, lalu tipe file diperiksa dari isi file (bukan hanya ekstensi/MIME).
3. OCR berjalan di perangkat petugas menggunakan model bahasa Indonesia yang disimpan/di-host bersama aplikasi. Foto tidak dikirim ke penyedia OCR eksternal.
4. Sistem menampilkan hasil yang terbaca dan penanda keyakinan/kolom yang perlu diperiksa. OCR bukan bukti kebenaran data.
5. Petugas mengoreksi hasil dan menekan **Kirim untuk pemeriksaan**.
6. Server menyimpan pengajuan baru pada tabel antrean terpisah, bukan langsung ke `warga` atau `keluarga`.
7. Ketua RT memeriksa foto dan hasil ekstraksi. Tombol **Setujui dan daftarkan** membuat catatan baru setelah validasi duplikasi NIK/KK; tombol **Tolak** menutup pengajuan.
8. Pengajuan yang ditolak atau kedaluwarsa dihapus sesuai kebijakan retensi.

## Kolom OCR

### Dari KTP
- NIK (16 digit)
- Nama lengkap
- Tempat lahir
- Tanggal lahir
- Jenis kelamin
- Agama
- Status perkawinan
- Pekerjaan
- Kewarganegaraan

### Dari KK
- Nomor KK (16 digit)
- Nama kepala keluarga
- Alamat
- RT
- RW
- Desa/kelurahan
- Kecamatan
- Kabupaten/kota

Nilai RT/RW lingkungan dapat ditetapkan sebagai default wilayah RT 004/RW 01, tetapi harus ditampilkan agar petugas dapat mengoreksi. Jangan mengarang nilai yang tidak terbaca.

## Kesesuaian skema database saat ini

Tabel `public.warga` dan `public.keluarga` sudah memiliki kolom utama untuk identitas dan alamat, tetapi hasil inspeksi skema menemukan kolom `agama` belum tersedia pada `warga`. Penambahan kolom agama harus dilakukan sebagai migrasi aditif setelah seluruh form dan pemakaian kolom diperiksa. Jangan mengubah baris warga/keluarga yang sudah ada.

Rancangan antrean memerlukan tabel baru, misalnya `pendataan_warga_review`, dengan kolom minimal:
- id, status (menunggu/diperiksa/disetujui/ditolak)
- data_ocr JSONB yang sudah divalidasi bentuknya
- path dokumen privat (bukan URL publik)
- dibuat_oleh, diperiksa_oleh, dibuat_at, diperiksa_at
- catatan pemeriksaan

Tabel baru wajib RLS aktif tanpa akses langsung `anon`/warga; akses melalui endpoint server yang memeriksa sesi Ketua RT. File bucket harus privat. Rancangan ini belum membuat tabel, bucket, atau mengubah database.

## Google Form dan Google Sheets

Google Forms tidak menyediakan OCR lokal yang otomatis mengisi jawaban pada formulir ketika gambar diunggah. Fitur upload Forms menyimpan file ke Google Drive; OCR lokal tidak dapat membaca file tersebut secara otomatis tanpa jembatan integrasi yang diberi akses ke Drive.

Rancangan aman sementara:
- Form: nama penghubung/nomor HP (opsional), gang/alamat ringkas, persetujuan penggunaan data, upload KK, upload KTP, dan catatan. Jangan meminta warga mengetik NIK/nama bila tujuan utamanya ekstraksi dari dokumen.
- Spreadsheet: ID pengajuan, waktu pengajuan, status pemeriksaan, nama hasil OCR, NIK tersamarkan, nomor KK tersamarkan, alamat, RT/RW, agama, petugas pemeriksa, waktu pemeriksaan, catatan. Hindari menyalin foto atau NIK lengkap ke sheet yang dibagikan.
- Karena dokumen unggahan Forms berada di Google Drive, akses Drive harus dibatasi hanya kepada petugas berwenang. Jangan mengaktifkan tautan publik.
- Sampai koneksi Google Drive/Forms tersedia, formulir dan sheet belum dapat dibuat langsung dari ChatGPT. Jangan mengklaim Form atau Sheet sudah aktif.
- Jika file dari Forms harus masuk ke OCR lokal aplikasi, petugas perlu mengunduh file lalu mengunggahnya ke menu OCR RT TBK. Sinkronisasi otomatis membutuhkan koneksi Google Drive/Apps Script yang sah dan peninjauan izin akses; koneksi tersebut belum tersedia.

## Pengaman sebelum implementasi produksi

- Konfirmasi lokasi penyimpanan dokumen dan lama retensi.
- Pastikan OCR berjalan tanpa mengunggah gambar ke CDN/API OCR pihak ketiga; model OCR dan berkas WASM harus di-host sendiri dan versinya dipatok.
- Uji dengan dokumen contoh fiktif, bukan KTP/KK warga.
- Uji validasi NIK/KK 16 digit, kualitas foto, duplikasi, pembatalan, dan kegagalan OCR.
- Uji otorisasi endpoint dan bucket; hanya Ketua RT yang dapat melihat dokumen dan menyetujui data.
- Tambahkan kolom `agama` dan tabel antrean hanya lewat migrasi aditif yang ditinjau; tidak menjalankan UPDATE/DELETE massal.
- Uji bahwa proses persetujuan hanya INSERT data baru dan tidak mengubah baris yang sudah ada.
- Jalankan seluruh test otomatis dan tinjau deployment sebelum dirilis ke warga.

## Status saat ini

Dokumen rancangan ini hanya menjelaskan arsitektur dan persiapan. Belum ada perubahan pada data warga/keluarga, skema Supabase, penyimpanan dokumen, menu aplikasi, atau deployment produksi.
