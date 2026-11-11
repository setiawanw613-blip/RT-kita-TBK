# Template Google Form dan Google Sheets — Pendataan Warga RT TBK

Status: template siap disalin saat akses Google Drive/Forms tersedia. Ini bukan Form/Sheet aktif.

## Judul Form
Pendataan dan Pemutakhiran Data Warga RT 004 / RW 01 — Taman Bali Kahuripan

## Deskripsi Form
Formulir ini digunakan untuk pendataan warga RT TBK. Petugas RT akan memeriksa dokumen dan hasil pembacaan sebelum data disahkan. Mohon unggah foto KK dan KTP yang jelas, tidak terpotong, dan dapat dibaca.

Dokumen identitas merupakan data pribadi. File hanya boleh diakses petugas RT yang ditunjuk untuk pendataan. Jangan membagikan tautan file atau spreadsheet kepada publik. Pengiriman formulir belum berarti data langsung disahkan.

## Susunan pertanyaan Form

1. Nama penghubung keluarga (opsional; jawaban singkat)
2. Nomor HP penghubung (opsional; jawaban singkat)
3. Gang / blok tempat tinggal (opsional; jawaban singkat)
4. Unggah Kartu Keluarga (wajib; file upload; batasi satu file; gambar JPG/PNG atau PDF bila perlu)
5. Unggah KTP (wajib; file upload; batasi satu file; gambar JPG/PNG)
6. Persetujuan pemrosesan data (wajib; checkbox tunggal): "Saya menyatakan dokumen yang saya unggah benar dan bersedia dokumen digunakan oleh petugas RT untuk verifikasi pendataan warga."
7. Catatan untuk petugas RT (opsional; paragraf)

Catatan: Google Forms mengharuskan responden login Google untuk unggah file. File unggahan disimpan di Google Drive pemilik Form. Karena itu, batasi akses folder unggahan dan jangan gunakan opsi siapa pun yang memiliki link. Google Form tidak menjalankan OCR lokal dan tidak mengisi jawaban berdasarkan gambar pada saat formulir dikirim.

## Kolom Google Sheets (lembar kerja internal, akses terbatas)

- ID Pengajuan
- Timestamp
- Status Pemeriksaan (Menunggu / Perlu Perbaikan / Disetujui / Ditolak)
- Nama Penghubung
- Nomor HP (akses terbatas)
- Gang/Blok
- Link File KK (akses terbatas)
- Link File KTP (akses terbatas)
- Hasil OCR Nama (draft)
- Hasil OCR NIK (MASKED; jangan tampilkan NIK lengkap di sheet)
- Hasil OCR Nomor KK (MASKED)
- Alamat
- RT
- RW
- Agama
- Tempat Lahir
- Tanggal Lahir
- Jenis Kelamin
- Status Perkawinan
- Pekerjaan
- Nama Petugas Pemeriksa
- Waktu Pemeriksaan
- Catatan Koreksi

Jangan berbagi spreadsheet ini kepada warga atau publik. Jika warga perlu menerima tanda terima, buat tanda terima terpisah tanpa NIK/No. KK lengkap dan tanpa tautan file dokumen.

## Proses kerja yang disarankan

1. Warga mengisi Form dan mengunggah dokumen.
2. Petugas RT memeriksa daftar pengajuan.
3. Untuk jalur OCR lokal, petugas mengunduh dokumen ke perangkat kerja yang dikuasai RT lalu membukanya melalui menu OCR lokal di RT TBK. Jangan mengirim dokumen ke situs OCR online.
4. Petugas memeriksa dan mengoreksi hasil OCR dengan melihat dokumen asli.
5. Pengajuan baru dikirim ke antrean review aplikasi.
6. Ketua RT menyetujui. Aplikasi memeriksa duplikasi NIK dan nomor KK, lalu membuat data baru. Jika terdeteksi cocok dengan data lama, proses dihentikan untuk pemeriksaan manual; jangan menimpa data lama.

## Privasi dan retensi

- Tetapkan petugas yang boleh melihat file.
- Nonaktifkan berbagi publik dan batasi editor spreadsheet.
- Jangan menyalin NIK/No. KK lengkap ke sheet atau notifikasi jika tidak benar-benar diperlukan.
- Tetapkan masa simpan file dokumen dan hapus file sementara setelah kebijakan retensi disetujui.
- Sediakan jalur koreksi data untuk warga.
- Simpan catatan siapa yang memeriksa dan menyetujui pengajuan.

## Status akses

Pada saat dokumen ini dibuat, konektor Google Drive dinonaktifkan oleh administrator. Oleh sebab itu, Form dan Sheet belum dapat dibuat langsung dari ChatGPT. Template ini dapat disalin ke akun Google resmi RT setelah akses Drive/Forms tersedia.
