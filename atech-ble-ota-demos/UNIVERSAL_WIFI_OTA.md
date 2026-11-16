# Universal Wi-Fi OTA: signed firmware over the cloud, the LAN or the board's own hotspot

Status on 2026-11-15: compiles for both demos (`base`, `updated`, `ai`), passes the automated
suites (builder 258 of 261 tests pass, 3 skipped, structure tests of every shared library, jsdom tests of both dashboards),
and works end to end against the simulated boards. **Nothing in this document has been verified on a
physical ESP32-S3.** Section 6 says what a hardware run must show; section 7 lists the limits.

## 1. What changed, in one paragraph

Every firmware image a board installs now carries an ECDSA P-256 signature over a manifest (build id,
demo, size, SHA-256, app version, downgrade flag, target device). One verifier (`atech::ImageSink`
plus `AtechFwSign`) sits behind all three ways an image can arrive: the cloud pull, the backend's LAN
push, and an upload on the board's own hotspot page. The board refuses unsigned images, images for
another board, and images with a lower app version than it has run, unless the owner allowed the
downgrade in the dashboard. Wi-Fi profiles cover personal WPA2/WPA3 and WPA2-Enterprise (PEAP,
EAP-TTLS, EAP-TLS) with the authentication server's certificate always validated. After every connect
the board checks whether it really has internet; a network with a sign-in page is reported as
`captive` rather than as a TLS failure, and the hotspot page offers a sign-in helper (SoftAP + STA with
NAT) plus the board's MAC for IT registration. A small controller in the hotspot library starts the
hotspot by itself when the board has no Wi-Fi or has lost the cloud for 90 s, and closes it 60 s after
the cloud is back. The dashboard offers two methods only: Wi-Fi (cloud or LAN) and the Local Wi-Fi
update (a signed package prepared in the browser, uploaded on the board's page). Bluetooth carries
the one-time Wi-Fi setup and the recovery controls, never firmware: the demos' original Bluetooth OTA
writers are compiled out unless a lab build asks for them (`-DATECH_BLE_OTA_DEMO=1`). USB stays the
recovery path.

## 2. Architecture

```
 dashboard (Safari/Chrome, any origin)            backend (Node, builder/)                board (ESP32-S3)
 ───────────────────────────────────            ─────────────────────────              ─────────────────────────────
 Select board → Deploy                           POST /api/builds/:id/deploy             AtechCloudOta: poll /api/device/poll
   Wi-Fi (cloud)  ─────────────────────────────▶ cloud job + signed manifest ──────────▶ ranged HTTPS download → ImageSink
   Wi-Fi (LAN, local backend) ─────────────────▶ HMAC push, manifest in headers ───────▶ AtechWifiLan :8080 → ImageSink
   Local Wi-Fi update                            GET /api/builds/:id/package              AtechWifiOta hotspot page
     prepare = fetch + verify .atech here ◀────── ATECHPKG1 + JSON header + image           reads the header in the browser,
     join ATECH-XXXX, open the board page ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶ uploads image + manifest headers → ImageSink
                                                                                           ImageSink: markers, SHA-256, signature,
                                                                                           target, downgrade policy, esp_ota_end,
                                                                                           set boot partition → reboot → health check
                                                                                           → confirm or bootloader rollback
```

- **One install engine.** `shared/AtechCloudOta/src/AtechImageSink.{h,cpp}` writes to the inactive
  OTA slot under the core's flash lock (`coreTryAcquireOta`), checks the identity markers, the
  digest, then `atech::fwsign::verify()` (signature, target, downgrade), then `esp_ota_end` and the
  boot partition. Refusals leave the boot partition untouched.
- **Signing.** `builder/lib/signing.js` creates or loads the backend's P-256 key
  (`ATECH_SIGNING_KEY_FILE`, default `<builds dir>/signing/firmware-signing.pem`, mode 0600), signs the
  canonical manifest string and builds the `.atech` package. `shared/AtechFwSign` verifies with
  mbedTLS. The public key is compiled into every image (`-DATECH_FW_PUBKEY`, set by the installer and
  the workspace from the backend's key) and pinned into NVS (`atech_fw/pubkey`) on the first
  authenticated cloud login (`sign_key` in the login answer), on a LAN session or on an upload with
  `X-Atech-Key`. A board with no key refuses signed and unsigned images alike with a clear message;
  `-DATECH_ALLOW_UNSIGNED=1` is for lab builds only (it also skips the downgrade rule for unsigned
  images). A key carried by a LAN or hotspot upload is used to verify that upload first and pinned
  only once the image was accepted, so a refused package never locks the board to a foreign key.
- **Downgrades.** The board records the app version of every image it has confirmed
  (`atech_fw/ver`). A manifest with a lower version is refused unless it carries `downgrade=1`;
  the backend sets that flag only when the deploy request says `allowDowngrade`, which the
  dashboard sends only after the user confirmed the warning.
- **Wi-Fi profiles.** `shared/AtechWifiLan` stores one profile in NVS `atech_wifi`: `ssid`, `pass`,
  `auth` (personal, PEAP, TTLS, TLS), `ident`, `user`, `ca`, `crt`, `key`, `ph2`, `domain`,
  `cabund`. Enterprise profiles without a CA and without the built-in bundle are refused by every
  path with the same text, and refused again at connect time if the stored profile lacks a trust
  anchor (the board then never associates). The profile is written certificates first and method
  last, so a failed write never leaves "enterprise without CA" behind. Budget: 4 KiB per PEM, 10 KiB
  for the three together (the `nvs` partition is 20 KiB); the Bluetooth setup message carries at most
  6 KiB, so large chains go in through the hotspot page or the built-in bundle. `connectStation()`
  sets the CA explicitly (or the Mozilla bundle), the expected domain when given, and skips only the
  certificate time check until SNTP has run.
- **Internet probe.** A task in `AtechWifiLan` fetches `generate_204` (fallback Apple
  `hotspot-detect.html`) after every connect: `ok`, `captive` (with the redirect target), `offline`.
  The state goes into the LAN identity, the Bluetooth status, every cloud poll and the hotspot page.
- **Hotspot.** `shared/AtechWifiOta` 2.0: SSID `ATECH-<6 hex of the MAC>`, WPA2 with the per-device
  random password, hostname `atech-<suffix>.local`, captive-portal probes so phones open the page by
  themselves, `http://192.168.4.1/` as the fallback. The page takes the `.atech` package, a Wi-Fi
  profile (including enterprise fields), the cloud URL, the signing key (owner token), the sign-in
  helper and a network recheck. The board reports `ap_ssid`/`ap_pass` once per cloud login; the
  backend stores them and shows them, with the OTA authorization code, to the owner only
  (`GET /api/devices/:id/local-credentials`).
- **Controller.** `AtechWifiOtaConfig::autoStart` with `offlineGraceMs` 90000 and `onlineGraceMs`
  60000. `transportJson()` (`cloud|hotspot|none`, reason `online|no_wifi|no_cloud_url|captive|offline|manual`)
  rides in the LAN identity (`transport`) and every cloud poll (`transport=..&reason=..&hotspot=`).
  A hotspot started by holding BOOT is left to the 10 min inactivity timeout; an auto-started one
  stays until the cloud is back for 60 s with no client in the last two minutes and no upload.
  "Cloud online" means a session with a successful exchange in the last 60 s: three failed polls in a
  row end the session (the agent logs in again when the network is back and asks the Wi-Fi layer to
  re-probe for a sign-in page), so a station that is associated while the internet is gone brings
  the hotspot up too.
- **Dashboard.** `web-shared/atech-builder.js`: methods `methodWifi` and `methodHotspot`; an offline
  cloud board defaults to the local update with the badge `Device offline: local Wi-Fi update
  available`; the local panel fetches the credentials, prepares (fetches, checks the package header,
  saves) the `.atech` file, shows SSID, password, authorization code and the board's addresses, and
  watches `/api/devices` until the board reports the new build id (`Update complete`).

## 3. Files

| Area | Files |
| --- | --- |
| Signing | `builder/lib/signing.js`, `shared/AtechFwSign/` (`library.json`, `src/AtechFwSign.h`, `src/AtechFwSign.cpp`, `sign.test.js`), `builder/test/signing.test.js` |
| Install engine | `shared/AtechCloudOta/src/AtechImageSink.{h,cpp}` (manifest, signature, downgrade), `shared/AtechCloudOta/src/AtechCloudOta.{h,cpp}` (sign_key pin, sig/dg/kid/target in jobs, captive state, extraLogin/extraPoll/internetState hooks) |
| Backend | `builder/server.js` (`/api/builds/:id/package`, `/api/devices/:id/local-credentials`, `allowDowngrade`, health `signing`), `builder/lib/cloud-ota.js`, `builder/lib/cloud-routes.js`, `builder/lib/lan-ota.js`, `builder/lib/cloud-devices.js` (hotspot credentials, captive/transport report), `builder/lib/devices.js`, `builder/lib/installer.js` and `builder/lib/workspace.js` (`-DATECH_FW_PUBKEY`), `builder/lib/jobs.js` (`ATECH-FWSIGN:1` marker), `builder/lib/config.js` |
| Simulators | `builder/lib/fake-cloud-device.js`, `builder/lib/fake-device.js`, `builder/lib/fake-prov-board.js` (same refusal texts as the firmware) |
| Wi-Fi | `shared/AtechWifiLan/src/AtechWifiLan.{h,cpp}` (profiles, enterprise, probe task, transport identity), `shared/AtechWifiOta/src/AtechWifiOta.{h,cpp}` (hotspot, package upload, helper, controller), `shared/AtechBleProv/src/AtechBleProv.{h,cpp}` (6144-byte messages, enterprise fields, hotspot report) |
| Demos | `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp` (fwsign begin, hooks, controller config, Bluetooth no longer blocks the hotspot), both `web/index.html` |
| Dashboard | `web-shared/atech-builder.js`, `web-shared/builder.css`, `web-shared/atech-provision.js` |
| Tests | `builder/test/*.test.js` (cloud, lan, server, cloud-devices, installer, workspace, provision, dashboard-*), `shared/*/**.test.js`, `web-shared/*.test.js`, `demo*/web/dashboard.test.js` |

## 4. Build, flash, run

Firmware: PlatformIO `espressif32 @ 8.0.0`, Arduino-ESP32 3.3.12 on ESP-IDF 5.5.5, board
`esp32-s3-devkitc-1` (N16R8). Partitions: `nvs`, `otadata`, `ota_0` and `ota_1` (6 MiB each),
`spiffs`. The sdkconfig enables app rollback, Wi-Fi Enterprise, NAPT, ECDSA and secp256r1.

```sh
# backend
cd builder && npm install && npm start            # creates <builds>/signing/firmware-signing.pem on first start
# the key id and public key: GET /api/health → signing.keyId / signing.publicKey

# firmware, with the backend's public key compiled in (the installer page and generated builds do this for you)
cd ../demo1-custom-gatt
PLATFORMIO_BUILD_FLAGS='-DATECH_FW_PUBKEY="<130 hex from /api/health>"' pio run -e base -t upload
# lab only, no backend yet: a board that accepts unsigned images
PLATFORMIO_BUILD_FLAGS='-DATECH_ALLOW_UNSIGNED=1' pio run -e base -t upload
```

Or use the browser installer at `/demo1/install.html`: it builds the base image on the backend with
the backend's key and flashes it over USB. A board flashed without a compiled-in key still works: it
pins the key from its first authenticated cloud login (TLS, device token) or from the owner on the
hotspot page (`/api/sign/save` with the authorization code).

Environment: `ATECH_SIGNING_KEY_FILE` (optional path of the PEM; keep it in a persisted volume),
`ATECH_PUBLIC_URL` (the origin boards poll), the existing cloud timings. Simulated boards:
`ATECH_SIMULATED_DEVICE=all npm start` gives one board per demo that logs in, pins the key, verifies
manifests exactly like the firmware, and reports `internet`/`transport`.

Dashboard flow: **Select board → Describe → Deploy**. Wi-Fi (cloud when the board is registered,
LAN on a local backend) is automatic when the board is reachable. When it is not, the Local Wi-Fi
update is selected: click **Start the local Wi-Fi update**, then **Prepare update** (the `.atech`
package is fetched, its header checked against the job and saved), join the shown `ATECH-XXXX` with
the shown password, open `http://192.168.4.1/` (or `atech-<suffix>.local`), enter the authorization
code, choose the file, tap **Deploy Firmware**. Rejoin your network; the badge turns to **Update
complete** when the board reports the new build id.

## 5. Protocol details worth knowing

- Canonical manifest string (signed): `atech-fw/1\n<build>\n<demo>\n<size>\n<sha256 lower>\n<version>\n<0|1>\n<target>\n`.
  Signature: raw `r||s`, 128 hex. Public key: 130 hex uncompressed point. Key id: first 8 hex of
  SHA-256(public key). An empty target means "any board of this demo".
- Package: `"ATECHPKG1\n"` + uint32 LE header length + JSON header (`v, build, demo, size, sha256,
  version, ver, downgrade, target, sig, kid, pub, app, created`) + image. Filename
  `atech-demo<d>-<build>.atech`. The hotspot page reads the header in the browser and sends the
  image with `X-Atech-Build`, `X-Atech-Version`, `X-Atech-Downgrade`, `X-Atech-Target`,
  `X-Atech-SHA256`, `X-Atech-Sig`, `X-Atech-Key`, `X-Atech-OTA-Key` (the authorization code).
- Cloud poll answer: `sig`, `dg`, `kid`, `target`, `ver` next to the job; login answer: `sign_key`,
  `sign_kid`. LAN begin headers: `X-Atech-Sig`, `X-Atech-Version`, `X-Atech-Downgrade`,
  `X-Atech-Target`, `X-Atech-Key`.
- Health check after a reboot: the core confirms a pending image only once `appSetup()` returned and
  `appLoop()` ran, the uptime passed `autoConfirmMs`, and the board is not in safe mode. A cloud
  job holds that confirmation until the backend acknowledges the new build (then 180 s confirm
  timeout → rollback). Three crash resets in a row put the board in safe mode (app disabled, OTA
  still available). A pending image that never confirms is rolled back by the bootloader on the
  next reset.
- Refusal texts (identical in the firmware and the simulators): `This image carries no Atech
  signature; download the signed update package from the dashboard`, `No firmware signing key is
  provisioned on this board; ...`, `Downgrade refused: this board has run app version N and this
  build is version M; allow the downgrade in the dashboard to install it`, `Enterprise Wi-Fi needs a
  trusted CA certificate (PEM) or the built-in bundle; certificate checking is never disabled`.

## 6. Test procedures and expected results

Automated now (host): `cd builder && npm test` (261 tests: 258 pass, 3 skipped) and the structure tests
`node shared/AtechFwSign/sign.test.js shared/AtechCloudOta/agent.test.js shared/AtechWifiOta/portal.test.js
shared/AtechBleProv/prov.test.js shared/AtechCore/core.test.js web-shared/atech-builder.test.js
web-shared/atech-provision.test.js demo1-custom-gatt/web/dashboard.test.js demo2-bleota-library/web/dashboard.test.js`.
The simulated boards (`builder/lib/fake-*.js`) exercise the protocol end to end; their fault hooks are
named below. Every "on hardware" line is a procedure, not a result: none has been run on a board.

| # | Scenario | Automated coverage | On hardware: do | Expected |
| --- | --- | --- | --- | --- |
| 1 | Home WPA2 → cloud OTA | `cloud.test.js` (signed job, pinned key, confirm), `dashboard-cloud.test.js` cloud deploy states | Bluetooth setup with the home SSID/password, wait for "Online via cloud", Describe, Deploy | Board logs `sign key pinned`, downloads, `ImageSink` verifies, reboots, backend acknowledges, badge Succeeded; `/api/identity` shows the new build and `kid` |
| 2 | Enterprise PEAP → cloud OTA | `provision.test.js` (PEAP profile needs user+password, CA or bundle), `lan.test.js`/`prov.test.js` pins on `esp_eap_client_set_ca_cert`, `WPA2_AUTH_PEAP` | In Wi-Fi setup pick the campus SSID (detected as enterprise), method PEAP, username, password, upload the CA PEM or tick the bundle, optional server domain | Board joins (`[wifi] ... PEAP`), probe `ok`, then as scenario 1. With a wrong CA the join fails and the profile keeps the refusal reason; nothing falls back to unverified |
| 3 | Enterprise EAP-TLS → cloud OTA | `provision.test.js` (TLS needs cert+key and identity), structure pins on `WPA2_AUTH_TLS` | Method EAP-TLS, identity, client certificate and key (PEM), CA | As scenario 2; the private key never appears in any status or serial line |
| 4 | Captive portal | `cloud-devices.test.js` captive report, `dashboard-cloud.test.js` "needs a sign-in", `portal.test.js` helper routes, controller pins | Join a hotel/campus SSID with a sign-in page | Dashboard: "needs a sign-in" with the SSID and the board MAC; after 90 s the hotspot comes up (reason `captive`); on the board page, "Sign in to the network" routes the laptop through the board (MAC-keyed portals), recheck shows `ok` and the hotspot closes 60 s after the cloud is back. Otherwise register the MAC with IT or use scenario 5 |
| 5 | No internet → direct hotspot OTA | `dashboard-cloud.test.js` offline flow (credentials, package, completion), `server.test.js` package and credentials routes, `portal.test.js` package headers, fake LAN device signature checks | Power the board away from any known Wi-Fi (or unplug the router); in the dashboard the board shows Offline | Badge `Device offline: local Wi-Fi update available`; Prepare saves `atech-demoN-<build>.atech`; `ATECH-XXXX` is visible with the shown password; the page opens by itself or at 192.168.4.1; upload shows progress, "verified", reboot; back on Wi-Fi the dashboard shows Update complete |
| 6 | Wi-Fi drops during transfer | `cloud.test.js` (`dropDownloadAfterBytes`, resumed with ranges, `MAX_ATTEMPTS`), `lan.test.js` (`dropAfterBytes` → failed, slot untouched), portal abort path | Pull the router power mid-download (cloud) or mid-upload (hotspot) | Cloud: ranged resume on the next poll, up to 5 attempts, then the job fails and the old image keeps running. LAN/hotspot: "incomplete" refusal, boot partition unchanged, no reboot |
| 7 | Corrupted or wrongly signed firmware | `signing.test.js`, `cloud.test.js` (`shaMismatch`, wrong target, unsigned), fake device parity, `portal refuses a package whose body length differs from its header` | Edit a byte of the `.atech` body; or sign with another key; or upload a raw `.bin` | Refused before `esp_ota_end`, with the exact reason on the page or in the job; the board never reboots and keeps its slot |
| 8 | Power loss during update | Not automatable on the host; the bootloader logic is ESP-IDF's | Cut power while the progress bar moves; power on | The otadata still points at the old slot; the old firmware boots; the next deploy starts from scratch (no partial image is ever selected) |
| 9 | Boots but fails the health check | `cloud.test.js` (`safeModeOnReboot`, `rollbackOnReboot`), `lan.test.js` (`appHangs`) | Deploy a generated app that crashes in `appLoop()` | The core never confirms; after the confirm timeout the agent calls `esp_ota_mark_app_invalid_rollback_and_reboot`; three crash resets → safe mode with the app off; the dashboard shows Failed with the reason |
| 10 | Safari and Chrome local update | `dashboard-dom.test.js`, `dashboard-deploy.test.js`, `dashboard-hosted.test.js` (no Web Bluetooth, hotspot method, copy) | Run scenario 5 once in Safari and once in Chrome on macOS | Identical flow; Safari saves the `.atech` through the blob link; the board page works in both; Bluetooth is only missing for the one-time setup, which the hotspot page covers |
| 11 | Several boards at once | `cloud-devices.test.js` ownership and per-device jobs, `dashboard-cloud.test.js` board list, two simulated boards `ATECH_SIMULATED_DEVICE=1,1` | Claim two boards, deploy to each | Each board gets only jobs with its own target (another target is refused by the board); the dashboard lists both with their own state; a hotspot of one board is `ATECH-<its suffix>` only |

## 7. Limitations and open points

- No hardware verification. Enterprise joins, the NAPT sign-in helper, the captive-portal probe
  against real portals, mDNS on the hotspot and the ESP-IDF rollback timing are only exercised by
  structure tests and simulators.
- Secure Boot V2 and flash encryption are out of scope: the signature protects the OTA path, not a
  physical attacker with USB access.
- The signing key lives in the backend's builds directory; back it up with the volume. Rotating it
  requires a board to pin the new key through an authenticated channel: a board that already trusts
  a key refuses a cloud login's different `sign_key`, so the owner pastes the new public key (shown
  only at `GET /api/health`) on the hotspot page with `replace=1`; a board that is online through the
  cloud never opens its hotspot by itself, so that is a BOOT hold. The per-demo app version counter
  lives in the builds directory too (`jobs.js`); wiping it makes every new build a "downgrade" for
  boards that ran the old numbering until the owner confirms one.
- The sign-in helper only helps portals that key on the client MAC; portals requiring a certificate,
  an app or a logged-in account need IT registration of the board's MAC or the local update.
- The browser never talks to the board from the hosted dashboard (mixed content, private network
  access); the local update is a two-browser-tab flow by design.
- Wi-Fi profiles hold one network; WPA3-Enterprise 192-bit, EAP-FAST and per-user accounts are not
  implemented.
- A hotspot auto-started while offline stays up until the cloud is back; a board on a LAN-only
  backend (no `ATECH_PUBLIC_URL`) closes it as soon as the station has an address, and never
  auto-starts it for a wrong Wi-Fi password (hold BOOT for that).
- The internet probe treats any non-204 answer as `captive` and a blocked port 80 as `offline`
  even when HTTPS works; the cloud session is the authority for "online" in the dashboard.
- The sign-in helper keeps the hotspot's catch-all DNS running; a client with an old lease may need
  to reconnect to the hotspot once the helper is on.
- On the hosted (Vercel) dashboard the package download passes through the `/api/*` proxy function;
  a package is about 2 MB, under the function's 4.5 MB body limit, but that path has not been run.
