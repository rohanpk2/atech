# AI Firmware Builder

Type what the board should do, click **Generate firmware**, review the generated C++, click **Deploy**, and the ESP32-S3 runs the new logic after a wireless update. Both demos share one backend, one builder card and one deployment panel. Deployment prefers **Wi-Fi** (the backend streams the image to the board over the LAN; see [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md)), falls back to the demo's **Bluetooth** protocol (Demo 1: Atech custom GATT, Demo 2: gb88 BLEOTA) and, last, to the board hotspot portal.

**Verification status (2026-10-27):** every firmware environment compiles, all automated tests pass, and the acceptance prompt was generated, compiled and validated end to end for both demos through the real backend. **No ESP32-S3 board was attached during this work, so nothing below has been flashed, deployed over BLE or Wi-Fi, rebooted, rolled back or put into safe mode on hardware.** See the table at the end.

## Quick start

```sh
cd ~/Projects/atech/atech-ble-ota-demos/builder
npm install
npm start
```

Then open **http://localhost:5173/demo1/** or **http://localhost:5173/demo2/** in desktop Chrome. If an older `python3 -m http.server 5173` from the previous README instructions is still running, stop it first; the backend warns when it detects one and you can also open `http://127.0.0.1:5173/`.

Model credentials, checked in this order:

1. `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the environment or in the git-ignored `builder/.env` file (copy `builder/.env.example`; loaded by `npm start`, shell values win and blank lines count as unset), or an `ant auth login` profile. Provider failures (invalid key, no credit, rate limit, outage, network) are reported on the job as plain-language errors; the key itself is never logged, stored or returned by the API. The backend then uses the official `@anthropic-ai/sdk` with `claude-opus-5-5`, adaptive thinking and structured output.
2. Otherwise the locally installed `claude` CLI and its existing login (`claude -p --json-schema`). This is what ran the first end-to-end tests on this machine. It costs normal usage on that account (about $0.10 to $0.20 per generation here).

`ATECH_LLM_PROVIDER=anthropic|claude-cli` forces one; `ATECH_LLM_MODEL` changes the model; `ATECH_MAX_REPAIRS` (default 3) bounds the repair loop; `ATECH_BUILDER_PORT`/`ATECH_BUILDER_HOST` or `--port`/`--host` change the listener. `--host 0.0.0.0` exposes the firmware download links to a phone on the same Wi-Fi for the Safari path; there is no Web Bluetooth on a non-localhost HTTP origin, so that only serves downloads.

Before the first wireless deploy a board needs the current base image once over USB: `pio run -e base -t upload` in the demo folder, or the browser installer at `/demo1/install.html` and `/demo2/install.html` (ESP Web Tools, Chrome/Edge desktop only).

## The flow

1. **Connect** (Chrome, Web Bluetooth). The dashboard reads the board's identity: device ID `ATECH-<12 hex MAC>`, six-character pairing code (also the suffix of the BLE name `Atech-Custom-OTA-<code>` / `Atech-Library-OTA-<code>` and of the Wi-Fi hotspot `Atech-OTA-D1-<code>` / `Atech-OTA-D2-<code>`), running build, app name and state. Connecting first binds the build to that board.
2. **Build firmware.** The backend sends the prompt plus the application API header to the model, runs the static policy on the returned file, compiles it with PlatformIO in an isolated workspace, feeds compiler errors or policy violations back for up to three repair rounds, then validates the image. Progress streams to the card (SSE with polling fallback).
3. **Review.** The dashboard shows the model's plain-language summary of what was built and the image size; the generated `user_app.cpp` itself stays in the job directory under `.ai-builds/jobs/<id>/` and is not displayed. A failed build lists its policy violations or compiler errors. Nothing has touched the board yet.
4. **Deploy.** Enabled when a build is ready. The deployment panel picks Wi-Fi when the selected board is paired and reachable, Bluetooth when Web Bluetooth has a connected board, otherwise it downloads the file for the hotspot portal; any available method can be forced. The build's demo must match the board's demo, the build must be unbound or bound to this board, and the image must fit the slot size the board reports.
5. **Verify.** Over Wi-Fi the backend, over Bluetooth the dashboard, waits for the reboot and checks: same device ID, the identity reports the expected build id, the app loop counter increases (the generated code is executing), an authenticated echo is answered, and only then sends **confirm**, which cancels the bootloader rollback. The panel shows the checks it passed and the transfer, reboot and verification times. A failed check leaves the image pending; a reset then boots the previous firmware. A failed Wi-Fi transfer is reported with the next available method offered; nothing switches transports by itself.

The acceptance prompt "Make the onboard LED blink three times quickly, pause for two seconds, and repeat." produced, on both demos, a file whose `appLoop()` runs a three-iteration loop of `led.set` / `delay(120..150)` / `led.off` followed by `delay(2000)`. No dashboard command was involved; the LED commands remain separate opcodes that the core executes.

## What generated code can do

Generated files include only `<AtechApp.h>` (plus standard headers) and define `void appSetup()` and `void appLoop()`. The app runs on its own FreeRTOS task on core 1, so blocking `delay()` is fine and never stalls BLE, OTA or the Wi-Fi portal.

| Available | Not available in this version |
| --- | --- |
| `led.set(r,g,b)`, `led.off()` on the onboard NeoPixel | Wi-Fi, Bluetooth, `Update`, `esp_ota_*`, partitions, NVS/`Preferences` |
| `pinMode`, `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite`, `ledcAttach`, `ledcWrite`, `attachInterrupt` on permitted pins | `Wire`/I2C, `SPI`, `Serial1`/`Serial2`, `tone()`, hardware timers, touch |
| `atech::log(fmt, ...)`, `Serial.print*`, `millis`, `micros`, `delay`, `random`, the standard library | Sleep modes, `ESP.restart`, FreeRTOS task creation, raw NeoPixel objects, inline assembly |

Permitted GPIO: 1, 2, 4 to 18, 21, 38 to 42, 47. Reserved: 0 (BOOT), 3, 19/20 (USB), 26 to 37 (flash and PSRAM), 43/44 (UART0), 45/46 (strapping), 48 (LED, facade only). The backend rejects literal reserved pins before compiling; the header routes every GPIO call through runtime guards that refuse reserved pins and log the refusal, so a computed pin cannot bypass the table either.

## Validation before "ready"

- Source policy: entry points present, no `setup`/`loop`, allowed includes only, forbidden API list, GPIO literals, no `#undef`/`#define` of the guarded names, size limit 64 KiB. Comments and string literals are ignored.
- Board configuration: the workspace is a copy of the demo's `platformio.ini` (board `esp32-s3-devkitc-1`, 16 MB, `qio_opi`) and its unchanged `partitions.csv`; the AI environment only adds `-DDEMO_VERSION=3 -DATECH_AI_BUILD=1`.
- Image: magic `0xE9`, chip id 9 (ESP32-S3), 16 MB flash header, application descriptor present, size at most 6 MiB minus a 64 KiB margin, and both markers found: the demo's Wi-Fi portal identity (`ATECH-OTA-APP-DEMO1`/`DEMO2`) and `ATECH-BUILD:<build id>`.
- Browser, again, before any byte is written: ESP32-S3 application header, demo match, device binding, slot size reported by the board.

## Identity service (both demos)

Service `a7ec0100-2e47-4dd2-82a4-9c2cf6eaa001`:

| Characteristic | UUID suffix | Use |
| --- | --- | --- |
| Identity (read) | `a7ec0101` | JSON: `id, suffix, demo, board, variant, core, fw, build, app, ver, slot, slotSize, pending, canRollback, safe, crashes, target, paired, appState, loops, up` |
| Control (write) | `a7ec0102` | `[opcode][8-byte nonce]`; `0x01` confirm, `0x02` rollback, `0x03` echo, `0x04` restart |
| Event (notify) | `a7ec0103` | `[opcode][status][nonce]`; status `0` ok, `1` unsupported, `2` refused |

Demo 1 keeps its original command service and opcodes `0x01` to `0x05` unchanged and adds `0x06 resume app`, which hands the LED back to the generated app after a dashboard LED command. LED mode `3` means "app controlled". Demo 2 keeps the gb88 protocol byte-for-byte; gb88's hosted page still works against the same firmware.

## Recovery

- **Rollback.** The core defers Arduino-ESP32's OTA confirmation (`verifyRollbackLater()` returns true). A freshly booted image stays `PENDING_VERIFY` until the dashboard sends **confirm** after its checks, or the core confirms automatically after 20 s of uptime once `appLoop()` has completed at least one pass. An app that panics in `appSetup()` reboots and the bootloader returns to the previous image; an app that hangs in `appSetup()` is never confirmed and rolls back on the next reset. **Roll back to previous firmware** in the card uses `Update.rollBack()` when the other slot holds a valid image.
- **Safe mode.** Three consecutive crash resets (panic, watchdog, brownout) boot with the app task disabled, the LED breathing red, and `safe:true` in the identity. BLE, both OTA transports and the portal keep running so a new build can be deployed; a power cycle or a successful deploy clears the counter.
- The app is suspended only while a transfer is actually writing flash (BLE START to FINISH, or while the Wi-Fi portal reports an upload), so a pending image can still prove itself while the portal stays up for verification.

## Safari, iPhone and the Wi-Fi path

Safari has no Web Bluetooth and no Web Serial. Wi-Fi deployment does not need either: the dashboard talks only to the builder backend (same origin), and the backend talks to the board. On an iPhone or iPad open the LAN link the backend prints when started with `--host 0.0.0.0` (it carries the dashboard key). If the board is not on Wi-Fi yet, the hotspot steps on the dashboard set it up; the manual file upload on the hotspot page remains available as the last resort, exactly as before.

## USB installer

`/demo1/install.html` and `/demo2/install.html` use ESP Web Tools 10 with the manifest at `/api/installer/<demo>/manifest.json` (bootloader at 0x0, partitions at 0x8000, boot_app0 at 0xE000, firmware at 0x10000, all from the demo's `base` build). The page shows whether the parts exist and can trigger `pio run -e base` through the backend. ESP Web Tools' own console lets you read the boot log, which prints the device ID, pairing code and Wi-Fi credentials.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | provider, model, PlatformIO version, LAN URLs |
| `GET /api/demos/:demo` | BLE/SSID prefixes, slot size, GPIO policy |
| `POST /api/builds` `{demo, prompt, deviceId?}` | start a job (202 with `id`, `buildId`, `appVersion`) |
| `GET /api/builds?demo=` | recent jobs |
| `GET /api/builds/:id` | job JSON (state, attempt, code, diagnostics, violations, firmware size/CRC32/SHA-256) |
| `GET /api/builds/:id/events` | SSE stream of job updates, ends with `event: done` |
| `GET /api/builds/:id/firmware.bin` | the validated image (only when `ready`) |
| `POST /api/builds/:id/deployed` | record a deployment result for the audit trail |
| `POST /api/builds/:id/deploy` `{deviceId}` | start a Wi-Fi deployment to a paired board (202 with `id`) |
| `GET /api/deployments`, `/:id`, `/:id/events`; `POST /:id/abort` | deployment state, SSE stream, abort |
| `GET /api/devices?refresh=1`; `POST /api/devices/discover`, `/pair`, `/:id/probe`, `/:id/control`; `DELETE /:id` | device registry (see WIFI_LAN_OTA.md) |
| `GET /api/installer/:demo/manifest.json`, `/parts/:name`, `/status`; `POST /api/installer/:demo/build` | ESP Web Tools |

Jobs persist under `.ai-builds/jobs/<id>/` (prompt, every attempt's `user_app.cpp` and `build.log`, `firmware.bin`, `meta.json`). Workspaces live in `.ai-builds/workspaces/demo<N>/`; the checked-in demo projects are never modified by a job. The backend has no authentication and binds to 127.0.0.1 by default.

## Layout

- `builder/`: Node backend (`server.js`, `lib/`, `prompts/system.md`, `test/`). `npm test` runs the unit, pipeline, HTTP and jsdom dashboard tests; `ATECH_REAL_BUILD=1 npm test` also compiles the stock app in a real workspace.
- `shared/AtechCore/`: the protected core (`AtechCore.h/.cpp`, `AtechAppApi.h`, `AtechApp.h`), used by both demos.
- `web-shared/`: `atech-identity.js`, `atech-builder.js`, `builder.css`, served at `/shared/`.
- `demo1-custom-gatt/src/app/`, `demo2-bleota-library/src/app/`: the stock `user_app.cpp` and `app_build.h` that the backend replaces inside the workspace.
- `demo2-bleota-library/web/`: the new Demo 2 dashboard and `bleota-client.js`, an independent client for the gb88 protocol written from its published specification.

## Physically verified

| Item | Status |
| --- | --- |
| `pio run` for base, updated and ai, both demos | Verified on this machine |
| Backend, browser-module and dashboard tests | Verified (`npm test`, the per-demo `node` tests) |
| Model generation, policy, compile, image validation for the acceptance prompt | Verified for Demo 1 (first attempt, 28 s) and Demo 2 (first attempt, 149 s including the workspace's first full compile) using the `claude` CLI provider |
| Wi-Fi deployment protocol, progress, interruption, replay and wrong-device handling | Verified against the simulated board (`builder/test/lan.test.js`) and in Chrome against the simulated board; **not on hardware** |
| USB install, BLE connect, identity read, BLE OTA (either protocol), Wi-Fi join, mDNS, LAN OTA, reboot, post-reboot verification, confirm, rollback, safe mode, Wi-Fi portal with an AI image, ESP Web Tools flash | **Not verified: no board was attached** |
| Dashboards in a real Chrome session | Not verified in Chrome; verified in jsdom and by route checks against the running backend |
