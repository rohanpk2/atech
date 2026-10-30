# End-to-end cloud OTA: one-time Wi-Fi setup over Bluetooth, then deploy from anywhere

**Status (2026-10-29):** implemented for both demos, compiled for every environment (`base`, `updated`, `ai`, Demo 1 1,855,360 bytes and Demo 2 1,870,608 bytes in a 6 MiB slot), covered by automated tests that prove the browser, the backend reference board and the canonical strings agree byte for byte, and driven end to end in jsdom. **Hardware:** the board `ATECH-90DA724FC608` was attached at the start of the session (its serial boot log was captured), but it disappeared from USB before the new image could be flashed; section 9 says exactly what ran on it and what did not. Nothing in this document is a hardware result unless section 9 says so.

The customer experience this delivers: flash the board once over USB, open the dashboard in desktop Chrome, **Connect Bluetooth**, type the home Wi-Fi name and password into **Wi-Fi setup**, click **Join Wi-Fi**. The board joins, reports to the cloud, is claimed for that dashboard user automatically, and from then on **Generate** and **Deploy** work from any browser through the cloud. No hotspot, no SoftAP, no serial console, no code to copy.

## 1. What already existed (recon of 2026-10-29)

The repository already implemented most of the brief's phases 2 to 4 before this work; see the table in `docs/superpowers/specs/2026-10-29-ble-wifi-onboarding-design.md`. In short: the cloud agent (`shared/AtechCloudOta`, HTTPS with the built-in root bundle, HMAC login, bearer session, poll every 15 s with a status report, ranged download, inactive-slot install, boot marker, acknowledged confirm, automatic rollback), the device API (`/api/device/*`), claiming and ownership, the job lifecycle with every failure reason, the protected firmware template, the two 6 MiB app slots with rollback, the Vercel frontend and the Docker packaging. What was missing:

- Wi-Fi provisioning only existed through the board's own SoftAP hotspot portal (hold BOOT, join `Atech-OTA-…`, open 192.168.4.1, type the code), which the brief forbids as the primary path.
- The cloud server URL and the board's credential (the pairing token) had to be typed: the URL on the hotspot page, the token from the serial console into the claim form.
- Build routes (`/api/builds*`) were not owner-scoped.
- There was no way to deploy the static blink v2 image through the cloud without the model.

## 2. What changed, phase by phase

### Phase 1: one-time Wi-Fi onboarding over Bluetooth

| Part | Files | What it does |
| --- | --- | --- |
| Firmware service | `shared/AtechBleProv/` (new), `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp` | GATT service `a7ec0200`: status (read), request (write), reply (notify). Encrypted provisioning of Wi-Fi credentials, the cloud server URL and the pairing token; owner grant or BOOT press once the board has an owner; embeds `ATECH-PROV:1`. |
| Neighbouring libraries | `shared/AtechCloudOta` (`hasSession()`), `shared/AtechWifiLan` (`scanLines()`, `lastDisconnectReason()`), `shared/AtechWifiOta` (`shortPress` callback) | The lock follows the first cloud login; the scan feeds the dashboard list; a short BOOT press opens the physical-presence window without disturbing the 3 s hotspot hold. |
| Browser protocol | `web-shared/atech-provision.js` (new) | Frames, the WebCrypto session (ECDH P-256, HKDF-SHA256, AES-256-GCM), status parsing. Never touches storage or the console. |
| Dashboard | `web-shared/atech-builder.js`, `web-shared/builder.css`, both `web/index.html`, both `web/app.js` | **Wi-Fi setup** block in step 1 for a Bluetooth-connected board: state line, Scan, network list, password, Join Wi-Fi, Forget Wi-Fi, a bar while joining; automatic claim; the BOOT hint. Both demos discover the service on connect. |
| Backend | `builder/lib/cloud-auth.js`, `builder/server.js` | `POST /api/devices/:id/provision-grant` for the board's owner only. `GET /api/health` already exposed `cloud.publicUrl`, which the dashboard provisions. |
| Reference board | `builder/lib/fake-prov-board.js` (new) | The firmware side in `node:crypto`, so the tests prove interop without hardware. |

### Phase 2: cloud communication

Unchanged protocol (`CLOUD_WIFI_OTA.md` sections 4 and 5). Hardening: jobs record the principal that created them (`ownerId`); `GET /api/builds`, `GET /api/builds/:id`, `/events`, `/firmware.bin`, `POST /deployed` and `POST /deploy` refuse another principal's build with 403 and the list is filtered. Builds from before ownership existed stay visible to everyone, like device records.

### Phase 3: true cloud OTA

Unchanged path (the board polls, downloads in ranges over one TLS connection, verifies header, demo, build and target markers, size and SHA-256, installs on the inactive slot, reboots, is acknowledged, confirms; failure reasons `expired, stalled, reboot_timeout, confirm_timeout, device, rolled_back, safe_mode, attempts, artifact`). Addition: `POST /api/builds/stock {demo}` turns the checked-in stock app into a deployable job (compiled in the `ai` environment it takes the v2 branch, the quick green blink) without calling the model, so the static blink v1 to v2 cloud deployment can be verified first.

### Phase 4: the agent survives generation

The provisioning service joins the protected core: generated code cannot include it (`ALLOWED_INCLUDES`), and `builder/lib/source-policy.js` now refuses any reference to `AtechBleProv`, `AtechCloudOta`, `AtechWifiLan`, `AtechWifiOta…`, `AtechCore` or `AtechImageSink` by name. Every build and every cloud deployment requires the `ATECH-PROV:` marker in the image next to `ATECH-CLOUD-AGENT:`. NVS is never written by any OTA path, so identity, token, Wi-Fi credentials, server URL and the lock survive updates. Bluetooth OTA and the hotspot portal remain as backups.

### Phase 5: tests

`cd builder && npm test`: 201 tests, 199 pass, 2 skipped (the real-compile ones, run with `ATECH_REAL_BUILD=1`). New: `provision.test.js` (canonical grant string; grant route for owner, other user, unclaimed, malformed; framing round trips and reordering; hello, scan, provision, forget, locked board with and without grant, grant bound to the session, BOOT window, tampered ciphertext on both sides, session-less request, timeout), `dashboard-provision.test.js` (jsdom: block visibility, scan, join with URL and automatic claim, already-claimed board, owner grant, BOOT hint, busy refusal, password absent from storage, cookies and the log), stock job and owner scoping in `jobs.test.js` and `server.test.js`, policy and marker tests. Structure tests: `shared/AtechBleProv/prov.test.js`, `web-shared/atech-provision.test.js`, updated `atech-builder.test.js` and both `dashboard.test.js`. PlatformIO: `base`, `updated`, `ai` compile for both demos with the size check printed.

## 3. The protocol (`atech-prov/1`)

Service `a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001`:

| Characteristic | UUID suffix | Properties | Content |
| --- | --- | --- | --- |
| Status | `a7ec0201` | read | JSON, no secrets: `prov, id, locked, unlock_ms, session, wifi {configured, ssid, connected, ip, rssi, reason, joining}, cloud {url, state, session, last_error}, busy` |
| Request | `a7ec0202` | write with response | request frames |
| Reply | `a7ec0203` | notify | reply frames |

Frames: `[flags][seq][payload ≤ 240]`, `flags` bit 0 last, bit 1 first; messages are `[opcode][body]` up to 1024 bytes; an unfinished request is dropped after 5 s.

| Request | Body | Reply |
| --- | --- | --- |
| `0x01 hello` | client P-256 public key (65 bytes) | `0x81`: `[board key 65][nonce 16][flags]` (bit 0 locked, bit 1 Wi-Fi configured, bit 2 URL set). Session key = `HKDF-SHA256(salt = nonce, ikm = ECDH secret, info = "atech-prov/1")`. |
| `0x02 scan` | none | `0x82`: lines `ssid<TAB>rssi<TAB>open`, strongest first, at most 12 |
| `0x03 provision` | `[iv 12][ciphertext][tag 16]`, AES-256-GCM, AAD `0x03`; plaintext is a form body `ssid, pass, url, grant, claim` (all optional, booleans `1`/`0`) | `0x83`, encrypted with AAD `0x83`: `ok=1&joining=1[&token=…]` or `ok=0&error=…` |
| `0x04 forget` | encrypted `wifi, url, grant` | `0x84`: `ok=1` or `ok=0&error=…` |
| any | | `0xFF` with a text body when the request cannot be answered inside a session (no hello, malformed key, authentication failed) |

Authorization: an **unlocked** board (never owned) accepts any connected client. A board becomes **locked**, persistently (NVS `atech_prov/locked`), the first time its cloud agent logs in: the backend holds its token, so somebody owns it. A locked board accepts `provision` and `forget` only with an **owner grant**, `HMAC-SHA256(token, "atech-prov-grant/1\n<id>\n<nonce hex>\n<sha256 hex of client key || board key>\n")`, which `POST /api/devices/:id/provision-grant {nonce, transcript}` returns to the board's owner only, or within two minutes of a short **BOOT press**. Binding the grant to both public keys makes the key exchange authenticated: a relay changes the keys and the grant fails. The token is released only inside an authorized `provision` reply with `claim=1`; the dashboard uses it once for `POST /api/devices/claim` and discards it, and skips the claim when the board is already listed as paired for this user.

The canonical strings live in `shared/AtechBleProv/src/AtechBleProv.cpp`, `web-shared/atech-provision.js`, `builder/lib/cloud-auth.js` and `builder/lib/fake-prov-board.js`; the structure tests pin them.

## 4. Security review

- The Wi-Fi password travels once, inside an AES-256-GCM message keyed by an ephemeral ECDH exchange; it is never logged (`prov.test.js` checks every `Serial.print` line), never stored in the browser (`dashboard-provision.test.js` checks `localStorage`, cookies and the activity log), never sent to the backend (the dashboard's only backend calls during setup are the grant and the claim, neither carries it).
- An owned board refuses changes from anyone but its owner or someone holding it (BOOT). An unowned board is first come, first served while the user stands next to it, like an unprovisioned Espressif board; the window closes at the first cloud login.
- The server URL is validated by the board: `https://` only (a lab build with `-DATECH_CLOUD_ALLOW_HTTP=1` also accepts `http://`), at most 120 characters, printable.
- The token reaches the backend over HTTPS and is stored with mode 0600, exactly as when it was typed.
- Build, device and deployment routes are owner-scoped. `/api/device/*` keeps its own per-board authentication and rate limits.
- Why not Espressif `wifi_provisioning` / `WiFiProv`: it takes over the BLE host and GATT table (`protocomm_ble`), which conflicts with the demos' own services that must stay connectable, and Web Bluetooth has no client for its protobuf and SRP6a framing. This design mirrors its Security 1 idea (ephemeral ECDH plus an AEAD) and adds an owner-held proof of possession.
- Not covered: BLE link-layer encryption, signed firmware, Secure Boot, flash encryption, per-user accounts beyond the single sign-in. Arduino `String` buffers holding the password are not zeroed after use.

## 5. Running it locally (lab)

```sh
cd ~/Projects/atech/atech-ble-ota-demos/builder
npm install
npm start                                   # http://localhost:5173/demo1/
```

The dashboard provisions `cloud.publicUrl` from `/api/health`, which is `ATECH_PUBLIC_URL`. For a board to reach a backend on your Mac over your Wi-Fi, start the backend on all interfaces with a plain-HTTP public URL and flash a lab image that accepts it:

```sh
# backend (prints a ?key= link; the board must be on the same Wi-Fi as the Mac)
ATECH_PUBLIC_URL=http://<mac-ip>:5173 npm start -- --host 0.0.0.0

# lab firmware: plain http:// accepted (never ship this flag)
cd ../demo1-custom-gatt
PLATFORMIO_BUILD_FLAGS='-DATECH_CLOUD_ALLOW_HTTP=1' ~/.platformio/penv/bin/pio run -e base -t upload --upload-port /dev/cu.usbmodem<id>
```

Without hardware: `ATECH_SIMULATED_DEVICE=all npm start` keeps working (the simulated boards have no Bluetooth, so the Wi-Fi setup block does not appear for them).

## 6. One-time USB flash (production image)

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
ls /dev/cu.usbmodem*                        # the board's serial port (CH343: /dev/cu.usbmodem<serial>)
~/.platformio/penv/bin/pio run -e base -t upload --upload-port /dev/cu.usbmodem<id>
~/.platformio/penv/bin/pio device monitor -b 115200 -p /dev/cu.usbmodem<id>   # Ctrl+C to leave
```

Or the browser installer: `http://localhost:5173/demo1/install.html` in desktop Chrome or Edge. Either way NVS is untouched: a board keeps its id, pairing token, Wi-Fi credentials, server URL and lock across the flash. To bake the Droplet's address into the baseline, build with `PLATFORMIO_BUILD_FLAGS='-DATECH_CLOUD_URL="https://<droplet name>"'` (the backend does this for generated images from `ATECH_PUBLIC_URL`); the dashboard provisions the same address over Bluetooth anyway, so this is optional.

Expected boot log: `[core] device ATECH-…`, `[prov] Bluetooth Wi-Fi setup service ready (ATECH-PROV:1); board is not owned yet` (or `owned (grant or BOOT press needed)`), `[wifi] no home Wi-Fi configured …` or `[wifi] joining "<ssid>"`, `[cloud] agent ATECH-CLOUD-AGENT:1 reporting to …` or `no server URL configured`.

## 7. Backend redeploy (DigitalOcean, Docker)

On the Droplet, from the repository root (same commands as `deploy/README.md`; nothing new is required in `/etc/atech/builder.env`, but `ATECH_PUBLIC_URL=https://<droplet name>` must be set for the dashboard to provision the server address):

```sh
git pull
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml -f atech-ble-ota-demos/deploy/compose.tls.yaml up -d --build
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml logs -f --tail 50 builder
curl -si https://<droplet name>/api/device/challenge?id=ATECH-000000000000    # 200, ok=1
curl -si https://<droplet name>/api/health                                    # 401 without the key (expected)
```

The image build runs the tests only with `--target test`; the runtime image is what compose builds. Existing `devices.json`, jobs and `cloud-deployments.json` in the builds volume are read unchanged (jobs without an owner stay visible to everyone). **Builds created before 2026-10-29 cannot be deployed through the cloud any more**: their images lack the provisioning service marker, so `POST /api/builds/:id/deploy` answers 400 with code `rebuild`; generate them again (the LAN and Bluetooth paths still accept them).

## 8. Vercel

No new environment variables. `ATECH_BACKEND_URL` must point at the Droplet (it was a placeholder on 2026-10-29), `ATECH_BUILDER_KEY` must match the container's key, `ATECH_DASHBOARD_USER` is the owner name every claimed board and build is bound to. Redeploy from the repository root after pulling:

```sh
cd ~/Projects/atech
vercel pull --yes --environment=production
ATECH_BACKEND_URL=https://<droplet name> ATECH_BUILDER_KEY=<key> ATECH_DASHBOARD_USER=<user> ATECH_DASHBOARD_PASSWORD=<password> vercel build --prod
vercel deploy --prebuilt --prod
```

Web Bluetooth needs a secure context: the hosted dashboard (`https://atech-dashboards.vercel.app`) qualifies, and so does `http://localhost:5173`. The Vercel sign-in wall (`vercel project protection disable atech-dashboards --sso`) is still the owner's decision.

## 9. Hardware validation

Board: ESP32-S3-DevKitC-1 N16R8, `ATECH-90DA724FC608` (pairing suffix `4FC608`), CH343 serial `/dev/cu.usbmodem5CBB0247201`, Chrome 156 on macOS.

| Step | What | Result in this session |
| --- | --- | --- |
| 0 | Serial boot log of the image already on the board (115200 baud, 12 s capture) | **Done.** Stock v1 image from this code base: `[core] device ATECH-90DA724FC608 … build stock app "blue default" v1`, `[wifi] joining "Rohan's iPhone"` (the hotspot the brief wants to retire), `[cloud] no server URL configured`, hotspot credentials printed. The local registry still holds this board's LAN pairing from 2026-10-28. |
| 1 | `pio run -e base -t upload --upload-port /dev/cu.usbmodem5CBB0247201` | **Not done.** The port disappeared before the upload (`Could not open … busy or doesn't exist`; `ls /dev/cu.usbmodem*` empty; no CH34x device in `system_profiler`). A 30 minute watcher waited for it. |
| 2 | Boot log of the new image: same id, `[prov] … ready`, Wi-Fi still configured | Pending step 1. |
| 3 | Bluetooth: status read, hello (ECDH time), scan, refusals (33-character SSID, tampered ciphertext), provision `https://atech-api.example.com` with `claim`, token equals the serial console code, URL persists across a reboot, forget | Pending step 1. The client is `scratchpad/ble-prov-check.py` (bleak + cryptography); a first bleak scan did not return within 60 s, which on macOS usually means the Bluetooth permission prompt for the Python process was never answered. |
| 4 | Join the owner's 2.4 GHz network from the dashboard | **Needs the owner:** the Wi-Fi password is not available to this session and is not something to go looking for. Steps in section 10. |
| 5 | Claim automatically, cloud online, static v1 to v2 cloud deployment, AI deployment, rollback, safe mode | Needs steps 1 and 4. |

Nothing above the "Done" row was observed on hardware. The protocol was exercised against the Node reference board only.

## 10. End-to-end checklist for the owner

1. Plug the board in, flash the base image (section 6), open the serial monitor and note the `[prov]` line.
2. Start the backend (section 5, lab) or use the hosted dashboard with the Droplet redeployed (sections 7 and 8).
3. Desktop Chrome: open the dashboard, **Connect Bluetooth**, pick `Atech-Custom-OTA-4FC608`. The **Wi-Fi setup** block appears under step 1 with `Not on Wi-Fi yet`.
4. **Scan**, pick your 2.4 GHz network, type its password, **Join Wi-Fi**. Expect the bar, then `On <ssid> (<ip>), cloud online` within about 30 s, the activity log line `Claimed ATECH-90DA724FC608 in this dashboard`, the serial lines `[prov] Wi-Fi credentials for "<ssid>" stored over Bluetooth; joining`, `[wifi] connected to "<ssid>"`, `[cloud] logged in`, `[prov] board locked`.
5. Step 1 shows **Online via cloud**. Press RST on the board: it rejoins and logs in again without any typing.
6. Static v1 to v2 through the cloud: `curl -s -X POST http://localhost:5173/api/builds/stock -H 'content-type: application/json' -d '{"demo":1}'` (add `-H 'x-atech-key: <key>'` on a keyed backend; on the hosted dashboard the browser session carries the key, so run it from the Droplet against `http://127.0.0.1:5173` with the key and `-H 'x-atech-user: <user>'`). Wait for `GET /api/builds/<id>` to say `ready`. The dashboard's step 3 deploys only the build it generated itself, so deploy the stock job with `curl -X POST …/api/builds/<id>/deploy -H 'content-type: application/json' -d '{"deviceId":"ATECH-90DA724FC608","via":"cloud"}'` and watch `GET /api/deployments/<id>` go `pending, downloading, installing, rebooting, succeeded`. The LED changes from the slow blue blink to the quick green one. Serial: `[cloud] job … into ota_1`, `verified (SHA-256 …); rebooting`, `boot confirmed by the backend acknowledgment`.
7. AI deployment: **Generate** a prompt, **Deploy over Cloud Wi-Fi**, same expectations.
8. Re-provisioning an owned board: in the same dashboard, change the Wi-Fi: it works through the grant without a BOOT press. From a second dashboard user (another `ATECH_DASHBOARD_USER`): refused with the BOOT hint; press BOOT once, join again within two minutes: accepted.
9. Failure paths: `CLOUD_WIFI_OTA.md` section 10, items 11 to 22 (interrupted download, lost network, power loss, rollback, safe mode, no acknowledgment, expired, duplicate, wrong board, ownership, heap).

## 11. Unresolved

- No hardware run of the new image (section 9).
- Build and deploy of a stock job from the dashboard UI: the stock job exists only through the API; step 3 deploys the latest generated build.
- Builds from before this branch must be generated again before a cloud deployment (their images predate the provisioning service); the LAN and Bluetooth paths still accept them.
- The locked-board path on hardware needs a cloud login first, hence Wi-Fi.
- `String` buffers holding the password on the board are not zeroed.
- The dashboard asks the backend for a grant only when the board reports locked; a board that was locked by another backend (a second Droplet) shows the BOOT hint, which is correct but may surprise.
