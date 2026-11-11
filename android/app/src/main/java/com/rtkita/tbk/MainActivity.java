package com.rtkita.tbk;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String HOME = "https://rt-kita-tbk.vercel.app/";
    private static final String HOST = "rt-kita-tbk.vercel.app";
    private static final int FILE_CHOOSER_REQUEST = 4102;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("https".equalsIgnoreCase(scheme) && HOST.equalsIgnoreCase(uri.getHost())) return false;
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    openExternal(uri);
                    return true;
                }
                if ("tel".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (ActivityNotFoundException ignored) { }
                    return true;
                }
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                Uri uri = Uri.parse(url);
                if (!"https".equalsIgnoreCase(uri.getScheme()) || !HOST.equalsIgnoreCase(uri.getHost())) {
                    Toast.makeText(MainActivity.this, "Unduhan dari domain luar diblokir demi keamanan", Toast.LENGTH_LONG).show();
                    return;
                }
                try {
                    // Flush WebView cookies first so authenticated same-origin downloads
                    // use the active RT Kita session in Android's DownloadManager.
                    CookieManager cookieManager = CookieManager.getInstance();
                    cookieManager.flush();
                    String cookie = cookieManager.getCookie(url);
                    if (cookie == null || cookie.trim().isEmpty()) {
                        Toast.makeText(MainActivity.this,
                                "Sesi login tidak terbaca. Silakan masuk ulang lalu coba unduh lagi.",
                                Toast.LENGTH_LONG).show();
                        return;
                    }

                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request request = new DownloadManager.Request(uri);
                    request.addRequestHeader("Cookie", cookie);
                    if (userAgent != null && !userAgent.trim().isEmpty()) {
                        request.addRequestHeader("User-Agent", userAgent);
                    }
                    request.setMimeType(mimeType);
                    request.setTitle(fileName);
                    request.setDescription("Mengunduh berkas RT Kita");
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                    DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (manager == null) {
                        Toast.makeText(MainActivity.this, "Layanan unduhan perangkat tidak tersedia",
                                Toast.LENGTH_LONG).show();
                        return;
                    }
                    manager.enqueue(request);
                    Toast.makeText(MainActivity.this, "Unduhan dimulai. Periksa folder Download.", Toast.LENGTH_LONG).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Unduhan gagal dimulai", Toast.LENGTH_SHORT).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                clearPendingCamera();
                fileCallback = callback;
                try {
                    // WebView params.createIntent() membuka pemilih galeri dan mengabaikan
                    // atribut HTML capture="environment". Tangani capture secara native.
                    if (params.isCaptureEnabled() && acceptsImage(params.getAcceptTypes())) {
                        Intent camera = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                        if (camera.resolveActivity(getPackageManager()) != null) {
                            File pictures = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                            if (pictures == null) throw new IOException("Folder kamera tidak tersedia");
                            if (!pictures.exists() && !pictures.mkdirs()) {
                                throw new IOException("Folder kamera tidak dapat dibuat");
                            }
                            pendingCameraFile = File.createTempFile("RTTBK_KAMERA_", ".jpg", pictures);
                            pendingCameraUri = FileProvider.getUriForFile(
                                    MainActivity.this,
                                    getPackageName() + ".fileprovider",
                                    pendingCameraFile
                            );
                            camera.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, pendingCameraUri);
                            camera.setClipData(ClipData.newRawUri("Foto dokumen RT TBK", pendingCameraUri));
                            camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                            startActivityForResult(camera, FILE_CHOOSER_REQUEST);
                            return true;
                        }
                    }
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException | IOException e) {
                    clearPendingCamera();
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "Kamera tidak dapat dibuka. Silakan coba lagi.", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        if (savedInstanceState == null) webView.loadUrl(HOME);
        else webView.restoreState(savedInstanceState);
    }

    private boolean acceptsImage(String[] types) {
        if (types == null || types.length == 0) return false;
        for (String type : types) {
            if (type != null && (type.equalsIgnoreCase("image/*")
                    || type.toLowerCase().startsWith("image/"))) return true;
        }
        return false;
    }

    private void clearPendingCamera() {
        if (pendingCameraFile != null && pendingCameraFile.exists()) pendingCameraFile.delete();
        pendingCameraFile = null;
        pendingCameraUri = null;
    }

    private void openExternal(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Tidak ada aplikasi untuk membuka tautan", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] result;
            if (pendingCameraUri != null) {
                if (resultCode == RESULT_OK && pendingCameraFile != null
                        && pendingCameraFile.exists() && pendingCameraFile.length() > 0) {
                    result = new Uri[]{pendingCameraUri};
                } else {
                    result = null;
                    clearPendingCamera();
                }
            } else {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        clearPendingCamera();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
