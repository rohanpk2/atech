# Universal Wi-Fi OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atech boards take signed firmware over Wi-Fi from the cloud when they have internet, and from a signed package uploaded on their own `ATECH-XXXX` hotspot page when they do not, on home, enterprise (PEAP, TTLS, EAP-TLS) and captive-portal networks, with one installation engine, downgrade protection and a dashboard that reads Select, Deploy, Update complete.

**Architecture:** A new `AtechFwSign` library verifies an ECDSA P-256 manifest inside the existing `atech::ImageSink`, which the cloud agent, the LAN service and the hotspot portal all use. `AtechWifiLan` gains a Wi-Fi profile (personal and enterprise), a connectivity probe task and SNTP; `AtechWifiOta` becomes the transport controller (auto-started `ATECH-` hotspot, package upload, sign-in helper with NAT). The backend signs manifests per deployment, serves `.atech` packages and relays the board's hotspot credentials and network state to the owner's dashboard, which gains the offline flow.

**Tech Stack:** PlatformIO `espressif32 @ 8.0.0` / Arduino-ESP32 3.3.12 / ESP-IDF 5.5.5 (`mbedtls/ecdsa.h`, `esp_eap_client.h`, `esp_netif_napt_enable`, `ESPmDNS`, `Preferences`), Node 20+ (`node:crypto` P-256, `node:test`, jsdom), vanilla browser JS.

**Spec:** the brief, plus `docs/superpowers/specs/2026-11-15-universal-wifi-ota-design.md`.

## Global Constraints

- No commits in this session: the owner reviews the working tree and commits. Every task still ends with its tests green (`cd builder && npm test`, `node shared/<lib>/<x>.test.js`, `node web-shared/atech-builder.test.js`, both `web/dashboard.test.js`).
- No em dashes (U+2014) in `web-shared/atech-builder.js` or `builder.css` (pinned by `atech-builder.test.js`); the badge copy is `Device offline: local Wi-Fi update available`.
- Every `$('id')` in `web-shared/atech-builder.js` exists in both `index.html` files and in `KNOWN_IDS`.
- Canonical signed string: `atech-fw/1\n<build>\n<demo>\n<size>\n<sha256 lower>\n<version>\n<0|1>\n<target>\n`; signature = ECDSA P-256 over SHA-256 of it, raw `r||s`, 128 lowercase hex; public key = 65-byte uncompressed point, 130 hex; `kid` = first 8 hex of SHA-256(public key bytes).
- Package: `"ATECHPKG1\n"` (10 bytes) + uint32 LE header length + UTF-8 JSON header + image bytes; filename `atech-demo<d>-<build>.atech`.
- Image marker `ATECH-FWSIGN:1` is required by the backend (`SIGN_MARKER = 'ATECH-FWSIGN:'`) next to `ATECH-CLOUD-AGENT:` and `ATECH-PROV:`.
- NVS: `atech_fw` (`pubkey` string 130 hex, `ver` uint32); `atech_wifi` adds `auth`, `ident`, `user`, `ca`, `crt`, `key` (blobs), `ph2`, `domain`, `cabund`.
- Hotspot SSID `ATECH-<6 hex suffix>` for both demos; hostname `atech-<suffix>`; portal at `http://192.168.4.1`.
- Bluetooth setup `MAX_MESSAGE` 6144 on all three implementations; scan line `ssid<TAB>rssi<TAB>open<TAB>enterprise`.
- Controller timings: `offlineGraceMs` 90000, `onlineGraceMs` 60000, client-recent window 120000, inactivity timeout unchanged (600000).
- Connectivity probe: `http://connectivitycheck.gstatic.com/generate_204` then `http://captive.apple.com/hotspot-detect.html`; states `unknown|checking|ok|captive|offline`.
- Versions: AtechCore stays `1.3.0`; AtechCloudOta `1.2.0`; AtechWifiLan `1.3.0`; AtechWifiOta `2.0.0`; AtechBleProv `1.2.0`; AtechFwSign `1.0.0`.
- Nothing is claimed as hardware-verified.

## Review Focus

1. A package whose JSON header says one size and whose body has another must be refused by the board before activation, with the slot untouched (Task 2 `portal refuses a package whose body length differs from its header`, fake device parity in Task 2).
2. A manifest signed for board A presented to board B must fail even though the image bytes and digest are valid (Task 1 `verifyManifest fails when the target differs`; Task 3 fake cloud device `job for another target is refused by the board`).
3. A board that has already confirmed version 5 must refuse version 4 unless the manifest carries `downgrade=1`, and the dashboard must ask before setting it (Task 3 `downgrade is refused without the flag and accepted with it`, Task 6 dashboard `a lower version asks for confirmation before deploying`).
4. An enterprise profile without a CA and without the bundle flag must be refused by every provisioning path with the same message, never stored (Task 4 `enterprise profile without CA is refused`, portal and Bluetooth variants).
5. A board whose station is associated but captive must not report "online" anywhere and the hotspot must come up with the sign-in helper offered (Task 5 `captive state reaches the cloud report and the portal status`, Task 6 controller `captive starts the hotspot`).

---

### Task 1: Signing primitives on both sides

**Files:**
- Create: `builder/lib/signing.js`, `builder/test/signing.test.js`
- Create: `shared/AtechFwSign/library.json`, `shared/AtechFwSign/src/AtechFwSign.h`, `shared/AtechFwSign/src/AtechFwSign.cpp`, `shared/AtechFwSign/sign.test.js`
- Modify: `shared/AtechCloudOta/src/AtechImageSink.h`, `shared/AtechCloudOta/src/AtechImageSink.cpp`, `shared/AtechCloudOta/library.json` (1.2.0)
- Modify: `builder/lib/config.js` (`signingKeyFile`), `builder/lib/jobs.js` (`SIGN_MARKER`), `builder/test/helpers.js`, `builder/lib/fake-device.js` (`syntheticFirmware` marker list)

**Interfaces:**
- Produces `builder/lib/signing.js`: `createSigner({file})` returns `{publicKeyHex(), keyId(), sign(manifest) -> hex, verify(manifest, sigHex, pubHex?) -> boolean, file}`; `canonicalManifest({build, demo, size, sha256, version, downgrade, target}) -> string`; `verifyManifest(manifest, sigHex, pubHex) -> boolean`; `buildPackage({image, header}) -> Buffer`; `parsePackage(buffer) -> {header, image}` (throws `Error` with `code: 'package'` on a bad magic, length or JSON); `PACKAGE_MAGIC`; `keyIdOf(pubHex)`.
- Produces `AtechFwSign.h`, namespace `atech::fwsign`: `struct Manifest { String build; uint8_t demo; uint32_t size; String sha256; uint32_t version; bool downgrade; String target; String signature; }`; `bool begin(const char *compiledPubKeyHex, bool allowUnsigned, const char *preferencesNamespace = "atech_fw")`; `bool hasKey()`; `String keyIdHex()`; `const char *keySource()` (`compiled|nvs|none`); `bool pinKey(const String &hex, const char *source)` (false if a different key is pinned); `bool replaceKey(const String &hex, const char *source)`; `bool keyMatches(const String &hex)`; `String canonical(const Manifest &)`; `bool verify(const Manifest &, String &reason)`; `uint32_t maxVersion()`; `void recordRunningVersion(uint32_t)`; `bool allowUnsigned()`; `String statusJson()`.
- Produces `ImageSink::setManifest(const atech::fwsign::Manifest &)` and `ImageSink::hasManifest()`; `begin()` accepts an empty `sha256Hex` (digest comparison skipped) and `finish()` refuses an unsigned image unless `fwsign::allowUnsigned()`.

- [ ] **Step 1: Write `builder/test/signing.test.js`** with: `canonical string is exact` (asserts the Global Constraints string for build `deadbeef`, demo 1, size 1000, sha `ab`x32, version 3, downgrade false, target `ATECH-A1B2C3D4E5F6`); `key is created once and reloaded` (two `createSigner` calls on one temp file give equal `publicKeyHex()`, file mode 0600, 130 hex, `keyId()` 8 hex); `sign and verify round trip; a changed field fails` (flip `downgrade`, `target`, one digest byte: each `verify` false); `verifyManifest fails when the target differs`; `package round trip and refusals` (header fields survive, `image` equals input, bad magic throws `code 'package'`, truncated header throws, header length past the end throws).
- [ ] **Step 2: Run `cd builder && node --test test/signing.test.js`**: FAIL (module missing).
- [ ] **Step 3: Implement `builder/lib/signing.js`** with `node:crypto` (`generateKeyPairSync('ec', {namedCurve: 'prime256v1'})`, `sign('sha256', ..., {dsaEncoding: 'ieee-p1363'})`, raw public key via `publicKey.export({format: 'jwk'})` x/y to the 65-byte point). Add `signingKeyFile` to `loadConfig` (`ATECH_SIGNING_KEY_FILE`, default `<buildsDir>/signing/firmware-signing.pem`).
- [ ] **Step 4: Run the test**: PASS.
- [ ] **Step 5: Write `shared/AtechFwSign/sign.test.js`** (structure test): pins `"atech-fw/1\n"`, `ATECH-FWSIGN:1`, `mbedtls_ecdsa_verify`, `MBEDTLS_ECP_DP_SECP256R1`, `mbedtls_ecp_point_read_binary`, `"atech_fw"`, `"pubkey"`, `"ver"`, `ATECH_ALLOW_UNSIGNED` warning text, the downgrade message `Downgrade refused`, and in `AtechImageSink.cpp` that `fwsign::verify(` appears after the digest comparison and before `esp_ota_set_boot_partition`.
- [ ] **Step 6: Implement `AtechFwSign.{h,cpp}`** and the sink changes; add `SIGN_MARKER` to `jobs.js` (validate markers in `execute` and in `cloud-ota.js create`), to `helpers.js fakeWorkspace`, and to `fake-device.js syntheticFirmware`.
- [ ] **Step 7: Run `node shared/AtechFwSign/sign.test.js`, `node shared/AtechCloudOta/agent.test.js`, `cd builder && npm test`**: PASS.

### Task 2: Direct Wi-Fi hotspot OTA

**Files:**
- Modify: `shared/AtechWifiOta/src/AtechWifiOta.h`, `shared/AtechWifiOta/src/AtechWifiOta.cpp` (portal rewrite), `shared/AtechWifiOta/library.json` (2.0.0), `shared/AtechWifiOta/portal.test.js`
- Modify: `shared/AtechWifiLan/src/AtechWifiLan.h/.cpp` (`ensureMdns()`, `stationMac()`)
- Modify: `shared/AtechCloudOta/src/AtechCloudOta.h/.cpp` (`extraLogin` hook, `sign_key` pin), `shared/AtechCloudOta/agent.test.js`
- Modify: `builder/server.js` (`GET /api/builds/:id/package`, health `signing`), `builder/lib/cloud-routes.js` (login `sign_key`, `sign_kid`), `builder/lib/cloud-devices.js` (`apSsid`, `apPass` into `record.hotspot`), `builder/lib/devices.js` (`hotspot` in `describe`), `builder/lib/fake-cloud-device.js` (reports `ap_ssid`, `ap_pass`), `builder/lib/installer.js` and `builder/lib/workspace.js` (bake `ATECH_FW_PUBKEY`), `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp`
- Test: `builder/test/server.test.js` (package route), `builder/test/cloud-devices.test.js` (hotspot credentials stored and shown to the owner only), `builder/test/installer.test.js`, `builder/test/workspace.test.js`

**Interfaces:**
- Consumes Task 1 (`signer`, `buildPackage`, `fwsign`, `ImageSink::setManifest`).
- Produces `GET /api/builds/:id/package?deviceId=&downgrade=1` → `application/octet-stream`, `content-disposition: attachment; filename="atech-demo<d>-<build>.atech"`, header fields `{v: 1, build, demo, size, sha256, ver, downgrade, target, sig, kid, pub, app, created}`; 403 for another principal's build, 400 `rebuild` when the image lacks `ATECH-FWSIGN:`.
- Produces `AtechCloudOtaConfig::extraLogin` (`String (*)()`, form fields appended to the login body only) and the login answer field `sign_key` (130 hex) handled by `fwsign::pinKey(hex, "cloud")`.
- Produces `AtechWifiOtaPortal`: `const String &apPassword() const`, `String hotspotReport()` (`ap_ssid=..&ap_pass=..`), config `hostnamePrefix`; portal routes `POST /api/update` (multipart `firmware` + manifest headers), `GET /api/status` (adds `hostname`, `mac`, `sign`), `GET /api/sign/status`, `POST /api/sign/save` (token, `pubkey`).
- Produces `devices.describe(id).hotspot = {ssid, pass}` (only for records the caller may access; `list(ownerId)` already filters).

- [ ] **Step 1: Write the server test** `package route serves a signed package to the owner and refuses others` (parse with `parsePackage`, check `header.target` equals the query device, `header.sig` verifies with `signer.verify`, 403 for `bob`).
- [ ] **Step 2: Run**: FAIL (404).
- [ ] **Step 3: Implement the route and `health.signing = {keyId, publicKey}`**; create the signer in `createServer` (accept `signer` in options for tests).
- [ ] **Step 4: Write `cloud-devices.test.js` case** `login stores the hotspot credentials and describe shows them` and the `installer.test.js`/`workspace.test.js` cases that `buildFlagsEnv`/`rewritePlatformioIni` include `-DATECH_FW_PUBKEY="<hex>"` when a `signingPublicKey` is given.
- [ ] **Step 5: Implement** `normalizeReport` fields `apSsid`, `apPass`, and `record.hotspot` in `login()`; `describe()` exposes `hotspot`; `cloudIdentity` unchanged; `buildFlagsEnv(config, {publicKey})` and `rewritePlatformioIni(..., {pubKey})`; `fake-cloud-device` sends `ap_ssid=ATECH-<suffix>&ap_pass=simulated-hotspot-<suffix>` at login.
- [ ] **Step 6: Run `npm test`**: PASS.
- [ ] **Step 7: Update `portal.test.js`**: new assertions (accept `.atech,.bin`, `ATECHPKG1`, `X-Atech-Sig`, `X-Atech-Key`, `ImageSink`/`sink.finish(` before `esp_ota_set_boot_partition` is no longer in the portal (the sink owns it), `ssidPrefix` default `ATECH`, `MDNS`, `/api/sign/save` behind `authorize()`, `portal refuses a package whose body length differs from its header` through `X-Atech-Firmware-Size` versus `upload.totalSize`), drop the CRC32 assertions. Run: FAIL.
- [ ] **Step 8: Rewrite the portal**: page restyled with the dashboard tokens (light theme), sections Update, Network, Cloud, Board; upload through `atech::ImageSink` with the manifest from headers; key pinning on upload; `ensureMdns()`; both `main.cpp` set `ssidPrefix = "ATECH"`, `hostnamePrefix = "atech"`, `extraLogin = hotspotReport`, `fwsign::begin(ATECH_FW_PUBKEY, ATECH_ALLOW_UNSIGNED != 0)` before the other libraries.
- [ ] **Step 9: Run `node shared/AtechWifiOta/portal.test.js`, `node shared/AtechCloudOta/agent.test.js`, `node shared/AtechCore/core.test.js`, `cd builder && npm test`**: PASS.

### Task 3: Signed cloud pull and LAN deploy, downgrade flag

**Files:**
- Modify: `builder/lib/cloud-ota.js` (`create({..., allowDowngrade})`, `d.signature`, `d.version`, `d.downgrade`, `manifest()` adds `sig`, `dg`, `kid`, `target`), `builder/lib/cloud-routes.js` (poll passes them), `builder/server.js` (deploy body `allowDowngrade`), `builder/lib/lan-ota.js` (begin headers `X-Atech-Sig`, `X-Atech-Version`, `X-Atech-Downgrade`, `X-Atech-Target`, `X-Atech-Key`), `builder/lib/fake-cloud-device.js`, `builder/lib/fake-device.js` (verify like the firmware; state `maxVersion`, `pinnedKey`; faults `badSignature`)
- Modify: `shared/AtechCloudOta/src/AtechCloudOta.cpp` (`runJob` reads `sig`, `dg`, `kid`, `target`; `handleAck confirm` calls `fwsign::recordRunningVersion(config.appVersion)`), `shared/AtechWifiLan/src/AtechWifiLan.cpp` (session on `ImageSink`, manifest headers, key pin on authenticated begin), `shared/AtechWifiLan/library.json` (1.3.0)
- Test: `builder/test/cloud.test.js`, `builder/test/lan.test.js`, `builder/test/cloud-server.test.js`

**Interfaces:**
- Consumes Task 1 and Task 2.
- Produces poll fields `sig`, `dg` (`0|1`), `kid`, `target`; LAN begin headers as above; deployment snapshot fields `version`, `downgrade`, `signature`.

- [ ] **Step 1: Write tests**: cloud `poll manifest carries a verifiable signature bound to the device`; `job for another target is refused by the board` (fake device started with a different id reports `failed` with `Image was signed for`); `downgrade is refused without the flag and accepted with it` (fake device `state.maxVersion = 9`); `a tampered signature fails the job with reason device`; lan `begin carries the signature headers and the fake board verifies them`.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** backend and both fakes (the fakes verify with `verifyManifest`; they pin the key from `X-Atech-Key` / `sign_key` when none is pinned).
- [ ] **Step 4: Run `npm test`**: PASS.
- [ ] **Step 5: Firmware**: cloud agent manifest handling and version recording; LAN session migrated to `ImageSink` (remove the duplicated `MarkerScanner`/`TargetScanner`/prefix code from `AtechWifiLan.cpp`). Update `agent.test.js` (`"sig"`, `"dg"`, `recordRunningVersion`) and add to `sign.test.js` that `AtechWifiLan.cpp` uses `atech::ImageSink` and no longer calls `esp_ota_set_boot_partition` itself.
- [ ] **Step 6: Run the structure tests**: PASS.

### Task 4: Enterprise Wi-Fi profiles

**Files:**
- Modify: `shared/AtechWifiLan/src/AtechWifiLan.h/.cpp` (`AtechWifiProfile`, `saveProfile`, `profile`, `authName`, enterprise `startStation`, scan classes, SNTP)
- Modify: `shared/AtechBleProv/src/AtechBleProv.cpp` (`MAX_MESSAGE 6144`, profile fields, `hotspot=1` reply, status `wifi.auth`), `shared/AtechBleProv/library.json` (1.2.0), `shared/AtechBleProv/prov.test.js`
- Modify: `shared/AtechWifiOta/src/AtechWifiOta.cpp` (Network card: method select, identity, username, CA, client cert, key, phase 2, domain, bundle)
- Modify: `web-shared/atech-provision.js` (`parseScan` 4 fields, `MAX_MESSAGE`), `web-shared/atech-provision.test.js`, `builder/lib/fake-prov-board.js`, `web-shared/atech-builder.js` + both `index.html` (method select and fields in the Wi-Fi setup block), `builder/test/provision.test.js`, `builder/test/dashboard-provision.test.js`, `web-shared/atech-builder.test.js` (new ids)

**Interfaces:**
- Produces `struct AtechWifiProfile { String ssid, pass; uint8_t auth; String identity, username, ca, cert, key, domain; uint8_t phase2; bool caBundle; }` with `enum : uint8_t { ATECH_WIFI_PERSONAL = 0, ATECH_WIFI_PEAP = 1, ATECH_WIFI_TTLS = 2, ATECH_WIFI_TLS = 3 }`; `bool AtechWifiLan::saveProfile(const AtechWifiProfile &)` (refusal messages: `SSID must contain 1 to 32 characters`; `Wi-Fi password must contain 8 to 63 characters (or be empty for an open network)`; `Enterprise Wi-Fi needs a trusted CA certificate (PEM) or the built-in bundle; certificate checking is never disabled`; `EAP-TLS needs a client certificate and its private key`; `PEAP and TTLS need a username and password`); `AtechWifiProfile AtechWifiLan::profile() const` (secrets blank); `const char *AtechWifiLan::authName() const` (`personal|peap|ttls|tls`).
- Provision form fields (Bluetooth and portal alike): `auth` (`personal|peap|ttls|tls`), `ident`, `user`, `ca`, `crt`, `key`, `ph2` (`eap|mschapv2|mschap|pap|chap`), `domain`, `ca_bundle` (`1|0`), `hotspot` (`1` asks for `ap_ssid`, `ap_pass` in the reply).
- New dashboard ids: `provAuth`, `provIdentity`, `provUsername`, `provCa`, `provCert`, `provKey`, `provPhase2`, `provDomain`, `provCaBundle`, `provEnterprise`.

- [ ] **Step 1: Write tests**: `provision.test.js` `the reference board stores an enterprise profile and refuses one without a CA`; `dashboard-provision.test.js` `an enterprise network preselects PEAP, requires username and CA, and sends the profile`; `atech-provision.test.js` `parseScan reads the enterprise flag`; `prov.test.js` pins `MAX_MESSAGE 6144`, the field names and the CA refusal text.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** firmware (`esp_eap_client_*` calls, `WiFi.begin(ssid, method, ...)`, `configTime(0, 0, "pool.ntp.org")` on got-IP, scan `auth` class), reference board, browser module, dashboard block, portal card.
- [ ] **Step 4: Run every suite**: PASS.

### Task 5: Captive portal detection and the sign-in helper

**Files:**
- Modify: `shared/AtechWifiLan/src/AtechWifiLan.h/.cpp` (probe task, `internetState()`, `captiveUrl()`, `recheckInternet()`, `stationMac()`, `netJson` fields `internet`, `captive_url`, `mac`, `auth`)
- Modify: `shared/AtechCloudOta/src/AtechCloudOta.h/.cpp` (`internetState` hook, `State::Captive`, `extraPoll` hook), `shared/AtechWifiOta/src/AtechWifiOta.cpp` (helper routes, NAT, DNS switch, status fields), `shared/AtechBleProv/src/AtechBleProv.cpp` (status fields)
- Modify: `builder/lib/cloud-devices.js` (`normalizeReport`: `internet`, `captiveUrl`, `transport`, `mac`, `wifiAuth`, `kid`, `hotspot`), `builder/lib/devices.js` (`cloudIdentity.net`), `builder/lib/fake-cloud-device.js`, `web-shared/atech-builder.js` (copy), tests

**Interfaces:**
- Produces poll fields `internet`, `captive_url`, `transport`, `mac`, `wifi_auth`, `kid`, `hotspot` (`1|0`); portal routes `POST /api/net/helper` (token; body `on=1|0`), `POST /api/net/recheck` (token); status fields `internet`, `captive_url`, `helper`, `mac`.
- Cloud agent state name `captive` (`stateText`), with `error` `this network needs a sign-in (captive portal)`.

- [ ] **Step 1: Write tests**: cloud-devices `captive state reaches the cloud report and the portal status` (normalizeReport + describe); `agent.test.js` pins `State::Captive`, `"captive"`, `internetState`; `portal.test.js` pins `esp_netif_napt_enable`/`enableNAPT`, `/api/net/helper` behind `authorize()`, `generate_204` and `hotspot-detect.html` probe URLs in `AtechWifiLan.cpp`; dashboard-cloud `a captive board says it needs a sign-in and offers the local update`.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** the probe task (4 KiB stack, `HTTPClient` on a plain `NetworkClient`, 6 s timeouts, redirects disabled, `Location` captured), the helper, the fields.
- [ ] **Step 4: Run every suite**: PASS.

### Task 6: Transport controller, dashboard offline flow, documentation

**Files:**
- Modify: `shared/AtechWifiOta/src/AtechWifiOta.h/.cpp` (`autoStart`, `offlineGraceMs`, `onlineGraceMs`, `evaluatePolicy()`, `transport()`, `transportReason()`, `transportJson()`), both `main.cpp` (wire `extraPoll = transportReport`, `internetState`), `shared/AtechWifiOta/portal.test.js`
- Modify: `web-shared/atech-builder.js`, `web-shared/builder.css`, both `index.html`, both `web/dashboard.test.js`, `web-shared/atech-builder.test.js`, `builder/test/dashboard-deploy.test.js`, `builder/test/dashboard-cloud.test.js`, `builder/test/dashboard-dom.test.js`, `builder/test/dashboard-hosted.test.js`
- Create: `UNIVERSAL_WIFI_OTA.md`; Modify: `README.md`, `builder/.env.example`, `deploy/builder.env.example`

**Interfaces:**
- Produces `transportJson()` = `{"transport":"cloud|hotspot|none","reason":"online|no_wifi|captive|offline|no_cloud_url|manual","ssid":"ATECH-…","hostname":"atech-…","helper":bool}`; `transportReport()` = `transport=..&reason=..&hotspot=1|0`.
- Dashboard: method ids `methodWifi`, `methodHotspot` (Bluetooth card removed); new ids `localPanel`, `localState`, `localPrepare`, `localSsid`, `localPass`, `localToken`, `localOpen`, `localDone`, `localHint`, `deployDowngrade`; `effectiveMethod()` order `['wifi', 'hotspot']`; `aiDownload` keeps its id and points at the package.

- [ ] **Step 1: Write tests**: `portal.test.js` `captive starts the hotspot` and `online for 60 s stops an auto-started hotspot` (structure: `evaluatePolicy`, constants); dashboard-cloud `an offline cloud board shows the local update flow with the hotspot credentials and completes when the board reports the new build`; dashboard-deploy rewritten for two methods (`Wi-Fi first, hotspot second, no Bluetooth transport`); `a lower version asks for confirmation before deploying`; `atech-builder.test.js` order assertion updated.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** the controller and the dashboard flow (package download through `fetch` + `URL.createObjectURL`, copy buttons, completion watch comparing `device.build` with `job.buildId`).
- [ ] **Step 4: Run every suite**: PASS.
- [ ] **Step 5: Compile** `pio run -e base && pio run -e updated && pio run -e ai` in both demos (with `PLATFORMIO_BUILD_FLAGS='-DATECH_FW_PUBKEY="<test hex>"'` once); record the `[atech] firmware.bin … fits` lines.
- [ ] **Step 6: Write `UNIVERSAL_WIFI_OTA.md`** (architecture, files, build and flash, the eleven test procedures with expected results, limitations) and update `README.md` and both env examples (`ATECH_SIGNING_KEY_FILE`).
