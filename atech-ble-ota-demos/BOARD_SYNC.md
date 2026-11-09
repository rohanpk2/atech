# Board-to-board sync (AtechSync)

Two Atech boards keep a small key-value state and discrete events in agreement over ESP-NOW,
directly, with no router, backend or internet in the path. A change on one board appears on the
other within a fraction of a second; either board may change anything; a rebooted board catches
up; rapid changes never loop. The first application is one shared boolean, `demo.power`, shown
on the onboard LED of both boards and toggled from the BOOT button, the serial console or the
dashboard.

**Verification status (2026-11-09):** the protocol engine passes 253 host-compiled C++ checks
(two and three engines on a lossy in-memory bus), the backend and both dashboards pass 231 Node
tests plus the structure tests, all six PlatformIO environments build, and an independent code
review's two critical and four important findings were fixed with tests. **Only one ESP32-S3
is attached to this machine, so nothing below has run on two physical boards.** Section 7 is the
procedure for doing that; section 9 lists what it has to confirm.

## 1. What it does

- A reusable firmware module, `shared/AtechSync`, that any Atech image carries. It knows nothing
  about LEDs, buttons or `demo.power`; it moves typed values (bool, int, float, string, small
  JSON) under short keys, and one-off events with a name and a payload.
- Pairing with an explicit code, persisted in NVS, with a clear line between **paired**
  (configured) and **connected** (a frame from the peer in the last 8 s).
- Acknowledged delivery with retries, duplicate suppression, a deterministic conflict rule, and
  a full reconciliation whenever the two boards reconnect or one reboots.
- Every frame sealed with AES-128-GCM under the pairing key.
- Control from the serial console, from the dashboard over Bluetooth (desktop Chrome), and from
  the backend over the LAN or through the cloud poll, so the hosted dashboard works too.
- The same application API for generated firmware: `atech::sync::*` in `AtechApp.h`.

## 2. Architecture

```
 app task              main loop task                       Wi-Fi task
 user_app.cpp          AtechSync (ESP32 wrapper)            ESP-NOW callbacks
 atech::sync::*  <-->  notification queue                   recv / send status -> queue
                       SyncEngine (portable C++)
                         SyncStore: (revision, writer) per key
                         SyncCodec: body layout
                         peers, ack queue, dedupe, heartbeats, pairing, reconciliation
                       AES-128-GCM seal / unseal, NVS, channel policy, status JSON,
                       GATT a7ec0300, serial console, command()
 hooks:  AtechBleProv OP_SYNC (sealed)   AtechWifiLan POST /api/sync (HMAC) + "sync" in identity
         AtechCloudOta poll: sync=<status> out, sync=<command> in
```

| File | Role |
| --- | --- |
| `shared/AtechSync/src/SyncTypes.h` | limits, timings, the `SyncEntry` type, the version order |
| `shared/AtechSync/src/SyncCodec.h/.cpp` | little-endian body layout of every message, strict decoding |
| `shared/AtechSync/src/SyncStore.h/.cpp` | the versioned table, digest, NVS blob |
| `shared/AtechSync/src/SyncEngine.h/.cpp` | the protocol: peers, pairing, acks, retries, dedupe, heartbeats, reconciliation, forwarding |
| `shared/AtechSync/src/AtechSync.h/.cpp` | ESP32 side: ESP-NOW, GCM, NVS, queues, channel policy, status, GATT, serial, `command()` |
| `shared/AtechSync/src/AtechSyncApp.h` | the application API (included by `AtechApp.h`) |
| `shared/AtechSync/test/host/*.cpp`, `sync.test.js` | host-compiled engine tests |
| `shared/AtechSync/wiring.test.js` | structure test of the wrapper, the hooks and both demos |

The engine never touches a radio, a clock or storage: the wrapper feeds it time, frames and
commands, and it answers through two small interfaces (send a body to a MAC; notify a state or
event change). That is what makes it testable on the host and what will let a Wi-Fi/MQTT
transport be added later without changing the application API.

## 3. Wire format

Frame, at most 250 bytes (ESP-NOW v1):

```
[0xA7 0x53][version 1][type][flags][iv 12]   <- 17-byte header, also the GCM additional data
[ciphertext, at most 217 bytes][tag 16]
```

Key: the 16-byte pairing key of the peer (AES-128). IV: 4 random bytes drawn at boot plus an
8-byte counter. A frame from an unknown MAC is tried against the open pairing key only while a
pairing window is open and only for a PAIR_REQ; anything else from an unknown sender is dropped
before any parsing (`unknownSenders` in the status counters). A frame that fails authentication
is dropped (`authFailures`).

Plaintext bodies (little-endian):

| type | name | body |
| --- | --- | --- |
| 1 | HELLO | msgId u32, protocol u8, channel u8, uptimeMs u32, flags u8 (bit0 just booted), stateCount u8, stateDigest u32 |
| 2 | HELLO_ACK | msgId u32, ackOf u32, then the HELLO fields |
| 3 | STATE | msgId u32, revision u32, writer[6], keyLen u8, key, valueType u8, valueLen u8, value |
| 4 | STATE_ACK | msgId u32, ackOf u32 |
| 5 | EVENT | msgId u32, nameLen u8, name, payloadLen u8, payload |
| 6 | EVENT_ACK | msgId u32, ackOf u32 |
| 7 | SYNC_REQ | msgId u32 (the peer answers with every STATE entry) |
| 8 | PAIR_REQ | msgId u32, nonce[8], protocol u8, channel u8 |
| 9 | PAIR_ACK | msgId u32, nonce[8], channel u8 |
| 10 | UNPAIR | msgId u32 |

Limits: key 1..32 characters (`A-Z a-z 0-9 . _ -`), value 0..96 bytes, event name 1..32, payload
0..96, 16 keys, 4 peers, 20 queued frames. Value types: `bool` (`true`/`false`), `int` (32-bit),
`float`, `string`, `json` (small structured text starting with `{` or `[`).

## 4. Versioning, conflicts and reconnection

Every key carries `(revision, writer MAC)`. A local write sets `revision = known revision + 1`
and `writer = this board`. A remote STATE is applied when its pair is greater than the local one:
**higher revision wins; equal revisions, the numerically larger writer MAC wins.** An identical
pair is a duplicate (acknowledged, not re-applied). An older pair is stale: it is acknowledged
and answered with the newer local STATE, so the sender converges. No wall clock is involved.

Remote changes are never sent back to their sender; with several peers they are forwarded to
the others only (a star through the hub). Each STATE and EVENT is acknowledged; the sender
retries 5 times (150 ms, 300, 600, 1200, 2400), replaces a queued STATE for the same key by the
newer value (rapid toggles never flood the queue), and drops the frame after the fifth attempt
(`dropped`). The last 16 message ids per peer suppress duplicates.

HELLO every 3 s when nothing else was sent; a peer is **connected** while a frame arrived in the
last 8 s and **offline** after that. At every reconnection both sides compare the digest of
`(key, revision, writer)` and resend their whole table when it differs; the same happens when
two consecutive heartbeats disagree with nothing in flight (self-healing after a dropped frame).

Startup policy: the state table is persisted to NVS (at most every 2 s after a change) and
loaded at boot, so a reboot keeps every revision. A new pair exchanges both tables and ends with
the union of keys, each conflict settled by the rule above: the board that wrote a key more
often wins; equal counts, the larger MAC. The demo key starts unset on both boards.

## 5. Pairing, authorization, security

Board A issues a **pairing code**, valid 10 minutes or until a peer pairs:

```
ATSYNC1-<12 hex MAC of A>-<2 hex channel of A>-<32 hex random key>
```

Board B receives it (serial, Bluetooth setup session or backend), stores A as its peer with that
key and channel, and sends sealed PAIR_REQ frames every second (20 fast attempts, then every
10 s). A verifies the seal with the key it issued, stores B, answers PAIR_ACK and closes the
window. B marks the pairing confirmed on the PAIR_ACK (or any sealed frame from A). Both persist
peer MAC, key, channel and the confirmed flag in NVS (`atech_sync`: `peers`, `state`).

Who may issue a code, pair or unpair:

| Path | Authorization |
| --- | --- |
| serial console | the person holding the USB cable |
| Bluetooth setup session (dashboard) | the same rule as a Wi-Fi change: an unowned board accepts; an owned board needs the owner's grant (minted by the backend for its owner) or a short BOOT press within two minutes |
| backend relay (LAN `POST /api/sync`, cloud poll) | the board's own pairing token: the backend holds it only for the board's owner |

Setting state and sending events carry no extra authorization over Bluetooth, like today's LED
commands; over the backend they still need the token. This is the prototype threat model of the
rest of the project (README): a per-board secret, integrity-checked traffic, unsigned firmware.

**Why AES-GCM instead of ESP-NOW's own LMK encryption.** ESP-NOW encrypts a peer only when both
sides have switched that peer entry to encrypted, and a frame whose encryption does not match
the entry is dropped. That makes the pairing handshake and a lost confirmation fragile: one
side encrypted, the other not, and neither hears the other. Sealing every frame above the link
layer with the pairing key gives the same confidentiality and integrity, works for the very
first PAIR_REQ, and has no such state. The ESP-NOW peer entries are therefore added
unencrypted (`encrypt = false`) on purpose.

## 6. Wi-Fi channels and OTA coexistence

ESP-NOW only works between boards on the same channel.

| Both boards | Result |
| --- | --- |
| on the same Wi-Fi network | the access point fixes the channel; nothing to do |
| neither on Wi-Fi | the pairing code carries A's channel; B uses it. After 15 s without contact a free board hops 1..13 (2 s each) and stays where a HELLO_ACK arrives |
| one on Wi-Fi, one not | the free board finds the fixed one the same way |
| on two different Wi-Fi networks on different channels | **not supported**; the status reports `channelMismatch: true` and the dashboard says so |

The module never changes the channel while the station is connected or the hotspot portal is
up. While the LAN module retries a lost Wi-Fi join (every 15 s) its scan moves the channel
briefly; retries cover the lost frames. The Wi-Fi module gained `setRadioHold(true)` so the
driver stays started for ESP-NOW even on a board with no Wi-Fi credentials.

While any OTA transport owns flash (`otaBusy()`), the module sends nothing but acknowledgments
and reports `paused`; incoming frames are still applied. After the reboot the peer and the state
table come back from NVS and the peer reconnects within one heartbeat: the other board sees a
few seconds of "Paired, not communicating", never "Not paired".

## 7. Build, flash, pair and test two boards

Everything below is the procedure; none of it has been run on two boards yet.

### 7.1 Build and flash

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt    # or demo2-bleota-library
pio run -e base
# Board A plugged in alone (find the port with: pio device list)
pio run -e base -t upload --upload-port /dev/cu.usbmodemXXXX
# Board B plugged in alone
pio run -e base -t upload --upload-port /dev/cu.usbmodemYYYY
```

Both boards may run different demos (Demo 1 and Demo 2 pair with each other; the sync module is
the same). Open a serial monitor on each board: `pio device monitor -b 115200 -p <port>`.

Expected at boot on each board:

```
[sync] not paired; 0 state key(s) restored. Serial: "sync code" here, then "sync pair <code>" on the other board
[sync] ESP-NOW ready on ATECH-XXXXXXXXXXXX, channel 1
[app] stock Demo 1 app ready on ATECH-XXXXXXXXXXXX; demo.power is off; not paired yet (...)
```

### 7.2 Pair over the serial console

On board A type `sync code`:

```
[sync] pairing code issued; valid for 10 minutes: ATSYNC1-A1B2C3D4E5F6-01-0123456789abcdef0123456789abcdef
[sync] on the other board type: sync pair ATSYNC1-A1B2C3D4E5F6-01-0123456789abcdef0123456789abcdef
```

On board B type `sync pair ATSYNC1-...` (the whole code). Expected within about two seconds:

```
B:  [sync] pairing with ATECH-A1B2C3D4E5F6 (channel 1); waiting for its answer
B:  [sync] ok
A:  [sync] peer ATECH-...B...: none -> connected
B:  [sync] peer ATECH-A1B2C3D4E5F6: pairing -> connected
```

`sync status` on either board prints the status JSON: `"paired":true,"connected":true`.

### 7.3 Toggle the shared state

- Press **BOOT** briefly on board A (a short press; a 3 s hold opens the hotspot portal instead).
  Both LEDs turn solid warm white. Expected:

  ```
  A:  [prov] BOOT pressed: Bluetooth setup changes allowed for 120 s
  A:  [app] demo.power = true (set here, revision 1 by ATECH-A1B2C3D4E5F6)
  B:  [app] demo.power = true (from the other board, revision 1 by ATECH-A1B2C3D4E5F6)
  ```

- Press BOOT on board B: both LEDs return to the stock blink (slow blue on a v1 image, quick
  green on v2); the lines above repeat with revision 2 and B as the writer.
- Serial alternatives: `sync toggle demo.power`, `sync set demo.power true`, `sync get demo.power`,
  `sync event button.pressed`.

### 7.4 Dashboard

Local backend: `cd builder && npm start`, open http://localhost:5173/demo1/ in desktop Chrome.

1. **Connect Bluetooth** to board A. The **Board connections** block appears in step 1 with
   "Not paired".
2. Click **Connect another board**. The code appears in the block (and is kept in this tab).
3. **Disconnect**, then **Connect Bluetooth** to board B. The block now offers **Pair with
   ATECH-A...**; click it. Within a few seconds both boards show **Connected**.
4. **Turn demo.power on / off** toggles both LEDs; the block updates live from the board's change
   notification. The Activity log records every change with its writer.
5. **Unpair** (two clicks) forgets the pairing on both boards.

A board reached through the backend (paired over the LAN, or claimed through the cloud) shows
the same block from the backend's status: on the LAN the command runs at once; through the cloud
it is **queued** and the board picks it up on its next poll (15 s by default). The pairing code of a
cloud board appears in the block when the board reports it. On an owned board the dashboard asks
the backend for the owner grant, as for a Wi-Fi change; without it, press BOOT once on the board.

### 7.5 Reboot and reconnect

- Press RST on board B. Board A shows "Paired, not communicating" for a few seconds, then
  "Connected"; B's LED comes back with the right state (`demo.power` is restored from NVS and
  reconciled). Expected on B: `[sync] paired with ATECH-A... (confirmed, channel N), 1 state key(s) restored`.
- Power board B off, toggle on A twice, power B on: B ends with A's value and A's revision.
- Toggle on both boards while B is off (one each): after reconnection both hold the value written
  by the board with the larger MAC (section 4), with no further traffic (`sync status` counters stop moving).
- Tap BOOT on A ten times quickly: both boards end in the same state; `stats.dropped` stays 0 and
  `queued` returns to 0.
- Deploy a build to A over any OTA path while paired: A reports `paused` during the transfer, B
  shows A offline during the reboot, and both reconnect afterwards with the state intact.

### 7.6 No hardware: two simulated boards

```sh
cd builder && ATECH_SIMULATED_DEVICE=1,1 npm start
```

gives two simulated Demo 1 boards on one in-process bus. In the dashboard select the first,
click **Connect another board**, select the second with **Use this board**, click **Pair with
...**, then toggle. This exercises the backend, the dashboard and the protocol model
(`builder/lib/fake-sync.js`), not the firmware.

## 8. Reference

### Serial console

```
sync status | sync code | sync pair <code> | sync unpair
sync set <key> <value> | sync toggle <key> | sync get <key> | sync event <name> [payload]
```

Types are inferred (`true`/`false`, integer, decimal, `{`/`[` JSON, else string).

### Application API (`AtechApp.h`, namespace `atech::sync`)

```cpp
bool setBool(key, v);  bool getBool(key, fallback);    bool setInt(key, v);   int32_t getInt(key, fallback);
bool setFloat(key, v); float getFloat(key, fallback);  bool setString(key, v); size_t getString(key, out, cap);
bool setJson(key, v);  size_t getJson(key, out, cap);  bool has(key);
bool emit(name, payload = "");
bool onChange(void (*cb)(const StateChange &));  bool onEvent(void (*cb)(const Event &));
bool wait(ms);                 // delay() that returns true as soon as a change was delivered
bool peerConnected(); bool paired(); const char *peerId();
```

Callbacks run on the application task between `appLoop()` passes and inside `wait()`.

### Backend

- `POST /api/devices/:id/sync` body `{op, key, value, type, code, name, payload}` with `op` in
  `code | pair | unpair | set | toggle | event | status`. Answers `{ok, via: 'lan', result}` when the
  board is on the LAN (the board's own `{ok, code | error}`), `202 {ok, via: 'cloud', queued: true,
  pollMs}` when it is cloud-registered, `409` when it is reachable neither way.
- Board LAN route `POST /api/sync`, headers `X-Atech-Device`, `X-Atech-Nonce`, `X-Atech-Auth` =
  HMAC-SHA256(token, `atech-sync/1\n<id>\n<nonce>\n<body>\n`), body the form above.
- Cloud poll: the board sends `sync=<compact JSON>` with every poll; the answer may carry
  `sync=<form>`. The compact JSON is `{paired, connected, peer, peerState, code, state: {key: text}}`
  and is what the hosted dashboard renders.
- Bluetooth setup opcode `0x05` (sealed): the form above plus `grant`; reply `ok=1[&code=...]` or
  `ok=0&error=...`.
- GATT `a7ec0300`: `a7ec0301` status (read; a compact payload kept under 440 bytes because a GATT
  attribute holds at most 512: `{sync, id, paired, connected, peer, peerState, pairingOpen, code, paused,
  channelMismatch, channel, lastAckAgoMs, state: {key: text}, truncated}`; state entries are added while
  they fit and `truncated` says when they did not), `a7ec0302` change (notify:
  `{k, v, t, rev, by, remote}`, `{event, payload, from, remote}` or `{peer, state}`).

### Status JSON (board)

`id, mac, channel, wifi, radio, paused, pairingOpen, pairingCode, paired, connected, peer,
peerState (none | pairing | offline | connected), peerChannel, channelMismatch, lastAckAgoMs,
lastSeenAgoMs, peers[], state{key: {v, t, rev, by}}, queued, stats{sent, acked, retries, dropped,
received, duplicates, stale, rejected, forwarded, authFailures, unknownSenders, malformed,
rxOverflows, notifyOverflows, sendFailures}`.

### Tests

```sh
node shared/AtechSync/sync.test.js        # host-compiled engine tests (clang++)
node shared/AtechSync/wiring.test.js      # structure: wrapper, hooks, both demos
cd builder && npm test                    # backend, simulator, jsdom dashboards (sync.test.js, dashboard-sync.test.js)
node web-shared/atech-builder.test.js; node demo1-custom-gatt/web/dashboard.test.js; node demo2-bleota-library/web/dashboard.test.js
cd demo1-custom-gatt && pio run -e base -e updated -e ai   # and demo2-bleota-library
```

## 9. Limitations and what two boards must confirm

- **Nothing in sections 7.1 to 7.5 has run on two physical boards.** The host tests prove the
  protocol logic; the ESP-NOW driver, the channel policy, GCM throughput and the BOOT button path
  are proven only by compiling.
- To confirm on hardware: pairing within a few seconds on channel 1 with no Wi-Fi; pairing when
  both boards are on the same home Wi-Fi; the free board finding a Wi-Fi-connected board (hop;
  measure the time from the 15 s silence to the first HELLO_ACK); re-pairing with a fresh code while
  the boards are already paired (both must end on the new key, `sync status` on both); toggle
  latency well under a second; the reboot, power-off and conflict cases of 7.5; an OTA deployment
  while paired; `authFailures`, `unknownSenders`, `rxOverflows` staying at 0 in normal use and during
  pairing; the Board connections block rendering over Bluetooth (the status read is the compact
  payload; `sync status` on serial prints the full one).
- Two boards on different Wi-Fi networks on different channels cannot talk (section 6).
- A short BOOT press also opens the two-minute Bluetooth setup window on an owned board (existing
  behaviour); the demo app reuses the press as its toggle because the DevKitC-1 has no other
  button. Generated apps may use any allowed GPIO for their own button.
- The hosted dashboard sees a cloud board's state with up to one poll interval (15 s) of delay and
  can only queue commands; the LAN and Bluetooth paths are immediate.
- Values are at most 96 bytes and 16 keys per board; more than two boards pair through one hub
  board (star), proven on the host only.
- Link-layer LMK encryption is not used (section 5); the serial console accepts commands from
  anyone with the USB cable.
