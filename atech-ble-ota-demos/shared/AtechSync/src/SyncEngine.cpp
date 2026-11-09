// SyncEngine.cpp: see SyncEngine.h.
#include "SyncEngine.h"

#include <string.h>

namespace atech {
namespace syncproto {

namespace {
constexpr uint8_t HELLO_FLAG_BOOTED = 0x01;
constexpr uint32_t SYNC_ALL_THROTTLE_MS = 10000;
inline bool due(uint32_t nowMs, uint32_t atMs) { return static_cast<int32_t>(nowMs - atMs) >= 0; }
}  // namespace

const char *peerStateName(PeerState state) {
  switch (state) {
    case PeerState::Pairing: return "pairing";
    case PeerState::Offline: return "offline";
    case PeerState::Connected: return "connected";
    default: return "none";
  }
}

SyncEngine::SyncEngine(SyncTransport &transport, SyncListener &listener)
    : _transport(transport), _listener(listener), _channel(0), _msgId(1), _seed(0), _bootMs(0), _justBooted(false),
      _paused(false), _storeDirty(false), _pairingOpen(false), _pairingUntilMs(0) {
  memset(_peers, 0, sizeof(_peers));
  memset(_queue, 0, sizeof(_queue));
  memset(&_stats, 0, sizeof(_stats));
  memset(_mac, 0, sizeof(_mac));
  memset(_pairingKey, 0, sizeof(_pairingKey));
}

void SyncEngine::begin(const uint8_t mac[6], uint32_t nowMs, uint32_t seed) {
  memcpy(_mac, mac, 6);
  _seed = seed;
  _msgId = (seed | 1u);
  _bootMs = nowMs;
  _justBooted = true;
}

// ---- helpers --------------------------------------------------------------------------------

int SyncEngine::indexOf(const uint8_t mac[6]) const {
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used && memcmp(_peers[i].mac, mac, 6) == 0) return int(i);
  return -1;
}

int SyncEngine::allocatePeer(const uint8_t mac[6]) {
  const int existing = indexOf(mac);
  if (existing >= 0) return existing;
  for (size_t i = 0; i < MAX_PEERS; ++i) {
    if (_peers[i].used) continue;
    memset(&_peers[i], 0, sizeof(SyncPeer));
    _peers[i].used = true;
    memcpy(_peers[i].mac, mac, 6);
    return int(i);
  }
  return -1;
}

void SyncEngine::removePeer(int index, uint32_t nowMs, bool notifyPeer) {
  (void)nowMs;
  if (index < 0 || !_peers[index].used) return;
  SyncPeer &p = _peers[index];
  if (notifyPeer && p.confirmed) {
    Message m{};
    m.type = Type::Unpair;
    m.msgId = nextMsgId();
    transmit(p.mac, Type::Unpair, m);
  }
  dropQueueFor(index);
  SyncPeer copy = p;
  const PeerState previous = p.state;
  copy.state = PeerState::None;
  copy.used = false;
  memset(&p, 0, sizeof(SyncPeer));
  _listener.onPeer(copy, previous);
  _listener.onPeersChanged();
}

uint32_t SyncEngine::nextMsgId() {
  _msgId += 1;
  if (_msgId == 0) _msgId = 1;
  return _msgId;
}

void SyncEngine::makeNonce(uint8_t out[8]) {
  uint32_t x = nextMsgId() ^ (_seed * 2654435761u);
  uint32_t y = (x ^ (x >> 13)) * 0x5BD1E995u ^ _bootMs;
  for (int i = 0; i < 4; ++i) { out[i] = uint8_t(x >> (8 * i)); out[4 + i] = uint8_t(y >> (8 * i)); }
}

bool SyncEngine::transmit(const uint8_t mac[6], Type type, const Message &m) {
  uint8_t body[MAX_BODY];
  const size_t len = encode(m, body, sizeof body);
  if (!len) return false;
  return _transport.send(mac, type, body, len);
}

void SyncEngine::sendAck(SyncPeer &peer, Type ackType, uint32_t ackOf) {
  Message m{};
  m.type = ackType;
  m.msgId = nextMsgId();
  m.ackOf = ackOf;
  transmit(peer.mac, ackType, m);
}

void SyncEngine::sendHello(SyncPeer &peer, uint32_t nowMs, bool ack, uint32_t ackOf) {
  Message m{};
  m.type = ack ? Type::HelloAck : Type::Hello;
  m.msgId = nextMsgId();
  m.ackOf = ackOf;
  m.protocol = PROTOCOL;
  m.channel = _channel;
  m.uptimeMs = nowMs - _bootMs;
  m.flags = _justBooted ? HELLO_FLAG_BOOTED : 0;
  m.stateCount = uint8_t(_store.count());
  m.stateDigest = _store.digest();
  if (transmit(peer.mac, m.type, m)) peer.lastTxMs = nowMs;
}

void SyncEngine::sendPairReq(SyncPeer &peer, uint32_t nowMs) {
  Message m{};
  m.type = Type::PairReq;
  m.msgId = nextMsgId();
  memcpy(m.nonce, peer.pairNonce, 8);
  m.protocol = PROTOCOL;
  m.channel = _channel;
  transmit(peer.mac, Type::PairReq, m);
  peer.lastTxMs = nowMs;
  peer.pairAttempts = peer.pairAttempts < 255 ? peer.pairAttempts + 1 : 255;
  peer.nextPairMs = nowMs + (peer.pairAttempts < PAIR_REQ_FAST_ATTEMPTS ? PAIR_REQ_INTERVAL_MS : PAIR_REQ_SLOW_INTERVAL_MS);
}

// Queues a STATE or EVENT for a peer. A STATE for a key already queued for that peer replaces it
// (new id, attempts reset, same schedule), so rapid changes never flood the queue; EVENTs are
// never merged and are dropped, counted, when the queue is full.
bool SyncEngine::enqueue(int peerIndex, const Message &m, uint32_t nowMs) {
  Outgoing *slot = nullptr;
  if (m.type == Type::State) {
    for (size_t i = 0; i < QUEUE_DEPTH; ++i) {
      Outgoing &o = _queue[i];
      if (o.used && o.peer == peerIndex && o.type == Type::State && strcmp(o.key, m.entry.key) == 0) { slot = &o; break; }
    }
  }
  const bool replacing = slot != nullptr;
  if (!slot) {
    for (size_t i = 0; i < QUEUE_DEPTH; ++i) if (!_queue[i].used) { slot = &_queue[i]; break; }
  }
  if (!slot) { _stats.dropped++; return false; }
  Message copy = m;
  copy.msgId = nextMsgId();
  const size_t len = encode(copy, slot->body, sizeof slot->body);
  if (!len) { if (!replacing) memset(slot, 0, sizeof(Outgoing)); return false; }
  slot->used = true;
  slot->peer = uint8_t(peerIndex);
  slot->type = m.type;
  slot->msgId = copy.msgId;
  slot->attempts = 0;
  slot->len = uint8_t(len);
  if (!replacing) slot->nextAtMs = nowMs;
  if (m.type == Type::State) strncpy(slot->key, m.entry.key, MAX_KEY); else slot->key[0] = 0;
  return true;
}

void SyncEngine::enqueueState(int peerIndex, const SyncEntry &entry, uint32_t nowMs) {
  Message m{};
  m.type = Type::State;
  m.entry = entry;
  enqueue(peerIndex, m, nowMs);
}

void SyncEngine::sendAll(int peerIndex, uint32_t nowMs, bool force) {
  SyncPeer &p = _peers[peerIndex];
  if (!force && p.lastSyncAllMs != 0 && nowMs - p.lastSyncAllMs < SYNC_ALL_THROTTLE_MS) return;
  p.lastSyncAllMs = nowMs ? nowMs : 1;
  for (size_t i = 0; i < _store.count(); ++i) enqueueState(peerIndex, *_store.at(i), nowMs);
}

void SyncEngine::dropQueueFor(int peerIndex) {
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) if (_queue[i].used && _queue[i].peer == peerIndex) memset(&_queue[i], 0, sizeof(Outgoing));
}

size_t SyncEngine::queuedFor(int peerIndex) const {
  size_t n = 0;
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) if (_queue[i].used && _queue[i].peer == peerIndex) ++n;
  return n;
}

// Any authenticated frame proves the peer is alive (and, for a Pairing peer, that the handshake
// completed). Returns true when the peer just became Connected.
bool SyncEngine::touch(SyncPeer &peer, uint32_t nowMs) {
  peer.lastRxMs = nowMs;
  if (peer.state == PeerState::Connected) return false;
  const PeerState previous = peer.state;
  peer.state = PeerState::Connected;
  if (!peer.confirmed) { peer.confirmed = true; _listener.onPeersChanged(); }
  _listener.onPeer(peer, previous);
  return true;
}

bool SyncEngine::seen(SyncPeer &peer, uint32_t msgId) {
  for (size_t i = 0; i < peer.dedupeCount && i < DEDUPE; ++i) if (peer.dedupe[i] == msgId) return true;
  peer.dedupe[peer.dedupeAt] = msgId;
  peer.dedupeAt = uint8_t((peer.dedupeAt + 1) % DEDUPE);
  if (peer.dedupeCount < DEDUPE) peer.dedupeCount++;
  return false;
}

void SyncEngine::digestsDiffer(const Message &m, bool &differ) const {
  differ = m.stateDigest != _store.digest() || m.stateCount != _store.count();
}

// ---- state and events ----------------------------------------------------------------------

bool SyncEngine::set(const char *key, ValueType type, const char *value, uint32_t nowMs) {
  SyncEntry entry;
  if (!_store.setLocal(key, type, value, _mac, &entry)) return false;
  _storeDirty = true;
  const SyncEntry *stored = _store.find(key);
  StateChange change{stored, false, _mac};
  _listener.onState(change);
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used && _peers[i].confirmed) enqueueState(int(i), *stored, nowMs);
  return true;
}

bool SyncEngine::emit(const char *name, const char *payload, uint32_t nowMs) {
  if (!name) return false;
  const size_t nameLen = strnlen(name, MAX_NAME + 1);
  const size_t payloadLen = payload ? strnlen(payload, MAX_PAYLOAD + 1) : 0;
  if (nameLen == 0 || nameLen > MAX_NAME || payloadLen > MAX_PAYLOAD) return false;
  Message m{};
  m.type = Type::Event;
  memcpy(m.name, name, nameLen);
  if (payload) memcpy(m.payload, payload, payloadLen);
  EventInfo info{m.name, m.payload, _mac, false};
  _listener.onEvent(info);
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used && _peers[i].confirmed) enqueue(int(i), m, nowMs);
  return true;
}

// ---- pairing ---------------------------------------------------------------------------------

void SyncEngine::openPairing(const uint8_t key[KEY_BYTES], uint32_t nowMs) {
  memcpy(_pairingKey, key, KEY_BYTES);
  _pairingOpen = true;
  _pairingUntilMs = nowMs + PAIR_WINDOW_MS;
}

void SyncEngine::closePairing() {
  _pairingOpen = false;
  memset(_pairingKey, 0, sizeof(_pairingKey));
}

bool SyncEngine::pairingOpen(uint32_t nowMs) const {
  return _pairingOpen && !due(nowMs, _pairingUntilMs);
}

bool SyncEngine::pairWith(const uint8_t mac[6], const uint8_t key[KEY_BYTES], uint8_t channel, uint32_t nowMs) {
  if (memcmp(mac, _mac, 6) == 0) return false;
  const int index = allocatePeer(mac);
  if (index < 0) return false;
  SyncPeer &p = _peers[index];
  const PeerState previous = p.state;
  dropQueueFor(index);
  memcpy(p.key, key, KEY_BYTES);
  p.channel = channel;
  p.confirmed = false;
  p.state = PeerState::Pairing;
  p.pairAttempts = 0;
  p.nextPairMs = nowMs;
  p.lastRxMs = 0;
  p.lastAckMs = 0;
  p.lastSyncAllMs = 0;
  makeNonce(p.pairNonce);
  _listener.onPeer(p, previous);
  _listener.onPeersChanged();
  return true;
}

bool SyncEngine::unpair(const uint8_t mac[6], uint32_t nowMs) {
  const int index = indexOf(mac);
  if (index < 0) return false;
  removePeer(index, nowMs, true);
  return true;
}

bool SyncEngine::unpairAll(uint32_t nowMs) {
  bool any = false;
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used) { removePeer(int(i), nowMs, true); any = true; }
  closePairing();
  return any;
}

bool SyncEngine::addStoredPeer(const uint8_t mac[6], const uint8_t key[KEY_BYTES], uint8_t channel, bool confirmed) {
  if (memcmp(mac, _mac, 6) == 0) return false;
  const int index = allocatePeer(mac);
  if (index < 0) return false;
  SyncPeer &p = _peers[index];
  memcpy(p.key, key, KEY_BYTES);
  p.channel = channel;
  p.confirmed = confirmed;
  p.state = confirmed ? PeerState::Offline : PeerState::Pairing;
  p.lastTxMs = 0;
  p.nextPairMs = 0;
  p.pairAttempts = 0;
  makeNonce(p.pairNonce);
  return true;
}

const SyncPeer *SyncEngine::peer(size_t index) const {
  size_t seenUsed = 0;
  for (size_t i = 0; i < MAX_PEERS; ++i) {
    if (!_peers[i].used) continue;
    if (seenUsed == index) return &_peers[i];
    ++seenUsed;
  }
  return nullptr;
}

const SyncPeer *SyncEngine::peerFor(const uint8_t mac[6]) const {
  const int index = indexOf(mac);
  return index >= 0 ? &_peers[index] : nullptr;
}

size_t SyncEngine::peerCount() const {
  size_t n = 0;
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used) ++n;
  return n;
}

bool SyncEngine::anyConnected() const {
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used && _peers[i].state == PeerState::Connected) return true;
  return false;
}

size_t SyncEngine::queued() const {
  size_t n = 0;
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) if (_queue[i].used) ++n;
  return n;
}

// ---- receive ---------------------------------------------------------------------------------

void SyncEngine::receive(const uint8_t mac[6], Type type, const uint8_t *body, size_t len, uint32_t nowMs) {
  Message m;
  if (!mac || !decode(type, body, len, m)) { _stats.rejected++; return; }
  if (type == Type::PairReq) { handlePairReq(mac, m, nowMs); return; }
  const int index = indexOf(mac);
  if (index < 0) { _stats.rejected++; return; }
  SyncPeer &p = _peers[index];
  if (type == Type::PairAck && p.state == PeerState::Pairing && memcmp(m.nonce, p.pairNonce, 8) != 0) { _stats.rejected++; return; }
  _stats.received++;
  const bool justConnected = touch(p, nowMs);
  switch (type) {
    case Type::Hello:
    case Type::HelloAck:
      handleHello(index, m, justConnected, nowMs);
      break;
    case Type::State:
      handleState(index, m, nowMs);
      break;
    case Type::StateAck:
    case Type::EventAck:
      handleAck(index, m.ackOf, nowMs);
      break;
    case Type::Event:
      handleEvent(index, m, nowMs);
      break;
    case Type::SyncReq:
      sendAll(index, nowMs, true);
      break;
    case Type::PairAck:
      if (m.channel) p.channel = m.channel;
      _listener.onPeersChanged();
      break;
    case Type::Unpair:
      removePeer(index, nowMs, false);
      break;
    default:
      _stats.rejected++;
      break;
  }
}

void SyncEngine::handlePairReq(const uint8_t mac[6], const Message &m, uint32_t nowMs) {
  if (!pairingOpen(nowMs) || m.protocol != PROTOCOL || memcmp(mac, _mac, 6) == 0) { _stats.rejected++; return; }
  const int index = allocatePeer(mac);
  if (index < 0) { _stats.rejected++; _listener.onLog("pairing refused: peer table full"); return; }
  SyncPeer &p = _peers[index];
  const PeerState previous = p.state;
  dropQueueFor(index);
  memcpy(p.key, _pairingKey, KEY_BYTES);
  if (m.channel) p.channel = m.channel;
  p.confirmed = true;
  p.state = PeerState::Connected;
  p.lastRxMs = nowMs;
  p.lastSyncAllMs = 0;
  _stats.received++;
  Message ack{};
  ack.type = Type::PairAck;
  ack.msgId = nextMsgId();
  memcpy(ack.nonce, m.nonce, 8);
  ack.channel = _channel;
  transmit(p.mac, Type::PairAck, ack);
  p.lastTxMs = nowMs;
  closePairing();
  _listener.onPeer(p, previous);
  _listener.onPeersChanged();
}

void SyncEngine::handleHello(int peerIndex, const Message &m, bool justConnected, uint32_t nowMs) {
  SyncPeer &p = _peers[peerIndex];
  if (m.channel) p.channel = m.channel;
  if (m.type == Type::Hello && !_paused) sendHello(p, nowMs, true, m.msgId);
  if (m.type == Type::HelloAck) _justBooted = false;
  bool differ = false;
  digestsDiffer(m, differ);
  // The "just booted" flag is informational: a rebooted board comes back with its persisted
  // table, so the digest comparison below (and the reconnection rule) already cover it.
  if (differ && justConnected) {
    p.digestMisses = 0;
    sendAll(peerIndex, nowMs, true);
  } else if (!differ) {
    p.digestMisses = 0;
  } else if (queuedFor(peerIndex) == 0) {
    // A HELLO digest is a snapshot that can lag frames still in flight. Only a disagreement that
    // persists over two heartbeats with nothing queued means something was lost: resend then.
    if (++p.digestMisses >= 2) { p.digestMisses = 0; sendAll(peerIndex, nowMs, false); }
  }
}

void SyncEngine::handleState(int peerIndex, const Message &m, uint32_t nowMs) {
  SyncPeer &p = _peers[peerIndex];
  if (seen(p, m.msgId)) { _stats.duplicates++; sendAck(p, Type::StateAck, m.msgId); return; }
  const SyncStore::Apply result = _store.applyRemote(m.entry);
  sendAck(p, Type::StateAck, m.msgId);
  switch (result) {
    case SyncStore::Apply::Applied: {
      _storeDirty = true;
      const SyncEntry *stored = _store.find(m.entry.key);
      StateChange change{stored, true, stored->writer};
      _listener.onState(change);
      for (size_t i = 0; i < MAX_PEERS; ++i) {
        if (int(i) == peerIndex || !_peers[i].used || !_peers[i].confirmed) continue;
        enqueueState(int(i), *stored, nowMs);
        _stats.forwarded++;
      }
      break;
    }
    case SyncStore::Apply::Duplicate:
      _stats.duplicates++;
      break;
    case SyncStore::Apply::Stale: {
      _stats.stale++;
      const SyncEntry *local = _store.find(m.entry.key);
      if (local) enqueueState(peerIndex, *local, nowMs);
      break;
    }
    default:
      _stats.rejected++;
      break;
  }
}

void SyncEngine::handleEvent(int peerIndex, const Message &m, uint32_t nowMs) {
  SyncPeer &p = _peers[peerIndex];
  if (seen(p, m.msgId)) { _stats.duplicates++; sendAck(p, Type::EventAck, m.msgId); return; }
  sendAck(p, Type::EventAck, m.msgId);
  EventInfo info{m.name, m.payload, p.mac, true};
  _listener.onEvent(info);
  for (size_t i = 0; i < MAX_PEERS; ++i) {
    if (int(i) == peerIndex || !_peers[i].used || !_peers[i].confirmed) continue;
    Message copy = m;
    enqueue(int(i), copy, nowMs);
    _stats.forwarded++;
  }
}

void SyncEngine::handleAck(int peerIndex, uint32_t ackOf, uint32_t nowMs) {
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) {
    Outgoing &o = _queue[i];
    if (!o.used || o.peer != peerIndex || o.msgId != ackOf) continue;
    memset(&o, 0, sizeof(Outgoing));
    _stats.acked++;
    _peers[peerIndex].lastAckMs = nowMs;
    return;
  }
}

void SyncEngine::sendResult(const uint8_t mac[6], bool ok, uint32_t nowMs) {
  if (ok) return;
  const int index = indexOf(mac);
  if (index < 0) return;
  // The radio reported no MAC-layer acknowledgment: retry sooner than the schedule says.
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) {
    Outgoing &o = _queue[i];
    if (o.used && o.peer == index && o.attempts > 0 && !due(nowMs, o.nextAtMs)) o.nextAtMs = nowMs + 50;
  }
}

void SyncEngine::forceHello() {
  for (size_t i = 0; i < MAX_PEERS; ++i) if (_peers[i].used && _peers[i].confirmed) _peers[i].lastTxMs = 0;
}

// ---- tick ------------------------------------------------------------------------------------

void SyncEngine::tick(uint32_t nowMs) {
  for (size_t i = 0; i < MAX_PEERS; ++i) {
    SyncPeer &p = _peers[i];
    if (!p.used) continue;
    if (!p.confirmed) {
      if (!_paused && due(nowMs, p.nextPairMs)) sendPairReq(p, nowMs);
      continue;
    }
    if (p.state == PeerState::Connected && nowMs - p.lastRxMs > CONNECT_TIMEOUT_MS) {
      const PeerState previous = p.state;
      p.state = PeerState::Offline;
      _listener.onPeer(p, previous);
    }
    if (!_paused && (p.lastTxMs == 0 || nowMs - p.lastTxMs >= HELLO_INTERVAL_MS)) sendHello(p, nowMs, false, 0);
  }
  if (_paused) return;
  for (size_t i = 0; i < QUEUE_DEPTH; ++i) {
    Outgoing &o = _queue[i];
    if (!o.used || !due(nowMs, o.nextAtMs)) continue;
    if (o.attempts >= MAX_ATTEMPTS) { memset(&o, 0, sizeof(Outgoing)); _stats.dropped++; continue; }
    SyncPeer &p = _peers[o.peer];
    if (!p.used) { memset(&o, 0, sizeof(Outgoing)); continue; }
    _transport.send(p.mac, o.type, o.body, o.len);
    o.attempts++;
    _stats.sent++;
    if (o.attempts > 1) _stats.retries++;
    o.nextAtMs = nowMs + (RETRY_BASE_MS << (o.attempts - 1));
    p.lastTxMs = nowMs;
  }
}

}  // namespace syncproto
}  // namespace atech
