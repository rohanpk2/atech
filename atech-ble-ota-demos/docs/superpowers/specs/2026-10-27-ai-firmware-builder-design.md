# AI Firmware Builder for the Atech BLE / Wi-Fi OTA demos

Date: 2026-10-27. Status: design approved by the requester's written brief (the brief is the
twelve numbered requirements plus the first end-to-end test); choices marked **(my call)** were
made by the builder and can be overridden.

## Intent

A user connects an ESP32-S3, types a natural-language prompt into the existing dashboard, builds,
reviews the generated C++ and deploys it wirelessly. The board then runs genuinely new
application logic while keeping every existing capability: BLE commands, custom-GATT OTA
(Demo 1), gb88 BLEOTA (Demo 2), the Wi-Fi SoftAP portal, device identification and recovery.

The first end-to-end test is the acceptance bar: "Make the onboard LED blink three times
quickly, pause for two seconds, and repeat." The LLM must write the pattern; the dashboard must
not map the prompt onto the five predefined LED commands.

## Goals

1. One-prompt firmware generation, compile, validate, review, deploy, verify, in the browser.
2. Generated code is sandboxed in a single file with a tiny, documented API; the Atech core
   (BLE, OTA, identity, recovery) is never regenerated.
3. Every build is validated against the board, partition table and GPIO policy before the
   browser is allowed to deploy it.
4. The two demos share one backend and one builder UI; only the OTA transport differs.
5. Nothing that works today stops working: the five Demo 1 commands, the connection test, the
   file-based OTA, the Wi-Fi portal, the base/updated builds, the existing JS tests.

## Non-goals

- Production security. Generated firmware is unsigned, the backend has no auth, and the Wi-Fi
  portal keeps its lab-grade token. The README already states this; the builder inherits it.
- Multi-user or remote hosting. The backend is a local developer tool on the Mac.
- Replacing gb88's browser app. Demo 2 gains its own dashboard that speaks the gb88 protocol,
  but gb88's page keeps working against the same firmware.

## Anti-goals (would make this a failure even if it "works")

- Satisfying the acceptance test by pattern-matching prompts to canned LED modes.
- A generated app that can brick the board: no rollback, no safe mode, OTA blocked by a busy
  loop.
- Claiming Safari/iPhone can pair or deploy automatically. It cannot; the UI must say so and
  hand the user a file plus the manual hotspot steps.
- Marking an update "Verified" from a browser-side event alone. Verification needs the board's
  own identity report after reboot.

## Constraints

- Hardware: ESP32-S3 DevKitC-1 N16R8, NeoPixel on GPIO48, BOOT on GPIO0, 16 MB flash,
  two 6 MiB OTA slots (`partitions.csv` is shared by both demos and must not change).
- Toolchain: PlatformIO 6.2.0, espressif32 8.0.0, Arduino-ESP32 3.3.12, NimBLE on the S3,
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=1` in the precompiled libs (so IDF rollback works),
  task watchdog checks only the CPU0 idle task.
- Browser: desktop Chrome for Web Bluetooth and Web Serial; Safari has neither.
- LLM access on this machine: no `ANTHROPIC_API_KEY`, no `ant` CLI, but the `claude` CLI
  (2.1.307) is logged in and `claude -p --json-schema` returns structured output.
- Existing tests: `protocol.test.js`, `dashboard.test.js`, `portal.test.js` must keep passing.
  Another session added `?v=N` cache-busters to Demo 1's `index.html`; keep them.

## Architecture

```
browser (Chrome)                     builder backend (Node, localhost:5173)        board
 dashboard ── POST /api/builds ───▶ generate (LLM) ─▶ policy check ─▶ compile  ─▶ validate image
     │  ◀── SSE job events ────────   (repair loop on compiler errors, max 3)
     │  GET firmware.bin
     ├── Demo 1: custom GATT OTA ───────────────────────────────────────────────▶ ota_x slot
     ├── Demo 2: gb88 BLEOTA sectors ───────────────────────────────────────────▶ ota_x slot
     └── reconnect ─▶ read identity ─▶ echo ─▶ confirm boot (cancel rollback) ◀── reboot
```

### Firmware: `shared/AtechCore` (new PlatformIO library, both demos)

Responsibilities, all in the protected core and never regenerated:

- **Device identity.** `ATECH-<12 hex MAC bytes>` from `esp_efuse_mac_get_default`, plus a
  6-hex pairing suffix from the last three MAC bytes. The existing SSID suffix used the first
  three bytes, which are Espressif's OUI and not unique per board; the core fixes the suffix
  derivation and both the BLE name and the Wi-Fi SSID use it (`Atech-Custom-OTA-1A2B3C`,
  `Atech-OTA-D1-1A2B3C`). Existing `namePrefix` filters still match. **(my call)**
- **Identity GATT service** `a7ec0100-…` with three characteristics, identical in both demos:
  - `a7ec0101` read: JSON `{id, suffix, demo, board, variant, core, fw, build, app, ver, slot,
    slotSize, pending, canRollback, safe, crashes, target, paired, appState, loops, up}`.
  - `a7ec0102` write: `[opcode][nonce x8]`; opcodes `0x01 CONFIRM` (cancel rollback),
    `0x02 ROLLBACK` (boot the other slot if it holds a valid image, then restart),
    `0x03 ECHO`, `0x04 RESTART`.
  - `a7ec0103` notify: `[opcode][status][nonce x8]`.
  Demo 1 keeps its existing service and all five opcodes untouched and adds one opcode,
  `0x06 resume app`, which hands the LED back to the generated app.
- **App task.** The generated app runs as its own FreeRTOS task on core 1 (8 KB stack,
  priority 1): `appSetup()` once, then `appLoop()` repeatedly with a one-tick yield. Blocking
  `delay()` inside the app is therefore allowed and never stalls BLE, OTA or commands. The
  core suspends the task while a transfer is actually streaming into flash (BLE START until
  FINISH/abort; Wi-Fi while the portal reports an upload) and resumes it on abort. It does
  not suspend for the whole Wi-Fi portal session, so a freshly booted image can still prove
  itself while the portal is up for verification. **(my call, after review)**
- **LED facade.** `atech::led.set(r,g,b)` / `off()` through one mutex-guarded NeoPixel. Demo 1
  LED modes become `0 off, 1 blink blue, 2 blink green, 3 app`; default is `app`. The stock
  blue/green blink moves into the default `user_app.cpp` so `base`/`updated` images behave
  exactly as before and report the same firmware strings.
- **GPIO policy.** `AtechApp.h` (the only header a generated file includes) routes `pinMode`,
  `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite`, `ledcAttach`, `ledcWrite`,
  `attachInterrupt` through guarded wrappers that refuse reserved pins at runtime and log the
  refusal. Allowed: 1, 2, 4–18, 21, 38–42, 47. Reserved: 0 (BOOT), 3, 19/20 (USB), 26–37
  (flash/PSRAM), 43/44 (UART0), 45/46 (strapping), 48 (LED, facade only).
- **Rollback.** The core defines `verifyRollbackLater()` returning true, so a freshly booted
  OTA image stays `PENDING_VERIFY` until the core confirms it: immediately on a dashboard
  `CONFIRM`, or automatically after 20 s of uptime **and** at least one completed `appLoop()`
  pass (BLE up, not in safe mode). An app that hangs in `appSetup()` never gets confirmed and
  the next reset rolls back. **(my call, after review)** A generated app that panics before that point reboots into the previous image via
  the bootloader. `ROLLBACK` uses `Update.canRollBack()/rollBack()` and is offered in the UI
  when the identity reports `canRollback`.
- **Safe mode.** A crash counter in RTC no-init memory increments on panic/WDT/brownout resets
  and clears after 60 s of uptime or a clean reset. Three consecutive crashes boot with the
  app task disabled, the LED pulsing red and `safe:true` in the identity; BLE, OTA and the
  portal keep running so a new build can be deployed. A power cycle gives the app another
  chance.
- **Build metadata.** `src/app/app_build.h` (shipped with stock values, overwritten per job)
  defines `ATECH_BUILD_ID`, `ATECH_APP_NAME`, `ATECH_APP_VERSION`, `ATECH_TARGET_DEVICE_ID`.
  The core embeds the marker `ATECH-BUILD:<id>` so the backend can prove a `firmware.bin`
  belongs to its job, and reports `paired:false` when a build targeted another device ID.
  Demo 1's info string stays `Atech demo1 / v<N> / <app name>` so the existing regex and
  version-byte comparison keep working; `N` is 1 and 2 for the stock images and a
  backend-assigned counter from 3 upward for AI builds.

### Generated-app contract (`AtechApp.h`)

The generated file must define `void appSetup()` and `void appLoop()`, must not define
`setup`/`loop`, must not include anything but `<AtechApp.h>` and standard headers, and must
not touch Wi-Fi, BLE, `Update`, `esp_ota_*`, partitions, NVS/`Preferences`, sleep modes,
`ESP.restart`, raw NeoPixel objects, FreeRTOS task creation, or inline asm. The backend's
static policy enforces this list on the source; the header's wrappers enforce GPIO at runtime.

What the app may use in this version **(my call, after review)**: `atech::led`, the eight
guarded GPIO calls, `atech::log` and `Serial.print*` for output, timing (`millis`, `micros`,
`delay`, `delayMicroseconds`), `random`, and the C/C++ standard library. Not in this version:
`Wire`, `SPI`, `Serial1`/`Serial2`/`HardwareSerial` (they bind pins without going through
`pinMode`), `tone`, hardware timers and interrupts other than the guarded `attachInterrupt`.
Prompts that need a bus fail policy with a clear message instead of burning repair rounds.

### Backend: `builder/` (Node 25, `node:http`, no framework)

- `server.js` serves `/demo1/`, `/demo2/` (the two dashboards), `/shared/` (shared browser
  modules) and `/api/*`. Binds 127.0.0.1:5173 by default; `--host 0.0.0.0` exposes it on the
  LAN for the iPhone download path.
- Job pipeline: `queued → generating → compiling → repairing(n) → validating → ready | failed`.
  Jobs persist under `.ai-builds/jobs/<id>/` (prompt, each attempt's source and build log,
  `firmware.bin`, `meta.json`). `GET /api/builds/:id/events` streams progress as SSE.
- LLM providers, selected automatically: `anthropic` (official `@anthropic-ai/sdk`,
  `claude-opus-5-5`, adaptive thinking, structured output via `messages.parse` with a Zod
  schema `{name, summary, code}`, server-side refusal fallbacks `"default"`) when an API key
  or `ant` profile resolves; otherwise `claude-cli` (`claude -p --json-schema`, same schema,
  CLAUDECODE env stripped so it works from inside a Claude Code session). `ATECH_LLM_PROVIDER`
  forces one. **(my call)**
- Repair loop: compiler errors (file:line:col: error) and policy violations are fed back with
  the previous source; the model returns the full corrected file. `ATECH_MAX_REPAIRS`
  defaults to 3.
- Isolated workspace: `.ai-builds/workspaces/demo<N>/` is a persistent copy of the demo's
  `platformio.ini` (rewritten with absolute `lib_extra_dirs`, an `[env:ai]` and a shared
  `build_cache_dir`), `partitions.csv` and `src/`. Each job re-syncs the core sources, writes
  `src/app/user_app.cpp` and `src/app/app_build.h`, and runs `pio run -e ai`. All PlatformIO
  invocations go through one queue. The checked-in demo projects are never modified by a job.
- Validation before `ready`: source policy; board config (board id, 16 MB flash, `qio_opi`,
  partition table hash equals the demo's); image header (magic `0xE9`, chip id 9, 16 MB flash
  nibble, app-descriptor magic); size ≤ slot size minus a 64 KB margin; identity marker
  (`ATECH-OTA-APP-DEMO<N>`) and `ATECH-BUILD:<id>` present in the binary.
- Installer: `GET /api/installer/<demo>/manifest.json` plus the four parts (bootloader @0x0,
  partitions @0x8000, boot_app0 @0xE000, firmware @0x10000) from the demo's `base` build,
  built on demand through the same queue.

### Browser

- `web-shared/atech-identity.js`: identity JSON parsing and control packet build/parse.
- `web-shared/atech-builder.js`: the builder card. It is given a transport object by each
  dashboard (`isConnected`, `identity`, `deploy(bytes, meta)`, `control(opcode)`) and owns
  prompt entry, job polling, code review, the explicit **Deploy** step, post-reboot
  verification and the confirm/rollback buttons. It refuses to deploy when the job's demo or
  bound device ID does not match the connected board, or the image exceeds `slotSize`.
- Demo 1 `app.js`: existing flow refactored so `deploy()` takes bytes instead of a file input
  (the file picker keeps working through the same path), identity read on connect, verification
  extended to check device ID, build ID, increasing `loops`, and an echo; `resume app` added
  to the command list; `fetch` stays out of `app.js` (the existing test forbids it there).
- Demo 2 `web/`: new dashboard with the same look, `bleota-client.js` implementing the gb88
  protocol from its published spec (20-byte commands, 4 KB sectors, CRC-16/CCITT, sector ACKs,
  rewind on index error, three retries on CRC error), with-response writes so long writes work
  regardless of negotiated MTU, payload size selector like Demo 1. **(my call)**
- Safari / no Web Bluetooth: builder still builds; the result card offers **Download
  firmware.bin** and the existing Wi-Fi steps, worded to say pairing and upload are manual.
- `install.html` per demo: ESP Web Tools button (Chrome/Edge desktop only), one-time USB
  baseline install, with its serial console for capturing the printed Wi-Fi credentials.

## Verification and what "done" means

- `pio run` succeeds for `base`, `updated` and `ai` in both demos.
- `npm test` in `builder/` passes (policy, image parser, workspace prep, job state machine with
  fake provider/compiler, server API, installer manifest) and the browser module tests pass
  (identity, bleota client vectors, dashboard structure for both demos, existing three tests).
- A real run of the acceptance prompt through the backend produces a validated `firmware.bin`
  whose `user_app.cpp` was written by the model.
- Hardware steps (BLE/Wi-Fi transfer, reboot, identity verification, rollback, safe mode) are
  documented as **not physically verified** unless a board is attached during the session.

## Left to the builder

Exact UI copy and layout within the existing stylesheet; prompt wording; log formats; the
precise SSE event schema; test file layout.

## Appendix: the requester's brief (acceptance bar)

Goal: a user connects an ESP32-S3, enters a natural-language prompt, clicks Build & Deploy,
and the board runs newly generated C++ code wirelessly. Keep the UX extremely simple: no manual
PlatformIO commands, firmware downloads or file selection for the normal Chrome flow.

1. Add a unique device ID and simple board pairing/identification.
2. Add a prompt input to the existing dashboard.
3. Use an LLM API through a backend to generate real C++ firmware from the user's instructions.
4. Compile the generated firmware with PlatformIO in an isolated build workspace. Capture
   compiler errors and optionally repair failed builds automatically.
5. Preserve the existing BLE, Wi-Fi OTA, device identification and recovery functionality in
   every generated image. Keep generated application logic separate from the protected core.
6. Validate the firmware against the board configuration, flash partition limits and
   permitted GPIO usage before deployment.
7. Show generated code for review and require an explicit Deploy action.
8. Deploy the resulting `firmware.bin` with Demo 1's custom BLE OTA protocol or Demo 2's
   gb88 BLEOTA protocol respectively.
9. Support the existing Wi-Fi OTA fallback. Handle Safari/iPhone limitations honestly: no
   claims of automatic pairing or one-click hotspot deployment.
10. After reboot, verify the device ID, new firmware version and a successful response.
    Provide rollback/recovery when supported.
11. Add a one-time browser-based USB installer using ESP Web Tools for compatible desktop
    browsers.
12. Preserve all existing LED, BLE, OTA and dashboard functionality.

First end-to-end test: "Make the onboard LED blink three times quickly, pause for two
seconds, and repeat." The LLM must generate genuinely new application logic, PlatformIO must
compile it, and the board must perform the pattern after wireless deployment; the prompt must
not be mapped onto predefined LED commands. Smallest working version in Demo 1 first, then
Demo 2. Report what has and has not been physically verified.

Reviewer clarifications: "review" means read-only inspection of the generated code before
the explicit Deploy (edit the prompt and rebuild to change it); there is no second mandatory
prompt and no latency budget; Demo 2's new dashboard also keeps a manual file-deploy path as
an advanced option, and gb88's hosted page keeps working against the same firmware.
