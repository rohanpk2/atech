// AtechSync.cpp: see AtechSync.h. Frame layout (shared with builder/lib/fake-sync.js, which
// models the observable behaviour, not the bytes):
//
//   [0xA7 0x53][version 1][type][flags][iv 12] [ciphertext][tag 16]
//
// The 17-byte header is the GCM additional data; the key is the 16-byte pairing key of the
// peer (AES-128). An unknown sender is tried against the open pairing key only for a PAIR_REQ;
// anything else from an unknown MAC is dropped before any parsing. ESP-NOW's own LMK encryption
// is deliberately not used (see BOARD_SYNC.md): the GCM layer gives the same protection without
// the "both sides must switch to encrypted before any frame passes" state that makes the pairing
// handshake fragile.
#include "AtechSync.h"
#include "AtechSyncApp.h"
#include "SyncEngine.h"

#include <AtechCore.h>
#include <AtechWifiLan.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <Preferences.h>
#include <WiFi.h>
#include <esp_mac.h>
#include <esp_now.h>
#include <esp_random.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <mbedtls/gcm.h>

#include <stdlib.h>
#include <string.h>

using namespace atech::syncproto;

namespace {

constexpr char SERVICE_UUID[] = "a7ec0300-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char STATUS_UUID[] = "a7ec0301-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char CHANGE_UUID[] = "a7ec0302-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char CODE_PREFIX[] = "ATSYNC1-";
constexpr size_t RX_QUEUE_DEPTH = 12;
constexpr size_t NOTIFY_QUEUE_DEPTH = 16;
constexpr size_t MAX_CALLBACKS = 4;
constexpr size_t PENDING_CHANGES = 4;
constexpr uint32_t ESPNOW_RETRY_MS = 2000;
constexpr uint32_t POLICY_INTERVAL_MS = 250;
constexpr size_t SERIAL_LINE_MAX = 160;
constexpr size_t PEER_RECORD = 6 + KEY_BYTES + 1 + 1;
constexpr size_t PEERS_BLOB = 1 + MAX_PEERS * PEER_RECORD;
constexpr size_t STATE_BLOB = 1 + MAX_KEYS * (1 + MAX_KEY + 1 + 1 + MAX_VALUE + 4 + 6);
constexpr TickType_t LOCK_WAIT = pdMS_TO_TICKS(1000);
// The GATT status read must stay under the attribute cap (512 bytes under NimBLE, 600 under
// Bluedroid); BLECharacteristic::setValue silently keeps the old value past it.
constexpr size_t BLE_STATUS_BUDGET = 440;
const char HEX_DIGITS[] = "0123456789abcdef";

// Posted by the ESP-NOW callbacks (Wi-Fi task) to the main loop.
struct RxItem {
  uint8_t kind;          // 0 frame, 1 send status
  uint8_t mac[6];
  uint8_t status;
  uint8_t len;
  uint8_t data[MAX_FRAME];
};

// Posted by the engine (main loop or app task, under the lock) to the application task.
struct Notification {
  uint8_t kind;          // 0 state, 1 event
  bool remote;
  ValueType type;
  uint32_t revision;
  char key[MAX_KEY + 1];
  char value[MAX_VALUE + 1];
  uint8_t source[6];
};

String hexEncode(const uint8_t *bytes, size_t length, bool upper = false) {
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    char hi = HEX_DIGITS[bytes[i] >> 4], lo = HEX_DIGITS[bytes[i] & 0x0f];
    if (upper) { hi = toupper(hi); lo = toupper(lo); }
    out += hi; out += lo;
  }
  return out;
}

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool hexDecode(const String &text, uint8_t *out, size_t length) {
  if (text.length() != length * 2) return false;
  for (size_t i = 0; i < length; ++i) {
    const int hi = hexValue(text[2 * i]), lo = hexValue(text[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = uint8_t(hi * 16 + lo);
  }
  return true;
}

void boardId(const uint8_t mac[6], char out[20]) {
  snprintf(out, 20, "ATECH-%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

String boardIdString(const uint8_t mac[6]) {
  char text[20];
  boardId(mac, text);
  return String(text);
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

// key=value&key=value; true when the key is present (the value may be empty).
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

String formEncode(const String &text) {
  String out;
  out.reserve(text.length() + 8);
  for (size_t i = 0; i < text.length(); ++i) {
    const char c = text[i];
    if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') out += c;
    else { out += '%'; out += toupper(HEX_DIGITS[static_cast<uint8_t>(c) >> 4]); out += toupper(HEX_DIGITS[static_cast<uint8_t>(c) & 0x0f]); }
  }
  return out;
}

String jsonEscape(const char *input) {
  String output;
  if (!input) return output;
  for (const char *p = input; *p; ++p) {
    const char c = *p;
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

// Infers the value type the way the serial console and the dashboards write values.
ValueType inferType(const String &value) {
  if (value == "true" || value == "false") return ValueType::Bool;
  if (SyncStore::validValue(ValueType::Int, value.c_str())) return ValueType::Int;
  if (SyncStore::validValue(ValueType::Float, value.c_str())) return ValueType::Float;
  if (value.startsWith("{") || value.startsWith("[")) return ValueType::Json;
  return ValueType::String;
}

}  // namespace

struct AtechSync::Impl : public SyncTransport, public SyncListener {
  AtechSyncConfig config = {};
  String preferencesNamespace;
  String error;
  bool initialized = false;
  bool espNowReady = false;
  uint32_t nextEspNowAttemptMs = 0;
  uint32_t nextPolicyMs = 0;

  SyncEngine engine;
  SemaphoreHandle_t lock = nullptr;
  QueueHandle_t rxQueue = nullptr;
  QueueHandle_t notifyQueue = nullptr;
  uint8_t mac[6] = {};
  uint8_t ivSalt[4] = {};
  uint64_t ivCounter = 0;
  mbedtls_gcm_context gcm;
  bool gcmReady = false;

  // Persistence (main loop only): blobs are staged under the lock and written to NVS after it.
  bool peersDirty = false;
  uint32_t storeDirtySinceMs = 0;
  bool flushPeers = false;
  bool flushState = false;
  size_t peersBlobLen = 0;
  size_t stateBlobLen = 0;
  uint8_t peersBlob[PEERS_BLOB];
  uint8_t stateBlob[STATE_BLOB];
  // Snapshot for callers that must never block on the engine lock.
  volatile bool cachedPaired = false;
  volatile bool cachedConnected = false;

  // Pairing code (main loop; read under the lock).
  String pairingCode;

  // Channel policy.
  uint8_t channel = 0;
  bool channelMismatch = false;
  bool staConnected = false;
  uint32_t lastHopMs = 0;
  uint8_t hopChannel = 0;

  // BLE status service.
  BLECharacteristic *statusChar = nullptr;
  BLECharacteristic *changeChar = nullptr;
  String pendingChanges[PENDING_CHANGES];
  uint8_t pendingCount = 0;

  // Serial console.
  char line[SERIAL_LINE_MAX];
  size_t lineLength = 0;

  // Counters the engine does not see.
  uint32_t authFailures = 0;
  uint32_t unknownSenders = 0;
  uint32_t malformedFrames = 0;
  uint32_t rxOverflows = 0;
  uint32_t notifyOverflows = 0;
  uint32_t sendFailures = 0;

  // Application callbacks (registered and invoked on the app task).
  atech::sync::ChangeCallback changeCallbacks[MAX_CALLBACKS] = {};
  size_t changeCallbackCount = 0;
  atech::sync::EventCallback eventCallbacks[MAX_CALLBACKS] = {};
  size_t eventCallbackCount = 0;
  char peerIdText[20] = "";

  Impl() : engine(*this, *this) { memset(line, 0, sizeof(line)); }
  ~Impl() {
    if (gcmReady) mbedtls_gcm_free(&gcm);
    if (rxQueue) vQueueDelete(rxQueue);
    if (notifyQueue) vQueueDelete(notifyQueue);
    if (lock) vSemaphoreDelete(lock);
  }

  bool take() { return lock && xSemaphoreTakeRecursive(lock, LOCK_WAIT) == pdTRUE; }
  void give() { if (lock) xSemaphoreGiveRecursive(lock); }
  struct Guard {
    Impl &impl; bool held;
    explicit Guard(Impl &i) : impl(i), held(i.take()) {}
    ~Guard() { if (held) impl.give(); }
  };

  // ---- sealing -------------------------------------------------------------------------------

  const uint8_t *keyFor(const uint8_t peerMac[6], Type type, uint32_t nowMs) {
    const SyncPeer *peer = engine.peerFor(peerMac);
    if (peer) return peer->key;
    if (type == Type::PairReq && engine.pairingOpen(nowMs)) return engine.pairingKey();
    return nullptr;
  }

  bool unseal(const uint8_t *key, const uint8_t *frame, size_t bodyLen, uint8_t *body) {
    if (mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, KEY_BYTES * 8) != 0) return false;
    return mbedtls_gcm_auth_decrypt(&gcm, bodyLen, frame + 5, IV_BYTES, frame, HEADER, frame + HEADER + bodyLen, TAG,
                                    frame + HEADER, body) == 0;
  }

  void ensureEspNowPeer(const uint8_t peerMac[6]) {
    if (esp_now_is_peer_exist(peerMac)) return;
    esp_now_peer_info_t info = {};
    memcpy(info.peer_addr, peerMac, 6);
    info.channel = 0;              // the channel the station is on right now
    info.ifidx = WIFI_IF_STA;
    info.encrypt = false;          // sealed above the link layer instead
    esp_now_add_peer(&info);
  }

  // SyncTransport: seal the plaintext body and hand it to ESP-NOW.
  bool send(const uint8_t peerMac[6], Type type, const uint8_t *body, size_t len) override {
    if (!espNowReady || len > MAX_BODY) return false;
    const uint8_t *key = keyFor(peerMac, type, millis());
    if (!key) return false;
    uint8_t frame[MAX_FRAME];
    frame[0] = MAGIC0; frame[1] = MAGIC1; frame[2] = PROTOCOL; frame[3] = static_cast<uint8_t>(type); frame[4] = 0;
    memcpy(frame + 5, ivSalt, 4);
    ++ivCounter;
    for (int i = 0; i < 8; ++i) frame[9 + i] = uint8_t(ivCounter >> (8 * i));
    if (mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, KEY_BYTES * 8) != 0) return false;
    if (mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, len, frame + 5, IV_BYTES, frame, HEADER, body, frame + HEADER, TAG,
                                  frame + HEADER + len) != 0) return false;
    ensureEspNowPeer(peerMac);
    const esp_err_t result = esp_now_send(peerMac, frame, HEADER + len + TAG);
    if (result != ESP_OK) sendFailures++;
    return result == ESP_OK;
  }

  // Main loop: a frame from the radio. The sender's key is chosen before anything is decrypted;
  // only a PAIR_REQ from an unknown MAC is tried against the open pairing key.
  void handleFrame(const uint8_t *src, const uint8_t *data, size_t len, uint32_t nowMs) {
    if (len < HEADER + TAG || data[0] != MAGIC0 || data[1] != MAGIC1 || data[2] != PROTOCOL) { malformedFrames++; return; }
    const Type type = static_cast<Type>(data[3]);
    const SyncPeer *peer = engine.peerFor(src);
    const uint8_t *key = peer ? peer->key : nullptr;
    if (!key && type == Type::PairReq && engine.pairingOpen(nowMs)) key = engine.pairingKey();
    if (!key) { unknownSenders++; return; }
    uint8_t body[MAX_BODY];
    const size_t bodyLen = len - HEADER - TAG;
    if (!unseal(key, data, bodyLen, body)) {
      // A board we already know may be pairing again with a fresh code: its PAIR_REQ is sealed
      // with that code's key, not with the stored one.
      const bool rePairing = type == Type::PairReq && peer && engine.pairingOpen(nowMs) && unseal(engine.pairingKey(), data, bodyLen, body);
      if (!rePairing) { authFailures++; return; }
    }
    engine.receive(src, type, body, bodyLen, nowMs);
  }

  // ---- SyncListener (called by the engine under the lock) ---------------------------------------

  void pushNotification(const Notification &n) {
    if (!notifyQueue || xQueueSend(notifyQueue, &n, 0) != pdTRUE) notifyOverflows++;
  }

  void queueChange(const String &json) {
    if (!changeChar) return;
    if (pendingCount >= PENDING_CHANGES) { pendingChanges[PENDING_CHANGES - 1] = json; return; }
    pendingChanges[pendingCount++] = json;
  }

  void onState(const StateChange &change) override {
    Notification n = {};
    n.kind = 0;
    n.remote = change.remote;
    n.type = change.entry->type;
    n.revision = change.entry->revision;
    strncpy(n.key, change.entry->key, MAX_KEY);
    strncpy(n.value, change.entry->value, MAX_VALUE);
    memcpy(n.source, change.entry->writer, 6);
    pushNotification(n);
    String json;
    json.reserve(160);
    json += F("{\"k\":\""); json += jsonEscape(change.entry->key);
    json += F("\",\"v\":\""); json += jsonEscape(change.entry->value);
    json += F("\",\"t\":\""); json += valueTypeName(change.entry->type);
    json += F("\",\"rev\":"); json += String(change.entry->revision);
    json += F(",\"by\":\""); json += boardIdString(change.entry->writer);
    json += F("\",\"remote\":"); json += change.remote ? F("true") : F("false");
    json += F("}");
    queueChange(json);
  }

  void onEvent(const EventInfo &event) override {
    Notification n = {};
    n.kind = 1;
    n.remote = event.remote;
    strncpy(n.key, event.name, MAX_KEY);
    strncpy(n.value, event.payload, MAX_VALUE);
    memcpy(n.source, event.source, 6);
    pushNotification(n);
    String json;
    json.reserve(120);
    json += F("{\"event\":\""); json += jsonEscape(event.name);
    json += F("\",\"payload\":\""); json += jsonEscape(event.payload);
    json += F("\",\"from\":\""); json += boardIdString(event.source);
    json += F("\",\"remote\":"); json += event.remote ? F("true") : F("false");
    json += F("}");
    queueChange(json);
  }

  void onPeer(const SyncPeer &peer, PeerState previous) override {
    Serial.printf("[sync] peer %s: %s -> %s\n", boardIdString(peer.mac).c_str(), peerStateName(previous), peerStateName(peer.state));
    String json;
    json.reserve(80);
    json += F("{\"peer\":\""); json += boardIdString(peer.mac);
    json += F("\",\"state\":\""); json += peerStateName(peer.state);
    json += F("\"}");
    queueChange(json);
  }

  void onPeersChanged() override { peersDirty = true; }
  void onLog(const char *text) override { Serial.printf("[sync] %s\n", text); }

  // ---- persistence (main loop) -------------------------------------------------------------------

  bool openPreferences(Preferences &preferences, bool readOnly) {
    if (preferences.begin(preferencesNamespace.c_str(), readOnly)) return true;
    preferences.end();
    return preferences.begin(preferencesNamespace.c_str(), false);
  }

  void loadPersisted() {
    Preferences preferences;
    if (!openPreferences(preferences, true)) { error = F("Could not open sync storage"); return; }
    size_t n = preferences.getBytesLength("peers");
    if (n > 0 && n <= PEERS_BLOB && preferences.getBytes("peers", peersBlob, n) == n) {
      const size_t count = peersBlob[0];
      if (1 + count * PEER_RECORD == n && count <= MAX_PEERS) {
        for (size_t i = 0; i < count; ++i) {
          const uint8_t *record = peersBlob + 1 + i * PEER_RECORD;
          engine.addStoredPeer(record, record + 6, record[6 + KEY_BYTES], record[7 + KEY_BYTES] != 0);
        }
      } else {
        Serial.println(F("[sync] stored peer table is corrupt; ignoring it"));
      }
    }
    n = preferences.getBytesLength("state");
    if (n > 0 && n <= STATE_BLOB && preferences.getBytes("state", stateBlob, n) == n) {
      if (!engine.store().deserialize(stateBlob, n)) Serial.println(F("[sync] stored state table is corrupt; starting empty"));
    }
    preferences.end();
  }

  // Under the lock: serialize what changed into the member buffers (main loop owned).
  void stagePersistence(uint32_t nowMs) {
    if (peersDirty) {
      peersDirty = false;
      size_t count = 0;
      for (size_t i = 0; i < MAX_PEERS; ++i) {
        const SyncPeer *peer = engine.peer(i);
        if (!peer) break;
        uint8_t *record = peersBlob + 1 + count * PEER_RECORD;
        memcpy(record, peer->mac, 6);
        memcpy(record + 6, peer->key, KEY_BYTES);
        record[6 + KEY_BYTES] = peer->channel;
        record[7 + KEY_BYTES] = peer->confirmed ? 1 : 0;
        ++count;
      }
      peersBlob[0] = uint8_t(count);
      peersBlobLen = 1 + count * PEER_RECORD;
      flushPeers = true;
    }
    if (engine.storeDirty() && !storeDirtySinceMs) storeDirtySinceMs = nowMs ? nowMs : 1;
    if (engine.storeDirty() && storeDirtySinceMs && nowMs - storeDirtySinceMs >= PERSIST_DEBOUNCE_MS) {
      stateBlobLen = engine.store().serialize(stateBlob, sizeof(stateBlob));
      engine.storePersisted();
      storeDirtySinceMs = 0;
      flushState = true;
    }
  }

  // Outside the lock: the NVS writes (milliseconds, more on a page erase) never stall the app task
  // or the Bluetooth host task waiting for the engine.
  void flushPersistence() {
    if (!flushPeers && !flushState) return;
    Preferences preferences;
    if (!openPreferences(preferences, false)) { flushPeers = flushState = false; return; }
    if (flushPeers) {
      flushPeers = false;
      if (peersBlob[0] == 0) preferences.remove("peers");
      else preferences.putBytes("peers", peersBlob, peersBlobLen);
    }
    if (flushState) {
      flushState = false;
      if (stateBlobLen == 0) preferences.remove("state");
      else preferences.putBytes("state", stateBlob, stateBlobLen);
    }
    preferences.end();
  }

  // ---- ESP-NOW lifecycle and channel policy (main loop) -----------------------------------------

  static void onEspNowReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len);
  static void onEspNowSent(const esp_now_send_info_t *info, esp_now_send_status_t status);

  void ensureEspNow(uint32_t nowMs) {
    const wifi_mode_t mode = WiFi.getMode();
    if (mode == WIFI_OFF) {
      if (espNowReady) { espNowReady = false; Serial.println(F("[sync] Wi-Fi driver stopped; ESP-NOW paused")); }
      if (static_cast<int32_t>(nowMs - nextEspNowAttemptMs) < 0) return;
      nextEspNowAttemptMs = nowMs + ESPNOW_RETRY_MS;
      if (config.lan) config.lan->setRadioHold(true); else WiFi.mode(WIFI_STA);
      return;
    }
    if (espNowReady || static_cast<int32_t>(nowMs - nextEspNowAttemptMs) < 0) return;
    nextEspNowAttemptMs = nowMs + ESPNOW_RETRY_MS;
    const esp_err_t result = esp_now_init();
    if (result != ESP_OK) { Serial.printf("[sync] esp_now_init failed: %s\n", esp_err_to_name(result)); return; }
    esp_now_register_recv_cb(onEspNowReceive);
    esp_now_register_send_cb(onEspNowSent);
    espNowReady = true;
    for (size_t i = 0; i < MAX_PEERS; ++i) { const SyncPeer *peer = engine.peer(i); if (peer) ensureEspNowPeer(peer->mac); }
    Serial.printf("[sync] ESP-NOW ready on %s, channel %u\n", boardIdString(mac).c_str(), channel);
  }

  void setChannel(uint8_t target) {
    if (target < 1 || target > 13 || target == channel) return;
    if (esp_wifi_set_channel(target, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
      esp_wifi_set_promiscuous(true);
      esp_wifi_set_channel(target, WIFI_SECOND_CHAN_NONE);
      esp_wifi_set_promiscuous(false);
    }
    channel = target;
    engine.setChannel(channel);
    engine.forceHello();   // announce ourselves on the new channel at once
  }

  void channelPolicy(uint32_t nowMs) {
    uint8_t primary = 0;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK && primary) { channel = primary; engine.setChannel(channel); }
    staConnected = config.lan ? config.lan->isConnected() : WiFi.isConnected();
    const bool apActive = (WiFi.getMode() & WIFI_MODE_AP) != 0;
    const bool radioFree = !staConnected && !apActive && espNowReady;
    const SyncPeer *peer = engine.peer(0);
    channelMismatch = peer && peer->channel && channel && peer->channel != channel && !radioFree;
    if (!radioFree || !peer) { hopChannel = 0; return; }
    if (peer->state == PeerState::Connected) { hopChannel = 0; return; }
    const uint32_t silentMs = peer->lastRxMs ? nowMs - peer->lastRxMs : HOP_AFTER_MS + 1;
    if (!peer->confirmed || silentMs < HOP_AFTER_MS) {
      if (peer->channel) setChannel(peer->channel);   // the channel the pairing code or the last HELLO named
      return;
    }
    if (nowMs - lastHopMs < HOP_DWELL_MS) return;
    hopChannel = hopChannel ? uint8_t(hopChannel % 13 + 1) : (peer->channel ? peer->channel : 1);
    lastHopMs = nowMs;
    setChannel(hopChannel);
  }

  // ---- commands -----------------------------------------------------------------------------------

  String buildCode(const uint8_t key[KEY_BYTES]) {
    String code = CODE_PREFIX;
    code += hexEncode(mac, 6, true);
    code += '-';
    char ch[3];
    snprintf(ch, sizeof ch, "%02x", channel ? channel : 1);
    code += ch;
    code += '-';
    code += hexEncode(key, KEY_BYTES);
    return code;
  }

  bool parseCode(const String &text, uint8_t outMac[6], uint8_t outKey[KEY_BYTES], uint8_t &outChannel) {
    String code = text;
    code.trim();
    if (!code.startsWith(CODE_PREFIX)) return false;
    const String rest = code.substring(strlen(CODE_PREFIX));
    const int firstDash = rest.indexOf('-');
    const int secondDash = firstDash >= 0 ? rest.indexOf('-', firstDash + 1) : -1;
    if (firstDash != 12 || secondDash != 15) return false;
    uint8_t ch = 0;
    if (!hexDecode(rest.substring(0, 12), outMac, 6) || !hexDecode(rest.substring(13, 15), &ch, 1) ||
        !hexDecode(rest.substring(16), outKey, KEY_BYTES)) {
      return false;
    }
    if (ch > 13) return false;
    outChannel = ch;
    return true;
  }

  bool setValue(const String &key, ValueType type, const String &value, String &why) {
    if (!SyncStore::validKey(key.c_str())) { why = F("Key must be 1 to 32 letters, digits, '.', '_' or '-'"); return false; }
    if (!SyncStore::validValue(type, value.c_str())) { why = String(F("Value is not a valid ")) + valueTypeName(type); return false; }
    Guard guard(*this);
    if (!guard.held) { why = F("Busy"); return false; }
    if (!engine.set(key.c_str(), type, value.c_str(), millis())) { why = F("The state table is full (16 keys)"); return false; }
    if (!storeDirtySinceMs) storeDirtySinceMs = millis() ? millis() : 1;
    return true;
  }

  AtechSyncResult command(const String &form, bool privileged) {
    AtechSyncResult result = {false, String(), String()};
    String op;
    formGet(form, "op", op);
    const bool pairingOp = op == "code" || op == "pair" || op == "unpair";
    if (pairingOp && !privileged) { result.error = F("Pairing changes need an authorized connection"); return result; }
    if (op == "code") {
      uint8_t key[KEY_BYTES];
      esp_fill_random(key, KEY_BYTES);
      Guard guard(*this);
      if (!guard.held) { result.error = F("Busy"); return result; }
      engine.openPairing(key, millis());
      pairingCode = buildCode(key);
      result.ok = true;
      result.code = pairingCode;
      Serial.printf("[sync] pairing code issued; valid for 10 minutes: %s\n", pairingCode.c_str());
      return result;
    }
    if (op == "pair") {
      String code;
      formGet(form, "code", code);
      uint8_t peerMac[6], key[KEY_BYTES], peerChannel = 0;
      if (!parseCode(code, peerMac, key, peerChannel)) { result.error = F("Malformed pairing code (expected ATSYNC1-<MAC>-<channel>-<key>)"); return result; }
      if (memcmp(peerMac, mac, 6) == 0) { result.error = F("That code was issued by this very board; use it on the other board"); return result; }
      Guard guard(*this);
      if (!guard.held) { result.error = F("Busy"); return result; }
      if (!engine.pairWith(peerMac, key, peerChannel, millis())) { result.error = F("Peer table full; unpair first"); return result; }
      engine.closePairing();
      pairingCode = "";
      if (espNowReady) ensureEspNowPeer(peerMac);
      result.ok = true;
      Serial.printf("[sync] pairing with %s (channel %u); waiting for its answer\n", boardIdString(peerMac).c_str(), peerChannel);
      return result;
    }
    if (op == "unpair") {
      Guard guard(*this);
      if (!guard.held) { result.error = F("Busy"); return result; }
      engine.unpairAll(millis());
      pairingCode = "";
      result.ok = true;
      Serial.println(F("[sync] unpaired"));
      return result;
    }
    if (op == "set") {
      String key, value, typeText;
      formGet(form, "key", key);
      formGet(form, "value", value);
      ValueType type = inferType(value);
      if (formGet(form, "type", typeText) && !typeText.isEmpty() && !parseValueType(typeText.c_str(), type)) { result.error = F("Unknown value type"); return result; }
      result.ok = setValue(key, type, value, result.error);
      return result;
    }
    if (op == "toggle") {
      String key;
      formGet(form, "key", key);
      bool current = false;
      {
        Guard guard(*this);
        if (!guard.held) { result.error = F("Busy"); return result; }
        const SyncEntry *entry = engine.get(key.c_str());
        if (entry && entry->type != ValueType::Bool) { result.error = F("That key is not a boolean"); return result; }
        current = entry && strcmp(entry->value, "true") == 0;
      }
      result.ok = setValue(key, ValueType::Bool, current ? "false" : "true", result.error);
      return result;
    }
    if (op == "event") {
      String name, payload;
      formGet(form, "name", name);
      formGet(form, "payload", payload);
      Guard guard(*this);
      if (!guard.held) { result.error = F("Busy"); return result; }
      if (!engine.emit(name.c_str(), payload.c_str(), millis())) { result.error = F("Event name must be 1 to 32 characters, payload at most 96"); return result; }
      result.ok = true;
      return result;
    }
    if (op == "status") { result.ok = true; return result; }
    result.error = F("Unknown op");
    return result;
  }

  // ---- status ------------------------------------------------------------------------------------

  String statusJson() {
    Guard guard(*this);
    if (!guard.held) return String(F("{\"sync\":1,\"busy\":true}"));
    const uint32_t now = millis();
    const SyncPeer *first = engine.peer(0);
    const bool paused = engine.paused();
    String json;
    json.reserve(760);
    json += F("{\"sync\":1,\"id\":\""); json += atech::deviceId();
    json += F("\",\"mac\":\""); json += hexEncode(mac, 6, true);
    json += F("\",\"channel\":"); json += String(channel);
    json += F(",\"wifi\":"); json += staConnected ? F("true") : F("false");
    json += F(",\"radio\":"); json += espNowReady ? F("true") : F("false");
    json += F(",\"paused\":"); json += paused ? F("true") : F("false");
    json += F(",\"pairingOpen\":"); json += engine.pairingOpen(now) ? F("true") : F("false");
    json += F(",\"pairingCode\":\""); json += engine.pairingOpen(now) ? pairingCode : String();
    json += F("\",\"paired\":"); json += first ? F("true") : F("false");
    json += F(",\"connected\":"); json += first && first->state == PeerState::Connected ? F("true") : F("false");
    json += F(",\"peer\":\""); json += first ? boardIdString(first->mac) : String();
    json += F("\",\"peerState\":\""); json += first ? peerStateName(first->state) : "none";
    json += F("\",\"peerChannel\":"); json += String(first ? first->channel : 0);
    json += F(",\"channelMismatch\":"); json += channelMismatch ? F("true") : F("false");
    json += F(",\"lastAckAgoMs\":"); json += first && first->lastAckMs ? String(now - first->lastAckMs) : String(-1);
    json += F(",\"lastSeenAgoMs\":"); json += first && first->lastRxMs ? String(now - first->lastRxMs) : String(-1);
    json += F(",\"peers\":[");
    for (size_t i = 0; i < MAX_PEERS; ++i) {
      const SyncPeer *peer = engine.peer(i);
      if (!peer) break;
      if (i) json += ',';
      json += F("{\"id\":\""); json += boardIdString(peer->mac);
      json += F("\",\"state\":\""); json += peerStateName(peer->state);
      json += F("\",\"confirmed\":"); json += peer->confirmed ? F("true") : F("false");
      json += F(",\"channel\":"); json += String(peer->channel);
      json += '}';
    }
    json += F("],\"state\":{");
    const SyncStore &store = engine.store();
    for (size_t i = 0; i < store.count(); ++i) {
      const SyncEntry *entry = store.at(i);
      if (i) json += ',';
      json += '"'; json += jsonEscape(entry->key);
      json += F("\":{\"v\":\""); json += jsonEscape(entry->value);
      json += F("\",\"t\":\""); json += valueTypeName(entry->type);
      json += F("\",\"rev\":"); json += String(entry->revision);
      json += F(",\"by\":\""); json += boardIdString(entry->writer);
      json += F("\"}");
    }
    const SyncStats &stats = engine.stats();
    json += F("},\"queued\":"); json += String(engine.queued());
    json += F(",\"stats\":{\"sent\":"); json += String(stats.sent);
    json += F(",\"acked\":"); json += String(stats.acked);
    json += F(",\"retries\":"); json += String(stats.retries);
    json += F(",\"dropped\":"); json += String(stats.dropped);
    json += F(",\"received\":"); json += String(stats.received);
    json += F(",\"duplicates\":"); json += String(stats.duplicates);
    json += F(",\"stale\":"); json += String(stats.stale);
    json += F(",\"rejected\":"); json += String(stats.rejected);
    json += F(",\"forwarded\":"); json += String(stats.forwarded);
    json += F(",\"authFailures\":"); json += String(authFailures);
    json += F(",\"unknownSenders\":"); json += String(unknownSenders);
    json += F(",\"malformed\":"); json += String(malformedFrames);
    json += F(",\"rxOverflows\":"); json += String(rxOverflows);
    json += F(",\"notifyOverflows\":"); json += String(notifyOverflows);
    json += F(",\"sendFailures\":"); json += String(sendFailures);
    json += F("}}");
    return json;
  }

  // The Bluetooth read: the same facts as the compact form plus what the dashboard needs live,
  // kept under BLE_STATUS_BUDGET; state entries are added until the budget is spent.
  String bleStatusJson() {
    Guard guard(*this);
    if (!guard.held) return String(F("{\"sync\":1,\"busy\":true}"));
    const uint32_t now = millis();
    const SyncPeer *first = engine.peer(0);
    String json;
    json.reserve(BLE_STATUS_BUDGET + 16);
    json += F("{\"sync\":1,\"id\":\""); json += atech::deviceId();
    json += F("\",\"paired\":"); json += first ? F("true") : F("false");
    json += F(",\"connected\":"); json += first && first->state == PeerState::Connected ? F("true") : F("false");
    json += F(",\"peer\":\""); json += first ? boardIdString(first->mac) : String();
    json += F("\",\"peerState\":\""); json += first ? peerStateName(first->state) : "none";
    json += F("\",\"pairingOpen\":"); json += engine.pairingOpen(now) ? F("true") : F("false");
    json += F(",\"code\":\""); json += engine.pairingOpen(now) ? pairingCode : String();
    json += F("\",\"paused\":"); json += engine.paused() ? F("true") : F("false");
    json += F(",\"channelMismatch\":"); json += channelMismatch ? F("true") : F("false");
    json += F(",\"channel\":"); json += String(channel);
    json += F(",\"lastAckAgoMs\":"); json += first && first->lastAckMs ? String(now - first->lastAckMs) : String(-1);
    json += F(",\"state\":{");
    const SyncStore &store = engine.store();
    bool truncated = false;
    size_t written = 0;
    const size_t tail = sizeof("},\"truncated\":false}") - 1;
    for (size_t i = 0; i < store.count(); ++i) {
      const SyncEntry *entry = store.at(i);
      String piece;
      piece.reserve(strlen(entry->key) + strlen(entry->value) + 8);
      if (written) piece += ',';
      piece += '"'; piece += jsonEscape(entry->key); piece += F("\":\""); piece += jsonEscape(entry->value); piece += '"';
      if (json.length() + piece.length() + tail > BLE_STATUS_BUDGET) { truncated = true; break; }
      json += piece;
      ++written;
    }
    json += F("},\"truncated\":"); json += truncated ? F("true") : F("false");
    json += '}';
    return json;
  }

  String compactStatusJson() {
    Guard guard(*this);
    if (!guard.held) return String(F("{\"sync\":1,\"busy\":true}"));
    const uint32_t now = millis();
    const SyncPeer *first = engine.peer(0);
    String json;
    json.reserve(320);
    json += F("{\"paired\":"); json += first ? F("true") : F("false");
    json += F(",\"connected\":"); json += first && first->state == PeerState::Connected ? F("true") : F("false");
    json += F(",\"peer\":\""); json += first ? boardIdString(first->mac) : String();
    json += F("\",\"peerState\":\""); json += first ? peerStateName(first->state) : "none";
    json += F("\",\"code\":\""); json += engine.pairingOpen(now) ? pairingCode : String();
    json += F("\",\"state\":{");
    const SyncStore &store = engine.store();
    for (size_t i = 0; i < store.count(); ++i) {
      const SyncEntry *entry = store.at(i);
      if (i) json += ',';
      json += '"'; json += jsonEscape(entry->key); json += F("\":\""); json += jsonEscape(entry->value); json += '"';
    }
    json += F("}}");
    return json;
  }

  // ---- serial console ------------------------------------------------------------------------------

  void printResult(const AtechSyncResult &result) {
    if (result.ok) Serial.println(F("[sync] ok"));
    else Serial.printf("[sync] error: %s\n", result.error.c_str());
  }

  bool handleSerialLine(const String &raw) {
    String text = raw;
    text.trim();
    if (!(text == "sync" || text.startsWith("sync "))) return false;
    String rest = text.length() > 4 ? text.substring(5) : String();
    rest.trim();
    int space = rest.indexOf(' ');
    const String verb = space < 0 ? rest : rest.substring(0, space);
    String args = space < 0 ? String() : rest.substring(space + 1);
    args.trim();
    if (verb.isEmpty() || verb == "help") {
      Serial.println(F("[sync] commands: sync status | sync code | sync pair <code> | sync unpair | sync set <key> <value> | "
                       "sync toggle <key> | sync get <key> | sync event <name> [payload]"));
      return true;
    }
    if (verb == "status") { Serial.println(statusJson()); return true; }
    if (verb == "code") {
      const AtechSyncResult result = command("op=code", true);
      if (result.ok) Serial.printf("[sync] on the other board type: sync pair %s\n", result.code.c_str());
      else printResult(result);
      return true;
    }
    if (verb == "pair") { printResult(command("op=pair&code=" + formEncode(args), true)); return true; }
    if (verb == "unpair") { printResult(command("op=unpair", true)); return true; }
    if (verb == "set") {
      space = args.indexOf(' ');
      if (space < 0) { Serial.println(F("[sync] usage: sync set <key> <value>")); return true; }
      String value = args.substring(space + 1);
      value.trim();
      printResult(command("op=set&key=" + formEncode(args.substring(0, space)) + "&value=" + formEncode(value), true));
      return true;
    }
    if (verb == "toggle") { printResult(command("op=toggle&key=" + formEncode(args), true)); return true; }
    if (verb == "get") {
      Guard guard(*this);
      if (!guard.held) { Serial.println(F("[sync] busy; try again")); return true; }
      const SyncEntry *entry = engine.get(args.c_str());
      if (!entry) Serial.printf("[sync] %s is not set\n", args.c_str());
      else Serial.printf("[sync] %s = %s (%s, revision %lu by %s)\n", entry->key, entry->value, valueTypeName(entry->type),
                         static_cast<unsigned long>(entry->revision), boardIdString(entry->writer).c_str());
      return true;
    }
    if (verb == "event") {
      space = args.indexOf(' ');
      const String name = space < 0 ? args : args.substring(0, space);
      String payload = space < 0 ? String() : args.substring(space + 1);
      payload.trim();
      printResult(command("op=event&name=" + formEncode(name) + "&payload=" + formEncode(payload), true));
      return true;
    }
    Serial.printf("[sync] unknown command \"%s\"; try: sync help\n", verb.c_str());
    return true;
  }

  void readSerial() {
    while (Serial.available() > 0) {
      const int c = Serial.read();
      if (c < 0) break;
      if (c == '\r') continue;
      if (c == '\n') {
        line[lineLength] = 0;
        if (lineLength) handleSerialLine(String(line));
        lineLength = 0;
        continue;
      }
      if (lineLength + 1 >= SERIAL_LINE_MAX) { lineLength = 0; continue; }   // overlong line: discard
      line[lineLength++] = static_cast<char>(c);
    }
  }

  // ---- main loop -----------------------------------------------------------------------------------

  void service() {
    if (!initialized) return;
    const uint32_t now = millis();
    ensureEspNow(now);
    RxItem item;
    {
      Guard guard(*this);
      if (guard.held) {
        engine.setPaused(config.otaBusy && config.otaBusy());
        while (rxQueue && xQueueReceive(rxQueue, &item, 0) == pdTRUE) {
          if (item.kind == 0) handleFrame(item.mac, item.data, item.len, now);
          else engine.sendResult(item.mac, item.status == 0, now);
        }
        engine.tick(now);
        if (static_cast<int32_t>(now - nextPolicyMs) >= 0) { nextPolicyMs = now + POLICY_INTERVAL_MS; channelPolicy(now); }
        stagePersistence(now);
        const SyncPeer *first = engine.peer(0);
        if (first) boardId(first->mac, peerIdText); else peerIdText[0] = 0;
        cachedPaired = first != nullptr;
        cachedConnected = engine.anyConnected();
      }
    }
    if (pendingCount && changeChar) {
      String json;
      {
        Guard guard(*this);
        json = pendingChanges[0];
        for (uint8_t i = 1; i < pendingCount; ++i) pendingChanges[i - 1] = pendingChanges[i];
        pendingChanges[--pendingCount] = String();
      }
      changeChar->setValue(reinterpret_cast<uint8_t *>(const_cast<char *>(json.c_str())), json.length());
      changeChar->notify();
    }
    flushPersistence();
    if (config.serialConsole) readSerial();
  }

  // ---- application task ----------------------------------------------------------------------------

  void dispatch(const Notification &n) {
    char source[20];
    boardId(n.source, source);
    if (n.kind == 0) {
      atech::sync::StateChange change = {n.key, valueTypeName(n.type), n.value, n.revision, source, n.remote};
      for (size_t i = 0; i < changeCallbackCount; ++i) changeCallbacks[i](change);
    } else {
      atech::sync::Event event = {n.key, n.value, source, n.remote};
      for (size_t i = 0; i < eventCallbackCount; ++i) eventCallbacks[i](event);
    }
  }

  // Delivers queued notifications to the app callbacks; waits up to `ticks` for the first one.
  bool drainNotifications(TickType_t ticks) {
    if (!notifyQueue) return false;
    Notification n;
    bool any = false;
    while (xQueueReceive(notifyQueue, &n, any ? 0 : ticks) == pdTRUE) { dispatch(n); any = true; }
    return any;
  }
};

namespace {

AtechSync::Impl *g_impl = nullptr;

class StatusCallbacks : public BLECharacteristicCallbacks {
public:
  explicit StatusCallbacks(AtechSync::Impl *owner) : impl(owner) {}
  void onRead(BLECharacteristic *characteristic) override { characteristic->setValue(impl->bleStatusJson()); }

private:
  AtechSync::Impl *impl;
};

void appIdleHook() {
  if (g_impl) g_impl->drainNotifications(0);
}

}  // namespace

// Runs on the Wi-Fi task: copy the frame into the queue and return. The main loop authenticates
// and parses it.
void AtechSync::Impl::onEspNowReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  AtechSync::Impl *impl = g_impl;
  if (!impl || !impl->rxQueue || !info || !info->src_addr || !data || len <= 0 || len > int(MAX_FRAME)) return;
  RxItem item;
  item.kind = 0;
  memcpy(item.mac, info->src_addr, 6);
  item.status = 0;
  item.len = uint8_t(len);
  memcpy(item.data, data, len);
  if (xQueueSend(impl->rxQueue, &item, 0) != pdTRUE) impl->rxOverflows++;
}

void AtechSync::Impl::onEspNowSent(const esp_now_send_info_t *info, esp_now_send_status_t status) {
  AtechSync::Impl *impl = g_impl;
  if (!impl || !impl->rxQueue || !info || !info->des_addr || status == ESP_NOW_SEND_SUCCESS) return;
  RxItem item;
  item.kind = 1;
  memcpy(item.mac, info->des_addr, 6);
  item.status = 1;
  item.len = 0;
  xQueueSend(impl->rxQueue, &item, 0);
}

AtechSync::AtechSync() : _impl(new Impl()) {}
AtechSync::~AtechSync() { if (g_impl == _impl) g_impl = nullptr; delete _impl; }

bool AtechSync::begin(const AtechSyncConfig &config) {
  if (!_impl || _impl->initialized) return _impl && _impl->initialized;
  Impl &impl = *_impl;
  impl.config = config;
  impl.preferencesNamespace = config.preferencesNamespace ? config.preferencesNamespace : "atech_sync";
  impl.lock = xSemaphoreCreateRecursiveMutex();
  impl.rxQueue = xQueueCreate(RX_QUEUE_DEPTH, sizeof(RxItem));
  impl.notifyQueue = xQueueCreate(NOTIFY_QUEUE_DEPTH, sizeof(Notification));
  if (!impl.lock || !impl.rxQueue || !impl.notifyQueue) { impl.error = F("Could not allocate the sync queues"); return false; }
  mbedtls_gcm_init(&impl.gcm);
  impl.gcmReady = true;
  esp_fill_random(impl.ivSalt, sizeof(impl.ivSalt));
  uint32_t seed = 0;
  esp_fill_random(&seed, sizeof(seed));
  esp_read_mac(impl.mac, ESP_MAC_WIFI_STA);
  impl.engine.begin(impl.mac, millis(), seed);
  impl.loadPersisted();
  if (config.lan) config.lan->setRadioHold(true); else WiFi.mode(WIFI_STA);
  if (config.server) {
    BLEService *service = config.server->createService(SERVICE_UUID);
    if (service) {
      impl.statusChar = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ);
      impl.statusChar->setCallbacks(new StatusCallbacks(&impl));
      impl.changeChar = service->createCharacteristic(CHANGE_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
#if defined(CONFIG_BLUEDROID_ENABLED)
      impl.changeChar->addDescriptor(new BLE2902());
#endif
      service->start();
    }
  }
  g_impl = &impl;
  atech::coreSetAppIdleHook(appIdleHook);
  impl.initialized = true;
  const SyncPeer *first = impl.engine.peer(0);
  if (first) {
    boardId(first->mac, impl.peerIdText);
    Serial.printf("[sync] paired with %s (%s, channel %u), %u state key(s) restored\n", impl.peerIdText,
                  first->confirmed ? "confirmed" : "pairing not finished", first->channel, unsigned(impl.engine.store().count()));
  } else {
    Serial.printf("[sync] not paired; %u state key(s) restored. Serial: \"sync code\" here, then \"sync pair <code>\" on the other board\n",
                  unsigned(impl.engine.store().count()));
  }
  return true;
}

void AtechSync::loop() { if (_impl) _impl->service(); }

AtechSyncResult AtechSync::command(const String &form, bool privileged) {
  if (!_impl || !_impl->initialized) return {false, String(F("Sync is not running")), String()};
  return _impl->command(form, privileged);
}

String AtechSync::statusJson() { return _impl && _impl->initialized ? _impl->statusJson() : String("{}"); }
String AtechSync::compactStatusJson() { return _impl && _impl->initialized ? _impl->compactStatusJson() : String("{}"); }
bool AtechSync::handleSerialLine(const String &line) { return _impl && _impl->initialized && _impl->handleSerialLine(line); }

bool AtechSync::isPaired() const { return _impl && _impl->initialized && _impl->cachedPaired; }
bool AtechSync::isConnected() const { return _impl && _impl->initialized && _impl->cachedConnected; }

bool AtechSync::emitEvent(const char *name, const char *payload) {
  if (!_impl || !_impl->initialized) return false;
  Impl::Guard guard(*_impl);
  if (!guard.held) return false;
  return _impl->engine.emit(name, payload ? payload : "", millis());
}

const String &AtechSync::lastError() const {
  static const String empty;
  return _impl ? _impl->error : empty;
}

// ---- application API (AtechSyncApp.h) -------------------------------------------------------------

namespace atech {
namespace sync {

namespace {
bool setText(const char *key, ValueType type, const char *value) {
  if (!g_impl || !key || !value) return false;
  String why;
  return g_impl->setValue(String(key), type, String(value), why);
}

size_t copyValue(const char *key, char *out, size_t cap, ValueType *typeOut = nullptr) {
  if (!g_impl || !key || !out || cap == 0) return 0;
  AtechSync::Impl::Guard guard(*g_impl);
  if (!guard.held) return 0;
  const SyncEntry *entry = g_impl->engine.get(key);
  if (!entry) { out[0] = 0; return 0; }
  const size_t n = strlen(entry->value);
  const size_t copied = n < cap - 1 ? n : cap - 1;
  memcpy(out, entry->value, copied);
  out[copied] = 0;
  if (typeOut) *typeOut = entry->type;
  return copied;
}
}  // namespace

bool setBool(const char *key, bool value) { return setText(key, ValueType::Bool, value ? "true" : "false"); }
bool getBool(const char *key, bool fallback) {
  char text[8];
  return copyValue(key, text, sizeof text) ? strcmp(text, "true") == 0 : fallback;
}
bool setInt(const char *key, int32_t value) {
  char text[16];
  snprintf(text, sizeof text, "%ld", static_cast<long>(value));
  return setText(key, ValueType::Int, text);
}
int32_t getInt(const char *key, int32_t fallback) {
  char text[16];
  return copyValue(key, text, sizeof text) ? static_cast<int32_t>(strtol(text, nullptr, 10)) : fallback;
}
bool setFloat(const char *key, float value) {
  char text[24];
  snprintf(text, sizeof text, "%g", static_cast<double>(value));
  return setText(key, ValueType::Float, text);
}
float getFloat(const char *key, float fallback) {
  char text[32];
  return copyValue(key, text, sizeof text) ? static_cast<float>(strtod(text, nullptr)) : fallback;
}
bool setString(const char *key, const char *value) { return setText(key, ValueType::String, value); }
size_t getString(const char *key, char *out, size_t cap) { return copyValue(key, out, cap); }
bool setJson(const char *key, const char *json) { return setText(key, ValueType::Json, json); }
size_t getJson(const char *key, char *out, size_t cap) { return copyValue(key, out, cap); }
bool has(const char *key) {
  if (!g_impl || !key) return false;
  AtechSync::Impl::Guard guard(*g_impl);
  return guard.held && g_impl->engine.get(key) != nullptr;
}

bool emit(const char *name, const char *payload) {
  if (!g_impl) return false;
  AtechSync::Impl::Guard guard(*g_impl);
  if (!guard.held) return false;
  return g_impl->engine.emit(name, payload ? payload : "", millis());
}

bool onChange(ChangeCallback callback) {
  if (!g_impl || !callback || g_impl->changeCallbackCount >= MAX_CALLBACKS) return false;
  g_impl->changeCallbacks[g_impl->changeCallbackCount++] = callback;
  return true;
}

bool onEvent(EventCallback callback) {
  if (!g_impl || !callback || g_impl->eventCallbackCount >= MAX_CALLBACKS) return false;
  g_impl->eventCallbacks[g_impl->eventCallbackCount++] = callback;
  return true;
}

bool wait(uint32_t ms) {
  if (!g_impl) { delay(ms); return false; }
  return g_impl->drainNotifications(pdMS_TO_TICKS(ms));
}

bool peerConnected() { return g_impl && g_impl->cachedConnected; }
bool paired() { return g_impl && g_impl->cachedPaired; }

const char *peerId() { return g_impl ? g_impl->peerIdText : ""; }

}  // namespace sync
}  // namespace atech
