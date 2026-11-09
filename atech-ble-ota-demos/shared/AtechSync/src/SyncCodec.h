// SyncCodec.h: the plaintext body layout of every AtechSync message (little-endian, explicit
// byte writes, no struct casts). The 17-byte sealed header (magic, version, type, flags, IV) and
// the GCM tag are added by the ESP32 wrapper; the type travels in that header, so `decode` takes
// it as an argument. Every length is checked; a body that leaves trailing bytes is refused.
#pragma once

#include "SyncTypes.h"

namespace atech {
namespace syncproto {

struct Message {
  Type type;
  uint32_t msgId;
  uint32_t ackOf;         // StateAck, EventAck, HelloAck
  uint8_t protocol;       // Hello, HelloAck, PairReq
  uint8_t channel;        // Hello, HelloAck, PairReq, PairAck
  uint32_t uptimeMs;      // Hello, HelloAck
  uint8_t flags;          // Hello, HelloAck: bit0 just booted
  uint8_t stateCount;     // Hello, HelloAck
  uint32_t stateDigest;   // Hello, HelloAck
  SyncEntry entry;        // State
  char name[MAX_NAME + 1];        // Event
  char payload[MAX_PAYLOAD + 1];  // Event
  uint8_t nonce[8];       // PairReq, PairAck
};

// Writes the body for `m.type` into out; returns the length, or 0 when a field breaks a limit or
// the buffer is too small.
size_t encode(const Message &m, uint8_t *out, size_t cap);
// Parses a body of the given type; false on any length violation, unknown type, zero-length key
// or event name, unknown value type, or trailing bytes. `out` is fully overwritten on success.
bool decode(Type type, const uint8_t *body, size_t len, Message &out);

}  // namespace syncproto
}  // namespace atech
