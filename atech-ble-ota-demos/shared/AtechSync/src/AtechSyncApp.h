// AtechSyncApp.h: the application-facing side of AtechSync, reached through AtechApp.h. A board's
// application (the stock demo or generated code) reads and writes a small shared key-value state
// and sends discrete events; paired boards see the same values and events over ESP-NOW. The
// communication layer knows nothing about keys, LEDs or pins: this header only moves values.
//
// Callbacks run on the application task, between appLoop() passes and inside wait(); they never
// run on a radio or core task. set*/emit are safe to call from appSetup() and appLoop().
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace atech {
namespace sync {

// One applied change: `type` is "bool", "int", "float", "string" or "json"; `value` is its text
// form; `writer` is the board id ("ATECH-...") that produced this revision; `remote` is false for
// a change made on this board.
struct StateChange {
  const char *key;
  const char *type;
  const char *value;
  uint32_t revision;
  const char *writer;
  bool remote;
};

// One discrete event; `source` is the board id that emitted it.
struct Event {
  const char *name;
  const char *payload;
  const char *source;
  bool remote;
};

typedef void (*ChangeCallback)(const StateChange &change);
typedef void (*EventCallback)(const Event &event);

// Keys: 1 to 32 characters of letters, digits, '.', '_' or '-'. Values: at most 96 bytes of text.
bool setBool(const char *key, bool value);
bool getBool(const char *key, bool fallback = false);
bool setInt(const char *key, int32_t value);
int32_t getInt(const char *key, int32_t fallback = 0);
bool setFloat(const char *key, float value);
float getFloat(const char *key, float fallback = 0.0f);
bool setString(const char *key, const char *value);
size_t getString(const char *key, char *out, size_t cap);   // bytes copied (0 when absent)
bool setJson(const char *key, const char *json);           // a small structured value, '{' or '[' first
size_t getJson(const char *key, char *out, size_t cap);
bool has(const char *key);

// Events are delivered once to every paired board and to local callbacks; they are not stored.
bool emit(const char *name, const char *payload = "");

// Up to four callbacks of each kind; false when the table is full.
bool onChange(ChangeCallback callback);
bool onEvent(EventCallback callback);

// Like delay(ms), but returns true as soon as a change or event has been delivered to the
// callbacks, so a loop can render immediately instead of sleeping through a blink period.
bool wait(uint32_t ms);

bool peerConnected();      // a paired board answered within the last few seconds
bool paired();             // a peer is configured (connected or not)
const char *peerId();      // the first paired board's id, or "" when none

}  // namespace sync
}  // namespace atech
