# RT Kita Android

Proyek Android untuk mengemas situs RT Kita melalui WebView HTTPS.

- Application ID: `com.rtkita.tbk`
- Situs: `https://rt-kita-tbk.vercel.app/`
- APK uji: GitHub Actions workflow **Tests**, artifact `rt-kita-android-debug`.
- APK rilis: workflow manual **Android APK (release)**; memerlukan signing secrets di bawah.

## Signing APK rilis

Buat satu keystore release yang aman dan simpan salinan cadangan offline. Jangan commit ke repository dan jangan membuat keystore baru untuk setiap rilis karena APK berikutnya harus ditandatangani dengan kunci yang sama agar bisa memperbarui instalasi lama.

Tambahkan empat GitHub Actions repository secrets:
- `RT_KITA_KEYSTORE_BASE64`: isi file keystore dalam Base64 satu baris.
- `RT_KITA_KEYSTORE_PASSWORD`: password keystore.
- `RT_KITA_KEY_ALIAS`: alias key.
- `RT_KITA_KEY_PASSWORD`: password key.

Jalankan workflow **Android APK (release)** secara manual. Workflow akan gagal dengan pesan yang jelas jika secrets belum disediakan. Kunci hanya digunakan di runner sementara dan tidak disimpan di artifact.

## Daftar uji sebelum rilis warga

1. Instal APK di beberapa perangkat Android dan pastikan update versi dapat dipasang.
2. Uji login Ketua RT dan warga, sesi, logout, dan pembatasan akses.
3. Uji unggah foto/dokumen, unduh/cetak surat, dan navigasi tombol kembali.
4. Uji tautan keluar dan alur pembayaran sandbox saja; jangan gunakan QRIS produksi sebelum proses produksi disiapkan.
5. Pastikan domain, privasi, dan dukungan operasional siap.

## Batasan versi awal

- Membutuhkan internet; belum ada offline penuh.
- APK debug hanya untuk pengujian, bukan distribusi resmi.
- APK rilis harus menggunakan signing key permanen yang dikuasai pengelola RT.
