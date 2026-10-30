# Cloud Wi-Fi OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the hosted dashboard queue a firmware deployment that the ESP32-S3 pulls over authenticated HTTPS, installs on its inactive OTA slot, reboots into, reports, and confirms, for both demos, without the backend ever contacting the board.

**Architecture:** The backend gains a device-facing API (`/api/device/*`, per-board HMAC login and bearer sessions, no dashboard key) and a persistent cloud job store with the states pending, downloading, installing, rebooting, succeeded, failed, cancelled (offline derived). A new shared firmware library `AtechCloudOta` runs an agent task that logs in, polls, downloads the image in ranged chunks over one TLS connection, validates it, reboots and confirms only after the backend acknowledges the new build. The shared dashboard module lists registered boards with last-seen, claims boards by id and pairing token, and renders cloud jobs; Vercel forwards the signed-in user as the owner principal.

**Tech Stack:** Node 20+ (`node:http`, `node:test`, jsdom), PlatformIO 6.2.0 with `espressif32 @ 8.0.0` / Arduino-ESP32 3.3.x (`NetworkClientSecure`, `HTTPClient`, `esp_ota_ops`, `Preferences`, `mbedtls`), Vercel routes, Caddy.

**Spec:** `docs/superpowers/specs/2026-10-29-cloud-wifi-ota-design.md`

## Global Constraints

- No commits in this session: the owner reviews the working tree and commits. Each task still ends with its tests green.
- No em dashes (U+2014) in any HTML, JS, CSS, C++ or Markdown touched (structure tests enforce this).
- Every `$('id')` referenced by `web-shared/atech-builder.js` must exist in both `index.html` files and in `KNOWN_IDS` of `web-shared/atech-builder.test.js`. New ids: `devClaimOpen`, `devClaimForm`, `devClaimId`, `devClaimToken`, `devClaimName`, `devClaim`.
- The literal strings `/api/builds/${job.id}/deploy`, `/api/deployments/${id}/events`, `/api/devices/pair`, `/api/builds/${...}/firmware.bin`, `EventSource(` and `function poll` stay in `atech-builder.js`.
- Canonical login message, byte for byte in Node and C++: `atech-cloud-login/1\n<device id>\n<nonce lowercase hex>\n`. HMAC-SHA256 keyed with the pairing token, hex lowercase.
- Device wire format: responses `text/plain; charset=utf-8`, one `key=value` per line, `ok=1` or `ok=0` first; requests `application/x-www-form-urlencoded`. Bearer header `Authorization: Bearer <session>`.
- Defaults (all overridable by env): poll 15000 ms (`ATECH_CLOUD_POLL_MS`), job TTL 30 min (`ATECH_CLOUD_JOB_TTL_MIN`), stall 120 s (`ATECH_CLOUD_STALL_S`), reboot timeout 300 s (`ATECH_CLOUD_REBOOT_TIMEOUT_S`), confirm timeout 120 s (`ATECH_CLOUD_CONFIRM_TIMEOUT_S`), offline after 45 s (`ATECH_CLOUD_OFFLINE_S`), max download attempts 5 (`ATECH_CLOUD_MAX_ATTEMPTS`), chunk 131072 bytes (`ATECH_CLOUD_CHUNK_BYTES`), nonce TTL 90 s, session TTL 24 h, max 4 sessions per board, pending registrations bounded to 64.
- `ATECH_PUBLIC_URL` (backend env) is an `https://host[:port]` or `http://host[:port]` origin without a path; it is baked into generated firmware as `ATECH_CLOUD_URL`.
- Image markers required at validation: the demo identity, `ATECH-BUILD:<id>`, `ATECH-CLOUD-AGENT:`.
- Firmware: only `https://` server URLs unless compiled with `-DATECH_CLOUD_ALLOW_HTTP=1`; built-in root bundle (`useBuiltinCACertBundle()`); one TLS session at a time; agent task on core 0, priority 2, 12288-byte stack; NVS namespace `atech_cloud` keys `url`, `job`, `expect`, `done`.
- Core version becomes `1.2.0`.
- Principal: `x-atech-user` header when `config.dashboardKey` is set and the header is present, else `local`. Records with `ownerId == null` are visible to every principal.
- Nothing is deployed; nothing is claimed as hardware-verified.

## Review Focus

1. A board that polls with `ready=0` (BLE or hotspot update in progress) must not be handed the job; the job stays `pending` with stage "Board is busy with another update" (Task 3 test `poll with ready=0 leaves the job pending`).
2. A second login for the same board invalidates nothing: four sessions may be live, the fifth evicts the oldest; a poll with an evicted session answers 401 and the board logs in again (Task 2 test `sessions are bounded per board`).
3. A ranged download request whose range starts beyond the file must get 416, and a request for a job that is no longer `downloading` must get 409 so a stale board cannot keep pulling bytes (Task 3 test `firmware range handling`).
4. The dashboard must keep `methodWifi` disabled and explain why when the selected cloud board runs a different demo than the page, even when it is online (Task 7 test `cloud board of the other demo`).
5. A report for a job that does not belong to the authenticated board must be refused with 403 and must not change the job (Task 3 test `reports from another board are refused`).

---

### Task 1: Backend foundations: canonical strings, kv format, partitions, config, markers

**Files:**
- Create: `builder/lib/cloud-auth.js`, `builder/lib/partitions.js`
- Modify: `builder/lib/config.js`, `builder/lib/jobs.js:240-243`, `builder/lib/fake-device.js:655-667`, `builder/test/helpers.js:285-293`
- Test: `builder/test/cloud-auth.test.js`, `builder/test/partitions.test.js`, `builder/test/config.test.js` (append)

**Interfaces:**
- Produces `cloud-auth.js`: `PROTOCOL = 1`; `loginMessage({deviceId, nonce}) -> string`; `proofHex(secret, {deviceId, nonce}) -> string` (uses `hmacHex` from `lan-auth.js`); `encodeKv(object) -> string` (booleans as `1`/`0`, `null`/`undefined` as empty, `\r`/`\n` stripped from values, keys in insertion order); `parseKv(text) -> object` (split at the first `=`, ignore blank lines); `parseForm(text) -> object` (via `URLSearchParams`); `newSessionToken() -> 48 hex chars`; `newJobId() -> 24 hex chars`; `class CloudError extends Error {status, code}`.
- Produces `partitions.js`: `parsePartitions(csvText) -> [{name, type, subtype, offset, size}]` (hex or decimal numbers, comments and blank lines ignored); `appSlots(parts) -> {ota0: size, ota1: size}` throwing when either is missing; `slotSizeFromCsv(file) -> number`.
- Produces `config.js`: `publicUrl: string|null` (trailing slash stripped; invalid value -> `null`), `slotSize` read from `demo1-custom-gatt/partitions.csv` through `slotSizeFromCsv` (fallback `0x600000`), `cloud: {pollMs, jobTtlMs, stallMs, rebootTimeoutMs, confirmTimeoutMs, offlineAfterMs, maxAttempts, chunkBytes}` with the defaults from Global Constraints.
- Produces: the marker constant `AGENT_MARKER = 'ATECH-CLOUD-AGENT:'` exported from `jobs.js`; job validation requires it.

- [ ] **Step 1: Write `builder/test/cloud-auth.test.js`**

```js
test('login message and proof match the firmware layout', () => {
  assert.equal(loginMessage({deviceId: 'ATECH-A1B2C3D4E5F6', nonce: 'ABCD'}), 'atech-cloud-login/1\nATECH-A1B2C3D4E5F6\nabcd\n');
  assert.equal(proofHex('key', {deviceId: 'ATECH-A1B2C3D4E5F6', nonce: 'abcd'}).length, 64);
});
test('kv encoding is line based and strips newlines', () => {
  assert.equal(encodeKv({ok: true, job: '', n: 5, text: 'a\nb'}), 'ok=1\njob=\nn=5\ntext=ab\n');
  assert.deepEqual(parseKv('ok=1\nsha=a=b\n\n'), {ok: '1', sha: 'a=b'});
  assert.deepEqual(parseForm('id=ATECH-1&proof=ab%20cd'), {id: 'ATECH-1', proof: 'ab cd'});
});
test('tokens and job ids are random hex of the documented length', ...)  // 48 and 24 chars, two calls differ
```

- [ ] **Step 2: Run it; expected: FAIL (module not found)**

Run: `cd builder && node --test test/cloud-auth.test.js`

- [ ] **Step 3: Implement `builder/lib/cloud-auth.js`**

- [ ] **Step 4: Write `builder/test/partitions.test.js`**

```js
test('parsePartitions reads the demo table', () => {
  const parts = parsePartitions(fs.readFileSync(path.join(config.demos[1].dir, 'partitions.csv'), 'utf8'));
  assert.deepEqual(parts.map(p => p.name), ['nvs', 'otadata', 'ota_0', 'ota_1', 'spiffs']);
  assert.equal(parts[2].offset, 0x10000); assert.equal(parts[2].size, 0x600000);
});
test('both demos share one table with two equal 6 MiB app slots', () => { /* read both csv files, deepEqual parts, appSlots ota0 === ota1 === 6291456 */ });
test('appSlots throws when a slot is missing', ...);
```

- [ ] **Step 5: Implement `builder/lib/partitions.js`; run the two test files; expected PASS**

- [ ] **Step 6: Extend `config.js` and `config.test.js`**

Append tests: `loadConfig({}).slotSize === 6291456`; `loadConfig({ATECH_PUBLIC_URL: 'https://api.example.com/'}).publicUrl === 'https://api.example.com'`; `loadConfig({ATECH_PUBLIC_URL: 'ftp://x'}).publicUrl === null`; `loadConfig({ATECH_CLOUD_JOB_TTL_MIN: '5'}).cloud.jobTtlMs === 300000`; defaults `cloud.pollMs === 15000`, `cloud.offlineAfterMs === 45000`, `cloud.maxAttempts === 5`.

- [ ] **Step 7: Require the agent marker**

In `jobs.js` add `const AGENT_MARKER = 'ATECH-CLOUD-AGENT:'`, include it in `markers` for `validateImage`, export it. In `test/helpers.js` `fakeWorkspace` push `'ATECH-CLOUD-AGENT:1'` next to the identity marker. In `fake-device.js` `syntheticFirmware` add `'ATECH-CLOUD-AGENT:1\0'` to the marker list. Add to `jobs.test.js`: `test('an image without the cloud agent marker fails validation')` using a `fakeWorkspace` spec `{ok: true, withAgentMarker: false}` (add that switch to `helpers.js`) and asserting `/ATECH-CLOUD-AGENT/` in `done.error`.

- [ ] **Step 8: Run the whole backend suite; expected: all pass**

Run: `cd builder && npm test`

### Task 2: Device registry ownership and the cloud device service

**Files:**
- Create: `builder/lib/cloud-devices.js`
- Modify: `builder/lib/devices.js` (`publicRecord`, `describe`, `list`, `refresh`, `pair`, new `canAccess`, `forget`), `builder/test/lan.test.js` (pairing test gains `ownerId`)
- Test: `builder/test/cloud-devices.test.js`

**Interfaces:**
- Consumes: Task 1 (`proofHex`, `newSessionToken`, `CloudError`, `config.cloud`).
- Produces `devices.js`: records gain `ownerId: string|null`, `claimedAt`, `cloud: {registeredAt, lastSeenAt, lastReport, lastAuthFailureAt, agent, verified}`; `canAccess(record, ownerId) -> boolean` (true when `record.ownerId == null` or equal); `list(ownerId = null)` filters with `canAccess` when `ownerId` is a string; `describe(id)` adds `via: 'lan'|'cloud'|null`, `online` (LAN probe within 20 s **or** `cloud.lastSeenAt` within `config.cloud.offlineAfterMs`), `cloud: {registered, online, lastSeenAt, lastReport, lastAuthFailureAt, verified}`, and when only the cloud is online, `identity` synthesized from `lastReport` (`{id, suffix, demo, fw, build, app, ver, slotSize, pending, canRollback: false, safe, appState, loops, up, otaOwner: '', target: '', paired: true, wifi: {ssid: '', ip: '', rssi, hostname: '', mdns: '', port: 0, connected: true, transferring, lastTransferError: '', lastTransferMs: 0}}`); `refresh()` skips records with neither `host` nor `hostname`; `pair({..., ownerId})` stores the owner; `remove(id)` unchanged.
- Produces `cloud-devices.js`: `class CloudDeviceService({config, devices, now = Date.now, log})` with `challenge({id, ip}) -> {nonce, ttlMs, claimed, serverTime}`; `login({id, nonce, proof, info, ip}) -> {session, expiresAt, pollMs}` or throws `CloudError(403, 'unclaimed')`, `CloudError(401, 'unauthorized')`, `CloudError(400, 'bad_request')`, `CloudError(429, 'rate_limited')`; `authenticate(authorizationHeader) -> {deviceId}` or throws `CloudError(401, 'session')`; `touch(deviceId, report)` (updates `cloud.lastSeenAt`, `cloud.lastReport`, persists at most once per 30 s unless `build`, `pending` or `safe` changed); `isOnline(deviceId) -> boolean`; `pendingRegistrations() -> [{id, demo, fw, build, app, ver, slotSize, seenAt}]`; `claim({id, token, name, ownerId}) -> public record` (throws 400 for a short token or bad id, 403 when the record belongs to another owner, 400 `token_mismatch` when a pending registration's proof disagrees); `sessionsFor(id)` for tests.
- `info` fields accepted at login and poll: `demo, fw, build, app, ver, slot_size, core, agent, pending, safe, up, loops, rssi, heap, heap_min, ready, transferring`.

- [ ] **Step 1: Write `builder/test/cloud-devices.test.js`**

Use `tempConfig()` with `cloud: {...loadConfig({}).cloud, offlineAfterMs: 200}` and a fake clock `let t = 1000; const now = () => t`.

```js
test('an unclaimed board gets a nonce, is refused at login and shows up as waiting to be claimed')
  // challenge({id}) -> nonce 32 hex, claimed false; login with a proof -> throws status 403 code 'unclaimed';
  // pendingRegistrations()[0].id === BOARD and .demo === 1
test('claiming verifies the token against the board commitment and binds the owner')
  // claim with wrong token -> throws /does not match/ code 'token_mismatch'; claim with SECRET -> record.ownerId === 'alice', paired true;
  // devices.list('bob') does not contain BOARD; devices.list('alice') does; devices.list() (no principal) does
test('a board id plus a wrong proof never gets a session')  // claimed board, proof 'f'.repeat(64) -> 401; record.cloud.lastAuthFailureAt set
test('login with the right proof returns a bearer session and the nonce is single use')
  // login ok -> session 48 hex; same nonce again -> 401; authenticate(`Bearer ${session}`).deviceId === BOARD; authenticate('Bearer nope') -> 401
test('sessions expire and are bounded per board')  // advance t by 24h+1 -> authenticate 401; five logins -> sessionsFor(BOARD).length === 4, first session 401
test('touch keeps last seen and online state')  // touch -> isOnline true; t += 300 -> false; describe(BOARD).cloud.online false, .cloud.lastSeenAt set, describe().identity.build from lastReport
test('claiming before the board ever connected is verified at first login')
  // claim BOARD with SECRET and no pending registration -> record.cloud.verified === false; later login with the right proof -> verified true; with a wrong token claimed -> login 401 and lastAuthFailureAt set
test('challenge and login are rate limited per ip')  // 61 challenges from ip 'x' -> the 61st throws 429
test('a cloud-only record is not probed over the LAN')  // devices.refresh() with deps.discover that throws -> resolves, record described as not LAN online
```

- [ ] **Step 2: Run it; expected: FAIL**

- [ ] **Step 3: Implement the `devices.js` changes and `cloud-devices.js`**

Rate limiter: a `Map` of buckets keyed `ip:<ip>` and `id:<id>`, capacity 60 per minute for ip and 20 per minute for id, refilled by elapsed `now()`.

- [ ] **Step 4: Run `node --test test/cloud-devices.test.js test/lan.test.js`; expected PASS**

### Task 3: Cloud deployment store and the simulated cloud board

**Files:**
- Create: `builder/lib/cloud-ota.js`, `builder/lib/fake-cloud-device.js`
- Test: `builder/test/cloud.test.js`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces `cloud-ota.js`: `class CloudDeploymentStore({config, jobs, devices, cloud, now = Date.now, log})`:
  - `create({jobId, deviceId, ownerId}) -> snapshot` (throws `CloudError(400|403|409)`; 409 code `duplicate` when `activeFor(deviceId)` exists; `expiresAt = now + config.cloud.jobTtlMs`);
  - `list({ownerId, deviceId}) -> snapshots` newest first (max 50); `get(id) -> snapshot|null`; `cancel(id) -> snapshot` (throws 409 unless `pending`); `subscribe(id, fn) -> unsubscribe`; `activeFor(deviceId) -> deployment|null` (states pending, downloading, installing, rebooting);
  - device side: `poll(deviceId, report) -> {job: manifest|null, ack: {jobId, action: 'confirm'|'clear'|'rollback'}|null, pollMs}` where `report.ready === '1'` is required to hand out a job and `report.boot_job` triggers the acknowledgment logic; `manifest = {job, build, size, sha256, demo, app, ver, url: '/api/device/jobs/<id>/firmware', chunk}`;
  - `openFirmware(jobId, deviceId, {range}) -> {stream, status: 200|206, start, end, size, sha256, buildId}` (throws 404 unknown, 403 other board, 409 not downloading, 416 bad range; counts an attempt per call; the sixth call throws 409 `attempts` after failing the job);
  - `report(jobId, deviceId, {phase, received, total, error, heap, heap_min}) -> snapshot` (throws 403 for another board; accepted phases `downloading`, `installing`, `rebooting`, `succeeded`, `failed`; `succeeded` is only accepted while the job is `rebooting` or `confirming` stage; out-of-order phases are ignored with the current snapshot returned);
  - `tick() -> number` (applies the four timeouts; returns how many changed); `persist()` to `<buildsDir>/cloud-deployments.json`; constructor reloads it and keeps the last 100.
  - Snapshot: `{id, transport: 'cloud', jobId, buildId, appName, appVersion, demo, deviceId, ownerId, state, stage, offline, total, received, percent, attempts, error, reason, checks, timings: {queuedMs, downloadMs, installMs, rebootMs, totalMs}, createdAt, updatedAt, expiresAt, claimedAt, finishedAt, deviceLastSeenAt, before: {build}, after: {build}, note}`; `reason` for failed is one of `expired, stalled, reboot_timeout, confirm_timeout, device, rolled_back, safe_mode, attempts, cancelled`.
  - On `succeeded` and `failed` it calls `jobs.recordDeployment(jobId, {deviceId, result, detail, transport: 'cloud'})`.
- Produces `fake-cloud-device.js`: `createFakeCloudDevice({id, demo, secret, baseUrl, build = 'stock', state = null, faults = {}, pollMs = 60, chunkBytes = 64 * 1024, log}) -> {start(), stop(), state, events, stats: {logins, polls, downloads, reports}, waitFor(predicate, timeoutMs)}`. Faults: `offline`, `wrongToken`, `dropDownloadAfterBytes` (once), `vanishAfterPhase` (`'downloading'|'installing'|'rebooting'`), `rollbackOnReboot`, `safeModeOnReboot`, `noReboot`, `busy`, `rebootMs`, `heap`. It validates the ESP header, demo identity, build id, target id and SHA-256 exactly like `fake-device.js` and refuses a job whose `demo` or `build` disagree with the stream; it persists `state.bootMarker = {job, build}` before "rebooting" and reports `boot_job`/`boot_build` on the first poll after; it confirms only on `ack action=confirm`; on `action=rollback` it restores `state.previousBuild`.

- [ ] **Step 1: Write `builder/test/cloud.test.js`**

Harness `boot({demo = 1, firmware = {}, faults = {}, clock})` like `lan.test.js`: `tempConfig` with `cloud` timings `{pollMs: 60, jobTtlMs: 2000, stallMs: 400, rebootTimeoutMs: 800, confirmTimeoutMs: 400, offlineAfterMs: 200, maxAttempts: 5, chunkBytes: 65536}`, a ready job with a synthetic image (300 KiB) carrying the three markers, a `DeviceRegistry`, a `CloudDeviceService`, a `CloudDeploymentStore`, and a tiny `node:http` server exposing the five device routes through the stores (a local helper `deviceServer()` inside the test, so the store is exercised over HTTP exactly as the real server will do it; Task 4 replaces nothing here). Then:

```js
test('pairing: wrong token refused, right token claims, other owner cannot deploy')
test('wrong device id: a job addressed to another board is never offered to this board')  // create for BOARD2 (claimed) -> fake BOARD polls -> no manifest; firmware GET with BOARD session -> 403
test('firmware mismatch: demo and bound-device mismatches are refused at create; a digest mismatch is refused by the board')
test('duplicate deployments are refused while one is active')  // second create -> 409 code duplicate
test('an offline board shows offline, then picks the job up and succeeds')  // states seen: pending(offline true) -> downloading -> installing -> rebooting -> succeeded; after.build === buildId; device confirmed
test('an interrupted download resumes with a range and succeeds')  // faults dropDownloadAfterBytes: 100k; result succeeded; attempts === 2; the fake device's second request carried Range
test('download retries are capped')  // faults dropDownloadAlways -> failed reason 'attempts'
test('an expired job fails and is never handed out')  // clock past ttl, tick() -> failed reason 'expired'; device poll -> job null
test('lost network during download fails the job after the stall timeout')  // vanishAfterPhase 'downloading' -> tick after stallMs -> failed reason 'stalled'
test('reboot confirmation: rolled back board fails the job, safe mode asks for rollback, never returning fails after the timeout')
test('late success: a board that returns after the reboot timeout still completes the job')
test('poll with ready=0 leaves the job pending')          // Review Focus 1
test('firmware range handling')                            // Review Focus 3: 416 past the end, 409 once installing
test('reports from another board are refused')            // Review Focus 5
test('cancel works only while pending')
test('the store survives a restart')                       // new store on the same buildsDir sees the pending job
```

- [ ] **Step 2: Run it; expected: FAIL**

- [ ] **Step 3: Implement `cloud-ota.js`**

State transitions:
- `poll`: `pending` + `ready === '1'` + not expired -> `downloading` (`claimedAt`, `timings.queuedMs`), manifest returned; `boot_job` present: match `boot_build === job.buildId` and `report.build === job.buildId` and `safe !== '1'` -> stage `confirming`, `ack confirm`; `report.build !== job.buildId` -> `failed rolled_back`, `ack clear`; `safe === '1'` -> `failed safe_mode`, `ack rollback`; job already `failed` with reason `reboot_timeout|stalled|confirm_timeout` but build matches -> `succeeded` with `note = 'succeeded after the timeout'`.
- `report`: `downloading` (progress, `received`, `percent`), `installing`, `rebooting` (`rebootingAt`), `succeeded` (only from `rebooting`/`confirming`; `after.build`, `finishedAt`, `timings.totalMs`), `failed` (any active state).
- `tick`: as in Global Constraints.

- [ ] **Step 4: Implement `fake-cloud-device.js`**

- [ ] **Step 5: Run `node --test test/cloud.test.js`; expected PASS**

### Task 4: Server routes, principal, key exemption, unified deployments, simulated cloud boards

**Files:**
- Modify: `builder/server.js` (routes, `keyPresented` exemption, `principalOf`, `readForm`, keep-alive, tick timer, `startSimulatedDevices`), `builder/test/lan-server.test.js` (boot helper passes the new stores), `builder/test/server.test.js` (unchanged behaviour must still pass)
- Test: `builder/test/cloud-server.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces `server.js` exports: `createServer({config, jobs, devices, deployments, cloud, cloudDeployments, installer, pioVersion, simulated})`, `principalOf(req, config) -> string`, `startSimulatedDevices(config, devices, {cloud, baseUrl}) -> [{lan, cloudAgent}]` (the cloud agent is started only when `baseUrl` is given, after `listen`).
- Routes (device, no dashboard key): `GET /api/device/challenge?id=`, `POST /api/device/login`, `POST /api/device/poll`, `GET /api/device/jobs/:id/firmware` (honours `Range`), `POST /api/device/jobs/:id/status`. Responses are kv; errors are `ok=0\ncode=<code>\nerror=<message>\n` with the `CloudError.status`.
- Routes (dashboard, key + principal): `POST /api/devices/claim {id, token, name}` -> `{device}`; `GET /api/devices` -> `{devices, unclaimed, refreshedAt}`; owner checks (403 `{error: 'This board belongs to another dashboard user'}`) on `DELETE /api/devices/:id`, `/probe`, `/control`, `POST /api/builds/:id/deploy`; `POST /api/builds/:id/deploy {deviceId, via?}` picks `cloud` when `via === 'cloud'` or (no `via`, no LAN host known, cloud registered); `GET /api/deployments` merges LAN and cloud (owner filtered); `GET /api/deployments/:id`, `/events`, `POST /:id/abort` serve both stores; `/api/health` adds `cloud: {publicUrl, pollMs, jobTtlMs}`.
- `server.keepAliveTimeout = 65000`, `server.headersTimeout = 66000`; a 5 s `tick` interval created in `createServer` and cleared on `server.on('close')`.

- [ ] **Step 1: Write `builder/test/cloud-server.test.js`**

```js
test('device routes work without the dashboard key and dashboard routes still require it')  // boot({key}) ; GET /api/device/challenge?id= -> 200 text/plain 'ok=1'; GET /api/devices without key -> 401
test('claim, list with last seen and unclaimed, deploy via cloud, follow over SSE and polling')  // fake cloud device against the server; x-atech-user 'alice'; states in SSE text include "downloading" and "succeeded"; /api/devices shows cloud.online and lastSeenAt
test('ownership: bob cannot see, deploy to, or forget alice's board')  // 403s; list for bob excludes it
test('principalOf: header honoured only with a key')  // principalOf({headers: {'x-atech-user': 'a'}}, {dashboardKey: null}) === 'local'; with key -> 'a'; key but no header -> 'local'
test('a cancelled pending job is reported and the board never receives it')
test('simulated boards register over the cloud too')  // startSimulatedDevices with baseUrl -> /api/devices shows via 'cloud' or 'lan' and both paired
```

- [ ] **Step 2: Run it; expected: FAIL**

- [ ] **Step 3: Implement the server changes; wire the stores in `main()`; start simulated cloud agents after `listen` pointing at `http://127.0.0.1:<port>`**

- [ ] **Step 4: Run `npm test`; expected: all pass (update `lan-server.test.js` boot helper for the new constructor arguments)**

### Task 5: Build pipeline: cloud URL flag, size check script, PlatformIO configuration

**Files:**
- Create: `shared/tools/check_ota_size.py`
- Modify: `builder/lib/workspace.js` (`rewritePlatformioIni`, `prepareWorkspace`), `builder/lib/installer.js` (`ensureBaseBuild` env), `demo1-custom-gatt/platformio.ini`, `demo2-bleota-library/platformio.ini`
- Test: `builder/test/workspace.test.js` (append), `builder/test/installer.test.js` (append)

**Interfaces:**
- Produces `rewritePlatformioIni(ini, {sharedDir, cacheDir, cloudUrl = null}) -> string`: rewrites `extra_scripts = post:../shared/tools/check_ota_size.py` to `post:<sharedDir>/tools/check_ota_size.py`; when `cloudUrl` is set, the `[env:ai]` `build_flags` line ends with ` '-DATECH_CLOUD_URL="<cloudUrl>"'`.
- Produces `installer.ensureBaseBuild(demo, {config, force, onLine})`: passes `env: {PLATFORMIO_BUILD_FLAGS: '-DATECH_CLOUD_URL="<publicUrl>"'}` to `runPio` when `config.publicUrl` is set (export `buildFlagsEnv(config) -> object` for the test).
- `platformio.ini` (both demos) `[env]` gains `board_build.flash_mode = qio`, `board_upload.maximum_size = 6291456`, `extra_scripts = post:../shared/tools/check_ota_size.py`, and a comment stating N16R8 = 16 MB flash (qio) + 8 MB PSRAM (opi).
- `check_ota_size.py`: post action on `$BUILD_DIR/${PROGNAME}.bin`; reads `board_build.partitions` from the project dir; requires `ota_0` and `ota_1` of equal size; prints `[atech] firmware.bin <bytes> bytes fits the <slot>-byte OTA slot (<free> bytes free after a 65536-byte margin)` or prints the overflow and calls `env.Exit(1)`.

- [ ] **Step 1: Append tests**

`workspace.test.js`: `rewritePlatformioIni(demo1Ini, {sharedDir: '/abs/shared', cacheDir: '/abs/cache'})` matches `/^extra_scripts = post:\/abs\/shared\/tools\/check_ota_size\.py$/m`; with `cloudUrl: 'https://api.example.com'` the `[env:ai]` section matches `/'-DATECH_CLOUD_URL="https:\/\/api\.example\.com"'/` and `[env:base]` does not. `installer.test.js`: `buildFlagsEnv({publicUrl: null})` deep-equals `{}`; `buildFlagsEnv({publicUrl: 'https://a.b'})` deep-equals `{PLATFORMIO_BUILD_FLAGS: '-DATECH_CLOUD_URL="https://a.b"'}`.

- [ ] **Step 2: Run; expected FAIL. Step 3: implement. Step 4: run `npm test`; expected PASS**

- [ ] **Step 5: Verify the script on a real build**

Run: `cd demo1-custom-gatt && pio run -e base 2>&1 | grep -E "\[atech\]|SUCCESS|error"`; expected the `[atech] firmware.bin ... fits` line and `SUCCESS`. Same for `demo2-bleota-library`.

### Task 6: Firmware: image sink, cloud agent, core hook, portal card, demo wiring

**Files:**
- Create: `shared/AtechCloudOta/library.json`, `shared/AtechCloudOta/src/AtechImageSink.h`, `shared/AtechCloudOta/src/AtechImageSink.cpp`, `shared/AtechCloudOta/src/AtechCloudOta.h`, `shared/AtechCloudOta/src/AtechCloudOta.cpp`, `shared/AtechCloudOta/agent.test.js`
- Modify: `shared/AtechCore/src/AtechCore.h` (`holdAutoConfirm`), `shared/AtechCore/src/AtechCore.cpp` (version `1.2.0`, gate), `shared/AtechCore/library.json`, `shared/AtechCore/core.test.js`; `shared/AtechWifiLan/src/AtechWifiLan.h/.cpp` (`extraIdentity`); `shared/AtechWifiOta/src/AtechWifiOta.h/.cpp` (`cloud` pointer, Cloud card, routes); `demo1-custom-gatt/src/main.cpp`, `demo2-bleota-library/src/main.cpp`; `demo2-bleota-library/firmware.test.js` (append)

**Interfaces:**
- `AtechCoreConfig` gains `bool (*holdAutoConfirm)();` (null = never hold). `coreLoop` auto-confirms only when it returns false.
- `AtechWifiLanConfig` gains `String (*extraIdentity)();` whose return (a JSON object text or empty) is appended as `"cloud":<json>` to `/api/identity`.
- `AtechWifiOtaConfig` gains `AtechCloudOta *cloud;`. Portal routes: `GET /api/cloud/status` (the agent's `statusJson()`), `POST /api/cloud/save` (form `url`, authorized), `POST /api/cloud/clear` (authorized). Card ids: `cloudCard`, `cloudStatus`, `cloudUrl`, `cloudSave`, `cloudClear`.
- `atech::ImageSink` (in `AtechImageSink.h`): `bool begin(uint32_t size, const String &sha256Hex, const String &buildId, const String &imageIdentity, String &reason)`; `bool write(const uint8_t *data, size_t length, String &reason)`; `bool finish(String &reason)` (marker checks, digest, `esp_ota_end`, `esp_ota_set_boot_partition`); `void abort()`; `uint32_t received() const`; `const char *partitionLabel() const`.
- `AtechCloudOtaConfig` and `AtechCloudOta` exactly as the spec's device section: `begin(const AtechCloudOtaConfig &)`, `loop()`, `isTransferring()`, `isEnabled()`, `holdsConfirm()`, `serverUrl()`, `setServerUrl(const String &)`, `clearServerUrl()`, `hasStoredUrl()`, `statusJson()`, `lastError()`, `stateName()`. Constants: `AGENT_MARKER[] = "ATECH-CLOUD-AGENT:1"`, `LOGIN_PREFIX[] = "atech-cloud-login/1\n"`, states `disabled, waiting_wifi, unclaimed, idle, downloading, installing, rebooting, confirming, error`.
- Device request bodies (form): login `id, nonce, proof, demo, fw, build, app, ver, slot_size, core, agent, pending, safe, up, loops, rssi, heap, heap_min, boot_job, boot_build`; poll adds `ready, transferring`; status `phase, received, total, error, elapsed, heap, heap_min`.
- Both `main.cpp`: `AtechCloudOta cloudOta;` started after the LAN service and before the portal; busy checks (`otaTransportBusy`/`anyOtaBusy`, `lanBlockedByOthers`, `bleBlocksWifiOta`/`otherOtaBusy`) include `cloudOta.isTransferring()`; advertising pauses while `wifiLan.isTransferring() || cloudOta.isTransferring()`; `coreConfig.holdAutoConfirm = cloudHoldsConfirm` (a free function returning `cloudOta.holdsConfirm()`); `lanConfig.extraIdentity = cloudIdentity`; `wifiOtaConfig.cloud = &cloudOta`; `#ifndef ATECH_CLOUD_URL #define ATECH_CLOUD_URL "" #endif`; `#ifndef ATECH_CLOUD_ALLOW_HTTP #define ATECH_CLOUD_ALLOW_HTTP 0 #endif`.

- [ ] **Step 1: Write `shared/AtechCloudOta/agent.test.js` (structure test, like `core.test.js`)**

Assert: `AtechCloudOta.cpp` contains `"atech-cloud-login/1\n"`, `ATECH-CLOUD-AGENT:1`, `useBuiltinCACertBundle`, `esp_ota_mark_app_invalid_rollback_and_reboot`, `Range: bytes=` or `"Range"`, `xTaskCreatePinnedToCore`, `coreTryAcquireOta("cloud")`, `Authorization`, `Bearer `, `https://`, `ATECH_CLOUD_ALLOW_HTTP`; it never contains `setInsecure`; `AtechImageSink.cpp` contains `esp_ota_begin`, `esp_ota_end`, `esp_ota_set_boot_partition`, `ESP_CHIP_ID_ESP32S3`, `ESP_IMAGE_FLASH_SIZE_16MB`, `ESP_APP_DESC_MAGIC_WORD`, `ATECH-TARGET:`, `ATECH-BUILD:`; both `main.cpp` files contain `#include <AtechCloudOta.h>`, `cloudOta.isTransferring()`, `holdAutoConfirm`, `wifiOtaConfig.cloud = &cloudOta`, `ATECH_CLOUD_URL`; `AtechCore.cpp` version `1.2.0`; `AtechWifiOta.cpp` portal HTML contains ids `cloudStatus`, `cloudUrl`, `cloudSave`, and the portal script never prints the token. Append to `core.test.js`: `holdAutoConfirm` in `AtechCore.h`, version regex updated to `1.2.0`. Append to `demo2 firmware.test.js`: `/cloudOta\.isTransferring\(\)/` and `/#include <AtechCloudOta\.h>/`.

- [ ] **Step 2: Run the three structure tests; expected FAIL**

- [ ] **Step 3: Implement `AtechImageSink` (port of the LAN session's `validatePrefix`, `consume`, `finish` logic with the KMP scanners)**

- [ ] **Step 4: Implement `AtechCloudOta`**

Agent loop (task function), one pass every 250 ms:
1. Not enabled or `!wifiConnected()` -> state `waiting_wifi`/`disabled`, sleep.
2. No session -> at most one login per backoff (5 s, doubling to 120 s on failure, reset on success): `GET challenge` then `POST login`; 403 `unclaimed` -> state `unclaimed`, backoff 30 s; 401 -> state `error` ("pairing token rejected"), backoff; success -> `idle`, `pollMs` from the response.
3. Boot marker present and not yet acknowledged -> poll with `boot_job`/`boot_build`; `action=confirm` -> wait until `atech::appLoops() > 0 && !atech::safeMode()`, then `atech::confirmBoot()`, report `succeeded`, clear `job`/`expect`, write `done`; `action=clear` -> clear marker; `action=rollback` -> `esp_ota_mark_app_invalid_rollback_and_reboot()`. If the running build id differs from `expect` at boot, report `failed` with "rolled back to <build>" and clear the marker before anything else. If no acknowledgment within `confirmTimeoutMs` of boot and the image is still pending -> rollback and reboot.
4. Every `pollMs`: poll with `ready = !otherOtaBusy() && coreOtaOwner() is empty`; a manifest with `demo` mismatch or `job == done` is reported `failed` and ignored; otherwise run the job.
5. Job: `coreTryAcquireOta("cloud")`, `coreSuspendApp()`, `sink.begin(...)`, then loop: `GET firmware` with `Range: bytes=<received>-<received+chunk-1>` on the kept-alive client, expect 206 (or 200 at offset 0), stream into the sink in 4 KiB reads with a 15 s inactivity limit, after each chunk `POST status phase=downloading received=<n> total=<size>`; on a transport error reconnect and continue from `sink.received()` (up to 5 failures, then report `failed`); on `sink.write` failure report `failed` and stop. After the last chunk: report `installing`, `sink.finish()`, write marker `job`/`expect` to NVS, report `rebooting`, release flash lock, `delay(1500)`, `ESP.restart()`.
6. All reports carry `heap=<esp_get_free_internal_heap_size()>` and `heap_min=<esp_get_minimum_free_heap_size()>`.

- [ ] **Step 5: Core hook, LAN `extraIdentity`, portal Cloud card and routes, both `main.cpp`**

- [ ] **Step 6: Compile every environment**

Run: `cd demo1-custom-gatt && pio run -e base -e updated -e ai` and the same in `demo2-bleota-library`; expected: `6 succeeded`, each with the `[atech] firmware.bin ... fits` line. Also `ATECH_REAL_BUILD=1 node --test test/workspace.test.js` in `builder/` (compiles through the workspace with the absolute extra script).

- [ ] **Step 7: Run the structure tests; expected PASS. Confirm `strings .pio/build/base/firmware.bin | grep -c ATECH-CLOUD-AGENT:1` prints at least 1 for both demos.**

### Task 7: Dashboard: registered boards, claim, cloud deploy states

**Files:**
- Modify: `web-shared/atech-builder.js`, `web-shared/builder.css`, `demo1-custom-gatt/web/index.html`, `demo2-bleota-library/web/index.html`, `web-shared/atech-builder.test.js`, `builder/test/dashboard-hosted.test.js`
- Test: `builder/test/dashboard-cloud.test.js`

**Interfaces:**
- Consumes: Task 4 response shapes (`/api/devices` -> `{devices, unclaimed}`, deployment snapshots with `transport: 'cloud'`).
- Produces in `atech-builder.js`: `CLOUD_PHASES = [['pending', 'Queued'], ['downloading', 'Download'], ['installing', 'Install'], ['rebooting', 'Reboot'], ['succeeded', 'Done']]`; `methodLabel(method) -> 'Cloud Wi-Fi'|'Wi-Fi'|'Bluetooth'|'Board hotspot'` (`Cloud Wi-Fi` when the selected device is cloud-registered and not LAN-online); `formatAgo(iso) -> '4 s ago'|'2 min ago'|'3 h ago'|'never'`; `wifiAvailability()` returns `{ok, reason, via: 'cloud'|'lan', offline}`; `deployWifi` posts `{deviceId, via: 'cloud'}` for cloud and `{deviceId}` for LAN; `renderDeployment` branches on `deployment.transport === 'cloud'`; `claimDevice()` posts `/api/devices/claim`; `renderDeviceList` adds rows for `state.unclaimed` with a **Claim** button that opens the claim form prefilled; the recovery buttons are hidden when `via === 'cloud'` and no BLE connection.
- Exact copy:
  - hosted, no device, `devStatus`: `No board registered yet. Claim your board with its ID and pairing token, or connect over Bluetooth in Chrome or Edge.`
  - hosted, no device, `methodWifiNote`: `No board claimed yet. Claim one in step 1 to deploy through the cloud.`
  - cloud online reason: `<name> online via the cloud (seen <ago>).`
  - cloud offline reason (ok = true): `<name> is offline (last seen <ago>); the job waits for it.`
  - other demo: `<id> runs Demo <n>, this dashboard is Demo <demo>.` (existing)
  - hosted `aiBrowserNote`: `This browser has no Web Bluetooth. Claim your board in step 1 and deploy through the cloud, or download the firmware for the board's hotspot page.`
  - cloud stage text: pending `Waiting for the board to pick up the job.`; offline `The board is offline; the job waits for it to come online.`; downloading `The board is downloading the firmware.`; installing `The board is checking and installing the image.`; rebooting `The board is restarting into the new firmware.`; succeeded `Deployed and confirmed on <deviceId>.`; failed `Cloud Wi-Fi deployment not verified: <error>`; cancelled `Job cancelled before the board picked it up.`
  - badges: `Queued`, `Offline`, `Downloading`, `Installing`, `Restarting`, `Succeeded`, `Failed`, `Cancelled`.
  - `devBadge` for a cloud board: `Online via cloud` / `Offline`; `devStatus`: `Online through the cloud, seen <ago>.` / `Offline. Last seen <ago>. The board polls the cloud every 15 s when it is powered and on Wi-Fi.`

- [ ] **Step 1: Write `builder/test/dashboard-cloud.test.js` (copy the hosted harness)**

```js
test('hosted dashboard lists registered boards with last seen and offers the claim form')
test('claiming posts id, token and name and selects the board')
test('cloud deploy posts via cloud and renders every state')  // sequence pending(offline) -> downloading(received 300) -> installing -> rebooting -> succeeded; assert badges in order, deployPercent '30%' during downloading, final Succeeded
test('a failed cloud job is reported with the failed badge and Bluetooth is offered when connected')
test('cloud board of the other demo keeps Wi-Fi unavailable')   // Review Focus 4
test('Bluetooth deploy and the firmware download fallback are unchanged on the hosted dashboard')
test('Safari with a claimed board deploys through the cloud without Web Bluetooth')
test('local dashboard still offers Find devices and LAN pairing next to claiming')
```

Update `dashboard-hosted.test.js`: the two assertions on `hosted dashboard yet` / `not available yet` become the new copy; `devFind` stays hidden when hosted. Update `atech-builder.test.js`: KNOWN_IDS gains the six ids; replace the `hosted dashboard yet` assertion with `/Claim one in step 1/` and add `/\/api\/devices\/claim/` and `/via: 'cloud'/`.

- [ ] **Step 2: Run; expected FAIL. Step 3: implement (HTML, CSS `.device-row .ago`, JS). Step 4: run `npm test` in `builder/` and the four dashboard structure tests; expected PASS**

### Task 8: Vercel, deploy configuration, documentation

**Files:**
- Modify: `vercel-frontend/vercel.json`, `vercel-frontend/test/vercel-config.test.js`, `vercel-frontend/README.md`, `deploy/builder.env.example`, `deploy/README.md`, `deploy/Caddyfile` (comment only), `builder/.env.example`, `README.md`, `AI_FIRMWARE_BUILDER.md`, `WIFI_LAN_OTA.md`
- Create: `CLOUD_WIFI_OTA.md`

- [ ] **Step 1: `vercel.json` transform `{type: 'request.headers', op: 'set', target: {key: 'x-atech-user'}, args: '$ATECH_DASHBOARD_USER', env: ['ATECH_DASHBOARD_USER']}` inserted before the `authorization` delete; update the test's `deepEqual`; run `cd vercel-frontend && npm test`; expected PASS**

- [ ] **Step 2: Env templates and deploy README: `ATECH_PUBLIC_URL`, `ATECH_CLOUD_*`, the device endpoint needs no key, firewall unchanged (443 already open), `ATECH_SIMULATED_DEVICE` now registers cloud boards too**

- [ ] **Step 3: Write `CLOUD_WIFI_OTA.md`** with sections: Status (nothing on hardware), Architecture, First-time bootstrap (USB installer or existing BLE OTA, then hotspot Wi-Fi join, then claim), Protocol (every route with request and response fields), Job lifecycle and timeouts, Security review, Dashboard states, Physical end-to-end checklist (numbered, with expected serial lines and expected dashboard states, including interrupted download, power loss mid-download, rollback, safe mode, expired job, offline board, heap watch), Unresolved.

- [ ] **Step 4: Update README (status line and the flow), AI_FIRMWARE_BUILDER (HTTP API table rows), WIFI_LAN_OTA (one line pointing to the cloud path), vercel-frontend README (the "What works where" table: cloud Wi-Fi yes everywhere)**

### Task 9: Whole-system verification

- [ ] **Step 1: `cd builder && npm test`; every module test; `cd vercel-frontend && npm test`; `node --test "deploy/*.test.js"`; all green**
- [ ] **Step 2: `pio run -e base -e updated -e ai` in both demos; six successes**
- [ ] **Step 3: Hosted emulation end to end without hardware: start the backend with `ATECH_BUILDER_HOST=0.0.0.0 ATECH_BUILDER_PORT=5199 ATECH_BUILDER_KEY=devkey ATECH_SIMULATED_DEVICE=all ATECH_PUBLIC_URL=http://127.0.0.1:5199`, the Vercel dev server in front, open `/demo1/` in Chrome, generate a build (real model call) or reuse a ready one, Cloud Wi-Fi Deploy, watch the states to Succeeded. Record what was observed.**
- [ ] **Step 4: Fresh reviewer on the whole working tree against the spec; fix findings; re-run Step 1**
