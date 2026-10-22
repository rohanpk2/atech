# Atech ESP32-S3: browser-to-board BLE OTA evaluation

**Status:** Two code demos packaged; **not yet verified on a physical ESP32-S3**. The JavaScript syntax and package structure can be checked offline, but the firmware and transfer reliability must be measured on the real board.

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

- `demo1-custom-gatt/`: **First demo.** Atech-owned HTML/JS dashboard + PlatformIO project + self-defined GATT protocol. CRC32 validated before activating OTA slot. Stop-and-wait ACK after every flash write.
- `demo2-bleota-library/`: **Second demo.** PlatformIO project based on the separately installed `gb88/BLEOTA` package; use its maintained Web Bluetooth dashboard at https://gb88.github.io/BLEOTA/ . It handles 4KB sectors, CRC16, retries, and optional signing (the example leaves signing disabled).

**One-time USB installation is required for each demo's baseline firmware.** Thereafter `base -> updated` runs over Bluetooth. To change between demos, USB-flash the other demo baseline.

## Hardware / setup

- ESP32-S3 N16R8 (16MB flash, 8MB OPI PSRAM) such as your board.
- Mac desktop Chrome, Bluetooth enabled; close nRF Connect on the phone so it cannot hold the board connection.
- Cursor + PlatformIO installed and working (your earlier BLE blinky test confirms this).
- Board plugged into USB-C for power. USB is **only for baseline provisioning or recovery**, not for the BLE update.
- Existing N16R8 GPIO48 onboard NeoPixel assumed. If the RGB LED is on GPIO38 instead, change `LED_PIN` in source.

## Demo 1: fully controlled Atech web prototype

1. Open the `demo1-custom-gatt` directory in Cursor.
2. Put the board into upload mode if necessary (hold BOOT, tap RST, release BOOT).
3. In its Terminal run `pio run -e base -t upload`. This installs a BLUE, slow-blinking firmware that advertises `Atech-Custom-OTA`.
4. Press **RST** once after upload if no advertisements appear.
5. Run `pio run -e updated` (**compile only**, no upload). Firmware file: `demo1-custom-gatt/.pio/build/updated/firmware.bin`.
6. From the repo's `demo1-custom-gatt` folder run `python3 -m http.server 5173 --directory web`.
7. In **desktop Chrome** open http://localhost:5173 , press **Connect**, select `Atech-Custom-OTA`, choose the **updated** firmware bin, click Update Firmware.
8. After transferring, the board reboots; reconnect and confirm dashboard shows `v2 / green blink` rather than `v1 / blue blink`.

Notes: `localhost` is a browser secure context; when remotely hosting the dashboard use **HTTPS**. Leave the browser foregrounded during transfer. Try 120-byte chunks first, 60 then 20 if your Mac BLE negotiated a smaller MTU. This prototype uses a stop-and-wait flash ACK for each write; it may be slower than the library demo.

## Demo 2: existing BLE OTA implementation / browser

1. Open `demo2-bleota-library` in Cursor.
2. Run `pio run -e base -t upload` (BOOT/RST if required), then press RST if needed.
3. Run `pio run -e updated` to compile `.pio/build/updated/firmware.bin` (**do not USB-upload the updated version**).
4. On Mac Chrome visit https://gb88.github.io/BLEOTA/ , click Connect and choose `Atech-Library-OTA`.
5. Select `.pio/build/updated/firmware.bin`, select **FLASH** / application firmware, start OTA.
6. Wait for completion and reboot. Reconnect: FW version should read `demo2-2.0.0`, LED should blink GREEN quickly.

This browser uploader and library are by gb88 (not included or copied in this package). **AGPL-3.0**: assess redistribution/network-service implications with counsel before embedding in a proprietary Atech product. For production, enable the upstream project's signed-image verification; this unsecure demo does not.

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

**Selection rule:** prefer the approach that reliably recovers from failed updates and can be secured, not necessarily the one with the fastest green LED change. Demo 1 likely has the simplest proprietary integration; Demo 2 is a strong transfer-protocol performance baseline. If the library's license is unacceptable, next try Espressif's vendor BLE OTA profile (#3).

## Reference implementations / API docs

- https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/ota.html
- https://docs.espressif.com/projects/esp-iot-solution/en/latest/bluetooth/ble_ota.html
- https://github.com/gb88/BLEOTA
- https://learn.sparkfun.com/tutorials/esp32-ota-updates-over-ble-from-a-react-web-application/all
- https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice
