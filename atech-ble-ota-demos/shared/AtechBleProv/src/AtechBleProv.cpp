// AtechBleProv.cpp: see AtechBleProv.h. Wire format, canonical strings and refusals are shared
// with web-shared/atech-provision.js and builder/lib/fake-prov-board.js; keep them byte-identical.
#include "AtechBleProv.h"

#include <AtechCloudOta.h>
#include <AtechCore.h>
#include <AtechSync.h>
#include <AtechWifiLan.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <Preferences.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <mbedtls/ecdh.h>
#include <mbedtls/gcm.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>

#include <algorithm>
#include <cstring>

namespace {

// Embedded so the backend can prove every image carries the provisioning service (jobs.js PROV_MARKER).
const char PROV_MARKER[] = "ATECH-PROV:1";
constexpr char SERVICE_UUID[] = "a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char STATUS_UUID[] = "a7ec0201-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char REQUEST_UUID[] = "a7ec0202-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char REPLY_UUID[] = "a7ec0203-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char HKDF_INFO[] = "atech-prov/1";
constexpr char GRANT_PREFIX[] = "atech-prov-grant/1\n";
constexpr size_t MAX_FRAGMENT = 240;
constexpr size_t MAX_MESSAGE = 1024;
constexpr size_t FRAME_MAX = MAX_FRAGMENT + 2;
constexpr uint32_t FRAGMENT_TIMEOUT_MS = 5000;
constexpr size_t PROV_NONCE_BYTES = 16;
constexpr size_t PROV_IV_BYTES = 12;
constexpr size_t PROV_TAG_BYTES = 16;
constexpr size_t PUBKEY_BYTES = 65;
constexpr size_t KEY_BYTES = 32;
constexpr size_t QUEUE_DEPTH = 8;
constexpr uint32_t NOTIFY_GAP_MS = 15;
constexpr uint8_t FLAG_LAST = 0x01;
constexpr uint8_t FLAG_FIRST = 0x02;
constexpr uint8_t OP_HELLO = 0x01;
constexpr uint8_t OP_SCAN = 0x02;
constexpr uint8_t OP_PROVISION = 0x03;
constexpr uint8_t OP_FORGET = 0x04;
constexpr uint8_t OP_SYNC = 0x05;
constexpr uint8_t REPLY_BIT = 0x80;
constexpr uint8_t OP_ERROR = 0xff;
constexpr size_t SCAN_LIMIT = 12;

struct Frame {
  uint16_t length;
  uint8_t bytes[FRAME_MAX];
};

const char HEX_DIGITS[] = "0123456789abcdef";

int rng(void *, unsigned char *out, size_t length) {
  esp_fill_random(out, length);
  return 0;
}

String hexEncode(const uint8_t *bytes, size_t length) {
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out += HEX_DIGITS[bytes[i] >> 4];
    out += HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

bool constantTimeEquals(const String &left, const String &right) {
  if (left.length() != right.length()) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < left.length(); ++i) difference |= uint8_t(left[i] ^ right[i]);
  return difference == 0;
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

// application/x-www-form-urlencoded value (the same alphabet as URLSearchParams keeps).
String formEncode(const String &text) {
  String out;
  out.reserve(text.length() + 8);
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '*') out += c;
    else if (c == ' ') out += '+';
    else { out += '%'; out += HEX_DIGITS[static_cast<uint8_t>(c) >> 4]; out += HEX_DIGITS[static_cast<uint8_t>(c) & 0x0f]; }
  }
  return out;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

String percentDecode(const String &text) {
  String out;
  out.reserve(text.length());
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (c == '+') out += ' ';
    else if (c == '%' && i + 2 < text.length() && hexValue(text[i + 1]) >= 0 && hexValue(text[i + 2]) >= 0) {
      out += static_cast<char>(hexValue(text[i + 1]) * 16 + hexValue(text[i + 2]));
      i += 2;
    } else out += c;
  }
  return out;
}

// key=value&key=value; returns true when the key is present (value may be empty).
bool formGet(const String &body, const char *key, String &value) {
  const size_t keyLength = strlen(key);
  size_t at = 0;
  while (at <= body.length()) {
    int amp = body.indexOf('&', at);
    if (amp < 0) amp = body.length();
    const int eq = body.indexOf('=', at);
    const size_t end = eq >= 0 && eq < amp ? static_cast<size_t>(eq) : static_cast<size_t>(amp);
    if (end - at == keyLength && strncmp(body.c_str() + at, key, keyLength) == 0) {
      value = eq >= 0 && eq < amp ? percentDecode(body.substring(eq + 1, amp)) : String();
      return true;
    }
    at = static_cast<size_t>(amp) + 1;
  }
  return false;
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

}  // namespace

struct AtechBleProv::Impl {
  AtechBleProvConfig config = {};
  String preferencesNamespace;
  String error;
  bool initialized = false;
  bool locked = false;
  uint32_t unlockUntilMs = 0;   // 0: no window open
  QueueHandle_t queue = nullptr;
  BLECharacteristic *statusChar = nullptr;
  BLECharacteristic *requestChar = nullptr;
  BLECharacteristic *replyChar = nullptr;

  // Request reassembly (main loop only).
  uint8_t message[MAX_MESSAGE];
  size_t size = 0;
  uint8_t expectedSeq = 0;
  bool open = false;
  uint32_t openedAtMs = 0;
  // Outgoing frame and sealed-reply scratch (main loop only).
  uint8_t frame[FRAME_MAX];
  uint8_t scratch[MAX_MESSAGE];

  // Session: ephemeral key for this BLE connection, replaced by every hello.
  bool haveKey = false;
  uint8_t key[KEY_BYTES] = {};
  uint8_t nonce[PROV_NONCE_BYTES] = {};
  uint8_t transcript[32] = {};
  mbedtls_gcm_context gcm;
  bool gcmReady = false;

  ~Impl() {
    dropSession();
    if (queue) vQueueDelete(queue);
  }

  // ---- persistence --------------------------------------------------------------------

  bool loadLock() {
    Preferences preferences;
    if (!preferences.begin(preferencesNamespace.c_str(), true)) {
      preferences.end();
      if (!preferences.begin(preferencesNamespace.c_str(), false)) { error = F("Could not open provisioning storage"); return false; }
    }
    locked = preferences.getBool("locked", false);
    preferences.end();
    return true;
  }

  void setLocked(bool value) {
    locked = value;
    Preferences preferences;
    if (preferences.begin(preferencesNamespace.c_str(), false)) {
      preferences.putBool("locked", value);
      preferences.end();
    }
  }

  bool unlockOpen() const { return unlockUntilMs != 0 && static_cast<int32_t>(millis() - unlockUntilMs) < 0; }

  // ---- framing -----------------------------------------------------------------------------

  // Mirrors createReassembler() in atech-provision.js: a first flag starts over, a wrong sequence
  // number or an oversized message drops the collected bytes.
  bool push(const Frame &incoming) {
    if (incoming.length < 3) { open = false; size = 0; return false; }
    const uint8_t flags = incoming.bytes[0];
    const uint8_t seq = incoming.bytes[1];
    if (flags & FLAG_FIRST) { open = true; size = 0; expectedSeq = 0; openedAtMs = millis(); }
    if (!open || seq != expectedSeq) { open = false; size = 0; return false; }
    const size_t payload = incoming.length - 2;
    if (size + payload > MAX_MESSAGE) { open = false; size = 0; return false; }
    memcpy(message + size, incoming.bytes + 2, payload);
    size += payload;
    expectedSeq = static_cast<uint8_t>(expectedSeq + 1);
    if (!(flags & FLAG_LAST)) return false;
    open = false;
    return true;
  }

  void send(uint8_t opcode, const uint8_t *body, size_t length) {
    if (!replyChar || length + 1 > MAX_MESSAGE) return;
    const size_t total = length + 1;
    uint8_t seq = 0;
    for (size_t offset = 0; offset < total; offset += MAX_FRAGMENT, ++seq) {
      const size_t count = std::min(MAX_FRAGMENT, total - offset);
      frame[0] = (offset == 0 ? FLAG_FIRST : 0) | (offset + count >= total ? FLAG_LAST : 0);
      frame[1] = seq;
      for (size_t i = 0; i < count; ++i) {
        const size_t at = offset + i;
        frame[2 + i] = at == 0 ? opcode : body[at - 1];
      }
      replyChar->setValue(frame, count + 2);
      replyChar->notify();
      if (offset + count < total) delay(NOTIFY_GAP_MS);
    }
  }

  void sendError(const String &text) {
    send(OP_ERROR, reinterpret_cast<const uint8_t *>(text.c_str()), text.length());
  }

  // ---- session ---------------------------------------------------------------------------------

  void dropSession() {
    haveKey = false;
    if (gcmReady) { mbedtls_gcm_free(&gcm); gcmReady = false; }
    memset(key, 0, sizeof(key));
  }

  void hello(const uint8_t *body, size_t length) {
    dropSession();
    if (length != PUBKEY_BYTES || body[0] != 0x04) { sendError(F("Malformed public key")); return; }
    mbedtls_ecdh_context ctx;
    mbedtls_ecdh_init(&ctx);
    uint8_t ours[1 + PUBKEY_BYTES] = {};
    uint8_t theirs[1 + PUBKEY_BYTES] = {};
    uint8_t shared[KEY_BYTES] = {};
    size_t olen = 0;
    bool ok = mbedtls_ecdh_setup(&ctx, MBEDTLS_ECP_DP_SECP256R1) == 0;
    if (ok) ok = mbedtls_ecdh_make_public(&ctx, &olen, ours, sizeof(ours), rng, nullptr) == 0 && olen == sizeof(ours) && ours[0] == PUBKEY_BYTES;
    theirs[0] = PUBKEY_BYTES;
    memcpy(theirs + 1, body, PUBKEY_BYTES);
    if (ok) ok = mbedtls_ecdh_read_public(&ctx, theirs, sizeof(theirs)) == 0;
    if (ok) ok = mbedtls_ecdh_calc_secret(&ctx, &olen, shared, sizeof(shared), rng, nullptr) == 0 && olen == KEY_BYTES;
    mbedtls_ecdh_free(&ctx);
    if (!ok) { sendError(F("Key agreement failed")); return; }
    esp_fill_random(nonce, PROV_NONCE_BYTES);
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    ok = md && mbedtls_hkdf(md, nonce, PROV_NONCE_BYTES, shared, KEY_BYTES, reinterpret_cast<const uint8_t *>(HKDF_INFO), strlen(HKDF_INFO), key, KEY_BYTES) == 0;
    memset(shared, 0, sizeof(shared));
    uint8_t both[2 * PUBKEY_BYTES];
    memcpy(both, body, PUBKEY_BYTES);
    memcpy(both + PUBKEY_BYTES, ours + 1, PUBKEY_BYTES);
    if (ok) ok = mbedtls_sha256(both, sizeof(both), transcript, 0) == 0;
    mbedtls_gcm_init(&gcm);
    gcmReady = true;
    if (ok) ok = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, KEY_BYTES * 8) == 0;
    if (!ok) { dropSession(); sendError(F("Key derivation failed")); return; }
    haveKey = true;
    uint8_t reply[PUBKEY_BYTES + PROV_NONCE_BYTES + 1];
    memcpy(reply, ours + 1, PUBKEY_BYTES);
    memcpy(reply + PUBKEY_BYTES, nonce, PROV_NONCE_BYTES);
    reply[PUBKEY_BYTES + PROV_NONCE_BYTES] = (locked ? 0x01 : 0) | (config.lan && config.lan->hasCredentials() ? 0x02 : 0) |
                                        (config.cloud && config.cloud->isEnabled() ? 0x04 : 0);
    send(OP_HELLO | REPLY_BIT, reply, sizeof(reply));
    Serial.println(F("[prov] secure session established with the dashboard"));
  }

  bool unseal(uint8_t aad, const uint8_t *body, size_t length, String &plain, String &why) {
    if (!haveKey) { why = F("No secure session: send hello first"); return false; }
    if (length < PROV_IV_BYTES + PROV_TAG_BYTES) { why = F("Could not decrypt the request (too short)"); return false; }
    const size_t count = length - PROV_IV_BYTES - PROV_TAG_BYTES;
    const int rc = mbedtls_gcm_auth_decrypt(&gcm, count, body, PROV_IV_BYTES, &aad, 1, body + PROV_IV_BYTES + count, PROV_TAG_BYTES, body + PROV_IV_BYTES, scratch);
    if (rc != 0) { why = F("Could not decrypt the request (authentication failed)"); return false; }
    scratch[count] = 0;
    plain = String(reinterpret_cast<const char *>(scratch));
    memset(scratch, 0, count + 1);
    return true;
  }

  void sendSealed(uint8_t opcode, const String &plain) {
    const size_t count = plain.length();
    if (PROV_IV_BYTES + count + PROV_TAG_BYTES + 1 > MAX_MESSAGE) { sendError(F("Reply too long")); return; }
    esp_fill_random(scratch, PROV_IV_BYTES);
    if (mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, count, scratch, PROV_IV_BYTES, &opcode, 1,
                                  reinterpret_cast<const uint8_t *>(plain.c_str()), scratch + PROV_IV_BYTES, PROV_TAG_BYTES, scratch + PROV_IV_BYTES + count) != 0) {
      sendError(F("Could not encrypt the reply"));
      return;
    }
    send(opcode, scratch, PROV_IV_BYTES + count + PROV_TAG_BYTES);
    memset(scratch, 0, PROV_IV_BYTES + count + PROV_TAG_BYTES);
  }

  void refuse(uint8_t opcode, const String &text) {
    sendSealed(opcode, String(F("ok=0&error=")) + formEncode(text));
  }

  // ---- authorization -----------------------------------------------------------------------------

  // An owned board accepts changes from its owner (grant bound to this session's nonce and both
  // public keys) or within the window a BOOT press opens.
  bool authorized(const String &grant) {
    if (!locked) return true;
    if (unlockOpen()) return true;
    if (grant.length() != 64 || !haveKey || !config.authToken) return false;
    String message = GRANT_PREFIX;
    message += atech::deviceId(); message += '\n';
    message += hexEncode(nonce, PROV_NONCE_BYTES); message += '\n';
    message += hexEncode(transcript, sizeof(transcript)); message += '\n';
    String expected;
    if (!hmacSha256Hex(config.authToken(), message, expected)) return false;
    String presented = grant;
    presented.toLowerCase();
    return constantTimeEquals(expected, presented);
  }

  // ---- requests ----------------------------------------------------------------------------------

  void scan() {
    const String lines = config.lan ? config.lan->scanLines(SCAN_LIMIT) : String();
    send(OP_SCAN | REPLY_BIT, reinterpret_cast<const uint8_t *>(lines.c_str()), lines.length());
  }

  void provision(const uint8_t *body, size_t length) {
    String plain, why;
    if (!unseal(OP_PROVISION, body, length, plain, why)) { sendError(why); return; }
    const uint8_t replyOp = OP_PROVISION | REPLY_BIT;
    String ssid, secret, url, grant, claim;
    const bool hasSsid = formGet(plain, "ssid", ssid);
    formGet(plain, "pass", secret);
    const bool hasUrl = formGet(plain, "url", url);
    formGet(plain, "grant", grant);
    const bool wantToken = formGet(plain, "claim", claim) && claim == "1";
    plain = "";
    if (!authorized(grant)) {
      refuse(replyOp, F("This board is locked: it already has an owner. Ask the owner's dashboard for a grant or press the BOOT button once"));
      return;
    }
    if (config.busy && config.busy()) { refuse(replyOp, F("The board is busy with an update; try again when it is done")); return; }
    if (hasSsid && (ssid.isEmpty() || ssid.length() > 32)) { refuse(replyOp, F("SSID must contain 1 to 32 characters")); return; }
    if (hasSsid && !secret.isEmpty() && (secret.length() < 8 || secret.length() > 63)) {
      refuse(replyOp, F("Wi-Fi password must contain 8 to 63 characters (or be empty for an open network)"));
      return;
    }
    if (hasUrl) {
      url.trim();
      if (!config.cloud) { refuse(replyOp, F("This image has no cloud agent")); return; }
      if (url.isEmpty()) {
        if (!config.cloud->clearServerUrl()) { refuse(replyOp, config.cloud->lastError()); return; }
      } else if (!config.cloud->setServerUrl(url)) {
        refuse(replyOp, config.cloud->lastError());
        return;
      }
    }
    if (hasSsid) {
      if (!config.lan || !config.lan->saveCredentials(ssid, secret)) { refuse(replyOp, config.lan ? config.lan->lastError() : String(F("No Wi-Fi manager"))); return; }
      Serial.printf("[prov] Wi-Fi credentials for \"%s\" stored over Bluetooth; joining\n", ssid.c_str());
    }
    secret = "";
    String reply = F("ok=1&joining=");
    reply += hasSsid ? '1' : '0';
    if (wantToken && config.authToken) { reply += F("&token="); reply += formEncode(config.authToken()); }
    Serial.printf("[prov] provisioning accepted%s%s\n", hasUrl ? " (server URL)" : "", wantToken ? " (pairing token released to the dashboard)" : "");
    sendSealed(replyOp, reply);
  }

  void forget(const uint8_t *body, size_t length) {
    String plain, why;
    if (!unseal(OP_FORGET, body, length, plain, why)) { sendError(why); return; }
    const uint8_t replyOp = OP_FORGET | REPLY_BIT;
    String wifi, url, grant;
    formGet(plain, "wifi", wifi);
    formGet(plain, "url", url);
    formGet(plain, "grant", grant);
    plain = "";
    if (!authorized(grant)) { refuse(replyOp, F("This board is locked: it already has an owner")); return; }
    if (config.busy && config.busy()) { refuse(replyOp, F("The board is busy with an update; try again when it is done")); return; }
    if (wifi == "1" && config.lan && !config.lan->forgetCredentials()) { refuse(replyOp, F("Could not erase the Wi-Fi credentials")); return; }
    if (url == "1" && config.cloud && !config.cloud->clearServerUrl()) { refuse(replyOp, config.cloud->lastError()); return; }
    Serial.printf("[prov] forgot%s%s\n", wifi == "1" ? " Wi-Fi" : "", url == "1" ? " server URL" : "");
    sendSealed(replyOp, F("ok=1"));
  }

  // Board-to-board sync over the sealed session: op=code|pair|unpair|set|toggle|event (see
  // AtechSync::command). Issuing a code, pairing and unpairing change persistent configuration and
  // need the same authorization as a Wi-Fi change on an owned board; setting state does not.
  void sync(const uint8_t *body, size_t length) {
    String plain, why;
    if (!unseal(OP_SYNC, body, length, plain, why)) { sendError(why); return; }
    const uint8_t replyOp = OP_SYNC | REPLY_BIT;
    String op, grant;
    formGet(plain, "op", op);
    formGet(plain, "grant", grant);
    const bool privileged = authorized(grant);
    const bool pairingOp = op == "code" || op == "pair" || op == "unpair";
    if (pairingOp && !privileged) {
      refuse(replyOp, F("This board is locked: it already has an owner. Ask the owner's dashboard for a grant or press the BOOT button once"));
      return;
    }
    if (!config.sync) { refuse(replyOp, F("This image has no board-to-board sync")); return; }
    const AtechSyncResult result = config.sync->command(plain, privileged);
    plain = "";
    if (!result.ok) { refuse(replyOp, result.error); return; }
    String reply = F("ok=1");
    if (!result.code.isEmpty()) { reply += F("&code="); reply += formEncode(result.code); }
    sendSealed(replyOp, reply);
  }

  void handle() {
    if (size == 0) return;
    const uint8_t opcode = message[0];
    const uint8_t *body = message + 1;
    const size_t length = size - 1;
    size = 0;
    switch (opcode) {
      case OP_HELLO: hello(body, length); break;
      case OP_SCAN: scan(); break;
      case OP_PROVISION: provision(body, length); break;
      case OP_FORGET: forget(body, length); break;
      case OP_SYNC: sync(body, length); break;
      default: sendError(String(F("Unknown request ")) + String(opcode)); break;
    }
  }

  void service() {
    if (!initialized) return;
    // The first successful cloud login proves the backend holds this board's token: it has an owner.
    if (!locked && config.cloud && config.cloud->hasSession()) {
      setLocked(true);
      Serial.println(F("[prov] board locked: the cloud backend accepted its credentials; changes now need the owner's grant or a BOOT press"));
    }
    if (open && millis() - openedAtMs > FRAGMENT_TIMEOUT_MS) { open = false; size = 0; }
    Frame incoming;
    while (queue && xQueueReceive(queue, &incoming, 0) == pdTRUE) {
      if (push(incoming)) handle();
    }
  }

  // ---- status ------------------------------------------------------------------------------------

  String statusJson() {
    AtechWifiLan *lan = config.lan;
    AtechCloudOta *cloud = config.cloud;
    const bool connected = lan && lan->isConnected();
    String json;
    json.reserve(420);
    json += F("{\"prov\":1,\"id\":\""); json += atech::deviceId();
    json += F("\",\"locked\":"); json += locked ? F("true") : F("false");
    json += F(",\"unlock_ms\":"); json += String(unlockOpen() ? unlockUntilMs - millis() : 0);
    json += F(",\"session\":"); json += haveKey ? F("true") : F("false");
    json += F(",\"wifi\":{\"configured\":"); json += lan && lan->hasCredentials() ? F("true") : F("false");
    json += F(",\"ssid\":\""); json += jsonEscape(lan ? lan->configuredSsid() : String());
    json += F("\",\"connected\":"); json += connected ? F("true") : F("false");
    json += F(",\"ip\":\""); json += connected ? lan->ip().toString() : String();
    json += F("\",\"rssi\":"); json += String(connected ? lan->rssi() : 0);
    json += F(",\"reason\":"); json += String(lan ? lan->lastDisconnectReason() : 0);
    json += F(",\"joining\":"); json += lan && lan->stationEnabled() && !connected ? F("true") : F("false");
    json += F("},\"cloud\":{\"url\":\""); json += jsonEscape(cloud ? cloud->serverUrl() : String());
    json += F("\",\"state\":\""); json += cloud ? cloud->stateName() : "disabled";
    json += F("\",\"session\":"); json += cloud && cloud->hasSession() ? F("true") : F("false");
    json += F(",\"last_error\":\""); json += jsonEscape(cloud ? cloud->lastError() : String());
    json += F("\"},\"busy\":"); json += config.busy && config.busy() ? F("true") : F("false");
    json += F("}");
    return json;
  }
};

namespace {

class RequestCallbacks : public BLECharacteristicCallbacks {
public:
  explicit RequestCallbacks(AtechBleProv::Impl *owner) : impl(owner) {}
  // Runs on the BLE host task: only enqueue; the main loop does the crypto and the Wi-Fi work.
  void onWrite(BLECharacteristic *characteristic) override {
    const size_t length = characteristic->getLength();
    if (length < 3 || length > FRAME_MAX || !impl->queue) return;
    Frame incoming;
    incoming.length = static_cast<uint16_t>(length);
    memcpy(incoming.bytes, characteristic->getData(), length);
    if (xQueueSend(impl->queue, &incoming, 0) != pdTRUE) Serial.println(F("[prov] request queue full"));
  }

private:
  AtechBleProv::Impl *impl;
};

class StatusCallbacks : public BLECharacteristicCallbacks {
public:
  explicit StatusCallbacks(AtechBleProv::Impl *owner) : impl(owner) {}
  void onRead(BLECharacteristic *characteristic) override { characteristic->setValue(impl->statusJson()); }

private:
  AtechBleProv::Impl *impl;
};

}  // namespace

AtechBleProv::AtechBleProv() : _impl(new Impl()) {}
AtechBleProv::~AtechBleProv() { delete _impl; }

bool AtechBleProv::begin(const AtechBleProvConfig &config) {
  if (!_impl || _impl->initialized) return _impl && _impl->initialized;
  Impl &impl = *_impl;
  impl.config = config;
  impl.preferencesNamespace = config.preferencesNamespace ? config.preferencesNamespace : "atech_prov";
  if (impl.config.unlockWindowMs == 0) impl.config.unlockWindowMs = 120000;
  if (!config.server) { impl.error = F("No BLE server"); return false; }
  if (!impl.loadLock()) return false;
  impl.queue = xQueueCreate(QUEUE_DEPTH, sizeof(Frame));
  if (!impl.queue) { impl.error = F("Could not create the provisioning queue"); return false; }
  BLEService *service = config.server->createService(SERVICE_UUID);
  if (!service) { impl.error = F("Could not create the provisioning service"); return false; }
  impl.statusChar = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ);
  impl.statusChar->setCallbacks(new StatusCallbacks(&impl));
  impl.requestChar = service->createCharacteristic(REQUEST_UUID, BLECharacteristic::PROPERTY_WRITE);
  impl.requestChar->setCallbacks(new RequestCallbacks(&impl));
  impl.replyChar = service->createCharacteristic(REPLY_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
#if defined(CONFIG_BLUEDROID_ENABLED)
  impl.replyChar->addDescriptor(new BLE2902());
#endif
  service->start();
  impl.initialized = true;
  Serial.printf("[prov] Bluetooth Wi-Fi setup service ready (%s); board is %s\n", PROV_MARKER, impl.locked ? "owned (grant or BOOT press needed)" : "not owned yet");
  return true;
}

void AtechBleProv::loop() { if (_impl) _impl->service(); }

void AtechBleProv::noteButtonPress() {
  if (!_impl || !_impl->initialized) return;
  _impl->unlockUntilMs = millis() + _impl->config.unlockWindowMs;
  if (_impl->unlockUntilMs == 0) _impl->unlockUntilMs = 1;
  Serial.printf("[prov] BOOT pressed: Bluetooth setup changes allowed for %lu s\n", static_cast<unsigned long>(_impl->config.unlockWindowMs / 1000));
}

bool AtechBleProv::isLocked() const { return _impl && _impl->locked; }
bool AtechBleProv::unlockWindowOpen() const { return _impl && _impl->unlockOpen(); }
String AtechBleProv::statusJson() { return _impl ? _impl->statusJson() : String("{}"); }

const String &AtechBleProv::lastError() const {
  static const String empty;
  return _impl ? _impl->error : empty;
}
