<?php
declare(strict_types=1);

$appPath = getenv('RTTBK_APP_PATH') ?: dirname(__DIR__) . '/app';
$configFile = rtrim($appPath, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'config.php';
if (!is_file($configFile)) {
    http_response_code(503);
    exit('Konfigurasi website belum dipasang oleh pengelola.');
}
$config = require $configFile;
if (!is_array($config)) {
    http_response_code(503);
    exit('Konfigurasi website tidak valid.');
}

$baseUrl = rtrim((string)($config['site']['base_url'] ?? ''), '/');
if (!preg_match('#^https://[a-z0-9.-]+(?::[0-9]+)?$#i', $baseUrl)) {
    http_response_code(503);
    exit('SITE_BASE_URL wajib menggunakan domain HTTPS yang valid.');
}
if (($config['duitku']['mode'] ?? '') !== 'sandbox') {
    http_response_code(503);
    exit('Website ini hanya mengizinkan mode Sandbox.');
}
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_name('rttbk_duitku_sandbox');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function h(string $value): string {
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function db(): PDO {
    global $config;
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $db = $config['database'] ?? [];
    $pdo = new PDO((string)($db['dsn'] ?? ''), (string)($db['username'] ?? ''), (string)($db['password'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}

function csrf_token(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return (string)$_SESSION['csrf'];
}

function verify_csrf(): bool {
    $sent = (string)($_POST['csrf'] ?? '');
    return $sent !== '' && isset($_SESSION['csrf']) && hash_equals((string)$_SESSION['csrf'], $sent);
}

function duitku_config_ready(): bool {
    global $config;
    $code = trim((string)($config['duitku']['merchant_code'] ?? ''));
    $key = trim((string)($config['duitku']['api_key'] ?? ''));
    return $code !== '' && $key !== '' &&
        !str_contains($code, 'ISI_') && !str_contains($key, 'ISI_');
}
