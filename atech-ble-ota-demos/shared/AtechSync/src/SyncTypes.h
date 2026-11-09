// SyncTypes.h: constants, enums and the state entry shared by the portable AtechSync engine
// (SyncCodec, SyncStore, SyncEngine) and the ESP32 wrapper (AtechSync). No Arduino here: the
// engine compiles on the host for its tests. Limits are also mirrored by builder/lib/fake-sync.js.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace atech {
namespace syncproto {

constexpr uint8_t PROTOCOL = 1;
constexpr uint8_t MAGIC0 = 0xA7;
constexpr uint8_t MAGIC1 = 0x53;
constexpr size_t MAX_FRAME = 250;          // ESP-NOW v1 payload
constexpr size_t IV_BYTES = 12;
constexpr size_t HEADER = 5 + IV_BYTES;    // magic(2) version(1) type(1) flags(1) iv(12)
constexpr size_t TAG = 16;
constexpr size_t MAX_BODY = MAX_FRAME - HEADER - TAG;   // 217
constexpr size_t KEY_BYTES = 16;           // pairing key, AES-128

constexpr size_t MAX_KEY = 32;
constexpr size_t MAX_VALUE = 96;
constexpr size_t MAX_NAME = 32;
constexpr size_t MAX_PAYLOAD = 96;
constexpr size_t MAX_KEYS = 16;
constexpr size_t MAX_PEERS = 4;
constexpr size_t QUEUE_DEPTH = 20;   // holds a full-table reconciliation (16 keys) plus events
constexpr size_t DEDUPE = 16;

constexpr uint8_t MAX_ATTEMPTS = 5;
constexpr uint32_t RETRY_BASE_MS = 150;
constexpr uint32_t HELLO_INTERVAL_MS = 3000;
constexpr uint32_t CONNECT_TIMEOUT_MS = 8000;
constexpr uint32_t PAIR_WINDOW_MS = 600000;
constexpr uint32_t PAIR_REQ_INTERVAL_MS = 1000;
constexpr uint8_t PAIR_REQ_FAST_ATTEMPTS = 20;
constexpr uint32_t PAIR_REQ_SLOW_INTERVAL_MS = 10000;
constexpr uint32_t HOP_AFTER_MS = 15000;
constexpr uint32_t HOP_DWELL_MS = 2000;
constexpr uint32_t PERSIST_DEBOUNCE_MS = 2000;

enum class Type : uint8_t {
  Hello = 1, HelloAck = 2, State = 3, StateAck = 4, Event = 5, EventAck = 6,
  SyncReq = 7, PairReq = 8, PairAck = 9, Unpair = 10,
};

enum class ValueType : uint8_t { Bool = 1, Int = 2, Float = 3, String = 4, Json = 5 };

// One synchronized key. `writer` is the station MAC of the board that produced this revision.
struct SyncEntry {
  char key[MAX_KEY + 1];
  ValueType type;
  char value[MAX_VALUE + 1];
  uint32_t revision;
  uint8_t writer[6];
};

// Total order on versions: higher revision first, then the numerically larger writer MAC.
// Returns negative when a is older than b, zero when identical, positive when a is newer.
int compareVersion(uint32_t revA, const uint8_t *writerA, uint32_t revB, const uint8_t *writerB);

const char *valueTypeName(ValueType type);
bool parseValueType(const char *text, ValueType &out);
bool validValueType(uint8_t raw);

}  // namespace syncproto
}  // namespace atech
