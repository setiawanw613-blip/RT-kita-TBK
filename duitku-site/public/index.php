<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
global $config;
$site = $config['site'] ?? [];
$ready = duitku_config_ready();
$notice = isset($_GET['status']) ? (string)$_GET['status'] : '';
?>
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1459a6">
<title><?= h((string)($site['title'] ?? 'Pembayaran Iuran Warga RT TBK')) ?></title>
<style>
:root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17243a;background:#f2f6fb}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:900px;margin:auto;padding:24px 16px 48px}
header{background:#124f96;color:white;padding:28px 24px;border-radius:20px}
header small{opacity:.85;letter-spacing:.08em;text-transform:uppercase}h1{font-size:clamp(26px,5vw,38px);margin:10px 0}header p{margin:0;line-height:1.6;opacity:.94}
main{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-top:18px}
.card{background:white;border:1px solid #dce5ef;border-radius:18px;padding:22px;box-shadow:0 8px 28px #183b5b0b}
h2{font-size:20px;margin:0 0 12px}.muted{color:#5c6b7d;line-height:1.6}
.fee{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf1f5}.fee.total{font-weight:800;font-size:18px;border:0;padding-top:16px}
label{display:block;font-weight:650;margin:13px 0 6px}input{width:100%;padding:12px;border:1px solid #cbd6e2;border-radius:10px;font:inherit}
button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:11px;background:#1459a6;color:white;font:700 16px system-ui;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}.notice{padding:12px;border-radius:10px;background:#fff6df;color:#714d00;margin:0 0 14px}
.status{padding:12px;border-radius:10px;background:#e9f5ff;color:#124f96;margin-bottom:14px}
footer{text-align:center;color:#6a7889;font-size:13px;margin-top:22px}
@media(max-width:700px){main{grid-template-columns:1fr}.wrap{padding:14px 12px 32px}}
</style>
</head>
<body><div class="wrap">
<header>
<small>Pelayanan warga digital · RT 004 / RW 01</small>
<h1><?= h((string)($site['organization'] ?? 'Pengelolaan Iuran Warga')) ?></h1>
<p><?= h((string)($site['area'] ?? 'Taman Bali Kahuripan')) ?> — <?= h((string)($site['description'] ?? 'Informasi layanan iuran lingkungan warga.')) ?></p>
</header>
<main>
<section class="card">
<h2>Informasi layanan</h2>
<p class="muted">Layanan ini disediakan untuk membantu pencatatan dan pembayaran iuran lingkungan warga RT 004 / RW 01. Dana iuran digunakan untuk kebutuhan lingkungan sesuai pencatatan dan pertanggungjawaban pengurus RT.</p>
<div class="fee"><span>Keamanan</span><strong>Rp15.000</strong></div>
<div class="fee"><span>Sampah</span><strong>Rp15.000</strong></div>
<div class="fee"><span>Kas RT</span><strong>Rp5.000</strong></div>
<div class="fee total"><span>Total iuran per bulan</span><strong>Rp35.000</strong></div>
<h2 style="margin-top:22px">Kontak pengelola</h2>
<p class="muted">
<strong><?= h((string)($site['coordinator_name'] ?? 'Pengelola RT')) ?></strong><br>
<?= h((string)($site['address'] ?? 'Alamat sekretariat belum diatur')) ?><br>
Telepon: <?= h((string)($site['phone'] ?? 'Belum diatur')) ?><br>
Email: <?= h((string)($site['email'] ?? 'Belum diatur')) ?>
</p>
</section>
<section class="card">
<h2>Checkout simulasi Sandbox</h2>
<?php if ($notice === 'pending'): ?><div class="status">Permintaan pembayaran telah dibuat. Status akhir menunggu callback resmi dari Duitku.</div><?php endif; ?>
<?php if (!$ready): ?><div class="notice">Checkout belum aktif. Pengelola perlu mengisi kredensial Sandbox Duitku pada konfigurasi hosting.</div><?php endif; ?>
<p class="muted">Ini adalah transaksi uji coba Sandbox untuk proses verifikasi integrasi. Tidak ada penagihan atau pemindahan uang sungguhan.</p>
<form method="post" action="create-invoice.php">
<input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
<label for="customer_name">Nama penguji</label>
<input id="customer_name" name="customer_name" maxlength="100" required autocomplete="name" placeholder="Nama lengkap">
<label for="customer_email">Email</label>
<input id="customer_email" name="customer_email" type="email" maxlength="255" required autocomplete="email" placeholder="nama@email.com">
<label for="customer_phone">Nomor telepon (opsional)</label>
<input id="customer_phone" name="customer_phone" maxlength="30" autocomplete="tel" placeholder="08xxxxxxxxxx">
<div class="fee total"><span>Nominal simulasi</span><strong>Rp35.000</strong></div>
<button type="submit" <?= $ready ? '' : 'disabled' ?>>Lanjut ke checkout Sandbox</button>
</form>
</section>
</main>
<footer>RT TBK · RT 004 / RW 01 – Taman Bali Kahuripan<br>Halaman uji Sandbox. Bukan kanal pembayaran produksi.<br><a href="ketentuan.php">Ketentuan Layanan</a> · <a href="kebijakan-privasi.php">Kebijakan Privasi</a></footer>
</div></body></html>
