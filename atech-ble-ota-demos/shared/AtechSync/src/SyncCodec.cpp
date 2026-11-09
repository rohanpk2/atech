// SyncCodec.cpp: see SyncCodec.h.
#include "SyncCodec.h"

#include <string.h>

namespace atech {
namespace syncproto {

namespace {

struct Writer {
  uint8_t *out;
  size_t cap;
  size_t at = 0;
  bool ok = true;
  void u8(uint8_t v) { if (at + 1 > cap) { ok = false; return; } out[at++] = v; }
  void u32(uint32_t v) { u8(uint8_t(v)); u8(uint8_t(v >> 8)); u8(uint8_t(v >> 16)); u8(uint8_t(v >> 24)); }
  void bytes(const uint8_t *p, size_t n) { if (at + n > cap) { ok = false; return; } memcpy(out + at, p, n); at += n; }
  // Length-prefixed text; refuses a text longer than max or, when required, an empty one.
  void text(const char *s, size_t max, bool required) {
    const size_t n = strnlen(s, max + 1);
    if (n > max || (required && n == 0)) { ok = false; return; }
    u8(uint8_t(n));
    bytes(reinterpret_cast<const uint8_t *>(s), n);
  }
};

struct Reader {
  const uint8_t *in;
  size_t len;
  size_t at = 0;
  bool ok = true;
  bool need(size_t n) { if (at + n > len) { ok = false; return false; } return true; }
  uint8_t u8() { if (!need(1)) return 0; return in[at++]; }
  uint32_t u32() {
    if (!need(4)) return 0;
    const uint32_t v = uint32_t(in[at]) | (uint32_t(in[at + 1]) << 8) | (uint32_t(in[at + 2]) << 16) | (uint32_t(in[at + 3]) << 24);
    at += 4;
    return v;
  }
  void bytes(uint8_t *p, size_t n) { if (!need(n)) return; memcpy(p, in + at, n); at += n; }
  void text(char *dst, size_t max, bool required) {
    const size_t n = u8();
    if (!ok) return;
    if (n > max || (required && n == 0) || !need(n)) { ok = false; return; }
    memcpy(dst, in + at, n);
    dst[n] = 0;
    at += n;
  }
  bool done() const { return ok && at == len; }
};

void writeHelloFields(Writer &w, const Message &m) {
  w.u8(m.protocol);
  w.u8(m.channel);
  w.u32(m.uptimeMs);
  w.u8(m.flags);
  w.u8(m.stateCount);
  w.u32(m.stateDigest);
}

void readHelloFields(Reader &r, Message &m) {
  m.protocol = r.u8();
  m.channel = r.u8();
  m.uptimeMs = r.u32();
  m.flags = r.u8();
  m.stateCount = r.u8();
  m.stateDigest = r.u32();
}

}  // namespace

size_t encode(const Message &m, uint8_t *out, size_t cap) {
  if (!out) return 0;
  Writer w{out, cap};
  w.u32(m.msgId);
  switch (m.type) {
    case Type::Hello:
      writeHelloFields(w, m);
      break;
    case Type::HelloAck:
      w.u32(m.ackOf);
      writeHelloFields(w, m);
      break;
    case Type::State:
      if (!validValueType(static_cast<uint8_t>(m.entry.type))) return 0;
      w.u32(m.entry.revision);
      w.bytes(m.entry.writer, 6);
      w.text(m.entry.key, MAX_KEY, true);
      w.u8(static_cast<uint8_t>(m.entry.type));
      w.text(m.entry.value, MAX_VALUE, false);
      break;
    case Type::StateAck:
    case Type::EventAck:
      w.u32(m.ackOf);
      break;
    case Type::Event:
      w.text(m.name, MAX_NAME, true);
      w.text(m.payload, MAX_PAYLOAD, false);
      break;
    case Type::SyncReq:
    case Type::Unpair:
      break;
    case Type::PairReq:
      w.bytes(m.nonce, 8);
      w.u8(m.protocol);
      w.u8(m.channel);
      break;
    case Type::PairAck:
      w.bytes(m.nonce, 8);
      w.u8(m.channel);
      break;
    default:
      return 0;
  }
  return w.ok ? w.at : 0;
}

bool decode(Type type, const uint8_t *body, size_t len, Message &out) {
  if (!body && len) return false;
  Reader r{body ? body : reinterpret_cast<const uint8_t *>(""), len};
  memset(&out, 0, sizeof(out));
  out.type = type;
  out.msgId = r.u32();
  switch (type) {
    case Type::Hello:
      readHelloFields(r, out);
      break;
    case Type::HelloAck:
      out.ackOf = r.u32();
      readHelloFields(r, out);
      break;
    case Type::State: {
      out.entry.revision = r.u32();
      r.bytes(out.entry.writer, 6);
      r.text(out.entry.key, MAX_KEY, true);
      const uint8_t rawType = r.u8();
      if (!r.ok || !validValueType(rawType)) return false;
      out.entry.type = static_cast<ValueType>(rawType);
      r.text(out.entry.value, MAX_VALUE, false);
      break;
    }
    case Type::StateAck:
    case Type::EventAck:
      out.ackOf = r.u32();
      break;
    case Type::Event:
      r.text(out.name, MAX_NAME, true);
      r.text(out.payload, MAX_PAYLOAD, false);
      break;
    case Type::SyncReq:
    case Type::Unpair:
      break;
    case Type::PairReq:
      r.bytes(out.nonce, 8);
      out.protocol = r.u8();
      out.channel = r.u8();
      break;
    case Type::PairAck:
      r.bytes(out.nonce, 8);
      out.channel = r.u8();
      break;
    default:
      return false;
  }
  return r.done();
}

}  // namespace syncproto
}  // namespace atech
