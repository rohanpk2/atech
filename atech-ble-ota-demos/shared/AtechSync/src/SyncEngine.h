// SyncEngine.h: the transport-agnostic heart of AtechSync. It owns the versioned state store, the
// peers, the outgoing queue with acknowledgments and retries, duplicate suppression, heartbeats,
// the pairing handshake and reconciliation after a reconnection. It never touches a radio, a
// clock or storage: the owner feeds it time (`tick`), frames (`receive`) and persistence hooks,
// and it talks back through SyncTransport (send a plaintext body of a given type to a MAC; the
// ESP32 wrapper seals it) and SyncListener (state and event notifications, peer changes).
// Portable C++17; the host tests drive two or three engines over an in-memory bus.
#pragma once

#include "SyncCodec.h"
#include "SyncStore.h"

namespace atech {
namespace syncproto {

enum class PeerState : uint8_t { None = 0, Pairing = 1, Offline = 2, Connected = 3 };
const char *peerStateName(PeerState state);

struct SyncPeer {
  bool used;
  uint8_t mac[6];
  uint8_t key[KEY_BYTES];
  uint8_t channel;          // the peer's last reported channel (0 unknown)
  bool confirmed;           // the pairing handshake completed (or the peer was stored as confirmed)
  PeerState state;
  uint32_t lastRxMs;        // last authenticated frame from the peer
  uint32_t lastAckMs;       // last acknowledgment of one of our frames
  uint32_t lastTxMs;        // last frame we sent it (heartbeat pacing)
  uint32_t nextPairMs;      // next PAIR_REQ while Pairing
  uint32_t lastSyncAllMs;   // last full-table send (throttle)
  uint8_t pairAttempts;
  uint8_t digestMisses;     // consecutive HELLOs whose digest disagreed with nothing in flight
  uint8_t pairNonce[8];
  uint32_t dedupe[DEDUPE];  // recently seen message ids
  uint8_t dedupeAt;
  uint8_t dedupeCount;
};

struct StateChange {
  const SyncEntry *entry;
  bool remote;
  const uint8_t *source;    // MAC of the writer that produced this change (ours when local)
};

struct EventInfo {
  const char *name;
  const char *payload;
  const uint8_t *source;
  bool remote;
};

struct SyncStats {
  uint32_t sent;        // transmissions of queued STATE/EVENT frames (retries included)
  uint32_t acked;
  uint32_t retries;
  uint32_t dropped;     // queued frames abandoned after MAX_ATTEMPTS, or refused by a full queue
  uint32_t received;    // authenticated, well-formed frames from known peers
  uint32_t duplicates;
  uint32_t stale;
  uint32_t rejected;    // malformed bodies, unknown senders, invalid entries
  uint32_t forwarded;
};

class SyncTransport {
public:
  virtual ~SyncTransport() {}
  virtual bool send(const uint8_t mac[6], Type type, const uint8_t *body, size_t len) = 0;
};

class SyncListener {
public:
  virtual ~SyncListener() {}
  virtual void onState(const StateChange &) {}
  virtual void onEvent(const EventInfo &) {}
  virtual void onPeer(const SyncPeer &, PeerState) {}   // state transitions; state None means removed
  virtual void onPeersChanged() {}                     // the peer table should be persisted
  virtual void onLog(const char *) {}
};

class SyncEngine {
public:
  SyncEngine(SyncTransport &transport, SyncListener &listener);

  void begin(const uint8_t mac[6], uint32_t nowMs, uint32_t seed);
  const uint8_t *mac() const { return _mac; }
  void setChannel(uint8_t channel) { _channel = channel; }
  uint8_t channel() const { return _channel; }
  // While paused (an OTA transport owns flash) nothing but acknowledgments leaves the board.
  void setPaused(bool paused) { _paused = paused; }
  bool paused() const { return _paused; }

  // ---- state and events (the owner serializes calls from several tasks) ----
  bool set(const char *key, ValueType type, const char *value, uint32_t nowMs);
  const SyncEntry *get(const char *key) const { return _store.find(key); }
  bool emit(const char *name, const char *payload, uint32_t nowMs);
  SyncStore &store() { return _store; }
  const SyncStore &store() const { return _store; }
  bool storeDirty() const { return _storeDirty; }
  void storePersisted() { _storeDirty = false; }

  // ---- pairing ----
  void openPairing(const uint8_t key[KEY_BYTES], uint32_t nowMs);
  void closePairing();
  bool pairingOpen(uint32_t nowMs) const;
  const uint8_t *pairingKey() const { return _pairingKey; }
  // The requesting side: store the peer from a pairing code and start sending PAIR_REQ.
  bool pairWith(const uint8_t mac[6], const uint8_t key[KEY_BYTES], uint8_t channel, uint32_t nowMs);
  bool unpair(const uint8_t mac[6], uint32_t nowMs);
  bool unpairAll(uint32_t nowMs);
  // Restores a persisted peer at boot (Offline when confirmed, Pairing otherwise).
  bool addStoredPeer(const uint8_t mac[6], const uint8_t key[KEY_BYTES], uint8_t channel, bool confirmed);

  const SyncPeer *peer(size_t index) const;       // index among used slots
  const SyncPeer *peerFor(const uint8_t mac[6]) const;
  size_t peerCount() const;
  bool anyConnected() const;

  // ---- transport ----
  void receive(const uint8_t mac[6], Type type, const uint8_t *body, size_t len, uint32_t nowMs);
  void sendResult(const uint8_t mac[6], bool ok, uint32_t nowMs);   // MAC-layer send status, optional
  void tick(uint32_t nowMs);
  // Makes the next tick send a HELLO to every confirmed peer (after a channel change).
  void forceHello();

  const SyncStats &stats() const { return _stats; }
  size_t queued() const;

private:
  struct Outgoing {
    bool used;
    uint8_t peer;
    Type type;
    uint32_t msgId;
    uint8_t attempts;
    uint32_t nextAtMs;
    uint8_t len;
    uint8_t body[MAX_BODY];
    char key[MAX_KEY + 1];   // STATE: coalescing key
  };

  int indexOf(const uint8_t mac[6]) const;
  int allocatePeer(const uint8_t mac[6]);
  void removePeer(int index, uint32_t nowMs, bool notifyPeer);
  uint32_t nextMsgId();
  void makeNonce(uint8_t out[8]);
  bool transmit(const uint8_t mac[6], Type type, const Message &m);
  void sendAck(SyncPeer &peer, Type ackType, uint32_t ackOf);
  void sendHello(SyncPeer &peer, uint32_t nowMs, bool ack, uint32_t ackOf);
  void sendPairReq(SyncPeer &peer, uint32_t nowMs);
  bool enqueue(int peerIndex, const Message &m, uint32_t nowMs);
  void enqueueState(int peerIndex, const SyncEntry &entry, uint32_t nowMs);
  void sendAll(int peerIndex, uint32_t nowMs, bool force);
  void dropQueueFor(int peerIndex);
  size_t queuedFor(int peerIndex) const;
  bool touch(SyncPeer &peer, uint32_t nowMs);
  bool seen(SyncPeer &peer, uint32_t msgId);
  void handlePairReq(const uint8_t mac[6], const Message &m, uint32_t nowMs);
  void handleHello(int peerIndex, const Message &m, bool justConnected, uint32_t nowMs);
  void handleState(int peerIndex, const Message &m, uint32_t nowMs);
  void handleEvent(int peerIndex, const Message &m, uint32_t nowMs);
  void handleAck(int peerIndex, uint32_t ackOf, uint32_t nowMs);
  void digestsDiffer(const Message &m, bool &differ) const;

  SyncTransport &_transport;
  SyncListener &_listener;
  SyncStore _store;
  SyncPeer _peers[MAX_PEERS];
  Outgoing _queue[QUEUE_DEPTH];
  SyncStats _stats;
  uint8_t _mac[6];
  uint8_t _channel;
  uint32_t _msgId;
  uint32_t _seed;
  uint32_t _bootMs;
  bool _justBooted;
  bool _paused;
  bool _storeDirty;
  bool _pairingOpen;
  uint32_t _pairingUntilMs;
  uint8_t _pairingKey[KEY_BYTES];
};

}  // namespace syncproto
}  // namespace atech
