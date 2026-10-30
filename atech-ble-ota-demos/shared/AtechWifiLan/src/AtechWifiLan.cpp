// AtechWifiLan.cpp: station-mode Wi-Fi, mDNS and the authenticated LAN OTA
// service. Runs inside the protected core; the AI-generated app never touches
// it and cannot stall it (the HTTP server has its own task on core 0).
#include "AtechWifiLan.h"

#include <AtechCore.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_app_format.h>
#include <esp_heap_caps.h>
#include <esp_http_server.h>
#include <esp_ota_ops.h>
#include <esp_random.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#if __has_include(<esp_coexist.h>)
#include <esp_coexist.h>
#define ATECH_HAS_COEX 1
#endif

#include <algorithm>
#include <cerrno>
#include <cstring>

namespace {

constexpr char PROTOCOL_VERSION[] = "1";
constexpr size_t NONCE_BYTES = 16;
constexpr size_t NONCE_SLOTS = 4;
constexpr uint32_t NONCE_TTL_MS = 90000;
constexpr size_t SESSION_ID_BYTES = 16;
constexpr size_t RECV_BUFFER_BYTES = 16 * 1024;
constexpr size_t CHUNK_MAX_BYTES = 256 * 1024;
constexpr size_t MIN_IMAGE_BYTES = 1024;
constexpr size_t APP_PREFIX_SIZE =
    sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(uint32_t);
constexpr size_t HEADER_VALUE_MAX = 96;
constexpr size_t TARGET_ID_MAX = 20;
constexpr char TARGET_PREFIX[] = "ATECH-TARGET:";
constexpr char BUILD_PREFIX[] = "ATECH-BUILD:";
constexpr TickType_t LOCK_WAIT = pdMS_TO_TICKS(8000);

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

bool isHex(const String &text, size_t expectedLength) {
  if (text.length() != expectedLength) return false;
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

bool constantTimeEquals(const String &left, const String &right) {
  if (left.length() != right.length()) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < left.length(); ++i) difference |= uint8_t(left[i] ^ right[i]);
  return difference == 0;
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
      default:
        if (static_cast<uint8_t>(c) >= 0x20) output += c;
        break;
    }
  }
  return output;
}

bool parseUnsigned(const String &text, uint32_t &value) {
  if (text.isEmpty() || text.length() > 10) return false;
  char *end = nullptr;
  errno = 0;
  const unsigned long parsed = strtoul(text.c_str(), &end, 10);
  if (errno != 0 || end == text.c_str() || *end != '\0' || parsed > UINT32_MAX) return false;
  value = static_cast<uint32_t>(parsed);
  return true;
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

// Streaming substring search with a KMP failure table so a marker is found
// even when a partial match overlaps the real one. Markers are byte strings
// and may contain a terminating NUL to make them exact.
struct MarkerScanner {
  uint8_t marker[80] = {};
  uint8_t failure[80] = {};
  size_t length = 0;
  size_t matched = 0;
  bool found = false;

  void reset(const uint8_t *bytes, size_t count) {
    length = std::min(count, sizeof(marker));
    memcpy(marker, bytes, length);
    matched = 0;
    found = false;
    failure[0] = 0;
    size_t k = 0;
    for (size_t i = 1; i < length; ++i) {
      while (k > 0 && marker[i] != marker[k]) k = failure[k - 1];
      if (marker[i] == marker[k]) ++k;
      failure[i] = static_cast<uint8_t>(k);
    }
  }

  void feed(const uint8_t *data, size_t count) {
    if (found || length == 0) return;
    for (size_t i = 0; i < count; ++i) {
      while (matched > 0 && data[i] != marker[matched]) matched = failure[matched - 1];
      if (data[i] == marker[matched]) {
        ++matched;
        if (matched == length) { found = true; return; }
      }
    }
  }
};

// Finds "ATECH-TARGET:" and captures the NUL-terminated device id after it.
struct TargetScanner {
  MarkerScanner prefix;
  char captured[TARGET_ID_MAX + 1] = {};
  size_t capturedLength = 0;
  bool complete = false;

  void reset() {
    prefix.reset(reinterpret_cast<const uint8_t *>(TARGET_PREFIX), sizeof(TARGET_PREFIX) - 1);
    capturedLength = 0;
    complete = false;
    captured[0] = '\0';
  }

  void feed(const uint8_t *data, size_t count) {
    if (complete) return;
    size_t i = 0;
    if (!prefix.found) {
      // Feed byte by byte so capture starts right after the prefix.
      for (; i < count && !prefix.found; ++i) prefix.feed(data + i, 1);
      if (!prefix.found) return;
    }
    for (; i < count; ++i) {
      if (data[i] == 0 || capturedLength >= TARGET_ID_MAX) {
        captured[capturedLength] = '\0';
        complete = true;
        return;
      }
      captured[capturedLength++] = static_cast<char>(data[i]);
    }
  }
};

struct Nonce {
  uint8_t bytes[NONCE_BYTES] = {};
  uint32_t issuedMs = 0;
  bool valid = false;
};

}  // namespace

struct AtechWifiLan::Impl {
  AtechWifiLanConfig config = {};
  String imageIdentity;
  String preferencesNamespace;
  String hostnameText;
  String storedSsid;
  String storedPassword;
  String error;
  Preferences preferences;

  bool initialized = false;
  bool stationWanted = false;
  bool apActive = false;
  volatile bool gotIp = false;
  volatile bool servicesPending = false;
  bool mdnsStarted = false;
  bool serverStarted = false;
  uint32_t lastAttemptMs = 0;
  uint32_t lastDisconnectMs = 0;
  uint32_t connectedAtMs = 0;
  int lastDisconnectReason = 0;
  httpd_handle_t server = nullptr;
  SemaphoreHandle_t lock = nullptr;
  Nonce nonces[NONCE_SLOTS];
  uint32_t rebootAtMs = 0;
  uint32_t restartAtMs = 0;

  // Upload session (guarded by lock).
  struct Session {
    bool active = false;
    char id[SESSION_ID_BYTES * 2 + 1] = {};
    uint32_t expectedSize = 0;
    uint32_t received = 0;
    String expectedSha;
    String buildId;
    const esp_partition_t *partition = nullptr;
    esp_ota_handle_t handle = 0;
    bool handleActive = false;
    mbedtls_sha256_context sha;
    bool shaStarted = false;
    uint8_t prefix[APP_PREFIX_SIZE] = {};
    size_t prefixLength = 0;
    bool headerOk = false;
    MarkerScanner identity;
    MarkerScanner build;
    TargetScanner target;
    uint32_t startedMs = 0;
    uint32_t firstChunkMs = 0;
    uint32_t lastActivityMs = 0;
    uint8_t *buffer = nullptr;
  } session;
  bool verifiedPendingReboot = false;
  String lastTransferError;
  uint32_t lastTransferMs = 0;

  ~Impl() {
    abortSession("Service destroyed", false);
    if (server) httpd_stop(server);
    if (lock) vSemaphoreDelete(lock);
  }

  // ---- credentials -------------------------------------------------------

  bool loadCredentials() {
    if (!preferences.begin(preferencesNamespace.c_str(), true)) {
      preferences.end();
      // Namespace may not exist yet; open read-write to create it.
      if (!preferences.begin(preferencesNamespace.c_str(), false)) {
        error = F("Could not open Wi-Fi credential storage");
        return false;
      }
    }
    storedSsid = preferences.getString("ssid", "");
    storedPassword = preferences.getString("pass", "");
    preferences.end();
    stationWanted = !storedSsid.isEmpty();
    return true;
  }

  bool persistCredentials(const String &ssid, const String &password) {
    if (!preferences.begin(preferencesNamespace.c_str(), false)) {
      error = F("Could not open Wi-Fi credential storage");
      return false;
    }
    const bool ok = preferences.putString("ssid", ssid) == ssid.length() &&
                    preferences.putString("pass", password) == password.length();
    preferences.end();
    if (!ok) error = F("Could not persist the Wi-Fi credentials");
    return ok;
  }

  bool eraseCredentials() {
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
    preferences.remove("ssid");
    preferences.remove("pass");
    preferences.end();
    return true;
  }

  // ---- Wi-Fi mode and station ----------------------------------------------

  void applyMode() {
    wifi_mode_t mode = WIFI_OFF;
    if (apActive && stationWanted) mode = WIFI_AP_STA;
    else if (apActive) mode = WIFI_AP;
    else if (stationWanted) mode = WIFI_STA;
    WiFi.mode(mode);
  }

  void startStation() {
    if (!stationWanted) return;
    WiFi.persistent(false);
    WiFi.setHostname(hostnameText.c_str());
    applyMode();
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.setMinSecurity(storedPassword.isEmpty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK);
    lastAttemptMs = millis();
    WiFi.begin(storedSsid.c_str(), storedPassword.isEmpty() ? nullptr : storedPassword.c_str());
    Serial.printf("[wifi] joining \"%s\" as %s\n", storedSsid.c_str(), hostnameText.c_str());
  }

  void onEvent(arduino_event_id_t event, const arduino_event_info_t &info) {
    switch (event) {
      case ARDUINO_EVENT_WIFI_STA_GOT_IP:
        gotIp = true;
        servicesPending = true;
        connectedAtMs = millis();
        break;
      case ARDUINO_EVENT_WIFI_STA_LOST_IP:
        gotIp = false;
        break;
      case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
        gotIp = false;
        lastDisconnectMs = millis();
        lastDisconnectReason = info.wifi_sta_disconnected.reason;
        break;
      default:
        break;
    }
  }

  void startServices() {
    servicesPending = false;
    if (!mdnsStarted) {
      if (MDNS.begin(hostnameText.c_str())) {
        MDNS.addService("atech-ota", "tcp", config.port);
        MDNS.addServiceTxt("atech-ota", "tcp", "id", atech::deviceId());
        MDNS.addServiceTxt("atech-ota", "tcp", "suffix", atech::pairingSuffix());
        MDNS.addServiceTxt("atech-ota", "tcp", "demo", String(config.demo).c_str());
        MDNS.addServiceTxt("atech-ota", "tcp", "fw", config.firmwareVersion ? config.firmwareVersion : "");
        MDNS.addServiceTxt("atech-ota", "tcp", "proto", PROTOCOL_VERSION);
        mdnsStarted = true;
      } else {
        Serial.println(F("[wifi] mDNS did not start; discovery falls back to manual IP"));
      }
    }
    if (!serverStarted) startServer();
    Serial.printf("[wifi] connected to \"%s\": http://%s:%u (%s.local)\n", WiFi.SSID().c_str(),
                  WiFi.localIP().toString().c_str(), config.port, hostnameText.c_str());
  }

  // ---- HTTP helpers ----------------------------------------------------------

  static const char *statusText(int status) {
    switch (status) {
      case 200: return "200 OK";
      case 400: return "400 Bad Request";
      case 401: return "401 Unauthorized";
      case 403: return "403 Forbidden";
      case 404: return "404 Not Found";
      case 409: return "409 Conflict";
      case 413: return "413 Payload Too Large";
      case 422: return "422 Unprocessable Entity";
      case 503: return "503 Service Unavailable";
      default: return "500 Internal Server Error";
    }
  }

  static esp_err_t sendJson(httpd_req_t *req, int status, const String &body, bool close = false) {
    httpd_resp_set_status(req, statusText(status));
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    if (close) httpd_resp_set_hdr(req, "Connection", "close");
    httpd_resp_send(req, body.c_str(), body.length());
    return close ? ESP_FAIL : ESP_OK;
  }

  static esp_err_t sendError(httpd_req_t *req, int status, const String &message, bool close = false) {
    String body = F("{\"ok\":false,\"error\":\"");
    body += jsonEscape(message);
    body += F("\"}");
    return sendJson(req, status, body, close);
  }

  static String header(httpd_req_t *req, const char *name) {
    char value[HEADER_VALUE_MAX] = {};
    if (httpd_req_get_hdr_value_str(req, name, value, sizeof(value)) != ESP_OK) return String();
    return String(value);
  }

  static String query(httpd_req_t *req, const char *key) {
    char buffer[64] = {};
    if (httpd_req_get_url_query_str(req, buffer, sizeof(buffer)) != ESP_OK) return String();
    char value[32] = {};
    if (httpd_query_key_value(buffer, key, value, sizeof(value)) != ESP_OK) return String();
    return String(value);
  }

  bool take() { return lock && xSemaphoreTakeRecursive(lock, LOCK_WAIT) == pdTRUE; }
  bool tryTake() { return lock && xSemaphoreTakeRecursive(lock, 0) == pdTRUE; }
  void give() { if (lock) xSemaphoreGiveRecursive(lock); }

  // ---- nonces --------------------------------------------------------------

  String issueNonce() {
    const uint32_t now = millis();
    size_t slot = 0;
    uint32_t oldest = UINT32_MAX;
    for (size_t i = 0; i < NONCE_SLOTS; ++i) {
      if (!nonces[i].valid) { slot = i; break; }
      const uint32_t age = now - nonces[i].issuedMs;
      if (age >= NONCE_TTL_MS) { slot = i; break; }
      if (nonces[i].issuedMs < oldest) { oldest = nonces[i].issuedMs; slot = i; }
    }
    esp_fill_random(nonces[slot].bytes, NONCE_BYTES);
    nonces[slot].issuedMs = now;
    nonces[slot].valid = true;
    return hexEncode(nonces[slot].bytes, NONCE_BYTES);
  }

  // Consumes a nonce; a nonce can authorize exactly one request.
  bool consumeNonce(const String &hex) {
    if (!isHex(hex, NONCE_BYTES * 2)) return false;
    String lowered = hex;
    lowered.toLowerCase();
    const uint32_t now = millis();
    for (size_t i = 0; i < NONCE_SLOTS; ++i) {
      if (!nonces[i].valid) continue;
      if (now - nonces[i].issuedMs >= NONCE_TTL_MS) { nonces[i].valid = false; continue; }
      if (constantTimeEquals(hexEncode(nonces[i].bytes, NONCE_BYTES), lowered)) {
        nonces[i].valid = false;
        return true;
      }
    }
    return false;
  }

  bool verifyAuth(const String &message, const String &presented) {
    const String token = config.authToken ? config.authToken() : String();
    if (token.length() < 16 || !isHex(presented, 64)) return false;
    String expected;
    if (!hmacSha256Hex(token, message, expected)) return false;
    String lowered = presented;
    lowered.toLowerCase();
    return constantTimeEquals(expected, lowered);
  }

  // ---- identity -------------------------------------------------------------

  String netJson() const {
    String json;
    json.reserve(320);
    json += F("{\"enabled\":");
    json += stationWanted ? F("true") : F("false");
    json += F(",\"configured_ssid\":\"");
    json += jsonEscape(storedSsid);
    json += F("\",\"connected\":");
    json += (stationWanted && gotIp) ? F("true") : F("false");
    json += F(",\"ssid\":\"");
    json += jsonEscape(gotIp ? WiFi.SSID() : String());
    json += F("\",\"ip\":\"");
    json += gotIp ? WiFi.localIP().toString() : String();
    json += F("\",\"rssi\":");
    json += String(gotIp ? WiFi.RSSI() : 0);
    json += F(",\"hostname\":\"");
    json += hostnameText;
    json += F("\",\"mdns\":\"");
    json += hostnameText;
    json += F(".local\",\"port\":");
    json += String(config.port);
    json += F(",\"proto\":");
    json += PROTOCOL_VERSION;
    json += F(",\"service\":");
    json += serverStarted ? F("true") : F("false");
    json += F(",\"transferring\":");
    json += session.active ? F("true") : F("false");
    json += F(",\"ap_active\":");
    json += apActive ? F("true") : F("false");
    json += F(",\"last_disconnect_reason\":");
    json += String(lastDisconnectReason);
    json += F(",\"last_transfer_error\":\"");
    json += jsonEscape(lastTransferError);
    json += F("\",\"last_transfer_ms\":");
    json += String(lastTransferMs);
    json += F("}");
    return json;
  }

  String identityJson() const {
    String identity = atech::identityJson();
    if (identity.endsWith("}")) identity.remove(identity.length() - 1);
    identity += F(",\"net\":");
    identity += netJson();
    if (config.extraIdentity) {
      const String extra = config.extraIdentity();
      if (extra.startsWith("{")) { identity += F(",\"cloud\":"); identity += extra; }
    }
    identity += F("}");
    return identity;
  }

  // ---- upload session ---------------------------------------------------------

  void releaseSessionResources() {
    if (session.handleActive) {
      esp_ota_abort(session.handle);
      session.handleActive = false;
      session.handle = 0;
    }
    if (session.shaStarted) {
      mbedtls_sha256_free(&session.sha);
      session.shaStarted = false;
    }
    if (session.buffer) {
      free(session.buffer);
      session.buffer = nullptr;
    }
    session.active = false;
    session.id[0] = '\0';
  }

  void abortSession(const String &message, bool resumeApp = true) {
    if (!session.active && !session.handleActive) return;
    releaseSessionResources();
    lastTransferError = message;
    atech::coreReleaseOta("lan");
#ifdef ATECH_HAS_COEX
    esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
#endif
    if (resumeApp) atech::coreResumeApp();
    Serial.printf("[lan-ota] aborted: %s\n", message.c_str());
  }

  bool validatePrefix(String &reason) {
    esp_image_header_t imageHeader = {};
    memcpy(&imageHeader, session.prefix, sizeof(imageHeader));
    if (imageHeader.magic != ESP_IMAGE_HEADER_MAGIC) { reason = F("Not an ESP application image (bad magic byte)"); return false; }
    if (imageHeader.segment_count == 0 || imageHeader.segment_count > ESP_IMAGE_MAX_SEGMENTS) {
      reason = F("Invalid ESP application segment count");
      return false;
    }
    if (imageHeader.chip_id != ESP_CHIP_ID_ESP32S3) { reason = F("Firmware target is not ESP32-S3"); return false; }
    if (imageHeader.spi_size != ESP_IMAGE_FLASH_SIZE_16MB) { reason = F("Firmware flash target is not the configured 16MB board"); return false; }
    uint32_t descriptorMagic = 0;
    memcpy(&descriptorMagic, session.prefix + sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t), sizeof(descriptorMagic));
    if (descriptorMagic != ESP_APP_DESC_MAGIC_WORD) {
      reason = F("Image is not an application firmware.bin (bootloader/merged images are rejected)");
      return false;
    }
    return true;
  }

  // Consumes received bytes: integrity, markers, header check, flash write.
  bool consume(const uint8_t *data, size_t length, String &reason) {
    if (mbedtls_sha256_update(&session.sha, data, length) != 0) { reason = F("SHA-256 update failed"); return false; }
    session.identity.feed(data, length);
    session.build.feed(data, length);
    session.target.feed(data, length);
    if (!session.headerOk) {
      const size_t toCopy = std::min(length, APP_PREFIX_SIZE - session.prefixLength);
      memcpy(session.prefix + session.prefixLength, data, toCopy);
      session.prefixLength += toCopy;
      if (session.prefixLength == APP_PREFIX_SIZE && !validatePrefix(reason)) return false;
      if (session.prefixLength == APP_PREFIX_SIZE) session.headerOk = true;
      else return true;  // still accumulating the header; nothing written yet
      // Write the prefix now that it is known to be an application image.
      const esp_err_t prefixResult = esp_ota_write(session.handle, session.prefix, APP_PREFIX_SIZE);
      if (prefixResult != ESP_OK) { reason = String(F("Flash write failed: ")) + esp_err_to_name(prefixResult); return false; }
      data += toCopy;
      length -= toCopy;
      if (length == 0) return true;
    }
    const esp_err_t result = esp_ota_write(session.handle, data, length);
    if (result != ESP_OK) { reason = String(F("Flash write failed: ")) + esp_err_to_name(result); return false; }
    return true;
  }

  // ---- handlers ------------------------------------------------------------------

  static Impl *self(httpd_req_t *req) { return static_cast<Impl *>(req->user_ctx); }

  static esp_err_t handleIdentity(httpd_req_t *req) {
    return sendJson(req, 200, self(req)->identityJson());
  }

  static esp_err_t handleChallenge(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    String body = F("{\"ok\":true,\"nonce\":\"");
    body += impl->issueNonce();
    body += F("\",\"ttl_ms\":");
    body += String(NONCE_TTL_MS);
    body += F(",\"device\":\"");
    body += atech::deviceId();
    body += F("\",\"proto\":");
    body += PROTOCOL_VERSION;
    body += F("}");
    impl->give();
    return sendJson(req, 200, body);
  }

  static esp_err_t handleBegin(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    const esp_err_t result = impl->begin(req);
    impl->give();
    return result;
  }

  esp_err_t begin(httpd_req_t *req) {
    const String device = header(req, "X-Atech-Device");
    const String nonce = header(req, "X-Atech-Nonce");
    const String sizeText = header(req, "X-Atech-Size");
    String sha = header(req, "X-Atech-SHA256");
    const String build = header(req, "X-Atech-Build");
    const String auth = header(req, "X-Atech-Auth");
    sha.toLowerCase();

    if (device != atech::deviceId()) {
      return sendError(req, 403, String(F("This upload is addressed to ")) + (device.isEmpty() ? String(F("no device")) : device) +
                                 F("; this board is ") + atech::deviceId());
    }
    if (!consumeNonce(nonce)) return sendError(req, 401, F("Unknown, used or expired nonce; request a new challenge"));
    uint32_t size = 0;
    if (!parseUnsigned(sizeText, size) || size < MIN_IMAGE_BYTES) return sendError(req, 400, F("Missing or invalid firmware size"));
    if (!isHex(sha, 64)) return sendError(req, 400, F("Missing or invalid firmware SHA-256"));
    if (build.isEmpty() || build.length() > 40) return sendError(req, 400, F("Missing or invalid build id"));
    for (size_t i = 0; i < build.length(); ++i) {
      const char c = build[i];
      if (!(isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_')) return sendError(req, 400, F("Invalid build id"));
    }
    String message = F("atech-ota-begin/1\n");
    message += device; message += '\n';
    String nonceLower = nonce; nonceLower.toLowerCase();
    message += nonceLower; message += '\n';
    message += String(size); message += '\n';
    message += sha; message += '\n';
    message += build; message += '\n';
    if (!verifyAuth(message, auth)) return sendError(req, 401, F("Authorization failed; pair the backend with this board's OTA authorization code"));

    if (rebootAtMs != 0 || verifiedPendingReboot) return sendError(req, 409, F("A verified update is rebooting"));
    if (session.active) {
      if (millis() - session.lastActivityMs < config.sessionTimeoutMs) return sendError(req, 409, F("Another LAN upload is in progress"));
      abortSession(F("Replaced a stalled upload session"));
    }
    if (config.otherOtaBusy && config.otherOtaBusy()) return sendError(req, 409, F("Bluetooth or hotspot update is active; wait for it to finish"));
    if (!atech::coreTryAcquireOta("lan")) {
      return sendError(req, 409, String(F("Flash is owned by the ")) + atech::coreOtaOwner() + F(" updater"));
    }
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *target = esp_ota_get_next_update_partition(nullptr);
    if (!target || target == running) {
      atech::coreReleaseOta("lan");
      return sendError(req, 500, F("No inactive OTA application partition is available"));
    }
    if (size > target->size) {
      atech::coreReleaseOta("lan");
      return sendError(req, 413, String(F("Firmware is larger than the inactive OTA slot (")) + String(target->size) + F(" bytes)"));
    }
    session.buffer = static_cast<uint8_t *>(heap_caps_malloc(RECV_BUFFER_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    if (!session.buffer) session.buffer = static_cast<uint8_t *>(malloc(RECV_BUFFER_BYTES));
    if (!session.buffer) {
      atech::coreReleaseOta("lan");
      return sendError(req, 500, F("Could not allocate the receive buffer"));
    }
    const uint32_t eraseStart = millis();
    const esp_err_t beginResult = esp_ota_begin(target, size, &session.handle);
    if (beginResult != ESP_OK) {
      free(session.buffer);
      session.buffer = nullptr;
      atech::coreReleaseOta("lan");
      return sendError(req, 500, String(F("Could not begin inactive-partition update: ")) + esp_err_to_name(beginResult));
    }
    const uint32_t eraseMs = millis() - eraseStart;
    session.handleActive = true;
    session.partition = target;
    session.expectedSize = size;
    session.received = 0;
    session.expectedSha = sha;
    session.buildId = build;
    session.prefixLength = 0;
    session.headerOk = false;
    mbedtls_sha256_init(&session.sha);
    mbedtls_sha256_starts(&session.sha, 0);
    session.shaStarted = true;
    session.identity.reset(reinterpret_cast<const uint8_t *>(imageIdentity.c_str()), imageIdentity.length());
    String buildMarker = String(BUILD_PREFIX) + build;
    session.build.reset(reinterpret_cast<const uint8_t *>(buildMarker.c_str()), buildMarker.length() + 1);  // include NUL
    session.target.reset();
    uint8_t idBytes[SESSION_ID_BYTES];
    esp_fill_random(idBytes, sizeof(idBytes));
    const String idHex = hexEncode(idBytes, sizeof(idBytes));
    strncpy(session.id, idHex.c_str(), sizeof(session.id) - 1);
    session.id[sizeof(session.id) - 1] = '\0';
    session.startedMs = millis();
    session.firstChunkMs = 0;
    session.lastActivityMs = session.startedMs;
    session.active = true;
    lastTransferError = "";
    atech::coreSuspendApp();
#ifdef ATECH_HAS_COEX
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
#endif
    Serial.printf("[lan-ota] session %s: %lu bytes into %s (erase %lu ms) build %s\n", session.id,
                  static_cast<unsigned long>(size), target->label, static_cast<unsigned long>(eraseMs), build.c_str());
    String body = F("{\"ok\":true,\"session\":\"");
    body += session.id;
    body += F("\",\"chunk_max\":");
    body += String(CHUNK_MAX_BYTES);
    body += F(",\"partition\":\"");
    body += target->label;
    body += F("\",\"slot_size\":");
    body += String(target->size);
    body += F(",\"erase_ms\":");
    body += String(eraseMs);
    body += F("}");
    return sendJson(req, 200, body);
  }

  bool sessionMatches(httpd_req_t *req) {
    if (!session.active) return false;
    const String presented = header(req, "X-Atech-Session");
    return constantTimeEquals(presented, String(session.id));
  }

  static esp_err_t handleChunk(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"), true);
    const esp_err_t result = impl->chunk(req);
    impl->give();
    return result;
  }

  esp_err_t chunk(httpd_req_t *req) {
    if (!sessionMatches(req)) return sendError(req, 409, F("No matching upload session; begin again"), true);
    uint32_t offset = 0;
    if (!parseUnsigned(query(req, "offset"), offset) || offset != session.received) {
      return sendError(req, 409, String(F("Unexpected offset; the board has ")) + String(session.received) + F(" bytes"), true);
    }
    const size_t length = req->content_len;
    if (length == 0 || length > CHUNK_MAX_BYTES) return sendError(req, 413, F("Chunk size out of range"), true);
    if (length > session.expectedSize - session.received) {
      abortSession(F("Received more bytes than declared"));
      return sendError(req, 413, F("Chunk exceeds the declared firmware size"), true);
    }
    if (session.firstChunkMs == 0) session.firstChunkMs = millis();
    size_t remaining = length;
    int timeouts = 0;
    String reason;
    while (remaining > 0) {
      const int read = httpd_req_recv(req, reinterpret_cast<char *>(session.buffer), std::min(remaining, RECV_BUFFER_BYTES));
      if (read == HTTPD_SOCK_ERR_TIMEOUT) {
        if (++timeouts >= 2) { abortSession(F("Upload stalled; incomplete image discarded")); return ESP_FAIL; }
        continue;
      }
      if (read <= 0) { abortSession(F("Connection lost during upload; incomplete image discarded")); return ESP_FAIL; }
      if (!consume(session.buffer, static_cast<size_t>(read), reason)) {
        abortSession(reason);
        return sendError(req, 422, reason, true);
      }
      session.received += static_cast<uint32_t>(read);
      remaining -= static_cast<size_t>(read);
      session.lastActivityMs = millis();
    }
    String body = F("{\"ok\":true,\"received\":");
    body += String(session.received);
    body += F(",\"elapsed_ms\":");
    body += String(millis() - session.firstChunkMs);
    body += F("}");
    return sendJson(req, 200, body);
  }

  static esp_err_t handleFinish(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    const esp_err_t result = impl->finish(req);
    impl->give();
    return result;
  }

  esp_err_t finish(httpd_req_t *req) {
    if (!sessionMatches(req)) return sendError(req, 409, F("No matching upload session"));
    if (session.received != session.expectedSize) {
      const String reason = String(F("Upload incomplete: ")) + String(session.received) + F(" of ") + String(session.expectedSize) + F(" bytes");
      abortSession(reason);
      return sendError(req, 422, reason);
    }
    if (!session.headerOk) { abortSession(F("Application header was never validated")); return sendError(req, 422, F("Application header was never validated")); }
    if (!session.identity.found) {
      abortSession(F("Firmware belongs to a different Atech demo/target"));
      return sendError(req, 422, F("Firmware belongs to a different Atech demo/target"));
    }
    if (!session.build.found) {
      const String reason = String(F("Image does not carry build id ")) + session.buildId;
      abortSession(reason);
      return sendError(req, 422, reason);
    }
    if (session.target.complete && session.target.capturedLength > 0 &&
        strcmp(session.target.captured, atech::deviceId()) != 0) {
      const String reason = String(F("Image was built for ")) + session.target.captured + F(", not this board");
      abortSession(reason);
      return sendError(req, 422, reason);
    }
    uint8_t digest[32] = {};
    if (mbedtls_sha256_finish(&session.sha, digest) != 0) { abortSession(F("SHA-256 finalization failed")); return sendError(req, 500, F("SHA-256 finalization failed")); }
    mbedtls_sha256_free(&session.sha);
    session.shaStarted = false;
    const String actualSha = hexEncode(digest, sizeof(digest));
    if (!constantTimeEquals(actualSha, session.expectedSha)) {
      abortSession(F("Image SHA-256 does not match the declared digest; inactive partition not selected"));
      return sendError(req, 422, F("Image SHA-256 does not match the declared digest"));
    }
    const uint32_t transferMs = session.firstChunkMs ? millis() - session.firstChunkMs : 0;
    // esp_ota_end validates the ESP image (checksum, appended hash, and when
    // enabled secure boot / anti-rollback). It never selects the image.
    const uint32_t verifyStart = millis();
    const esp_err_t validation = esp_ota_end(session.handle);
    session.handleActive = false;
    session.handle = 0;
    if (validation != ESP_OK) {
      const String reason = String(F("ESP image verification failed: ")) + esp_err_to_name(validation);
      abortSession(reason);
      return sendError(req, 422, reason);
    }
    const esp_err_t activation = esp_ota_set_boot_partition(session.partition);
    if (activation != ESP_OK) {
      const String reason = String(F("Verified image could not be selected: ")) + esp_err_to_name(activation);
      abortSession(reason);
      return sendError(req, 500, reason);
    }
    const uint32_t verifyMs = millis() - verifyStart;
    lastTransferMs = transferMs;
    lastTransferError = "";
    const String partitionLabel = session.partition->label;
    // Keep the flash lock and the suspended app until the restart.
    session.active = false;
    session.id[0] = '\0';
    if (session.buffer) { free(session.buffer); session.buffer = nullptr; }
    verifiedPendingReboot = true;
    rebootAtMs = millis() + config.rebootDelayMs;
    Serial.printf("[lan-ota] verified %lu bytes in %lu ms (image check %lu ms), SHA-256 %s; rebooting into %s\n",
                  static_cast<unsigned long>(session.expectedSize), static_cast<unsigned long>(transferMs),
                  static_cast<unsigned long>(verifyMs), actualSha.c_str(), partitionLabel.c_str());
    String body = F("{\"ok\":true,\"stage\":\"verified\",\"bytes\":");
    body += String(session.expectedSize);
    body += F(",\"sha256\":\"");
    body += actualSha;
    body += F("\",\"transfer_ms\":");
    body += String(transferMs);
    body += F(",\"verify_ms\":");
    body += String(verifyMs);
    body += F(",\"partition\":\"");
    body += partitionLabel;
    body += F("\",\"reboot_in_ms\":");
    body += String(config.rebootDelayMs);
    body += F("}");
    return sendJson(req, 200, body, true);
  }

  static esp_err_t handleAbort(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    esp_err_t result;
    if (!impl->sessionMatches(req)) {
      result = sendError(req, 409, F("No matching upload session"));
    } else {
      impl->abortSession(F("Aborted by the backend"));
      result = sendJson(req, 200, F("{\"ok\":true,\"stage\":\"aborted\"}"));
    }
    impl->give();
    return result;
  }

  static esp_err_t handleControl(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    const esp_err_t result = impl->control(req);
    impl->give();
    return result;
  }

  esp_err_t control(httpd_req_t *req) {
    const String device = header(req, "X-Atech-Device");
    const String nonce = header(req, "X-Atech-Nonce");
    String op = header(req, "X-Atech-Op");
    const String auth = header(req, "X-Atech-Auth");
    op.toLowerCase();
    if (device != atech::deviceId()) return sendError(req, 403, String(F("Request addressed to another board; this board is ")) + atech::deviceId());
    if (op != "echo" && op != "confirm" && op != "rollback" && op != "restart") return sendError(req, 400, F("Unsupported control operation"));
    if (!consumeNonce(nonce)) return sendError(req, 401, F("Unknown, used or expired nonce; request a new challenge"));
    String message = F("atech-control/1\n");
    message += device; message += '\n';
    String nonceLower = nonce; nonceLower.toLowerCase();
    message += nonceLower; message += '\n';
    message += op; message += '\n';
    if (!verifyAuth(message, auth)) return sendError(req, 401, F("Authorization failed"));

    const char *status = "ok";
    if (op == "confirm") {
      if (!atech::confirmBoot()) status = "refused";
    } else if (op == "rollback") {
      if (session.active || rebootAtMs != 0) status = "refused";
      else if (!atech::canRollback() || !atech::rollbackToPrevious()) status = "refused";
      else restartAtMs = millis() + 700;
    } else if (op == "restart") {
      if (session.active) status = "refused";
      else restartAtMs = millis() + 700;
    }
    Serial.printf("[lan-ota] control %s: %s\n", op.c_str(), status);
    String body = F("{\"ok\":");
    body += strcmp(status, "ok") == 0 ? F("true") : F("false");
    body += F(",\"op\":\"");
    body += op;
    body += F("\",\"status\":\"");
    body += status;
    body += F("\",\"pending\":");
    body += atech::rollbackPending() ? F("true") : F("false");
    body += F(",\"canRollback\":");
    body += atech::canRollback() ? F("true") : F("false");
    body += F("}");
    return sendJson(req, 200, body);
  }

  static esp_err_t handleNotFound(httpd_req_t *req, httpd_err_code_t) {
    return sendError(req, 404, F("Not found"));
  }

  bool startServer() {
    httpd_config_t httpdConfig = HTTPD_DEFAULT_CONFIG();
    httpdConfig.server_port = config.port;
    httpdConfig.ctrl_port = 32768 + config.port;
    httpdConfig.task_priority = tskIDLE_PRIORITY + 5;
    httpdConfig.stack_size = 8192;
    httpdConfig.core_id = 0;
    httpdConfig.max_open_sockets = 4;
    httpdConfig.max_uri_handlers = 10;
    httpdConfig.lru_purge_enable = true;
    httpdConfig.recv_wait_timeout = 10;
    httpdConfig.send_wait_timeout = 10;
    httpdConfig.backlog_conn = 2;
    if (httpd_start(&server, &httpdConfig) != ESP_OK) {
      error = F("Could not start the LAN OTA service");
      Serial.println(F("[lan-ota] httpd_start failed"));
      return false;
    }
    const httpd_uri_t routes[] = {
        {"/api/identity", HTTP_GET, handleIdentity, this},
        {"/api/ota/challenge", HTTP_GET, handleChallenge, this},
        {"/api/ota/begin", HTTP_POST, handleBegin, this},
        {"/api/ota/chunk", HTTP_PUT, handleChunk, this},
        {"/api/ota/finish", HTTP_POST, handleFinish, this},
        {"/api/ota/abort", HTTP_POST, handleAbort, this},
        {"/api/control", HTTP_POST, handleControl, this},
    };
    for (const httpd_uri_t &route : routes) httpd_register_uri_handler(server, &route);
    httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, handleNotFound);
    serverStarted = true;
    Serial.printf("[lan-ota] service listening on port %u\n", config.port);
    return true;
  }

  // ---- main-loop service --------------------------------------------------------

  void service() {
    if (!initialized) return;
    const uint32_t now = millis();
    if (rebootAtMs != 0 && static_cast<int32_t>(now - rebootAtMs) >= 0) {
      Serial.println(F("[lan-ota] rebooting into the verified image"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    if (restartAtMs != 0 && static_cast<int32_t>(now - restartAtMs) >= 0) {
      Serial.println(F("[lan-ota] restarting"));
      Serial.flush();
      delay(50);
      ESP.restart();
    }
    if (servicesPending) startServices();
    if (stationWanted && !gotIp && !apActiveScanGuard() &&
        now - lastAttemptMs >= config.reconnectIntervalMs) {
      lastAttemptMs = now;
      Serial.printf("[wifi] not connected (reason %d); retrying \"%s\"\n", lastDisconnectReason, storedSsid.c_str());
      WiFi.disconnect(false, false, 0);
      WiFi.begin(storedSsid.c_str(), storedPassword.isEmpty() ? nullptr : storedPassword.c_str());
    }
    if (session.active && tryTake()) {
      if (now - session.lastActivityMs >= config.sessionTimeoutMs) {
        abortSession(F("Upload session timed out; incomplete image discarded"));
      }
      give();
    }
  }

  bool apActiveScanGuard() const { return false; }
};

AtechWifiLan::AtechWifiLan() : _impl(new Impl()) {}
AtechWifiLan::~AtechWifiLan() { delete _impl; }

bool AtechWifiLan::begin(const AtechWifiLanConfig &config) {
  if (!_impl || _impl->initialized) return _impl && _impl->initialized;
  _impl->config = config;
  _impl->imageIdentity = config.imageIdentity ? config.imageIdentity : "";
  _impl->preferencesNamespace = config.preferencesNamespace ? config.preferencesNamespace : "atech_wifi";
  if (_impl->config.port == 0) _impl->config.port = 8080;
  if (_impl->config.rebootDelayMs < 500) _impl->config.rebootDelayMs = 1500;
  if (_impl->config.sessionTimeoutMs == 0) _impl->config.sessionTimeoutMs = 20000;
  if (_impl->config.reconnectIntervalMs == 0) _impl->config.reconnectIntervalMs = 15000;
  if (_impl->imageIdentity.length() < 8) {
    _impl->error = F("Image identity marker must contain at least 8 characters");
    return false;
  }
  _impl->hostnameText = String(config.hostnamePrefix ? config.hostnamePrefix : "atech") + "-" + atech::pairingSuffix();
  _impl->hostnameText.toLowerCase();
  _impl->lock = xSemaphoreCreateRecursiveMutex();
  if (!_impl->lock) { _impl->error = F("Could not create the LAN OTA lock"); return false; }
  if (!_impl->loadCredentials()) return false;
  Impl *impl = _impl;
  WiFi.onEvent([impl](arduino_event_id_t event, arduino_event_info_t info) { impl->onEvent(event, info); });
  _impl->initialized = true;
  if (_impl->stationWanted) {
    _impl->startStation();
  } else {
    Serial.println(F("[wifi] no home Wi-Fi configured; hold BOOT for 3 s and open the hotspot portal to set it up"));
  }
  return true;
}

void AtechWifiLan::loop() { if (_impl) _impl->service(); }

bool AtechWifiLan::hasCredentials() const { return _impl && !_impl->storedSsid.isEmpty(); }

bool AtechWifiLan::saveCredentials(const String &ssid, const String &password) {
  if (!_impl || !_impl->initialized) return false;
  if (ssid.isEmpty() || ssid.length() > 32) { _impl->error = F("SSID must contain 1 to 32 characters"); return false; }
  if (!password.isEmpty() && (password.length() < 8 || password.length() > 63)) {
    _impl->error = F("Wi-Fi password must contain 8 to 63 characters (or be empty for an open network)");
    return false;
  }
  if (!_impl->persistCredentials(ssid, password)) return false;
  _impl->storedSsid = ssid;
  _impl->storedPassword = password;
  _impl->stationWanted = true;
  _impl->gotIp = false;
  _impl->lastDisconnectReason = 0;
  _impl->startStation();
  return true;
}

bool AtechWifiLan::forgetCredentials() {
  if (!_impl || !_impl->initialized) return false;
  if (!_impl->eraseCredentials()) return false;
  _impl->storedSsid = "";
  _impl->storedPassword = "";
  _impl->stationWanted = false;
  _impl->gotIp = false;
  WiFi.disconnect(false, true);
  if (_impl->mdnsStarted) { MDNS.end(); _impl->mdnsStarted = false; }
  _impl->applyMode();
  Serial.println(F("[wifi] home Wi-Fi credentials forgotten"));
  return true;
}

String AtechWifiLan::configuredSsid() const { return _impl ? _impl->storedSsid : String(); }
bool AtechWifiLan::isConnected() const { return _impl && _impl->stationWanted && _impl->gotIp; }
bool AtechWifiLan::stationEnabled() const { return _impl && _impl->stationWanted; }
IPAddress AtechWifiLan::ip() const { return isConnected() ? WiFi.localIP() : IPAddress(); }
int AtechWifiLan::rssi() const { return isConnected() ? WiFi.RSSI() : 0; }
String AtechWifiLan::hostname() const { return _impl ? _impl->hostnameText : String(); }
uint16_t AtechWifiLan::port() const { return _impl ? _impl->config.port : 0; }
String AtechWifiLan::statusJson() const { return _impl ? _impl->netJson() : String("{}"); }

String AtechWifiLan::scanJson() {
  if (!_impl) return "[]";
  const wifi_mode_t before = WiFi.getMode();
  if (before != WIFI_STA && before != WIFI_AP_STA) WiFi.mode(before == WIFI_AP ? WIFI_AP_STA : WIFI_STA);
  const int16_t count = WiFi.scanNetworks(false, false, false, 120);
  String json = "[";
  int emitted = 0;
  for (int16_t i = 0; i < count && emitted < 24; ++i) {
    const String ssid = WiFi.SSID(i);
    if (ssid.isEmpty()) continue;
    // Keep the strongest entry per SSID.
    bool duplicate = false;
    for (int16_t j = 0; j < i; ++j) if (WiFi.SSID(j) == ssid) { duplicate = true; break; }
    if (duplicate) continue;
    int32_t bestRssi = WiFi.RSSI(i);
    int32_t bestChannel = WiFi.channel(i);
    wifi_auth_mode_t auth = WiFi.encryptionType(i);
    for (int16_t j = i + 1; j < count; ++j) {
      if (WiFi.SSID(j) == ssid && WiFi.RSSI(j) > bestRssi) { bestRssi = WiFi.RSSI(j); bestChannel = WiFi.channel(j); auth = WiFi.encryptionType(j); }
    }
    if (emitted++) json += ',';
    json += F("{\"ssid\":\"");
    json += jsonEscape(ssid);
    json += F("\",\"rssi\":");
    json += String(bestRssi);
    json += F(",\"channel\":");
    json += String(bestChannel);
    json += F(",\"open\":");
    json += auth == WIFI_AUTH_OPEN ? F("true") : F("false");
    json += '}';
  }
  json += ']';
  WiFi.scanDelete();
  if (before != WiFi.getMode()) _impl->applyMode();
  return json;
}

void AtechWifiLan::setSoftApActive(bool active) {
  if (!_impl) return;
  _impl->apActive = active;
  _impl->applyMode();
  if (active) WiFi.setSleep(false);
}

bool AtechWifiLan::isTransferring() const { return _impl && (_impl->session.active || _impl->verifiedPendingReboot); }
bool AtechWifiLan::serviceRunning() const { return _impl && _impl->serverStarted; }

const String &AtechWifiLan::lastError() const {
  static const String empty;
  return _impl ? _impl->error : empty;
}
