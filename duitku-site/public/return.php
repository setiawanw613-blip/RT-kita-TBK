<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
$orderId = trim((string)($_GET['merchantOrderId'] ?? ''));
$order = null;
if (preg_match('/^RTTBK[A-Z0-9]{10,40}$/', $orderId)) {
    $stmt = db()->prepare('SELECT merchant_order_id, duitku_reference, payment_amount, payment_status, created_at FROM duitku_sandbox_orders WHERE merchant_order_id = :order_id LIMIT 1');
    $stmt->execute([':order_id' => $orderId]);
    $order = $stmt->fetch() ?: null;
}
$statusText = match ($order['payment_status'] ?? '') {
    'paid' => 'Callback Duitku terverifikasi: simulasi berhasil.',
    'failed' => 'Transaksi Sandbox gagal atau dibatalkan.',
    'pending' => 'Transaksi masih menunggu callback resmi dari Duitku.',
    default => 'Nomor transaksi belum ditemukan. Periksa kembali beberapa saat lagi.',
};
?>
<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Status Simulasi RT TBK</title>
<style>body{font-family:system-ui,sans-serif;background:#f2f6fb;color:#17243a;margin:0;padding:24px}.card{max-width:560px;margin:8vh auto;background:white;border:1px solid #dce5ef;border-radius:18px;padding:24px}a{color:#1459a6}code{overflow-wrap:anywhere}</style></head><body><main class="card"><h1>Status simulasi pembayaran</h1><p><?= h($statusText) ?></p>
<?php if ($order): ?><p>Nomor pesanan: <code><?= h((string)$order['merchant_order_id']) ?></code></p><p>Referensi Duitku: <code><?= h((string)($order['duitku_reference'] ?? '-')) ?></code></p><p>Nominal: <strong>Rp<?= number_format((int)$order['payment_amount'], 0, ',', '.') ?></strong></p><?php endif; ?>
<p>Halaman ini tidak menetapkan status lunas dari parameter redirect browser. Status hanya diperbarui melalui callback server Duitku yang tervalidasi.</p><p><a href="index.php">Kembali ke halaman RT TBK</a></p></main></body></html>
