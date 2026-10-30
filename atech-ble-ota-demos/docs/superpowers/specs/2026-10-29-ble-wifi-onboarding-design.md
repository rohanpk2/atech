# One-time Wi-Fi onboarding over Bluetooth and end-to-end cloud OTA (design)

Date: 2026-10-29. Status: designed from the requester's written brief of 2026-10-29 (quoted in the
appendix) after inspecting the repository and the attached board. Choices marked **(my call)** were
made by the builder because the session ran without the requester available; each can be overridden.

## What exists today (recon, 2026-10-29)

The repository already implements most of the brief's phases 2 to 4. Nothing in this design
replaces them; the new work is phase 1 and the glue that makes the whole flow serial-free.

| Area | State found | Where |
| --- | --- | --- |
| Board identity and pairing token | `ATECH-<MAC>` id from eFuse; 24-character OTA authorization code generated at first boot into NVS, printed on the serial console, used as the LAN HMAC secret and the cloud pre-shared key | `shared/AtechCore`, `shared/AtechWifiOta` |
| Wi-Fi credentials | NVS namespace `atech_wifi` (`ssid`, `pass`), auto-join at boot, auto-reconnect every 15 s | `shared/AtechWifiLan` |
| Wi-Fi provisioning | Only through the board's own SoftAP hotspot portal (hold BOOT 3 s, join `Atech-OTA-D1-…`, open 192.168.4.1, type the code). This is exactly what the brief forbids as the primary path. | `shared/AtechWifiOta` |
| Cloud agent | Own task, HTTPS with the built-in root bundle, HMAC login (`atech-cloud-login/1`), bearer session, poll every 15 s with a status report, ranged download, inactive-slot install, boot marker, acknowledged confirm, automatic rollback after 3 min without acknowledgment | `shared/AtechCloudOta` |
| Cloud server URL | Compiled in (`ATECH_CLOUD_URL` from `ATECH_PUBLIC_URL`) or set on the hotspot portal (NVS `atech_cloud/url`) | `AtechCloudOta`, `builder/lib/workspace.js`, `installer.js` |
| Device API | `/api/device/challenge`, `login`, `poll`, `jobs/:id/firmware`, `jobs/:id/status`; no dashboard key; rate limited; sessions bounded | `builder/lib/cloud-routes.js`, `cloud-devices.js` |
| Claiming and ownership | `POST /api/devices/claim {id, token}`; owner = `x-atech-user` (Vercel sets it) or `local`; device and deployment routes are owner-scoped | `builder/server.js`, `cloud-devices.js`, `devices.js` |
| Build routes | `GET /api/builds`, `/api/builds/:id`, `/firmware.bin` are **not** owner-scoped (any key holder sees every build) | `builder/server.js`, `jobs.js` |
| Job lifecycle | pending, downloading, installing, rebooting, succeeded, failed (expired, stalled, reboot_timeout, confirm_timeout, device, rolled_back, safe_mode, attempts, artifact), cancelled; persisted; timeouts; one job per board | `builder/lib/cloud-ota.js` |
| Firmware template | Generated code is `src/app/user_app.cpp` only; source policy forbids Wi-Fi, BLE, OTA, NVS, tasks; GPIO guards; every image must carry the `ATECH-CLOUD-AGENT:` marker | `builder/lib/source-policy.js`, `jobs.js`, `shared/AtechCore` |
| Partitions and rollback | two 6 MiB app slots, `verifyRollbackLater`, auto-confirm after the app loop runs, safe mode after three crash resets, size check at build | `partitions.csv`, `shared/tools/check_ota_size.py` |
| Hosted dashboard | Vercel project `atech-dashboards`, `/api/*` proxied to `ATECH_BACKEND_URL` with the key and the user header; Basic sign-in; env values were placeholders on 2026-10-29 | `vercel-frontend/` |
| Docker | `deploy/` image with PlatformIO, Caddy TLS front for `/api/*`; verified locally only | `deploy/` |
| Hardware | **A board is attached now**: `ATECH-90DA724FC608` on `/dev/cu.usbmodem5CBB0247201`, running a stock v1 image from this code base (it prints the `[cloud]` and `[wifi]` lines), Wi-Fi configured for the iPhone hotspot, no cloud URL. The local registry still holds its LAN pairing (token) from 2026-10-28. | serial log, `.ai-builds/devices.json` |

Static blink v1 (blue, slow) and v2 (green, quick) are the `base` and `updated` environments; a
job for the cloud path can only be created from a build job today, so there is no way to push the
static v2 through the cloud without the model.

## Intent

A customer flashes the board once over USB, opens the dashboard in desktop Chrome, clicks
**Connect Bluetooth**, types their normal 2.4 GHz Wi-Fi name and password, and from then on deploys
generated firmware from anywhere through the hosted dashboard. No hotspot, no SoftAP, no serial
console, no copying of codes. The Wi-Fi password goes from the browser to the board over an
encrypted Bluetooth channel and nowhere else.

## Goals

1. **Phase 1.** Provision Wi-Fi credentials, the cloud server URL and the device's cloud
   authentication over the existing Bluetooth connection, encrypted end to end between the browser
   and the board, authenticated for a board that already has an owner. Credentials persist in NVS and
   survive reboots and OTA updates. The dashboard shows join and cloud status. A board already
   claimed by this dashboard user is not claimed again.
2. **Phase 2.** Keep the existing HTTPS heartbeat and polling; display online/offline and firmware
   version (exists); make every build route owner-scoped so a customer only sees and deploys their
   own builds.
3. **Phase 3.** Keep the existing cloud OTA path; add a way to create a deployable job from the
   static stock app (blink v2) so the v1 to v2 cloud deployment can be verified without the model.
4. **Phase 4.** The provisioning service joins the protected core: every image carries it, the
   generated application cannot reach it, and identity, token and Wi-Fi configuration survive updates.
   Bluetooth OTA and the hotspot portal remain as backups.
5. **Phase 5.** Automated tests for provisioning crypto and framing, the grant route and ownership,
   the dashboard flow, the static job, build ownership; precise commands for USB flash, Docker
   redeploy, Vercel configuration and the hardware validation; honest reporting of what ran on the
   attached board.

## Non-goals

- Replacing the demos' GATT services with Espressif's `wifi_provisioning` / `WiFiProv` component.
  It takes over the BLE host and GATT table (`protocomm_ble`), which is incompatible with the
  custom OTA and command services (Demo 1) and gb88 BLEOTA (Demo 2) that must keep working on the
  same connection, and Web Bluetooth has no client for its protobuf and SRP6a (Security 2) framing.
  **(my call)** The design below mirrors its Security 1 idea (ephemeral ECDH plus an AEAD) and adds
  an owner-held proof of possession, implemented as ordinary GATT characteristics the existing
  dashboard already knows how to use.
- BLE link-layer pairing or bonding. Web Bluetooth on macOS Chrome can trigger OS pairing dialogs,
  but the result is "Just Works" (unauthenticated), stores OS state the dashboard cannot inspect,
  and would not protect the password from a relay. Application-layer encryption is used instead.
- Signed firmware, Secure Boot, flash encryption, per-user accounts beyond the single sign-in.
  Documented production steps, unchanged.
- Pushing anything from the cloud to the board. The board keeps pulling.

## Anti-goals

- The Wi-Fi password ever reaching the backend, a log line, `localStorage`, a cookie or the URL.
- A board that accepts a new server URL or new Wi-Fi from any phone nearby once it has an owner.
- Claiming anything was verified on hardware that was not. The attached board is used for what it
  can prove in this session; the rest is listed as not verified.

## Constraints discovered during recon

- BLE stack: NimBLE (`CONFIG_BT_NIMBLE_ENABLED=1`), preferred MTU 256, long writes up to 512 bytes
  assembled by the Arduino BLE library, `onWrite` must not block (it runs on the host task), so
  frames are queued to the main loop as the demos already do for OTA and commands.
- mbedtls in the precompiled libs: ECDH, SECP256R1, HKDF, GCM, hardware SHA all enabled, so
  P-256 ECDH, HKDF-SHA256 and AES-256-GCM are available on the board; WebCrypto in Chrome 156 has
  the same three. P-256 rather than X25519 because WebCrypto support for P-256 ECDH is universal.
- Notifications carry at most MTU minus 3 bytes (244 at the negotiated 247); replies longer than
  that are fragmented at the application layer.
- `WiFi.scanNetworks` blocks for about two seconds; the hotspot portal already runs it from the
  main loop, so the provisioning handler may too.
- The board's LAN record in `.ai-builds/devices.json` has no `ownerId` (claimed before ownership
  existed), so it is visible to every principal; claiming it from the hosted dashboard sets one.
- The Mac is on a Wi-Fi network whose name macOS hides from the shell and whose password is not
  available to this session; the attached board is configured for an iPhone hotspot. Hardware
  validation of the join itself therefore needs the owner to type a password.

## Architecture (new parts in bold)

```
desktop Chrome ── Web Bluetooth ──▶ ESP32-S3
   dashboard         │                ├─ Demo 1 custom GATT (OTA, commands)   unchanged
                     │                ├─ Atech identity service a7ec0100       unchanged
                     │                └─ **Atech provisioning service a7ec0200**
                     │                       status (read), request (write), reply (notify)
                     │                       ECDH P-256 → HKDF → AES-256-GCM; owner grant HMAC
                     └── HTTPS ──▶ Vercel ──▶ Droplet backend
                                        ├─ **POST /api/devices/:id/provision-grant** (owner only)
                                        ├─ POST /api/devices/claim (token read over BLE, automatic)
                                        └─ /api/device/* (board, as before)
ESP32-S3 ── Wi-Fi ── HTTPS ──▶ Droplet backend (login, poll, download, report)   unchanged
```

## Phase 1: Bluetooth Wi-Fi onboarding

### GATT service `a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001` (new shared library `shared/AtechBleProv`)

| Characteristic | UUID suffix | Properties | Content |
| --- | --- | --- | --- |
| Status | `a7ec0201` | read | JSON, no secrets: `{"prov":1,"id":…,"locked":bool,"unlock_ms":n,"session":bool,"wifi":{"configured":bool,"ssid":"…","connected":bool,"ip":"…","rssi":n,"reason":n,"joining":bool},"cloud":{"url":"…","state":"…","session":bool,"last_error":"…","last_contact_ms":n},"busy":bool}` |
| Request | `a7ec0202` | write (with response) | fragmented request frames |
| Reply | `a7ec0203` | notify | fragmented reply frames |

Framing on both characteristics: `[flags][seq][payload ≤ 240]`; `flags` bit 0 = last fragment,
bit 1 = first fragment; `seq` counts from 0 inside a message. A message is `[opcode][body]`,
at most 1024 bytes reassembled. A request whose fragments do not arrive within 5 s is dropped.

| Request | Body | Reply (`opcode | 0x80`) |
| --- | --- | --- |
| `0x01 HELLO` | client ECDH P-256 public key, 65 bytes uncompressed | `[board public key 65][nonce 16][flags 1]`; flags bit 0 = locked, bit 1 = Wi-Fi configured, bit 2 = cloud URL set. Starts a session: `key = HKDF-SHA256(salt = nonce, ikm = ECDH shared secret, info = "atech-prov/1")`. The session ends on disconnect or the next HELLO. |
| `0x02 SCAN` | none | text lines `ssid<TAB>rssi<TAB>open(0/1)`, strongest first, one line per SSID, at most 12 |
| `0x03 PROVISION` | `[iv 12][ciphertext][tag 16]`, AES-256-GCM, AAD = `[0x03]`, plaintext JSON `{"ssid","pass","url","grant","claim"}` (every field optional) | encrypted the same way with AAD `[0x83]`: `{"ok":true,"joining":bool,"token":"…"}` (token only when `claim` was true and the request was authorized) or `{"ok":false,"error":"…"}` |
| `0x04 FORGET` | encrypted JSON `{"wifi":bool,"url":bool,"grant"}` | encrypted `{"ok":…}` |

Plaintext replies (`0x81`, `0x82`) are fine: public keys, a nonce, network names. Everything that
carries the password, the server URL or the token is under the session key.

### Authorization: who may provision

- **Unlocked board** (never owned): any connected client may provision. First come, first served,
  like an unprovisioned Espressif board; the window is the time between the USB flash and the first
  successful cloud login, with the user standing next to it. **(my call)**
- **Locked board**: a board becomes locked, persistently (NVS `atech_prov/locked`), the first time
  its cloud agent completes a login (the backend holds its token, so somebody owns it). A locked
  board accepts PROVISION and FORGET only with one of:
  1. an **owner grant**: `HMAC-SHA256(token, "atech-prov-grant/1\n<id>\n<nonce hex>\n<sha256 hex of client public key || board public key>\n")`, hex. The dashboard asks its backend for it (`POST /api/devices/:id/provision-grant {nonce, transcript}`), which only answers the board's owner, and the backend computes it from the stored token. Binding the two public keys makes the key exchange authenticated: a relay changes the keys and the grant fails.
  2. a **physical-presence window**: a short press (released before the 3 s hotspot hold) of the BOOT button unlocks the board for 2 minutes. The dashboard tells the user to press it when it has no grant (board owned by another dashboard user, or a backend that no longer knows the token). **(my call)**
- The token is returned over the encrypted channel only in an authorized PROVISION with `claim: true`.
  The dashboard uses it once, to call `POST /api/devices/claim`, and discards it. If the backend
  already lists the board as claimed by this principal, the dashboard does not claim again.

### Board behaviour

- Library `shared/AtechBleProv` (protected core): `begin({server, lan, cloud, authToken, busy, buttonPin…})`,
  `loop()` (processes queued frames), `noteButtonPress()`, `statusJson()`. Embeds `ATECH-PROV:1`.
- PROVISION with `ssid` calls `AtechWifiLan::saveCredentials` (validates lengths, persists, starts
  the join). With `url` calls `AtechCloudOta::setServerUrl` (https only unless the lab flag). Refused
  while any OTA transport owns flash (`busy`). The password is never printed; the SSID is.
- The cloud agent gains `hasSession()` so the provisioning library can observe the first login and
  set the lock. The hotspot portal gains a `shortPress` callback so the BOOT button can open the
  physical-presence window without disturbing the 3 s hold.
- Status is read by the dashboard every 1.5 s while a join is in progress and every 5 s otherwise
  (long read; the identity characteristic already proves long reads work with this stack).

### Dashboard (desktop Chrome, both demos)

- Step 1 gains a **Wi-Fi setup** block, visible only when a board is connected over Bluetooth and
  exposes the provisioning service. Ids: `provPanel`, `provState`, `provSsid`, `provNetworks`
  (datalist), `provPassword`, `provScan`, `provJoin`, `provForget`, `provProgress`, `provHint`.
  Copy follows the Lovable-style rules: one state line, a bar while joining, no explanations of
  the protocol.
- Join: HELLO (if no session), build `{ssid, pass, url: health.cloud.publicUrl, claim: true}`, add a
  grant when the HELLO flags say locked and the backend answers the grant request, PROVISION, clear
  the password field, poll status until `wifi.connected` or `reason != 0` (45 s), then claim if
  needed and show the cloud state. A locked board without a grant shows the BOOT-press hint.
- The shared module `web-shared/atech-provision.js` holds framing, WebCrypto and JSON; `app.js`
  (each demo) wires it to the characteristics and exposes it as `transport.provisioning`.
- The password lives in a local variable for the duration of one request. No logging of the
  request body; the activity log says "Wi-Fi credentials sent to the board" only.

### Backend

- `lib/cloud-auth.js`: `provisionGrantMessage`, `provisionGrantHex` (canonical string pinned by tests).
- `POST /api/devices/:id/provision-grant {nonce, transcript}`: owner check (`canAccess`), 404 when
  the backend holds no token for the board, 400 on malformed nonce or transcript.
- `GET /api/health` already exposes `cloud.publicUrl`; the dashboard provisions it.

## Phase 2: cloud communication (hardening only)

- Jobs get `ownerId` at creation (`principalOf`); `GET /api/builds`, `GET /api/builds/:id`,
  `/events`, `/firmware.bin`, `/deployed`, `/deploy` refuse another principal's job (403) and the
  list is filtered. Jobs from before ownership (`ownerId` missing) stay visible to everyone, like
  device records. **(my call)**
- Everything else (heartbeat every 15 s with firmware, build, heap, RSSI; online within 45 s;
  rate limits; sessions) stays as implemented and documented in `CLOUD_WIFI_OTA.md`.

## Phase 3: cloud OTA (one addition)

- `POST /api/builds/stock {demo}`: creates a job whose code is the checked-in stock
  `src/app/user_app.cpp` (compiled in the `ai` environment it takes the v2 branch: quick green
  blink), skipping the model: policy, compile, validation, markers and the job record are exactly
  those of a generated build, so the resulting job deploys through every existing path. This is the
  static blink v1 to v2 cloud deployment the brief asks to verify first. **(my call)**

## Phase 4: preserving the agent

- `shared/AtechBleProv` is part of the protected core: generated code cannot include it
  (`ALLOWED_INCLUDES`), and the source policy already forbids `WiFi*`, `BLE*`, `Preferences`, `nvs_*`.
  The policy gains `AtechBleProv`, `AtechCloudOta`, `AtechWifiLan`, `AtechWifiOta` as forbidden
  identifiers so even a reference by name fails before compiling. **(my call)**
- Required image markers become identity, `ATECH-BUILD:<id>`, `ATECH-CLOUD-AGENT:` and
  `ATECH-PROV:`; a job whose image lacks the provisioning service cannot become ready or be
  deployed.
- NVS namespaces are untouched by any OTA path (only the app slots are written), so identity,
  token, Wi-Fi credentials, server URL and the lock survive updates, as they do today.

## Phase 5: tests and commands

- `builder/test/provision.test.js`: canonical grant string; framing round trips (fragment and
  reassemble, max size, out-of-order rejection); WebCrypto session against a Node reference of
  the board (ECDH P-256, HKDF, AES-GCM with the same AAD and layout) in both directions; the grant
  route (owner 200, other 403, unclaimed 404, bad nonce 400); claim with a token read over BLE.
- `builder/test/dashboard-provision.test.js` (jsdom): block hidden without provisioning; scan fills
  the datalist; join sends `{ssid, pass, url, claim}`; password field cleared and the password absent
  from the log and storage; status polling shows connected and cloud online; claim posted once and
  not for an already-claimed board; locked board obtains a grant; locked without a grant shows the
  BOOT hint; busy board refused.
- `builder/test/jobs.test.js` and `server.test.js`: stock job; owner scoping of build routes.
- `shared/AtechBleProv/prov.test.js`: UUIDs, canonical strings, mbedtls calls, fragment constants,
  no `Serial.print` of the password, marker, wiring in both `main.cpp` files; existing structure
  tests updated (`KNOWN_IDS`, `core.test.js`, `portal.test.js`, `agent.test.js`).
- PlatformIO: `base`, `updated`, `ai` for both demos compile with the size check printed.
- Hardware (attached board): USB flash of the new base image; the board keeps its id and token;
  BLE provisioning handshake, status, scan and refusal paths exercised with a BLE central on the
  Mac; what the owner's Wi-Fi password is needed for is listed as not verified.

## Security review

- Confidentiality of the password: ECDH P-256 ephemeral keys per session, HKDF, AES-256-GCM with a
  random 96-bit IV per message and the opcode as associated data. A passive listener learns nothing.
- Authenticity for an owned board: the grant binds the token, the session nonce and both public
  keys; an active relay fails; a BOOT press is the only other way in.
- Unowned board: first come, first served while the user stands next to it; documented.
- The token leaves the board only inside an authorized encrypted PROVISION reply and is used by
  the browser once to claim. It is never stored in the browser.
- The server URL is validated by the board (https only, length, characters); a lab build accepts
  http with the existing compile-time flag.
- The backend never receives the password or the SSID; it receives the token (as it does today when
  typed) over HTTPS and stores it with mode 0600.
- Build routes are owner-scoped; device and deployment routes already were.
- Not covered: BLE link-layer encryption, signed firmware, flash encryption, multi-user accounts.

## Left to the builder

Exact copy within the stated meaning; CSS for the block; the status polling cadence within the
stated bounds; the Node reference layout; log formats; which structure assertions pin what.

## Appendix: the requester's brief (2026-10-29)

Complete end-to-end cloud OTA for the Atech ESP32-S3 project (primary target `demo1-custom-gatt`,
Vercel dashboard, DigitalOcean Docker backend). Goal: a customer sets up the ESP32 once, connects it
to their normal Wi-Fi, then deploys generated firmware wirelessly from anywhere; no personal
hotspot, repeated serial console token entry, or local LAN access from DigitalOcean. Inspect the
repo first and document what exists; preserve BLE OTA, code generation, board claiming and routes.
Phase 1: reuse Connect Bluetooth in desktop Chrome; dashboard UI for a 2.4 GHz SSID/password,
provisioning through authenticated/encrypted BLE, join and cloud status; BLE provisioning in the
firmware, reusing Espressif secure provisioning where compatible; persist in NVS and reconnect;
provision the cloud API configuration and device authentication securely without serial copying;
an already claimed board is not claimed again; never log, store in browser storage or upload the
Wi-Fi password; no SoftAP, no phone hotspot. Phase 2: HTTPS to the existing API, authenticated
heartbeat and polling about every 15 s, reuse ownership and claim, show real online/offline and
firmware version, secure all routes so customers deploy only to their boards. Phase 3: Deploy uses
the build server, stores firmware, creates a job; the ESP32 polls, downloads over HTTPS, verifies
target, integrity, signature when configured, version and SHA-256, applies OTA to the inactive
partition with rollback on failed boot or health check; reports queued, downloading, installing,
successful, failed; never rely on DigitalOcean reaching the board. Phase 4: generated firmware always
includes networking, device auth, provisioning recovery and cloud OTA; the LLM generates logic into a
controlled template; keep identity and Wi-Fi across OTA; keep Bluetooth as backup; keep generated
code away from OTA and credential storage. Phase 5: test provisioning, reconnection, API auth,
ownership, job lifecycle, validity checks, rollback and build failures; verify static blink v1 to v2
through the cloud before AI firmware; account for Docker and Vercel; never expose keys or tokens in
frontend bundles; give precise commands for the USB flash, Docker redeploy and hardware validation.
Implement incrementally, show changed files, tests and hardware instructions per phase, and never
claim physical validation that did not happen on the connected ESP32.
