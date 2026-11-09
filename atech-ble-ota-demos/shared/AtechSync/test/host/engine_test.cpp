// Host tests for the AtechSync protocol engine: two (or three) engines on a lossy in-memory bus.
#include "check.h"
#include "fake_bus.h"

static const uint8_t MAC_A[6] = {0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6};
static const uint8_t MAC_B[6] = {0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF7};   // larger than A: wins ties
static const uint8_t MAC_C[6] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55};
static const uint8_t KEY1[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
static const uint8_t KEY2[16] = {9, 9, 9, 9, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};

static void pair(World &w, Node &a, Node &b, const uint8_t *key = KEY1) {
  a.engine.openPairing(key, w.now);
  b.engine.pairWith(a.mac, key, 1, w.now);
  w.run(3000);
}

static bool holds(const Node &n, const char *key, const char *value) {
  const SyncEntry *e = n.engine.get(key);
  return e && std::strcmp(e->value, value) == 0;
}

static void pairing_handshake_both_sides_store_peer() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  a.engine.openPairing(KEY1, w.now);
  CHECK(a.engine.pairingOpen(w.now));
  CHECK(b.engine.pairWith(MAC_A, KEY1, 1, w.now));
  w.run(3000);
  const SyncPeer *ab = a.engine.peerFor(MAC_B);
  const SyncPeer *ba = b.engine.peerFor(MAC_A);
  CHECK(ab && ba);
  if (ab && ba) {
    CHECK(ab->confirmed && ba->confirmed);
    CHECK(ab->state == PeerState::Connected);
    CHECK(ba->state == PeerState::Connected);
    CHECK(std::memcmp(ab->key, KEY1, 16) == 0 && std::memcmp(ba->key, KEY1, 16) == 0);
  }
  CHECK(!a.engine.pairingOpen(w.now));
  CHECK_EQ(w.bus.count(Type::PairAck), 1);
  CHECK(a.peersChanged >= 1 && b.peersChanged >= 1);
}

static void local_set_reaches_peer_and_notifies_both() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  CHECK(a.engine.set("demo.power", ValueType::Bool, "true", w.now));
  CHECK(a.engine.storeDirty());
  a.engine.storePersisted();
  CHECK(!a.engine.storeDirty());
  w.run(1000);
  CHECK_EQ(b.remoteChanges(), 1);
  if (!b.changes.empty()) {
    CHECK_STR(b.changes[0].key.c_str(), "demo.power");
    CHECK_STR(b.changes[0].value.c_str(), "true");
    CHECK_EQ(b.changes[0].revision, 1u);
    CHECK(std::memcmp(b.changes[0].writer, MAC_A, 6) == 0);
  }
  CHECK_EQ(a.localChanges(), 1);
  CHECK_EQ(a.engine.stats().acked, 1u);
  CHECK(b.engine.storeDirty());
}

static void bidirectional_updates() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  b.engine.set("counter", ValueType::Int, "5", w.now);
  w.run(1000);
  CHECK(holds(a, "counter", "5"));
  a.engine.set("counter", ValueType::Int, "6", w.now);
  w.run(1000);
  CHECK(holds(b, "counter", "6"));
  CHECK_EQ(b.engine.get("counter")->revision, 2u);
}

static void duplicate_frames_apply_once() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.duplicateStates = true;
  a.engine.set("demo.power", ValueType::Bool, "true", w.now);
  w.run(1000);
  CHECK_EQ(b.remoteChanges(), 1);
  CHECK_EQ(b.engine.stats().duplicates, 1u);
  CHECK_EQ(w.bus.count(Type::StateAck), 2);
  CHECK_EQ(a.engine.stats().acked, 1u);
  CHECK_EQ(a.engine.queued(), 0u);
}

static void lost_acks_retry_with_backoff() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  int dropped = 0;
  w.bus.drop = [&](const Frame &f) {
    if (f.type == Type::State && std::memcmp(f.from, MAC_A, 6) == 0 && dropped < 2) { ++dropped; return true; }
    return false;
  };
  a.engine.set("demo.power", ValueType::Bool, "true", w.now);
  w.run(2000);
  CHECK(holds(b, "demo.power", "true"));
  CHECK_EQ(a.engine.stats().retries, 2u);
  const std::vector<uint32_t> times = w.bus.sentTimes(Type::State, MAC_A);
  CHECK_EQ(times.size(), 3u);
  if (times.size() == 3) {
    CHECK(times[1] - times[0] >= 150 && times[1] - times[0] <= 160);
    CHECK(times[2] - times[1] >= 300 && times[2] - times[1] <= 310);
  }
  CHECK_EQ(a.engine.queued(), 0u);
}

static void exhausted_retries_drop_and_report() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.drop = [](const Frame &f) { return f.type == Type::State && std::memcmp(f.from, MAC_A, 6) == 0; };
  a.engine.set("demo.power", ValueType::Bool, "true", w.now);
  w.run(6000);
  CHECK_EQ(a.engine.stats().dropped, 1u);
  CHECK_EQ(a.engine.queued(), 0u);
  CHECK_EQ(w.bus.sentTimes(Type::State, MAC_A).size(), 5u);
  CHECK_EQ(b.remoteChanges(), 0);
}

static void stale_remote_state_is_answered_with_the_newer_local_entry() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.partition = true;
  a.engine.set("k", ValueType::Int, "1", w.now);
  b.engine.set("k", ValueType::Int, "2", w.now);
  b.engine.set("k", ValueType::Int, "3", w.now);
  w.bus.partition = false;
  w.run(3000);
  CHECK(holds(a, "k", "3"));
  CHECK(holds(b, "k", "3"));
  CHECK(std::memcmp(a.engine.get("k")->writer, MAC_B, 6) == 0);
  CHECK_EQ(a.remoteChanges(), 1);
  CHECK_EQ(b.remoteChanges(), 0);
  CHECK(b.engine.stats().stale >= 1);
  const int states = w.bus.count(Type::State);
  w.run(3000);
  CHECK_EQ(w.bus.count(Type::State), states);
}

static void simultaneous_conflicting_writes_converge_with_the_mac_tie_breaker() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.partition = true;
  a.engine.set("k", ValueType::String, "a", w.now);
  b.engine.set("k", ValueType::String, "b", w.now);
  w.bus.partition = false;
  w.run(3000);
  CHECK(holds(a, "k", "b"));   // same revision 1 on both sides: the larger MAC (B) wins
  CHECK(holds(b, "k", "b"));
  CHECK_EQ(a.remoteChanges(), 1);
  CHECK_EQ(b.remoteChanges(), 0);
  CHECK_EQ(a.engine.queued(), 0u);
  CHECK_EQ(b.engine.queued(), 0u);
}

static void disconnect_and_reconnect_reconciles() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  a.engine.set("x", ValueType::Int, "1", w.now);
  a.engine.set("y", ValueType::Int, "2", w.now);
  w.run(1000);
  CHECK(holds(b, "y", "2"));
  w.bus.partition = true;
  w.run(10000);
  CHECK(a.engine.peerFor(MAC_B)->state == PeerState::Offline);
  CHECK(b.engine.peerFor(MAC_A)->state == PeerState::Offline);
  bool aSawOffline = false;
  for (const Transition &t : a.transitions) if (t.from == PeerState::Connected && t.to == PeerState::Offline) aSawOffline = true;
  CHECK(aSawOffline);
  b.engine.set("z", ValueType::Int, "3", w.now);
  w.run(6000);
  CHECK(b.engine.stats().dropped >= 1);
  w.bus.partition = false;
  w.run(5000);
  CHECK(a.engine.peerFor(MAC_B)->state == PeerState::Connected);
  CHECK(b.engine.peerFor(MAC_A)->state == PeerState::Connected);
  CHECK(holds(a, "z", "3"));
  CHECK_EQ(a.engine.store().digest(), b.engine.store().digest());
}

static void reboot_restores_state_and_peer() {
  World w;
  Node b(w.bus, MAC_B, &w.now, 22);
  uint8_t blob[1024];
  size_t blobLen = 0;
  uint8_t channel = 0;
  {
    Node a(w.bus, MAC_A, &w.now, 11);
    pair(w, a, b);
    a.engine.set("k", ValueType::Int, "1", w.now);
    w.run(1000);
    blobLen = a.engine.store().serialize(blob, sizeof blob);
    channel = a.engine.peer(0)->channel;
  }   // A "reboots": the old engine is gone
  Node a2(w.bus, MAC_A, &w.now, 33);
  CHECK(a2.engine.addStoredPeer(MAC_B, KEY1, channel, true));
  CHECK(a2.engine.store().deserialize(blob, blobLen));
  CHECK_EQ(a2.engine.get("k")->revision, 1u);
  w.run(3500);
  CHECK(b.engine.peerFor(MAC_A)->state == PeerState::Connected);
  CHECK(a2.engine.peerFor(MAC_B)->state == PeerState::Connected);
  a2.engine.set("k", ValueType::Int, "2", w.now);
  w.run(1000);
  CHECK(holds(b, "k", "2"));
  CHECK_EQ(b.engine.get("k")->revision, 2u);
}

static void events_are_delivered_once_and_acked() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.duplicateEvents = true;
  CHECK(a.engine.emit("button.pressed", "x", w.now));
  w.run(1000);
  CHECK_EQ(b.events.size(), 1u);
  if (!b.events.empty()) {
    CHECK_STR(b.events[0].name.c_str(), "button.pressed");
    CHECK_STR(b.events[0].payload.c_str(), "x");
    CHECK(b.events[0].remote);
    CHECK(std::memcmp(b.events[0].source, MAC_A, 6) == 0);
  }
  CHECK_EQ(a.events.size(), 1u);
  CHECK(!a.events.empty() && !a.events[0].remote);
  CHECK_EQ(w.bus.count(Type::EventAck), 2);
  CHECK_EQ(a.engine.stats().acked, 1u);
  CHECK(!a.engine.emit("", "x", w.now));
  char longName[40];
  std::memset(longName, 'n', 39);
  longName[39] = 0;
  CHECK(!a.engine.emit(longName, "", w.now));
}

static void rapid_toggles_coalesce() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.bus.hold = true;
  for (int i = 0; i < 20; ++i) a.engine.set("demo.power", ValueType::Bool, i % 2 ? "true" : "false", w.now);
  CHECK_EQ(a.engine.queued(), 1u);
  w.run(500);
  w.bus.hold = false;
  w.run(2000);
  CHECK(holds(b, "demo.power", "true"));   // i = 19 was the last write
  CHECK(a.engine.stats().sent <= 6);
  CHECK_EQ(a.engine.queued(), 0u);
}

static void unknown_mac_is_ignored_unless_pairing() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  Message m{};
  m.type = Type::State; m.msgId = 77; m.entry.revision = 9; std::memcpy(m.entry.writer, MAC_C, 6);
  std::strcpy(m.entry.key, "k"); m.entry.type = ValueType::Int; std::strcpy(m.entry.value, "1");
  uint8_t body[MAX_BODY];
  const size_t n = encode(m, body, sizeof body);
  a.engine.receive(MAC_C, Type::State, body, n, w.now);
  CHECK_EQ(a.engine.stats().rejected, 1u);
  CHECK(a.engine.get("k") == nullptr);
  CHECK_EQ(a.engine.peerCount(), 1u);
}

static void malformed_bodies_are_rejected() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  const uint8_t shortState[3] = {1, 2, 3};
  a.engine.receive(MAC_B, Type::State, shortState, sizeof shortState, w.now);
  uint8_t longEvent[64] = {};
  longEvent[4] = 40;   // nameLen 40 after the msgId
  a.engine.receive(MAC_B, Type::Event, longEvent, sizeof longEvent, w.now);
  const uint8_t pairReq[1] = {0};
  a.engine.receive(MAC_B, Type::PairReq, pairReq, 1, w.now);
  CHECK_EQ(a.engine.stats().rejected, 3u);
  CHECK_EQ(a.engine.store().count(), 0u);
  CHECK_EQ(a.events.size(), 0u);
}

static void unpair_removes_peer_on_both_sides() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  CHECK(a.engine.unpairAll(w.now));
  w.run(1000);
  CHECK_EQ(a.engine.peerCount(), 0u);
  CHECK_EQ(b.engine.peerCount(), 0u);
  CHECK(!b.transitions.empty() && b.transitions.back().to == PeerState::None);
  CHECK(!a.transitions.empty() && a.transitions.back().to == PeerState::None);
  CHECK(!a.engine.set("k", ValueType::Int, "1", w.now) || a.engine.queued() == 0);   // no peer: nothing queued
}

static void paused_engine_sends_only_acks() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  a.engine.setPaused(true);
  CHECK(a.engine.paused());
  const int hellosBefore = w.bus.sentTimes(Type::Hello, MAC_A).size();
  b.engine.set("k", ValueType::Int, "1", w.now);
  w.run(1000);
  CHECK(holds(a, "k", "1"));
  CHECK_EQ(b.engine.stats().acked, 1u);
  a.engine.set("m", ValueType::Int, "2", w.now);
  w.run(1000);
  CHECK_EQ(a.engine.queued(), 1u);
  CHECK(!holds(b, "m", "2"));
  CHECK_EQ(int(w.bus.sentTimes(Type::Hello, MAC_A).size()), hellosBefore);
  a.engine.setPaused(false);
  w.run(1000);
  CHECK(holds(b, "m", "2"));
  CHECK_EQ(a.engine.queued(), 0u);
}

static void three_peers_forward_through_the_hub() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22), c(w.bus, MAC_C, &w.now, 33);
  pair(w, a, b, KEY1);
  pair(w, a, c, KEY2);
  CHECK_EQ(a.engine.peerCount(), 2u);
  b.engine.set("k", ValueType::Int, "1", w.now);
  w.run(1500);
  CHECK(holds(a, "k", "1"));
  CHECK(holds(c, "k", "1"));
  CHECK_EQ(a.engine.stats().forwarded, 1u);
  CHECK_EQ(b.remoteChanges(), 0);
  CHECK_EQ(c.remoteChanges(), 1);
}

static void repair_with_a_fresh_code_while_paired() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b, KEY1);
  a.engine.set("k", ValueType::Int, "1", w.now);
  w.run(1000);
  // The user asks A for a new code and pairs B with it again: both end up on KEY2, still in sync.
  a.engine.openPairing(KEY2, w.now);
  CHECK(b.engine.pairWith(MAC_A, KEY2, 1, w.now));
  CHECK(b.engine.peerFor(MAC_A)->state == PeerState::Pairing);
  w.run(3000);
  CHECK(a.engine.peerFor(MAC_B) && std::memcmp(a.engine.peerFor(MAC_B)->key, KEY2, 16) == 0);
  CHECK(b.engine.peerFor(MAC_A) && std::memcmp(b.engine.peerFor(MAC_A)->key, KEY2, 16) == 0);
  CHECK(a.engine.peerFor(MAC_B)->state == PeerState::Connected);
  CHECK(b.engine.peerFor(MAC_A)->state == PeerState::Connected);
  CHECK_EQ(a.engine.peerCount(), 1u);
  CHECK(!a.engine.pairingOpen(w.now));
  b.engine.set("k", ValueType::Int, "2", w.now);
  w.run(1000);
  CHECK(holds(a, "k", "2"));
}

static void force_hello_sends_on_the_next_tick() {
  World w;
  Node a(w.bus, MAC_A, &w.now, 11), b(w.bus, MAC_B, &w.now, 22);
  pair(w, a, b);
  w.run(100);
  const size_t before = w.bus.sentTimes(Type::Hello, MAC_A).size();
  a.engine.forceHello();
  w.run(20);
  CHECK_EQ(w.bus.sentTimes(Type::Hello, MAC_A).size(), before + 1);
  w.run(200);
  CHECK_EQ(w.bus.sentTimes(Type::Hello, MAC_A).size(), before + 1);   // one forced hello, then the normal pace
}

int main() {
  RUN(repair_with_a_fresh_code_while_paired);
  RUN(force_hello_sends_on_the_next_tick);
  RUN(pairing_handshake_both_sides_store_peer);
  RUN(local_set_reaches_peer_and_notifies_both);
  RUN(bidirectional_updates);
  RUN(duplicate_frames_apply_once);
  RUN(lost_acks_retry_with_backoff);
  RUN(exhausted_retries_drop_and_report);
  RUN(stale_remote_state_is_answered_with_the_newer_local_entry);
  RUN(simultaneous_conflicting_writes_converge_with_the_mac_tie_breaker);
  RUN(disconnect_and_reconnect_reconciles);
  RUN(reboot_restores_state_and_peer);
  RUN(events_are_delivered_once_and_acked);
  RUN(rapid_toggles_coalesce);
  RUN(unknown_mac_is_ignored_unless_pairing);
  RUN(malformed_bodies_are_rejected);
  RUN(unpair_removes_peer_on_both_sides);
  RUN(paused_engine_sends_only_acks);
  RUN(three_peers_forward_through_the_hub);
  return report("engine_test");
}
