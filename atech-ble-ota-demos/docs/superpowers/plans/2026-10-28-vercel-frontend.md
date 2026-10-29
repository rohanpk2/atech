# Vercel-hosted dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve both Atech dashboards from Vercel at `/demo1/` and `/demo2/`, proxy `/api/*` to the Droplet backend over HTTPS with the backend key injected by Vercel, behind a sign-in, with polling instead of SSE, without breaking local development.

**Architecture:** A new `vercel-frontend/` directory is the Vercel Root Directory. Its build script copies the unchanged dashboards and shared modules into `dist/` and writes a hosted runtime config; `vercel.json` routes `/api/*` to `${ATECH_BACKEND_URL}` and sets `x-atech-key` from an environment variable; a Routing Middleware enforces HTTP Basic auth on every path. The shared dashboard module reads the runtime config for the API base, the transport (poll or auto) and hosted copy. A Caddy overlay gives the Droplet HTTPS; it is written, not deployed.

**Tech Stack:** Node 20+ (ESM in `vercel-frontend/`, CommonJS elsewhere as today), `node --test`, jsdom (already in `builder/devDependencies`), `@vercel/functions` for `next()`, Caddy 2 in Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-28-vercel-frontend-design.md`

## Global Constraints

- No commits in this session: the owner reviews the working tree and commits. Each task still ends with its tests green.
- No em dashes (U+2014) in any HTML, JS, CSS or Markdown touched (existing structure tests enforce this on dashboards).
- Every `$('id')` referenced by `web-shared/atech-builder.js` must exist in both `index.html` files and in `KNOWN_IDS` of `web-shared/atech-builder.test.js`. This plan adds no new ids.
- The literal strings `/api/builds/${job.id}/deploy`, `/api/deployments/${id}/events`, `/api/devices/pair`, `/api/builds/${...}/firmware.bin`, `EventSource(` and `function poll` must stay in `atech-builder.js` (structure test).
- Hosted config values are exactly `{apiBase: '', transport: 'poll', hosted: true, pollMs: 3000}`; local default is `{apiBase: '', transport: 'auto', hosted: false, pollMs: 2000}`.
- Environment variable names: `ATECH_BACKEND_URL`, `ATECH_BUILDER_KEY`, `ATECH_DASHBOARD_USER`, `ATECH_DASHBOARD_PASSWORD`, `ATECH_ALLOW_MISSING_ENV`, `ATECH_PUBLIC_HOST`.
- `ATECH_BACKEND_URL` must match `^https://[A-Za-z0-9.-]+(:[0-9]+)?$` at Vercel build time.
- Nothing in `dist/` may contain the value of `ATECH_BUILDER_KEY`, `ATECH_DASHBOARD_PASSWORD` or `ANTHROPIC_API_KEY`; no `*.test.js`, dotfiles or `node_modules` are copied.
- Nothing is deployed and no DigitalOcean setting is changed.

## Review Focus

- A request with an `x-atech-key` header supplied by the browser must not reach the backend with that value: the Vercel transform uses `op: set` (replaces), and the dev server must do the same. Test in Task 4.
- A `firmware.bin` download (binary, `content-disposition: attachment`) must stream unchanged through the dev proxy, with status and headers intact. Test in Task 4.
- Credentials with a colon in the password (`user:pa:ss`) must authenticate: split only at the first colon. Test in Task 2.
- Opening `/demo1` without the trailing slash must redirect to `/demo1/`, otherwise `app.js` resolves to `/app.js` and the page is blank. Explicit `redirects` in `vercel.json` (Task 3 test) and a 308 in the dev server (Task 4 test). `trailingSlash: true` is not an option: it would 308 every extension-less `/api` path before the proxy route (see the design's post-check decisions).
- A build job that fails while polled must end in the `Failed` badge with its error and stop polling; a job whose poll request errors once must keep polling. Test in Task 1.

---

### Task 1: Runtime config and hosted mode in the shared dashboard module

**Files:**
- Create: `web-shared/atech-config.js`
- Modify: `web-shared/atech-builder.js` (constants at top, `adoptKey`/`mount` start, `api()`, `wifiAvailability`, `renderDevice`, `findDevices`, `followDeployment`, `checkBackend`, `render` download href, `follow`, `startDevicePolling`, the `aiBrowserNote` copy near the end)
- Modify: `demo1-custom-gatt/web/index.html:266`, `demo2-bleota-library/web/index.html:240` (add the config script before `atech-identity.js`)
- Modify: `demo1-custom-gatt/web/install.html`, `demo2-bleota-library/web/install.html`
- Modify: `web-shared/atech-builder.test.js` (new assertions)
- Test: `builder/test/dashboard-hosted.test.js` (new)

**Interfaces:**
- Produces: `window.ATECH_CONFIG = {apiBase: string, transport: 'auto'|'poll', hosted: boolean, pollMs: number}` read once at `mount()`.
- Produces: inside `mount()`, `apiUrl(path: string): string` returning `apiBase + path`; `api(path, init)` calls `fetch(apiUrl(path), ...)`; `EventSource` and `download.href` use `apiUrl(...)` too.
- Produces (copy, exact):
  - Wi-Fi reason, hosted, no device: `Not available from the hosted dashboard yet: the build service runs in the cloud, not on your Wi-Fi.`
  - `devStatus`, hosted, no device and no Bluetooth identity: `Wi-Fi deployment from this hosted dashboard is not available yet. Connect over Bluetooth in Chrome or Edge, or download the firmware for the board's hotspot page.`
  - `aiBackend` offline, hosted: `Build service unreachable. The hosted dashboard could not reach the backend; try again in a minute.`
  - `aiBackend` offline, hosted, key refused: `Build service refused the hosted dashboard key. Check ATECH_BUILDER_KEY on Vercel.`
  - `keyBanner`, hosted: `The build service rejected this dashboard's key. The Vercel environment variable ATECH_BUILDER_KEY must match the backend's key.`
  - `aiBrowserNote`, hosted: `This browser has no Web Bluetooth, and Wi-Fi deployment from the hosted dashboard is not available yet. Generate and download the firmware here, then upload it on the board's hotspot page.`
  - `install.html` not-allowed slot: `Web Serial needs a secure page: HTTPS or http://localhost.`
  - `install.html` hosted, base image missing: `The base image is not available on the build service yet. Ask the operator to run deploy/warm-cache.js --base on the server.`

- [ ] **Step 1: Write the failing jsdom test `builder/test/dashboard-hosted.test.js`**

Copy the `bootDashboard` harness from `builder/test/dashboard-deploy.test.js` with two changes: after evaluating `/shared/atech-config.js`, assign `window.ATECH_CONFIG = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30}`; set `window.EventSource = function () { throw new Error('EventSource must not be used in poll mode'); }`. Routes return a sequence for `/api/builds/job1`: a function that yields `generating`, then `compiling`, then `ready` (use `readyJob` from the deploy test, copied).

```js
test('hosted dashboard polls a build to ready without EventSource and offers a same-origin download', async () => {
  const {doc, errors} = await bootDashboard(1, {routes: {'/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}}, '/api/builds/job1': sequence}});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(errors, []);
  assert.equal(doc.getElementById('aiBadge').textContent, 'Validated');
  assert.equal(doc.getElementById('aiCode').textContent, 'void appLoop() {}');
  assert.ok(doc.getElementById('aiDownload').getAttribute('href').endsWith('/api/builds/job1/firmware.bin'));
  assert.equal(doc.getElementById('aiDownload').hidden, false);
});
test('hosted dashboard hides Find devices and explains that cloud Wi-Fi deployment is not available', async () => {
  const {doc} = await bootDashboard(2);
  assert.equal(doc.getElementById('devFind').hidden, true);
  assert.match(doc.getElementById('methodWifiNote').textContent, /hosted dashboard yet/);
  assert.match(doc.getElementById('devStatus').textContent, /not available yet/);
  assert.equal(doc.body.dataset.deployMethod, 'hotspot');
});
test('hosted dashboard still offers Bluetooth when a board is connected', async () => {
  const {doc} = await bootDashboard(1, {connected: true});
  assert.equal(doc.body.dataset.deployMethod, 'ble');
});
test('a failed build ends polling with the Failed badge', async () => { /* sequence: generating, then failed with error 'boom'; assert aiBadge 'Failed', aiStatus matches /boom/, and the number of /api/builds/job1 calls stops growing over 150 ms */ });
test('one failed poll does not stop polling', async () => { /* sequence: generating, then a route returning status 500, then ready; assert aiBadge 'Validated' */ });
test('hosted copy on backend failure names the Vercel key', async () => { /* /api/health -> {status: 401, body: {keyRequired: true}}; assert aiBackend matches /ATECH_BUILDER_KEY on Vercel/ and keyBanner matches /must match the backend's key/ */ });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd builder && node --test test/dashboard-hosted.test.js`
Expected: FAIL (ENOENT for `web-shared/atech-config.js`, then assertion failures).

- [ ] **Step 3: Create `web-shared/atech-config.js`**

A classic script, four lines of comment explaining that the backend serves this default and the Vercel build overwrites it, then exactly:
```js
window.ATECH_CONFIG = {apiBase: '', transport: 'auto', hosted: false, pollMs: 2000};
```

- [ ] **Step 4: Add the script tag to both `index.html` files and both `install.html` files**

`<script src="/shared/atech-config.js?v=1"></script>` as the first script tag in `index.html` (before `atech-identity.js`) and before the inline script in `install.html`.

- [ ] **Step 5: Implement config plumbing in `web-shared/atech-builder.js`**

At the top of `mount()`: `const cfg = root.ATECH_CONFIG || {}; const apiBase = String(cfg.apiBase || '').replace(/\/+$/, ''); const usePolling = cfg.transport === 'poll'; const hosted = Boolean(cfg.hosted); const pollMs = Number(cfg.pollMs) || POLL_MS; const devicePollMs = hosted ? 15000 : DEVICE_POLL_MS;` and `function apiUrl(path) { return apiBase + path; }`. Use `apiUrl` in `api()`, both `EventSource` constructors and the download href; use `pollMs` in both `poll` timers and `devicePollMs` in `startDevicePolling`. In `follow()` and `followDeployment()`: `if (usePolling || typeof win.EventSource !== 'function') { poll(...); return; }`. In `findDevices()`: when `hosted`, return immediately. In `renderDevice()`: `$('devFind').hidden = hosted;` and the hosted `devStatus` copy for the no-device branch. In `wifiAvailability()`: when `hosted` and no device, return the hosted reason. In `api()` and `checkBackend()`: the hosted copy above. The `aiBrowserNote` assignment picks the hosted sentence when `hosted`. The poll in `poll(id)` must keep running after one failed `pollOnce` (it already logs and continues; keep that) and stop on `ready`/`failed` (already in `pollOnce`).

- [ ] **Step 6: Update `install.html` (both demos)**

Inside the inline script: `const cfg = window.ATECH_CONFIG || {}; const apiBase = String(cfg.apiBase || '').replace(/\/+$/, '');` then `if (apiBase) $('installButton').setAttribute('manifest', apiBase + '/api/installer/N/manifest.json');`, prefix both `fetch` URLs with `apiBase`, `if (cfg.hosted) $('buildBase').hidden = true;`, and in `refresh()` when `!status.ready && cfg.hosted` show the hosted copy with tone `error`, badge `Not built`. Replace the not-allowed slot text and change the first list item to `The builder backend serves the four image parts from the Demo N base build.`

- [ ] **Step 7: Extend `web-shared/atech-builder.test.js`**

Add: `assert.match(source, /root\.ATECH_CONFIG/)`, `assert.match(source, /transport === 'poll'/)`, `assert.match(source, /function apiUrl\(/)`, `assert.match(source, /hosted dashboard yet/)`.

- [ ] **Step 8: Run every dashboard test**

Run from `atech-ble-ota-demos/`:
```sh
cd builder && npm test && cd ..
node web-shared/atech-builder.test.js && node web-shared/atech-identity.test.js
node demo1-custom-gatt/web/dashboard.test.js && node demo2-bleota-library/web/dashboard.test.js
```
Expected: all PASS, including the new `dashboard-hosted.test.js`.

---

### Task 2: `vercel-frontend` scaffold, Basic auth helper and middleware

**Files:**
- Create: `vercel-frontend/package.json`, `vercel-frontend/.gitignore`, `vercel-frontend/lib/basic-auth.js`, `vercel-frontend/middleware.js`
- Test: `vercel-frontend/test/basic-auth.test.js`, `vercel-frontend/test/middleware.test.js`

**Interfaces:**
- Produces: `parseBasicAuthorization(header: string | null): {user: string, password: string} | null` (base64 of UTF-8, split at the first colon, `null` for anything malformed).
- Produces: `timingSafeEqualStrings(a: string, b: string): boolean` (compares UTF-8 bytes in constant time over the longer length).
- Produces: `authorize(header: string | null, {user, password}): {status: 'unconfigured' | 'denied' | 'ok'}`; `unconfigured` when either credential is empty or undefined.
- Produces: `middleware.js` default export `(request: Request) => Response`; 503 text when unconfigured, 401 with `www-authenticate: Basic realm="Atech dashboard", charset="UTF-8"` when denied, `next()` when ok. No `config.matcher` (runs on every path).

- [ ] **Step 1: `package.json`** with `"type": "module"`, scripts `build: node build.js`, `dev: node dev-server.js`, `test: node --test`, `engines.node >=20`, dependency `@vercel/functions ^3.10.4`. `.gitignore`: `node_modules/`, `dist/`, `.vercel/`. Run `npm install` to create `package-lock.json`.

- [ ] **Step 2: Write `test/basic-auth.test.js`** (failing): parse of `Basic dXNlcjpwYTpzcw==` gives `{user: 'user', password: 'pa:ss'}`; `Bearer x`, `Basic`, `Basic !!!` give `null`; UTF-8 password `pässword` round-trips; `authorize` returns `unconfigured` for `{user: 'a', password: ''}`, `denied` for a wrong password and for a missing header, `ok` for the right pair; `timingSafeEqualStrings('abc', 'abd') === false`, `('abc','abc') === true`, `('a','abc') === false`.

- [ ] **Step 3: Run it to verify it fails**: `cd vercel-frontend && node --test test/basic-auth.test.js` fails with module not found.

- [ ] **Step 4: Implement `lib/basic-auth.js`** using only `atob`, `TextEncoder`, `TextDecoder` (no Node imports, so it also runs in the dev server and any runtime).

- [ ] **Step 5: Run it to verify it passes.**

- [ ] **Step 6: Write `test/middleware.test.js`** (failing): with `process.env.ATECH_DASHBOARD_USER`/`PASSWORD` unset the response status is 503 and the body mentions `ATECH_DASHBOARD_USER`; with them set and no header, 401 and the `www-authenticate` header above; with a wrong pair, 401; with the right pair, the response has header `x-middleware-next` equal to `1` (what `next()` from `@vercel/functions` returns). Build requests with `new Request('https://example.test/demo1/', {headers})`.

- [ ] **Step 7: Run it to verify it fails**, then **implement `middleware.js`**, then **run to verify it passes.**

---

### Task 3: Build script and `vercel.json`

**Files:**
- Create: `vercel-frontend/build.js`, `vercel-frontend/vercel.json`
- Test: `vercel-frontend/test/build.test.js`, `vercel-frontend/test/vercel-config.test.js`

**Interfaces:**
- Produces: `validateEnv(env: object): string[]` (problems; empty when valid). Rules from Global Constraints; each message names the variable.
- Produces: `hostedConfigSource(): string` returning the two-line config script with `{"apiBase":"","transport":"poll","hosted":true,"pollMs":3000}`.
- Produces: `assembleDist({rootDir, outDir, env, allowMissingEnv = false}): Promise<{files: string[]}>`; `rootDir` is `atech-ble-ota-demos/`; copies `demo1-custom-gatt/web` to `outDir/demo1`, `demo2-bleota-library/web` to `outDir/demo2`, `web-shared` to `outDir/shared`, skipping names ending in `.test.js`, names starting with `.`, and `node_modules`; writes `outDir/shared/atech-config.js` from `hostedConfigSource()`; then throws `Error('Secret value found in build output: <file>')` if any output file contains a non-empty `env.ATECH_BUILDER_KEY`, `env.ATECH_DASHBOARD_PASSWORD` or `env.ANTHROPIC_API_KEY`.
- CLI: `node build.js` uses `rootDir = path.resolve(__dirname, '..')`, `outDir = path.join(__dirname, 'dist')`, `allowMissingEnv = process.env.ATECH_ALLOW_MISSING_ENV === '1'`; prints the file count; exits 1 with the problems listed when validation fails.

- [ ] **Step 1: Write `test/build.test.js`** (failing), using a temp `outDir` and the real `rootDir`:
  - `validateEnv({})` lists four problems naming each variable; `validateEnv({ATECH_BACKEND_URL: 'http://x', ...})` rejects http; `'https://api.example.com/'` (trailing slash) and `'https://api.example.com/api'` are rejected; `'https://api.example.com:8443'` is accepted.
  - `assembleDist` with a valid env creates `demo1/index.html`, `demo1/install.html`, `demo1/app.js`, `demo2/index.html`, `shared/atech-builder.js`, `shared/builder.css`; does not create `shared/atech-builder.test.js`, `demo1/dashboard.test.js` or `demo1/protocol.test.js`; `shared/atech-config.js` contains `"transport":"poll"` and `"hosted":true` and `"pollMs":3000`.
  - no file in `outDir` contains the test key `kEy-SeCrEt-123` (passed as `ATECH_BUILDER_KEY`).
  - `assembleDist` with `env: {}` and `allowMissingEnv: false` rejects with a message naming `ATECH_BACKEND_URL`; with `allowMissingEnv: true` it resolves.
  - a planted file: write `outDir/../plant.txt`? No: instead call `assembleDist` with `env.ATECH_DASHBOARD_PASSWORD` set to a string that does appear in `web-shared/builder.css` (for example `prefers-reduced-motion`) and assert it rejects with `Secret value found in build output`.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `build.js`** (ESM, `node:fs/promises`, `node:path`, `fileURLToPath`). Recursive copy with the filter; the scan reads each output file as UTF-8.

- [ ] **Step 4: Run it to verify it passes.**

- [ ] **Step 5: Write `test/vercel-config.test.js`** (failing): parse `vercel.json`; assert `framework === null`, `buildCommand === 'npm run build'`, `outputDirectory === 'dist'`, `trailingSlash === undefined`; `redirects` contains `{source: '/', destination: '/demo1/', permanent: false}` and `{source: '/demoN', destination: '/demoN/', permanent: true}` for both demos; exactly one route whose `src` matches `/api/`, with `dest === '${ATECH_BACKEND_URL}/api/$1'`, `env` includes `ATECH_BACKEND_URL`, and transforms `[{type: 'request.headers', op: 'set', target: {key: 'x-atech-key'}, args: '$ATECH_BUILDER_KEY', env: ['ATECH_BUILDER_KEY']}, {type: 'request.headers', op: 'delete', target: {key: 'authorization'}}]`; the file text contains no `https://` literal other than the `$schema` URL (the backend URL is never hardcoded).

- [ ] **Step 6: Write `vercel.json`**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "redirects": [
    {"source": "/", "destination": "/demo1/", "permanent": false},
    {"source": "/demo1", "destination": "/demo1/", "permanent": true},
    {"source": "/demo2", "destination": "/demo2/", "permanent": true}
  ],
  "routes": [
    {
      "src": "^/api/(.*)$",
      "dest": "${ATECH_BACKEND_URL}/api/$1",
      "env": ["ATECH_BACKEND_URL"],
      "transforms": [
        {"type": "request.headers", "op": "set", "target": {"key": "x-atech-key"}, "args": "$ATECH_BUILDER_KEY", "env": ["ATECH_BUILDER_KEY"]},
        {"type": "request.headers", "op": "delete", "target": {"key": "authorization"}}
      ]
    }
  ]
}
```

- [ ] **Step 7: Run the config test and the whole `vercel-frontend` suite**: `npm test` passes.

---

### Task 4: Local emulation server

**Files:**
- Create: `vercel-frontend/dev-server.js`
- Test: `vercel-frontend/test/dev-server.test.js`

**Interfaces:**
- Consumes: `authorize` (Task 2), `assembleDist` (Task 3).
- Produces: `createDevServer({distDir, backendUrl, builderKey, user, password, log = () => {}}): http.Server` (not listening). Behaviour: if `user && password`, every request goes through `authorize` (401 with the same `www-authenticate` as the middleware); `/` answers 307 to `/demo1/`; a path matching `^/(demo1|demo2)$` answers 308 to the same path plus `/`; `/api/...` is proxied to `backendUrl + path + search` with the same method, headers (minus `host` and `authorization`, plus `x-atech-key: builderKey` replacing any incoming value when `builderKey` is set), streamed body, and the upstream status, headers and body streamed back; anything else is served from `distDir` (directory to `index.html`, MIME from extension, 404 JSON otherwise, path traversal refused).
- CLI: `node dev-server.js` reads `PORT` (default 3000), `ATECH_BACKEND_URL` (default `http://127.0.0.1:5173`), `ATECH_BUILDER_KEY`, `ATECH_DASHBOARD_USER`, `ATECH_DASHBOARD_PASSWORD`; rebuilds `dist/` first with `assembleDist({..., allowMissingEnv: true})`; prints the URLs and a warning line when no sign-in is configured.

- [ ] **Step 1: Write `test/dev-server.test.js`** (failing): start a fake backend (`node:http`) that records `{method, url, headers, body}` and answers `/api/health` with JSON, `/api/builds` POST with 202 JSON, `/api/builds/job1/firmware.bin` with 1000 bytes of `0xE9` and `content-disposition: attachment; filename="x.bin"`. Build a temp dist with `assembleDist`. Start `createDevServer` on port 0 with `user: 'u', password: 'p', builderKey: 'srv-key'`. Assert: `GET /demo1/` without auth is 401 with the `www-authenticate` header; with auth it is 200 and the body contains `Atech Device Console`; `GET /demo1` is 308 to `/demo1/`; `GET /` is 302 to `/demo1/`; `GET /shared/atech-config.js` contains `"hosted":true`; `GET /api/health?x=1` reaches the backend as `/api/health?x=1` with `x-atech-key: srv-key` even when the client sent `x-atech-key: client-key`; `POST /api/builds` forwards the JSON body and the 202 status; `GET /api/builds/job1/firmware.bin` returns 1000 bytes, status 200 and the `content-disposition` header; `GET /../package.json` and `GET /demo1/%2e%2e/package.json` are 404.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `dev-server.js`** with `node:http`/`node:https` for the upstream request (pick by `backendUrl` protocol), `pipeline` for bodies, and a MIME map matching `builder/server.js`.

- [ ] **Step 4: Run it to verify it passes**, then run `npm test` for the whole directory.

---

### Task 5: Droplet HTTPS overlay

**Files:**
- Create: `deploy/compose.tls.yaml`, `deploy/Caddyfile`, `deploy/caddy.env.example`
- Modify: `deploy/README.md` (replace "Opening it to the internet later" with an "HTTPS for the hosted dashboards" section)
- Modify: `.dockerignore` (add `vercel-frontend`)

**Interfaces:**
- Produces: service `caddy` (image `caddy:2.10-alpine`) joined to the existing default network, `env_file` `${ATECH_CADDY_ENV_FILE:-/etc/atech/caddy.env}` holding `ATECH_PUBLIC_HOST=<dns name>`, ports `80:80`, `443:443`, `443:443/udp`, volumes `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy-data:/data`, `caddy-config:/config`, `restart: unless-stopped`, `depends_on: [builder]`.
- Produces: `Caddyfile` site `{$ATECH_PUBLIC_HOST}` with `handle /api/* { reverse_proxy builder:5173 { flush_interval -1 } }` and a fallback `handle { respond "Atech build service. The dashboards are hosted separately." 404 }`.

- [ ] **Step 1: Write the three files.**

- [ ] **Step 2: Validate the Compose merge locally**

Run (from the repository root, with temp env files so no real secret is needed):
```sh
printf 'ANTHROPIC_API_KEY=x\n' > /tmp/atech-builder.env; printf 'ATECH_PUBLIC_HOST=api.example.com\n' > /tmp/atech-caddy.env
ATECH_ENV_FILE=/tmp/atech-builder.env ATECH_CADDY_ENV_FILE=/tmp/atech-caddy.env docker compose -f atech-ble-ota-demos/deploy/compose.yaml -f atech-ble-ota-demos/deploy/compose.tls.yaml config --services
```
Expected: prints `builder` and `caddy`. If Docker is not running, say so in the report and validate the Caddyfile with `docker run --rm -v "$PWD/atech-ble-ota-demos/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" -e ATECH_PUBLIC_HOST=api.example.com caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile` when it is.

- [ ] **Step 3: Update `deploy/README.md`** with: DNS A record, firewall ports 80 and 443 (manual), `/etc/atech/caddy.env`, the two-file `up -d` command, `curl -si https://<host>/api/health` expecting 401 without the key and `{"ok":true}` with `-H "x-atech-key: $KEY"`, and the sentence that `ATECH_BUILDER_KEY` on Vercel must equal the key the container uses.

---

### Task 6: Documentation and housekeeping

**Files:**
- Create: `vercel-frontend/README.md`
- Modify: `README.md` (one line under "Run it" or "More"), `/Users/rohan/Projects/atech/.gitignore` (add `node_modules/`, `.vercel/`, `atech-ble-ota-demos/vercel-frontend/dist/`)

- [ ] **Step 1: Write `vercel-frontend/README.md`** with these sections: What this is (two sentences and the request diagram from the spec); Vercel project settings (the table from the spec, verbatim values); Environment variables (name, sensitive or not, example, where the value comes from: the key from `/data/builds/dashboard.key` or `ATECH_BUILDER_KEY` on the Droplet); Before the first deploy (Droplet HTTPS, link to `deploy/README.md`); Deploy steps (import repository, set root directory, confirm "Include source files outside of the Root Directory" is on, add env vars, deploy); Verify (open `/demo1/`, sign-in prompt, `Backend online` in the top bar, generate, watch status, download, Chrome Bluetooth, installer page); What the hosted dashboard can and cannot do (Wi-Fi deploy to home boards: not yet; Bluetooth: Chrome and Edge on desktop and Android; Safari: generate and download only); Local emulation (`npm run dev` with the env vars, against `cd builder && ATECH_BUILDER_HOST=0.0.0.0 ATECH_BUILDER_KEY=devkey ATECH_SIMULATED_DEVICE=all npm start`); Rotating secrets.

- [ ] **Step 2: Add the README line and the gitignore entries.**

- [ ] **Step 3: Check nothing new is untracked by mistake**: `git status --short` shows the intended files only; `git check-ignore vercel-frontend/dist vercel-frontend/node_modules` prints both.

---

### Task 7: Verification run

- [ ] **Step 1: All automated suites**, from `atech-ble-ota-demos/`:
```sh
(cd builder && npm test)
(cd vercel-frontend && npm test)
node web-shared/atech-builder.test.js && node web-shared/atech-identity.test.js
node demo1-custom-gatt/web/protocol.test.js && node demo1-custom-gatt/web/dashboard.test.js
node demo2-bleota-library/firmware.test.js && node demo2-bleota-library/web/bleota-client.test.js && node demo2-bleota-library/web/dashboard.test.js
node shared/AtechCore/core.test.js && node shared/AtechWifiOta/portal.test.js
node --test "deploy/*.test.js"
```
Expected: every command exits 0.

- [ ] **Step 2: Browser check** (Chrome via the browser tools): start the backend with `ATECH_BUILDER_HOST=0.0.0.0 ATECH_BUILDER_KEY=devkey ATECH_SIMULATED_DEVICE=all npm start` on port 5173 and the dev server with `PORT=3100 ATECH_BUILDER_KEY=devkey ATECH_DASHBOARD_USER=atech ATECH_DASHBOARD_PASSWORD=<local>`; open `http://atech:<local>@localhost:3100/demo1/` and `/demo2/`: top bar says `Backend online`, `Find devices` hidden, Wi-Fi note carries the hosted text, the simulated board appears, generate one build if a model key is configured (poll to `Validated`, source preview visible, download link works), open `/demo1/install.html` (status answers, no "Build the base image now" button). Record what was and was not exercised.
