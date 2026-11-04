# RT Kita Android (APK uji)

Proyek Android awal untuk mengemas situs RT Kita ke aplikasi Android melalui WebView HTTPS.

- Application ID: `com.rtkita.tbk`
- Situs yang dibuka: `https://rt-kita-tbk.vercel.app/`
- Build uji: `./gradlew :app:assembleDebug`
- APK debug otomatis ditandatangani oleh Android SDK untuk pengujian, bukan untuk distribusi rilis jangka panjang.

Sebelum rilis publik, wajib:
1. Uji login admin dan warga pada perangkat Android nyata.
2. Uji unggah foto/dokumen, unduh surat, tombol kembali, dan alur QRIS (tanpa transaksi produksi).
3. Verifikasi kebijakan tautan eksternal dan keamanan sesi.
4. Buat kunci signing release yang disimpan sebagai GitHub Actions Secrets; jangan pernah commit ke repository.
5. Build APK release bertanda tangan dan uji instalasi/upgrade.

APK ini memuat situs online, sehingga memerlukan internet. Versi ini belum menyediakan mode offline penuh.
