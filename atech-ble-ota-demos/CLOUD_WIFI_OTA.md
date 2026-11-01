# Cloud Wi-Fi OTA: the board pulls firmware from the backend

**Status (2026-10-29):** implemented for both demos, compiled for every environment (`base`, `updated`, `ai`), covered by automated tests against a protocol-accurate simulated board, and driven end to end through the HTTP API by those tests. **No ESP32-S3 was attached during this work.** Nothing below was flashed, joined to a real Wi-Fi network, connected to a real TLS server, rebooted, rolled back or timed on hardware. Section 10 is the checklist for doing that.

The target experience: open the hosted dashboard in any browser (Safari on an iPhone included), type a prompt, **Generate**, **Deploy over Cloud Wi-Fi**, and watch the job go pending, downloading, installing, rebooting, succeeded. The backend on the Droplet never connects to the board; the board connects to the backend.

## 1. Architecture

```
Safari / Chrome ──HTTPS──▶ Vercel (open dashboards, /api proxy + key + x-atech-user)
                                         │ HTTPS
                                         ▼
                           Droplet: Caddy ─▶ builder container
                             /api/*          ├─ dashboard routes: dashboard key + owner (builds, devices, deployments)
                                             └─ device routes /api/device/*: per-board login proof + bearer session
                                                      ▲ HTTPS, outbound only, certificate validated
ESP32-S3 on its home Wi-Fi ── AtechCloudOta agent task ─┘
   login → poll → job → ranged download → inactive OTA slot → reboot → report → confirm
```

- The dashboard queues a **job** (`POST /api/builds/:id/deploy {deviceId, via: "cloud"}`).
- The board polls every 15 s. When it is ready (no other update in progress), the backend hands it the job: build id, size, SHA-256, download path.
- The board downloads the image in 128 KiB ranged chunks over one kept-alive TLS connection, posting a progress report between chunks, writes straight into the inactive OTA slot, validates the image, selects the slot, persists a boot marker, reports `rebooting` and restarts.
- After the reboot the board logs in again and reports the marker. The backend compares the running build with the job. On a match it answers `confirm`; the board waits until its generated app has run at least once, cancels the bootloader rollback, and reports `succeeded`. On a mismatch (the bootloader rolled back) the job fails. In safe mode the backend answers `rollback` and the board marks the image invalid and reboots into the previous one.
- A cloud-deployed image that cannot reach the backend within 3 minutes of booting rolls itself back: the backend never acknowledged it, so the board treats the image as broken.

The LAN path (backend on the same network as the board, `WIFI_LAN_OTA.md`) and Bluetooth are unchanged and still preferred locally; the cloud path is what the hosted dashboard uses.

## 2. Identity, pairing token, ownership

| Thing | What it is |
| --- | --- |
| Board id | `ATECH-<12 hex MAC digits>`, from the eFuse MAC. Printed at boot, shown by the dashboards. Authorizes nothing by itself. |
| Pairing token | The board's OTA authorization code (24 characters, about 140 bits), generated at first boot into NVS, printed on the serial console at every boot, never shown by any HTTP endpoint. It is the LAN pairing secret and the cloud pre-shared key. |
| Owner | The dashboard principal that claimed the board: `ATECH_DASHBOARD_USER`, forwarded by Vercel as `x-atech-user`, or `local` for a backend without a dashboard key (and for a key holder that sends no header, such as an operator on an SSH tunnel). |

**Claiming** (dashboard, step 1, **Claim a board**): enter the id, the token and an optional name. If the board has already contacted the backend (it tries every 30 s while unclaimed and leaves a commitment, the HMAC of its login challenge), the token is checked immediately and a wrong token is refused with a clear message. If the board has not contacted the backend yet, the claim is stored as waiting and checked at its first login; a mismatch is shown on the board's row.

Every dashboard route that touches a board or a deployment is filtered or refused by owner. Boards with no owner (the simulated boards) are visible to everyone.

## 3. First-time bootstrap

**Since 2026-10-29 the normal path is Bluetooth:** flash the base image over USB, **Connect Bluetooth** in desktop Chrome, and use the **Wi-Fi setup** block in step 1 (network, password, **Join Wi-Fi**). The dashboard provisions the server URL from `ATECH_PUBLIC_URL` and claims the board automatically with the token it reads inside the encrypted session; nothing is typed from the serial console. See [WIFI_BLE_ONBOARDING.md](WIFI_BLE_ONBOARDING.md). The hotspot route below remains the backup.

A board needs an image that contains the cloud agent (any build from this commit on) and a Wi-Fi network. Two routes:

**USB (new board, or a board whose NVS should be erased):** open `/demo1/install.html` or `/demo2/install.html` in desktop Chrome or Edge (or run `pio run -e base -t upload` in the demo folder) and install the baseline. Open the serial console (115200 baud) and press RST: the boot log prints the device id, the hotspot name and password, and the OTA authorization code. Record them. When the backend was started with `ATECH_PUBLIC_URL`, the baseline already carries the server URL (`[cloud] agent ATECH-CLOUD-AGENT:1 reporting to https://...`); otherwise set it on the hotspot portal below.

**Existing BLE OTA (a board already in service):** build `pio run -e base` (or `updated`) and deploy `.pio/build/<env>/firmware.bin` with the dashboard's Bluetooth path (Demo 1 custom GATT, Demo 2 gb88) or the hotspot page. NVS, credentials and the partition table are unchanged, so the board keeps its id and token. The new image prints the same credentials at boot; the authorization code is also the pairing token.

**Wi-Fi and server (once per board):** hold **BOOT** for three seconds, join the `Atech-OTA-D1-<suffix>` (or `D2`) hotspot, open `http://192.168.4.1`, enter the OTA authorization code, join your 2.4 GHz network in **Home Wi-Fi**. The **Cloud deployments** card shows the agent state and the server it reports to; **Save server URL** overrides the compiled-in default (only `https://` is accepted). The Wi-Fi password and the network name stay on the board; the cloud only ever receives connection state and signal strength.

**Claim (once per board):** in the hosted dashboard the board appears under step 1 as waiting to be claimed within about 30 s of joining Wi-Fi. Click **Claim**, enter the token (and a name). From then on it shows as online with its last contact, and **Deploy over Cloud Wi-Fi** queues jobs for it.

## 4. Device API (`/api/device/*`)

No dashboard key. Responses are `text/plain; charset=utf-8`, one `key=value` per line, `ok=1` or `ok=0` first; an error carries `code` and `error`. Request bodies are `application/x-www-form-urlencoded`. Rate limits: 60 per minute per address, 20 per minute per board id on challenge and login.

| Route | Request | Answer |
| --- | --- | --- |
| `GET /api/device/challenge?id=` | board id | `nonce` (32 hex, 90 s, single use, four outstanding per board), `ttl`, `claimed`, `server_time` |
| `POST /api/device/login` | `id, nonce, proof` plus the identity fields below | `session` (48 hex, 24 h, at most four live per board), `expires`, `poll` (ms). 403 `unclaimed` records a pending registration; 401 `unauthorized` records the failure on the board's row. |
| `POST /api/device/poll` | `Authorization: Bearer <session>`; identity fields plus `ready` (no other update owns flash) and `transferring`; after a reboot also `boot_job`, `boot_build` | `poll`; a job as `job, build, size, sha256, demo, app, ver, url, chunk` or `job=` empty; an acknowledgment as `ack=<job id>` and `action=confirm|clear|rollback` |
| `GET /api/device/jobs/:id/firmware` | Bearer; optional `Range: bytes=a-b` | the bytes (200, or 206 with `Content-Range`), `X-Atech-SHA256`, `X-Atech-Build`, `X-Atech-Size`; 416 past the end; 409 once the job is no longer downloading; 403 for another board's job |
| `POST /api/device/jobs/:id/status` | Bearer; `phase=downloading|installing|rebooting|succeeded|failed`, `received`, `total`, `error`, `elapsed`, `build`, `heap`, `heap_min` | `state` |

Identity fields: `demo, fw, build, app, ver, slot_size, core, agent, pending, safe, up, loops, rssi, heap, heap_min, state`.

Proof: `HMAC-SHA256(token, "atech-cloud-login/1\n<id>\n<nonce lowercase>\n")`, hex. The same string is built by `builder/lib/cloud-auth.js` and `shared/AtechCloudOta/src/AtechCloudOta.cpp`; the structure tests pin both.

A board only ever receives a job addressed to its own id, only through a session its own proof earned, and only when it says it is ready. A download request counts as an attempt when it does not continue exactly where the previous one ended; a job fails after five such attempts.

## 5. Job lifecycle

| State | Meaning | Leaves when |
| --- | --- | --- |
| `pending` | queued; shown as **offline** while the board has not polled within 45 s | the board polls with `ready=1` (→ downloading), the user cancels, or 30 minutes pass (→ failed `expired`) |
| `downloading` | the board is fetching ranges and reporting progress | `installing` report; no report for 120 s → failed `stalled` |
| `installing` | the board is checking the image and selecting the slot | `rebooting` report |
| `rebooting` | the board restarted; waiting for it to log in with the marker | back with the expected build → `confirm` acknowledged, then `succeeded`; back with the old build → failed `rolled_back`; safe mode → failed `safe_mode` with `rollback`; 5 minutes without the board → failed `reboot_timeout`; acknowledged but no `succeeded` within 2 minutes → failed `confirm_timeout` |
| `succeeded` | the board confirmed the new build (its `succeeded` report, or, when that report never arrives, its next poll showing the expected build no longer pending) | final |
| `failed` | with `reason`: `expired, stalled, reboot_timeout, confirm_timeout, device, rolled_back, safe_mode, attempts, artifact` | a board that returns with the expected build after `reboot_timeout`, `stalled` or `confirm_timeout` still completes the job (note "succeeded after the timeout") |
| `cancelled` | the user stopped it before the board picked it up | final |

Timings in the snapshot: `queuedMs, downloadMs, installMs, rebootMs, totalMs`. Jobs persist in `<builds dir>/cloud-deployments.json` (last 100), so a backend restart keeps a pending job. One active job per board; a second request answers 409 `duplicate`. Forgetting a board, or claiming it from another dashboard user, cancels its active jobs and logs it out of the cloud API, so nobody inherits a queued build. A board whose `installing` and `rebooting` reports were lost is still acknowledged when it comes back with the job's marker. After a page reload the dashboard re-attaches to the selected board's active job.

## 6. Device side

`shared/AtechCloudOta` (protected core, never generated):

- Own FreeRTOS task (core 0, priority 2, 12 KiB stack). The main loop keeps servicing BLE, the LAN service and the hotspot portal.
- One `NetworkClientSecure` with the built-in Mozilla root bundle (`useBuiltinCACertBundle()`), 30 s handshake, 10 s connect, 15 s read timeouts, redirects disabled, `setReuse(true)`: login, poll, every firmware range and every status report run over one kept-alive connection in turn. The pinned libraries allocate TLS in internal RAM, so there is never a second session. `setInsecure()` is not used anywhere.
- `https://` only. Firmware compiled with `-DATECH_CLOUD_ALLOW_HTTP=1` also accepts `http://` (a local backend during development) and prints a warning at every boot.
- Server URL: the hotspot portal's value in NVS (`atech_cloud/url`) wins, otherwise the compiled-in `ATECH_CLOUD_URL` that the backend bakes into generated images and the installer bakes into the baseline from `ATECH_PUBLIC_URL`.
- Image sink: `esp_ota_begin` on the inactive slot, streaming SHA-256, header check on the first 36 bytes (magic, chip id 9, 16 MB flash, app descriptor), the demo identity, `ATECH-BUILD:<id>` and `ATECH-TARGET:` markers, exact size, `esp_ota_end`, then `esp_ota_set_boot_partition`. The same rules as the LAN service.
- Exclusivity: `coreTryAcquireOta("cloud")`; the generated app is suspended during a transfer; BLE START, the hotspot upload and the LAN begin refuse while the cloud transfer owns flash; BLE advertising pauses during the transfer.
- Boot marker (`atech_cloud/job`, `expect`) written before the restart; `done` remembers the last applied job so it is never applied twice. While the marker is unacknowledged the core's automatic confirmation is held (`holdAutoConfirm`); without an acknowledgment within 3 minutes a pending image is marked invalid and the board reboots into the previous one.
- Every report carries the free and minimum internal heap for the checklist in section 10.

The hotspot portal gains a **Cloud deployments** card (a URL change is handed to the agent task, which drops its connection and session; refused during a transfer); the board keeps its boot marker until the backend has accepted the `succeeded` report, so a lost report is repeated on the next poll; the confirm-timeout check runs before the Wi-Fi gate, so a cloud image that cannot even join Wi-Fi rolls back after the timeout; the LAN identity (`/api/identity`) gains a `cloud` object with the agent's state.

Memory: the image grew by about 270 KB (TLS, HTTP client) to 1.83 MB for Demo 1 and 1.84 MB for Demo 2, in a 6 MiB slot; `shared/tools/check_ota_size.py` fails any build that would not fit with a 64 KiB margin.

## 7. Dashboard

Step 1 (hosted): claimed boards with **Online via cloud, seen 4 s ago** or **Offline, last seen 2 h ago**; boards waiting to be claimed with a **Claim** button; the claim form (id, token, name). **Find devices** stays hidden (mDNS would run on the Droplet). Locally both exist side by side.

Step 3: the first method card reads **Cloud Wi-Fi** for a cloud board (and **Wi-Fi** for a LAN board). A claimed board that is offline can still be given a job; the card says the job waits for it. Phases: Queued, Download, Install, Reboot, Done; badges Queued, Offline, Downloading, Installing, Restarting, Succeeded, Failed, Cancelled; progress from the board's reports; **Stop** while pending. A failed job is reported with its reason and the next available method is offered, never started automatically. **Keep this firmware** and **Roll back** are hidden for a board reached only through the cloud: there is no command channel; recovery is the board's own rollback or another deployment.

Bluetooth and the hotspot download are unchanged. Safari and iPhone use the cloud path with `fetch` only.

## 8. Security review

- Board id alone authorizes nothing: login needs the HMAC proof keyed with the pairing token; later calls need the bearer session; the download needs the session of the board the job names.
- Wrong board: the job is addressed to one id; the backend hands it only to that board's session; the image's own `ATECH-TARGET` marker is checked by the board; the build record's bound device id is checked at create.
- Integrity: SHA-256 declared by the backend and verified on the board, ESP image validation (`esp_ota_end`), demo and build markers, chip id, flash size header, app descriptor.
- Compatibility: demo match at create and on the board; slot size (reported and from the partition table); the agent marker required in every image.
- Replay: single-use nonces; random single-use job ids with expiry; the last completed job remembered on the board; the state machine refuses out-of-order reports; reports and downloads for another board's job answer 403.
- Transport: HTTPS with the built-in root bundle; plain HTTP only with a compile-time flag that prints a warning. Wi-Fi password and SSID never leave the board.
- Ownership: every dashboard device and deployment route checks the principal against the record; two sign-ins never see each other's boards (tested).
- Not covered: signed images, Secure Boot, flash encryption, per-user accounts beyond the single sign-in, DoS beyond simple rate limits, cloud-side recovery controls.

## 9. Automated verification (2026-10-29)

- `cd builder && npm test`: 180 tests, 180 passed, 2 skipped (the real-compile tests, run separately with `ATECH_REAL_BUILD=1`: both passed; the installer one proves the base image carries the baked server URL). New: `cloud-auth`, `partitions`, `cloud-devices` (pairing, ownership, proofs, sessions, rate limit), `cloud` (the state machine against the simulated board: wrong device id, firmware mismatch, offline, interrupted download with resume, capped retries, duplicate, expired, lost network, rollback, safe mode, never returning, late success, busy board, ranges, foreign reports, cancel, restart, lost success and progress reports, forget and re-claim, aborted download closes the file), `cloud-server` (routes, key exemption, owner scoping, SSE, simulated boards, forget over HTTP), `dashboard-cloud` (jsdom, including re-attaching to a job after a reload).
- Hosted emulation driven in Chrome (Vercel dev server in front of a local backend with simulated boards, real model build): Queued, Downloading, Installing, Restarting, Succeeded in 6.4 s. Simulation only.
- Module tests: `shared/AtechCloudOta/agent.test.js`, `core.test.js`, `portal.test.js`, both `dashboard.test.js`, `atech-builder.test.js`, `vercel-frontend` (31 tests): all pass.
- PlatformIO: `base`, `updated`, `ai` compile for both demos; every image contains `ATECH-CLOUD-AGENT:1`; the size check prints for each.
- Not run: anything on hardware, a real TLS handshake from an ESP32-S3, a real Wi-Fi join, real reboot timings.

## 10. Physical end-to-end checklist

Record the board revision, the Droplet name, the firmware sizes, browser and OS versions, and every pass or fail. A successful build is not a hardware result.

**Preparation**

1. Droplet: `ATECH_PUBLIC_URL=https://<name>` in `/etc/atech/builder.env`, container restarted; `curl -si https://<name>/api/device/challenge?id=ATECH-000000000000` answers `200` with `ok=1`; `curl -si https://<name>/api/devices` answers `401`.
2. Vercel: `ATECH_DASHBOARD_USER` set; the hosted dashboard loads and the top bar says the backend is online.
3. Build both demos locally with the same `ATECH_PUBLIC_URL` so the baseline carries the URL: `PLATFORMIO_BUILD_FLAGS='-DATECH_CLOUD_URL="https://<name>"' pio run -e base`; note the `[atech] firmware.bin ... fits` line.

**Bootstrap**

4. USB-install the Demo 1 baseline (`install.html` or `pio run -e base -t upload`). Serial at 115200: expect `[core] device ATECH-...`, the hotspot credentials, `[cloud] agent ATECH-CLOUD-AGENT:1 reporting to https://<name>`, `[wifi] no home Wi-Fi configured`.
5. Hold BOOT 3 s, join the hotspot, open `http://192.168.4.1`, enter the code, join the 2.4 GHz network. Expect `[wifi] connected to "<ssid>": http://<ip>:8080`, then within 30 s `[cloud]` lines: a challenge, then either `logged in` or `waiting to be claimed`. The Cloud card on the portal shows the same state. Note the free heap printed in the first poll (dashboard board details after claiming).
6. Hosted dashboard, step 1: the board appears as waiting to be claimed within 30 s. Enter a wrong token first: expect the mismatch message and no record. Enter the right token: expect **Online via cloud, seen N s ago**. Serial: `[cloud] logged in`.

**Deploy**

7. Generate a build (for example the triple blink) and **Deploy over Cloud Wi-Fi**. Expect badges Queued, Downloading (bar moving in 128 KiB steps), Installing, Restarting, Succeeded within about two minutes. Serial: `[cloud] job ... bytes of build ... into ota_1`, chunk lines, `verified (SHA-256 ...); rebooting`, after the reboot `booted after cloud job ... waiting for the backend's acknowledgment`, then `boot confirmed by the backend acknowledgment`. The LED pattern changed. Record download, reboot and total times from the panel, and the minimum free heap reported.
8. Repeat with Demo 2 (gb88 image): same expectations.
9. Bluetooth regression: with the new image, connect in desktop Chrome and send Demo 1 commands; run a Bluetooth OTA of the `updated` image; confirm it still works. Demo 2: gb88's hosted page still updates the board.
10. LAN regression: with a local backend on the same network, **Find devices**, **Pair**, deploy over Wi-Fi (LAN). Both paths work on the same board; the dashboard shows the board online over Wi-Fi locally and online via the cloud on the hosted dashboard.

**Failure paths**

11. Offline board: power the board off, queue a job: the dashboard shows **Offline**; power it on: the job proceeds and succeeds.
12. Interrupted download: during Downloading, briefly disconnect the router's internet (or block the Droplet in the firewall) for 20 s, then restore. Expect `[cloud] download interrupted at N bytes ...; retrying` and a resumed range, then success; the job's `attempts` is 2.
13. Lost network for good: block the Droplet during Downloading and leave it blocked. Expect the job to fail with `stalled` after 2 minutes; the board gives up after its own retries, reports failed when it can, keeps running the old image; unblock, and the board polls again.
14. Power loss mid-download: pull power during Downloading. Expect the old image to boot, the board to log in and the job to be offered again (ranges resume from zero because the OTA handle was lost), then success. If the job meanwhile stalled on the backend, deploy again.
15. Rollback: deploy a build whose generated app crashes in `appSetup()` (for example a null dereference). Expect the board to reboot repeatedly, the bootloader to return to the previous image, the board to report the old build, and the job to fail with `rolled_back`.
16. Safe mode: deploy a build whose app crashes after a few seconds in `appLoop()`. After three crash resets expect `safe:true` in the identity, the backend's `rollback` acknowledgment, and the board returning to the previous build.
17. No acknowledgment: block the Droplet right after the board reports `rebooting`. Expect the board to boot the new image, fail to reach the backend, and after 3 minutes print `[cloud] rolling back: no acknowledgment ...` and boot the previous image. Unblock: the backend should report `rolled_back` (or `reboot_timeout` if the block lasted longer than 5 minutes).
18. Expired job: queue a job for a powered-off board and wait 30 minutes: expect **Failed (expired)**; power on: nothing is downloaded.
19. Duplicate job: with a job pending, deploy again: expect the 409 message. Cancel the pending job: expect **Cancelled** and the board never downloads it.
20. Wrong board: claim two boards; deploy a build bound to board A to board B: refused at create. Deploy an unbound build to A: B never receives it.
21. Ownership: deploy a preview with a different `ATECH_DASHBOARD_USER`: the first owner's boards are not listed and cannot be deployed to.

**Resources**

22. Watch `heap` and `heap_min` in the board details during a download with a BLE client connected and the LAN service running. Record the minimum. If a TLS handshake fails for lack of memory, the serial log shows the HTTPClient error; record it, this is the open hardware risk named in the design.

## 11. Unresolved

- No hardware verification of anything above.
- TLS and HTTP client memory on a board that also runs NimBLE, the LAN httpd and the hotspot has not been measured; the agent is designed for one TLS session at a time because of it.
- No cloud-side confirm, rollback or restart commands for cloud-only boards; a queued-command channel is the documented follow-up.
- Progress granularity is one report per 128 KiB chunk.
- The pairing token is stored in plain NVS on the board and in `devices.json` (mode 0600) on the backend, as the LAN path already does; flash encryption remains the production step.
