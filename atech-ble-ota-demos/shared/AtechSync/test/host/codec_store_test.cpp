// Host tests for the AtechSync wire codec and the versioned state store.
#include "check.h"
#include "SyncCodec.h"
#include "SyncStore.h"

#include <cstring>

using namespace atech::syncproto;

static const uint8_t MAC_A[6] = {0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6};
static const uint8_t MAC_B[6] = {0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF7};   // larger than A
static const uint8_t MAC_C[6] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55};   // smaller than A

static Message stateMessage(const char *key, ValueType type, const char *value, uint32_t revision, const uint8_t *writer, uint32_t msgId) {
  Message m{};
  m.type = Type::State;
  m.msgId = msgId;
  std::strncpy(m.entry.key, key, sizeof(m.entry.key) - 1);
  m.entry.type = type;
  std::strncpy(m.entry.value, value, sizeof(m.entry.value) - 1);
  m.entry.revision = revision;
  std::memcpy(m.entry.writer, writer, 6);
  return m;
}

static SyncEntry entry(const char *key, ValueType type, const char *value, uint32_t revision, const uint8_t *writer) {
  SyncEntry e{};
  std::strncpy(e.key, key, sizeof(e.key) - 1);
  e.type = type;
  std::strncpy(e.value, value, sizeof(e.value) - 1);
  e.revision = revision;
  std::memcpy(e.writer, writer, 6);
  return e;
}

static void encode_decode_state_round_trip() {
  Message m = stateMessage("demo.power", ValueType::Bool, "true", 12, MAC_A, 102);
  uint8_t buf[MAX_BODY];
  const size_t n = encode(m, buf, sizeof buf);
  CHECK_EQ(n, 31u);
  Message d{};
  CHECK(decode(Type::State, buf, n, d));
  CHECK_EQ(d.msgId, 102u);
  CHECK_STR(d.entry.key, "demo.power");
  CHECK(d.entry.type == ValueType::Bool);
  CHECK_STR(d.entry.value, "true");
  CHECK_EQ(d.entry.revision, 12u);
  CHECK(std::memcmp(d.entry.writer, MAC_A, 6) == 0);
}

static void encode_rejects_oversized() {
  uint8_t buf[MAX_BODY];
  char longKey[34];
  std::memset(longKey, 'k', 33);
  longKey[33] = 0;
  Message m = stateMessage("x", ValueType::String, "v", 1, MAC_A, 1);
  std::memcpy(m.entry.key, longKey, 34);   // 33 characters: one over the limit
  CHECK_EQ(encode(m, buf, sizeof buf), 0u);

  Message v = stateMessage("x", ValueType::String, "", 1, MAC_A, 1);
  std::memset(v.entry.value, 'v', 97);     // 97 bytes, terminator lost: one over the limit
  CHECK_EQ(encode(v, buf, sizeof buf), 0u);

  Message e{};
  e.type = Type::Event;
  e.msgId = 5;
  std::strcpy(e.name, "button.pressed");
  std::memset(e.payload, 'p', 97);
  CHECK_EQ(encode(e, buf, sizeof buf), 0u);

  // A buffer too small for the encoded body also fails.
  Message ok = stateMessage("demo.power", ValueType::Bool, "true", 1, MAC_A, 1);
  CHECK_EQ(encode(ok, buf, 10), 0u);
}

static void decode_rejects_malformed() {
  Message m = stateMessage("demo.power", ValueType::Bool, "true", 12, MAC_A, 102);
  uint8_t buf[MAX_BODY];
  const size_t n = encode(m, buf, sizeof buf);
  Message d{};
  CHECK(!decode(Type::State, buf, n - 1, d));          // truncated by one byte
  uint8_t trailing[MAX_BODY];
  std::memcpy(trailing, buf, n);
  trailing[n] = 0;
  CHECK(!decode(Type::State, trailing, n + 1, d));     // one trailing byte
  uint8_t zeroKey[MAX_BODY];
  std::memcpy(zeroKey, buf, n);
  zeroKey[14] = 0;                                      // keyLen = 0
  CHECK(!decode(Type::State, zeroKey, n, d));
  uint8_t badType[MAX_BODY];
  std::memcpy(badType, buf, n);
  badType[15 + 10] = 9;                                 // valueType after the 10-byte key
  CHECK(!decode(Type::State, badType, n, d));
  uint8_t hello[3] = {1, 2, 3};
  CHECK(!decode(Type::Hello, hello, sizeof hello, d));
  CHECK(!decode(Type::State, nullptr, 0, d));
  uint8_t unknown[8] = {};
  CHECK(!decode(static_cast<Type>(42), unknown, sizeof unknown, d));
}

static void every_type_round_trips() {
  uint8_t buf[MAX_BODY];
  Message d{};

  Message hello{};
  hello.type = Type::Hello; hello.msgId = 1; hello.protocol = PROTOCOL; hello.channel = 6; hello.uptimeMs = 123456;
  hello.flags = 1; hello.stateCount = 3; hello.stateDigest = 0xDEADBEEF;
  size_t n = encode(hello, buf, sizeof buf);
  CHECK_EQ(n, 16u);
  CHECK(decode(Type::Hello, buf, n, d));
  CHECK_EQ(d.channel, 6u); CHECK_EQ(d.uptimeMs, 123456u); CHECK_EQ(d.flags, 1u); CHECK_EQ(d.stateCount, 3u); CHECK_EQ(d.stateDigest, 0xDEADBEEFu);

  Message helloAck = hello;
  helloAck.type = Type::HelloAck; helloAck.msgId = 2; helloAck.ackOf = 7;
  n = encode(helloAck, buf, sizeof buf);
  CHECK_EQ(n, 20u);
  CHECK(decode(Type::HelloAck, buf, n, d));
  CHECK_EQ(d.ackOf, 7u); CHECK_EQ(d.stateDigest, 0xDEADBEEFu);

  Message ev{};
  ev.type = Type::Event; ev.msgId = 3; std::strcpy(ev.name, "button.pressed");
  n = encode(ev, buf, sizeof buf);
  CHECK_EQ(n, 4u + 1 + 14 + 1);
  CHECK(decode(Type::Event, buf, n, d));
  CHECK_STR(d.name, "button.pressed"); CHECK_STR(d.payload, "");

  Message ack{};
  ack.type = Type::StateAck; ack.msgId = 4; ack.ackOf = 102;
  n = encode(ack, buf, sizeof buf);
  CHECK_EQ(n, 8u);
  CHECK(decode(Type::StateAck, buf, n, d));
  CHECK_EQ(d.ackOf, 102u);
  ack.type = Type::EventAck;
  n = encode(ack, buf, sizeof buf);
  CHECK(decode(Type::EventAck, buf, n, d));
  CHECK_EQ(d.ackOf, 102u);

  Message req{};
  req.type = Type::SyncReq; req.msgId = 5;
  n = encode(req, buf, sizeof buf);
  CHECK_EQ(n, 4u);
  CHECK(decode(Type::SyncReq, buf, n, d));
  CHECK_EQ(d.msgId, 5u);

  Message pair{};
  pair.type = Type::PairReq; pair.msgId = 6; pair.protocol = PROTOCOL; pair.channel = 6;
  for (int i = 0; i < 8; ++i) pair.nonce[i] = uint8_t(i + 1);
  n = encode(pair, buf, sizeof buf);
  CHECK_EQ(n, 14u);
  CHECK(decode(Type::PairReq, buf, n, d));
  CHECK_EQ(d.nonce[7], 8u); CHECK_EQ(d.channel, 6u); CHECK_EQ(d.protocol, (unsigned)PROTOCOL);

  Message pairAck = pair;
  pairAck.type = Type::PairAck; pairAck.msgId = 7;
  n = encode(pairAck, buf, sizeof buf);
  CHECK_EQ(n, 13u);
  CHECK(decode(Type::PairAck, buf, n, d));
  CHECK_EQ(d.nonce[0], 1u); CHECK_EQ(d.channel, 6u);

  Message unpair{};
  unpair.type = Type::Unpair; unpair.msgId = 8;
  n = encode(unpair, buf, sizeof buf);
  CHECK_EQ(n, 4u);
  CHECK(decode(Type::Unpair, buf, n, d));
  CHECK_EQ(d.msgId, 8u);
}

static void set_local_increments_known_revision() {
  SyncStore store;
  SyncEntry out{};
  CHECK(store.setLocal("demo.power", ValueType::Bool, "true", MAC_A, &out));
  CHECK_EQ(out.revision, 1u);
  CHECK(std::memcmp(out.writer, MAC_A, 6) == 0);
  CHECK_EQ(store.count(), 1u);
  CHECK(store.applyRemote(entry("demo.power", ValueType::Bool, "false", 5, MAC_B)) == SyncStore::Apply::Applied);
  CHECK(store.setLocal("demo.power", ValueType::Bool, "true", MAC_A, &out));
  CHECK_EQ(out.revision, 6u);
  CHECK_STR(store.find("demo.power")->value, "true");
}

static void apply_remote_orders_by_revision_then_mac() {
  SyncStore store;
  SyncEntry out{};
  store.setLocal("k", ValueType::Int, "1", MAC_A, &out);                       // rev 1, writer A
  CHECK(store.applyRemote(entry("k", ValueType::Int, "2", 2, MAC_C)) == SyncStore::Apply::Applied);   // higher revision wins
  CHECK_STR(store.find("k")->value, "2");
  CHECK(store.applyRemote(entry("k", ValueType::Int, "3", 2, MAC_B)) == SyncStore::Apply::Applied);   // same revision, larger MAC wins
  CHECK_STR(store.find("k")->value, "3");
  CHECK(store.applyRemote(entry("k", ValueType::Int, "4", 2, MAC_A)) == SyncStore::Apply::Stale);     // same revision, smaller MAC
  CHECK_STR(store.find("k")->value, "3");
  CHECK(store.applyRemote(entry("k", ValueType::Int, "3", 2, MAC_B)) == SyncStore::Apply::Duplicate); // identical pair
  CHECK(store.applyRemote(entry("k", ValueType::Int, "9", 1, MAC_B)) == SyncStore::Apply::Stale);     // lower revision
  CHECK(compareVersion(2, MAC_B, 2, MAC_A) > 0);
  CHECK(compareVersion(2, MAC_A, 2, MAC_B) < 0);
  CHECK(compareVersion(3, MAC_C, 2, MAC_B) > 0);
  CHECK(compareVersion(2, MAC_A, 2, MAC_A) == 0);
}

static void store_limits() {
  SyncStore store;
  SyncEntry out{};
  char key[8];
  for (int i = 0; i < 16; ++i) {
    std::snprintf(key, sizeof key, "k%d", i);
    CHECK(store.setLocal(key, ValueType::Int, "1", MAC_A, &out));
  }
  CHECK_EQ(store.count(), 16u);
  CHECK(!store.setLocal("k16", ValueType::Int, "1", MAC_A, &out));
  CHECK(store.applyRemote(entry("k17", ValueType::Int, "1", 1, MAC_B)) == SyncStore::Apply::Rejected);
  CHECK(store.applyRemote(entry("bad key", ValueType::Int, "1", 1, MAC_B)) == SyncStore::Apply::Rejected);
  CHECK(store.applyRemote(entry("k0", ValueType::Bool, "maybe", 9, MAC_B)) == SyncStore::Apply::Rejected);
  CHECK(store.applyRemote(entry("k0", static_cast<ValueType>(7), "1", 9, MAC_B)) == SyncStore::Apply::Rejected);
  CHECK(!SyncStore::validKey(""));
  CHECK(!SyncStore::validKey("has space"));
  CHECK(SyncStore::validKey("demo.power_1-x"));
}

static void digest_is_order_independent_and_changes() {
  SyncStore a, b;
  SyncEntry out{};
  a.setLocal("x", ValueType::Int, "1", MAC_A, &out);
  a.setLocal("y", ValueType::Int, "2", MAC_A, &out);
  b.setLocal("y", ValueType::Int, "2", MAC_A, &out);
  b.setLocal("x", ValueType::Int, "1", MAC_A, &out);
  CHECK_EQ(a.digest(), b.digest());
  CHECK_EQ(a.count(), 2u);
  const uint32_t before = a.digest();
  a.setLocal("x", ValueType::Int, "1", MAC_A, &out);   // revision 2 now
  CHECK(a.digest() != before);
  SyncStore empty;
  CHECK(empty.digest() != a.digest());
}

static void serialize_round_trip() {
  SyncStore a;
  SyncEntry out{};
  a.setLocal("demo.power", ValueType::Bool, "true", MAC_A, &out);
  a.setLocal("name", ValueType::String, "desk lamp", MAC_B, &out);
  a.applyRemote(entry("count", ValueType::Int, "42", 7, MAC_C));
  uint8_t blob[1024];
  const size_t n = a.serialize(blob, sizeof blob);
  CHECK(n > 0);
  SyncStore b;
  CHECK(b.deserialize(blob, n));
  CHECK_EQ(b.count(), 3u);
  CHECK_STR(b.find("name")->value, "desk lamp");
  CHECK_EQ(b.find("count")->revision, 7u);
  CHECK(std::memcmp(b.find("count")->writer, MAC_C, 6) == 0);
  CHECK_EQ(a.digest(), b.digest());

  SyncStore c;
  CHECK(!c.deserialize(blob, n - 3));
  CHECK_EQ(c.count(), 0u);
  uint8_t many[4] = {40, 0, 0, 0};
  CHECK(!c.deserialize(many, sizeof many));
  CHECK_EQ(c.count(), 0u);
  CHECK_EQ(a.serialize(blob, 8), 0u);   // buffer too small
}

static void valid_value_rules() {
  CHECK(SyncStore::validValue(ValueType::Bool, "true"));
  CHECK(SyncStore::validValue(ValueType::Bool, "false"));
  CHECK(!SyncStore::validValue(ValueType::Bool, "False"));
  CHECK(SyncStore::validValue(ValueType::Int, "-12"));
  CHECK(!SyncStore::validValue(ValueType::Int, "12x"));
  CHECK(!SyncStore::validValue(ValueType::Int, "99999999999"));
  CHECK(SyncStore::validValue(ValueType::Float, "3.5"));
  CHECK(!SyncStore::validValue(ValueType::Float, "3.5abc"));
  CHECK(SyncStore::validValue(ValueType::Json, "{\"a\":1}"));
  CHECK(SyncStore::validValue(ValueType::Json, "[1,2]"));
  CHECK(!SyncStore::validValue(ValueType::Json, "abc"));
  CHECK(SyncStore::validValue(ValueType::String, ""));
  char longValue[98];
  std::memset(longValue, 'v', 97);
  longValue[97] = 0;
  CHECK(!SyncStore::validValue(ValueType::String, longValue));
  ValueType parsed;
  CHECK(parseValueType("bool", parsed) && parsed == ValueType::Bool);
  CHECK(parseValueType("json", parsed) && parsed == ValueType::Json);
  CHECK(!parseValueType("blob", parsed));
  CHECK_STR(valueTypeName(ValueType::Float), "float");
}

int main() {
  RUN(encode_decode_state_round_trip);
  RUN(encode_rejects_oversized);
  RUN(decode_rejects_malformed);
  RUN(every_type_round_trips);
  RUN(set_local_increments_known_revision);
  RUN(apply_remote_orders_by_revision_then_mac);
  RUN(store_limits);
  RUN(digest_is_order_independent_and_changes);
  RUN(serialize_round_trip);
  RUN(valid_value_rules);
  return report("codec_store_test");
}
