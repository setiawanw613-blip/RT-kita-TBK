<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
global $config;
$site = $config['site'] ?? [];
?>
<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ketentuan Layanan - RT TBK</title>
<style>body{font-family:system-ui,sans-serif;background:#f2f6fb;color:#17243a;margin:0;padding:20px;line-height:1.65}.card{max-width:760px;margin:5vh auto;background:white;border:1px solid #dce5ef;border-radius:18px;padding:24px}a{color:#1459a6}</style></head><body><main class="card"><h1>Ketentuan Layanan</h1>
<p>Website ini merupakan halaman informasi pengelolaan iuran lingkungan warga RT 004 / RW 01 – Taman Bali Kahuripan.</p>
<p>Rincian iuran yang diinformasikan adalah keamanan Rp15.000, sampah Rp15.000, dan kas RT Rp5.000 per bulan, dengan total Rp35.000 per bulan. Penggunaan dana iuran mengikuti kebutuhan lingkungan dan pencatatan pengurus RT.</p>
<p>Fitur checkout yang tersedia pada versi website ini adalah simulasi Duitku Sandbox. Transaksi Sandbox bukan pembayaran nyata, tidak menimbulkan kewajiban pembayaran, dan tidak dapat dijadikan bukti pelunasan iuran warga.</p>
<p>Website ini belum menerima pembayaran produksi. Pembayaran nyata hanya dapat dilakukan setelah proses verifikasi merchant, aktivasi resmi Duitku, dan pengumuman resmi dari pengurus RT.</p>
<p>Kontak pengelola: <?= h((string)($site['phone'] ?? 'nomor telepon pengelola yang dikonfigurasi')) ?> · <?= h((string)($site['email'] ?? 'email pengelola yang dikonfigurasi')) ?>.</p>
<p><a href="index.php">Kembali ke halaman utama</a></p></main></body></html>
