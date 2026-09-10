// eink_frame: Wi-Fi picture frame firmware for the Waveshare ESP32-S3-ePaper-13.3E6.
//
// Every FRAME_POLL_MINUTES it downloads frame/schedule.json and frame/manifest.json from the
// GitHub repo, works out which image is due (schedule_logic.cpp), and if that differs from what
// the panel is showing, streams the 960,000-byte image into PSRAM, displays it, and puts the
// panel to sleep with its power rail off. NVS remembers the current image across reboots.
//
// Board: ESP32S3 Dev Module, USB CDC On Boot enabled, Flash 32MB, partition "32M Flash
// (4.8MB APP/22MB FATFS)", PSRAM "OPI PSRAM". Serial log on the CH343 port at 115200.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <time.h>

#include <string>
#include <vector>

#include "DEV_Config.h"
#include "EPD_13in3e.h"
#include "config.h"
#include "mbedtls/sha256.h"
#include "schedule_logic.h"
#include "secrets.h"

static const size_t BIN_SIZE = (size_t)EPD_13IN3E_WIDTH * EPD_13IN3E_HEIGHT / 2;  // 960,000

struct ManifestImage {
  std::string id;
  std::string bin;
  std::string sha256;
  size_t size;
};

// Declared up here because the Arduino preprocessor emits function prototypes before any type
// defined lower in the sketch.
struct CachedFile {
  String body;
  String etag;
};

static Preferences prefs;
static std::vector<ManifestImage> images;
static Schedule schedule;
static uint8_t* imageBuffer = nullptr;
static uint32_t lastPollMs = 0;
static bool firstPoll = true;
static int consecutiveFailures = 0;

// ---------------------------------------------------------------- helpers

static void logf(const char* fmt, ...) {
  char line[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(line, sizeof(line), fmt, args);
  va_end(args);
  time_t now = time(nullptr);
  struct tm local;
  localtime_r(&now, &local);
  if (now > 1000000000) {
    printf("[%02d:%02d:%02d] %s\r\n", local.tm_hour, local.tm_min, local.tm_sec, line);
  } else {
    printf("[boot+%lus] %s\r\n", (unsigned long)(millis() / 1000), line);
  }
}

static bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  logf("wifi: connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < FRAME_WIFI_TIMEOUT_MS) {
    delay(250);
  }
  if (WiFi.status() != WL_CONNECTED) {
    logf("wifi: failed (status %d)", (int)WiFi.status());
    return false;
  }
  logf("wifi: connected, ip %s, rssi %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

static bool syncTime() {
  if (time(nullptr) > 1000000000) return true;
  configTzTime(FRAME_TZ_POSIX_DEFAULT, FRAME_NTP_SERVER_1, FRAME_NTP_SERVER_2);
  uint32_t start = millis();
  while (time(nullptr) < 1000000000 && millis() - start < 30000) delay(200);
  if (time(nullptr) < 1000000000) {
    logf("time: NTP sync failed");
    return false;
  }
  logf("time: synced, unix %ld", (long)time(nullptr));
  return true;
}

static void applyTimezone(const std::string& tzPosix) {
  const char* tz = tzPosix.empty() ? FRAME_TZ_POSIX_DEFAULT : tzPosix.c_str();
  const char* current = getenv("TZ");
  if (!current || strcmp(current, tz) != 0) {
    setenv("TZ", tz, 1);
    tzset();
    logf("time: timezone %s", tz);
  }
}

static bool httpGetString(const String& url, String& out) {
  NetworkClientSecure client;
  client.setInsecure();  // TODO: pin the CA bundle once end-to-end works
  HTTPClient http;
  http.setTimeout(FRAME_HTTP_TIMEOUT_MS);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    logf("http: begin failed for %s", url.c_str());
    return false;
  }
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    logf("http: %d for %s", code, url.c_str());
    http.end();
    return false;
  }
  out = http.getString();
  http.end();
  return true;
}

// Fetches a small JSON file through the GitHub API with an ETag conditional request, so the
// content is fresh the moment it's committed and an unchanged file costs nothing against the
// rate limit. Falls back to the raw file server if the API is unavailable.
static bool fetchFresh(const char* name, CachedFile& cache) {
  {
    NetworkClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setTimeout(FRAME_HTTP_TIMEOUT_MS);
    http.setReuse(false);
    String url = String(FRAME_API_BASE) + name + "?ref=" FRAME_API_REF;
    if (http.begin(client, url)) {
      http.addHeader("Accept", "application/vnd.github.raw+json");
      http.addHeader("X-GitHub-Api-Version", "2022-11-28");
      if (cache.etag.length()) http.addHeader("If-None-Match", cache.etag);
      const char* keys[] = {"ETag"};
      http.collectHeaders(keys, 1);
      int code = http.GET();
      if (code == HTTP_CODE_NOT_MODIFIED && cache.body.length()) {
        http.end();
        return true;
      }
      if (code == HTTP_CODE_OK) {
        cache.body = http.getString();
        cache.etag = http.header("ETag");
        http.end();
        return true;
      }
      logf("api: %d for %s, falling back to raw", code, name);
      http.end();
    }
  }
  String body;
  if (!httpGetString(String(FRAME_RAW_BASE) + name, body)) return false;
  cache.body = body;
  cache.etag = "";
  return true;
}

static bool httpGetBuffer(const String& url, uint8_t* buf, size_t expect) {
  NetworkClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(FRAME_HTTP_TIMEOUT_MS);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    logf("http: begin failed for %s", url.c_str());
    return false;
  }
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    logf("http: %d for %s", code, url.c_str());
    http.end();
    return false;
  }
  int declared = http.getSize();
  if (declared > 0 && (size_t)declared != expect) {
    logf("http: size %d, expected %u", declared, (unsigned)expect);
    http.end();
    return false;
  }
  NetworkClient* stream = http.getStreamPtr();
  size_t got = 0;
  uint32_t lastData = millis();
  while (got < expect) {
    size_t avail = stream->available();
    if (avail > 0) {
      size_t want = min(avail, expect - got);
      int n = stream->readBytes(buf + got, want);
      if (n > 0) {
        got += (size_t)n;
        lastData = millis();
      }
    } else {
      if (!http.connected() && stream->available() == 0) break;
      if (millis() - lastData > FRAME_HTTP_TIMEOUT_MS) {
        logf("http: stalled after %u bytes", (unsigned)got);
        break;
      }
      delay(2);
    }
  }
  http.end();
  if (got != expect) {
    logf("http: got %u of %u bytes", (unsigned)got, (unsigned)expect);
    return false;
  }
  return true;
}

static String sha256Hex(const uint8_t* data, size_t len) {
  unsigned char digest[32];
  mbedtls_sha256(data, len, digest, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", digest[i]);
  hex[64] = 0;
  return String(hex);
}

// ---------------------------------------------------------------- parsing

static bool parseSchedule(const String& json, Schedule& s) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    logf("schedule: json error %s", err.c_str());
    return false;
  }
  Schedule out;
  out.mode = doc["mode"] | "rotate";
  out.interval_hours = doc["interval_hours"] | 6.0;
  out.order = doc["order"] | "upload";
  out.shuffle_seed = doc["shuffle_seed"] | 1;
  out.epoch_unix = doc["epoch_unix"] | (int64_t)0;
  out.tz_posix = doc["tz_posix"] | "";
  out.min_refresh_minutes = doc["min_refresh_minutes"] | 30;
  out.single_image_id = doc["single_image_id"] | "";
  JsonObject quiet = doc["quiet_hours"];
  if (!quiet.isNull()) {
    out.quiet_start_min = parseHHMM(quiet["start"] | "");
    out.quiet_end_min = parseHHMM(quiet["end"] | "");
  }
  for (JsonObject p : doc["pins"].as<JsonArray>()) {
    PinRule rule;
    rule.image_id = p["image_id"] | "";
    rule.date = p["date"] | "";
    rule.days_mask = 0;
    for (int d : p["days"].as<JsonArray>()) {
      if (d >= 0 && d <= 6) rule.days_mask |= (uint8_t)(1u << d);
    }
    rule.start_min = parseHHMM(p["start"] | "");
    rule.end_min = parseHHMM(p["end"] | "");
    if (!rule.image_id.empty()) out.pins.push_back(rule);
  }
  JsonObject showNow = doc["show_now"];
  if (!showNow.isNull()) {
    out.show_now_id = showNow["image_id"] | "";
    out.show_now_at = showNow["at_unix"] | (int64_t)0;
  }
  s = out;
  return true;
}

static bool parseManifest(const String& json, std::vector<ManifestImage>& out) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    logf("manifest: json error %s", err.c_str());
    return false;
  }
  std::vector<ManifestImage> list;
  for (JsonObject im : doc["images"].as<JsonArray>()) {
    ManifestImage entry;
    entry.id = im["id"] | "";
    entry.bin = im["bin"] | "";
    entry.sha256 = im["bin_sha256"] | "";
    entry.size = im["size"] | (size_t)0;
    if (!entry.id.empty() && !entry.bin.empty()) list.push_back(entry);
  }
  out = list;
  return true;
}

// ---------------------------------------------------------------- display

static void showImage(const uint8_t* buf) {
  logf("panel: init");
  DEV_Module_Init();  // panel rail on, pins configured
  EPD_13IN3E_Init();
  logf("panel: refreshing (about 30 s)");
  EPD_13IN3E_Display(buf);
  EPD_13IN3E_Sleep();
  DEV_Module_Exit();  // panel rail off
  logf("panel: done, sleeping");
}

// ---------------------------------------------------------------- poll

static bool poll() {
  if (!connectWiFi()) return false;
  if (!syncTime()) return false;

  static CachedFile scheduleFile, manifestFile;
  if (!fetchFresh("schedule.json", scheduleFile)) return false;
  if (!parseSchedule(scheduleFile.body, schedule)) return false;
  applyTimezone(schedule.tz_posix);

  if (!fetchFresh("manifest.json", manifestFile)) return false;
  if (!parseManifest(manifestFile.body, images)) return false;

  std::vector<std::string> ids;
  ids.reserve(images.size());
  for (const ManifestImage& im : images) ids.push_back(im.id);

  time_t now = time(nullptr);
  struct tm local;
  localtime_r(&now, &local);
  const char* reason = "";
  std::string due = dueImage(schedule, ids, (int64_t)now, local, &reason);
  String current = prefs.getString("current", "");
  uint32_t lastRefresh = prefs.getULong("last_refresh", 0);

  logf("poll: %u images, due=%s (%s), showing=%s", (unsigned)images.size(),
       due.empty() ? "-" : due.c_str(), reason, current.length() ? current.c_str() : "-");

  if (due.empty() || due == current.c_str()) return true;

  if (inQuietHours(schedule, local)) {
    logf("poll: quiet hours, not refreshing");
    return true;
  }
  // A deliberate "show now" only waits for the panel's safety floor; scheduled changes respect
  // the schedule's own minimum spacing.
  bool urgent = strcmp(reason, "show-now") == 0;
  int minRefresh = urgent ? FRAME_URGENT_FLOOR_MIN : max(schedule.min_refresh_minutes, FRAME_MIN_REFRESH_FLOOR_MIN);
  if (lastRefresh > 0 && (uint32_t)now > lastRefresh && (uint32_t)now - lastRefresh < (uint32_t)minRefresh * 60u) {
    logf("poll: last refresh %lu s ago, waiting for the %d min minimum",
         (unsigned long)((uint32_t)now - lastRefresh), minRefresh);
    return true;
  }

  const ManifestImage* target = nullptr;
  for (const ManifestImage& im : images) {
    if (im.id == due) { target = &im; break; }
  }
  if (!target) return true;
  if (target->size != 0 && target->size != BIN_SIZE) {
    logf("poll: manifest size %u for %s is not %u, skipping", (unsigned)target->size, target->id.c_str(), (unsigned)BIN_SIZE);
    return true;
  }

  logf("download: %s", target->bin.c_str());
  if (!httpGetBuffer(String(FRAME_RAW_BASE) + target->bin.c_str(), imageBuffer, BIN_SIZE)) return false;
  if (!target->sha256.empty()) {
    String actual = sha256Hex(imageBuffer, BIN_SIZE);
    if (actual != target->sha256.c_str()) {
      logf("download: sha256 mismatch (%s vs %s)", actual.substring(0, 12).c_str(), target->sha256.substr(0, 12).c_str());
      return false;
    }
  }
  logf("download: ok, 960000 bytes verified");

  showImage(imageBuffer);
  prefs.putString("current", due.c_str());
  prefs.putULong("last_refresh", (uint32_t)time(nullptr));
  logf("now showing %s", due.c_str());
  return true;
}

// ---------------------------------------------------------------- arduino

void setup() {
  delay(300);
  printf("\r\n=== eink_frame starting ===\r\n");
  prefs.begin("frame", false);
  imageBuffer = (uint8_t*)ps_malloc(BIN_SIZE);
  if (!imageBuffer) {
    printf("FATAL: could not allocate %u bytes in PSRAM\r\n", (unsigned)BIN_SIZE);
    while (true) delay(1000);
  }
  pinMode(EPD_PWR_PIN, OUTPUT);
  digitalWrite(EPD_PWR_PIN, LOW);  // keep the panel rail off until an image is ready
  setenv("TZ", FRAME_TZ_POSIX_DEFAULT, 1);
  tzset();
  logf("boot: psram %u KB free, showing=%s", (unsigned)(ESP.getFreePsram() / 1024), prefs.getString("current", "-").c_str());
}

void loop() {
  uint32_t interval = firstPoll ? 0 : (uint32_t)FRAME_POLL_MINUTES * 60000u;
  if (consecutiveFailures > 0) interval = min(interval, 60000u * (uint32_t)min(consecutiveFailures, 5));
  if (firstPoll || millis() - lastPollMs >= interval) {
    firstPoll = false;
    lastPollMs = millis();
    bool ok = poll();
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    if (!ok) logf("poll: failed (%d in a row)", consecutiveFailures);
    if (consecutiveFailures >= FRAME_FAILURES_BEFORE_RESTART) {
      logf("too many failures, restarting");
      delay(500);
      ESP.restart();
    }
  }
  delay(1000);
}
