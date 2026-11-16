// AtechWifiLan.cpp: station-mode Wi-Fi, mDNS and the authenticated LAN OTA
// service. Runs inside the protected core; the AI-generated app never touches
// it and cannot stall it (the HTTP server has its own task on core 0).
#include "AtechWifiLan.h"

#include <AtechCore.h>
#include <AtechFwSign.h>
#include <AtechImageSink.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <NetworkClient.h>
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
#if __has_include(<esp_coexist.h>)
#include <esp_coexist.h>
#define ATECH_HAS_COEX 1
#endif
#if __has_include(<esp_eap_client.h>)
#include <esp_eap_client.h>
#define ATECH_HAS_EAP 1
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
constexpr size_t SYNC_BODY_MAX = 1024;   // POST /api/sync form body
constexpr size_t CHUNK_MAX_BYTES = 256 * 1024;
constexpr size_t MIN_IMAGE_BYTES = 1024;
constexpr size_t HEADER_VALUE_MAX = 160;   // the signing key (130 hex) is the longest header value
constexpr TickType_t LOCK_WAIT = pdMS_TO_TICKS(8000);
constexpr size_t PEM_MAX = 4096;           // one CA chain, client certificate or key
constexpr size_t PEM_TOTAL_MAX = 10240;    // all three together: the nvs partition is 20 KiB
constexpr size_t FIELD_MAX = 128;          // identity, username, domain
const char CA_REFUSAL[] = "Enterprise Wi-Fi needs a trusted CA certificate (PEM) or the built-in bundle; certificate checking is never disabled";
const char AUTH_NAMES[][9] = {"personal", "peap", "ttls", "tls"};
// Connectivity probe: plain HTTP, redirects not followed, bounded body. A 204 (or Apple's "Success")
// means the internet answered; a redirect or another page means a sign-in portal; nothing means offline.
const char PROBE_PRIMARY[] = "http://connectivitycheck.gstatic.com/generate_204";
const char PROBE_SECONDARY[] = "http://captive.apple.com/hotspot-detect.html";
constexpr uint32_t PROBE_TIMEOUT_MS = 6000;
constexpr uint32_t PROBE_OK_RECHECK_MS = 10UL * 60UL * 1000UL;
constexpr uint32_t PROBE_BAD_RECHECK_MS = 60000;
constexpr size_t PROBE_BODY_MAX = 512;
constexpr uint32_t PROBE_TASK_STACK = 6144;
enum class Net : uint8_t { Unknown, Checking, Ok, Captive, Offline };
const char *netName(Net state) {
  switch (state) {
    case Net::Checking: return "checking";
    case Net::Ok: return "ok";
    case Net::Captive: return "captive";
    case Net::Offline: return "offline";
    default: return "unknown";
  }
}
const char PHASE2_NAMES[][9] = {"eap", "mschapv2", "mschap", "pap", "chap"};

bool isEnterpriseAuth(wifi_auth_mode_t mode) {
  return mode == WIFI_AUTH_ENTERPRISE || mode == WIFI_AUTH_WPA3_ENTERPRISE || mode == WIFI_AUTH_WPA2_WPA3_ENTERPRISE ||
         mode == WIFI_AUTH_WPA_ENTERPRISE || mode == WIFI_AUTH_WPA3_ENT_192;
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
  AtechWifiProfile stored;
  String error;
  Preferences preferences;
  bool sntpStarted = false;
  // Internet probe (own task; results read from any task).
  volatile Net netState = Net::Unknown;
  String captiveUrlText;            // written by the probe task under lock
  TaskHandle_t probeTask = nullptr;
  volatile bool probeRequested = false;
  uint32_t nextProbeMs = 0;

  bool initialized = false;
  bool stationWanted = false;
  bool apActive = false;
  bool radioHold = false;   // ESP-NOW wants the driver started (AtechSync)
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

  // Upload session (guarded by lock). The bytes go through the shared install engine.
  struct Session {
    bool active = false;
    char id[SESSION_ID_BYTES * 2 + 1] = {};
    uint32_t expectedSize = 0;
    uint32_t received = 0;
    String buildId;
    String pendingKey;    // X-Atech-Key of this upload, pinned only once the sink accepted the image
    uint32_t startedMs = 0;
    uint32_t firstChunkMs = 0;
    uint32_t lastActivityMs = 0;
    uint8_t *buffer = nullptr;
  } session;
  atech::ImageSink sink;
  bool verifiedPendingReboot = false;
  String lastTransferError;
  uint32_t lastTransferMs = 0;

  ~Impl() {
    abortSession("Service destroyed", false);
    if (probeTask) vTaskDelete(probeTask);
    if (server) httpd_stop(server);
    if (lock) vSemaphoreDelete(lock);
  }

  // ---- internet probe ------------------------------------------------------------------

  static void probeMain(void *arg) { static_cast<Impl *>(arg)->probeLoop(); }

  int fetch(const char *url, String &location, String &body) {
    NetworkClient client;
    HTTPClient http;
    http.setConnectTimeout(PROBE_TIMEOUT_MS);
    http.setTimeout(PROBE_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setReuse(false);
    http.setUserAgent("AtechNet/1");
    const char *keys[] = {"Location"};
    http.collectHeaders(keys, 1);
    if (!http.begin(client, url)) return -1;
    const int code = http.GET();
    if (code >= 300 && code < 400) location = http.header("Location");
    if (code == 200) {
      NetworkClient *stream = http.getStreamPtr();
      const uint32_t start = millis();
      char chunk[128];
      while (stream && body.length() < PROBE_BODY_MAX && millis() - start < 2000) {
        const int available = stream->available();
        if (available <= 0) { if (!stream->connected()) break; vTaskDelay(pdMS_TO_TICKS(20)); continue; }
        const int read = stream->read(reinterpret_cast<uint8_t *>(chunk), std::min<size_t>(sizeof(chunk), PROBE_BODY_MAX - body.length()));
        if (read <= 0) break;
        body.concat(chunk, read);
      }
    }
    http.end();
    return code;
  }

  Net probeOnce(String &location) {
    String body;
    int code = fetch(PROBE_PRIMARY, location, body);
    if (code == 204) return Net::Ok;
    if (code > 0) return Net::Captive;   // a redirect or a page instead of the empty answer
    body = "";
    code = fetch(PROBE_SECONDARY, location, body);
    if (code == 200 && body.indexOf("Success") >= 0) return Net::Ok;
    if (code > 0) return Net::Captive;
    return Net::Offline;
  }

  void probeLoop() {
    for (;;) {
      if (!probeRequested || !gotIp) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }
      probeRequested = false;
      netState = Net::Checking;
      String location;
      const Net result = probeOnce(location);
      if (take()) { captiveUrlText = location; give(); }
      netState = result;
      Serial.printf("[wifi] internet: %s%s%s\n", netName(result), location.isEmpty() ? "" : ", sign-in page ", location.c_str());
      nextProbeMs = millis() + (result == Net::Ok ? PROBE_OK_RECHECK_MS : PROBE_BAD_RECHECK_MS);
    }
  }

  // ---- the stored profile ------------------------------------------------------------

  String getBlob(const char *key) {
    const size_t length = preferences.getBytesLength(key);
    if (length == 0 || length > PEM_MAX + 1) return String();
    char *buffer = static_cast<char *>(malloc(length + 1));
    if (!buffer) return String();
    const size_t read = preferences.getBytes(key, buffer, length);
    buffer[read] = '\0';
    String out(buffer);
    free(buffer);
    return out;
  }

  bool putBlob(const char *key, const String &value) {
    if (value.isEmpty()) { preferences.remove(key); return true; }
    return preferences.putBytes(key, value.c_str(), value.length()) == value.length();
  }

  bool putText(const char *key, const String &value) {
    if (value.isEmpty()) { preferences.remove(key); return true; }
    return preferences.putString(key, value) == value.length();
  }

  bool loadCredentials() {
    if (!preferences.begin(preferencesNamespace.c_str(), true)) {
      preferences.end();
      // Namespace may not exist yet; open read-write to create it.
      if (!preferences.begin(preferencesNamespace.c_str(), false)) {
        error = F("Could not open Wi-Fi credential storage");
        return false;
      }
    }
    stored = AtechWifiProfile();
    stored.ssid = preferences.getString("ssid", "");
    stored.pass = preferences.getString("pass", "");
    stored.auth = preferences.getUChar("auth", ATECH_WIFI_PERSONAL);
    stored.identity = preferences.getString("ident", "");
    stored.username = preferences.getString("user", "");
    stored.domain = preferences.getString("domain", "");
    stored.phase2 = preferences.getUChar("ph2", ATECH_TTLS_MSCHAPV2);
    stored.caBundle = preferences.getBool("cabund", false);
    stored.ca = getBlob("ca");
    stored.cert = getBlob("crt");
    stored.key = getBlob("key");
    preferences.end();
    if (stored.auth > ATECH_WIFI_TLS) stored.auth = ATECH_WIFI_PERSONAL;
    if (stored.phase2 > ATECH_TTLS_CHAP) stored.phase2 = ATECH_TTLS_MSCHAPV2;
    stationWanted = !stored.ssid.isEmpty();
    return true;
  }

  bool persistProfile(const AtechWifiProfile &p) {
    if (!preferences.begin(preferencesNamespace.c_str(), false)) {
      error = F("Could not open Wi-Fi credential storage");
      return false;
    }
    // Certificates first and the method last: a write that fails midway (storage full) leaves a
    // profile that is empty, never "enterprise without its trust anchor". Blob lengths are read back.
    bool ok = putBlob("ca", p.ca) && putBlob("crt", p.cert) && putBlob("key", p.key) &&
              preferences.getBytesLength("ca") == p.ca.length() && preferences.getBytesLength("crt") == p.cert.length() &&
              preferences.getBytesLength("key") == p.key.length();
    ok = ok && putText("ssid", p.ssid) && putText("pass", p.pass) && putText("ident", p.identity) && putText("user", p.username) &&
         putText("domain", p.domain) && preferences.putUChar("ph2", p.phase2) == 1 && preferences.putBool("cabund", p.caBundle) == 1 &&
         preferences.putUChar("auth", p.auth) == 1;
    if (!ok) {
      for (const char *key : {"ssid", "pass", "auth", "ident", "user", "domain", "ph2", "cabund", "ca", "crt", "key"}) preferences.remove(key);
    }
    preferences.end();
    if (!ok) error = F("Could not persist the Wi-Fi profile (storage full?); nothing was kept");
    return ok;
  }

  bool eraseCredentials() {
    if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
    for (const char *key : {"ssid", "pass", "auth", "ident", "user", "domain", "ph2", "cabund", "ca", "crt", "key"}) preferences.remove(key);
    preferences.end();
    return true;
  }

  // Validates a profile the way every provisioning path (Bluetooth, hotspot page) relies on; the
  // texts are shared with builder/lib/fake-prov-board.js.
  bool validateProfile(AtechWifiProfile &p) {
    if (p.ssid.isEmpty() || p.ssid.length() > 32) { error = F("SSID must contain 1 to 32 characters"); return false; }
    if (p.auth > ATECH_WIFI_TLS) { error = F("Unknown Wi-Fi security method"); return false; }
    if (p.auth == ATECH_WIFI_PERSONAL) {
      if (!p.pass.isEmpty() && (p.pass.length() < 8 || p.pass.length() > 63)) {
        error = F("Wi-Fi password must contain 8 to 63 characters (or be empty for an open network)");
        return false;
      }
      p.identity = ""; p.username = ""; p.ca = ""; p.cert = ""; p.key = ""; p.domain = ""; p.phase2 = ATECH_TTLS_MSCHAPV2; p.caBundle = false;
      return true;
    }
    if (p.ca.isEmpty() && !p.caBundle) { error = CA_REFUSAL; return false; }
    if (!p.ca.isEmpty() && !p.ca.startsWith("-----BEGIN")) { error = F("The CA certificate is not PEM"); return false; }
    if ((p.auth == ATECH_WIFI_PEAP || p.auth == ATECH_WIFI_TTLS) && (p.username.isEmpty() || p.pass.isEmpty())) {
      error = F("PEAP and TTLS need a username and password");
      return false;
    }
    if (p.auth == ATECH_WIFI_TLS) {
      if (p.cert.isEmpty() || p.key.isEmpty()) { error = F("EAP-TLS needs a client certificate and its private key"); return false; }
      if (p.identity.isEmpty()) { error = F("EAP-TLS needs an identity (usually the certificate subject)"); return false; }
      if (!p.cert.startsWith("-----BEGIN") || !p.key.startsWith("-----BEGIN")) { error = F("The client certificate or key is not PEM"); return false; }
      p.pass = "";
    } else {
      p.cert = ""; p.key = "";
    }
    if (p.auth != ATECH_WIFI_TTLS) p.phase2 = ATECH_TTLS_MSCHAPV2;
    if (p.phase2 > ATECH_TTLS_CHAP) { error = F("Unknown TTLS phase 2 method"); return false; }
    if (p.ca.length() > PEM_MAX || p.cert.length() > PEM_MAX || p.key.length() > PEM_MAX) { error = F("A certificate or key is too long (4 KiB limit)"); return false; }
    if (p.ca.length() + p.cert.length() + p.key.length() > PEM_TOTAL_MAX) { error = F("Certificates and key together exceed 10 KiB; use a shorter CA chain or the built-in bundle"); return false; }
    if (p.identity.length() > FIELD_MAX || p.username.length() > FIELD_MAX || p.domain.length() > FIELD_MAX || p.pass.length() > FIELD_MAX) {
      error = F("Identity, username, password and server name are at most 128 characters");
      return false;
    }
    return true;
  }

  // ---- Wi-Fi mode and station ----------------------------------------------

  void applyMode() {
    wifi_mode_t mode = WIFI_OFF;
    if (apActive && (stationWanted || radioHold)) mode = WIFI_AP_STA;
    else if (apActive) mode = WIFI_AP;
    else if (stationWanted || radioHold) mode = WIFI_STA;
    WiFi.mode(mode);
  }

  // Associates with the stored profile. Enterprise methods validate the authentication server
  // against the CA or the built-in bundle (and the expected name when one is set); only the
  // certificate validity window is skipped, because the board has no clock before its first network.
  void connectStation() {
    if (stored.auth == ATECH_WIFI_PERSONAL) {
      WiFi.setMinSecurity(stored.pass.isEmpty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK);
      WiFi.begin(stored.ssid.c_str(), stored.pass.isEmpty() ? nullptr : stored.pass.c_str());
      return;
    }
    // The invariant every provisioning path enforces at save time holds at connect time too: an
    // enterprise profile with neither a CA nor the bundle (a damaged or foreign NVS) never associates,
    // because the supplicant would then skip server certificate validation.
    if (stored.ca.isEmpty() && !stored.caBundle) {
      error = F("Stored enterprise profile has no trust anchor; not joining");
      Serial.println(F("[wifi] enterprise profile has no trust anchor; not joining (set the CA or the bundle on the board page)"));
      stationWanted = false;
      return;
    }
#if defined(ATECH_HAS_EAP) && defined(CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT)
    esp_eap_client_set_disable_time_check(true);
    // The server certificate is validated against the given CA or the built-in bundle; a CA left over
    // from a previous profile is cleared so the bundle choice is the only trust anchor.
    if (stored.caBundle) esp_eap_client_clear_ca_cert();
    else esp_eap_client_set_ca_cert(reinterpret_cast<const unsigned char *>(stored.ca.c_str()), stored.ca.length());
    esp_eap_client_use_default_cert_bundle(stored.caBundle);
    esp_eap_client_set_domain_name(stored.domain.isEmpty() ? nullptr : stored.domain.c_str());
    const wpa2_auth_method_t method = stored.auth == ATECH_WIFI_TLS ? WPA2_AUTH_TLS : stored.auth == ATECH_WIFI_TTLS ? WPA2_AUTH_TTLS : WPA2_AUTH_PEAP;
    const String identity = stored.identity.isEmpty() ? stored.username : stored.identity;
    WiFi.setMinSecurity(WIFI_AUTH_WPA2_ENTERPRISE);
    WiFi.begin(stored.ssid.c_str(), method, identity.c_str(), stored.username.c_str(), stored.pass.c_str(),
               stored.ca.isEmpty() ? nullptr : stored.ca.c_str(), stored.cert.isEmpty() ? nullptr : stored.cert.c_str(),
               stored.key.isEmpty() ? nullptr : stored.key.c_str(), stored.auth == ATECH_WIFI_TTLS ? static_cast<int>(stored.phase2) : -1);
#else
    Serial.println(F("[wifi] this build has no enterprise Wi-Fi support"));
#endif
  }

  void startStation() {
    if (!stationWanted) return;
    WiFi.persistent(false);
    WiFi.setHostname(hostnameText.c_str());
    applyMode();
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    lastAttemptMs = millis();
    connectStation();
    Serial.printf("[wifi] joining \"%s\" (%s) as %s\n", stored.ssid.c_str(), AUTH_NAMES[stored.auth], hostnameText.c_str());
  }

  void onEvent(arduino_event_id_t event, const arduino_event_info_t &info) {
    switch (event) {
      case ARDUINO_EVENT_WIFI_STA_GOT_IP:
        gotIp = true;
        servicesPending = true;
        connectedAtMs = millis();
        probeRequested = true;
        nextProbeMs = 0;
        break;
      case ARDUINO_EVENT_WIFI_STA_LOST_IP:
        gotIp = false;
        netState = Net::Unknown;
        break;
      case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
        gotIp = false;
        netState = Net::Unknown;
        lastDisconnectMs = millis();
        lastDisconnectReason = info.wifi_sta_disconnected.reason;
        break;
      default:
        break;
    }
  }

  bool ensureMdns() {
    if (mdnsStarted) return true;
    if (!MDNS.begin(hostnameText.c_str())) {
      Serial.println(F("[wifi] mDNS did not start; discovery falls back to manual IP"));
      return false;
    }
    MDNS.addService("atech-ota", "tcp", config.port);
    MDNS.addServiceTxt("atech-ota", "tcp", "id", atech::deviceId());
    MDNS.addServiceTxt("atech-ota", "tcp", "suffix", atech::pairingSuffix());
    MDNS.addServiceTxt("atech-ota", "tcp", "demo", String(config.demo).c_str());
    MDNS.addServiceTxt("atech-ota", "tcp", "fw", config.firmwareVersion ? config.firmwareVersion : "");
    MDNS.addServiceTxt("atech-ota", "tcp", "proto", PROTOCOL_VERSION);
    mdnsStarted = true;
    return true;
  }

  void startServices() {
    servicesPending = false;
    ensureMdns();
    // Time for TLS certificate validity checks (cloud agent, future EAP sessions).
    if (!sntpStarted) { configTime(0, 0, "pool.ntp.org", "time.google.com"); sntpStarted = true; }
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
    json += jsonEscape(stored.ssid);
    json += F("\",\"auth\":\"");
    json += AUTH_NAMES[stored.auth];
    json += F("\",\"internet\":\"");
    json += netName(netState);
    json += F("\",\"captive_url\":\"");
    json += jsonEscape(captiveUrlText);
    json += F("\",\"mac\":\"");
    json += WiFi.macAddress();
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
    if (config.syncIdentity) {
      const String sync = config.syncIdentity();
      if (sync.startsWith("{")) { identity += F(",\"sync\":"); identity += sync; }
    }
    if (config.transportIdentity) {
      const String transport = config.transportIdentity();
      if (transport.startsWith("{")) { identity += F(",\"transport\":"); identity += transport; }
    }
    // The signing state (key id, highest confirmed app version) so the dashboard can foresee a downgrade.
    identity += F(",\"sign\":");
    identity += atech::fwsign::statusJson();
    identity += F("}");
    return identity;
  }

  // ---- upload session ---------------------------------------------------------

  void releaseSessionResources() {
    sink.abort();
    if (session.buffer) {
      free(session.buffer);
      session.buffer = nullptr;
    }
    session.active = false;
    session.pendingKey = String();
    session.id[0] = '\0';
  }

  void abortSession(const String &message, bool resumeApp = true) {
    if (!session.active && !sink.active()) return;
    releaseSessionResources();
    lastTransferError = message;
    atech::coreReleaseOta("lan");
#ifdef ATECH_HAS_COEX
    esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
#endif
    if (resumeApp) atech::coreResumeApp();
    Serial.printf("[lan-ota] aborted: %s\n", message.c_str());
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

    // The signed manifest (shared/AtechFwSign): the backend signs build, demo, size, digest, version,
    // downgrade flag and this board's id; the sink verifies it at finish. The HMAC above proves the
    // backend holds the pairing token, so the first signing key may be pinned here.
    String signature = header(req, "X-Atech-Sig");
    signature.toLowerCase();
    String target = header(req, "X-Atech-Target");
    target.trim();
    target.toUpperCase();
    uint32_t version = 0;
    if (!signature.isEmpty()) {
      if (!isHex(signature, 128)) return sendError(req, 400, F("Invalid firmware signature"));
      if (!parseUnsigned(header(req, "X-Atech-Version"), version)) return sendError(req, 400, F("Missing or invalid firmware version"));
      if (!target.isEmpty() && target != atech::deviceId()) return sendError(req, 403, String(F("This upload is signed for ")) + target + F(", not this board"));
    }
    // The key rides with the upload and is pinned in finish(), after the sink accepted the image.
    String pendingKey = header(req, "X-Atech-Key");
    pendingKey.toLowerCase();

    if (rebootAtMs != 0 || verifiedPendingReboot) return sendError(req, 409, F("A verified update is rebooting"));
    if (session.active) {
      if (millis() - session.lastActivityMs < config.sessionTimeoutMs) return sendError(req, 409, F("Another LAN upload is in progress"));
      abortSession(F("Replaced a stalled upload session"));
    }
    if (config.otherOtaBusy && config.otherOtaBusy()) return sendError(req, 409, F("Bluetooth or hotspot update is active; wait for it to finish"));
    if (!atech::coreTryAcquireOta("lan")) {
      return sendError(req, 409, String(F("Flash is owned by the ")) + atech::coreOtaOwner() + F(" updater"));
    }
    session.buffer = static_cast<uint8_t *>(heap_caps_malloc(RECV_BUFFER_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    if (!session.buffer) session.buffer = static_cast<uint8_t *>(malloc(RECV_BUFFER_BYTES));
    if (!session.buffer) {
      atech::coreReleaseOta("lan");
      return sendError(req, 500, F("Could not allocate the receive buffer"));
    }
    const uint32_t eraseStart = millis();
    String reason;
    if (!sink.begin(size, sha, build, imageIdentity, reason)) {
      free(session.buffer);
      session.buffer = nullptr;
      atech::coreReleaseOta("lan");
      return sendError(req, reason.startsWith("Firmware is larger") ? 413 : reason.startsWith("Could not") ? 500 : 400, reason);
    }
    const uint32_t eraseMs = millis() - eraseStart;
    if (!signature.isEmpty()) {
      atech::fwsign::Manifest manifest;
      manifest.build = build;
      manifest.demo = config.demo;
      manifest.size = size;
      manifest.sha256 = sha;
      manifest.version = version;
      manifest.downgrade = header(req, "X-Atech-Downgrade") == "1";
      manifest.target = target;
      manifest.signature = signature;
      if (!atech::fwsign::hasKey()) manifest.candidateKey = pendingKey;
      sink.setManifest(manifest);
    }
    session.expectedSize = size;
    session.received = 0;
    session.buildId = build;
    session.pendingKey = pendingKey;
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
    Serial.printf("[lan-ota] session %s: %lu bytes into %s (erase %lu ms) build %s (%s)\n", session.id,
                  static_cast<unsigned long>(size), sink.partitionLabel(), static_cast<unsigned long>(eraseMs), build.c_str(),
                  signature.isEmpty() ? "unsigned" : "signed");
    String body = F("{\"ok\":true,\"session\":\"");
    body += session.id;
    body += F("\",\"chunk_max\":");
    body += String(CHUNK_MAX_BYTES);
    body += F(",\"partition\":\"");
    body += sink.partitionLabel();
    body += F("\",\"slot_size\":");
    body += String(sink.partitionSize());
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
      if (!sink.write(session.buffer, static_cast<size_t>(read), reason)) {
        abortSession(reason);
        return sendError(req, 422, reason, true);
      }
      session.received = sink.received();
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
    const uint32_t transferMs = session.firstChunkMs ? millis() - session.firstChunkMs : 0;
    // Markers, digest, signature, version policy, ESP image validation and slot selection: the sink
    // selects the slot only when every check passed, exactly as on the cloud and hotspot paths.
    const uint32_t verifyStart = millis();
    String reason;
    if (!sink.finish(reason)) {
      abortSession(reason);
      return sendError(req, 422, reason);
    }
    if (!session.pendingKey.isEmpty() && !atech::fwsign::hasKey()) atech::fwsign::pinKey(session.pendingKey, "lan");
    session.pendingKey = String();
    const String actualSha = sink.digestHex();
    const uint32_t verifyMs = millis() - verifyStart;
    lastTransferMs = transferMs;
    lastTransferError = "";
    const String partitionLabel = sink.partitionLabel();
    // Keep the flash lock and the suspended app until the restart.
    session.active = false;
    session.pendingKey = String();
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

  // Board-to-board sync relayed by the backend: the HMAC proves the board's owner, so the command
  // runs privileged (pairing codes, pair, unpair, set, toggle, event).
  static esp_err_t handleSync(httpd_req_t *req) {
    Impl *impl = self(req);
    if (!impl->take()) return sendError(req, 503, F("Service busy"));
    const esp_err_t result = impl->sync(req);
    impl->give();
    return result;
  }

  esp_err_t sync(httpd_req_t *req) {
    const String device = header(req, "X-Atech-Device");
    const String nonce = header(req, "X-Atech-Nonce");
    const String auth = header(req, "X-Atech-Auth");
    if (device != atech::deviceId()) return sendError(req, 403, String(F("Request addressed to another board; this board is ")) + atech::deviceId());
    if (!config.syncCommand) return sendError(req, 503, F("This image has no board-to-board sync"));
    if (req->content_len > SYNC_BODY_MAX) return sendError(req, 413, F("Request body too large"));
    char buffer[SYNC_BODY_MAX + 1];
    size_t got = 0;
    while (got < req->content_len) {
      const int read = httpd_req_recv(req, buffer + got, req->content_len - got);
      if (read <= 0) return sendError(req, 400, F("Could not read the request body"));
      got += static_cast<size_t>(read);
    }
    buffer[got] = '\0';
    const String body(buffer);
    if (!consumeNonce(nonce)) return sendError(req, 401, F("Unknown, used or expired nonce; request a new challenge"));
    String message = F("atech-sync/1\n");
    message += device; message += '\n';
    String nonceLower = nonce; nonceLower.toLowerCase();
    message += nonceLower; message += '\n';
    message += body; message += '\n';
    if (!verifyAuth(message, auth)) return sendError(req, 401, F("Authorization failed"));
    return sendJson(req, 200, config.syncCommand(body));
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
    httpdConfig.max_uri_handlers = 12;
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
        {"/api/sync", HTTP_POST, handleSync, this},
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
    if (gotIp && netState != Net::Checking && nextProbeMs != 0 && static_cast<int32_t>(now - nextProbeMs) >= 0 && !probeRequested) {
      probeRequested = true;
      nextProbeMs = 0;
    }
    if (stationWanted && !gotIp && !apActiveScanGuard() &&
        now - lastAttemptMs >= config.reconnectIntervalMs) {
      lastAttemptMs = now;
      Serial.printf("[wifi] not connected (reason %d); retrying \"%s\"\n", lastDisconnectReason, stored.ssid.c_str());
      WiFi.disconnect(false, false, 0);
      connectStation();
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
  if (xTaskCreatePinnedToCore(Impl::probeMain, "atech_net", PROBE_TASK_STACK, impl, 1, &impl->probeTask, 0) != pdPASS) {
    impl->probeTask = nullptr;
    Serial.println(F("[wifi] internet probe task did not start; reachability stays unknown"));
  }
  _impl->initialized = true;
  if (_impl->stationWanted) {
    _impl->startStation();
  } else {
    Serial.println(F("[wifi] no home Wi-Fi configured; hold BOOT for 3 s and open the hotspot portal to set it up"));
  }
  return true;
}

void AtechWifiLan::loop() { if (_impl) _impl->service(); }

bool AtechWifiLan::hasCredentials() const { return _impl && !_impl->stored.ssid.isEmpty(); }

bool AtechWifiLan::saveCredentials(const String &ssid, const String &password) {
  AtechWifiProfile profile;
  profile.ssid = ssid;
  profile.pass = password;
  return saveProfile(profile);
}

bool AtechWifiLan::saveProfile(const AtechWifiProfile &input) {
  if (!_impl || !_impl->initialized) return false;
  AtechWifiProfile profile = input;
  if (!_impl->validateProfile(profile)) return false;
  if (!_impl->persistProfile(profile)) return false;
  WiFi.disconnect(false, false, 0);
  _impl->stored = profile;
  _impl->stationWanted = true;
  _impl->gotIp = false;
  _impl->lastDisconnectReason = 0;
  _impl->startStation();
  return true;
}

AtechWifiProfile AtechWifiLan::profile() const {
  AtechWifiProfile copy;
  if (!_impl) return copy;
  copy = _impl->stored;
  copy.pass = "";
  copy.key = "";
  return copy;
}

uint8_t AtechWifiLan::authMethod() const { return _impl ? _impl->stored.auth : ATECH_WIFI_PERSONAL; }
const char *AtechWifiLan::authName() const { return AUTH_NAMES[authMethod()]; }
const char *AtechWifiLan::authName(uint8_t auth) { return auth <= ATECH_WIFI_TLS ? AUTH_NAMES[auth] : "unknown"; }
bool AtechWifiLan::parseAuth(const String &text, uint8_t &auth) {
  if (text.isEmpty()) { auth = ATECH_WIFI_PERSONAL; return true; }
  for (uint8_t i = 0; i <= ATECH_WIFI_TLS; ++i) if (text == AUTH_NAMES[i]) { auth = i; return true; }
  return false;
}
const char *AtechWifiLan::phase2Name(uint8_t phase2) { return phase2 <= ATECH_TTLS_CHAP ? PHASE2_NAMES[phase2] : "unknown"; }
bool AtechWifiLan::parsePhase2(const String &text, uint8_t &phase2) {
  if (text.isEmpty()) { phase2 = ATECH_TTLS_MSCHAPV2; return true; }
  for (uint8_t i = 0; i <= ATECH_TTLS_CHAP; ++i) if (text == PHASE2_NAMES[i]) { phase2 = i; return true; }
  return false;
}

bool AtechWifiLan::forgetCredentials() {
  if (!_impl || !_impl->initialized) return false;
  if (!_impl->eraseCredentials()) return false;
  _impl->stored = AtechWifiProfile();
  _impl->stationWanted = false;
  _impl->gotIp = false;
  WiFi.disconnect(false, true);
  if (_impl->mdnsStarted) { MDNS.end(); _impl->mdnsStarted = false; }
  _impl->applyMode();
  Serial.println(F("[wifi] home Wi-Fi credentials forgotten"));
  return true;
}

String AtechWifiLan::configuredSsid() const { return _impl ? _impl->stored.ssid : String(); }
int AtechWifiLan::lastDisconnectReason() const { return _impl ? _impl->lastDisconnectReason : 0; }
bool AtechWifiLan::isConnected() const { return _impl && _impl->stationWanted && _impl->gotIp; }
bool AtechWifiLan::stationEnabled() const { return _impl && _impl->stationWanted; }
IPAddress AtechWifiLan::ip() const { return isConnected() ? WiFi.localIP() : IPAddress(); }
int AtechWifiLan::rssi() const { return isConnected() ? WiFi.RSSI() : 0; }
String AtechWifiLan::hostname() const { return _impl ? _impl->hostnameText : String(); }
String AtechWifiLan::stationMac() const { return WiFi.macAddress(); }
const char *AtechWifiLan::internetState() const { return _impl ? netName(_impl->netState) : "unknown"; }
String AtechWifiLan::captiveUrl() const {
  if (!_impl || !_impl->tryTake()) return String();
  const String copy = _impl->captiveUrlText;
  _impl->give();
  return copy;
}
void AtechWifiLan::recheckInternet() { if (_impl) { _impl->probeRequested = true; _impl->nextProbeMs = 0; } }
bool AtechWifiLan::ensureMdns() { return _impl && _impl->initialized && _impl->ensureMdns(); }
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
    const bool enterprise = isEnterpriseAuth(auth);
    json += F("{\"ssid\":\"");
    json += jsonEscape(ssid);
    json += F("\",\"rssi\":");
    json += String(bestRssi);
    json += F(",\"channel\":");
    json += String(bestChannel);
    json += F(",\"open\":");
    json += auth == WIFI_AUTH_OPEN ? F("true") : F("false");
    json += F(",\"enterprise\":");
    json += enterprise ? F("true") : F("false");
    json += F(",\"auth\":\"");
    json += auth == WIFI_AUTH_OPEN ? "open" : enterprise ? "enterprise" : "personal";
    json += F("\"}");
  }
  json += ']';
  WiFi.scanDelete();
  if (before != WiFi.getMode()) _impl->applyMode();
  return json;
}

String AtechWifiLan::scanLines(size_t maxNetworks) {
  if (!_impl) return String();
  const wifi_mode_t before = WiFi.getMode();
  if (before != WIFI_STA && before != WIFI_AP_STA) WiFi.mode(before == WIFI_AP ? WIFI_AP_STA : WIFI_STA);
  const int16_t count = WiFi.scanNetworks(false, false, false, 120);
  String lines;
  size_t emitted = 0;
  for (int16_t i = 0; i < count && emitted < maxNetworks; ++i) {
    const String ssid = WiFi.SSID(i);
    if (ssid.isEmpty() || ssid.indexOf('\t') >= 0 || ssid.indexOf('\n') >= 0) continue;
    bool duplicate = false;
    for (int16_t j = 0; j < i; ++j) if (WiFi.SSID(j) == ssid) { duplicate = true; break; }
    if (duplicate) continue;
    int32_t bestRssi = WiFi.RSSI(i);
    wifi_auth_mode_t auth = WiFi.encryptionType(i);
    for (int16_t j = i + 1; j < count; ++j) {
      if (WiFi.SSID(j) == ssid && WiFi.RSSI(j) > bestRssi) { bestRssi = WiFi.RSSI(j); auth = WiFi.encryptionType(j); }
    }
    lines += ssid; lines += '\t'; lines += String(bestRssi); lines += '\t'; lines += auth == WIFI_AUTH_OPEN ? '1' : '0';
    lines += '\t'; lines += isEnterpriseAuth(auth) ? '1' : '0'; lines += '\n';
    ++emitted;
  }
  WiFi.scanDelete();
  if (before != WiFi.getMode()) _impl->applyMode();
  return lines;
}

void AtechWifiLan::setRadioHold(bool hold) {
  if (!_impl) return;
  _impl->radioHold = hold;
  _impl->applyMode();
  if (hold) WiFi.setSleep(false);
}

bool AtechWifiLan::radioHeld() const { return _impl && _impl->radioHold; }

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
