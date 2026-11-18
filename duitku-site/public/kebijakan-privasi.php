<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
global $config;
$site = $config['site'] ?? [];
?>
<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kebijakan Privasi - RT TBK</title>
<style>body{font-family:system-ui,sans-serif;background:#f2f6fb;color:#17243a;margin:0;padding:20px;line-height:1.65}.card{max-width:760px;margin:5vh auto;background:white;border:1px solid #dce5ef;border-radius:18px;padding:24px}a{color:#1459a6}</style></head><body><main class="card"><h1>Kebijakan Privasi</h1>
<p>Website simulasi pembayaran RT TBK ini hanya digunakan untuk pengujian integrasi Duitku Sandbox. Data nama, email, dan nomor telepon yang dimasukkan pada formulir digunakan untuk membuat transaksi simulasi dan menyimpan catatan status pengujian.</p>
<p>Data transaksi uji disimpan pada database website dan dapat diproses oleh Duitku Sandbox sesuai ketentuan layanan Duitku. Website ini tidak meminta kata sandi aplikasi RT TBK, NIK, nomor Kartu Keluarga, atau dokumen identitas.</p>
<p>Data simulasi tidak digunakan untuk menetapkan pelunasan iuran warga, mengubah saldo kas RT, atau mengubah data warga pada aplikasi utama RT TBK. Jangan masukkan data pribadi warga yang sebenarnya ke formulir Sandbox.</p>
<p>Untuk pertanyaan privasi, hubungi pengelola: <?= h((string)($site['email'] ?? 'email pengelola yang dikonfigurasi')) ?>.</p>
<p><a href="index.php">Kembali ke halaman utama</a></p></main></body></html>
