# AtechSync: board-to-board state synchronization over ESP-NOW (design, 2026-11-08)

Status: the requester's written brief ("Implement Atech Board-to-Board Communication in Existing
Demo", ten numbered sections) is the approved design. Choices marked **(my call)** were made by
the builder after reading the repository and can be overridden.

## Intent

Two Atech ESP32-S3 boards running the existing Demo 1 or Demo 2 firmware keep a small key-value
state in agreement over ESP-NOW, with no router, backend or internet in the path. A change on one
board appears on the other within a fraction of a second; either board may change anything; a
rebooted board catches up; rapid changes never loop. The first application of it is one shared
boolean, `demo.power`, shown on the onboard LED and toggled from the BOOT button, the serial
console or the dashboard.

Everything that exists keeps working: Bluetooth OTA (Demo 1 custom GATT, Demo 2 gb88 BLEOTA),
Wi-Fi LAN OTA, cloud OTA, the hotspot portal, the Bluetooth Wi-Fi setup, claiming, the AI firmware
builder and both dashboards.

## Goals

1. A reusable, application-neutral firmware module `shared/AtechSync` (transport, state and
   event manager, pairing, persistence) with a tiny application API.
2. A working two-board demo: `demo.power` synchronized in both directions, surviving reboot,
   with the LED reflecting it on both boards.
3. Pairing that reaches real boards through channels that already exist: the serial console,
   the Bluetooth setup session (desktop Chrome) and the backend (LAN now, cloud poll later in
   this same change).
4. A "Board connections" block in both dashboards that distinguishes "paired (configured)" from
   "communicating (confirmed in the last few seconds)" and can toggle the demo state over a
   connection that actually exists.
5. Tests that exercise the real protocol logic (compiled C++ on the host), the backend and the
   dashboards; the PlatformIO environments of both demos build.

## Non-goals

- More than two boards in this iteration. The data structures allow several peers; the pairing
  flow, the dashboard and the tests handle one.
- A Wi-Fi/MQTT transport. The engine is transport-agnostic so one can be added later; none is.
- Production security. Pairing keys are random per pairing and traffic is encrypted and
  authenticated, but the dashboard key, the token and the unsigned firmware are unchanged
  prototype-grade (README).
- Claiming anything about radio behaviour that was not measured on two boards. Only one board
  was ever attached to this machine; the final report states what was and was not tested.

## Anti-goals

- A "connected" badge that merely means "paired once".
- The communication layer knowing about LEDs, buttons or `demo.power`.
- A cloud dependency for the local update path, or a dashboard button that works only in
  the simulator.
- An ESP-NOW channel assumption that silently fails when one board is on Wi-Fi and the other
  is not.

## Constraints discovered in the repository

- Toolchain: PlatformIO `espressif32 @ 8.0.0`, Arduino-ESP32 3.x (`NetworkClient` naming,
  `esp_now_recv_info_t`/`esp_now_send_info_t` callbacks, `ESP_NOW_MAX_DATA_LEN` 250).
  `~/.platformio/penv/bin/pio` is installed; host `clang++` is available for native tests.
- Radio ownership today: `AtechWifiLan` decides the Wi-Fi mode (`applyMode()`: STA when
  credentials exist, AP/AP+STA while the hotspot portal runs, otherwise OFF). ESP-NOW needs the
  Wi-Fi driver started, so the LAN module gains a third "wanted" input.
- BOOT (GPIO 0) is already a core button: a 3 s hold toggles the hotspot portal, a short press is
  reported through `AtechWifiOtaConfig.shortPress` and unlocks Bluetooth setup on an owned board.
  No other button exists on the DevKitC-1. The onboard NeoPixel (GPIO 48) is owned by the core
  and reached by apps through `atech::led`.
- Generated apps see only `AtechApp.h`; the backend's `source-policy.js` forbids the core
  libraries by name (`Atech(BleProv|CloudOta|WifiLan|WifiOta|Core|ImageSink)`), Wi-Fi, BLE, NVS,
  tasks. The checked-in `src/app/user_app.cpp` is also what the "stock" job compiles.
- Dashboard reach: the browser talks to a board over Web Bluetooth (desktop Chrome) or to the
  backend; the backend reaches LAN-paired boards over HTTP with HMAC control messages and is
  polled by cloud-registered boards every 15 s. The hosted dashboard (Vercel) never sees the
  user's LAN. Nothing reads the serial port from the browser.
- Tests: `node --test` in `builder/` (unit, HTTP, jsdom), per-demo and per-library structure
  tests run with `node <file>`. No em dashes anywhere (structure tests enforce it). Every
  `$('id')` used by `web-shared/atech-builder.js` must exist in both `index.html` files and in
  `KNOWN_IDS`.
- `AI_FIRMWARE_BUILDER.md` has an uncommitted stray edit (`ins# AI Firmware Builder`); it is a
  typo and is reverted as part of the doc update.

## Architecture

```
 app task            main loop task                 Wi-Fi task
 user_app.cpp        AtechSync (Arduino wrapper)     ESP-NOW callbacks
 atech::sync::*  <-> notification queue              recv/send status -> FreeRTOS queue
                     |  SyncEngine (portable C++)    |
                     |  codec, state store, LWW,     |
                     |  pairing, retries, heartbeat  |
                     |  <- plaintext frames ---------+  (AES-128-GCM seal/unseal in the wrapper)
                     |  -> send(mac, bytes)
                     NVS: peer, key, channel, state blob
                     BLE: a7ec0300 status (read) + change notify
                     Serial: "sync ..." commands
                     Hooks: AtechBleProv OP_SYNC (sealed, grant-gated pairing)
                            AtechWifiLan POST /api/sync (HMAC)  + "sync" in /api/identity
                            AtechCloudOta poll: sync= command in, sync= status out
```

### Layering (my call)

- `shared/AtechSync/src/SyncEngine.h/.cpp`: portable C++17, no Arduino. Owns the state store,
  events, peers, outgoing queue with retries, duplicate suppression, heartbeats, connection state,
  reconciliation and the pairing handshake. Talks to the outside through two small interfaces:
  `SyncTransport` (`send(mac, bytes, len)`, `now()`) and `SyncListener` (`onState`, `onEvent`,
  `onPeerChange`, `onPersist`, `onLog`). Compiles and runs on the host, so the protocol is tested
  with two engines joined by a lossy in-memory bus.
- `shared/AtechSync/src/AtechSync.h/.cpp`: the ESP32 wrapper. ESP-NOW init, peers and channel
  policy, AES-128-GCM with mbedtls, NVS, FreeRTOS queues and mutex, the status JSON, the BLE
  status service, the serial console, the hooks for BleProv/WifiLan/CloudOta, and the bridge to
  the application API.
- `shared/AtechSync/src/AtechSyncApp.h`: the application-facing API, included by `AtechApp.h`,
  shown to the model in the system prompt.

### Transport: ESP-NOW with application-layer encryption (my call)

- Unicast ESP-NOW v1 frames, at most 250 bytes, to the paired peer's station MAC. The board id
  `ATECH-<12 hex>` already is that MAC (`esp_efuse_mac_get_default`).
- Every frame is sealed with AES-128-GCM under the 16-byte pairing key: header in clear
  (magic `0xA7 0x53`, version 1, type, flags, 12-byte IV = 4 random boot bytes + 8-byte counter),
  header as AAD, 16-byte tag. Body limit 217 bytes. An unknown sender's frame is tried against
  the open pairing key only while a pairing window is open; everything else is dropped and
  counted.
- ESP-NOW's own LMK encryption is **not** used. It requires both sides to have switched the peer
  entry to encrypted before any frame passes, which makes the pairing handshake and a lost
  confirmation fragile (one side encrypted, the other not, neither hears the other). The GCM layer
  gives the same confidentiality and integrity without that state. Documented in the user docs.

### Messages (plaintext body, little-endian)

| type | name | body |
| --- | --- | --- |
| 1 | HELLO | msgId u32, protocol u8, channel u8, uptimeMs u32, flags u8 (bit0 "just booted"), stateCount u8, stateDigest u32 |
| 2 | HELLO_ACK | msgId u32, ackOf u32, then the same fields as HELLO |
| 3 | STATE | msgId u32, revision u32, writer[6], keyLen u8, key, valueType u8, valueLen u8, value |
| 4 | STATE_ACK | msgId u32, ackOf u32 |
| 5 | EVENT | msgId u32, nameLen u8, name, payloadLen u8, payload |
| 6 | EVENT_ACK | msgId u32, ackOf u32 |
| 7 | SYNC_REQ | msgId u32 (peer answers with every STATE entry) |
| 8 | PAIR_REQ | msgId u32, nonce[8], protocol u8, channel u8 |
| 9 | PAIR_ACK | msgId u32, nonce[8], channel u8 |
| 10 | UNPAIR | msgId u32 |

Limits: key 1..32 bytes, value 0..96 bytes, event name 1..32, payload 0..96, 16 keys, up to
4 peers in the tables (one used). Value types: bool, int (int32), float, string, json (small
structured value kept as text, at most 96 bytes). Values are stored as text with a type tag;
typed accessors parse.

### State, revisions and the tie-breaker

- Each key carries `(revision, writer)`. A local write sets `revision = known revision + 1`,
  `writer = my MAC`. A remote STATE is applied when its `(revision, writer)` is greater than the
  local pair: higher revision wins; equal revisions, the writer with the numerically larger MAC
  wins. Same pair: duplicate, acknowledged, not re-applied. Lower pair: stale, acknowledged, and
  the local newer STATE is sent back so the sender converges.
- Remote updates are never re-sent to their sender; with several peers they would be forwarded to
  the others only. Duplicate suppression keeps the last 16 message ids per peer.
- No wall clocks are involved; `millis()` only drives timeouts.

### Reliability

- Outgoing STATE and EVENT frames wait for an application ACK. Retries: 5 attempts, 150 ms
  doubling to 2.4 s. A STATE already queued for the same key is replaced by a newer value (rapid
  toggles never flood the queue); EVENTs are not coalesced and are dropped (counted) when the
  queue of 12 is full. The ESP-NOW send callback's failure status triggers an early retry.
- When retries are exhausted the peer is marked disconnected; the next reconnection runs a full
  reconciliation, so nothing is lost permanently.

### Connection, reconnection, startup

- HELLO every 3 s when nothing else has been acknowledged in that time; `connected` means an
  authenticated frame arrived in the last 8 s. The status JSON separates `paired` (configured),
  `connected` (live) and `lastAckAgoMs` (last acknowledged communication).
- On disconnected to connected, and on the first contact after boot, both sides send every STATE
  entry (skipped when the HELLO digests of `(key, revision, writer)` already agree). Startup policy:
  persisted entries load first, so a reboot never resets revisions; the exchange then yields the
  union of keys with each conflict settled by the rule above. A new pair starts from whichever
  side wrote more, equal counts broken by MAC. Documented.
- The state table is persisted to NVS (one blob) at most once per 2 s after a change.

### Pairing

- Board A issues a pairing code: a fresh random 16-byte key plus its MAC and current channel,
  valid 10 minutes or until a peer pairs: `ATSYNC1-<12 hex MAC>-<2 hex channel>-<32 hex key>`.
- Board B receives the code (serial, Bluetooth setup session, or the backend), stores A as its
  peer with that key and channel, and sends sealed PAIR_REQ frames every second (up to 20). A
  verifies the seal with the key it issued, stores B, replies PAIR_ACK, closes the window. B marks
  the pairing confirmed when it receives the PAIR_ACK or any sealed frame from A. Both persist
  peer MAC, key and channel.
- Authorization: issuing a code, pairing and unpairing are accepted from the serial console (the
  user holds the USB cable), from the Bluetooth setup session under the existing rule for owned
  boards (owner grant or a BOOT press), and from the backend with the board's own token (LAN HMAC
  or cloud session), that is, from its owner. Setting state and sending events over Bluetooth
  carry no extra authorization, like today's LED commands; documented as the prototype threat
  model.
- Unpair deletes the peer, sends UNPAIR best-effort, and keeps the state table.

### Channels (my call)

- On home Wi-Fi the station channel is the access point's; the module never changes it. Two
  boards on the same network therefore agree.
- Not on Wi-Fi: while a pairing window is open the board stays on its current channel (the one
  printed in the code). Once paired, it uses the peer's last known channel (from the code or the
  last HELLO). After 15 s without contact it hops 1..13, two seconds each, sending HELLO on each,
  and stays where a HELLO_ACK arrives. `esp_wifi_set_channel` is used only when the station is not
  connected.
- Supported modes, documented: both boards on the same Wi-Fi; neither on Wi-Fi; one on Wi-Fi and
  one not (the free one finds the fixed one). Not supported: two different Wi-Fi networks on
  different channels; the status JSON reports the mismatch (`channel`, `peerChannel`).
- `AtechWifiLan` gains `setRadioHold(bool)`: when set, `applyMode()` chooses STA instead of OFF
  so the driver stays started for ESP-NOW even without credentials.

### OTA coexistence

- While any OTA transport owns flash (`otaBusy()`), the module sends nothing but ACKs and reports
  `paused`; incoming frames are still applied. ESP-NOW callbacks only copy into a queue; all work
  runs on the main loop task, like `AtechBleProv`.
- After an OTA reboot the pairing and the state table come back from NVS and the peer reconnects
  within one heartbeat; a reboot shows as a short "offline" on the other board, never as "unpaired".

### Application API (`AtechSyncApp.h`, namespace `atech::sync`)

```cpp
bool  setBool(const char *key, bool v);   bool getBool(const char *key, bool fallback = false);
bool  setInt(const char *key, int32_t v); int32_t getInt(const char *key, int32_t fallback = 0);
bool  setFloat(const char *key, float v); float getFloat(const char *key, float fallback = 0);
bool  setString(const char *key, const char *v); size_t getString(const char *key, char *out, size_t cap);
bool  setJson(const char *key, const char *json); size_t getJson(const char *key, char *out, size_t cap);
bool  has(const char *key);
bool  emit(const char *name, const char *payload = "");
void  onChange(void (*cb)(const StateChange &));   // key, type, value text, remote?, writer id
void  onEvent(void (*cb)(const Event &));          // name, payload, remote?, source id
bool  wait(uint32_t ms);                           // like delay(); returns early when a change arrives
bool  peerConnected();  bool paired();  const char *peerId();
```

Callbacks run on the application task, delivered between `appLoop()` calls (through a core hook
`atech::coreSetAppIdleHook`) and inside `wait()`. `set*` and `emit` are safe from the app task
(mutex); a local change notifies local callbacks too, so one code path renders both origins.

### The demo application (both `src/app/user_app.cpp`)

- `demo.power` false: the LED keeps the stock pattern (slow blue on v1, quick green on v2) so the
  two demos stay recognisable. `demo.power` true: solid warm white.
- Toggle sources: the local `button.pressed` event (main.cpp emits it from the existing BOOT short
  press, alongside the Bluetooth setup unlock it already triggers), the serial console
  (`sync set demo.power true`, `sync toggle demo.power`), the dashboard. Remote `button.pressed`
  events are logged, not acted on: only the local button changes the local state, and the state
  syncs. The app logs every change with its origin.
- The LED/button logic is only in `user_app.cpp`; `AtechSync` never mentions keys or pins.
  Generated apps may use the same API; the system prompt gets a short paragraph.

### Dashboard reach (what can really reach a board)

| Board reached by | status | toggle `demo.power` | issue code / pair / unpair |
| --- | --- | --- | --- |
| Web Bluetooth (desktop Chrome) | `a7ec0301` read + `a7ec0302` notify (live) | BleProv `OP_SYNC` sealed `op=set` | BleProv `OP_SYNC` sealed `op=code/pair/unpair`, grant or BOOT press on owned boards |
| Backend, LAN-paired | `/api/identity` carries `sync` (probe every 8 s) | `POST /api/devices/:id/sync` -> board `POST /api/sync` (HMAC) | same route |
| Backend, cloud-registered | the board's poll report carries `sync` (15 s) | `POST /api/devices/:id/sync` queues; delivered in the next poll answer as `sync=` | same, with the code appearing in the next report |

The dashboard flow: select a board, click **Connect another board**. The dashboard asks the
selected board for a pairing code and shows it with instructions; it also keeps it in
`sessionStorage`. Then the user selects the second board (connect it over Bluetooth, or choose it
in the device list) and clicks **Pair with <first board>**; the stored code is sent. Both boards
then report `paired` and, within seconds, `connected`. A code can also be typed in by hand
(from a serial console). "Unpair" needs a second click.

### Simulation

`builder/lib/fake-sync.js` is a Node model of the engine's observable behaviour (state store,
LWW, pairing codes, connection flag) joined to other simulated boards through an in-process bus,
so `ATECH_SIMULATED_DEVICE=1,1` (two Demo 1 boards; duplicate demos get distinct ids) lets the
dashboard pair two boards and toggle the shared state without hardware. It implements the
`/api/sync` route and the `sync` identity object in `fake-device.js` and the poll fields in
`fake-cloud-device.js`. It is a simulation of the protocol's contract, not of radio.

### Testing

- `shared/AtechSync/test/host/`: C++ tests compiled with the system `clang++` and run from a
  Node test (`shared/AtechSync/sync.test.js`, skipped with a message when no compiler is found):
  codec round trips and malformed/oversized rejection; local and remote changes; bidirectional
  updates; duplicates; lost ACKs and retries; simultaneous conflicting writes on both sides with
  the documented tie-breaker; disconnect and reconnect with reconciliation; reboot (serialize,
  new engine, reconnect); pairing handshake and persistence; queue coalescing.
- Structure test for the ESP32 wrapper and the wiring in both `main.cpp` files (UUIDs, ESP-NOW
  calls, GCM, NVS keys, hooks), as the other libraries have.
- Backend: `/api/devices/:id/sync` over the LAN and the cloud queue, fake-sync pairing across two
  simulated boards, the poll fields, the BleProv `OP_SYNC` reference board, the grant gating.
- Dashboard (jsdom): the block hidden without a board, status rendering for BLE and backend
  boards, code and pair flow with the stored code, toggle through the available path, "paired but
  not communicating" never shown as connected.
- `pio run -e base -e updated -e ai` for both demos.

### Deliverables and documentation

- `BOARD_SYNC.md`: how it works, exact build/flash/pair/test commands, the manual two-board test
  procedure, the channel modes, security notes and limitations; README and
  `AI_FIRMWARE_BUILDER.md` get a pointer; `builder/prompts/system.md` gets the API paragraph.
- Core version `1.3.0` (new hook); `AtechWifiLan` 1.2.0; `AtechBleProv` 1.1.0.
