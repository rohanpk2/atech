// AtechCloudOta.cpp: see AtechCloudOta.h. Wire format and canonical strings
// are shared with builder/lib/cloud-auth.js and builder/lib/cloud-routes.js;
// keep them byte-identical.
#include "AtechCloudOta.h"
#include "AtechImageSink.h"

#include <AtechCore.h>
#include <HTTPClient.h>
#include <NetworkClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <mbedtls/md.h>

#include <algorithm>
#include <cstring>

namespace {

// Embedded so the backend can prove every image carries the agent (jobs.js AGENT_MARKER).
const char AGENT_MARKER[] = "ATECH-CLOUD-AGENT:1";
const char LOGIN_PREFIX[] = "atech-cloud-login/1\n";
constexpr uint32_t TASK_STACK = 12288;
constexpr uint32_t LOOP_DELAY_MS = 250;
constexpr uint32_t BACKOFF_MIN_MS = 5000;
constexpr uint32_t BACKOFF_MAX_MS = 120000;
constexpr uint32_t UNCLAIMED_BACKOFF_MS = 30000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 10000;
constexpr uint32_t READ_TIMEOUT_MS = 15000;
constexpr uint32_t HANDSHAKE_TIMEOUT_S = 30;
constexpr uint32_t APP_LOOP_WAIT_MS = 15000;
constexpr uint32_t REBOOT_DELAY_MS = 1500;
constexpr size_t READ_BUFFER_BYTES = 4096;
constexpr size_t MAX_URL_LENGTH = 120;
constexpr uint8_t MAX_TRANSPORT_FAILURES = 5;
constexpr TickType_t LOCK_WAIT = pdMS_TO_TICKS(200);

enum class State : uint8_t { Disabled, WaitingWifi, Unclaimed, Idle, Downloading, Installing, Rebooting, Confirming, Error };

const char *stateText(State state) {
  switch (state) {
    case State::Disabled: return "disabled";
    case State::WaitingWifi: return "waiting_wifi";
    case State::Unclaimed: return "unclaimed";
    case State::Idle: return "idle";
    case State::Downloading: return "downloading";
    case State::Installing: return "installing";
    case State::Rebooting: return "rebooting";
    case State::Confirming: return "confirming";
    default: return "error";
  }
}

const char HEX_DIGITS[] = "0123456789abcdef";

String hexEncode(const uint8_t *bytes, size_t length) {
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out += HEX_DIGITS[bytes[i] >> 4];
    out += HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

bool hmacSha256Hex(const String &key, const String &message, String &out) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  uint8_t digest[32] = {};
  if (mbedtls_md_hmac(info, reinterpret_cast<const uint8_t *>(key.c_str()), key.length(),
                      reinterpret_cast<const uint8_t *>(message.c_str()), message.length(), digest) != 0) {
    return false;
  }
  out = hexEncode(digest, sizeof(digest));
  return true;
}

// application/x-www-form-urlencoded value.
String formEncode(const String &text) {
  String out;
  out.reserve(text.length() + 8);
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') out += c;
    else { out += '%'; out += HEX_DIGITS[static_cast<uint8_t>(c) >> 4]; out += HEX_DIGITS[static_cast<uint8_t>(c) & 0x0f]; }
  }
  return out;
}

String jsonEscape(const String &input) {
  String output;
  output.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); ++i) {
    const char c = input[i];
    switch (c) {
      case '\\': output += F("\\\\"); break;
      case '"': output += F("\\\""); break;
      case '\n': output += F("\\n"); break;
      case '\r': output += F("\\r"); break;
      case '\t': output += F("\\t"); break;
      default: if (static_cast<uint8_t>(c) >= 0x20) output += c; break;
    }
  }
  return output;
}

// One key=value per line (builder/lib/cloud-auth.js encodeKv). Returns "" when absent.
String kvGet(const String &body, const char *key) {
  const size_t keyLength = strlen(key);
  size_t at = 0;
  while (at < body.length()) {
    int end = body.indexOf('\n', at);
    if (end < 0) end = body.length();
    if (static_cast<size_t>(end) - at > keyLength && body[at + keyLength] == '=' && strncmp(body.c_str() + at, key, keyLength) == 0) {
      String value = body.substring(at + keyLength + 1, end);
      if (value.endsWith("\r")) value.remove(value.length() - 1);
      return value;
    }
    at = end + 1;
  }
  return String();
}

bool validUrl(const String &url, bool allowHttp) {
  if (url.isEmpty() || url.length() > MAX_URL_LENGTH) return false;
  for (size_t i = 0; i < url.length(); ++i) {
    const char c = url[i];
    if (c <= ' ' || c == '"' || c == '\'' || c == '\\' || static_cast<uint8_t>(c) >= 0x7f) return false;
  }
  if (url.startsWith("https://")) return url.length() > 8;
  if (allowHttp && url.startsWith("http://")) return url.length() > 7;
  return false;
}

}  // namespace

struct AtechCloudOta::Impl {
  AtechCloudOtaConfig config = {};
  String imageIdentity;
  String preferencesNamespace;
  String storedUrl;         // agent task only; the portal posts changes through pendingUrl
  String defaultUrl;
  String error;             // written under lock (setState/setError), read under lock
  String configError;       // loop task only: the last setServerUrl/clearServerUrl failure
  bool initialized = false;
  bool allowHttp = false;
  // Configuration handed from the loop task (hotspot portal) to the agent task, under lock.
  bool configPending = false;
  String pendingUrl;

  // Agent task state (guarded by lock when read from other tasks).
  SemaphoreHandle_t lock = nullptr;
  TaskHandle_t task = nullptr;
  State state = State::Disabled;
  String session;
  uint32_t pollMs = 15000;
  uint32_t nextPollAt = 0;
  uint32_t backoffMs = BACKOFF_MIN_MS;
  uint32_t lastLoginAttemptMs = 0;
  uint32_t lastContactMs = 0;
  uint32_t loginFailures = 0;

  // Boot marker: the job the previous boot installed, persisted before the restart.
  String markerJob;
  String markerBuild;
  String doneJob;
  volatile bool holdConfirm = false;
  bool bootAcknowledged = false;
  uint32_t bootMs = 0;

  // Active job.
  volatile bool transferring = false;
  String jobId;
  uint32_t jobTotal = 0;
  uint32_t jobReceived = 0;
  uint32_t jobStartedMs = 0;
  atech::ImageSink sink;

  // One TLS client, one plain client for lab builds; never two TLS sessions at once.
  NetworkClientSecure secure;
  NetworkClient plain;
  HTTPClient http;
  uint8_t *buffer = nullptr;

  ~Impl() {
    if (task) vTaskDelete(task);
    if (buffer) free(buffer);
    if (lock) vSemaphoreDelete(lock);
  }

  bool take() const { return lock && xSemaphoreTake(lock, LOCK_WAIT) == pdTRUE; }
  void give() const { if (lock) xSemaphoreGive(lock); }

  void setState(State next, const String &message = String()) {
    const bool locked = take();
    state = next;
    if (!message.isEmpty() || next == State::Error) error = message;
    if (locked) give();
  }

  // Strings statusJson() reads from other tasks are only ever assigned under the lock.
  void setError(const String &message) { const bool locked = take(); error = message; if (locked) give(); }
  void setSession(const String &token) { const bool locked = take(); session = token; if (locked) give(); }
  void setJob(const String &job) { const bool locked = take(); jobId = job; if (locked) give(); }

  // Applies a URL change posted by the portal: drop the kept-alive connection (HTTPClient would
  // keep talking to the old host) and the session, then log in afresh.
  void applyPendingConfig() {
    String url;
    bool pending = false;
    if (take()) {
      if (configPending) { pending = true; url = pendingUrl; configPending = false; }
      give();
    }
    if (!pending) return;
    http.end();
    secure.stop();
    plain.stop();
    if (take()) { storedUrl = url; give(); } else storedUrl = url;
    setSession(String());
    lastLoginAttemptMs = 0;
    backoffMs = BACKOFF_MIN_MS;
    loginFailures = 0;
    Serial.printf("[cloud] server URL is now %s\n", effectiveUrl().c_str());
  }

  // ---- persistence ----------------------------------------------------------------------

  bool loadPreferences() {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), true)) {
      preferences.end();
      if (!preferences.begin(preferencesNamespace.c_str(), false)) { error = F("Could not open cloud OTA storage"); return false; }
    }
    storedUrl = preferences.getString("url", "");
    markerJob = preferences.getString("job", "");
    markerBuild = preferences.getString("expect", "");
    doneJob = preferences.getString("done", "");
    preferences.end();
    return true;
  }

  bool putString(const char *key, const String &value) {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
    bool ok;
    if (value.isEmpty()) { preferences.remove(key); ok = true; }
    else ok = preferences.putString(key, value) == value.length();
    preferences.end();
    return ok;
  }

  bool writeMarker(const String &job, const String &build) {
    const bool locked = take();
    markerJob = job;
    markerBuild = build;
    if (locked) give();
    return putString("job", job) && putString("expect", build);
  }

  void clearMarker() {
    const bool locked = take();
    markerJob = "";
    markerBuild = "";
    if (locked) give();
    putString("job", "");
    putString("expect", "");
    holdConfirm = false;
    bootAcknowledged = true;
  }

  String effectiveUrl() const { return storedUrl.isEmpty() ? defaultUrl : storedUrl; }
  bool enabled() const { return !effectiveUrl().isEmpty(); }
  bool usesTls() const { return effectiveUrl().startsWith("https://"); }

  // ---- HTTP ------------------------------------------------------------------------------

  NetworkClient &client() { return usesTls() ? static_cast<NetworkClient &>(secure) : plain; }

  bool open(const String &path) {
    http.setReuse(true);
    http.setConnectTimeout(CONNECT_TIMEOUT_MS);
    http.setTimeout(READ_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setUserAgent(String("AtechCloudOta/1 (") + atech::deviceId() + ")");
    if (!http.begin(client(), effectiveUrl() + path)) { setError(F("Could not prepare the request")); return false; }
    if (!session.isEmpty()) http.addHeader("Authorization", "Bearer " + session);
    return true;
  }

  // Small request with a text answer. Returns the HTTP status, or a negative HTTPClient error.
  int exchange(const char *method, const String &path, const String &body, String &response) {
    if (!open(path)) return HTTPC_ERROR_CONNECTION_REFUSED;
    int status;
    if (strcmp(method, "POST") == 0) {
      http.addHeader("Content-Type", "application/x-www-form-urlencoded");
      status = http.POST(body);
    } else {
      status = http.GET();
    }
    response = status > 0 ? http.getString() : String();
    http.end();
    if (status > 0) lastContactMs = millis();
    if (status == 401 && !session.isEmpty()) {
      Serial.println(F("[cloud] session rejected; logging in again"));
      setSession(String());
    }
    return status;
  }

  // ---- identity ----------------------------------------------------------------------------

  String identityFields() const {
    String body;
    body.reserve(360);
    body += F("demo="); body += String(config.demo);
    body += F("&fw="); body += formEncode(config.firmwareVersion ? config.firmwareVersion : "");
    body += F("&build="); body += formEncode(atech::buildId());
    body += F("&app="); body += formEncode(config.appName ? config.appName : "");
    body += F("&ver="); body += String(config.appVersion);
    const esp_partition_t *running = esp_ota_get_running_partition();
    body += F("&slot_size="); body += String(running ? running->size : 0);
    body += F("&core="); body += formEncode(atech::coreVersion());
    body += F("&agent="); body += AGENT_MARKER + sizeof("ATECH-CLOUD-AGENT:") - 1;
    body += F("&pending="); body += atech::rollbackPending() ? '1' : '0';
    body += F("&safe="); body += atech::safeMode() ? '1' : '0';
    body += F("&up="); body += String(millis());
    body += F("&loops="); body += String(atech::appLoops());
    body += F("&rssi="); body += String(WiFi.RSSI());
    body += F("&heap="); body += String(esp_get_free_internal_heap_size());
    body += F("&heap_min="); body += String(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    body += F("&state="); body += stateText(state);
    if (!markerJob.isEmpty() && !bootAcknowledged) {
      body += F("&boot_job="); body += formEncode(markerJob);
      body += F("&boot_build="); body += formEncode(markerBuild);
    }
    return body;
  }

  // ---- login -------------------------------------------------------------------------------

  bool login() {
    String response;
    int status = exchange("GET", String("/api/device/challenge?id=") + atech::deviceId(), String(), response);
    if (status != 200) { setState(State::Error, status > 0 ? "challenge answered HTTP " + String(status) : HTTPClient::errorToString(status)); return false; }
    const String nonce = kvGet(response, "nonce");
    if (nonce.length() != 32) { setState(State::Error, F("challenge carried no nonce")); return false; }
    const String token = config.authToken ? config.authToken() : String();
    if (token.length() < 16) { setState(State::Error, F("no pairing token available")); return false; }
    String message = LOGIN_PREFIX;
    message += atech::deviceId(); message += '\n';
    String nonceLower = nonce; nonceLower.toLowerCase();
    message += nonceLower; message += '\n';
    String proof;
    if (!hmacSha256Hex(token, message, proof)) { setState(State::Error, F("HMAC failed")); return false; }
    String body = "id="; body += atech::deviceId();
    body += "&nonce="; body += nonceLower;
    body += "&proof="; body += proof;
    body += '&'; body += identityFields();
    setSession(String());
    status = exchange("POST", String("/api/device/login"), body, response);
    if (status == 200 && kvGet(response, "session").length() == 48) {
      setSession(kvGet(response, "session"));
      const uint32_t poll = kvGet(response, "poll").toInt();
      if (poll >= 1000 && poll <= 600000) pollMs = poll;
      loginFailures = 0;
      setState(State::Idle, String());
      Serial.printf("[cloud] logged in to %s (poll every %lu ms)\n", effectiveUrl().c_str(), static_cast<unsigned long>(pollMs));
      return true;
    }
    if (status == 403 && kvGet(response, "code") == "unclaimed") {
      setState(State::Unclaimed, F("waiting to be claimed in the dashboard"));
      return false;
    }
    if (status == 401 && kvGet(response, "code") == "nonce") { setState(State::Error, F("login challenge expired; retrying")); return false; }
    if (status == 401) { setState(State::Error, F("the backend rejected this board's pairing token")); return false; }
    setState(State::Error, status > 0 ? "login answered HTTP " + String(status) + " " + kvGet(response, "error") : HTTPClient::errorToString(status));
    return false;
  }

  // ---- status reports ------------------------------------------------------------------------

  int report(const String &job, const char *phase, uint32_t received, uint32_t total, const String &failure = String()) {
    String body = "phase="; body += phase;
    body += "&received="; body += String(received);
    body += "&total="; body += String(total);
    body += "&error="; body += formEncode(failure);
    body += "&elapsed="; body += String(millis() - jobStartedMs);
    body += "&build="; body += formEncode(atech::buildId());
    body += "&heap="; body += String(esp_get_free_internal_heap_size());
    body += "&heap_min="; body += String(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    String response;
    const int status = exchange("POST", String("/api/device/jobs/") + job + "/status", body, response);
    if (status != 200) Serial.printf("[cloud] status report %s not accepted (%d)\n", phase, status);
    return status;
  }

  // ---- download ----------------------------------------------------------------------------

  enum class ChunkResult { Ok, Retry, Fatal, Restart };

  ChunkResult fetchChunk(const String &path, uint32_t offset, uint32_t end, uint32_t total, String &reason) {
    if (!open(path)) { reason = error; return ChunkResult::Retry; }
    http.addHeader("Range", "bytes=" + String(offset) + "-" + String(end));
    const int status = http.GET();
    if (status <= 0) { http.end(); reason = HTTPClient::errorToString(status); return ChunkResult::Retry; }
    lastContactMs = millis();
    if (status == 401) { http.end(); setSession(String()); reason = F("session expired"); return ChunkResult::Retry; }
    if (status == 403 || status == 404 || status == 409 || status == 410) {
      const String body = http.getString();
      http.end();
      reason = kvGet(body, "error");
      if (reason.isEmpty()) reason = "download refused (HTTP " + String(status) + ")";
      return ChunkResult::Fatal;
    }
    if (status == 200 && offset != 0) { http.end(); reason = F("server ignored the range; restarting the download"); return ChunkResult::Restart; }
    if (status != 206 && status != 200) { http.end(); reason = "chunk answered HTTP " + String(status); return ChunkResult::Retry; }
    const uint32_t expected = status == 200 ? total : end - offset + 1;
    if (http.getSize() != static_cast<int>(expected)) { http.end(); reason = "unexpected chunk length " + String(http.getSize()); return ChunkResult::Retry; }
    NetworkClient *stream = http.getStreamPtr();
    uint32_t remaining = expected;
    uint32_t lastData = millis();
    while (remaining > 0) {
      const int available = stream->available();
      if (available <= 0) {
        if (!stream->connected()) { http.end(); reason = F("connection lost during the download"); return ChunkResult::Retry; }
        if (millis() - lastData > READ_TIMEOUT_MS) { http.end(); reason = F("download stalled"); return ChunkResult::Retry; }
        vTaskDelay(pdMS_TO_TICKS(5));
        continue;
      }
      const size_t want = std::min<size_t>(std::min<size_t>(available, READ_BUFFER_BYTES), remaining);
      const int read = stream->read(buffer, want);
      if (read <= 0) continue;
      lastData = millis();
      if (!sink.write(buffer, static_cast<size_t>(read), reason)) { http.end(); return ChunkResult::Fatal; }
      remaining -= static_cast<uint32_t>(read);
      jobReceived = sink.received();
    }
    http.end();
    return ChunkResult::Ok;
  }

  void releaseJob(bool resumeApp) {
    sink.abort();
    atech::coreReleaseOta("cloud");
    if (resumeApp) atech::coreResumeApp();
    transferring = false;
    setJob(String());
  }

  void failJob(const String &job, const String &reason, uint32_t total) {
    Serial.printf("[cloud] job %s failed: %s\n", job.c_str(), reason.c_str());
    setState(State::Error, reason);
    report(job, "failed", sink.received(), total, reason);
    releaseJob(true);
  }

  void runJob(const String &response) {
    const String job = kvGet(response, "job");
    const String build = kvGet(response, "build");
    const String sha = kvGet(response, "sha256");
    const String path = kvGet(response, "url");
    const uint32_t total = static_cast<uint32_t>(kvGet(response, "size").toInt());
    const uint32_t demo = static_cast<uint32_t>(kvGet(response, "demo").toInt());
    uint32_t chunk = static_cast<uint32_t>(kvGet(response, "chunk").toInt());
    if (chunk < 4096 || chunk > 1024 * 1024) chunk = config.chunkBytes;
    jobStartedMs = millis();
    if (demo != config.demo) { report(job, "failed", 0, total, "Job is for Demo " + String(demo) + "; this board is Demo " + String(config.demo)); return; }
    if (job == doneJob) { report(job, "failed", 0, total, F("Job already applied on this board")); return; }
    if (!path.startsWith("/api/device/jobs/")) { report(job, "failed", 0, total, F("Job carried no download path")); return; }
    if (config.otherOtaBusy && config.otherOtaBusy()) return;   // the backend offers it again on the next poll
    if (!atech::coreTryAcquireOta("cloud")) return;
    transferring = true;
    setJob(job);
    jobTotal = total;
    jobReceived = 0;
    atech::coreSuspendApp();
    setState(State::Downloading, String());
    String reason;
    if (!sink.begin(total, sha, build, imageIdentity, reason)) { failJob(job, reason, total); return; }
    Serial.printf("[cloud] job %s: %lu bytes of build %s into %s\n", job.c_str(), static_cast<unsigned long>(total), build.c_str(), sink.partitionLabel());
    uint8_t failures = 0;
    report(job, "downloading", 0, total);
    while (sink.received() < total) {
      const uint32_t offset = sink.received();
      const uint32_t end = std::min(total, offset + chunk) - 1;
      const ChunkResult result = fetchChunk(path, offset, end, total, reason);
      if (result == ChunkResult::Fatal) { failJob(job, reason, total); return; }
      if (result == ChunkResult::Restart || result == ChunkResult::Retry) {
        if (++failures > MAX_TRANSPORT_FAILURES) { failJob(job, "download failed after " + String(failures) + " attempts: " + reason, total); return; }
        Serial.printf("[cloud] download interrupted at %lu bytes (%s); retrying\n", static_cast<unsigned long>(offset), reason.c_str());
        if (result == ChunkResult::Restart && !sink.begin(total, sha, build, imageIdentity, reason)) { failJob(job, reason, total); return; }
        vTaskDelay(pdMS_TO_TICKS(500u * failures));
        if (session.isEmpty() && !login()) continue;
        continue;
      }
      report(job, "downloading", sink.received(), total);
    }
    setState(State::Installing, String());
    report(job, "installing", total, total);
    if (!sink.finish(reason)) { failJob(job, reason, total); return; }
    if (!writeMarker(job, build)) {
      // Without the marker the next boot could never report back; do not boot the image.
      failJob(job, F("Could not persist the reboot marker"), total);
      return;
    }
    Serial.printf("[cloud] job %s verified (SHA-256 %s); rebooting into %s\n", job.c_str(), sink.digestHex().c_str(), sink.partitionLabel());
    setState(State::Rebooting, String());
    report(job, "rebooting", total, total);
    transferring = false;
    Serial.flush();
    vTaskDelay(pdMS_TO_TICKS(REBOOT_DELAY_MS));
    ESP.restart();
  }

  // ---- boot acknowledgment --------------------------------------------------------------------

  void rollbackNow(const char *why) {
    Serial.printf("[cloud] rolling back: %s\n", why);
    Serial.flush();
    if (atech::rollbackPending()) {
      esp_ota_mark_app_invalid_rollback_and_reboot();
    } else if (atech::canRollback() && atech::rollbackToPrevious()) {
      vTaskDelay(pdMS_TO_TICKS(500));
      ESP.restart();
    }
    clearMarker();
  }

  void handleAck(const String &job, const String &action) {
    if (job != markerJob) return;
    if (action == "confirm") {
      setState(State::Confirming, String());
      const uint32_t start = millis();
      while (atech::appLoops() == 0 && !atech::safeMode() && millis() - start < APP_LOOP_WAIT_MS) vTaskDelay(pdMS_TO_TICKS(100));
      if (atech::safeMode() || atech::appLoops() == 0) {
        Serial.println(F("[cloud] acknowledged, but the app never ran; leaving the image pending"));
        return;   // the confirm timeout rolls back
      }
      if (!atech::confirmBoot()) { setState(State::Error, F("confirm failed")); return; }
      // The marker stays until the backend has the success report: a lost report is repeated on
      // the next poll (the backend answers confirm again; confirming twice is harmless).
      if (report(job, "succeeded", jobTotal, jobTotal) != 200) { Serial.println(F("[cloud] success report not delivered; will repeat")); return; }
      doneJob = job;
      putString("done", job);
      clearMarker();
      setState(State::Idle, String());
      Serial.println(F("[cloud] boot confirmed by the backend acknowledgment"));
    } else if (action == "rollback") {
      rollbackNow("the backend refused the booted image");
    } else {
      clearMarker();
      setState(State::Idle, String());
    }
  }

  void checkConfirmTimeout() {
    if (!holdConfirm) return;
    if (millis() - bootMs < config.confirmTimeoutMs) return;
    if (atech::rollbackPending()) rollbackNow("no acknowledgment from the backend within the confirm timeout");
    else { Serial.println(F("[cloud] boot marker cleared; the image was confirmed elsewhere")); clearMarker(); }
  }

  // ---- poll ---------------------------------------------------------------------------------

  void poll() {
    const bool ready = !transferring && !(config.otherOtaBusy && config.otherOtaBusy()) && atech::coreOtaOwner()[0] == '\0';
    String body = identityFields();
    body += "&ready="; body += ready ? '1' : '0';
    body += "&transferring="; body += transferring ? '1' : '0';
    String response;
    const int status = exchange("POST", String("/api/device/poll"), body, response);
    if (status != 200) {
      if (status > 0 && status != 401) setState(State::Error, "poll answered HTTP " + String(status));
      else if (status <= 0) setState(State::Error, HTTPClient::errorToString(status));
      return;
    }
    const uint32_t poll = kvGet(response, "poll").toInt();
    if (poll >= 1000 && poll <= 600000) pollMs = poll;
    if (state == State::Error) setState(State::Idle, String());
    const String ack = kvGet(response, "ack");
    if (!ack.isEmpty()) handleAck(ack, kvGet(response, "action"));
    const String job = kvGet(response, "job");
    if (!job.isEmpty() && ready) runJob(response);
  }

  // ---- task ---------------------------------------------------------------------------------

  static void taskMain(void *arg) { static_cast<Impl *>(arg)->run(); }

  void run() {
    for (;;) {
      checkConfirmTimeout();   // first: a cloud image that cannot reach the cloud rolls back even without Wi-Fi
      applyPendingConfig();
      if (!enabled()) { if (state != State::Disabled) setState(State::Disabled, String()); vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
      if (!config.wifiConnected || !config.wifiConnected()) {
        if (state != State::WaitingWifi) { setState(State::WaitingWifi, String()); setSession(String()); }
        vTaskDelay(pdMS_TO_TICKS(1000));
        continue;
      }
      const uint32_t now = millis();
      if (session.isEmpty()) {
        if (lastLoginAttemptMs == 0 || now - lastLoginAttemptMs >= backoffMs) {
          lastLoginAttemptMs = now;
          if (login()) { backoffMs = BACKOFF_MIN_MS; nextPollAt = now; }
          else {
            loginFailures++;
            backoffMs = state == State::Unclaimed ? UNCLAIMED_BACKOFF_MS : std::min(BACKOFF_MAX_MS, BACKOFF_MIN_MS << std::min<uint32_t>(loginFailures, 5));
          }
        }
        vTaskDelay(pdMS_TO_TICKS(LOOP_DELAY_MS));
        continue;
      }
      if (static_cast<int32_t>(now - nextPollAt) >= 0) {
        nextPollAt = now + pollMs;
        poll();
      }
      vTaskDelay(pdMS_TO_TICKS(LOOP_DELAY_MS));
    }
  }
};

AtechCloudOta::AtechCloudOta() : _impl(new Impl()) {}
AtechCloudOta::~AtechCloudOta() { delete _impl; }

bool AtechCloudOta::begin(const AtechCloudOtaConfig &config) {
  if (!_impl || _impl->initialized) return _impl && _impl->initialized;
  Impl &impl = *_impl;
  impl.config = config;
  impl.imageIdentity = config.imageIdentity ? config.imageIdentity : "";
  impl.preferencesNamespace = config.preferencesNamespace ? config.preferencesNamespace : "atech_cloud";
  impl.defaultUrl = config.defaultUrl ? config.defaultUrl : "";
  impl.allowHttp = config.allowInsecureHttp;
  if (impl.config.pollIntervalMs < 1000) impl.config.pollIntervalMs = 15000;
  if (impl.config.confirmTimeoutMs < 30000) impl.config.confirmTimeoutMs = 180000;
  if (impl.config.chunkBytes < 4096) impl.config.chunkBytes = 131072;
  impl.pollMs = impl.config.pollIntervalMs;
  if (impl.imageIdentity.length() < 8) { impl.error = F("Image identity marker must contain at least 8 characters"); return false; }
  impl.lock = xSemaphoreCreateMutex();
  if (!impl.lock) { impl.error = F("Could not create the cloud OTA lock"); return false; }
  if (!impl.loadPreferences()) return false;
  while (impl.defaultUrl.endsWith("/")) impl.defaultUrl.remove(impl.defaultUrl.length() - 1);
  if (!impl.defaultUrl.isEmpty() && !validUrl(impl.defaultUrl, impl.allowHttp)) {
    Serial.printf("[cloud] compiled-in server URL rejected: %s\n", impl.defaultUrl.c_str());
    impl.defaultUrl = "";
  }
  if (!impl.storedUrl.isEmpty() && !validUrl(impl.storedUrl, impl.allowHttp)) {
    Serial.printf("[cloud] stored server URL rejected: %s\n", impl.storedUrl.c_str());
    impl.storedUrl = "";
  }
  impl.buffer = static_cast<uint8_t *>(malloc(READ_BUFFER_BYTES));
  if (!impl.buffer) { impl.error = F("Could not allocate the download buffer"); return false; }
  impl.secure.useBuiltinCACertBundle();
  impl.secure.setHandshakeTimeout(HANDSHAKE_TIMEOUT_S);
  impl.bootMs = millis();
  if (!impl.markerJob.isEmpty()) {
    impl.holdConfirm = true;
    impl.bootAcknowledged = false;
    Serial.printf("[cloud] booted after cloud job %s (expected build %s, running %s); waiting for the backend's acknowledgment\n",
                  impl.markerJob.c_str(), impl.markerBuild.c_str(), atech::buildId());
  }
  if (impl.allowHttp) Serial.println(F("[cloud] WARNING: ATECH_CLOUD_ALLOW_HTTP is set; plain http:// server URLs are accepted (lab builds only)"));
  if (!impl.enabled()) Serial.println(F("[cloud] no server URL configured; set one on the hotspot portal or build with ATECH_CLOUD_URL"));
  else Serial.printf("[cloud] agent %s reporting to %s\n", AGENT_MARKER, impl.effectiveUrl().c_str());
  impl.initialized = true;
  if (xTaskCreatePinnedToCore(Impl::taskMain, "atech_cloud", TASK_STACK, &impl, 2, &impl.task, 0) != pdPASS) {
    impl.task = nullptr;
    impl.error = F("Could not start the cloud OTA task");
    return false;
  }
  return true;
}

void AtechCloudOta::loop() {}

bool AtechCloudOta::isEnabled() const { return _impl && _impl->initialized && _impl->enabled(); }
bool AtechCloudOta::isTransferring() const { return _impl && _impl->transferring; }
bool AtechCloudOta::holdsConfirm() const { return _impl && _impl->holdConfirm; }
String AtechCloudOta::serverUrl() const {
  if (!_impl) return String();
  const bool locked = _impl->take();
  const String url = _impl->effectiveUrl();
  if (locked) _impl->give();
  return url;
}
bool AtechCloudOta::hasStoredUrl() const {
  if (!_impl) return false;
  const bool locked = _impl->take();
  const bool stored = !_impl->storedUrl.isEmpty();
  if (locked) _impl->give();
  return stored;
}

// Called on the loop task (hotspot portal). The agent task applies the change on its next pass.
bool AtechCloudOta::setServerUrl(const String &url) {
  if (!_impl || !_impl->initialized) return false;
  if (_impl->transferring) { _impl->configError = F("A deployment is in progress; try again when it is done"); return false; }
  String trimmed = url;
  trimmed.trim();
  while (trimmed.endsWith("/")) trimmed.remove(trimmed.length() - 1);
  if (!validUrl(trimmed, _impl->allowHttp)) {
    _impl->configError = _impl->allowHttp ? F("Server URL must start with https:// or http://")
                                          : F("Server URL must start with https:// (the certificate is validated)");
    return false;
  }
  if (!_impl->putString("url", trimmed)) { _impl->configError = F("Could not store the server URL"); return false; }
  _impl->configError = "";
  if (_impl->take()) { _impl->pendingUrl = trimmed; _impl->configPending = true; _impl->give(); }
  else return false;
  Serial.printf("[cloud] server URL set to %s (applied by the agent task)\n", trimmed.c_str());
  return true;
}

bool AtechCloudOta::clearServerUrl() {
  if (!_impl || !_impl->initialized) return false;
  if (_impl->transferring) { _impl->configError = F("A deployment is in progress; try again when it is done"); return false; }
  if (!_impl->putString("url", String())) { _impl->configError = F("Could not clear the server URL"); return false; }
  _impl->configError = "";
  if (_impl->take()) { _impl->pendingUrl = ""; _impl->configPending = true; _impl->give(); }
  else return false;
  return true;
}

String AtechCloudOta::statusJson() const {
  if (!_impl) return String("{}");
  const Impl &impl = *_impl;
  String json;
  json.reserve(360);
  const bool locked = impl.take();
  json += F("{\"enabled\":"); json += impl.enabled() ? F("true") : F("false");
  json += F(",\"url\":\""); json += jsonEscape(impl.effectiveUrl());
  json += F("\",\"stored_url\":"); json += impl.storedUrl.isEmpty() ? F("false") : F("true");
  json += F(",\"default_url\":"); json += impl.defaultUrl.isEmpty() ? F("false") : F("true");
  json += F(",\"insecure_allowed\":"); json += impl.allowHttp ? F("true") : F("false");
  json += F(",\"state\":\""); json += stateText(impl.state);
  json += F("\",\"session\":"); json += impl.session.isEmpty() ? F("false") : F("true");
  json += F(",\"last_contact_ms\":"); json += String(impl.lastContactMs ? millis() - impl.lastContactMs : 0);
  json += F(",\"last_error\":\""); json += jsonEscape(impl.error);
  json += F("\",\"job\":\""); json += jsonEscape(impl.jobId);
  json += F("\",\"received\":"); json += String(impl.jobReceived);
  json += F(",\"total\":"); json += String(impl.jobTotal);
  json += F(",\"hold_confirm\":"); json += impl.holdConfirm ? F("true") : F("false");
  json += F(",\"marker_job\":\""); json += jsonEscape(impl.markerJob);
  json += F("\",\"heap\":"); json += String(esp_get_free_internal_heap_size());
  json += F("}");
  if (locked) impl.give();
  return json;
}

String AtechCloudOta::lastError() const {
  if (!_impl) return String();
  if (!_impl->configError.isEmpty()) return _impl->configError;
  const bool locked = _impl->take();
  const String copy = _impl->error;
  if (locked) _impl->give();
  return copy;
}

const char *AtechCloudOta::stateName() const { return _impl ? stateText(_impl->state) : "disabled"; }
