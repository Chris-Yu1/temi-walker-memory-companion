package com.memory.temiweb;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.PointF;
import android.media.AudioManager;
import android.media.FaceDetector;
import android.media.MediaPlayer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.util.Locale;
import org.json.JSONObject;

public class MainActivity extends Activity {
  private static final String APP_URL = "http://localhost:4200/?robot=temi-v3-192.168.1.109";
  private static final int PERMISSION_REQUEST = 42;
  private static final int FIXED_HEAD_ANGLE_DEGREES = 25;
  private static final long HEAD_TILT_REFRESH_INTERVAL_MS = 30_000L;
  private static final String TAG = "MemoryCompanion";
  private WebView webView;
  private TemiAudioBridge temiAudioBridge;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
    hideSystemUi();
    requestRuntimePermissions();

    webView = new WebView(this);
    setContentView(webView, new ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(true);
    settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    settings.setUseWideViewPort(false);
    settings.setLoadWithOverviewMode(false);
    settings.setTextZoom(100);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    webView.setInitialScale(100);

    webView.setWebViewClient(new WebViewClient() {
      @Override
      public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.proceed();
      }
    });

    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest request) {
        request.grant(request.getResources());
      }
    });
    webView.addJavascriptInterface(new TemiVisionBridge(), "TemiVision");
    webView.addJavascriptInterface(new TemiMotionBridge(), "TemiMotion");
    temiAudioBridge = new TemiAudioBridge(this);
    webView.addJavascriptInterface(temiAudioBridge, "TemiAudio");

    lockTemiMotion();
    webView.clearCache(true);
    webView.loadUrl(APP_URL + "&t=" + System.currentTimeMillis());
  }

  @Override
  protected void onResume() {
    super.onResume();
    hideSystemUi();
    lockTemiMotion();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      hideSystemUi();
    }
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    if (temiAudioBridge != null) {
      temiAudioBridge.shutdown();
      temiAudioBridge = null;
    }
    super.onDestroy();
  }

  private void requestRuntimePermissions() {
    if (android.os.Build.VERSION.SDK_INT < 23) {
      return;
    }

    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
      || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO
      }, PERMISSION_REQUEST);
    }
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
      View.SYSTEM_UI_FLAG_FULLSCREEN
        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    );
  }

  private void lockTemiMotion() {
    try {
      new TemiMotionBridge().lock();
    } catch (Exception ignored) {
      // Motion locking is best-effort; the web app should still load normally.
    }
  }

  private static class TemiMotionBridge {
    private static long lastHeadTiltAt = 0L;

    @JavascriptInterface
    public String lock() {
      try {
        Object robot = getRobot();
        if (robot == null) {
          Log.w(TAG, "Temi SDK robot instance is unavailable.");
          return "{\"locked\":false,\"reason\":\"temi sdk unavailable\"}";
        }

        invoke(robot, "setTrackUserOn", false);
        invoke(robot, "setDetectionModeOn", false);
        invoke(robot, "setAutoReturnOn", false);
        invoke(robot, "stopFaceRecognition");
        invoke(robot, "constraintBeWith");
        invoke(robot, "stopMovement");
        maybeRefreshHeadTilt(robot);
        Log.i(TAG, "Temi motion lock applied.");
        return "{\"locked\":true}";
      } catch (Exception error) {
        Log.e(TAG, "Temi motion lock failed.", error);
        return "{\"locked\":false}";
      }
    }

    @JavascriptInterface
    public String release() {
      lastHeadTiltAt = 0L;
      return "{\"locked\":false}";
    }

    private void maybeRefreshHeadTilt(Object robot) {
      long now = System.currentTimeMillis();
      if (now - lastHeadTiltAt < HEAD_TILT_REFRESH_INTERVAL_MS) {
        return;
      }
      invoke(robot, "tiltAngle", FIXED_HEAD_ANGLE_DEGREES, 0.3f);
      invoke(robot, "tiltAngle", FIXED_HEAD_ANGLE_DEGREES);
      lastHeadTiltAt = now;
    }

    private Object getRobot() {
      String[] classNames = new String[] {
        "com.robotemi.sdk.Robot",
        "com.robotemi.sdk.Robot$Companion"
      };

      for (String className : classNames) {
        try {
          Class<?> robotClass = Class.forName(className);
          try {
            Method getInstance = robotClass.getMethod("getInstance");
            return getInstance.invoke(null);
          } catch (Exception ignored) {
            Object companion = robotClass.getField("INSTANCE").get(null);
            Method getInstance = companion.getClass().getMethod("getInstance");
            return getInstance.invoke(companion);
          }
        } catch (Exception ignored) {
          // Try the next known SDK entry point.
        }
      }
      return null;
    }

    private void invoke(Object target, String methodName, Object... args) {
      for (Method method : target.getClass().getMethods()) {
        if (!method.getName().equals(methodName) || method.getParameterTypes().length != args.length) {
          continue;
        }

        try {
          method.invoke(target, coerce(method.getParameterTypes(), args));
          return;
        } catch (Exception ignored) {
          // Try another overload if one exists.
        }
      }
    }

    private Object[] coerce(Class<?>[] parameterTypes, Object[] args) {
      Object[] values = new Object[args.length];
      for (int index = 0; index < args.length; index += 1) {
        Class<?> type = parameterTypes[index];
        Object value = args[index];
        if ((type == int.class || type == Integer.class) && value instanceof Number) {
          values[index] = ((Number) value).intValue();
        } else if ((type == float.class || type == Float.class) && value instanceof Number) {
          values[index] = ((Number) value).floatValue();
        } else if ((type == double.class || type == Double.class) && value instanceof Number) {
          values[index] = ((Number) value).doubleValue();
        } else if ((type == boolean.class || type == Boolean.class) && value instanceof Boolean) {
          values[index] = value;
        } else {
          values[index] = value;
        }
      }
      return values;
    }
  }

  private static class TemiVisionBridge {
    @JavascriptInterface
    public String detectFace(String base64Image) {
      try {
        String encoded = base64Image;
        int commaIndex = encoded.indexOf(',');
        if (commaIndex >= 0) {
          encoded = encoded.substring(commaIndex + 1);
        }

        byte[] imageBytes = Base64.decode(encoded, Base64.DEFAULT);
        Bitmap decoded = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
        if (decoded == null) {
          return noFace();
        }

        int width = decoded.getWidth();
        if ((width & 1) == 1) {
          width -= 1;
        }
        Bitmap source = Bitmap.createScaledBitmap(decoded, width, decoded.getHeight(), false);
        Bitmap rgb565 = source.copy(Bitmap.Config.RGB_565, true);
        FaceDetector detector = new FaceDetector(rgb565.getWidth(), rgb565.getHeight(), 1);
        FaceDetector.Face[] faces = new FaceDetector.Face[1];
        int count = detector.findFaces(rgb565, faces);
        FaceDetector.Face face = count > 0 ? faces[0] : null;
        if (face == null || face.confidence() < 0.35f) {
          return noFace();
        }

        PointF midpoint = new PointF();
        face.getMidPoint(midpoint);
        float eyeDistance = Math.max(face.eyesDistance(), 1f);
        float boxWidth = eyeDistance * 2.7f;
        float boxHeight = eyeDistance * 3.4f;
        JSONObject result = new JSONObject();
        result.put("detected", true);
        result.put("x", clamp(midpoint.x - boxWidth / 2f, 0f, rgb565.getWidth()));
        result.put("y", clamp(midpoint.y - boxHeight * 0.42f, 0f, rgb565.getHeight()));
        result.put("width", Math.min(boxWidth, rgb565.getWidth()));
        result.put("height", Math.min(boxHeight, rgb565.getHeight()));
        result.put("confidence", face.confidence());
        return result.toString();
      } catch (Exception error) {
        return noFace();
      }
    }

    private static String noFace() {
      return "{\"detected\":false}";
    }

    private static float clamp(float value, float min, float max) {
      return Math.max(min, Math.min(max, value));
    }
  }

  private static class TemiAudioBridge {
    private final Activity activity;
    private MediaPlayer player;
    private TextToSpeech tts;
    private volatile boolean ttsSpeaking = false;

    TemiAudioBridge(Activity activity) {
      this.activity = activity;
      this.tts = new TextToSpeech(activity.getApplicationContext(), status -> {
        if (status == TextToSpeech.SUCCESS && this.tts != null) {
          configureTts();
        }
      });
      configureTts();
    }

    @JavascriptInterface
    public String speak(String text) {
      return speakText(text, "en-GB");
    }

    @JavascriptInterface
    public String speakText(String text, String locale) {
      try {
        String spokenText = text == null ? "" : text.trim();
        if (spokenText.length() == 0) {
          return "{\"ok\":false,\"error\":\"empty text\"}";
        }

        AudioManager audioManager = (AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
        if (audioManager != null) {
          int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
          audioManager.setStreamMute(AudioManager.STREAM_MUSIC, false);
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, (int) (maxVolume * 0.45f)), 0);
        }

        ttsSpeaking = true;
        String utteranceId = "memory-companion-" + System.currentTimeMillis();
        activity.runOnUiThread(() -> {
          stopCurrentPlayer();
          if (tts != null) {
            tts.setLanguage(resolveLocale(locale));
            tts.setSpeechRate(0.9f);
            tts.setPitch(1.08f);
            int status = tts.speak(spokenText, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            if (status == TextToSpeech.ERROR) {
              ttsSpeaking = false;
            }
          } else {
            ttsSpeaking = false;
          }
        });
        Log.i(TAG, "Temi native text TTS started.");
        return "{\"ok\":true}";
      } catch (Exception error) {
        Log.e(TAG, "Temi native text TTS failed.", error);
        return "{\"ok\":false,\"error\":\"" + error.getClass().getSimpleName() + "\"}";
      }
    }

    @JavascriptInterface
    public boolean isSpeaking() {
      return ttsSpeaking;
    }

    private Locale resolveLocale(String locale) {
      if (locale != null && locale.toLowerCase(Locale.ROOT).startsWith("en-gb")) {
        return Locale.UK;
      }
      return Locale.US;
    }

    private void configureTts() {
      if (tts == null) {
        return;
      }
      tts.setLanguage(Locale.UK);
      tts.setSpeechRate(0.9f);
      tts.setPitch(1.08f);
      tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
          ttsSpeaking = true;
        }

        @Override
        public void onDone(String utteranceId) {
          ttsSpeaking = false;
        }

        @Override
        public void onError(String utteranceId) {
          ttsSpeaking = false;
        }
      });
    }

    @JavascriptInterface
    public String playBase64Audio(String base64Audio) {
      try {
        String encoded = base64Audio == null ? "" : base64Audio.trim();
        int commaIndex = encoded.indexOf(',');
        if (commaIndex >= 0) {
          encoded = encoded.substring(commaIndex + 1);
        }
        byte[] audioBytes = Base64.decode(encoded, Base64.DEFAULT);
        File output = File.createTempFile("memory-companion-audio", ".wav", activity.getCacheDir());
        FileOutputStream stream = new FileOutputStream(output);
        stream.write(audioBytes);
        stream.close();

        stopCurrentPlayer();
        AudioManager audioManager = (AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
        if (audioManager != null) {
          int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
          audioManager.setStreamMute(AudioManager.STREAM_MUSIC, false);
          audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, (int) (maxVolume * 0.45f)), 0);
        }
        player = new MediaPlayer();
        player.setAudioStreamType(AudioManager.STREAM_MUSIC);
        player.setVolume(0.65f, 0.65f);
        player.setDataSource(output.getAbsolutePath());
        player.setOnCompletionListener(done -> {
          stopCurrentPlayer();
          output.delete();
        });
        player.setOnErrorListener((failed, what, extra) -> {
          stopCurrentPlayer();
          output.delete();
          return true;
        });
        player.prepare();
        player.start();
        Log.i(TAG, "Temi native audio playback started: " + output.getAbsolutePath());
        return "{\"ok\":true}";
      } catch (Exception error) {
        Log.e(TAG, "Temi native audio playback failed.", error);
        return "{\"ok\":false,\"error\":\"" + error.getClass().getSimpleName() + "\"}";
      }
    }

    private void stopCurrentPlayer() {
      if (player == null) {
        return;
      }
      try {
        if (player.isPlaying()) {
          player.stop();
        }
      } catch (Exception ignored) {
      }
      try {
        player.release();
      } catch (Exception ignored) {
      }
      player = null;
    }

    private void shutdown() {
      stopCurrentPlayer();
      if (tts != null) {
        try {
          tts.stop();
          tts.shutdown();
        } catch (Exception ignored) {
        }
        tts = null;
      }
    }
  }
}
