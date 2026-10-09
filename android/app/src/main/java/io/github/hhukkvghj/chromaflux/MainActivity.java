package io.github.hhukkvghj.chromaflux;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Chromaflux as an app: the very same index.html, bundled offline and served from a secure
 * in-app origin (so motion sensors are allowed), plus a small native bridge for what the
 * browser cannot do — vibration with real intensity and an orientation lock for hold mode.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private WebView web;
    private Vibrator vibrator;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));   // links leave the app
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "ChromafluxNative");
        web.loadUrl("https://" + HOST + "/assets/index.html");
        immersive();
    }

    /** What the page may ask of the phone. Called from JavaScript on a background thread. */
    public final class Bridge {

        /** pattern: "on,off,on,…" in ms; amp: 1–255 strength of every "on" segment. */
        @JavascriptInterface
        public void vibrate(String pattern, int amp) {
            if (vibrator == null || !vibrator.hasVibrator() || pattern == null) return;
            String[] parts = pattern.split(",");
            int n = parts.length + 1;
            long[] timings = new long[n];
            int[] amps = new int[n];
            timings[0] = 0;                       // createWaveform starts with an "off" slot
            int a = Math.max(1, Math.min(255, amp));
            long total = 0;
            for (int i = 0; i < parts.length; i++) {
                try {
                    timings[i + 1] = Math.max(0, Math.min(5000, Long.parseLong(parts[i].trim())));
                } catch (NumberFormatException e) {
                    timings[i + 1] = 0;
                }
                amps[i + 1] = (i % 2 == 0) ? a : 0;
                total += timings[i + 1];
            }
            if (total == 0) return;
            try {
                VibrationEffect effect = VibrationEffect.createWaveform(timings, amps, -1);
                // Media vibration follows the media/haptics setting rather than the ringer switch.
                if (Build.VERSION.SDK_INT >= 33) {
                    vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_MEDIA));
                } else {
                    vibrator.vibrate(effect, new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_GAME)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                }
            } catch (RuntimeException ignored) {
                // a malformed pattern must never take the app down
            }
        }

        @JavascriptInterface
        public void cancel() {
            if (vibrator != null) vibrator.cancel();
        }

        @JavascriptInterface
        public boolean hasAmplitudeControl() {
            return vibrator != null && vibrator.hasAmplitudeControl();
        }

        /** Hold mode keeps the glass from flipping into landscape while you tilt it. */
        @JavascriptInterface
        public void lockOrientation(boolean lock) {
            runOnUiThread(() -> setRequestedOrientation(lock
                    ? ActivityInfo.SCREEN_ORIENTATION_LOCKED
                    : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
        }
    }

    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onPause() {
        web.onPause();
        if (vibrator != null) vibrator.cancel();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
