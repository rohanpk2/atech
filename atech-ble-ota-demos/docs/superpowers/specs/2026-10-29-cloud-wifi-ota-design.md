# Cloud-initiated, device-pulled Wi-Fi OTA (design)

Date: 2026-10-29. Status: designed from the requester's written brief of 2026-10-29 (quoted in the
appendix). Choices marked **(my call)** were made by the builder because the session ran without
the requester available; each one can be overridden.

## Intent

The hosted dashboard on Vercel talks to the builder backend on the DigitalOcean Droplet. The
backend compiles firmware but cannot reach a board on somebody's home Wi-Fi, so today the hosted
dashboard can only offer Bluetooth (desktop Chrome) or a file download for the board's hotspot
page. This design lets the hosted dashboard **queue a deployment job** and lets the board **pull**
it: the ESP32-S3 makes outbound HTTPS requests to the backend, polls for a pending job, downloads
the image, writes it to the inactive OTA slot, reboots, proves the new build is running, and only
then confirms the boot. Safari and iPhone work because the browser only ever talks to Vercel over
HTTPS with `fetch`.

The user experience: power the board, join it to Wi-Fi once on its hotspot page, claim it in the
dashboard with its pairing token, then every later update is **Generate, Deploy, done**, from any
browser, with the dashboard showing pending, downloading, installing, rebooting, succeeded, offline
or failed.

## Goals

1. Both demos (`demo1-custom-gatt`, `demo2-bleota-library`) gain the same cloud Wi-Fi OTA path
   while their BLE OTA protocols and the existing LAN OTA and hotspot portal keep working.
2. The Droplet never connects to a board. The board initiates every connection, over HTTPS with
   certificate validation.
3. A board is identified by a stable id and authenticated by a per-board secret; the id alone
   authorizes nothing. A dashboard user can only see and deploy to boards they claimed.
4. A board installs only an image that is addressed to it, matches its demo and slot, carries the
   expected build id, hashes to the digest the backend declared, and passes the ESP image check.
   Jobs expire, cannot be replayed, and at most one is active per board.
5. The generated firmware always contains the cloud agent, Wi-Fi credential persistence, the OTA
   partition layout and the recovery path; the backend refuses an image without the agent.
6. The hosted dashboard replaces mDNS discovery with the list of registered boards and their
   last-seen time, and shows the job states above. Bluetooth deploy and the firmware download for
   the hotspot stay.
7. Automated tests cover pairing and ownership, wrong device id, firmware mismatch, offline
   boards, retries, interrupted downloads, duplicate jobs, expired jobs, lost network and reboot
   confirmation. Documentation covers first-time bootstrap and a complete physical checklist.

## Non-goals

- Signed firmware, Secure Boot, flash encryption. Still the production step; still documented.
- Multi-tenant user accounts in the backend. Ownership is keyed by the authenticated dashboard
  principal that the existing sign-in provides (see Security).
- Pushing to the board (WebSockets, MQTT). Polling is simpler, works through NAT and matches
  "device-pulled".
- Cloud-side recovery controls (confirm, rollback, restart) for a board that is only reachable
  through the cloud. **(my call, after the builder check)** The dashboard's "Keep this firmware"
  and "Roll back" buttons stay for boards reachable over the LAN or Bluetooth and are hidden for
  cloud-only boards. Recovery for a cloud board is: the board's own automatic rollback (below),
  or deploying another build. A queued-command channel is a documented follow-up.

## Anti-goals

- Removing the hosted deployment guard and trying LAN requests from the cloud.
- A board that trusts any server (`setInsecure()`), or a server that hands a job to whoever
  presents a board id.
- A job marked "succeeded" because the download finished. Success needs the board back online,
  running the expected build, and the boot confirmed.
- Claiming anything was verified on hardware. No board was attached in this session.

## Constraints discovered during recon

- Toolchain: PlatformIO 6.2.0, `espressif32 @ 8.0.0`, Arduino-ESP32 3.3.x precompiled libs for
  `esp32s3/qio_opi` with `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL=1` (the full Mozilla root
  set is linked in; `NetworkClientSecure::useBuiltinCACertBundle()` enables it),
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=1`, `esp_ota_mark_app_invalid_rollback_and_reboot()`
  available, `CONFIG_SPIRAM_USE_MALLOC=1` with allocations above 4 KiB eligible for PSRAM, but
  `CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC=1`: every TLS session lives in internal DRAM next to NimBLE,
  the Wi-Fi driver and the LAN httpd. The agent therefore holds **one** TLS connection at a time.
- The Droplet terminates TLS in Caddy (Let's Encrypt, ZeroSSL fallback) and forwards only
  `/api/*` to the container. The container requires the dashboard key on every `/api/*` request
  today; device endpoints must be exempt from that check and carry their own authentication.
- Vercel proxies `/api/*` with the key injected and the sign-in header removed. The board cannot
  go through Vercel (Basic auth), so the board talks to the Droplet's public name directly.
- The dashboards are pinned by structure tests on element ids and some copy strings; new ids go
  into both `index.html` files and `KNOWN_IDS`.
- `builder/lib/devices.js` already stores the per-board OTA authorization code (0600) for LAN
  pairing and reports a board online only when probed within 20 s. Unreachable LAN boards make
  `?refresh=1` slow (mDNS and probe timeouts); cloud-only records must not trigger LAN probing.
- Node's HTTP server closes idle keep-alive connections after 5 s by default.

## Architecture

```
Safari/Chrome ──HTTPS──▶ Vercel (sign-in, static dashboards, /api proxy + key + x-atech-user)
                                        │ HTTPS
                                        ▼
                         Droplet: Caddy ─▶ builder container (Node)
                           /api/*         ├─ dashboard routes: key + owner  (builds, devices, deployments)
                                          └─ device routes: per-board auth (/api/device/*)
                                                   ▲ HTTPS, outbound only, cert validated
ESP32-S3 (home Wi-Fi) ── AtechCloudOta agent task ─┘
   login (HMAC proof) → poll → claim job → download → flash inactive slot → reboot → report → confirm
```

Nothing in the browser addresses the board. Nothing on the Droplet addresses the board. The LAN
OTA path (backend on the same network) and Bluetooth remain exactly as they are for local use.

## Identity, pairing token and ownership

- **Board id**: `ATECH-<12 hex MAC>` from the eFuse MAC (exists).
- **Pairing token**: the per-board OTA authorization code the hotspot portal already generates
  at first boot (24 characters from a 57-symbol alphabet, about 140 bits), stored in NVS, printed
  on the serial console at boot and never shown by any HTTP endpoint. **(my call)** Reusing it keeps
  one secret per board, already documented, already the LAN pairing secret. It is the pre-shared
  key between board and backend for the cloud path too.
- **Claiming**: the dashboard user enters board id + pairing token (+ optional name). The backend
  stores the token (0600 file, as today) with `ownerId` = the authenticated principal. If the
  board has already contacted the backend (it logs in every 30 s while unclaimed and leaves a
  commitment `HMAC(token, login message)`), the claim verifies the token immediately and fails
  with a clear message on mismatch. If the board has not contacted the backend yet, the claim is
  stored as "waiting for the board" and verified at its first login; a mismatch is shown on the
  device row ("the board's code differs from the one entered").
- **Principal**: `x-atech-user` request header when the backend runs with a dashboard key (the
  Vercel route transform sets it to `$ATECH_DASHBOARD_USER`; anyone holding the key is already the
  trusted proxy); `local` when there is no key, and also when the key is presented without the
  header (an operator on an SSH tunnel). Records with `ownerId: null` (simulated boards) are visible to
  everyone. Device lists, claim, forget, control, deployment create/list/abort are all filtered or
  refused by owner. **(my call)** This is honest about what the existing single-user sign-in can
  provide while making every ownership check real and tested with two principals.

## Device authentication and anti-replay

- `GET /api/device/challenge?id=` returns a 16-byte nonce (90 s, single use, four per board).
- `POST /api/device/login` carries id, nonce, identity fields and
  `proof = HMAC-SHA256(token, "atech-cloud-login/1\n<id>\n<nonce>\n")`. A claimed board with a
  valid proof receives a **session token** (24 random bytes, 24 h, bound to the id, at most four
  live per board; in memory, so a backend restart just makes boards log in again). An unclaimed
  board gets 403 `unclaimed` and its login is recorded as a pending registration (memory only,
  bounded, informational: the dashboard shows "waiting to be claimed"). A claimed board with a bad
  proof gets 401 and the record notes the failure.
- Every other device request is `Authorization: Bearer <session>`. TLS protects the token on the
  wire; the dashboard never sees it.
- Replay: nonces are single use; a job id is random (12 bytes) and single use through its state
  machine; the board remembers the last completed job id in NVS and ignores it if offered again;
  the download endpoint only serves a job that is in `downloading` state for the authenticated
  board; status reports are accepted only from the board the job addresses.
- Rate limit: challenge and login are limited per IP and per id (token bucket). Pairing tokens are
  long enough that this is a nuisance control, not the security boundary.
- The canonical HMAC strings live in `builder/lib/cloud-auth.js` and the firmware; a structure
  test pins them byte for byte, like the LAN ones.

## Deployment job lifecycle (backend `lib/cloud-ota.js`)

States: `pending`, `downloading`, `installing`, `rebooting`, `succeeded`, `failed`, `cancelled`.
`offline` is derived: a `pending` job whose board has not polled within the offline window
(3 × poll interval, 45 s by default) is shown as offline; it stays pending until it expires.

- **create** (`POST /api/builds/:id/deploy {deviceId, via: 'cloud'}`): build must be `ready`;
  board must be claimed by the caller; `job.demo === board.demo`; build unbound or bound to this
  board; image ≤ board's reported slot size (when known) and ≤ configured slot minus margin;
  image contains the demo identity, `ATECH-BUILD:<id>` and `ATECH-CLOUD-AGENT:` markers; no other
  active job for the board (409, "duplicate"). The job gets `expiresAt = now + 30 min`
  **(my call)**.
- **claim** happens inside the board's poll: `POST /api/device/poll` with its status snapshot
  (`build, pending, safe, up, loops, rssi, ready`); when `ready=1` (no other OTA transport owns
  flash) and a pending job exists for this board, the backend moves it to `downloading` and returns
  the manifest (job id, build id, size, SHA-256, demo, app name/version, download path).
- **download**: `GET /api/device/jobs/:id/firmware` serves the image with `Content-Length`,
  `X-Atech-SHA256`, `X-Atech-Build` and honours `Range: bytes=a-b` (206 with `Content-Range`;
  416 when out of range). The board fetches it in 128 KiB ranged chunks over one kept-alive TLS
  connection and posts a progress report between chunks on the same connection, so the dashboard
  gets a real bar without a second TLS session. A dropped connection is resumed from the last
  byte the board wrote (the OTA handle stays open); the backend counts reconnects as attempts and
  the board gives up after five transport failures in one job. A 200 answer to a ranged request
  at offset zero is accepted; at any other offset it restarts the sink from zero. **(my call,
  after the builder check)**
- **reports**: `POST /api/device/jobs/:id/status` with `phase=downloading|installing|rebooting|
  succeeded|failed`, `received`, `total`, `error`. The backend records progress, timings and
  `lastReportAt`.
- **reboot confirmation**: before restarting, the board persists `{job id, expected build id}` in
  NVS. After reboot it logs in and polls with `boot_job`, `boot_build`, `safe` and `loops`. The
  backend compares the running build with the job's build: match and not in safe mode → answers
  `ack=<job> action=confirm`; the board waits until its app loop has run at least once, calls
  `confirmBoot()` (cancels the bootloader rollback) and reports `succeeded`; the job becomes
  `succeeded` with `after.build`. Mismatch (the bootloader rolled back) → `failed`
  ("rolled back to build X") and `action=clear`. Expected build but safe mode → `failed`
  ("booted into safe mode") and `action=rollback`, which makes the board call
  `esp_ota_mark_app_invalid_rollback_and_reboot()`. A job the backend had already failed by a
  timeout but whose board then reports the expected build is moved to `succeeded` with a note
  ("succeeded after the timeout"), because that is what happened. **(my call)**
- **timeouts** (backend tick every 5 s, injectable clock): pending past `expiresAt` → failed
  (`expired`); downloading/installing with no report for 120 s → failed (lost contact);
  rebooting for more than 5 min without the board coming back → failed; a confirm acknowledged but
  no `succeeded` within 2 min → failed. All **(my call)**, configurable through `ATECH_CLOUD_*`
  env variables.
- **cancel**: `POST /api/deployments/:id/abort` cancels a `pending` job only; a job the board
  already claimed cannot be stopped from the cloud (409 with that message).
- Jobs persist in `<buildsDir>/cloud-deployments.json` so a backend restart does not lose a
  pending job; the dashboard follows a job through the existing `/api/deployments/:id` (poll) and
  `/api/deployments/:id/events` (SSE) routes, which now serve both LAN and cloud deployments.

## Device side

### New shared library `shared/AtechCloudOta` (protected core, never generated)

- Configuration: demo, image identity marker, firmware string, app name/version, compiled-in
  default server URL (`ATECH_CLOUD_URL` build flag, empty by default), NVS namespace
  `atech_cloud`, callbacks for the pairing token, "other OTA busy" and "Wi-Fi connected", poll
  interval (15 s default, the server can adjust it per response), confirm timeout (3 min).
- Server URL precedence: NVS value set on the hotspot portal wins; otherwise the compiled-in
  default; neither → agent idle, logged once at boot. Only `https://` is accepted unless the
  firmware is compiled with `ATECH_CLOUD_ALLOW_HTTP=1` (lab use against a local backend; printed as
  a warning at every boot). **(my call)**
- Runs on its own FreeRTOS task (core 0, priority 2, 12 KiB stack) because TLS connects and the
  download block for seconds and the main loop must keep servicing BLE, the LAN service and the
  hotspot portal. One `NetworkClientSecure` + `HTTPClient` pair, kept alive (`setReuse`), used
  for login, poll, every ranged firmware chunk and every status report in turn; never two TLS
  sessions at once (internal DRAM, see constraints). Built-in root bundle, 10 s connect timeout,
  15 s read timeout, no redirects. Every report carries the free and minimum-ever internal heap
  so the physical checklist can watch memory during a transfer.
- Wire format to the device: `text/plain` lines `key=value` (no JSON parser needed on the board);
  the device sends `application/x-www-form-urlencoded`. **(my call)** Documented as the device
  protocol; the dashboard keeps JSON.
- Image sink (`AtechImageSink`): `esp_ota_begin` on the inactive slot, streaming SHA-256,
  ESP header check on the first 36 bytes (magic, chip id 9, 16 MB flash, app descriptor), KMP
  scanners for the demo identity, `ATECH-BUILD:<id>` and `ATECH-TARGET:<own id or empty>`, exact
  size, `esp_ota_end` (ESP image validation), then and only then `esp_ota_set_boot_partition`.
  Same rules as the LAN service; implemented in the new library rather than refactoring the LAN
  one, to keep the verified LAN code untouched **(my call)**.
- Exclusivity: `coreTryAcquireOta("cloud")`, `coreSuspendApp()` during the transfer, and the
  demos' busy checks include `cloudOta.isTransferring()` (BLE START, hotspot upload and the LAN
  begin all refuse while the cloud transfer owns flash; BLE advertising pauses like for LAN).
- Boot marker and rollback: `begin()` reads the NVS marker. If present it asks the core to hold
  its automatic confirmation (new `holdAutoConfirm` callback in `AtechCoreConfig`), logs in,
  reports `boot_job`, and acts on the ack. If the board cannot get an acknowledgment within the
  confirm timeout while the image is still `PENDING_VERIFY`, it calls
  `esp_ota_mark_app_invalid_rollback_and_reboot()`: a cloud-deployed image that cannot reach the
  cloud is treated as broken and the previous image returns. Images deployed over BLE or LAN keep
  the existing policy (auto-confirm after 20 s with the app loop running). **(my call)**
- A marker is embedded (`ATECH-CLOUD-AGENT:1`) and referenced at boot so the backend can prove the
  agent is linked into every image.

### Core and existing libraries

- `AtechCore`: `holdAutoConfirm` callback; version 1.2.0.
- `AtechWifiLan`: optional `extraIdentity` callback so `/api/identity` can carry a `cloud` object
  (url, state, last contact, last error) for the local dashboard. Protocol otherwise unchanged.
- `AtechWifiOta` (hotspot portal): a **Cloud** card showing the effective server URL and state,
  with "Save server URL" and "Use the built-in default", all behind the OTA authorization code.
  The Wi-Fi password and SSID stay on the board; the cloud only ever receives connection state and
  signal strength. New routes `/api/cloud/status`, `/api/cloud/save`, `/api/cloud/clear`.
- `main.cpp` of both demos: construct and start the agent, extend the busy checks, pause BLE
  advertising during a cloud transfer, pass `ATECH_CLOUD_URL`. BLE protocols untouched.

### Board configuration and image size

- `platformio.ini` (both demos, and therefore the AI workspace copy): keep `esp32-s3-devkitc-1`,
  `16MB`, `qio_opi`, `-DBOARD_HAS_PSRAM`; add `board_build.flash_mode = qio`, an explicit
  `board_upload.maximum_size` equal to the OTA slot (6 MiB) and a post-build script
  `shared/tools/check_ota_size.py` that reads `partitions.csv`, asserts both app slots are equal
  and fails the build when `firmware.bin` exceeds the slot minus a 64 KiB margin, printing the
  numbers. The backend's `rewritePlatformioIni` makes that path absolute in the workspace.
- `builder/lib/partitions.js` parses `partitions.csv`; `config.slotSize` comes from it; a test
  pins that both demos share the same table with two 6 MiB app slots.
- Build validation adds the `ATECH-CLOUD-AGENT:` marker to the required markers, so a job whose
  image lacks the agent fails validation instead of being deployable.
- `ATECH_PUBLIC_URL` (backend env, the Droplet's `https://` name) is baked into the `[env:ai]`
  build flags as `ATECH_CLOUD_URL` and into the installer's base build, so generated images and the
  USB baseline know the server without any portal typing. The portal can still override it.

## Backend changes (summary)

| Path | Change |
| --- | --- |
| `lib/cloud-auth.js` | canonical login message, kv serializer/parser, session token helpers |
| `lib/cloud-devices.js` | nonces, pending registrations, login/session, claim verification, rate limits, last-seen bookkeeping |
| `lib/devices.js` | `ownerId`, `cloud` fields, owner-filtered `list`, `describe` with cloud online state, skip LAN probing for cloud-only records |
| `lib/cloud-ota.js` | the job store: create, claim-on-poll, ranged firmware stream, status reports, boot acknowledgment, timeouts, late success, persistence, subscribe |
| `lib/fake-cloud-device.js` | a Node simulation of the agent (login, poll, download, report, reboot) with fault injection; used by tests and by `ATECH_SIMULATED_DEVICE` so the hosted dashboard shows cloud boards without hardware |
| `lib/partitions.js` | partition table parsing |
| `lib/workspace.js`, `lib/installer.js`, `lib/jobs.js`, `lib/image.js` | cloud URL build flag, absolute `extra_scripts`, agent marker, slot size from the table |
| `lib/config.js` | `publicUrl`, `ATECH_CLOUD_*` timings |
| `server.js` | `/api/device/*` (no dashboard key, per-board auth), claim/unclaimed listing, deploy `via`, unified deployment routes, principal, keep-alive timeout |

## Dashboard changes (`web-shared/atech-builder.js`, both `index.html`)

- Step 1: registered boards with last-seen ("Online via the cloud, seen 4 s ago" / "Offline,
  last seen 2 h ago"), unclaimed boards with a **Claim** button, a claim form (board id, pairing
  token, name). `Find devices` and the LAN pair form stay for local mode; hosted hides them.
  New ids: `devClaimForm`, `devClaimId`, `devClaimToken`, `devClaimName`, `devClaim`,
  `devClaimOpen`.
- Step 1 also hides "Keep this firmware" and "Roll back" for a board that is only reachable
  through the cloud (no command channel; see non-goals).
- Step 3: the first method card reads "Cloud Wi-Fi" when the selected board is cloud-registered
  (and the deploy request carries `via: 'cloud'`), "Wi-Fi" for LAN. A claimed board that is
  offline can still be given a job; the card says so and the deployment shows `offline` until the
  board polls. Cloud phases: Queued, Download, Install, Reboot, Done; progress from the board's
  reports; failed and cancelled; stage text per state.
- Bluetooth and the hotspot download are unchanged. Safari and iPhone use the cloud path with
  `fetch` only.
- Hosted copy no longer says cloud Wi-Fi is unavailable; the structure and jsdom tests that pinned
  that copy are updated to the new copy.

## Vercel and Droplet

- `vercel.json`: one more request-header transform, `x-atech-user = $ATECH_DASHBOARD_USER`.
- `deploy/builder.env.example`, `deploy/README.md`: `ATECH_PUBLIC_URL`, the device endpoint
  (`https://<ATECH_PUBLIC_HOST>/api/device/*` needs no key), timings, rate limits.
- Caddy keeps forwarding `/api/*` only. Device requests are small except the firmware download,
  which flows backend → Caddy → board.

## Security review

- Board id alone authorizes nothing: login needs the HMAC proof keyed with the pairing token;
  later calls need the session token; the download needs the session of the board the job names.
- Wrong board: the job is addressed to one board id; the backend only hands it to that board's
  session; the image's own `ATECH-TARGET` marker is checked by the board; the build record's
  bound device id is checked at create.
- Firmware integrity: SHA-256 declared by the backend and verified on the board over the stream,
  plus ESP image validation by `esp_ota_end`, plus the demo and build markers.
- Compatibility: demo match, slot size, chip id, flash size header, app descriptor.
- Replay: single-use nonces, single-use job ids with expiry, last-completed job remembered on the
  board, state machine refuses out-of-order reports.
- Transport: HTTPS with the built-in root bundle; plain HTTP only with a compile-time flag that
  prints a warning. Wi-Fi password and SSID never leave the board.
- Ownership: every dashboard device and deployment route checks the principal against the record.
- Not covered: signed images, flash encryption, per-user accounts, DoS beyond simple rate limits.

## Testing

- `builder/test/cloud.test.js` (store level, fake board): pairing with wrong and right token,
  ownership with two principals, wrong device id, demo and bound-device mismatch, digest
  mismatch at the board, offline then online, interrupted download with retry, retry exhaustion,
  duplicate job, expired job, lost network during download, reboot confirmation success, rollback
  detected, board never returns, cancel.
- `builder/test/cloud-server.test.js`: device routes without the dashboard key, dashboard routes
  still gated, rate limit, claim routes, unified deployment routes and SSE, simulated cloud boards.
- `builder/test/dashboard-cloud.test.js` (jsdom): hosted registered list and last-seen, claim
  flow, cloud deploy posts `via: 'cloud'`, every state renders, offline badge, Bluetooth still
  offered, download fallback present, Safari path.
- Structure tests: `shared/AtechCloudOta/agent.test.js` (canonical strings, markers, main.cpp
  wiring), updates to `core.test.js`, `portal.test.js`, `atech-builder.test.js`,
  `vercel-config.test.js`.
- Firmware: `pio run -e base -e updated -e ai` for both demos must succeed with the size check
  printed.
- Hardware: nothing. The physical checklist is documented, not executed.

## Documentation

- `CLOUD_WIFI_OTA.md`: architecture, protocol, security, bootstrap (USB installer or existing BLE
  OTA), claiming, the physical end-to-end checklist, status table of what was and was not
  verified.
- README, AI_FIRMWARE_BUILDER (API table), WIFI_LAN_OTA (status line), vercel-frontend README,
  deploy README, `.env` templates.

## Decisions after the builder check (2026-10-29)

A fresh reviewer read this document against the code and asked two questions; both are answered
above and summarised here.

- **No cloud recovery controls.** Confirm/rollback/restart for cloud-only boards would need a
  queued-command channel with its own acks, timeouts, owner checks and simulation. Out of scope;
  the buttons are hidden for such boards; the board rolls back on its own when a cloud-deployed
  image cannot report; the dashboard offers "deploy another build".
- **One TLS session, ranged chunks.** The pinned libs allocate TLS in internal DRAM, so the agent
  never opens two sessions. The download is split into 128 KiB range requests on one kept-alive
  connection with a status post between chunks; interrupted downloads resume from the last
  written byte; the dashboard still gets a real progress bar.

## Left to the builder

Exact copy within the stated meaning; test file layout; kv key names beyond those listed; CSS for
the new rows; the exact backoff schedule of the agent (bounded between 5 s and 2 min); log
formats.

## Appendix: the requester's brief (2026-10-29)

Implement cloud-initiated, device-pulled Wi-Fi OTA deployment in the existing repository for both
demos. Inspect the current architecture before editing. Keep existing BLE OTA and firmware
generation working. Architecture: Vercel dashboard creates deployment jobs via the DigitalOcean
builder API; the ESP32-S3 initiates outbound authenticated HTTPS requests to poll for pending
jobs, download a compatible image, flash the inactive OTA partition, reboot and report status;
never make the Droplet call a private LAN IP. Add Wi-Fi provisioning using the board's existing
SoftAP page, storing credentials in NVS without forwarding them to the cloud. Provide a stable
board id and secure pairing token; board ids alone must not authenticate. Add backend APIs for
registration/pairing, artifact retrieval, deployment creation, polling/claiming and status.
Require authentication and board ownership authorization; HTTPS with certificate validation,
per-board credentials, firmware integrity verification, device/build compatibility checks,
expiration, protection against unauthorized or replayed deployments. Generated firmware always
includes the shared agent, Wi-Fi persistence, OTA partition configuration and recovery; keep both
BLE implementations intact; configure 16 MB flash and 8 MB PSRAM; verify OTA partition size
against compiled images; safe rollback. Hosted dashboard: Cloud Wi-Fi Deploy queues a job and
shows pending, downloading, installing, rebooting, succeeded, offline, failed; registered-device
list with last-seen replaces mDNS discovery; keep BLE deploy and the download fallback; Safari and
iPhone through the cloud path. Tests for pairing/ownership, wrong device id, firmware mismatch,
offline devices, retries, interrupted downloads, duplicate deployments, expired jobs, lost network,
reboot confirmation. Document first-time bootstrap (USB or existing BLE OTA) and a complete
physical end-to-end checklist. Do not claim physical testing unless performed.
