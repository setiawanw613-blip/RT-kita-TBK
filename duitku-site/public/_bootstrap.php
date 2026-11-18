<?php
declare(strict_types=1);

$appPath = getenv('RTTBK_APP_PATH') ?: dirname(__DIR__) . '/app';
require rtrim($appPath, DIRECTORY_SEPARATOR) . '/bootstrap.php';
