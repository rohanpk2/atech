# Atech ESP32-S3: browser-to-board BLE OTA evaluation

**Status:** Demo 1's command dashboard and both firmware variants build and pass their offline protocol checks; Demo 2 remains available for comparison. **Neither end-to-end BLE path has been verified on a physical ESP32-S3 in this environment.** Transfer reliability must be measured on the real board.

**User experience:** Operator opens a **web dashboard on Mac Chrome**, connects directly to the nearby ESP32-S3 over Bluetooth LE, chooses a *compiled* `firmware.bin`, clicks deploy, sees progress, watches the board reboot, and verifies a different LED behavior/version. **The firmware bytes themselves travel over BLE.** There is no requirement for the board to have Wi-Fi.

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

- `demo1-custom-gatt/`: **First demo.** Atech-owned HTML/JS dashboard + PlatformIO project + self-defined GATT protocol. It provides safe LED/status commands, matched ESP32 acknowledgments, random-nonce connection proofs, and a real OTA path. It rejects non-ESP32-S3/non-application images in the browser, validates CRC32 before activating the OTA slot, and uses a stop-and-wait ACK after every flash write.
- `demo2-bleota-library/`: **Second demo.** PlatformIO project pinned to the upstream `gb88/BLEOTA` v1.0.6 Git tag; use its maintained Web Bluetooth dashboard at https://gb88.github.io/BLEOTA/ . It handles 4KB sectors, CRC16, retries, and optional signing (the example leaves signing disabled).

**One-time USB installation is required for each demo's baseline firmware.** Thereafter `base -> updated` runs over Bluetooth. To change between demos, USB-flash the other demo baseline.

## Hardware / setup

- ESP32-S3 N16R8 (16MB flash, 8MB OPI PSRAM) such as your board.
- Mac desktop Chrome, Bluetooth enabled; close nRF Connect on the phone so it cannot hold the board connection.
- Cursor + PlatformIO installed and working (your earlier BLE blinky test confirms this).
- Board plugged into USB-C for baseline provisioning. For the strongest radio proof, unplug it from the Mac and power it with a wall adapter or power bank during BLE commands and OTA. USB is **only for baseline provisioning or recovery**, not for the BLE update.
- Existing N16R8 GPIO48 onboard NeoPixel assumed. If the RGB LED is on GPIO38 instead, change `LED_PIN` in source.

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
python3 -m http.server 5173 --directory web
```

Keep that terminal open, then open **http://localhost:5173** in desktop Chrome. The update image is:

```text
~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt/.pio/build/updated/firmware.bin
```

`localhost` is a browser secure context; any remotely hosted dashboard must use HTTPS.

### 3. Prove two-way BLE communication

1. Unplug the board from the Mac and power it from a wall adapter or power bank.
2. Click **Connect device** and choose `Atech-Custom-OTA`.
3. Click **Run BLE connection test**. A pass means the firmware echoed the dashboard's exact random 64-bit challenge; a completed browser write alone never passes the test.
4. Enter `blink green` and click **Send command**. Confirm both the physical LED change and the **ESP32 ACK** card with the matching request ID, firmware version, state, and latency.
5. Try `blink blue`, `stop blinking`, `get status`, or `ping`. All other text is rejected in the browser, and firmware only accepts the five corresponding opcodes.

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

## Demo 2: existing BLE OTA implementation / browser

1. Open `demo2-bleota-library` in Cursor.
2. Run `pio run -e base -t upload` (BOOT/RST if required), then press RST if needed.
3. Run `pio run -e updated` to compile `.pio/build/updated/firmware.bin` (**do not USB-upload the updated version**).
4. On Mac Chrome visit https://gb88.github.io/BLEOTA/ , click Connect and choose `Atech-Library-OTA`.
5. Select `.pio/build/updated/firmware.bin`, select **FLASH** / application firmware, start OTA.
6. Wait for completion and reboot. Reconnect: FW version should read `demo2-2.0.0`, LED should blink GREEN quickly.

This browser uploader and library are by gb88 (not included or copied in this package). **AGPL-3.0**: assess redistribution/network-service implications with counsel before embedding in a proprietary Atech product. For production, enable the upstream project's signed-image verification; this unsecure demo does not.

## Offline verification

These checks do not replace a physical transfer, but they verify the toolchain, both firmware variants, the partition binary, and Demo 1's browser protocol:

```sh
cd demo1-custom-gatt
pio run -e base && pio run -e updated
node web/protocol.test.js
node web/dashboard.test.js

cd ../demo2-bleota-library
pio run -e base && pio run -e updated
```

The projects are pinned to PlatformIO Espressif32 8.0.0 / Arduino-ESP32 3.3.12. PlatformIO labels the underlying board definition as N8/no-PSRAM, but the project overrides select the N16R8 settings: `qio_opi`, `BOARD_HAS_PSRAM`, a 16MB flash header, and the custom 16MB partition table.

## Critical pitfalls

- Firmware updates require an **OTA partition table** with `ota_0`, `ota_1` and `otadata`. Both demos include the same custom 16MB `partitions.csv` with two 6MB application slots. `firmware.bin` is an **application image only**; do not transfer combined flash, bootloader, partitions, or arbitrary source-code files.
- Do not install an OTA app compiled with the wrong board/partition layout, flash size or PSRAM config.
- Flashing a different partition table over USB changes the existing layout; migrate carefully on boards carrying valuable persistent data.
- If the board isn't advertising after USB upload, press **RST**, exactly as with the prior blinking project.
- Chrome requires a user gesture to select Bluetooth devices and uses secure origin (`https://` or `http://localhost`). Safari on iPhone does **not** support Web Bluetooth; phone interface work comes after desktop tests.
- OTA with CRC32/CRC16 **does not protect against malicious code**. Add asymmetric signatures, device authentication, release authorization, signed manifests, anti-rollback and secure boot for real deployments. Test low-power interruptions and connection loss. Use flash encryption if the threat model requires it.
- Both demos are starter prototypes; not certified for safety-critical use or validated on your particular board.

## Evaluation plan (run on same board and firmware size)

Perform 5 successful transfers per demo and record median of transfer duration, throughput, reboot/verify time and success rate; then try 10 adversarial runs each: disconnect mid-transfer, unplug mid-transfer, wrong-board bin, incomplete image, corrupted payload, change BLE range, and interrupted/retried upload.

Use [BENCHMARKING.md](BENCHMARKING.md) for the repeatable procedure and `benchmark-results.csv` for raw results. Alternate `base` and `updated` images over BLE so every timed run starts from a working OTA-capable firmware.

| Metric | Demo 1 (custom GATT) | Demo 2 (BLEOTA) | Acceptance target to set after first baseline |
| --- | --- | --- | --- |
| Setup / first-time flash | | | |
| Transfer time for identical .bin size | | | |
| Verified bytes per second | | | |
| Update success (5 runs) | | | |
| Recovery after disconnect | | | |
| Recovery after power loss | | | |
| Firmware version after reboot | | | |
| Binary signature enforcement | Not in demo | Optional, off in demo | REQUIRED in production |
| Dashboard integration complexity | | | |
| Licensing / maintenance burden | Original Atech code | AGPL-3.0 | |

**Selection rule:** prefer the approach that reliably recovers from failed updates and can be secured, not necessarily the one with the fastest green LED change. For Atech, evolve Demo 1 into an Atech-owned, versioned sector/window protocol and keep its Web Bluetooth client inside the dashboard. Borrow the useful behavior demonstrated by Demo 2—sector CRCs, bounded retries, larger write-without-response packets, and optional compression—but do not make the AGPL library or its externally hosted UI the product boundary unless that licensing/dependency choice is intentional. Espressif's vendor BLE OTA profile is the next baseline to test before finalizing the wire protocol.

## Reference implementations / API docs

- https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/ota.html
- https://docs.espressif.com/projects/esp-iot-solution/en/latest/bluetooth/ble_ota.html
- https://github.com/gb88/BLEOTA
- https://learn.sparkfun.com/tutorials/esp32-ota-updates-over-ble-from-a-react-web-application/all
- https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice
