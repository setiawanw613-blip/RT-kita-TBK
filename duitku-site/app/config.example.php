<?php
declare(strict_types=1);

/*
 * Salin file ini menjadi config.php di folder app/ (DI LUAR document root).
 * Jangan commit config.php dan jangan membagikan Merchant Key.
 */
return [
    'site' => [
        'base_url' => 'https://GANTI-DENGAN-SUBDOMAIN-ANDA',
        'title' => 'Pembayaran Iuran Warga RT TBK',
        'organization' => 'Pengelolaan Iuran Warga RT 004 / RW 01',
        'area' => 'Taman Bali Kahuripan',
        'description' => 'Layanan administrasi pembayaran iuran lingkungan warga RT 004 / RW 01 Taman Bali Kahuripan.',
        'address' => 'ISI ALAMAT SEKRETARIAT ATAU AREA KERJA RESMI',
        'phone' => 'ISI NOMOR TELEPON RESMI',
        'email' => 'ISI EMAIL RESMI PENGELOLA',
        'coordinator_name' => 'Ketua RT 004 / RW 01',
    ],
    'duitku' => [
        'mode' => 'sandbox', // Dikunci sandbox oleh aplikasi ini.
        'merchant_code' => 'ISI_MERCHANT_CODE_SANDBOX',
        'api_key' => 'ISI_API_KEY_SANDBOX',
        'payment_method' => '', // Kosong = biarkan opsi kanal tersedia sesuai proyek Sandbox.
        'expiry_minutes' => 15,
    ],
    'database' => [
        'dsn' => 'mysql:host=localhost;dbname=ISI_NAMA_DATABASE;charset=utf8mb4',
        'username' => 'ISI_USER_DATABASE',
        'password' => 'ISI_PASSWORD_DATABASE',
    ],
];
