<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
global $config;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Method Not Allowed');
}
$merchantCode = trim((string)($_POST['merchantCode'] ?? ''));
$amount = trim((string)($_POST['amount'] ?? ''));
$orderId = trim((string)($_POST['merchantOrderId'] ?? ''));
$signature = trim((string)($_POST['signature'] ?? ''));
$resultCode = trim((string)($_POST['resultCode'] ?? ''));
$reference = trim((string)($_POST['reference'] ?? ''));
$expectedMerchant = trim((string)($config['duitku']['merchant_code'] ?? ''));
$apiKey = trim((string)($config['duitku']['api_key'] ?? ''));

if ($merchantCode === '' || $amount === '' || $orderId === '' || $signature === '' || $expectedMerchant === '' || $apiKey === '') {
    http_response_code(400);
    exit('Invalid callback');
}
if (!hash_equals($expectedMerchant, $merchantCode) || !preg_match('/^\d{1,10}$/', $amount) || !preg_match('/^RTTBK[A-Z0-9]{10,40}$/', $orderId)) {
    http_response_code(400);
    exit('Invalid callback data');
}
$expectedSignature = hash_hmac('sha256', $merchantCode . $amount . $orderId, $apiKey);
if (!hash_equals($expectedSignature, $signature)) {
    http_response_code(403);
    exit('Invalid signature');
}

$pdo = db();
$pdo->beginTransaction();
try {
    $select = $pdo->prepare('SELECT id, payment_amount, payment_status, duitku_reference FROM duitku_sandbox_orders WHERE merchant_order_id = :order_id FOR UPDATE');
    $select->execute([':order_id' => $orderId]);
    $order = $select->fetch();
    if (!$order || (int)$order['payment_amount'] !== (int)$amount || $reference === '' || !hash_equals((string)$order['duitku_reference'], $reference)) {
        $pdo->rollBack();
        http_response_code(404);
        exit('Order not found or amount mismatch');
    }
    $status = (string)$order['payment_status'];
    $newStatus = $status;
    if ($resultCode === '00') {
        $newStatus = 'paid';
    } elseif ($resultCode === '01' && $status !== 'paid') {
        $newStatus = 'failed';
    }
    $update = $pdo->prepare('UPDATE duitku_sandbox_orders SET
        duitku_reference = COALESCE(NULLIF(:reference, ""), duitku_reference),
        payment_method = COALESCE(NULLIF(:method, ""), payment_method),
        result_code = :result_code,
        payment_status = :payment_status,
        publisher_order_id = COALESCE(NULLIF(:publisher_order_id, ""), publisher_order_id),
        settlement_date = :settlement_date,
        callback_received_at = COALESCE(callback_received_at, UTC_TIMESTAMP())
        WHERE id = :id');
    $settlementDate = trim((string)($_POST['settlementDate'] ?? ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $settlementDate)) $settlementDate = null;
    $update->execute([
        ':reference' => $reference,
        ':method' => trim((string)($_POST['paymentCode'] ?? '')),
        ':result_code' => $resultCode,
        ':payment_status' => $newStatus,
        ':publisher_order_id' => trim((string)($_POST['publisherOrderId'] ?? '')),
        ':settlement_date' => $settlementDate,
        ':id' => (int)$order['id'],
    ]);
    $pdo->commit();
    http_response_code(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'SUCCESS';
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('Duitku Sandbox callback processing failed: ' . $e->getMessage());
    http_response_code(500);
    echo 'RETRY';
}
