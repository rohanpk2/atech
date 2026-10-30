# BLE Wi-Fi Onboarding and Cloud OTA Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer provision Wi-Fi, the cloud server and the board's cloud credential over the dashboard's existing Bluetooth connection, then deploy through the existing cloud OTA path, with every build and board route owner-scoped and a static blink v1 to v2 cloud deployment verifiable without the model.

**Architecture:** A new protected-core GATT service (`shared/AtechBleProv`, UUID family `a7ec02xx`) carries fragmented request/reply frames; a per-connection ECDH P-256 + HKDF + AES-256-GCM session protects the Wi-Fi password, server URL and token; an owned board additionally requires an owner grant (HMAC with the pairing token, minted by the backend for the owner only) or a BOOT press. The browser side lives in `web-shared/atech-provision.js` (WebCrypto) and is mounted by each demo's `app.js`; the dashboard block lives in `web-shared/atech-builder.js`. The backend gains the grant route, build ownership and a stock-app job.

**Tech Stack:** Arduino-ESP32 3.3 (NimBLE, mbedtls), PlatformIO 6.2, Node 25 (`node:test`, WebCrypto, jsdom), Web Bluetooth in Chrome 156.

**Spec:** `docs/superpowers/specs/2026-10-29-ble-wifi-onboarding-design.md`

## Global Constraints

- Canonical strings are byte-identical in firmware, backend and browser: HKDF info `atech-prov/1`, grant prefix `atech-prov-grant/1\n`, fragment payload at most 240 bytes, reassembled message at most 1024 bytes, nonce 16 bytes, IV 12 bytes, tag 16 bytes, AAD = the one opcode byte.
- UUIDs: service `a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001`, status `a7ec0201-…`, request `a7ec0202-…`, reply `a7ec0203-…`.
- The Wi-Fi password never appears in a log line, `localStorage`, a cookie, a URL, a backend request or a `Serial.print`.
- Dashboard copy: no em dashes, no code on screen, bars while working; every new element id goes into both `index.html` files and `KNOWN_IDS` in `web-shared/atech-builder.test.js`.
- Every existing test keeps passing: `cd builder && npm test`, the per-module `node <file>` tests, `pio run -e base -e updated -e ai` in both demos.
- Nothing is reported as verified on hardware unless it ran on `ATECH-90DA724FC608` in this session.

## Review Focus

1. A PROVISION whose JSON contains an SSID longer than 32 or a password of 1 to 7 characters must be refused with the LAN library's message, not stored. (Task 5 structure test pins `saveCredentials`; Task 4's reference board mirrors the limits.)
2. A request fragment stream that never ends (first fragment, no last) must not block later requests: Task 5 drops it after 5 s; Task 4 pins the reassembler's size and ordering rules.
3. A HELLO arriving while a cloud transfer owns flash must still answer (status and scan work during a transfer; only PROVISION and FORGET are refused with `busy`). Task 6's jsdom test covers the refusal copy.
4. A board claimed by another principal: the grant route answers 403 and the dashboard shows the BOOT hint instead of failing silently. Task 1 and Task 6 tests.
5. A build created before ownership existed (no `ownerId`) must stay deployable by every principal. Task 2 test.

---

### Task 1: Owner grant on the backend

**Files:**
- Modify: `builder/lib/cloud-auth.js`
- Modify: `builder/server.js` (devices routes)
- Test: `builder/test/provision.test.js` (new)

**Interfaces:**
- Produces: `provisionGrantMessage({deviceId, nonce, transcript})` → `` `atech-prov-grant/1\n${deviceId}\n${nonce.toLowerCase()}\n${transcript.toLowerCase()}\n` ``; `provisionGrantHex(secret, {deviceId, nonce, transcript})` → 64-char hex; route `POST /api/devices/:id/provision-grant` body `{nonce: 32 hex, transcript: 64 hex}` → `{grant}`.

- [ ] **Step 1: Write the failing tests** in `builder/test/provision.test.js`: `provisionGrantMessage` equals the exact string for `BOARD`, nonce `AB…` (uppercase in, lowercase out); route answers 200 `{grant}` for the owner, 403 for `bob`, 404 for an unclaimed id (`cloud` error code `unclaimed`), 400 for a 10-character nonce. Boot the server the way `cloud-server.test.js` does.
- [ ] **Step 2: Run** `node --test test/provision.test.js` → FAIL (function missing, route 404).
- [ ] **Step 3: Implement** the two functions in `cloud-auth.js` and the route in `server.js` (after the claim route; `devices.get(id)`, `canAccess`, `record.secret`).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(backend): owner grant for Bluetooth provisioning`.

### Task 2: Build ownership

**Files:**
- Modify: `builder/lib/jobs.js` (`create({… ownerId})`, `list(demo, ownerId)`, `canAccess(id, ownerId)`)
- Modify: `builder/server.js` (every `/api/builds*` route, `principalOf`)
- Test: `builder/test/server.test.js`

- [ ] **Step 1: Write the failing test** `builds are scoped to the dashboard user that created them`: with `dashboardKey` set, `alice` creates a job; `bob` gets 403 on `GET /api/builds/:id`, `/firmware.bin`, `/events`, `POST /deployed`, `POST /deploy`, and an empty list; `alice` and a caller without `x-atech-user` (principal `local`) … `local` sees only its own; a job file written with no `ownerId` is visible to both.
- [ ] **Step 2: Run** `node --test test/server.test.js` → FAIL.
- [ ] **Step 3: Implement**: `create` stores `ownerId` (null when absent); `canAccess` reuses `devices.canAccess` semantics; `list(demo, ownerId)` filters; server routes call `jobs.canAccess(id, principalOf(req, config))` and answer `{error: 'This build belongs to another dashboard user'}` 403.
- [ ] **Step 4: Run** `npm test` → all pass.
- [ ] **Step 5: Commit** `feat(backend): owner-scoped build routes`.

### Task 3: Stock-app job (static blink v2 through every deploy path)

**Files:**
- Modify: `builder/lib/jobs.js` (`createStock({demo, ownerId})`, `execute` skips the provider when `job.static`)
- Modify: `builder/server.js` (`POST /api/builds/stock`)
- Test: `builder/test/jobs.test.js`, `builder/test/server.test.js`

- [ ] **Step 1: Write the failing tests**: `createStock` records `prompt: 'stock app'`, `static: 'stock'`, `appName: 'green default'`, the code equals the checked-in `src/app/user_app.cpp`; `run` reaches `ready` with the fake workspace and the provider is never called; `POST /api/builds/stock {demo: 1}` → 202 and the job reaches ready.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`fs.readFileSync(path.join(entry.dir, 'src', 'app', 'user_app.cpp'))`, `summary: 'The stock Demo N app: quick green blink (v2 behaviour)'`).
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(backend): stock-app job for static v1 to v2 deployments`.

### Task 4: Browser provisioning module and the Node reference board

**Files:**
- Create: `web-shared/atech-provision.js` (UMD like `atech-identity.js`)
- Create: `builder/lib/fake-prov-board.js` (Node reference of the firmware side, used by tests and later by the jsdom test)
- Test: `builder/test/provision.test.js` (extend), `web-shared/atech-provision.test.js` (structure)

**Interfaces:**
- Produces (`root.AtechProvision`): `SERVICE`, `STATUS_CHAR`, `REQUEST_CHAR`, `REPLY_CHAR`, `OPS = {hello: 1, scan: 2, provision: 3, forget: 4}`, `MAX_FRAGMENT = 240`, `MAX_MESSAGE = 1024`, `fragment(message: Uint8Array) → Uint8Array[]`, `createReassembler() → {push(frame) → Uint8Array|null}`, `createSession({write(bytes), subscribe(handler) → unsubscribe, timeoutMs = 8000, crypto = globalThis.crypto}) → {hello() → {locked, wifiConfigured, urlSet, nonce (hex), transcript (hex)}, scan() → [{ssid, rssi, open}], provision({ssid, pass, url, grant, claim}) → {ok, joining, token, error}, forget({wifi, url, grant}) → {ok, error}, close()}`, `parseStatus(bytes) → object`, `transcriptHex(clientPub, boardPub)` (sha256 hex).
- Produces (`createFakeProvBoard({id, token, locked, unlock, status, networks, lan})`): `{handleWrite(frame) → void, onNotify(fn), status() → JSON string, state}` implementing the firmware byte layout with `node:crypto` (`createECDH('prime256v1')`, `hkdfSync`, `aes-256-gcm`).

- [ ] **Step 1: Write the failing tests**: fragment/reassemble round trip for 1, 240, 241 and 1024 bytes; 1025 rejected; an out-of-order `seq` resets; `hello` against the fake board yields a 32-hex nonce and `transcript === sha256(clientPub||boardPub)`; `scan` parses `Home\t-50\t0\n`; `provision({ssid:'Home', pass:'secret123', url, claim:true})` on an unlocked board returns `{ok:true, joining:true, token}` and the fake board recorded `{ssid, pass}`; on a locked board without grant → `{ok:false, error: /locked/}`; with `grant = provisionGrantHex(token, {deviceId, nonce, transcript})` → ok; a tampered ciphertext byte → `{ok:false}` on the board side and the session rejects a tampered reply.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both files. WebCrypto: `generateKey({name:'ECDH', namedCurve:'P-256'})`, `exportKey('raw')`, `deriveBits` 256, HKDF (`salt = nonce`, `info = 'atech-prov/1'`) → `AES-GCM` 256; frames per the spec; replies matched by `opcode | 0x80` with a timeout.
- [ ] **Step 4: Run** → PASS; `node web-shared/atech-provision.test.js` pins the UUIDs, the HKDF info and that the module never touches `localStorage`.
- [ ] **Step 5: Commit** `feat(web): Bluetooth provisioning protocol with a Node reference board`.

### Task 5: Firmware provisioning service

**Files:**
- Create: `shared/AtechBleProv/library.json`, `src/AtechBleProv.h`, `src/AtechBleProv.cpp`
- Modify: `shared/AtechCloudOta/src/AtechCloudOta.h/.cpp` (`bool hasSession() const`)
- Modify: `shared/AtechWifiOta/src/AtechWifiOta.h/.cpp` (`void (*shortPress)()` in the config; fired on release before `buttonHoldMs`)
- Modify: `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp`
- Test: `shared/AtechBleProv/prov.test.js` (structure), update `shared/AtechCloudOta/agent.test.js`, `shared/AtechCore/core.test.js` if touched

**Interfaces:**
- Produces: `struct AtechBleProvConfig {BLEServer *server; AtechWifiLan *lan; AtechCloudOta *cloud; String (*authToken)(); bool (*busy)(); uint32_t unlockWindowMs; const char *preferencesNamespace;}`; `class AtechBleProv {bool begin(const AtechBleProvConfig&); void loop(); void noteButtonPress(); bool isLocked() const; String statusJson(); const String &lastError() const;}`; marker `ATECH-PROV:1`.

- [ ] **Step 1: Write the structure test** `prov.test.js`: UUIDs present; `"atech-prov/1"` and `"atech-prov-grant/1\n"` present; `mbedtls_ecdh_setup`, `MBEDTLS_ECP_DP_SECP256R1`, `mbedtls_hkdf`, `mbedtls_gcm_auth_decrypt`, `mbedtls_gcm_crypt_and_tag`, `esp_fill_random`; `240`, `1024`, `5000` (fragment timeout); `saveCredentials(`, `setServerUrl(`; `"locked"`, `"atech_prov"`; no `Serial.print` line containing `pass`; `ATECH-PROV:1`; both `main.cpp` call `bleProv.begin(` and `bleProv.loop()`; `hasSession()` in the agent header; `shortPress` in the portal header.
- [ ] **Step 2: Run** `node shared/AtechBleProv/prov.test.js` → FAIL.
- [ ] **Step 3: Implement** the library (frames queued from `onWrite` to `loop()`; ECDH via `mbedtls_ecdh_make_public`/`read_public`/`calc_secret`; the lock set in `loop()` when `cloud->hasSession()` first becomes true; unlock window from `noteButtonPress()`), the two small additions, and the wiring (`AtechBleProv bleProv;` after `coreAttachBle`, `busy` = the demo's `otaTransportBusy`/`anyOtaBusy`, `shortPress` → `bleProv.noteButtonPress()`).
- [ ] **Step 4: Compile** `cd demo1-custom-gatt && pio run -e base -e updated -e ai` and the same in `demo2-bleota-library` → SUCCESS with `[atech] firmware.bin … fits`.
- [ ] **Step 5: Run** the structure tests → PASS. **Commit** `feat(firmware): Bluetooth Wi-Fi provisioning service in the protected core`.

### Task 6: Dashboard Wi-Fi setup block

**Files:**
- Modify: `web-shared/atech-builder.js`, `web-shared/builder.css`, `web-shared/atech-builder.test.js`
- Modify: `demo1-custom-gatt/web/index.html`, `demo1-custom-gatt/web/app.js`, `demo2-bleota-library/web/index.html`, `demo2-bleota-library/web/app.js`
- Test: `builder/test/dashboard-provision.test.js` (new, jsdom; fake transport whose `provisioning` is backed by `createFakeProvBoard`)

**Interfaces:**
- Consumes: `AtechProvision.createSession` (Task 4) and the grant route (Task 1).
- Produces: transport contract gains `provisioning: null | {available: () => boolean, session: () => Session, readStatus: () => Promise<object>}`; `app.js` builds it from the three characteristics when the service exists.

- [ ] **Step 1: Write the failing jsdom tests**: block hidden when `transport.provisioning` is null; shown after connect; **Scan** fills `provNetworks` options; **Join** with `Home`/`secret123` calls `provision` with `{ssid:'Home', pass:'secret123', url:'https://api.example', claim:true}`, clears `provPassword`, shows a bar, then `provState` reads `On Home, cloud online` after the fake board reports connected and the device list shows the board online; `/api/devices/claim` posted once with the token and not at all when the board is already in `state.devices` as paired for this user; locked board: `/api/devices/:id/provision-grant` requested and its grant sent; locked and 403 → hint contains `Press the BOOT button`; busy board → `provState` contains `busy`; the word `secret123` never appears in `localStorage`, `document.cookie` or `#log`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the block (HTML, CSS `.prov-form` grid, JS in `mount`), the transport wiring in both `app.js` (`optionalServices` gains `AtechProvision.SERVICE`), script tags for `/shared/atech-provision.js?v=1`, `KNOWN_IDS`.
- [ ] **Step 4: Run** `npm test`, `node demo1-custom-gatt/web/dashboard.test.js`, `node demo2-bleota-library/web/dashboard.test.js`, `cd web-shared && node atech-builder.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(dashboard): one-time Wi-Fi setup over Bluetooth`.

### Task 7: Protect the agent in generated images

**Files:**
- Modify: `builder/lib/source-policy.js` (forbidden identifiers `AtechBleProv|AtechCloudOta|AtechWifiLan|AtechWifiOta`), `builder/lib/jobs.js` (`PROV_MARKER = 'ATECH-PROV:'`, required markers), `builder/lib/cloud-ota.js` (same markers at create), `builder/test/helpers.js` (`syntheticFirmware` adds the marker), `builder/lib/fake-device.js` if it builds images, `builder/prompts/system.md` (one line: the provisioning service is part of the core)
- Test: `builder/test/source-policy.test.js`, `builder/test/jobs.test.js`

- [ ] **Step 1: Tests**: `checkSource('… AtechBleProv …')` violates; a compiled image without `ATECH-PROV:` fails validation with that marker named.
- [ ] **Step 2–4**: FAIL, implement, `npm test` PASS.
- [ ] **Step 5: Commit** `feat(builder): generated images must carry the provisioning service`.

### Task 8: Harden the flaky store test

**Files:** `builder/test/cloud.test.js:396-409`

- [ ] **Step 1**: replace the immediate `bootMarker` assertion with `await ctx.device.waitFor(() => ctx.device.state.bootMarker === null, 2000)`.
- [ ] **Step 2**: `npm test` twice → 0 failures. **Commit** `test: wait for the marker to clear`.

### Task 9: Hardware validation on the attached board

**Files:** scratchpad scripts only (`…/scratchpad/ble-prov-check.py` with bleak), results recorded in the doc of Task 10.

- [ ] **Step 1**: `cd demo1-custom-gatt && pio run -e base -t upload --upload-port /dev/cu.usbmodem5CBB0247201`, then a 15 s serial capture: expect the same id `ATECH-90DA724FC608`, `[prov] service ready`, the stored SSID still joined (if the hotspot is on).
- [ ] **Step 2**: bleak script: connect to `Atech-Custom-OTA-4FC608`, read status, HELLO, SCAN (expect at least one network), PROVISION `{url}` only with an unlocked board → ok, read status shows the URL, reboot (identity control 0x04) and read status again → URL persisted; PROVISION with a wrong grant on a locked board → refused.
- [ ] **Step 3**: record pass/fail per item in Task 10's doc; the Wi-Fi join with the owner's network and the cloud deploy are listed as the owner's steps.

### Task 10: Documentation, memory, commit

**Files:**
- Create: `WIFI_BLE_ONBOARDING.md` (what exists, phase by phase changes, protocol, security, exact commands: USB flash, backend run for the lab, Docker redeploy, Vercel env, hardware validation checklist, results table)
- Modify: `README.md` (first-time setup now: Connect Bluetooth, Wi-Fi setup), `CLOUD_WIFI_OTA.md` (bootstrap section points at the BLE flow; hotspot is the backup), `AI_FIRMWARE_BUILDER.md` (API table: grant, stock, ownership), `deploy/README.md` and `vercel-frontend/README.md` (no new variables; mention the grant route), `builder/.env.example` (nothing new)
- Memory: update `atech-cloud-wifi-ota.md` and `atech-builder-llm-credentials.md` (board attached now)

- [ ] **Step 1**: write the docs; **Step 2**: `git add` the changed files and commit `docs: Bluetooth Wi-Fi onboarding and cloud OTA validation`.
