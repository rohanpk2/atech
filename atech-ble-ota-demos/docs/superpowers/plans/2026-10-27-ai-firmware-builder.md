# AI Firmware Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user type a prompt in the Demo 1 or Demo 2 dashboard, have an LLM write a sandboxed C++ app, compile and validate it with PlatformIO, review it, deploy it over the demo's existing BLE OTA protocol, and verify the board after reboot.

**Architecture:** A shared firmware core (`shared/AtechCore`) adds device identity, an identity GATT service, an app task that runs generated code, LED/GPIO facades, rollback confirmation and safe mode to both demos. A dependency-light Node backend (`builder/`) generates code with Claude, compiles it in an isolated PlatformIO workspace, validates the image, and serves both dashboards. A shared browser module (`web-shared/`) owns the builder UI and talks to each dashboard through a small transport object.

**Tech Stack:** Arduino-ESP32 3.3.12 / PlatformIO espressif32 8.0.0 (NimBLE), Node 25 with `node:http` and `node:test`, `@anthropic-ai/sdk` 1.3 + `zod`, vanilla browser JS, ESP Web Tools 10.

**Spec:** `docs/superpowers/specs/2026-10-27-ai-firmware-builder-design.md`

## Global Constraints

- Board: `esp32-s3-devkitc-1`, `board_upload.flash_size = 16MB`, `memory_type = qio_opi`, `partitions.csv` unchanged (OTA slots 0x600000 bytes each).
- Generated code lives only in `src/app/user_app.cpp`; it defines `void appSetup()` and `void appLoop()` and includes only `<AtechApp.h>` and standard headers.
- Allowed GPIO for generated code: 1, 2, 4–18, 21, 38–42, 47. Reserved: 0, 3, 19, 20, 26–37, 43–46, 48.
- Identity service UUIDs: `a7ec0100-2e47-4dd2-82a4-9c2cf6eaa001` (service), `a7ec0101` identity read, `a7ec0102` control write, `a7ec0103` event notify. Control opcodes: `0x01 CONFIRM`, `0x02 ROLLBACK`, `0x03 ECHO`, `0x04 RESTART`.
- Demo 1 LED modes: `0 off, 1 blink blue, 2 blink green, 3 app`; new command opcode `0x06 resume app`. Opcodes 0x01–0x05 unchanged.
- Demo 1 info string format stays `Atech demo1 / v<N> / <app name>`; stock images must still report `Atech demo1 / v1 / blue default` and `Atech demo1 / v2 / green default`. Demo 2 stock version strings stay `demo2-1.0.0` / `demo2-2.0.0`.
- LLM: `claude-opus-5-5` through `@anthropic-ai/sdk` when credentials resolve; `claude -p --json-schema` otherwise. Output schema `{name, summary, code}`.
- Backend listens on `127.0.0.1:5173` by default; LAN exposure only with `--host 0.0.0.0`.
- Copy must not contain em dashes (existing test). Keep the `?v=N` cache-busters another session added to Demo 1's `index.html`.
- Do not commit; the user commits themselves (harness rule).

## Review Focus

- A generated `appLoop()` that never returns (tight `while(true)` without `delay`): BLE commands, OTA and the Wi-Fi portal must keep working. Pinned by Task 2's design (task on core 1 with the Arduino loop) and the manual hardware step in Task 16.
- A generated app that panics in `appSetup()` right after an OTA: the board must come back on the previous firmware, not boot-loop. Pinned by the rollback-pending logic in Task 2 and the policy test in Task 6 that forbids `ESP.restart`; hardware check listed in Task 16.
- A `firmware.bin` from Demo 2 deployed to a Demo 1 board (or vice versa): refused in the browser before any byte is written. Test added in Task 12 (`refuses deploy when identity.demo differs`).
- Build bigger than the 6 MiB slot or missing the identity marker: must fail validation, never reach `ready`. Tests in Task 7 (`image.test.js`).
- The browser loses the SSE stream mid-build: the UI must recover by polling `GET /api/builds/:id`. Test in Task 12 (`builder polls when events close`).

---

### Task 1: Device identity and the generated-app contract header

**Files:**
- Create: `shared/AtechCore/library.json`
- Create: `shared/AtechCore/src/AtechApp.h`
- Create: `shared/AtechCore/src/AtechCore.h`
- Create: `shared/AtechCore/src/AtechCore.cpp`
- Modify: `shared/AtechWifiOta/src/AtechWifiOta.cpp:893-897` (suffix derivation)
- Test: `shared/AtechCore/core.test.js` (structure test, like `portal.test.js`)

**Interfaces:**
- Produces (C++): `namespace atech { const char *deviceId(); const char *pairingSuffix(); String bleName(const char *prefix); }` where `deviceId()` is `"ATECH-"` + 12 uppercase hex from `esp_efuse_mac_get_default` in byte order and `pairingSuffix()` is bytes 3..5 (`"%02X%02X%02X"`).
- Produces (C++, `AtechApp.h`): `class atech::Led { void set(uint8_t r, uint8_t g, uint8_t b); void off(); }`, `extern atech::Led atech::led;`, `void atech::log(const char *fmt, ...)`, `bool atech::isPinAllowed(int pin)`, guarded wrappers `guardedPinMode(int, uint8_t) -> bool`, `guardedDigitalWrite(int, uint8_t) -> bool`, `guardedDigitalRead(int) -> int`, `guardedAnalogRead(int) -> int`, `guardedAnalogWrite(int, int) -> bool`, `guardedLedcAttach(int, uint32_t, uint8_t) -> bool`, `guardedLedcWrite(int, uint32_t) -> bool`, `guardedAttachInterrupt(int, void (*)(), int) -> bool`; macros `pinMode`, `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite`, `ledcAttach`, `ledcWrite`, `attachInterrupt` mapped onto them; declarations `void appSetup(); void appLoop();`.
- Produces (C++, `AtechCore.h`): `struct AtechCoreConfig { uint8_t demo; const char *board; const char *variant; const char *firmwareInfo; const char *buildId; const char *appName; uint16_t appVersion; const char *targetDeviceId; int ledPin; uint32_t autoConfirmMs; bool (*otaBusy)(); }` and `namespace atech { bool coreBegin(const AtechCoreConfig &); void coreAttachBle(BLEServer *); void coreLoop(); void coreSuspendApp(); void coreResumeApp(); bool coreAppRunning(); enum class LedOwner : uint8_t { Off = 0, BlinkBlue = 1, BlinkGreen = 2, App = 3 }; void setLedOwner(LedOwner); LedOwner ledOwner(); String identityJson(); bool confirmBoot(); bool rollbackToPrevious(); bool rollbackPending(); bool canRollback(); bool safeMode(); uint32_t crashCount(); uint32_t appLoops(); }`.

- [ ] **Step 1: Write the structure test** `shared/AtechCore/core.test.js` asserting: `AtechApp.h` defines macros for all eight guarded calls; `AtechCore.cpp` contains `esp_efuse_mac_get_default`, `verifyRollbackLater`, `esp_ota_mark_app_valid_cancel_rollback`, `RTC_NOINIT_ATTR`, `xTaskCreatePinnedToCore`, `vTaskSuspend`, `a7ec0101-`, `a7ec0102-`, `a7ec0103-`; the allowed-pin table in `AtechCore.cpp` lists exactly `1,2,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,21,38,39,40,41,42,47`; `AtechWifiOta.cpp` no longer contains `mac & 0xFFFFFFULL`.
- [ ] **Step 2: Run it** with `node shared/AtechCore/core.test.js`; expected FAIL (files missing).
- [ ] **Step 3: Create `library.json`** (name `AtechCore`, frameworks arduino, platforms espressif32, `build.includeDir` `src`).
- [ ] **Step 4: Write `AtechApp.h` and `AtechCore.h`** with the signatures above. `AtechApp.h` must declare the wrappers before defining the macros and must not be included by `AtechCore.cpp`.
- [ ] **Step 5: Implement identity in `AtechCore.cpp`**: `deviceId()`/`pairingSuffix()` cached in static buffers; `bleName()` returns `String(prefix) + "-" + pairingSuffix()`. Implement the GPIO guard table, `isPinAllowed`, the guarded wrappers (refuse + `log` on reserved pins), `atech::log` (Serial, prefixed `[app]`), and the `Led` class over one `Adafruit_NeoPixel` protected by a FreeRTOS mutex; `Led::set` is a no-op when `ledOwner() != LedOwner::App`.
- [ ] **Step 6: Fix the Wi-Fi suffix** in `AtechWifiOta.cpp`: read six bytes with `esp_efuse_mac_get_default(mac)` and format `mac[3], mac[4], mac[5]`.
- [ ] **Step 7: Run the structure test**; expected PASS (the remaining `AtechCore.cpp` symbols are added in Task 2, so the test for them may still fail; that is expected until Task 2 completes).

### Task 2: Core lifecycle: app task, safe mode, rollback, identity service

**Files:**
- Modify: `shared/AtechCore/src/AtechCore.cpp`
- Test: `shared/AtechCore/core.test.js` (from Task 1), plus `pio run` in Task 4

**Interfaces:**
- Consumes: Task 1 signatures.
- Produces: identity JSON with keys `id, suffix, demo, board, variant, core, fw, build, app, ver, slot, slotSize, pending, canRollback, safe, crashes, target, paired, appState, loops, up`; `appState` is one of `"disabled" | "setup" | "running" | "suspended"`; `core` is `"1.0.0"`; `build` is the `buildId` string; `slot` is the running partition label; `slotSize` its size in bytes; `up` uptime in ms. Control response `[opcode][status][nonce x8]` with status `0 ok, 1 unsupported, 2 refused`.

- [ ] **Step 1: Implement crash counting and safe mode**: `RTC_NOINIT_ATTR uint32_t crashCounter`; in `coreBegin`, read `esp_reset_reason()`; `ESP_RST_PANIC`, `ESP_RST_TASK_WDT`, `ESP_RST_INT_WDT`, `ESP_RST_WDT`, `ESP_RST_BROWNOUT` increment, anything else resets to 0; `safeMode()` is `crashCounter >= 3`; `coreLoop` clears the counter once `millis() >= 60000`.
- [ ] **Step 2: Implement the app task**: `xTaskCreatePinnedToCore(appTaskMain, "atech_app", 8192, nullptr, 1, &appTask, 1)` unless safe mode; `appTaskMain` sets `appState` to `setup`, calls `appSetup()`, sets `running`, then loops `appLoop(); loops++; vTaskDelay(1)`. `coreSuspendApp` = `vTaskSuspend` + `appState = suspended` + LED off; `coreResumeApp` = `vTaskResume` + `running`.
- [ ] **Step 3: Implement rollback**: define `extern "C" bool verifyRollbackLater() { return true; }`; in `coreBegin`, `rollbackPending()` is true when `esp_ota_get_state_partition(running)` returns `ESP_OTA_IMG_PENDING_VERIFY`; `confirmBoot()` calls `esp_ota_mark_app_valid_cancel_rollback()` and clears pending; `coreLoop` auto-confirms when pending, `millis() >= autoConfirmMs`, not safe mode and `appState != setup` hung check is skipped (setup may legitimately take long). `canRollback()` returns `Update.canRollBack()`; `rollbackToPrevious()` calls `Update.rollBack()` and schedules `ESP.restart()` 500 ms later from `coreLoop`.
- [ ] **Step 4: Implement the identity service** in `coreAttachBle`: create service `a7ec0100-…`, identity characteristic (READ) whose value is refreshed from `identityJson()` on every read via a `BLECharacteristicCallbacks::onRead`, control (WRITE) that enqueues `[opcode][nonce x8]` to a FreeRTOS queue drained in `coreLoop`, event (NOTIFY | READ) with `BLE2902` under `CONFIG_BLUEDROID_ENABLED`. Handle opcodes: CONFIRM → `confirmBoot()`; ROLLBACK → `rollbackToPrevious()` (status 2 if `!canRollback()`); ECHO → status 0; RESTART → schedule restart; unknown → status 1.
- [ ] **Step 5: Implement `renderCoreLed()`** inside `coreLoop`: owner `BlinkBlue` 1200 ms period blue 40, `BlinkGreen` 350 ms green 40, `Off` cleared, safe mode overrides with red breathing (period 2000 ms, max 40) when owner is `App`; when owner is `App` and not safe mode the core does not touch the LED.
- [ ] **Step 6: Run the structure test**; expected PASS.

### Task 3: Demo 1 firmware integration

**Files:**
- Create: `demo1-custom-gatt/src/app/user_app.cpp` (stock blink: blue 1200 ms when `DEMO_VERSION == 1`, green 350 ms otherwise, via `led.set`/`delay`)
- Create: `demo1-custom-gatt/src/app/app_build.h` (stock: `#ifndef`-guarded `ATECH_BUILD_ID "stock"`, `ATECH_APP_NAME` `"blue default"`/`"green default"` by `DEMO_VERSION`, `ATECH_APP_VERSION DEMO_VERSION`, `ATECH_TARGET_DEVICE_ID ""`)
- Modify: `demo1-custom-gatt/src/main.cpp`
- Modify: `demo1-custom-gatt/platformio.ini` (add `[env:ai]` with `-DDEMO_VERSION=3 -DATECH_AI_BUILD=1`)
- Test: `demo1-custom-gatt/web/protocol.test.js` (firmware-source assertions)

**Interfaces:**
- Consumes: Task 1 and 2.
- Produces: `FIRMWARE_INFO` = `"Atech demo1 / v" ATECH_STR(ATECH_APP_VERSION) " / " ATECH_APP_NAME`; response byte 16 = `ATECH_APP_VERSION & 0xFF`; byte 7 = `static_cast<uint8_t>(atech::ledOwner())`; `CommandOpcode::ResumeApp = 0x06`; BLE name `atech::bleName("Atech-Custom-OTA")`; `AtechCoreConfig` filled with `demo 1`, identity `ATECH-OTA-APP-DEMO1`, `buildId` pointing at a `constexpr char BUILD_MARKER[] = "ATECH-BUILD:" ATECH_BUILD_ID` so the marker is embedded.

- [ ] **Step 1: Extend `protocol.test.js`** firmware-source assertions: `ResumeApp = 0x06`, `atech::coreBegin`, `atech::coreAttachBle`, `atech::coreSuspendApp`, `"ATECH-BUILD:" ATECH_BUILD_ID`, `#include "app/app_build.h"`; and `LED_MODES` in `protocol.js` has key `3`.
- [ ] **Step 2: Run** `node web/protocol.test.js`; expected FAIL.
- [ ] **Step 3: Write `user_app.cpp` and `app_build.h`** as specified.
- [ ] **Step 4: Modify `main.cpp`**: include `AtechCore.h` and `app/app_build.h`; replace `ledMode`/`renderLed` with `atech::LedOwner`; add `ResumeApp`; suspend the app at OTA START and on `handleWifiOtaModeChanged(true)`, resume on abort and on mode end; call `atech::coreBegin(config)` before `BLEDevice::init`, `atech::coreAttachBle(bleServer)` after the main service is created, `atech::coreLoop()` from `loop()`; `otaBusy` = `otaTransportBusy`.
- [ ] **Step 5: Add `LED_MODES[3] = 'app controlled'` and `'resume app': 0x06`** to `protocol.js` `COMMANDS`; add the `<option>` and a chip in `index.html`; `README` command table row.
- [ ] **Step 6: Run** `node web/protocol.test.js && node web/dashboard.test.js`; expected PASS.
- [ ] **Step 7: Build** `cd demo1-custom-gatt && pio run -e base && pio run -e updated && pio run -e ai`; expected three `SUCCESS` lines and `firmware.bin` under each `.pio/build/<env>/`.

### Task 4: Demo 2 firmware integration

**Files:**
- Create: `demo2-bleota-library/src/app/user_app.cpp`, `demo2-bleota-library/src/app/app_build.h` (same shape as Task 3; app names `"blue default"`/`"green default"`)
- Modify: `demo2-bleota-library/src/main.cpp`
- Modify: `demo2-bleota-library/platformio.ini` (add `[env:ai]`)
- Test: `demo2-bleota-library/firmware.test.js` (structure test)

**Interfaces:**
- Produces: `FIRMWARE_VERSION` = `"demo2-" ATECH_STR(ATECH_APP_VERSION) ".0.0"`; BLE name `atech::bleName("Atech-Library-OTA")`; `BLEOTA.setSerialNumber(atech::deviceId())`; a `BLEOTACallbacks` subclass whose `beforeStartOTA` calls `atech::coreSuspendApp()` and `afterAbort` calls `atech::coreResumeApp()`; identity service attached to the same `BLEServer`.

- [ ] **Step 1: Write `firmware.test.js`** asserting `main.cpp` contains `atech::coreAttachBle(server)`, `BLEOTA.setCallbacks`, `atech::coreSuspendApp`, `"ATECH-BUILD:" ATECH_BUILD_ID`, and no longer contains `led.setPixelColor` (LED moved to the app/core); `platformio.ini` has `[env:ai]`.
- [ ] **Step 2: Run** `node demo2-bleota-library/firmware.test.js`; expected FAIL.
- [ ] **Step 3: Check whether `BLEOTACallbacks` virtuals have definitions** (`grep -n "BLEOTACallbacks::" .pio/libdeps/base/BLEOTA/src/*.cpp`); if none, override all four in the subclass.
- [ ] **Step 4: Modify `main.cpp`** per the interface; keep gb88 protocol calls untouched.
- [ ] **Step 5: Run the structure test**; expected PASS. **Build** `pio run -e base && pio run -e updated && pio run -e ai`; expected SUCCESS x3.

### Task 5: Backend skeleton: config, GPIO policy, PlatformIO runner

**Files:**
- Create: `builder/lib/config.js`, `builder/lib/gpio-policy.js`, `builder/lib/pio.js`
- Test: `builder/test/gpio-policy.test.js`, `builder/test/pio.test.js`

**Interfaces:**
- Produces: `config = { rootDir, buildsDir, demos: {1: {key:'demo1', dir, name:'Demo 1 custom GATT', imageIdentity:'ATECH-OTA-APP-DEMO1', blePrefix:'Atech-Custom-OTA', ssidPrefix:'Atech-OTA-D1', webDir}, 2: {...DEMO2}}, slotSize: 6291456, sizeMargin: 65536, pio: <abs path>, model: 'claude-opus-5-5', maxRepairs: 3, providerOverride, port: 5173, host: '127.0.0.1' }` read from env `ATECH_LLM_MODEL`, `ATECH_MAX_REPAIRS`, `ATECH_LLM_PROVIDER`, `ATECH_BUILDER_PORT`, `ATECH_BUILDER_HOST`, `PLATFORMIO_BIN`.
- `gpio-policy.js`: `ALLOWED_PINS: number[]`, `RESERVED: {pin: reason}`, `isPinAllowed(pin) -> boolean`, `describe() -> string` (for the prompt).
- `pio.js`: `runPio(args: string[], {cwd, env?, timeoutMs = 600000, onLine?}) -> Promise<{code, log}>` serialised through one queue; `parseDiagnostics(log) -> [{file, line, col, severity: 'error'|'warning', message}]` (regex `^(.+?):(\d+):(\d+): (error|warning|fatal error): (.*)$`) plus linker errors (`undefined reference to`, `multiple definition of`) as `{severity:'error', message}`.

- [ ] **Step 1: Tests** `gpio-policy.test.js`: `isPinAllowed(48) === false`, `isPinAllowed(4) === true`, `ALLOWED_PINS` deep-equals the Global Constraints list. `pio.test.js`: `parseDiagnostics` on a sample log with two errors, one warning, one `undefined reference` returns 4 entries with correct fields; `runPio(['--version'])` resolves `code 0` and log containing `PlatformIO`.
- [ ] **Step 2: Run** `cd builder && npm test`; expected FAIL.
- [ ] **Step 3: Implement** the three modules. `runPio` spawns `config.pio` with `stdio: pipe`, `PLATFORMIO_DISABLE_PROGRESSBAR=true`, `PLATFORMIO_NO_ANSI=true`, strips ANSI, enforces the timeout with `kill('SIGKILL')`.
- [ ] **Step 4: Run tests**; expected PASS.

### Task 6: Source policy

**Files:**
- Create: `builder/lib/source-policy.js`
- Test: `builder/test/source-policy.test.js`

**Interfaces:**
- Produces: `checkSource(code: string) -> {ok: boolean, violations: [{rule, message, line}]}` with rules: `size` (> 64 KiB), `entry-points` (missing `appSetup`/`appLoop`), `reserved-entry` (defines `setup(`/`loop(`), `include` (any `#include` other than `<AtechApp.h>` and the C/C++ standard set `<Arduino.h> <stdint.h> <string.h> <math.h> <stdio.h> <stdlib.h> <cstdint> <cstring> <cmath> <cstdio> <cstdlib> <algorithm> <array> <vector> <string> <functional>`), `forbidden-api` (regex list: `WiFi`, `BLEDevice`, `BLEServer`, `NimBLE`, `Update\.`, `esp_ota_`, `esp_partition`, `spi_flash`, `nvs_`, `Preferences`, `esp_restart`, `ESP\.restart`, `esp_deep_sleep`, `esp_light_sleep`, `Adafruit_NeoPixel`, `xTaskCreate`, `vTaskDelete`, `__asm`, `system\(`), `gpio` (literal first argument of `pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcAttach|ledcWrite|attachInterrupt|tone|noTone|touchRead` not in `ALLOWED_PINS`), `app-macro-bypass` (`#undef pinMode` etc.).

- [ ] **Step 1: Tests**: valid blink program passes; each rule above has one failing fixture; `gpio` violation reports `line`; a comment containing `WiFi` does not trigger (strip `//` and `/* */` comments before scanning).
- [ ] **Step 2: Run**; expected FAIL. **Step 3: Implement.** **Step 4: Run**; expected PASS.

### Task 7: ESP image parser and validator

**Files:**
- Create: `builder/lib/image.js`
- Test: `builder/test/image.test.js`

**Interfaces:**
- Produces: `parseImage(buf: Buffer) -> {magic, segmentCount, chipId, flashSizeCode, appDescMagic}`; `validateImage(buf, {slotSize, sizeMargin, markers: string[]}) -> {ok, errors: string[], size, chipId}` checking magic `0xE9`, `chipId === 9`, `(buf[3] >> 4) === 4` (16 MB), app-desc magic `0xABCD5432` at offset 32, `size <= slotSize - sizeMargin`, each marker present (`buf.indexOf(marker)`).

- [ ] **Step 1: Tests** with synthetic buffers: good image passes; wrong chip id → error mentions `chip`; flash nibble 2 → error mentions `16MB`; missing marker → error names the marker; size `slotSize - 1000` → error mentions `slot`. If `demo1-custom-gatt/.pio/build/base/firmware.bin` exists, it passes with markers `['ATECH-OTA-APP-DEMO1']`; `bootloader.bin` fails.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run**; PASS.

### Task 8: Isolated workspace and compile

**Files:**
- Create: `builder/lib/workspace.js`
- Test: `builder/test/workspace.test.js`

**Interfaces:**
- Consumes: `runPio`, `parseDiagnostics`, `config`.
- Produces: `rewritePlatformioIni(ini: string, {sharedDir, cacheDir}) -> string` (replace `lib_extra_dirs = ../shared` with the absolute path, add `build_cache_dir = <cacheDir>` under `[env]`, add `[env:ai]` if absent); `renderAppBuildHeader({buildId, appName, appVersion, targetDeviceId}) -> string` (four `#define`s, strings C-escaped); `prepareWorkspace(demo, {code, meta}) -> Promise<{dir}>` (copies `platformio.ini` rewritten, `partitions.csv`, `src/**` except `src/app/user_app.cpp`, writes the generated file and header); `compileWorkspace(demo, dir, {onLine}) -> Promise<{ok, log, diagnostics, firmwarePath}>` running `pio run -e ai`.

- [ ] **Step 1: Tests**: `rewritePlatformioIni` output contains the absolute shared dir, `build_cache_dir`, and keeps `[env:base]`; `renderAppBuildHeader` escapes a quote in the app name; `prepareWorkspace(1, …)` under a temp `buildsDir` produces `src/main.cpp`, `src/app/user_app.cpp` equal to the given code, `src/app/app_build.h`; a real compile test (`ATECH_REAL_BUILD=1 npm test`) compiles the stock Demo 1 app in the workspace and returns `ok: true` with an existing `firmwarePath` (skipped otherwise).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and `ATECH_REAL_BUILD=1 node --test test/workspace.test.js`; PASS.

### Task 9: LLM providers and prompt assembly

**Files:**
- Create: `builder/prompts/system.md`, `builder/lib/generate.js`, `builder/lib/providers/anthropic.js`, `builder/lib/providers/claude-cli.js`
- Test: `builder/test/generate.test.js`, `builder/test/providers.test.js`

**Interfaces:**
- Produces: `GENERATION_SCHEMA` (zod: `name` 1–40 chars, `summary` ≤ 300 chars, `code` string) and `GENERATION_JSON_SCHEMA`; `buildSystemPrompt({demo, apiHeader}) -> string` (reads `prompts/system.md`, inserts `AtechApp.h` verbatim, the GPIO description, demo-specific notes); `buildMessages({prompt, demo, deviceId, attempts: [{code, diagnostics, violations, logTail}]}) -> Message[]` where every repair round appends the previous `code` as an assistant turn and the errors as a user turn asking for the full corrected file; `selectProvider(config) -> Promise<Provider>` preferring `anthropic` when `new Anthropic()` can resolve a key (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) or `~/.config/anthropic` exists, else `claude-cli` when `claude` is on PATH, else throws.
- Provider shape: `{name, model, generate({system, messages}) -> Promise<{name, summary, code, usage?}>}`.
- `anthropic.js`: `client.messages.parse({model, max_tokens: 16000, system, messages, output_config: {format: zodOutputFormat(GENERATION_SCHEMA)}, thinking: {type: 'adaptive'}, output_config.effort 'high'})` on `client.beta.messages` with `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'` if the beta surface supports parse; otherwise use `messages.parse` without fallbacks and note it. Check `stop_reason === 'refusal'` and throw a `GenerationRefused` error.
- `claude-cli.js`: spawn `claude -p <user text> --output-format json --json-schema <schema> --model <model> --no-session-persistence --system-prompt <system>` with `CLAUDECODE` and `CLAUDE_CODE_*` removed from env; read `structured_output`; multi-turn repair rounds are flattened into one user text (previous code + errors) because `-p` is single-turn.

- [ ] **Step 1: Tests** `generate.test.js`: system prompt contains the header text `appSetup`, the allowed-pin list and `ATECH-OTA-APP` nowhere (no secrets); messages for a repair round include `error:` lines and the prior code; schema rejects `{name:'', code:'x'}`. `providers.test.js`: `claude-cli` builds the expected argv (inject a fake spawn) and parses `structured_output`; `selectProvider` picks `claude-cli` when `ATECH_LLM_PROVIDER=claude-cli`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Write `system.md`** covering: role, the contract (define `appSetup`/`appLoop`; the app runs on its own task so `delay()` is fine; keep each `appLoop` pass under about 3 s; use `led.set/off`; only allowed pins; no networking/OTA/restart/sleep; no globals named `setup`/`loop`; return only the JSON fields). **Step 4: Implement modules.** **Step 5: Run**; PASS.

### Task 10: Job pipeline

**Files:**
- Create: `builder/lib/jobs.js`
- Test: `builder/test/jobs.test.js`

**Interfaces:**
- Consumes: `checkSource`, `validateImage`, `prepareWorkspace`, `compileWorkspace`, `buildMessages`, provider.
- Produces: `class JobStore { constructor({config, provider, deps}); create({demo, prompt, deviceId}) -> job; get(id); list(demo) -> job[]; subscribe(id, fn) -> unsubscribe; run(id) -> Promise<job> }`. Job JSON: `{id, demo, prompt, deviceId, state, stage, attempt, maxRepairs, buildId, appName, appVersion, summary, code, diagnostics, violations, logTail, firmware: {size, crc32, path} | null, error, createdAt, updatedAt, provider, model}`. States: `queued, generating, compiling, repairing, validating, ready, failed`. `buildId` = 8 hex from `crypto.randomBytes`; `appVersion` from `.ai-builds/state.json` counter starting at 3. Persist `meta.json`, `attempt-N/user_app.cpp`, `attempt-N/build.log`, `firmware.bin` under `.ai-builds/jobs/<id>/`. Every state change calls subscribers with the job JSON.

- [ ] **Step 1: Tests** with a fake provider (scripted responses) and fake `compileWorkspace`/`prepareWorkspace`: success on first attempt → `ready`, `firmware.size` set, `appVersion` 3 then 4 on a second job; compile error then success → `attempt 2`, `ready`, the second provider call's messages include the diagnostics; policy violation → provider asked to repair with the violation message, no compile attempted for that round; three failed repairs → `failed` with `error` naming the last diagnostic; image validation failure (marker missing) → `failed`; subscribers receive at least `generating, compiling, validating, ready`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run**; PASS.

### Task 11: HTTP server, SSE, firmware download, installer manifest

**Files:**
- Create: `builder/server.js`, `builder/lib/installer.js`, `builder/lib/http-util.js`
- Test: `builder/test/server.test.js`, `builder/test/installer.test.js`

**Interfaces:**
- `installer.js`: `manifest(demo) -> object` (`{name, version, new_install_prompt_erase: true, new_install_improv_wait_time: 0, builds: [{chipFamily: 'ESP32-S3', parts: [{path: '/api/installer/<demo>/parts/bootloader.bin', offset: 0}, {partitions.bin, 32768}, {boot_app0.bin, 57344}, {firmware.bin, 65536}]}]}`), `ensureBaseBuild(demo) -> Promise<{dir}>` (runs `pio run -e base` in the demo dir only if `firmware.bin` is missing or older than any `src/**` file), `partFile(demo, name) -> path` (`boot_app0.bin` from `~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin`).
- `server.js`: `createServer({config, jobs, installer}) -> http.Server`; routes: `GET /` → redirect `/demo1/`; `GET /demo1/*`, `GET /demo2/*` static from each `web/`; `GET /shared/*` from `web-shared/`; `GET /api/health` → `{ok, provider, model, pio, demos, lanUrls}`; `GET /api/demos/:demo` → `{demo, blePrefix, ssidPrefix, slotSize, allowedPins, reservedPins}`; `POST /api/builds` (JSON) → `202 {id}`; `GET /api/builds?demo=` → list (newest first, 20); `GET /api/builds/:id`; `GET /api/builds/:id/events` → SSE `event: job` with the JSON each update, `event: done` at terminal; `GET /api/builds/:id/firmware.bin` → `application/octet-stream` with `Content-Disposition: attachment; filename="atech-demo<N>-<buildId>.bin"` only when `ready`, else 409; `POST /api/builds/:id/deployed` records `{deviceId, result, at}` into meta; `GET /api/installer/:demo/manifest.json`; `GET /api/installer/:demo/parts/:name`; `POST /api/installer/:demo/build`. JSON errors `{error}`; bodies capped at 64 KiB; no CORS needed (same origin).
- `npm start` prints the local and LAN URLs.

- [ ] **Step 1: Tests** `installer.test.js`: manifest offsets exactly `0, 32768, 57344, 65536` and `chipFamily` `ESP32-S3`. `server.test.js`: boot on port 0 with a `JobStore` using fakes; `GET /api/health` 200; `POST /api/builds` 202 then `GET /api/builds/:id` reaches `ready`; `GET …/firmware.bin` returns the bytes and attachment header; SSE endpoint yields a `done` event; `GET /demo1/` serves `index.html`; path traversal `GET /demo1/../../package.json` → 404.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run**; PASS. **Step 5: Start** `npm start` once and `curl -s localhost:5173/api/health`; expected `"ok":true`.

### Task 12: Shared browser modules: identity protocol and builder UI

**Files:**
- Create: `web-shared/atech-identity.js`, `web-shared/atech-builder.js`, `web-shared/builder.css`
- Test: `web-shared/atech-identity.test.js`, `web-shared/atech-builder.test.js`

**Interfaces:**
- `atech-identity.js` (UMD like `protocol.js`): `IDENTITY_SERVICE`, `IDENTITY_CHAR`, `CONTROL_CHAR`, `EVENT_CHAR`, `CONTROL = {confirm: 1, rollback: 2, echo: 3, restart: 4}`, `parseIdentity(bytes|string) -> object` (throws unless `id` matches `/^ATECH-[0-9A-F]{12}$/` and `demo`, `build`, `slotSize` present), `buildControlPacket(opcode, nonce: Uint8Array(8)) -> Uint8Array(9)`, `parseControlEvent(bytes) -> {opcode, status, nonce}`, `CONTROL_STATUS = {0:'ok',1:'unsupported',2:'refused'}`.
- `atech-builder.js`: `AtechBuilder.mount({demo, transport, log, root = document})` reading DOM ids `aiPrompt, aiBuild, aiStatus, aiBadge, aiSummary, aiCode, aiCodeMeta, aiDeploy, aiDownload, aiTarget, aiConfirm, aiRollback, aiAttempts, aiLog`. `transport = {bluetoothAvailable: boolean, isConnected(): boolean, identity(): object|null, readIdentity(): Promise<object>, deploy(bytes, meta): Promise<{identity}>, control(opcode): Promise<{status}>}`. Behaviour: Build posts `{demo, prompt, deviceId: identity?.id}` then follows SSE, falling back to 2 s polling if the stream errors; shows `summary` and `code` with attempt count; **Deploy** enabled only when `ready && isConnected() && job.demo === identity.demo && (!job.deviceId || job.deviceId === identity.id) && firmware.size <= identity.slotSize`; after `deploy` resolves, verifies `identity.build === job.buildId`, `identity.id`, waits until a second `readIdentity()` shows `loops` increased (up to 10 s), sends `echo`, then `confirm`, and renders "Verified"; **Download** link to `/api/builds/:id/firmware.bin` shown always when ready (primary when no Bluetooth); **Rollback** visible when `identity.canRollback`.
- Copy for Safari: "This browser has no Web Bluetooth. Download the firmware, then follow the Wi-Fi steps; pairing and upload are manual."

- [ ] **Step 1: Tests** `atech-identity.test.js`: round-trip control packet; `parseIdentity` accepts a sample and rejects a bad id. `atech-builder.test.js` (source structure, no DOM): every `$('…')` id used by the module is in the id list above; the deploy guard expression contains `job.demo === identity.demo`, `firmware.size <= identity.slotSize`; polling fallback present (`setInterval` or `poll`); copy contains "pairing and upload are manual"; no em dashes.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** modules and `builder.css` (card layout reusing `.card`, `.btn`, `.badge`, `.state` classes; `<pre>` for code with max-height 360 px and scroll). **Step 4: Run**; PASS.

### Task 13: Demo 1 dashboard integration

**Files:**
- Modify: `demo1-custom-gatt/web/index.html`, `demo1-custom-gatt/web/app.js`, `demo1-custom-gatt/web/styles.css`
- Modify: `demo1-custom-gatt/web/dashboard.test.js`
- Create: `demo1-custom-gatt/web/install.html`

**Interfaces:**
- `app.js` exposes `window.AtechDemo1Transport` implementing the transport object; `deploy(bytes, meta)` is the existing OTA flow refactored from `deploy()` (file picker calls `deployBytes(bytes, {fileName})`); `connectGatt` also reads `a7ec0101` into `currentIdentity` and renders `deviceId`, pairing suffix and `build` in the device card; `finishOtaVerification` additionally checks `meta.buildId` when given; `control(opcode)` writes `a7ec0102` and awaits a matching nonce on `a7ec0103`.
- `index.html` adds the builder card (ids from Task 12) between the device card and the grid, a link to `install.html`, `<script src="/shared/atech-identity.js">` and `/shared/atech-builder.js` after `app.js`, `<link href="/shared/builder.css">`.
- `install.html`: ESP Web Tools button with `manifest="/api/installer/1/manifest.json"`, Chrome/Edge-desktop note, credential-capture note.

- [ ] **Step 1: Extend `dashboard.test.js`**: builder ids present and unique; scripts order `protocol.js`, `app.js`, then `/shared/atech-identity.js`, `/shared/atech-builder.js`; `app.js` still has no `fetch(`; `app.js` contains `a7ec0101-`; `install.html` contains `esp-web-install-button` and `manifest="/api/installer/1/manifest.json"`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run** `node web/protocol.test.js && node web/dashboard.test.js`; PASS. **Step 5: Smoke** in Chrome via `npm start`: page loads without console errors (no board needed).

### Task 14: Demo 2 dashboard with gb88 BLEOTA client

**Files:**
- Create: `demo2-bleota-library/web/index.html`, `app.js`, `bleota-client.js`, `styles.css` (copy of Demo 1's), `install.html`
- Test: `demo2-bleota-library/web/bleota-client.test.js`, `demo2-bleota-library/web/dashboard.test.js`

**Interfaces:**
- `bleota-client.js` (UMD): `BLEOTA_SERVICE = '00008018-0000-1000-8000-00805f9b34fb'`, `RECV_FW_CHAR = '00008020-…'`, `COMMAND_CHAR = '00008022-…'`, `COMMANDS = {startFlash: 0x0001, stop: 0x0002, ack: 0x0003, startSpiffs: 0x0004}`, `crc16(bytes, init = 0)`, `buildCommandFrame(commandId, payload = Uint8Array(0)) -> Uint8Array(20)`, `parseCommandAck(bytes) -> {commandId, status}` (throws on CRC/length), `parseSectorAck(bytes) -> {sectorIndex, status, expectedIndex}`, `splitSectors(bytes, sectorSize = 4096) -> Uint8Array[]`, `buildSectorPackets(sector, sectorIndex, payloadSize) -> Uint8Array[]` (last packet seq `0xFF` + CRC16 LE over the whole sector), `STATUS = {0:'ok',1:'crc or nack',2:'index',3:'signature',5:'start error'}`.
- `app.js`: connect with `filters: [{namePrefix: 'Atech-Library-OTA'}], optionalServices: [BLEOTA_SERVICE, IDENTITY_SERVICE]`; `deployBytes(bytes, meta)` = START → sectors with `writeValueWithResponse` and payload size from a `<select>` (509/241/117/17) with automatic fallback on the first packet like Demo 1 → STOP → wait disconnect → reconnect loop 30 s → identity check; exposes `window.AtechDemo2Transport`; Wi-Fi panel with `Atech-OTA-D2-<suffix>` copy; optional manual file picker.
- Verify against the README spec vectors: START frame for size `0x12345678` is `01 00 78 56 34 12 00…00 crc`.

- [ ] **Step 1: Tests** `bleota-client.test.js`: `crc16('123456789') === 0x31C3`; START frame bytes; `parseCommandAck` on a frame built by `buildCommandFrame(0x0003, [01 00 00 00])`; `splitSectors` of 4097 bytes → two sectors (4096, 1); `buildSectorPackets` of a 4096-byte sector with payload 241 → 17 packets, first header `[idx,0,0]`, last header seq `0xFF` and trailing CRC equal to `crc16(sector)`. `dashboard.test.js`: ids used by `app.js` and builder exist; script order `bleota-client.js`, `app.js`, shared modules; Wi-Fi copy mentions `Atech-OTA-D2-&lt;suffix&gt;` and `http://192.168.4.1`; `app.js` has no `fetch(`; no em dashes; `install.html` manifest path `/api/installer/2/manifest.json`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement.** **Step 4: Run**; PASS.

### Task 15: Documentation

**Files:**
- Create: `AI_FIRMWARE_BUILDER.md`
- Modify: `README.md` (folder guide, run instructions, Demo 2 dashboard, command table, verification status)

- [ ] **Step 1: Write `AI_FIRMWARE_BUILDER.md`**: quick start (`cd builder && npm install && npm start`), credentials (`ANTHROPIC_API_KEY` or `ant auth login`, else the `claude` CLI login), the generated-app contract, the pipeline and validation list, the identity service, rollback/safe-mode behaviour, Safari/iPhone limits, ESP Web Tools installer, API table, and a "Physically verified" table filled honestly.
- [ ] **Step 2: Update `README.md`** accordingly; keep existing sections.
- [ ] **Step 3: Run** all JS tests and both demos' three `pio run` envs one final time.

### Task 16: End-to-end run of the acceptance prompt and hardware checklist

- [ ] **Step 1:** `npm start`, then `curl -X POST localhost:5173/api/builds -d '{"demo":1,"prompt":"Make the onboard LED blink three times quickly, pause for two seconds, and repeat."}'`; poll until `ready`; record attempts, provider, and the generated `user_app.cpp`; run `validateImage` on the produced bin (the pipeline already did; confirm `size` and markers in the job JSON).
- [ ] **Step 2:** Repeat for `demo 2`.
- [ ] **Step 3:** If a board is attached (`ls /dev/cu.usb*`), flash `base` over USB, open `/demo1/`, run the prompt, deploy, and record: identity before/after, build id match, `loops` increasing, echo, confirm; then `rollback`. Otherwise record these as not physically verified in `AI_FIRMWARE_BUILDER.md`.
