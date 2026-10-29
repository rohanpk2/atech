# DigitalOcean Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing Atech AI firmware builder backend (both dashboards, Claude generation, PlatformIO ESP32-S3 compilation, firmware download) in one Docker container on a 2 GB DigitalOcean Droplet, started with `docker compose -f atech-ble-ota-demos/deploy/compose.yaml up -d --build` from the repository root.

**Architecture:** One Debian-based image (`node:24-bookworm-slim` + python3 venv + PlatformIO 6.2.0) that pre-installs the pinned `espressif32 @ 8.0.0` platform, both toolchains, the Arduino framework packages and every `lib_deps` entry at build time so `pio run` never downloads at runtime. The unmodified backend runs as a non-root user with `ATECH_BUILDS_DIR=/data/builds` on a named volume; three more named volumes keep the PlatformIO download cache and the two demo projects' `.pio` directories. Secrets stay in `/etc/atech/builder.env` on the host (compose `env_file`), never in the image. The dashboard key that the backend already requires on non-loopback listeners becomes the authentication layer; the entrypoint persists a generated key so it survives restarts.

**Tech Stack:** Docker 29 / Compose 5, Node 24 LTS, Python 3.11 venv, PlatformIO Core 6.2.0, espressif32 8.0.0 (Arduino-ESP32 3.3.12), `node:test`.

**Spec:** the deployment request of 2026-10-28 (pasted into the session); requirements are restated in Global Constraints.

## Global Constraints

- Build context is `atech-ble-ota-demos/`; Dockerfile and compose live in `atech-ble-ota-demos/deploy/`; the compose command above must work from the repository root.
- Publish only `127.0.0.1:5173:5173`; inside the container the backend listens on `0.0.0.0:5173`.
- Environment comes from `/etc/atech/builder.env` (overridable for local tests with `ATECH_ENV_FILE`); that file is never read at image build time and never copied into the image.
- `ANTHROPIC_API_KEY` must never appear in logs or API responses (already enforced by `builder/lib/redact.js`; nothing new may print `process.env`).
- Exactly one PlatformIO process at a time (already enforced by the queue in `builder/lib/pio.js`); the container limits SCons to one compile job on the 2 GB Droplet via `ATECH_PIO_JOBS=1`.
- Non-root user `atech` (uid 10001), `restart: unless-stopped`, memory limit 1536 MiB plus swap to 3072 MiB, `pids_limit`, `cap_drop: ALL`, `no-new-privileges`, `init: true`, json-file log rotation, a HEALTHCHECK on `/api/health`.
- `.dockerignore` excludes `node_modules`, `.pio`, `.env*` (except `.env.example`), `.ai-builds`, `.DS_Store`, `docs/` and the top-level Markdown.
- Do not move or rewrite the builder. Backend changes are limited to two additive settings: honour `PLATFORMIO_CORE_DIR` in `builder/lib/config.js` and add `ATECH_PIO_JOBS` to pass `-j N` to `pio run`.
- Preserve every existing test; Bluetooth OTA, Wi-Fi OTA, rollback, safety policy and identity code are untouched.
- Do not commit; do not deploy to the Droplet; do not modify `/etc/atech/builder.env`.

## Review Focus

- The builder restarts after a reboot with no `ATECH_BUILDER_KEY` in the env file: the dashboard key must be the same as before the reboot, or every saved dashboard session breaks. Pinned by the entrypoint test in Task 3.
- Health check without the key: `/api/health` answers 401 on a keyed listener, so a naive curl would mark the container unhealthy forever. Pinned by the healthcheck tests in Task 2.
- A named volume mounted on a directory that does not exist in the image is created root-owned and the non-root backend cannot write to it. Pinned by Task 4 (every mount point is created and chowned in the Dockerfile) and the `--network none` compile in Task 7.
- The first AI build for Demo 2 needs the BLEOTA git dependency: without `git` in the image and the pre-populated workspace, the build fails on a Droplet with a flaky network. Pinned by Task 3's `--install-only` warm step run at image build and the offline compile in Task 7.
- `pio run` reinstalls any missing required platform package at run time (verified in `platformio/run/processor.py`, `autoinstall=True`), so trimming the 2.3 GB RISC-V toolchain from the image would make the first build download it again. Pinned by the offline compile in Task 7.

---

### Task 1: Backend settings `PLATFORMIO_CORE_DIR` and `ATECH_PIO_JOBS`

**Files:**
- Modify: `builder/lib/config.js` (`findPio`, `bootApp0`, new `pioJobs`)
- Modify: `builder/lib/pio.js` (`runPio` gains a `jobs` option)
- Modify: `builder/lib/workspace.js:95`, `builder/lib/installer.js:66` (pass `jobs: config.pioJobs`)
- Modify: `builder/.env.example`
- Test: `builder/test/config.test.js`, `builder/test/pio.test.js`

**Interfaces:**
- Produces: `loadConfig(env).pioJobs: number | null`; `loadConfig(env).pio` and `.bootApp0` resolve under `env.PLATFORMIO_CORE_DIR` when set, else `~/.platformio`; `runPio(args, {jobs})` appends `['-j', String(jobs)]` when `args[0] === 'run'` and `jobs` is a positive integer.

- [ ] **Step 1: Write the failing tests**

```js
// config.test.js
test('loadConfig honours PLATFORMIO_CORE_DIR for the pio binary and boot_app0', () => {
  const config = loadConfig({PLATFORMIO_CORE_DIR: '/opt/pio'});
  assert.equal(config.pio, path.join('/opt/pio', 'penv', 'bin', 'pio'));
  assert.equal(config.bootApp0, path.join('/opt/pio', 'packages', 'framework-arduinoespressif32', 'tools', 'partitions', 'boot_app0.bin'));
  assert.equal(loadConfig({PLATFORMIO_CORE_DIR: '/opt/pio', PLATFORMIO_BIN: '/usr/bin/pio'}).pio, '/usr/bin/pio');
});
test('loadConfig parses ATECH_PIO_JOBS and ignores nonsense', () => {
  assert.equal(loadConfig({}).pioJobs, null);
  assert.equal(loadConfig({ATECH_PIO_JOBS: '2'}).pioJobs, 2);
  assert.equal(loadConfig({ATECH_PIO_JOBS: '0'}).pioJobs, null);
  assert.equal(loadConfig({ATECH_PIO_JOBS: 'lots'}).pioJobs, null);
});
// pio.test.js (pioBin: 'echo' makes the log echo the argv)
test('runPio passes -j to pio run only when jobs is set', async () => {
  assert.equal((await runPio(['run', '-e', 'ai'], {pioBin: 'echo', jobs: 1})).log.trim(), 'run -e ai -j 1');
  assert.equal((await runPio(['run', '-e', 'ai'], {pioBin: 'echo'})).log.trim(), 'run -e ai');
  assert.equal((await runPio(['--version'], {pioBin: 'echo', jobs: 1})).log.trim(), '--version');
});
```

- [ ] **Step 2: Run `cd builder && node --test test/config.test.js test/pio.test.js`; expect the new tests to FAIL.**
- [ ] **Step 3: Implement.** `findPio(env)` and `bootApp0` use `pioHome = env.PLATFORMIO_CORE_DIR ? path.resolve(env.PLATFORMIO_CORE_DIR) : path.join(os.homedir(), '.platformio')`. `pioJobs = Number.isInteger(n) && n > 0 ? n : null` with `n = Number(env.ATECH_PIO_JOBS)`. In `runPio`, `const jobs = options.jobs ?? loadConfig().pioJobs` is only consulted when `pioBin` is not given to avoid a second `loadConfig()` call: simplest is `const jobs = options.jobs === undefined ? (pioBin ? null : loadConfig().pioJobs) : options.jobs`; append `-j` when `args[0] === 'run'`. Both callers pass `jobs: config.pioJobs`.
- [ ] **Step 4: Run `cd builder && npm test`; expect all PASS.**
- [ ] **Step 5: Add `# ATECH_PIO_JOBS=` and `# PLATFORMIO_CORE_DIR=` lines to `builder/.env.example`.**

### Task 2: Container health check

**Files:**
- Create: `deploy/healthcheck.js`
- Test: `deploy/healthcheck.test.js`

**Interfaces:**
- Produces: `node deploy/healthcheck.js` exits 0 when `GET http://127.0.0.1:$ATECH_BUILDER_PORT/api/health` answers 200 with `{ok:true}` using the key from `ATECH_BUILDER_KEY` or `$ATECH_BUILDS_DIR/dashboard.key`; exits 1 otherwise (including timeout 5 s). Exports `check({port, key})` returning a Promise<boolean> for tests.

- [ ] **Step 1: Write the failing tests** (`node --test deploy/`): a stub `http.createServer` that requires header `x-atech-key: k1` on `/api/health`; `check({port, key: 'k1'})` resolves true, `check({port, key: 'wrong'})` resolves false, `check({port: unusedPort})` resolves false; `readKey({env, buildsDir})` prefers env and falls back to the file.
- [ ] **Step 2: Run, expect FAIL (module missing).**
- [ ] **Step 3: Implement `deploy/healthcheck.js`** with `node:http` only; when run as main, `process.exit(ok ? 0 : 1)`.
- [ ] **Step 4: Run `node --test deploy/`; expect PASS.**

### Task 3: Entrypoint and cache warmer

**Files:**
- Create: `deploy/entrypoint.sh`
- Create: `deploy/warm-cache.js`
- Test: `deploy/entrypoint.test.js`

**Interfaces:**
- `entrypoint.sh`: POSIX sh; if `ATECH_BUILDER_KEY` is empty, read or create `$ATECH_BUILDS_DIR/dashboard.key` (mode 600, 24 random bytes base64url) and export it; then `exec node /app/builder/server.js "$@"`. `ATECH_ENTRYPOINT_CMD` (test hook) replaces the exec target so the test can print the environment.
- `warm-cache.js [--install-only] [--base]`: for demos 1 and 2 call `prepareWorkspace(demo, {code: <stock user_app.cpp>, meta: {buildId: 'warmcache', appName: 'warm', appVersion: 3, targetDeviceId: ''}})` then `runPio(['pkg','install'], {cwd: dir})`; without `--install-only` also `compileWorkspace`; with `--base` also `installer.ensureBaseBuild(demo, {force: true})`. Exit 1 on any failure. Prints only PlatformIO lines passed through `redactSecrets`.

- [ ] **Step 1: Write the failing test**: run `sh deploy/entrypoint.sh` with `ATECH_BUILDS_DIR=<tmp>`, `ATECH_ENTRYPOINT_CMD="node -e 'process.stdout.write(process.env.ATECH_BUILDER_KEY)'"`, twice; assert both outputs are equal, length ≥ 24, file mode 0600; then with `ATECH_BUILDER_KEY=fixed` assert output `fixed` and no file created.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement both scripts.**
- [ ] **Step 4: Run `node --test deploy/`; expect PASS. Run `node deploy/warm-cache.js --install-only` locally with `ATECH_BUILDS_DIR=/tmp/x`; expect exit 0 and `libdeps/ai` populated for both demos.**

### Task 4: Dockerfile and `.dockerignore`

**Files:**
- Create: `deploy/Dockerfile`
- Create: `.dockerignore` (context root `atech-ble-ota-demos/`)

- [ ] **Step 1: Write `.dockerignore`** per Global Constraints (keep `builder/prompts/system.md`, keep tests so the `test` stage can run them).
- [ ] **Step 2: Write the Dockerfile** with stages `runtime` (default) and `test`:
  1. `FROM node:24-bookworm-slim`; apt `python3 python3-venv git ca-certificates`; `useradd -u 10001`; `mkdir -p /data/builds /app` chowned to atech.
  2. `ENV PLATFORMIO_CORE_DIR=/home/atech/.platformio PLATFORMIO_BIN=/home/atech/.platformio/penv/bin/pio PLATFORMIO_SETTING_ENABLE_TELEMETRY=false ATECH_BUILDS_DIR=/data/builds ATECH_PIO_JOBS=1 NODE_ENV=production`.
  3. As atech: venv at `$PLATFORMIO_CORE_DIR/penv`, `pip install platformio==6.2.0`.
  4. Copy only the two `platformio.ini` files; `pio pkg install -g -t platformio/tool-scons@~4.41101.0`; `pio pkg install -d <demo> -e base -e ai` for both; delete `.cache` contents but keep the empty `.cache` directory.
  5. Copy `builder/package*.json`; `npm ci --omit=dev`.
  6. Copy the rest; `node deploy/warm-cache.js --install-only` (populates `/data/builds/workspaces/*/.pio/libdeps/ai`).
  7. `EXPOSE 5173`, `HEALTHCHECK CMD node /app/deploy/healthcheck.js`, `ENTRYPOINT ["/app/deploy/entrypoint.sh"]`.
  8. `FROM runtime AS test`: `npm ci` with dev deps, `RUN npm test` and the per-demo node tests.
- [ ] **Step 3: Build locally: `docker build -f deploy/Dockerfile -t atech-builder:local .` ; expect success. `docker run --rm atech-builder:local pio --version` is not available (entrypoint), so check `docker run --rm --entrypoint pio atech-builder:local --version` prints `PlatformIO Core, version 6.2.0`.**

### Task 5: Compose file

**Files:**
- Create: `deploy/compose.yaml`

- [ ] **Step 1: Write compose.yaml** exactly as the Global Constraints list: service `builder`, `build: {context: .., dockerfile: deploy/Dockerfile}`, `image: atech-builder:local`, `container_name: atech-builder`, `env_file: [{path: ${ATECH_ENV_FILE:-/etc/atech/builder.env}, required: true}]`, `environment: {ATECH_BUILDER_HOST: 0.0.0.0, ATECH_BUILDER_PORT: "5173", ATECH_BUILDS_DIR: /data/builds}`, `ports: ["127.0.0.1:5173:5173"]`, volumes `builds:/data/builds`, `pio-cache:/home/atech/.platformio/.cache`, `demo1-pio:/app/demo1-custom-gatt/.pio`, `demo2-pio:/app/demo2-bleota-library/.pio`, limits and hardening, healthcheck (interval 30s, timeout 10s, start_period 90s, retries 3), logging json-file 10m x 3.
- [ ] **Step 2: `docker compose -f atech-ble-ota-demos/deploy/compose.yaml config` from the repo root with `ATECH_ENV_FILE` pointing at a temp file; expect resolved absolute context/Dockerfile paths and no warnings.**

### Task 6: Documentation

**Files:**
- Create: `deploy/README.md`, `deploy/builder.env.example`
- Modify: `AI_FIRMWARE_BUILDER.md` (Quick start gains a one-line pointer), `README.md` (same)

- [ ] **Step 1: Write `deploy/README.md`**: prerequisites (disk ≥ 15 GB free (image measured at 6.55 GB), Docker, env file), the env variable table, exact Droplet commands (`git pull`, compose up, logs, health, SSH tunnel `ssh -L 5173:127.0.0.1:5173`), warm-cache and base-build commands, update/rollback procedure, going public later (reverse proxy with TLS, Web Bluetooth needs HTTPS, dashboard key), limitations (Wi-Fi LAN OTA and mDNS cannot reach a home LAN from the cloud).
- [ ] **Step 2: `deploy/builder.env.example`** mirrors the variables the container honours.

### Task 7: Verification

- [ ] `cd builder && npm test` (backend, AI builder, jsdom dashboard tests).
- [ ] Demo 1/Demo 2 protocol tests: `node demo1-custom-gatt/web/protocol.test.js`, `node demo1-custom-gatt/web/dashboard.test.js`, `node demo2-bleota-library/firmware.test.js`, `node demo2-bleota-library/web/bleota-client.test.js`, `node demo2-bleota-library/web/dashboard.test.js`, `node shared/AtechCore/core.test.js`, `node shared/AtechWifiOta/portal.test.js`, `cd web-shared && node atech-identity.test.js && node atech-builder.test.js`.
- [ ] `node --test deploy/`.
- [ ] Native PlatformIO: `pio run -e base && pio run -e ai` in both demos.
- [ ] `docker build` (runtime and test targets), then `docker run --network none ... node deploy/warm-cache.js` proves both AI workspaces compile offline inside the image.
- [ ] Compose up locally with `ATECH_ENV_FILE=$PWD/atech-ble-ota-demos/builder/.env`; `docker compose ps` healthy; `/api/health` via 127.0.0.1:5173 with the key; `POST /api/builds` with the acceptance prompt; wait for `ready`; `GET /api/builds/:id/firmware.bin` returns an image whose size matches the job's `firmware.size`; `grep` the logs for `sk-ant-` finds nothing.
- [ ] Record what was and was not run on the Droplet (nothing was).
