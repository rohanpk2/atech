# Atech ESP32-S3: Wi-Fi primary OTA, Bluetooth fallback, AI firmware builder

**Status (2026-10-28):** both demos now deploy **over the user's own Wi-Fi network by default**, with their original Bluetooth OTA protocols as the backup and the device-hosted hotspot portal as the last resort. The builder backend streams the validated image to the board over an HMAC-authenticated LAN service, which works from Safari and Chrome without Web Bluetooth. See [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md) for provisioning, deployment, security, browser compatibility, migration and the test record. The AI firmware builder is described in [AI_FIRMWARE_BUILDER.md](AI_FIRMWARE_BUILDER.md). **No BLE or Wi-Fi transfer has been verified on physical ESP32-S3 hardware in this environment.** Successful compilation, browser tests, backend tests against a simulated board and end-to-end generation are not hardware results; use [WIFI_OTA_TESTING.md](WIFI_OTA_TESTING.md) and [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md) section 10 for the hardware procedure.

## The intended experience

1. Power the ESP32-S3 from a wall charger or power bank.
2. Once: hold BOOT, join the board hotspot, open `http://192.168.4.1`, enter the OTA authorization code and join your 2.4 GHz home Wi-Fi.
3. Open the Atech dashboard in Safari or Chrome; **Find devices** shows the board; **Pair** it with the same code.
4. Type what the board should do, click **Generate firmware**, read the generated C++.
5. Click **Deploy**. Wi-Fi is used when the board is reachable; the panel shows percentage, KiB/s, time remaining, reboot and verification. Bluetooth and the hotspot remain selectable.

## AI firmware builder (both demos)

```sh
cd ~/Projects/atech/atech-ble-ota-demos/builder
npm install
npm start
```

Server deployment with Docker: [deploy/README.md](deploy/README.md).

Open **http://localhost:5173/demo1/** or **http://localhost:5173/demo2/** in desktop Chrome (stop any old `python3 -m http.server 5173` first; the backend now serves both dashboards). Connect the board, type for example "Make the onboard LED blink three times quickly, pause for two seconds, and repeat.", click **Build firmware**, read the generated `user_app.cpp`, then click **Deploy to device**. The dashboard verifies the device ID, the new build id, that the generated app loop is executing, and an echo before confirming the image; the board rolls back automatically if a generated app crashes before confirmation. Model access uses `ANTHROPIC_API_KEY` (or `ant auth login`) when present, otherwise the logged-in `claude` CLI.

The builder also adds to every image: a unique device ID and pairing code (`ATECH-<MAC>`, last six hex digits in the BLE name and Wi-Fi SSID), an identity GATT service, a sandboxed app task that the stock blue/green blink now runs on, guarded GPIO, rollback confirmation and a crash-counting safe mode. A one-time USB installer with ESP Web Tools lives at `/demo1/install.html` and `/demo2/install.html` (Chrome/Edge desktop).

**User experience:** use Bluetooth OTA from the existing Chrome interfaces when Web Bluetooth is available. As a fallback, hold the running board's **BOOT** button for about three seconds, join its WPA2 `Atech-OTA-D1-<suffix>` or `Atech-OTA-D2-<suffix>` hotspot, and upload the application `firmware.bin` from Safari or Chrome at **http://192.168.4.1/**. Both transports stream into the inactive OTA application partition, reboot, and retain both update methods.

## Shortlist (BLE binary transport, web-first)

| Rank | Transport/firmware approach | What it buys us | Cost / risk |
| --- | --- | --- | --- |
| 1 | **Atech-owned Web Bluetooth + custom GATT receiver + Arduino `Update`** | Smallest controllable end-to-end browser demo; own UX and protocol | We must engineer authentication, retries, resume, signing, observability |
| 2 | **Existing `gb88/BLEOTA` library + its browser app** | Ready-made sector protocol, CRC16, compression, optional signing, web uploader | AGPL-3.0 obligations; third-party dependency; need security and hardware verification |
| 3 | **Espressif ESP-IoT-Solution BLE OTA profile** | Vendor-supported protocol building blocks, 4KB sectors and CRC | ESP-IDF migration and browser protocol integration |
| 4 | **ESP-NimBLE custom GATT OTA** | Memory/stack efficiency and packet-window tuning | Like #1 but requires deeper Bluetooth implementation |
| 5 | **Delta OTA over BLE** | Send firmware differences for smaller transfer volumes | Strict source image matching, patch-generation complexity, recovery planning |

These are implementation families rather than five mutually exclusive radio technologies. They can eventually share a common Atech dashboard frontend.

## Folder guide

- `demo1-custom-gatt/`: **First demo.** Atech-owned HTML/JS dashboard + PlatformIO project + self-defined GATT protocol. It provides safe LED/status commands, matched ESP32 acknowledgments, random-nonce connection proofs, and a real OTA path. It rejects non-ESP32-S3/non-application images in the browser, validates CRC32 before activating the OTA slot, and uses a stop-and-wait ACK after every flash write. `src/app/user_app.cpp` holds the stock blink app the AI builder replaces.
- `demo2-bleota-library/`: **Second demo.** PlatformIO project pinned to the upstream `gb88/BLEOTA` v1.0.6 Git tag. Its new `web/` dashboard speaks the gb88 protocol from an independent client (`bleota-client.js`) and adds identity, verification and the AI builder; gb88's maintained page at https://gb88.github.io/BLEOTA/ still works against the same firmware. The protocol handles 4KB sectors, CRC16, retries, and optional signing (left disabled).
- `shared/AtechCore/`: the protected firmware core used by both demos: device ID and pairing code, identity GATT service, sandboxed app task, LED and GPIO guards, rollback confirmation and safe mode. Generated code only sees `AtechApp.h`.
- `shared/AtechWifiOta/`: shared SoftAP, authenticated local portal (now with the home Wi-Fi provisioning card), streaming IDF OTA writer, validation, timeout, and post-reboot verification support used by all firmware builds.
- `shared/AtechWifiLan/`: station-mode Wi-Fi, mDNS and the HMAC-authenticated LAN OTA service that the builder backend deploys through. See [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md).
- `builder/`: the Node backend of the AI firmware builder (model access, policy, isolated PlatformIO workspaces, image validation, job API, ESP Web Tools installer) that also serves both dashboards. `web-shared/` holds the builder card and identity protocol used by both.
- `AI_FIRMWARE_BUILDER.md`: how the builder works, what generated code may do, the identity and recovery protocol, and what has and has not been physically verified.
- `WIFI_LAN_OTA.md`: Wi-Fi provisioning, LAN deployment protocol and security review, Safari/Chrome compatibility, performance expectations, migration and the automated test record.
- `WIFI_OTA_TESTING.md`: exact USB, BLE, macOS/iPhone Safari, Chrome, interruption, rejection, and recovery procedures.

**One-time USB installation is required for each demo's baseline firmware.** Thereafter `base -> updated` can run over Bluetooth or Wi-Fi. To change between demos, USB-flash the other demo baseline.

## Hardware / setup

- ESP32-S3 N16R8 (16MB flash, 8MB OPI PSRAM) such as your board.
- Mac desktop Chrome for BLE; Safari or Chrome on macOS/iPhone for Wi-Fi. Close nRF Connect and other clients so they cannot hold a BLE connection when entering Wi-Fi mode.
- Cursor + PlatformIO installed and working (your earlier BLE blinky test confirms this).
- Board plugged into USB-C for baseline provisioning. For the strongest radio proof, unplug it from the Mac and power it with a wall adapter or power bank during OTA. USB is **only for baseline provisioning/recovery and credential capture**, not for the wireless update itself.
- Existing N16R8 GPIO48 onboard NeoPixel assumed. If the RGB LED is on GPIO38 instead, change `LED_PIN` in source.
- The checked-in DevKitC target uses GPIO0 for BOOT and GPIO48 for its RGB LED. A fresh three-second runtime BOOT hold enters/exits Wi-Fi OTA. A BOOT button already held during reset is deliberately ignored so the normal hold-BOOT/tap-RST ROM flashing sequence is unchanged. Set the Wi-Fi config's button pin to `-1` if the actual board does not expose a safe GPIO0 runtime button.

## Demo 1: fully controlled Atech web prototype

The new command/response characteristics are part of the baseline firmware. USB-flash `base` once even if an older Demo 1 build is already on the board.

### 1. Provision the board once over USB

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
pio run -e base -t upload
```

If upload mode is needed, hold **BOOT**, tap **RST**, release **BOOT**, then run the upload command again. Press **RST** once after upload if no advertisement appears. The base firmware reports `Atech demo1 / v1 / blue default` and slowly blinks blue.

An optional serial log can run in a separate terminal while the board remains connected to the Mac:

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
pio device monitor -b 115200
```

### 2. Build the wireless update and launch the dashboard

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
pio run -e updated
cd ../builder && npm install && npm start
```

Keep that terminal open, then open **http://localhost:5173/demo1/** in desktop Chrome (the builder backend serves the dashboard; a plain static server no longer works because the AI card needs `/api/*` and `/shared/*`). The update image is:

```text
~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt/.pio/build/updated/firmware.bin
```

`localhost` is a browser secure context; any remotely hosted dashboard must use HTTPS.
The dashboard now checks `navigator.bluetooth`: Bluetooth is preferred when available, while Safari and other unsupported browsers are directed to the separate device-hosted Wi-Fi portal. The dashboard never POSTs firmware from its HTTPS/localhost origin to the board's HTTP origin.

### 3. Prove two-way BLE communication

1. Unplug the board from the Mac and power it from a wall adapter or power bank.
2. Click **Connect device** and choose `Atech-Custom-OTA-<pairing code>`; the code is the last six hex digits of the device ID shown in the device card after connecting.
3. Click **Run BLE connection test**. A pass means the firmware echoed the dashboard's exact random 64-bit challenge; a completed browser write alone never passes the test.
4. Enter `blink green` and click **Send command**. Confirm both the physical LED change and the **ESP32 ACK** card with the matching request ID, firmware version, state, and latency.
5. Try `blink blue`, `stop blinking`, `get status`, `ping`, or `resume app` (hands the LED back to the running app). All other text is rejected in the browser, and firmware only accepts the six corresponding opcodes.

### 4. Perform and verify the real BLE OTA

1. In **Update over Bluetooth**, choose `.pio/build/updated/firmware.bin`.
2. Leave **120 bytes** selected initially and click **Deploy firmware**. If the first GATT payload is rejected, the client automatically retries with 20 bytes; 60 and 20 are also available manually.
3. Keep Chrome foregrounded. Watch percentage, acknowledged bytes, and measured speed. Each increment is based on an ESP32 flash acknowledgment.
4. After transfer, the ESP32 checks CRC32, selects the inactive OTA partition, and reboots. The dashboard attempts to reconnect to the already-authorized device for up to 30 seconds.
5. The dashboard marks the update **Verified** only after the same device reports a changed firmware string and answers a fresh random PING. The updated image reports `Atech demo1 / v2 / green default`.
6. Send `blink blue` or `get status` once more to prove the updated firmware still executes commands.

A disconnect or 30 seconds without OTA data aborts the partial write, leaving the prior firmware active and allowing a clean reconnect/retry. If automatic post-reboot verification times out, the UI shows **Needs verification**, not success; press **Connect device** to retry against the already-authorized board.

### Demo 1 command wire format

Command requests and responses are fixed at 20 bytes so they fit the minimum BLE ATT payload. Both contain protocol version, little-endian 32-bit request ID, opcode, an 8-byte nonce, and CRC16/CCITT. The response also includes execution status, LED state, firmware version, and the echoed nonce. The browser rejects a response with the wrong CRC, request ID, opcode, or nonce.

| Opcode | Command | Firmware action |
| --- | --- | --- |
| `0x01` | `ping` | Echo nonce and report live state |
| `0x02` | `blink blue` | Blink the onboard LED blue |
| `0x03` | `blink green` | Blink the onboard LED green |
| `0x04` | `stop blinking` | Turn the onboard LED off |
| `0x05` | `get status` | Report state without changing it |
| `0x06` | `resume app` | Return LED control to the running (generated or stock) app |

LED mode `3` in the acknowledgment means "app controlled". The shared identity service (`a7ec0100`) with its confirm/rollback/echo/restart control channel is documented in [AI_FIRMWARE_BUILDER.md](AI_FIRMWARE_BUILDER.md).

## Demo 2: existing BLE OTA implementation / browser

1. Open `demo2-bleota-library` in Cursor.
2. Run `pio run -e base -t upload` (BOOT/RST if required), then press RST if needed.
3. Run `pio run -e updated` to compile `.pio/build/updated/firmware.bin` (**do not USB-upload the updated version**).
4. Either open **http://localhost:5173/demo2/** (builder backend running) and use its manual firmware card or the AI builder, or on Mac Chrome visit https://gb88.github.io/BLEOTA/ , click Connect and choose `Atech-Library-OTA-<pairing code>`.
5. Select `.pio/build/updated/firmware.bin`, select **FLASH** / application firmware, start OTA.
6. Wait for completion and reboot. Reconnect: FW version should read `demo2-2.0.0`, LED should blink GREEN quickly. The Atech dashboard additionally verifies the device ID and build id through the identity service.

This browser uploader and library are by gb88 (not included or copied in this package). **AGPL-3.0**: assess redistribution/network-service implications with counsel before embedding in a proprietary Atech product. The gb88 protocol is unchanged. Its optional firmware signing remains disabled in this demo; the independent Wi-Fi fallback does not alter that BLE security choice.

## Wi-Fi OTA fallback (both demos)

The base and updated images both include the same local portal. Demo 1 advertises `Atech-OTA-D1-<six-hex-device-suffix>`; Demo 2 advertises `Atech-OTA-D2-<suffix>`. Credentials are random per-device values stored in NVS so they survive the OTA reboot. They are printed at 115200 baud at boot and whenever Wi-Fi OTA starts:

```text
Wi-Fi OTA credentials (record securely during provisioning):
  SSID: Atech-OTA-D1-123ABC
  WPA2 password: <device-specific random value>
  OTA authorization code: <different device-specific random value>
  Portal: http://192.168.4.1
```

Record these during USB provisioning or place them in the device's protected deployment record. The portal does not reveal either secret. To override them for a managed test fixture, add the following two lines under the common `build_flags` in that demo's `platformio.ini` (use different values per device, keep the simple quoted character set, and never commit real credentials):

```ini
  '-DATECH_WIFI_AP_PASSWORD="D1fixture-WPA2-ChangeMe"'
  '-DATECH_WIFI_OTA_TOKEN="D1fixture-Portal-Token-ChangeMe"'
```

The WPA2 value must contain 12–63 characters and the token at least 16. Remove the overrides to use the default NVS-persisted random values; erasing the demo's NVS namespace generates a new pair.

1. Build the correct `updated` environment and locate its `.pio/build/updated/firmware.bin`.
2. Make sure no BLE client is connected and no BLE OTA is running. While firmware is running, hold **BOOT** for about three seconds and release it without pressing RST. A connected/active BLE session makes the request fail closed; disconnect it and hold BOOT again.
3. Join the demo's WPA2 hotspot. On iPhone, choose to remain connected without internet.
4. In Safari or Chrome, type **http://192.168.4.1/** and enter the separate OTA authorization code.
5. Select only the application `firmware.bin` and click **Deploy Firmware**. Browser upload percentage is not success: wait for the separate device-side **flash verified** response.
6. The portal checks the declared size and CRC32 while streaming, rejects bootloader/partition/merged files, enforces ESP32-S3 + 16MB-board headers and the D1/D2 image identity, then calls `esp_ota_end()` for full ESP image integrity validation. It changes the boot partition only after validation succeeds.
7. After success the board reboots and restores the same hotspot once, allowing the page to report the running version and previous version. Exit from the portal, hold BOOT for three seconds, or leave it inactive for ten minutes to stop the AP and restore BLE advertising.

Only one updater can own flash. Wi-Fi mode cannot start while BLE is connected/running, BLE advertising is stopped for the AP session, concurrent HTTP updates are rejected, and aborted/incomplete HTTP bodies call `esp_ota_abort()` without selecting the inactive partition. Demo 1 also keeps its 30-second BLE transfer timeout; Demo 2 continues to use the upstream gb88 lifecycle.

For Safari on iPhone, AirDrop the compiled `firmware.bin` to the phone and choose **Save to Files before joining the no-internet ESP32 hotspot**. In the local portal's picker, choose Browse and select it from Files. See [WIFI_OTA_TESTING.md](WIFI_OTA_TESTING.md) for exact per-demo macOS/iPhone, Chrome BLE regression, interruption, invalid-image, and USB recovery steps.

The WPA2 credential and independent portal token provide two access checks, but this HTTP lab portal is not deployment-grade release authorization. A party with valid credentials can still submit any structurally valid image bearing the public demo marker. Production devices need provisioned/rotatable secrets, rate limiting, signed firmware enforced by Secure Boot, anti-rollback policy, protected signing keys, and an appropriate encrypted management channel.

## Offline verification

These checks do not replace a physical transfer, but they verify the toolchain, all four firmware variants, the shared portal compilation, the partition binary, and Demo 1's browser protocol:

```sh
cd demo1-custom-gatt
pio run -e base && pio run -e updated && pio run -e ai
node web/protocol.test.js
node web/dashboard.test.js
node ../shared/AtechWifiOta/portal.test.js
node ../shared/AtechCore/core.test.js

cd ../demo2-bleota-library
pio run -e base && pio run -e updated && pio run -e ai
node firmware.test.js
node web/bleota-client.test.js
node web/dashboard.test.js

cd ../web-shared && node atech-identity.test.js && node atech-builder.test.js
cd ../builder && npm test     # includes the LAN OTA, device registry, routes and jsdom deployment tests
```

To try the whole Wi-Fi flow without a board, start the backend with `ATECH_SIMULATED_DEVICE=all npm start`; two simulated boards (clearly labelled) register themselves and accept deployments with the real protocol. They prove nothing about ESP32 radio or flash speed.

The `ai` environment is the one the builder compiles inside its isolated workspace; it is never uploaded over USB.

The projects are pinned to PlatformIO Espressif32 8.0.0 / Arduino-ESP32 3.3.12. PlatformIO labels the underlying board definition as N8/no-PSRAM, but the project overrides select the N16R8 settings: `qio_opi`, `BOARD_HAS_PSRAM`, a 16MB flash header, and the custom 16MB partition table.

## Critical pitfalls

- Firmware updates require an **OTA partition table** with `ota_0`, `ota_1` and `otadata`. Both demos include the same custom 16MB `partitions.csv` with two 6MB application slots. `firmware.bin` is an **application image only**; do not transfer combined flash, bootloader, partitions, or arbitrary source-code files.
- Do not install an OTA app compiled with the wrong board/partition layout, flash size or PSRAM config.
- Flashing a different partition table over USB changes the existing layout; migrate carefully on boards carrying valuable persistent data.
- If the board isn't advertising after USB upload, press **RST**, exactly as with the prior blinking project.
- Chrome requires a user gesture to select Bluetooth devices and uses a secure origin (`https://` or `http://localhost`). Safari on iPhone does **not** support Web Bluetooth, but it can use the local SoftAP portal without Web Bluetooth.
- CRC32/CRC16 and the ESP image checksum detect corruption; they **do not establish who authorized the firmware**. The separate Wi-Fi token authenticates the portal request but is not a code signature. Add asymmetric signatures, signed manifests, anti-rollback and Secure Boot for real deployments. Test low-power interruptions and connection loss. Use flash encryption if the threat model requires it.
- Both demos are starter prototypes; not certified for safety-critical use or validated on your particular board.

## Evaluation plan (run on the same board; record each exact image size)

Perform five successful transfers per demo and transport, recording median transfer duration, throughput, reboot/verify time and success rate. Then run the adversarial BLE and Wi-Fi cases: disconnect mid-transfer, unplug mid-transfer, wrong-board/wrong-demo bin, incomplete image, corrupted payload, bad token, concurrent updater, range changes, timeout, and interrupted/retried upload.

Use [BENCHMARKING.md](BENCHMARKING.md) for the repeatable procedure and `benchmark-results.csv` for raw results. Re-provision or alternate known images so every timed run starts from a working OTA-capable firmware.

| Metric | Demo 1 (custom GATT) | Demo 2 (BLEOTA) | Acceptance target to set after first baseline |
| --- | --- | --- | --- |
| Setup / first-time flash | | | |
| Transfer time for recorded application bytes | | | |
| Verified bytes per second | | | |
| Update success (5 runs) | | | |
| Recovery after disconnect | | | |
| Recovery after power loss | | | |
| Firmware version after reboot | | | |
| Binary signature enforcement | Not in demo | Optional, off in demo | REQUIRED in production |
| Dashboard integration complexity | | | |
| Licensing / maintenance burden | Original Atech code | AGPL-3.0 | |

**Selection rule:** prefer the approach that reliably recovers from failed updates and can be secured, not necessarily the one with the fastest green LED change. For Atech, evolve Demo 1 into an Atech-owned, versioned sector/window protocol and keep its Web Bluetooth client inside the dashboard. Borrow the useful behavior demonstrated by Demo 2 (sector CRCs, bounded retries, larger write-without-response packets, and optional compression), but do not make the AGPL library or its externally hosted UI the product boundary unless that licensing/dependency choice is intentional. Espressif's vendor BLE OTA profile is the next baseline to test before finalizing the wire protocol.

## Reference implementations / API docs

- https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/ota.html
- https://docs.espressif.com/projects/esp-iot-solution/en/latest/bluetooth/ble_ota.html
- https://github.com/gb88/BLEOTA
- https://learn.sparkfun.com/tutorials/esp32-ota-updates-over-ble-from-a-react-web-application/all
- https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice
