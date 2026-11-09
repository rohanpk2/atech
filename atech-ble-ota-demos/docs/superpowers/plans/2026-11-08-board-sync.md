# AtechSync Board-to-Board Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Atech ESP32-S3 boards keep a generic key-value state and discrete events in agreement over ESP-NOW, pair through the serial console, the Bluetooth setup session or the backend, and show one shared boolean `demo.power` on their LEDs and in both dashboards.

**Architecture:** A portable C++17 engine (`SyncCodec`, `SyncStore`, `SyncEngine`, no Arduino) owns the wire format, the per-key `(revision, writer)` versioning, acknowledgments and retries, duplicate suppression, heartbeats, pairing and reconciliation, and is tested on the host with two engines on a lossy bus. An ESP32 wrapper (`AtechSync`) adds ESP-NOW, AES-128-GCM sealing, NVS, FreeRTOS queues, the application API, a BLE status service, a serial console and the command hooks the existing Bluetooth setup, LAN and cloud paths use. The backend relays commands (LAN now, cloud poll otherwise), simulates boards on an in-process bus, and the shared dashboard module gains a "Board connections" block.

**Tech Stack:** PlatformIO `espressif32 @ 8.0.0` / Arduino-ESP32 3.x (`esp_now.h`, `esp_wifi.h`, `mbedtls/gcm.h`, `Preferences`, FreeRTOS), host `clang++ -std=c++17` for engine tests, Node 20+ (`node:test`, jsdom), vanilla browser JS.

**Spec:** `docs/superpowers/specs/2026-11-08-board-sync-design.md`

## Global Constraints

- No commits in this session: the owner reviews the working tree and commits. Each task still ends with its tests green.
- No em dashes (U+2014) in any file touched (structure tests enforce it).
- Every `$('id')` referenced by `web-shared/atech-builder.js` exists in both `index.html` files and in `KNOWN_IDS` of `web-shared/atech-builder.test.js`. New ids: `syncPanel`, `syncBadge`, `syncState`, `syncSelf`, `syncPeer`, `syncLink`, `syncValue`, `syncToggle`, `syncConnect`, `syncCode`, `syncPairInput`, `syncPair`, `syncUnpair`, `syncHint`.
- Wire limits: frame 250 bytes, header 17 bytes (`0xA7 0x53`, version `1`, type, flags, 12-byte IV), tag 16, body at most 217; key 1..32, value 0..96, event name 1..32, payload 0..96; 16 keys, 4 peers, outgoing queue 12, dedupe ring 16 ids per peer.
- Timings: retries 5 attempts, 150 ms doubling (150, 300, 600, 1200, 2400); HELLO every 3000 ms; connected = frame in the last 8000 ms; pairing window 600000 ms; PAIR_REQ every 1000 ms, 20 fast attempts then every 10000 ms; hop after 15000 ms silence, 2000 ms per channel 1..13; persist debounce 2000 ms.
- Version rule: higher revision wins; equal revisions, the numerically larger writer MAC wins (`memcmp` order); equal pair is a duplicate.
- Pairing code: `ATSYNC1-<12 uppercase hex MAC>-<2 hex channel>-<32 lowercase hex key>`.
- Canonical LAN HMAC message: `atech-sync/1\n<device id>\n<nonce lowercase hex>\n<form body>\n`, keyed with the board's pairing token, hex lowercase.
- Bluetooth setup opcode `OP_SYNC = 0x05`; pairing ops (`code`, `pair`, `unpair`) need `authorized(grant)`, `set`/`event`/`toggle` do not.
- GATT: service `a7ec0300-2e47-4dd2-82a4-9c2cf6eaa001`, status `a7ec0301-...` (read), change `a7ec0302-...` (notify).
- NVS namespace `atech_sync`, keys `peers` (blob) and `state` (blob).
- Versions: `ATECH_CORE_VERSION` `1.3.0` (core.test.js and agent.test.js both pin it), AtechWifiLan `1.2.0`, AtechBleProv `1.1.0`, AtechSync `1.0.0`.
- Generated-code policy: `atech::sync::` stays allowed; `AtechSync` is added to the forbidden core-library name list only as the header `AtechSync.h` (the app header `AtechSyncApp.h` is reached through `AtechApp.h`).
- Nothing is claimed as hardware-verified; one board exists on this machine.

## Review Focus

1. A STATE frame whose `(revision, writer)` is older than the local entry must be acknowledged and answered with the newer local STATE, never applied, so a board returning from a partition with stale writes converges instead of overwriting (Task 2 test `stale remote state is answered with the newer local entry`).
2. Two boards that write the same key while disconnected and then reconnect must end with identical values and the documented winner, with no further traffic once both ACKed (Task 2 test `simultaneous conflicting writes converge with the MAC tie-breaker`).
3. A frame from an unknown MAC while no pairing window is open, or one that fails authentication, must be dropped and counted, never parsed (Task 3 structure test `unknown senders are dropped before decoding` and Task 2 codec tests for malformed bodies).
4. The dashboard must never show "Connected" for a board whose status says `paired` but not `connected`, including right after pairing while the peer has not answered (Task 6 test `paired but silent board is shown as not communicating`).
5. A cloud-queued command for an offline board must not be reported as applied; the dashboard says "queued" until the board's next report carries the result (Task 5 test `cloud sync command is queued and delivered in the poll` and Task 6 test `cloud board commands show as queued`).

---

### Task 1: Portable codec and state store with host tests

**Files:**
- Create: `shared/AtechSync/library.json`, `shared/AtechSync/src/SyncTypes.h`, `shared/AtechSync/src/SyncCodec.h`, `shared/AtechSync/src/SyncCodec.cpp`, `shared/AtechSync/src/SyncStore.h`, `shared/AtechSync/src/SyncStore.cpp`
- Create: `shared/AtechSync/test/host/check.h` (tiny assert macros, counts failures), `shared/AtechSync/test/host/codec_store_test.cpp`, `shared/AtechSync/sync.test.js` (compiles and runs every `test/host/*_test.cpp` with `clang++ -std=c++17 -Wall -Wextra -I src`, skips with a message when no compiler is on PATH)

**Interfaces:**
- Produces `SyncTypes.h`, namespace `atech::syncproto`: the constants from Global Constraints (`PROTOCOL = 1`, `MAX_FRAME = 250`, `HEADER = 17`, `TAG = 16`, `MAX_BODY = 217`, `MAX_KEY = 32`, `MAX_VALUE = 96`, `MAX_NAME = 32`, `MAX_PAYLOAD = 96`, `MAX_KEYS = 16`, `MAX_PEERS = 4`, `QUEUE_DEPTH = 12`, `DEDUPE = 16`, timing constants), `enum class Type : uint8_t {Hello = 1, HelloAck, State, StateAck, Event, EventAck, SyncReq, PairReq, PairAck, Unpair}`, `enum class ValueType : uint8_t {Bool = 1, Int, Float, String, Json}`, `struct SyncEntry {char key[33]; ValueType type; char value[97]; uint32_t revision; uint8_t writer[6];}`, `int compareVersion(uint32_t revA, const uint8_t *writerA, uint32_t revB, const uint8_t *writerB)` (negative, zero, positive), `const char *valueTypeName(ValueType)`, `bool parseValueType(const char *, ValueType &)`.
- Produces `SyncCodec.h`: `struct Message { Type type; uint32_t msgId; uint32_t ackOf; uint8_t protocol; uint8_t channel; uint32_t uptimeMs; uint8_t flags; uint8_t stateCount; uint32_t stateDigest; SyncEntry entry; char name[33]; char payload[97]; uint8_t nonce[8]; }`; `size_t encode(const Message &, uint8_t *out, size_t cap)` (0 on failure); `bool decode(Type type, const uint8_t *body, size_t len, Message &out)` (false on any length or limit violation, trailing bytes, zero-length key or name, unknown value type).
- Produces `SyncStore.h`: `class SyncStore` with `bool setLocal(const char *key, ValueType type, const char *value, const uint8_t writer[6], SyncEntry *result)`, `enum class Apply {Applied, Duplicate, Stale, Rejected}`, `Apply applyRemote(const SyncEntry &incoming)`, `const SyncEntry *find(const char *key) const`, `size_t count() const`, `const SyncEntry *at(size_t) const`, `uint32_t digest() const` (XOR of per-entry FNV-1a over key, revision, writer: order independent), `size_t serialize(uint8_t *out, size_t cap) const`, `bool deserialize(const uint8_t *in, size_t len)`, `static bool validKey(const char *)`, `static bool validValue(ValueType, const char *)` (bool: `true`/`false`; int: optional sign and digits within int32; float: `strtod` consumes all; string and json: length only, json must start with `{` or `[`).

- [ ] **Step 1: Write `codec_store_test.cpp`** with these tests (one function each, run from `main`, exit code = failures):
  - `encode_decode_state_round_trip`: STATE with key `demo.power`, Bool `true`, revision 12, writer `A1:B2:C3:D4:E5:F6`, msgId 102 decodes identical.
  - `encode_rejects_oversized`: key of 33 chars returns 0; value of 97 bytes returns 0; event payload of 97 returns 0.
  - `decode_rejects_malformed`: STATE body truncated by one byte is false; keyLen 0 is false; valueType 9 is false; a body with one trailing byte is false; HELLO with 3 bytes is false.
  - `every_type_round_trips`: Hello, HelloAck (ackOf 7), Event (`button.pressed`, payload `""`), SyncReq, PairReq (nonce 1..8, channel 6), PairAck, Unpair, StateAck.
  - `set_local_increments_known_revision`: fresh key gets revision 1 and the writer; applying remote revision 5 then setLocal yields revision 6.
  - `apply_remote_orders_by_revision_then_mac`: remote rev 2 beats local rev 1; same rev with larger MAC beats; same rev smaller MAC is Stale; identical pair is Duplicate; `compareVersion` sign matches.
  - `store_limits`: 17th key is rejected by setLocal (false) and by applyRemote (Rejected); invalid key with a space is Rejected.
  - `digest_is_order_independent_and_changes`: two stores filled in different orders agree; a revision bump changes it.
  - `serialize_round_trip`: three entries survive serialize/deserialize; a truncated blob returns false and leaves the store empty; a blob declaring 40 entries returns false.
  - `valid_value_rules`: `true`/`False` handling (`False` rejected), `-12`, `3.5`, `{"a":1}`, `abc` as json rejected.

- [ ] **Step 2: Write `sync.test.js`**: find `clang++` or `c++` with `which`; compile each `test/host/*_test.cpp` plus `src/SyncCodec.cpp src/SyncStore.cpp src/SyncEngine.cpp` (skip engine file if missing) into `os.tmpdir()`; run; fail the script on non-zero exit; print `AtechSync host tests passed` or `skipped: no C++ compiler`. Run: `node shared/AtechSync/sync.test.js`. Expected: compile error (headers missing).

- [ ] **Step 3: Implement `SyncTypes.h`, `SyncCodec.cpp`, `SyncStore.cpp`** per Interfaces. Encoding is little-endian with explicit byte writes (no struct casts). `library.json` mirrors `AtechBleProv/library.json` with name `AtechSync`, version `1.0.0`, no dependencies.

- [ ] **Step 4: Run** `node shared/AtechSync/sync.test.js`. Expected: `AtechSync host tests passed`.

### Task 2: Portable engine: peers, pairing, acks, retries, dedupe, heartbeat, reconciliation

**Files:**
- Create: `shared/AtechSync/src/SyncEngine.h`, `shared/AtechSync/src/SyncEngine.cpp`, `shared/AtechSync/test/host/engine_test.cpp`, `shared/AtechSync/test/host/fake_bus.h` (two or three engines, per-direction loss function, delivery queue drained by `pump(nowMs)`, records every frame type)

**Interfaces:**
- Consumes Task 1.
- Produces `SyncEngine.h`:
  - `class SyncTransport { virtual bool send(const uint8_t mac[6], Type type, const uint8_t *body, size_t len) = 0; }` (the wrapper seals and transmits).
  - `struct StateChange { const SyncEntry *entry; bool remote; }`, `struct EventInfo { const char *name; const char *payload; const uint8_t *source; bool remote; }`.
  - `enum class PeerState : uint8_t {None, Pairing, Offline, Connected}`; `struct SyncPeer { bool used; uint8_t mac[6]; uint8_t key[16]; uint8_t channel; bool confirmed; PeerState state; uint32_t lastRxMs, lastAckMs, lastTxMs, nextPairMs; uint8_t pairAttempts; uint32_t dedupe[16]; uint8_t dedupeAt; }`.
  - `class SyncListener { virtual void onState(const StateChange &) {} virtual void onEvent(const EventInfo &) {} virtual void onPeer(const SyncPeer &, PeerState previous) {} virtual void onPeersChanged() {} virtual void onLog(const char *) {} }`.
  - `struct SyncStats { uint32_t sent, acked, retries, dropped, received, duplicates, stale, rejected, forwarded; }`.
  - `class SyncEngine { SyncEngine(SyncTransport &, SyncListener &); void begin(const uint8_t mac[6], uint32_t nowMs, uint32_t seed); void setChannel(uint8_t); uint8_t channel() const; void setPaused(bool); bool paused() const; bool set(const char *key, ValueType, const char *value, uint32_t nowMs); const SyncEntry *get(const char *key) const; bool emit(const char *name, const char *payload, uint32_t nowMs); SyncStore &store(); void openPairing(const uint8_t key[16], uint32_t nowMs); void closePairing(); bool pairingOpen(uint32_t nowMs) const; const uint8_t *pairingKey() const; bool pairWith(const uint8_t mac[6], const uint8_t key[16], uint8_t channel, uint32_t nowMs); bool unpair(const uint8_t mac[6], uint32_t nowMs); bool unpairAll(uint32_t nowMs); bool addStoredPeer(const uint8_t mac[6], const uint8_t key[16], uint8_t channel, bool confirmed); const SyncPeer *peer(size_t i) const; const SyncPeer *peerFor(const uint8_t mac[6]) const; size_t peerCount() const; bool anyConnected() const; void receive(const uint8_t mac[6], Type type, const uint8_t *body, size_t len, uint32_t nowMs); void sendResult(const uint8_t mac[6], bool ok, uint32_t nowMs); void tick(uint32_t nowMs); bool storeDirty() const; void storePersisted(); const SyncStats &stats() const; size_t queued() const; }`.
- Behaviour fixed by the spec and tests: a local `set` notifies the listener (remote = false), enqueues one STATE per connected or offline (confirmed) peer, replacing a queued STATE for the same key; remote STATE Applied notifies and is forwarded to every other confirmed peer; Stale answers with the local entry; every STATE/EVENT received is acknowledged exactly once per arrival; dedupe by `(peer, msgId)`; HELLO/HELLO_ACK carry `store.count()` and `store.digest()` and trigger `sendAll(peer)` when digests differ at (re)connection; PAIR_REQ from an unknown MAC while the window is open adds the peer (Connected, confirmed) with the pairing key, answers PAIR_ACK and closes the window; PAIR_ACK or any frame from a Pairing peer sets confirmed and Connected; UNPAIR removes the peer and notifies; `tick` sends due retries, drops after 5 attempts (`stats.dropped`), sends HELLO when `now - lastTxMs >= 3000`, moves a Connected peer to Offline after 8000 ms without a frame, sends PAIR_REQ for Pairing peers on schedule; `setPaused(true)` suppresses everything but ACKs.

- [ ] **Step 1: Write `engine_test.cpp`** with the bus from `fake_bus.h` (`Bus bus; Node a(bus, macA), b(bus, macB)`; `bus.run(untilMs, stepMs)` ticks both engines and delivers frames):
  - `pairing_handshake_both_sides_store_peer`: A `openPairing(key)`, B `pairWith(macA, key, 1)`; after `run(3000)` both `peerFor` the other, both `confirmed`, both `Connected`, A's window closed, bus saw exactly one PAIR_ACK.
  - `local_set_reaches_peer_and_notifies_both`: after pairing, A sets `demo.power` Bool `true`; B's listener got one remote change with value `true`, revision 1, writer macA; A's listener got one local change; `stats.acked` on A is 1 after `run`.
  - `bidirectional_updates`: B sets `counter` Int `5`; A has it; A sets `counter` `6`; B has `6` with revision 2.
  - `duplicate_frames_apply_once`: bus duplicates every STATE from A; B's listener counts exactly one change; A gets two ACKs without error.
  - `lost_acks_retry_with_backoff`: bus drops the first two STATE frames A to B; the frame arrives on attempt 3; `stats.retries == 2`; delivery times grow 150 then 300 ms apart (within one step).
  - `exhausted_retries_drop_and_report`: bus drops all STATE frames A to B; after `run(6000)` `stats.dropped == 1`, `queued() == 0`, and B shows no change.
  - `stale_remote_state_is_answered_with_the_newer_local_entry`: partition the bus; A sets `k` to `1`; B sets `k` to `2` then `3` (B revision 2); reconnect; both end with `3` from writer macB; A's listener saw the remote `3`; no STATE frames in flight after 3 s of silence.
  - `simultaneous_conflicting_writes_converge_with_the_mac_tie_breaker`: partition; A sets `k` `a`, B sets `k` `b` (both revision 1); reconnect; both hold the value written by the larger MAC; the loser's listener saw exactly one remote change.
  - `disconnect_and_reconnect_reconciles`: pair, set two keys, cut the bus for 10 s (both peers Offline, `onPeer` fired), B sets a third key while cut, restore; within 5 s both Connected and A has the third key; digest equal.
  - `reboot_restores_state_and_peer`: serialize A's store and peer; construct a new engine A2 with `addStoredPeer` and `deserialize`; A2 sets `k` and reaches B with revision old+1; B's view of A2 is Connected within one HELLO.
  - `events_are_delivered_once_and_acked`: A emits `button.pressed` with payload `x`; B gets exactly one event (remote, source macA); a duplicated frame does not repeat it.
  - `rapid_toggles_coalesce`: with the bus paused, A sets `demo.power` 20 times; `queued() == 1`; after resume B holds the last value and `stats.sent <= 6`.
  - `unknown_mac_is_ignored_unless_pairing`: `receive` of a valid STATE body from an unknown MAC changes nothing and counts `rejected`.
  - `malformed_bodies_are_rejected`: STATE body of 3 bytes, EVENT with nameLen 40, PairReq of 1 byte each count `rejected` and leave the store untouched.
  - `unpair_removes_peer_on_both_sides`: A `unpairAll`; after `run(1000)` B has no peer and its `onPeer` saw `None`.
  - `paused_engine_sends_only_acks`: A paused; B sets `k`; A applies and ACKs; A's own set while paused stays queued (`queued() == 1`) and flushes after `setPaused(false)`.
  - `three_peers_forward_through_the_hub`: A paired with B and with C; B sets `k`; C receives it (forwarded by A, `stats.forwarded == 1` on A); B does not receive it back.

- [ ] **Step 2: Run** `node shared/AtechSync/sync.test.js`. Expected: compile failure (`SyncEngine.h` missing).

- [ ] **Step 3: Implement `SyncEngine.cpp`.** Outgoing queue entries: `{used, peerIndex, Type, msgId, attempts, nextAtMs, uint8_t body[217], uint8_t len, char key[33]}`. Message ids: `seed | 1`, incremented per send. HELLO `flags` bit0 = just booted (set in `begin`, cleared after the first HELLO_ACK). Pairing nonce: the low 8 bytes of the msgId counter mixed with the seed.

- [ ] **Step 4: Run** `node shared/AtechSync/sync.test.js`. Expected: `AtechSync host tests passed`.

### Task 3: ESP32 wrapper, application API, core hook, radio hold

**Files:**
- Create: `shared/AtechSync/src/AtechSync.h`, `shared/AtechSync/src/AtechSync.cpp`, `shared/AtechSync/src/AtechSyncApp.h`, `shared/AtechSync/wiring.test.js`
- Modify: `shared/AtechCore/src/AtechCore.h` (declare `void coreSetAppIdleHook(void (*hook)())`), `shared/AtechCore/src/AtechCore.cpp` (call the hook in `appTaskMain` after `appLoop()`; `ATECH_CORE_VERSION` `1.3.0`; `library.json` 1.3.0), `shared/AtechCore/src/AtechApp.h` (add `#include "AtechSyncApp.h"` after `AtechAppApi.h`), `shared/AtechWifiLan/src/AtechWifiLan.h` (`void setRadioHold(bool hold); bool radioHeld() const;`), `shared/AtechWifiLan/src/AtechWifiLan.cpp` (`applyMode()` chooses `WIFI_STA` when `stationWanted || radioHold`; `setRadioHold` calls `applyMode()` and `WiFi.setSleep(false)`; `library.json` 1.2.0), `shared/AtechCore/core.test.js` and `shared/AtechCloudOta/agent.test.js` (version `1.3.0`, hook present)

**Interfaces:**
- Consumes Task 2 (`SyncEngine`, `SyncTransport`, `SyncListener`).
- Produces `AtechSync.h`:
  - `struct AtechSyncConfig { BLEServer *server; AtechWifiLan *lan; bool (*otaBusy)(); const char *preferencesNamespace; bool serialConsole; }`.
  - `struct AtechSyncResult { bool ok; String error; String code; }`.
  - `class AtechSync { bool begin(const AtechSyncConfig &); void loop(); AtechSyncResult command(const String &form, bool privileged); String statusJson(); String compactStatusJson(); bool handleSerialLine(const String &line); bool isPaired() const; bool isConnected() const; bool emitEvent(const char *name, const char *payload = ""); const String &lastError() const; }`.
  - `command()` form fields: `op` in `code|pair|unpair|set|toggle|event|status`; `code` (pairing code for `pair`), `key`, `value`, `type` (optional, else inferred: `true`/`false` Bool, integer Int, decimal Float, `{`/`[` Json, else String), `name`, `payload`. `privileged == false` refuses `code`, `pair`, `unpair` with error `Pairing changes need an authorized connection`.
  - `statusJson()` keys: `id`, `mac`, `channel`, `wifi` (station connected), `paused`, `pairingOpen`, `pairingCode` (while open), `paired`, `connected`, `peer`, `peerState` (`none|pairing|offline|connected`), `peerChannel`, `channelMismatch`, `lastAckAgoMs`, `lastSeenAgoMs`, `peers` (array of `{id, state, confirmed, channel}`), `state` (object key -> `{v, t, rev, by}`), `stats`, `queued`.
  - `compactStatusJson()`: `{paired, connected, peer, peerState, code, state:{key: value text}}` for the cloud poll.
- Produces `AtechSyncApp.h`, namespace `atech::sync`: the API from the spec (`setBool/getBool/setInt/getInt/setFloat/getFloat/setString/getString/setJson/getJson/has/emit/onChange/onEvent/wait/peerConnected/paired/peerId`), `struct StateChange { const char *key; const char *type; const char *value; uint32_t revision; const char *writer; bool remote; }`, `struct Event { const char *name; const char *payload; const char *source; bool remote; }`.
- ESP32 behaviour fixed: ESP-NOW callbacks copy into a FreeRTOS queue (`struct Rx {uint8_t kind; uint8_t mac[6]; uint8_t len; uint8_t data[250];}`, depth 12); `loop()` drains it, unseals with the peer key or, for an unknown MAC while `pairingOpen`, the pairing key (otherwise drop and count), calls `engine.receive`, then `engine.tick`, then flushes persistence (`peers` blob when `onPeersChanged`, `state` blob when `storeDirty()` and 2000 ms passed), then updates the channel policy, then sends pending BLE change notifications, then reads the serial console. All engine calls hold one recursive mutex. The transport builds the 17-byte header, seals with `mbedtls_gcm_crypt_and_tag` (AES-128, IV = 4 boot bytes from `esp_fill_random` + 8-byte counter, AAD = header), adds the ESP-NOW peer if missing (`channel 0`, `WIFI_IF_STA`, `encrypt false`), `esp_now_send`. Application notifications go through a second queue (depth 16) drained on the app task by `atech::sync::wait()` and the core idle hook.

- [ ] **Step 1: Write `wiring.test.js`** (structure, like `prov.test.js`): asserts the UUIDs `a7ec0300/0301/0302`, `esp_now_init`, `esp_now_register_recv_cb`, `esp_now_register_send_cb`, `esp_now_add_peer`, `esp_now_send`, `esp_wifi_set_channel`, `mbedtls_gcm_setkey`, `mbedtls_gcm_auth_decrypt`, `mbedtls_gcm_crypt_and_tag`, `esp_fill_random`, `xQueueSendFromISR` absent and `xQueueSend` present in the ESP-NOW callbacks, `"atech_sync"`, `"peers"`, `"state"`, `xSemaphoreCreateRecursiveMutex`, the title `unknown senders are dropped before decoding`: the receive path checks `engine.peerFor(` or `pairingOpen(` before `unseal(`; `coreSetAppIdleHook` declared in the core header and called in the core; `setRadioHold` declared and `radioHold` used in `applyMode`; `AtechApp.h` includes `AtechSyncApp.h`; every `Serial.print` line in `AtechSync.cpp` that mentions `key` does not print `hexEncode(peer.key` (the pairing key appears only inside the pairing code the user asked for).

- [ ] **Step 2: Run** `node shared/AtechSync/wiring.test.js`. Expected: fails on missing files.

- [ ] **Step 3: Implement the core hook, the radio hold and `AtechSync.cpp` / `AtechSyncApp.h`.** Channel policy in `loop()`: if `lan && lan->isConnected()` or the Wi-Fi mode has the AP bit, never set the channel, only record `channelMismatch = peerChannel && peerChannel != channel`; else if a peer is confirmed and not connected for 15000 ms, hop every 2000 ms through 1..13 with `esp_wifi_set_channel`, else stay on the stored peer channel; when a HELLO arrives from a connected peer, store its channel.
  Serial console: lines starting with `sync` (`help`, `status`, `code`, `pair <code>`, `unpair`, `set <key> <value>`, `toggle <key>`, `get <key>`, `event <name> [payload]`), results printed with the `[sync]` prefix; `status` prints the JSON.

- [ ] **Step 4: Run** `node shared/AtechSync/wiring.test.js && node shared/AtechCore/core.test.js && node shared/AtechCloudOta/agent.test.js`. Expected: all three pass. (Compilation is verified in Task 4 once a demo links the library.)

### Task 4: Firmware wiring in both demos, the hooks, the demo app, the prompt

**Files:**
- Modify: `shared/AtechBleProv/src/AtechBleProv.h` (`AtechSync *sync;` in the config), `shared/AtechBleProv/src/AtechBleProv.cpp` (`OP_SYNC = 0x05`, `sync(body, length)` handler: unseal, `formGet` `op`, pairing ops need `authorized(grant)`, call `config.sync->command(plain, authorized)`, sealed reply `ok=1[&code=...]` or `ok=0&error=`; `library.json` 1.1.0)
- Modify: `shared/AtechWifiLan/src/AtechWifiLan.h` (`String (*syncCommand)(const String &form); String (*syncIdentity)();` in the config), `shared/AtechWifiLan/src/AtechWifiLan.cpp` (route `{"/api/sync", HTTP_POST, handleSync, this}`, `max_uri_handlers` 12, message `atech-sync/1\n...`, body read up to 1024 bytes, answers `syncCommand(body)` JSON or 503 when unset; `identityJson()` appends `,"sync":` + `syncIdentity()` when set)
- Modify: `shared/AtechCloudOta/src/AtechCloudOta.h` (`String (*extraReport)(); void (*command)(const String &form);`), `shared/AtechCloudOta/src/AtechCloudOta.cpp` (`identityFields()` appends `&sync=` + `formEncode(extraReport())` when set; `poll()` reads `kvGet(response, "sync")` and calls `config.command(percentDecode(value))` when non-empty, before the job)
- Modify: `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp` (include `<AtechSync.h>`; `AtechSync boardSync;`; `handleShortPress()` also calls `boardSync.emitEvent("button.pressed")`; `lanConfig.syncCommand = syncCommandJson; lanConfig.syncIdentity = syncIdentity;` `cloudConfig.extraReport = syncReport; cloudConfig.command = syncCloudCommand;` `provConfig.sync = &boardSync;` `boardSync.begin(syncConfig)` after `wifiLan.begin` and before `cloudOta.begin`; `boardSync.loop()` in `loop()`)
- Modify: `demo1-custom-gatt/src/app/user_app.cpp`, `demo2-bleota-library/src/app/user_app.cpp` (the demo app: `demo.power` false keeps the stock blink, true is solid warm white `led.set(40, 30, 18)`; `onEvent` toggles on local `button.pressed` only; `onChange` logs key, value, origin; `appLoop` renders and calls `atech::sync::wait(...)` for the blink timing)
- Modify: `builder/prompts/system.md` (one paragraph: shared state and events through `atech::sync::*`, callbacks on the app task, `wait()`), `builder/lib/source-policy.js` (forbidden header `AtechSync.h` via the include allow-list only; no regex change needed beyond adding `Sync` to the core-library name list while keeping `atech::sync::` allowed: the pattern becomes `\bAtech(BleProv|CloudOta|WifiLan|WifiOta|Core|ImageSink|Sync)\b(?!App)`), `builder/test/source-policy.test.js` (allowed `atech::sync::setBool`, forbidden `AtechSync x;`)
- Modify: `shared/AtechBleProv/prov.test.js` (OP_SYNC present, `config.sync->command`), `demo2-bleota-library/firmware.test.js` (`boardSync.begin(`, `boardSync.loop()`), `shared/AtechSync/wiring.test.js` (both `main.cpp` contain `AtechSync boardSync;`, `boardSync.begin(`, `boardSync.loop()`, `emitEvent("button.pressed")`, `lanConfig.syncCommand`, `cloudConfig.command`, `provConfig.sync`; both `user_app.cpp` contain `atech::sync::onEvent`, `atech::sync::onChange`, `"demo.power"`; `AtechSync.cpp` does not contain `demo.power` or `led.`)

**Interfaces:**
- Consumes Task 3 (`AtechSync::command`, `statusJson`, `compactStatusJson`, `emitEvent`).
- Produces in `main.cpp`: `String syncCommandJson(const String &form)` (privileged: the LAN HMAC proves the owner) returning `{"ok":true,"code":"..."}` or `{"ok":false,"error":"..."}`; `String syncIdentity()` = `boardSync.statusJson()`; `String syncReport()` = `boardSync.compactStatusJson()`; `void syncCloudCommand(const String &form)` (privileged).

- [ ] **Step 1: Extend the structure tests** listed above and run them. Expected: failures naming the missing wiring.
- [ ] **Step 2: Implement the hooks, the wiring and the demo app.**
- [ ] **Step 3: Run** `for f in shared/*/*.test.js demo2-bleota-library/firmware.test.js; do node "$f" || exit 1; done` and `cd builder && node --test test/source-policy.test.js`. Expected: all pass.
- [ ] **Step 4: Compile** `cd demo1-custom-gatt && pio run -e base` and `cd demo2-bleota-library && pio run -e base`. Expected: `[SUCCESS]` with the `[atech] firmware.bin ... fits` line. Fix warnings that are errors under the project flags.

### Task 5: Backend relay, cloud queue, simulator

**Files:**
- Create: `builder/lib/fake-sync.js` (`createSyncBus({lossRate = 0, delayMs = 5})` with `attach(mac, node)`, `detach`, `send(from, to, message)`; `createFakeSync({id, bus, now})` with `status()`, `compact()`, `command(form, privileged)`, `set(key, value, type)`, `get(key)`, `onChange(fn)`, `start()`, `stop()`; mirrors the engine: revisions, tie-breaker, pairing code format, PAIR_REQ/ACK, HELLO every 3000 ms, connected after 8000 ms silence, full exchange on reconnect)
- Create: `builder/test/sync.test.js`
- Modify: `builder/lib/lan-auth.js` (`syncMessage({deviceId, nonce, body})`), `builder/lib/devices.js` (`async sync(id, form)`: challenge, `POST /api/sync` with `X-Atech-Device/Nonce/Auth`, body form; `summarizeIdentity` passes `sync: identity.sync || null`; `cloudIdentity` adds `sync: r.sync || null`), `builder/lib/cloud-devices.js` (`normalizeReport` adds `sync: parseSync(info.sync)` (JSON parse guarded, else null); `queueCommand(id, form, ttlMs = 600000)`, `takeCommand(id)` single slot, `pendingCommand(id)`), `builder/lib/cloud-routes.js` (poll answer adds `sync: cloud.takeCommand(deviceId) || ''`), `builder/server.js` (route `POST /api/devices/(ATECH-...)/sync`: body `{op, key, value, type, code, name, payload}` -> form; owner check; LAN when `devices.describe(id).via === 'lan'` -> `{ok, via: 'lan', result}`; cloud-registered -> `cloud.queueCommand` -> `202 {ok: true, via: 'cloud', queued: true, pollMs}`; else `409 {error: 'Board is not reachable right now'}`; `startSimulatedDevices` accepts repeated demos (`1,1`) with ids `ATECH-51D000000${index}E${demo}` and attaches every simulated board to one bus; `/api/health` lists simulated ids), `builder/lib/fake-device.js` (option `sync`; identity carries `sync: sync.compactIdentity()`; route `POST /api/sync` with `syncMessage` HMAC and `consumeNonce`), `builder/lib/fake-cloud-device.js` (option `sync`; `identityBody` adds `sync=` compact JSON; `step()` applies `kv.sync` through `sync.command(form, true)`), `builder/lib/fake-prov-board.js` (option `sync`; opcode 5: `authorized(grant)` for `code|pair|unpair`, replies `{ok, code}` or `{ok: false, error}`), `builder/test/cloud-server.test.js` (the `simulated boards` test keeps `started.length === 2` for `all`)

**Interfaces:**
- Produces HTTP: `POST /api/devices/:id/sync` as above; board `POST /api/sync` answers `{"ok":true,"code":"..."}`/`{"ok":false,"error":"..."}`; poll fields `sync=` both ways; `device.identity.sync` object `{paired, connected, peer, peerState, code, state}` for LAN and cloud boards alike.

- [ ] **Step 1: Write `builder/test/sync.test.js`**:
  - `sync message is canonical`: `syncMessage({deviceId: 'ATECH-A1B2C3D4E5F6', nonce: 'AB', body: 'op=code'})` equals `'atech-sync/1\nATECH-A1B2C3D4E5F6\nab\nop=code\n'`.
  - `two simulated boards pair through codes and converge`: bus, two fake-syncs; `a.command('op=code', true).code` matches `/^ATSYNC1-[0-9A-F]{12}-[0-9a-f]{2}-[0-9a-f]{32}$/`; `b.command('op=pair&code=...', true).ok`; within 3 s both `status().connected`; `a.set('demo.power', 'true', 'bool')`; B holds `true`; `b.command('op=toggle&key=demo.power')`; A holds `false`; conflicting writes while detached converge to the larger MAC's value; `command('op=pair', false)` is refused.
  - `LAN relay reaches a simulated board`: boot server with one fake device + fake-sync; `POST /api/devices/:id/sync {op:'code'}` returns `via 'lan'` and a code; wrong op returns 400; another user is 403.
  - `cloud sync command is queued and delivered in the poll`: cloud-registered fake cloud device with fake-sync; `POST ... {op:'set', key:'demo.power', value:'true'}` answers 202 `queued: true`; after the device polls, `devices.describe(id).identity.sync.state['demo.power'] === 'true'` and a second command replaces the first while undelivered.
  - `the prov reference board gates pairing ops`: locked board without grant -> `ok: false` mentioning locked; `op=set` works without grant; with grant `op=code` returns a code.
  - `simulated duplicate demos get distinct ids`: `startSimulatedDevices` with `simulatedDevices: '1,1'` yields two Demo 1 boards with different ids sharing one bus.

- [ ] **Step 2: Run** `cd builder && node --test test/sync.test.js`. Expected: failures (modules missing).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `cd builder && npm test`. Expected: all pass (2 skipped real-compile tests).

### Task 6: Browser: provisioning opcode, GATT status hook, Board connections block

**Files:**
- Modify: `web-shared/atech-provision.js` (`OPS.sync = 5`; `session.sync(payload)` sealed; `decodeForm` keeps `code`), `web-shared/atech-provision.test.js` (opcode 5, `sync(` exposed)
- Modify: `demo1-custom-gatt/web/app.js`, `demo2-bleota-library/web/app.js` (discover service `a7ec0300`: `transport.sync = {available(), readStatus(), subscribe(handler)}`; `optionalServices` adds `AtechSync.SERVICE`; cleared on disconnect), `web-shared/atech-sync.js` (new: UUIDs, `parseStatus`, `parseChange`, `CODE_PATTERN`, `storeCode/loadCode` on `sessionStorage` key `atechSyncCode`), both `index.html` (script tag before `atech-builder.js`; the block inside the step 1 card after `provPanel`), `web-shared/builder.css` (`.sync` block styles following `.prov`)
- Modify: `web-shared/atech-builder.js` (section `Board connections`: `syncSource()` -> `'ble'` when `transport.sync` is available and connected, else `'backend'` when the selected device's `identity.sync` exists, else null; `renderSync()`; `syncCommand(payload)` -> BLE through `provSession().sync()` with the owner grant for pairing ops like `joinWifi` does, else `POST /api/devices/:id/sync`; `connectAnotherBoard()` -> `op=code`, shows the code, `storeCode`; `pairStoredCode()`; `unpairBoard()` (arm and confirm); `toggleDemo()` -> `op=set key=demo.power value=!current`; polling: BLE status every `provPollMs` while the block is visible, change notifications applied at once; backend boards rely on `refreshDevices`), `web-shared/atech-builder.test.js` (`KNOWN_IDS` additions; `Board connections` copy; `/api/devices/${...}/sync` literal; `Not communicating` copy)
- Create: `builder/test/dashboard-sync.test.js` (jsdom, modelled on `dashboard-provision.test.js`, with a fake `transport.sync` and the fake prov board carrying a fake-sync)

**Interfaces:**
- Consumes Task 5 (`/api/devices/:id/sync`, `identity.sync`), Task 4 (GATT status JSON, OP_SYNC form).
- Copy fixed: badge `Not paired` (neutral), `Pairing` (working), `Paired, not communicating` (error), `Connected` (success); line `Last acknowledged <ago>`; button labels `Connect another board`, `Pair with <id>` / `Pair with this code`, `Unpair`, `Turn demo.power on|off`; cloud hint `Queued; the board picks it up within <poll> s.`

- [ ] **Step 1: Write `dashboard-sync.test.js`**:
  - `the block is hidden without a board and shown for a Bluetooth board with the sync service`.
  - `paired but silent board is shown as not communicating`: status `{paired: true, connected: false, peer: 'ATECH-...'}` -> badge `Paired, not communicating`, dot offline.
  - `connected board shows peer, last ack and the demo state, and toggles over Bluetooth`: click `syncToggle`; the fake board receives `op=set&key=demo.power&value=true`; a change notification updates `syncValue` without a poll.
  - `connect another board stores the code and the next board offers to pair with it`: click `syncConnect` on board A -> `syncCode` shows the code; boot a second dashboard with board B -> `syncPair` reads `Pair with ATECH-A1...`; click -> B receives `op=pair&code=...`.
  - `cloud board commands show as queued`: backend device via cloud; click toggle -> fetch called `POST /api/devices/:id/sync`; hint contains `Queued`.
  - `pairing ops on an owned board use the owner grant`: locked fake board; `syncConnect` asks `/api/devices/:id/provision-grant` and the board accepts.

- [ ] **Step 2: Run** `cd builder && node --test test/dashboard-sync.test.js`. Expected: fails (ids missing).
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `cd builder && npm test && node ../web-shared/atech-builder.test.js && node ../web-shared/atech-provision.test.js && node ../demo1-custom-gatt/web/dashboard.test.js && node ../demo2-bleota-library/web/dashboard.test.js`. Expected: all pass.

### Task 7: Documentation, full verification, builds

**Files:**
- Create: `BOARD_SYNC.md` (what it does, architecture, wire format, versioning rule, channel modes, pairing and authorization, security notes including why GCM instead of LMK, exact commands: build, flash both boards, pair over serial, pair over the dashboard, toggle, the manual two-board test procedure with expected serial lines, limitations and what was not verified)
- Modify: `README.md` (Parts table row for AtechSync, a "Two boards" paragraph, More list), `AI_FIRMWARE_BUILDER.md` (revert the stray `ins` typo; a line on `atech::sync`), `REFERENCE.md` (pointer), `.env.example` (`ATECH_SIMULATED_DEVICE=1,1` example)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run every test:** `cd builder && npm test`; `for f in ../shared/*/*.test.js ../web-shared/*.test.js ../demo1-custom-gatt/web/*.test.js ../demo2-bleota-library/web/*.test.js ../demo2-bleota-library/firmware.test.js; do node "$f" || exit 1; done`. Expected: all pass.
- [ ] **Step 3: Build** `pio run -e base -e updated -e ai` in both demo directories (background). Expected: six `[SUCCESS]` lines with the size check printed.
- [ ] **Step 4: Report** what changed, which files, what was tested, and the hardware-dependent limitations.
