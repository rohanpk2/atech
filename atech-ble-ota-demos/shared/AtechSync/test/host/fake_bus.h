// fake_bus.h: an in-memory "radio" joining SyncEngine instances for the host tests. Frames are
// delivered on pump() after a small latency; a predicate can drop frames, a flag can partition
// the bus (frames lost), another can hold them (delivered later), and every transmission and
// delivery is recorded so tests can assert on timing and counts.
#pragma once

#include "SyncEngine.h"

#include <cstring>
#include <deque>
#include <functional>
#include <string>
#include <vector>

using namespace atech::syncproto;

struct Frame {
  uint8_t from[6];
  uint8_t to[6];
  Type type;
  uint8_t body[MAX_BODY];
  size_t len;
  uint32_t sentAt;
  uint32_t deliverAt;
};

struct Node;

struct Bus {
  std::vector<Node *> nodes;
  std::deque<Frame> inFlight;
  std::vector<Frame> transmitted;   // every send() call, dropped or not
  std::vector<Frame> delivered;
  std::function<bool(const Frame &)> drop;   // true: lose the frame
  bool partition = false;      // every frame is lost
  bool hold = false;           // frames wait until hold is cleared
  bool duplicateStates = false;
  bool duplicateEvents = false;
  uint32_t latencyMs = 1;

  void attach(Node *node);
  void detach(Node *node);
  void send(const uint8_t *from, const uint8_t *to, Type type, const uint8_t *body, size_t len, uint32_t now) {
    Frame f{};
    std::memcpy(f.from, from, 6);
    std::memcpy(f.to, to, 6);
    f.type = type;
    std::memcpy(f.body, body, len);
    f.len = len;
    f.sentAt = now;
    f.deliverAt = now + latencyMs;
    transmitted.push_back(f);
    if (partition || (drop && drop(f))) return;
    inFlight.push_back(f);
    if ((duplicateStates && type == Type::State) || (duplicateEvents && type == Type::Event)) inFlight.push_back(f);
  }
  void pump(uint32_t now);
  int count(Type type) const {
    int n = 0;
    for (const Frame &f : transmitted) if (f.type == type) ++n;
    return n;
  }
  std::vector<uint32_t> sentTimes(Type type, const uint8_t *from) const {
    std::vector<uint32_t> out;
    for (const Frame &f : transmitted) if (f.type == type && std::memcmp(f.from, from, 6) == 0) out.push_back(f.sentAt);
    return out;
  }
};

struct Change { std::string key; std::string value; uint32_t revision; uint8_t writer[6]; bool remote; };
struct EventRecord { std::string name; std::string payload; uint8_t source[6]; bool remote; };
struct Transition { PeerState from; PeerState to; };

struct Node : public SyncTransport, public SyncListener {
  Bus &bus;
  uint8_t mac[6];
  uint32_t *clock;
  SyncEngine engine;
  std::vector<Change> changes;
  std::vector<EventRecord> events;
  std::vector<Transition> transitions;
  int peersChanged = 0;

  Node(Bus &b, const uint8_t *address, uint32_t *now, uint32_t seed) : bus(b), clock(now), engine(*this, *this) {
    std::memcpy(mac, address, 6);
    engine.begin(mac, *now, seed);
    bus.attach(this);
  }
  ~Node() { bus.detach(this); }

  bool send(const uint8_t to[6], Type type, const uint8_t *body, size_t len) override {
    bus.send(mac, to, type, body, len, *clock);
    return true;
  }
  void onState(const StateChange &change) override {
    Change c{change.entry->key, change.entry->value, change.entry->revision, {}, change.remote};
    std::memcpy(c.writer, change.entry->writer, 6);
    changes.push_back(c);
  }
  void onEvent(const EventInfo &event) override {
    EventRecord e{event.name, event.payload, {}, event.remote};
    std::memcpy(e.source, event.source, 6);
    events.push_back(e);
  }
  void onPeer(const SyncPeer &peer, PeerState previous) override { transitions.push_back({previous, peer.state}); }
  void onPeersChanged() override { ++peersChanged; }

  int remoteChanges() const { int n = 0; for (const Change &c : changes) if (c.remote) ++n; return n; }
  int localChanges() const { return int(changes.size()) - remoteChanges(); }
};

inline void Bus::attach(Node *node) { nodes.push_back(node); }
inline void Bus::detach(Node *node) {
  for (size_t i = 0; i < nodes.size(); ++i) if (nodes[i] == node) { nodes.erase(nodes.begin() + i); return; }
}
inline void Bus::pump(uint32_t now) {
  if (hold) return;
  while (!inFlight.empty() && inFlight.front().deliverAt <= now) {
    Frame f = inFlight.front();
    inFlight.pop_front();
    for (Node *node : nodes) {
      if (std::memcmp(node->mac, f.to, 6) != 0) continue;
      delivered.push_back(f);
      node->engine.receive(f.from, f.type, f.body, f.len, now);
    }
  }
}

struct World {
  uint32_t now = 1000;
  Bus bus;
  // Advances time, ticking every attached engine and delivering frames at each step.
  void run(uint32_t durationMs, uint32_t stepMs = 10) {
    const uint32_t until = now + durationMs;
    while (now < until) {
      now += stepMs;
      for (Node *node : bus.nodes) node->engine.tick(now);
      bus.pump(now);
    }
  }
};
