<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';
global $config;

if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !verify_csrf()) {
    http_response_code(405);
    exit('Permintaan tidak valid.');
}
if (!duitku_config_ready()) {
    http_response_code(503);
    exit('Kredensial Sandbox Duitku belum dikonfigurasi.');
}
if (!extension_loaded('curl')) {
    http_response_code(503);
    exit('Ekstensi cURL PHP belum tersedia pada hosting.');
}
$last = (int)($_SESSION['last_checkout_at'] ?? 0);
if ($last > time() - 20) {
    http_response_code(429);
    exit('Mohon tunggu sebentar sebelum membuat simulasi berikutnya.');
}
$name = trim((string)($_POST['customer_name'] ?? ''));
$email = trim((string)($_POST['customer_email'] ?? ''));
$phone = preg_replace('/[^0-9+]/', '', (string)($_POST['customer_phone'] ?? ''));
if ($name === '' || mb_strlen($name) > 100 || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 255 || strlen($phone) > 30) {
    http_response_code(422);
    exit('Nama, email, atau nomor telepon tidak valid.');
}
$amount = 35000;
$orderId = 'RTTBK' . date('ymdHis') . strtoupper(bin2hex(random_bytes(4)));
$productDetails = 'Simulasi iuran warga RT 004/RW 01';
$merchantCode = trim((string)$config['duitku']['merchant_code']);
$apiKey = trim((string)$config['duitku']['api_key']);
$timestamp = (string)round(microtime(true) * 1000);
$signature = hash_hmac('sha256', $merchantCode . $timestamp, $apiKey);
$payload = [
    'paymentAmount' => $amount,
    'merchantOrderId' => $orderId,
    'productDetails' => $productDetails,
    'additionalParam' => '',
    'merchantUserInfo' => '',
    'customerVaName' => mb_substr($name, 0, 20),
    'email' => $email,
    'phoneNumber' => $phone,
    'itemDetails' => [[
        'name' => 'Simulasi iuran warga RT TBK',
        'price' => $amount,
        'quantity' => 1,
    ]],
    'callbackUrl' => rtrim((string)$config['site']['base_url'], '/') . '/callback.php',
    'returnUrl' => rtrim((string)$config['site']['base_url'], '/') . '/return.php',
    'expiryPeriod' => max(5, min(60, (int)($config['duitku']['expiry_minutes'] ?? 15))),
];
$method = trim((string)($config['duitku']['payment_method'] ?? ''));
if ($method !== '') $payload['paymentMethod'] = $method;

$body = json_encode($payload, JSON_UNESCAPED_SLASHES);
$ch = curl_init('https://api-sandbox.duitku.com/api/merchant/createInvoice');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 25,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: application/json',
        'x-duitku-signature: ' . $signature,
        'x-duitku-timestamp: ' . $timestamp,
        'x-duitku-merchantcode: ' . $merchantCode,
    ],
]);
$responseBody = curl_exec($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);
if (!is_string($responseBody) || $httpCode !== 200) {
    error_log('Duitku Sandbox Create Invoice failed; HTTP=' . $httpCode . '; curl=' . $curlError);
    http_response_code(502);
    exit('Duitku Sandbox belum dapat membuat invoice. Periksa konfigurasi dan coba kembali.');
}
$response = json_decode($responseBody, true);
if (!is_array($response) || (string)($response['statusCode'] ?? '') !== '00' || empty($response['paymentUrl']) || empty($response['reference'])) {
    error_log('Duitku Sandbox returned an unexpected Create Invoice response.');
    http_response_code(502);
    exit('Respons invoice dari Duitku tidak sesuai. Silakan periksa dashboard Sandbox.');
}

$stmt = db()->prepare('INSERT INTO duitku_sandbox_orders
    (merchant_order_id, duitku_reference, payment_amount, product_details, customer_name, customer_email, customer_phone, payment_method, payment_status)
    VALUES (:order_id, :reference, :amount, :details, :name, :email, :phone, :method, "pending")');
$stmt->execute([
    ':order_id' => $orderId,
    ':reference' => (string)$response['reference'],
    ':amount' => $amount,
    ':details' => $productDetails,
    ':name' => $name,
    ':email' => $email,
    ':phone' => $phone !== '' ? $phone : null,
    ':method' => $method !== '' ? $method : null,
]);
$_SESSION['last_checkout_at'] = time();
header('Location: ' . (string)$response['paymentUrl'], true, 303);
exit;
