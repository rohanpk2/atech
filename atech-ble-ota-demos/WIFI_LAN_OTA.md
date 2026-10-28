# Wi-Fi primary OTA with Bluetooth fallback

**Status (2026-10-28):** implemented and compiled for both demos (`base`, `updated`, `ai`), covered by automated tests against a protocol-accurate simulated board, and driven end to end in Chrome against that simulated board. **No ESP32-S3 was attached during this work.** Nothing below was flashed, joined to a real Wi-Fi network, transferred over a real radio, rebooted, rolled back or timed on hardware. Every number in this document that comes from the simulation is labelled as such.

The target experience:

**Power the ESP32 -> join it to Wi-Fi once -> open the Atech dashboard in Safari or Chrome -> type a prompt -> Generate -> Deploy -> the board runs the new firmware.**

After the one-time Wi-Fi setup no cable, no Web Bluetooth and no Web Serial are needed.

## 1. Architecture

```
Safari / Chrome (any device on the LAN)        builder backend (Mac, Node)                ESP32-S3
  dashboard  --same origin fetch/SSE-->  /api/builds, /api/devices,  --HTTP + HMAC-->  AtechWifiLan service :8080
             <-- progress events --      /api/deployments           <-- JSON ------   (esp_http_server task, core 0)
             --Web Bluetooth (backup)--------------------------------------------->  custom GATT / gb88 BLEOTA
             --hotspot portal (last resort, manual)--------------------------------->  AtechWifiOta SoftAP :80
```

**The browser never talks to the board over Wi-Fi.** It asks the builder backend, which already holds the validated `firmware.bin`, to deploy it. This is deliberate:

- An `http://localhost:5173` or `http://<mac-ip>:5173` page fetching `http://<board-ip>:8080` is a cross-origin request. It would need CORS on the board, it is subject to Chrome's Local Network Access checks, and an HTTPS-hosted dashboard would be blocked outright by mixed-content rules. Safari adds its own local-network restrictions. None of that applies to a same-origin call to the backend.
- The backend measures the transfer precisely, keeps the per-device secret off the browser, and can stream over a keep-alive TCP socket with large chunks, which a browser cannot be made to do reliably across Safari and Chrome.
- The same code path works in Safari on macOS and iOS, Chrome on macOS, Windows and Android, with no browser flags and no disabled security checks.

The backend is a local process on the user's computer; there is no cloud dependency.

## 2. What changed

### Firmware (protected core; never AI-generated)

| Path | Change |
| --- | --- |
| `shared/AtechWifiLan/` (new) | Station-mode Wi-Fi with NVS credentials and auto-reconnect, mDNS advertisement, and the authenticated LAN OTA service on `esp_http_server` (own task, core 0, priority 5, 16 KiB receive buffer, keep-alive). |
| `shared/AtechWifiOta/` | Hotspot portal gains the **Home Wi-Fi** card (scan, join, forget) behind the OTA authorization code, runs in AP+STA mode when a home network is configured, and refuses uploads while a LAN transfer owns flash. `otaToken()` accessor shares the per-device secret with the LAN service. |
| `shared/AtechCore/` | `coreTryAcquireOta/coreReleaseOta/coreOtaOwner`: one flash writer at a time across BLE, hotspot and LAN; `otaOwner` in the identity JSON; core version 1.1.0. |
| `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp` | Start the LAN service, embed `ATECH-TARGET:<device id>` next to `ATECH-BUILD:<id>`, pause BLE advertising during a LAN transfer, include the LAN transfer in every busy check, Demo 1 takes the flash lock for its BLE OTA, Demo 2 skips `BLEOTA.process()` during a LAN transfer. |

### Backend (`builder/`)

| Path | Change |
| --- | --- |
| `lib/lan-auth.js` | Canonical HMAC messages shared with the firmware. |
| `lib/mdns.js` | Dependency-free mDNS querier (PTR/SRV/TXT/A, name compression). |
| `lib/lan-client.js` | Small HTTP client with timeouts, keep-alive agent and readable errors. |
| `lib/devices.js` | Device registry `.ai-builds/devices.json` (mode 0600): discover, probe, pair by HMAC echo, refresh by mDNS/hostname, control. |
| `lib/lan-ota.js` | Deployment engine: preflight, challenge, begin, chunked upload, finish, reboot wait, verification, confirm; progress, speed, ETA and separate timings. |
| `lib/fake-device.js` | Simulated board implementing the same protocol, used by tests and by `ATECH_SIMULATED_DEVICE`. |
| `server.js`, `lib/config.js` | `/api/devices/*`, `/api/builds/:id/deploy`, `/api/deployments/*` (SSE), optional dashboard key, simulated boards. |

### Dashboard (`web-shared/`, both demos)

| Path | Change |
| --- | --- |
| `web-shared/atech-builder.js` | Device panel, builder card, deployment panel with Wi-Fi > Bluetooth > hotspot selection, one **Deploy** button, progress / KiB/s / ETA / phases / checks, dashboard key handling. |
| `web-shared/builder.css` | Styles for the new panels. |
| `demo*/web/index.html` | New layout; demo-specific Bluetooth controls moved under **Advanced**; hotspot instructions now include the home Wi-Fi setup. |
| `demo*/web/app.js` | Transport switch removed (the shared panel owns it); BLE OTA reports progress and phases to the panel. Bluetooth protocols unchanged. |

## 3. How Wi-Fi provisioning works

1. Power the board. Without stored credentials it logs `no home Wi-Fi configured` and keeps advertising over BLE.
2. Hold **BOOT** for about three seconds. The board starts its WPA2 hotspot `Atech-OTA-D1-<suffix>` / `Atech-OTA-D2-<suffix>` exactly as before (random per-device WPA2 password and OTA authorization code, printed at 115200 baud at every boot; the USB installer's console shows them).
3. Join the hotspot and open `http://192.168.4.1` in Safari or Chrome. Enter the OTA authorization code in the **Authorization** card. The code gates every provisioning call; the portal never shows a secret.
4. In **Home Wi-Fi**, tap **Scan**, pick the 2.4 GHz network (5 GHz networks cannot be joined by the ESP32-S3 and are not listed), enter its password and tap **Join this network**. The password is sent only over the WPA2 hotspot link and stored in the board's NVS (`Preferences` namespace `atech_wifi`). It is never echoed back.
5. The hotspot switches to AP+STA mode so the page can report the result: `Connected to <ssid> as <ip> (atech-<suffix>.local)`. Leave the hotspot (or let it time out after ten minutes); the board stays on the home network.
6. From then on the board joins the stored network at every boot, disables Wi-Fi modem sleep for throughput, sets the hostname `atech-<suffix>`, enables Arduino auto-reconnect and retries on its own every 15 s if the link drops. mDNS advertises `_atech-ota._tcp` on port 8080 with `id`, `suffix`, `demo`, `fw` and `proto` TXT records.
7. **Forget home Wi-Fi** on the portal erases the credentials and returns the radio to the original behaviour.

Credentials live in plain NVS, like the existing hotspot credentials. Enabling flash encryption is the production step; it is out of scope here and noted in section 9.

## 4. How Wi-Fi deployment works

### Pairing (once per board)

The dashboard's device panel runs **Find devices** (mDNS scan, about two seconds). A board that answers but is not paired shows **Pair**; enter its IP (prefilled) and the OTA authorization code. The backend proves the code with an authenticated echo (section 5) and stores it in `.ai-builds/devices.json` with mode 0600. The code never crosses the LAN. If discovery fails (mDNS blocked by the router), type the IP address or `atech-<suffix>.local` manually; the hotspot portal shows the IP after the join.

### Deploy

1. **Generate** binds the build to the selected board (`deviceId`), as it did for a Bluetooth-connected board.
2. **Deploy** picks the method: Wi-Fi when the selected board is paired and reachable, Bluetooth when Web Bluetooth has a connected board, otherwise the hotspot instructions. The user can force any available method with the three method cards; the choice is shown on the button ("Deploy over Wi-Fi").
3. The backend runs the deployment and streams it over SSE:
   - **preflight**: artifact size and SHA-256 match the build record; identity read from the board; same device id, same demo, image fits `slotSize`, no other flash owner.
   - **challenge + begin**: `GET /api/ota/challenge` gives a 16-byte nonce (90 s, single use). `POST /api/ota/begin` carries `X-Atech-Device`, `X-Atech-Nonce`, `X-Atech-Size`, `X-Atech-SHA256`, `X-Atech-Build` and `X-Atech-Auth = HMAC-SHA256(secret, "atech-ota-begin/1\n<device>\n<nonce>\n<size>\n<sha256>\n<build>\n")`. The board verifies the HMAC before touching flash, takes the flash lock, erases the inactive slot (`esp_ota_begin` with the declared size) and returns a single-use session id.
   - **uploading**: 128 KiB `PUT /api/ota/chunk?offset=N` requests on one keep-alive socket; each answer carries the bytes the board has written to flash, so the percentage, KiB/s and ETA on the dashboard are device-acknowledged values. Chunks are written straight into `esp_ota_write`; nothing is buffered beyond the 16 KiB receive buffer.
   - **finishing**: `POST /api/ota/finish`. The board checks completeness, the ESP header (magic, chip id 9, 16 MB flash header, app descriptor), the demo identity marker, `ATECH-BUILD:<id>`, `ATECH-TARGET:` (empty or its own id), the SHA-256 of the stream, then `esp_ota_end` (ESP image validation) and only then `esp_ota_set_boot_partition`. Any failure calls `esp_ota_abort`, releases the lock, resumes the app and reports the reason.
   - **rebooting**: the board restarts 1.5 s after answering. The backend waits, then polls the identity; it accepts the answer only when the reported uptime proves a fresh boot, re-resolving the address by mDNS if the DHCP lease changed.
   - **verifying**: same device id, `build` equals the expected build id, not in safe mode, the app loop counter advances, an authenticated echo answers.
   - **confirming**: authenticated `confirm` cancels the bootloader rollback. The deployment is **verified** only after this; any earlier failure leaves the image pending, and the next reset returns to the previous firmware.
4. The panel shows the transfer time, reboot time and verification time separately. **Abort** during preflight or upload sends `POST /api/ota/abort`; the board discards the partial image.

### Bluetooth fallback

Unchanged protocols: Demo 1 custom GATT, Demo 2 gb88 BLEOTA. The shared panel calls the demo's `deployBytes` with progress and phase callbacks, then runs the existing identity, build id, loop counter, echo and confirm checks. Bluetooth is offered when Web Bluetooth exists and a board is connected; it is never started automatically after a failed Wi-Fi transfer. The message says, for example, "Wi-Fi deployment not verified: ... Bluetooth is available: choose it above and click Deploy again."

### Hotspot

Unchanged device-hosted portal. The dashboard's hotspot card now also documents the home Wi-Fi setup, and the Deploy button turns into a download when nothing else is available.

### Exclusivity

One writer at a time. The LAN service takes `coreTryAcquireOta("lan")` and refuses when BLE OTA (`updating` / `BLEOTA.isRunning()`) or a hotspot upload is active; Demo 1's BLE START takes the same lock; the hotspot upload refuses while the LAN transfer owns flash; Demo 2 does not service gb88 while a LAN transfer runs. A merely connected BLE client does not block Wi-Fi deployment; Demo 1 commands answer `Busy` during the transfer. BLE advertising pauses during the transfer and resumes afterwards. The app task is suspended only for the duration of the transfer.

## 5. Security review

- **Device IDs and pairing codes never authorize anything.** Every begin and control request needs an HMAC over the device id, a fresh device-issued nonce and (for uploads) the size, digest and build id, keyed with the per-device OTA authorization code. Tests cover: wrong code, device id without code, replayed nonce, wrong device id, declared digest not matching the stream, image carrying another build id, image built for another board, wrong-demo image, non-ESP32-S3 image.
- **No reusable secret on the wire.** The code itself is only ever typed into the hotspot portal (WPA2 link) or the dashboard (same-origin to the local backend). A captured upload session id lets an attacker inject bytes into one transfer, which then fails the digest check.
- **Replay** is defeated by single-use nonces with a 90 s lifetime (four outstanding at most).
- **Wrong board** is caught three times: the HMAC binds the device id, the build record binds the device id, and the image's own `ATECH-TARGET` marker is checked by the receiving board.
- **Transport confidentiality** is not provided: firmware bytes travel in clear over the LAN, as they already do over BLE and the hotspot. The pinned ESP-IDF libs include `esp_https_server` and ECDSA, so moving the service to TLS with a per-device self-signed certificate pinned by the backend at pairing time is a contained follow-up (same handlers, `httpd_ssl_start` instead of `httpd_start`). Expect a one-second handshake and lower throughput on the ESP32-S3.
- **Backend exposure.** Bound to `127.0.0.1` by default. With `--host 0.0.0.0` (needed for phones) a dashboard key is generated and printed in the URL; every `/api/*` call must carry it (header, query or the cookie the dashboard sets). Treat the backend as a developer tool on a trusted LAN; it still has no user accounts.
- **Rate limiting** of challenge requests is not implemented; the nonce pool is bounded so this is a nuisance, not a bypass.
- **Flash encryption / Secure Boot / signed images** remain the production requirements listed in the README.

## 6. Safari and Chrome

| Browser | Wi-Fi deploy | Bluetooth backup | Hotspot |
| --- | --- | --- | --- |
| Safari on macOS | Yes (same-origin backend) | No Web Bluetooth | Yes |
| Safari on iPhone/iPad | Yes, open the LAN link the backend prints (`--host 0.0.0.0`, with key) | No | Yes |
| Chrome on macOS/Windows | Yes | Yes | Yes |
| Chrome on Android | Yes via the LAN link | Web Bluetooth exists, untested here | Yes |

Investigated constraints: cross-origin requests to the board (CORS), Chrome Local Network Access, mixed content for HTTPS-hosted dashboards. All are avoided by never fetching the board from the browser. The dashboards use `fetch`, `EventSource` and cookies only; `EventSource` cannot carry headers, which is why the key is also accepted as a cookie or query parameter. Verified in this session: the pages were driven in Chrome 156 against the simulated boards. Safari was not driven by automation; the jsdom tests cover the no-Web-Bluetooth path (`dashboard-deploy.test.js`), and nothing Safari-specific is used.

## 7. Performance

The Bluetooth path measured earlier runs at roughly 1.9 KiB/s (about 12 minutes for 1.36 MiB). Realistic expectations for the LAN path on the ESP32-S3 with the pinned Arduino-ESP32 3.3.12 build:

- `CONFIG_LWIP_TCP_WND_DEFAULT=5760` and `TCP_MSS=1436` are compiled into the precompiled libraries and cannot be changed from this project; the window caps throughput at about `5760 / RTT` bytes per second, which for a 5 ms LAN RTT is still above 1 MB/s.
- Flash erase of the whole image happens in `esp_ota_begin` (reported as `erase_ms` in the begin response, shown in the deployment timings); writes are sequential 16 KiB blocks.
- Modem sleep is disabled, BLE advertising is paused and `esp_coex_preference_set(ESP_COEX_PREFER_WIFI)` is applied during a transfer.
- Reports from comparable `esp_http_server` OTA receivers are typically 200 KiB/s to 800 KiB/s, which puts a 1.36 MiB image at 2 s to 7 s. **This is an expectation, not a measurement.** Measure it with `BENCHMARKING.md` and the `transfer_ms` value the board reports (`deployTime` on the dashboard, `timings.transferMs` and `timings.deviceTransferMs` in `/api/deployments/:id`), which excludes compilation, erase, reboot and verification.

Simulated-board numbers (Node to Node on loopback) are meaningless for hardware and are not reported as results.

Tuning knobs: `ATECH_LAN_CHUNK_BYTES` (default 128 KiB; the board accepts up to 256 KiB per request), `RECV_BUFFER_BYTES` in `AtechWifiLan.cpp`, and the httpd task priority/core in `startServer()`.

## 8. Automated test results (2026-10-28)

Simulated/automated only. `cd builder && npm test`: 100 tests, 99 passed, 1 skipped (the real-compile test, enabled with `ATECH_REAL_BUILD=1`). New files: `test/lan.test.js` (18 tests: HMAC, mDNS, pairing, replay, digest, full deployment, bound device, wrong demo, wrong target, invalid image, interrupted upload with retry, abort, rollback / hung app / safe mode after reboot, unreachable board with mDNS refresh, discovery), `test/lan-server.test.js` (routes, SSE, key gate, simulated boards), `test/dashboard-deploy.test.js` (jsdom: Wi-Fi first, Bluetooth backup, Safari copy, failure never auto-switches, bound-device blocking, key banner).

Per-module tests (`node <file>`): all nine pass, including the updated `core.test.js`, `portal.test.js` and both `dashboard.test.js`.

PlatformIO: `base`, `updated` and `ai` compile for both demos (Demo 1 image 1.52 MB, Demo 2 1.53 MB of flash).

Not run: `WIFI_OTA_TESTING.md` hardware matrix, real Wi-Fi join, real mDNS on a router, real transfer timing, reboot and rollback on hardware.

## 9. Migration of an existing board

A board running the previous firmware has no LAN service and no home Wi-Fi card, so it must receive the new baseline once:

- **Over the existing Bluetooth OTA** (Demo 1 custom GATT or Demo 2 gb88), from the dashboard's Advanced card or the AI builder's Bluetooth path: build `pio run -e base` (or `updated`) and deploy `.pio/build/<env>/firmware.bin`. The new image keeps the same partition table, the same NVS namespaces and the same hotspot credentials, so nothing else changes. This is the preferred route for a board that is already in service.
- **Over the existing hotspot portal**: same file, same steps as before.
- **USB** is required only when the board is not running a working OTA-capable image, when the partition table must change (it does not here), or when the NVS must be erased. Use `/demo1/install.html`, `/demo2/install.html` or `pio run -e base -t upload`.

After the update: hold BOOT, join the hotspot, set the home Wi-Fi, then pair in the dashboard.

## 10. Running it

```sh
cd ~/Projects/atech/atech-ble-ota-demos/builder
npm install
npm start                      # http://localhost:5173/demo1/ and /demo2/
npm start -- --host 0.0.0.0    # also prints a LAN link with ?key=... for Safari on iPhone/iPad
ATECH_SIMULATED_DEVICE=all npm start   # two simulated boards, no hardware, for trying the flow
```

Physical board, first time: install the new baseline (section 9), hold BOOT, join the hotspot, open `http://192.168.4.1`, enter the OTA authorization code, join your home Wi-Fi, note the IP, close the hotspot. In the dashboard click **Find devices**, **Pair**, enter the code. Then: prompt, **Generate firmware**, read the code, **Deploy over Wi-Fi**. Watch the transfer time on the panel and record it with `BENCHMARKING.md`.

## 11. Unresolved

- No hardware verification of anything in this document.
- The LAN service is plain HTTP with HMAC authentication; TLS is the documented next step.
- The chunk session timeout (20 s) is serviced from the Arduino loop; a generated app that monopolises core 1 does not block it (the server task runs on core 0), but a crash reboots the board mid-transfer like any other reset, and the partial image is simply discarded.
- `esp_coex_preference_set` is deprecated in newer ESP-IDF releases; it compiles against the pinned v5.5.5 and is wrapped in `__has_include`.
- The hotspot portal and the LAN service both hold the OTA authorization code in NVS without flash encryption.
