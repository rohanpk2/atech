# Wi-Fi OTA physical verification

This is the hardware test procedure for the Wi-Fi SoftAP fallback in both Atech BLE OTA demos. It deliberately keeps the BLE regression tests in scope: a firmware build passes only when its original BLE updater and the independent Wi-Fi updater both still work after an update.

> **Test status:** these steps have not been run on physical hardware in this repository environment. A successful build is not a hardware result. Record the board revision, LED pin, browser/OS versions, serial output, firmware file size, and every pass or failure when running this procedure.

## What must be tested

| Demo | Base state after USB flash | Updated state after OTA | Existing BLE interface | Wi-Fi hotspot |
| --- | --- | --- | --- | --- |
| Demo 1: custom GATT | `Atech demo1 / v1 / blue default`; GPIO48 LED blinks blue, 1.2 s period | `Atech demo1 / v2 / green default`; LED blinks green, 350 ms period | Local Atech dashboard in desktop Chrome; device `Atech-Custom-OTA` | `Atech-OTA-D1-<device suffix>` |
| Demo 2: gb88 BLEOTA | `demo2-1.0.0`; GPIO48 LED blinks blue, 1.2 s period | `demo2-2.0.0`; LED blinks green, 350 ms period | <https://gb88.github.io/BLEOTA/> in desktop Chrome; device `Atech-Library-OTA` | `Atech-OTA-D2-<device suffix>` |

Both Wi-Fi portals are expected at **http://192.168.4.1/**. Type `http://` explicitly; the device does not serve HTTPS and the existing HTTPS BLE pages must not attempt to upload to it.

Use the application image at `.pio/build/<environment>/firmware.bin`. Never select `bootloader.bin`, `partitions.bin`, a filesystem image, or a merged flash image for a normal update.

## Security and credential handling

Wi-Fi OTA mode is not an open hotspot. On its first boot, unless build-time overrides are configured, the device creates:

- a device-suffixed SSID;
- a randomly generated WPA2 password; and
- a separate, randomly generated OTA authorization code for the portal.

The password and authorization code are saved in NVS and persist across OTA updates, reboots, and later Wi-Fi OTA activations. They do not rotate merely because the AP stops or starts. They change only when the applicable NVS data is erased or a provisioned build supplies different overrides.

The WPA2 password controls access to the hotspot; it is **not** the OTA authorization code. The firmware prints the credentials at every boot and every AP start under the exact labels `SSID`, `WPA2 password`, and `OTA authorization code`. Capture all three from the 115200-baud serial log during provisioning. If a build uses configured credential overrides, the serial log remains the source of truth for that device. Do not put credentials in screenshots, benchmark CSV files, tickets, or source control.

The demo's random credentials and authorization code prevent casual unauthenticated use, but transport CRCs, an ESP image checksum, and WPA2 are not release authorization. Before deployment, require signed firmware, protect the signing key, enable the appropriate secure-boot/anti-rollback policy, provision per-device secrets, rate-limit authorization attempts, and define credential rotation and recovery. Demo 2's upstream signing option is not enabled by the current demo configuration.

## Preflight and build

Run the four builds before connecting a board:

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
pio run -e base
pio run -e updated
node web/protocol.test.js
node web/dashboard.test.js

cd ../demo2-bleota-library
pio run -e base
pio run -e updated
```

Record the application image sizes:

```sh
cd ~/Projects/atech/atech-ble-ota-demos
stat -f '%N,%z' demo1-custom-gatt/.pio/build/{base,updated}/firmware.bin
stat -f '%N,%z' demo2-bleota-library/.pio/build/{base,updated}/firmware.bin
```

The custom partition table provides two 6 MiB application slots. Treat an image above the inactive slot's capacity as invalid even if a browser lets it be selected.

Before each run:

1. Record the exact ESP32-S3 board/module revision, flash/PSRAM size, and whether its RGB LED is GPIO48 or GPIO38. The checked-in build targets an N16R8 board and GPIO48.
2. Record the macOS, iOS, Safari, and Chrome versions. Enable Bluetooth and Wi-Fi.
3. Close nRF Connect, LightBlue, other browser tabs, and any process that could retain a BLE connection.
4. Use a stable USB supply or power bank. Do not infer success only from a reset; confirm the reported firmware version and LED behavior.
5. Preserve serial logs for failure runs. They are needed to distinguish browser disconnect, authorization, image validation, flash, and reboot failures.

## USB-provision a base image

USB provisioning writes the bootloader, partition layout, and base application. It is the known recovery path and the starting point for every canonical `base -> updated` test.

### Demo 1

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
pio run -e base -t upload
pio device monitor -b 115200
```

Expected result: the serial log reports Demo 1 firmware v1, the device advertises `Atech-Custom-OTA`, and the LED slowly blinks blue.

### Demo 2

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo2-bleota-library
pio run -e base -t upload
pio device monitor -b 115200
```

Expected result: the serial log reports Demo 2 firmware v1, the device advertises `Atech-Library-OTA`, the BLE Device Information firmware value is `demo2-1.0.0`, and the LED slowly blinks blue.

If PlatformIO cannot enter download mode, hold **BOOT**, tap **RST**, release **BOOT**, and retry the upload. Press **RST** once after upload if the application does not start. This is the ROM flashing sequence; it is distinct from the runtime long-press described below. Never tap RST while holding BOOT merely to start Wi-Fi OTA.

If more than one serial device is present, identify it with `pio device list`, then add the port explicitly:

```sh
pio run -e base -t upload --upload-port /dev/cu.usbmodemXXXX
pio device monitor -b 115200 --port /dev/cu.usbmodemXXXX
```

Exit the serial monitor with `Ctrl-]` before another command needs the same port.

## Start Wi-Fi OTA mode and capture credentials

Perform these steps while the application is already running:

1. Leave the serial monitor open at 115200 baud.
2. Make sure no BLE update is running and no browser is connected to the board over BLE.
3. Hold **BOOT** for approximately three seconds, without pressing RST. Release it when the serial log says Wi-Fi OTA mode is starting.
4. Copy the values printed after `SSID`, `WPA2 password`, and `OTA authorization code` into a temporary local note.
5. Confirm the SSID is `Atech-OTA-D1-<suffix>` for Demo 1 or `Atech-OTA-D2-<suffix>` for Demo 2, and that it is not an open network.
6. Join that SSID. Accept the OS warning that the network has no internet, and choose to remain connected.
7. Open **http://192.168.4.1/**. If the browser silently upgrades the URL to HTTPS, edit it back to `http://` or use a private tab without an HTTPS-only rule.
8. Enter the OTA authorization code in the portal. A client that has only the WPA2 password must not be allowed to start an update.

Expected idle page:

- current firmware version and Demo 1/Demo 2 device name are correct;
- connection state says the portal is connected/ready;
- file picker accepts an application `.bin`;
- Deploy Firmware is disabled until a valid file has been selected; the authorization code is validated only when Deploy Firmware is clicked;
- upload progress is distinct from flash/image verification;
- no BLE transfer can start while the Wi-Fi OTA session owns the updater.

The Wi-Fi OTA mode is intentionally temporary. With no valid firmware upload in progress for **10 minutes**, it should remove the AP and return to normal BLE advertising. Automatic status polling and captive-portal probes deliberately do not extend the session, so even an idle open page must time out. Record the actual elapsed time from the serial log and verify BLE again; do not count an AP disappearance by itself as a pass.

## Canonical Wi-Fi `base -> updated` run

Repeat this run for every browser row in the matrix below. USB-flash `base` again between rows so each test begins from a known partition and version.

| Demo | Browser/device | Required result |
| --- | --- | --- |
| Demo 1 | Safari on macOS | Local portal uploads `demo1-custom-gatt/.pio/build/updated/firmware.bin`; post-reboot page reports v2; green fast blink; BLE commands and BLE OTA remain available |
| Demo 1 | Chrome on macOS | Same result; this tests Wi-Fi HTTP upload independently of Chrome's Web Bluetooth support |
| Demo 1 | Safari on iPhone | File chosen from Files; same v2/green/post-reboot/BLE result |
| Demo 2 | Safari on macOS | Local portal uploads `demo2-bleota-library/.pio/build/updated/firmware.bin`; post-reboot page reports `demo2-2.0.0`; green fast blink; gb88 BLEOTA remains available |
| Demo 2 | Chrome on macOS | Same result; independent Wi-Fi regression |
| Demo 2 | Safari on iPhone | File chosen from Files; same v2/green/post-reboot/BLE result |

For each row:

1. Confirm the board is on its base version and slowly blinking blue.
2. Start Wi-Fi OTA mode and join the correct D1 or D2 hotspot using the serial credentials.
3. At `http://192.168.4.1/`, verify the base version and device name before selecting a file.
4. Select that demo's exact `.pio/build/updated/firmware.bin`. Verify the portal displays the file name and byte count. Do not select the other demo's image.
5. Click **Deploy Firmware** once. A second click/browser may queue, time out, reset, or receive busy from the single-client server, but it must never start another writer.
6. Keep the page foregrounded and power stable. Record upload duration, peak progress, and all status/error text.
7. Confirm the page first reaches 100% **uploaded**, then separately reports that flash/image verification succeeded. A progress bar reaching 100% is not an OTA pass.
8. Confirm the device reboots only after successful verification and boot-partition activation.
9. If the browser disconnects when the AP reboots, wait for the same SSID to reappear, rejoin with the same temporary WPA2 password, and reopen `http://192.168.4.1/`. The temporary post-update access window must survive this reboot long enough to verify status.
10. Confirm the portal reports the updated version and a successful previous update, and the LED now blinks green quickly.
11. Let the temporary AP close or use the portal's normal exit behavior. Confirm the original BLE advertisement returns.
12. Run the demo's BLE post-update check. This proves that the updated image retained both OTA transports.

Record failure if the portal says success before image verification, if the running version is unchanged, if the LED changes without a matching version, if the AP credentials unexpectedly change across the verification reboot, or if BLE does not return after Wi-Fi mode ends.

## Safari on iPhone: get the image into Files first

Do this before joining the ESP32's no-internet hotspot:

1. Build the appropriate `updated` environment on the Mac.
2. In Finder press `Command-Shift-G`, paste one of these paths, and select `firmware.bin`:

   ```text
   ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt/.pio/build/updated/firmware.bin
   ~/Projects/atech/atech-ble-ota-demos/demo2-bleota-library/.pio/build/updated/firmware.bin
   ```

3. Rename the AirDrop copy to `demo1-updated-firmware.bin` or `demo2-updated-firmware.bin` if both will be on the phone. Renaming does not change its contents.
4. AirDrop it to the test iPhone. On the iPhone choose **Save to Files**, then save under **On My iPhone** or **Downloads**. Verify the file is present and its byte size matches the Mac.
5. Only now open **Settings > Wi-Fi** and join the board hotspot. Choose **Use Without Internet**/remain connected if prompted. Avoid AirDrop during the OTA because it can change radio/network state.
6. In Safari open `http://192.168.4.1/`, authorize, tap the file chooser, choose **Browse**, and select the saved `.bin` from Files.
7. Keep Safari foregrounded and the iPhone unlocked until flash verification completes. If iOS returns to cellular data or another Wi-Fi network, reselect the Atech hotspot and reopen the local page.

Safari on iPhone does not need Web Bluetooth for this path. The firmware bytes travel from Files to the ESP32 over local HTTP on the WPA2 SoftAP.

## BLE regression after the Wi-Fi changes

Run the original BLE flow before the Wi-Fi matrix and again after at least one successful Wi-Fi update. Safari is not the BLE test browser.

### Demo 1: Atech dashboard in Chrome

```sh
cd ~/Projects/atech/atech-ble-ota-demos/demo1-custom-gatt
python3 -m http.server 5173 --directory web
```

1. Open <http://localhost:5173/> in desktop Chrome.
2. Confirm the dashboard detects `navigator.bluetooth`, presents Bluetooth OTA as the preferred option, and also exposes Wi-Fi fallback instructions.
3. Click **Connect device**, select `Atech-Custom-OTA`, and run the BLE connection test.
4. Send `blink green`, `blink blue`, `stop blinking`, `get status`, and `ping`. Verify matched request IDs/ACKs and physical LED behavior.
5. From a USB-provisioned base image, select `demo1-custom-gatt/.pio/build/updated/firmware.bin` in **Update over Bluetooth** and deploy.
6. Require the dashboard's post-reboot version change and fresh PING before accepting **Verified**. Expected final state is v2 and the fast green default.
7. Send another command after reboot to show the original command/ACK protocol remains intact.

Open the same dashboard in Safari as a UI-only check: it must detect the lack of Web Bluetooth, show the SoftAP instructions, and must not try to POST the file from the dashboard to `http://192.168.4.1/`.

### Demo 2: upstream gb88 page in Chrome

1. From a USB-provisioned base image, open <https://gb88.github.io/BLEOTA/> in desktop Chrome.
2. Click **Connect**, choose `Atech-Library-OTA`, and confirm the reported firmware is `demo2-1.0.0`.
3. Select `demo2-bleota-library/.pio/build/updated/firmware.bin` and choose **FLASH** / application firmware.
4. Start the existing BLE OTA flow without changing the gb88 protocol.
5. After reboot, reconnect and require firmware `demo2-2.0.0` plus the fast green LED.
6. Perform another BLE discovery/read after a successful Wi-Fi update to prove the updated image still exposes the same service and Device Information values.

The gb88 website remains Demo 2's BLE updater. The device-hosted `http://192.168.4.1/` page is a separate Wi-Fi fallback, not a replacement or proxy for that website.

## Exclusivity tests

Run each case for both demos:

| Starting state | Action | Pass condition |
| --- | --- | --- |
| BLE connected but idle | Long-press BOOT | Wi-Fi mode does not steal the flash updater; serial/UI clearly says busy or asks for BLE disconnect |
| BLE transfer active | Long-press BOOT around 25% | BLE transfer continues or fails clearly; no SoftAP update session begins concurrently; running partition remains valid |
| Wi-Fi portal active, no upload | Scan/connect with the BLE page | No OTA transfer can acquire the updater while Wi-Fi owns it; no ambiguous dual-success state |
| Wi-Fi upload active | Try a second portal/browser and BLE updater | Second writer cannot acquire the updater (it may queue, time out, reset, or receive busy because the embedded server is single-client); first transfer is not corrupted |
| Wi-Fi mode timed out | Reconnect over BLE | Original advertisement, commands (Demo 1), and updater are usable without reset |

Never intentionally race two valid production images on a valuable board. These tests are checking rejection and ownership, not last-writer-wins behavior.

## Interrupted upload and cleanup

For each demo, USB-provision base before the series. Repeat interruptions near 25% and 75%.

### Browser/network interruption

1. Begin a Wi-Fi upload of the correct updated image.
2. At the chosen progress point, close the tab or switch the client to another Wi-Fi network.
3. Observe the serial log until the Arduino WebServer's 5-second stalled-POST timeout emits the abort callback and cleans up the incomplete transfer. The 10-minute AP timeout is suspended while a valid upload is active.
4. Confirm the device does not reboot into the partial image and does not report verified success.
5. Rejoin/restart Wi-Fi OTA mode as required, reopen the portal, and confirm it reports the aborted/incomplete result rather than success.
6. Retry the complete upload. Pass only if the retry verifies, reboots to the updated version, and BLE returns.

### Power interruption

1. Begin a Wi-Fi upload from a USB-provisioned base.
2. Remove power near 25% (repeat later near 75%).
3. Restore power without holding BOOT.
4. Confirm the old base application boots, slowly blinks blue, reports the old version, and advertises BLE. The incomplete inactive partition must not become the boot target.
5. Long-press BOOT to create a fresh Wi-Fi session, confirm that the same NVS-persisted credentials are printed, and retry the full update.

### Inactivity and return to BLE

1. Start Wi-Fi OTA mode but do not load the page or upload a file.
2. Leave the portal page open but do not upload, and wait at least 10 minutes while watching serial output. Its automatic status requests must not extend the timer.
3. Confirm the AP disappears, updater state is released, and the expected BLE name becomes discoverable again.
4. Start the portal a second time. Confirm the same `SSID`, `WPA2 password`, and `OTA authorization code` are printed and still work. They must change only after the relevant NVS data is erased or configured overrides are changed.

An incomplete transfer passes recovery only when the known-good firmware boots and both a later retry and BLE operation succeed. Merely resetting is not enough.

## Invalid image and authorization tests

Run these tests on a recoverable board while base is active. After every rejection, confirm the base version and blue LED still run and a valid retry remains possible.

| Test | Input/action | Required behavior |
| --- | --- | --- |
| Missing/incorrect code | Omit or alter the OTA authorization code, then click Deploy Firmware | Empty code is rejected locally; a nonempty wrong code receives HTTP 401; `esp_ota_begin` is never reached; no flash activation |
| Reused/second writer | Start from a second authenticated browser during upload | The single-client server queues/refuses/resets it or reports busy; it cannot become a second updater owner |
| Bootloader | Select `.pio/build/base/bootloader.bin` | Reject as non-application/wrong image; no reboot or partition switch |
| Partition table | Select `.pio/build/base/partitions.bin` | Reject as non-application/wrong image |
| Other ESP target | Use an application built for a non-S3 ESP32 | Reject target/chip mismatch before activation |
| Other Atech demo | Send Demo 2 image to Demo 1 and vice versa | Reject the missing/mismatched compiled identity marker with a different-demo/target error; `esp_ota_set_boot_partition` is never called |
| Oversize | Use a file larger than the inactive 6 MiB slot | Reject from the declared size before `esp_ota_begin`; clear size error |
| Truncated | Upload a truncated copy of a valid application | Completeness/integrity verification fails; incomplete partition is not activated |
| Corrupted | Flip bytes in a copy of a valid image | ESP image integrity verification fails; no activation |
| Client disconnect | Break Wi-Fi mid-body | Abort/cleanup; no false 100%-verified state |

Create a disposable truncated input outside the repository, if needed:

```sh
cd ~/Projects/atech/atech-ble-ota-demos
dd if=demo1-custom-gatt/.pio/build/updated/firmware.bin \
  of=/tmp/demo1-truncated-firmware.bin bs=1024 count=64
```

An actual `esp_ota_write` flash failure is difficult to induce safely without a diagnostic build or failing hardware. For a production validation campaign, add a test-only shared-library fault hook that returns an injected write error after a chosen byte offset; require a clear HTTP/serial flash error, `esp_ota_abort()`, no reboot/partition selection, and a successful clean retry. Do not simulate this by damaging a valuable board.

Do not overwrite the real build artifact. Do not deliberately install an image known to boot-loop unless the test board has a proven USB recovery path and no valuable data.

## USB recovery

Use USB recovery when the application does not boot, neither OTA interface returns, credentials are unavailable, or the partition layout is suspect:

1. Disconnect other serial/BLE clients.
2. Hold **BOOT**, tap **RST**, then release **BOOT** to enter the ROM downloader.
3. Re-run the appropriate base upload command from **USB-provision a base image**. Specify `--upload-port` if needed.
4. Tap RST once if the application does not start automatically.
5. Confirm base version, slow blue LED, and the original BLE advertisement before retrying OTA.

USB-flashing `base` is expected to restore the checked-in partition layout. It can overwrite application state; use a dedicated test board and back up any valuable persistent data before recovery.

## Result record

For every matrix row, capture at least:

| Field | Value |
| --- | --- |
| Demo and source version | |
| Target version | |
| Board/module revision and LED GPIO | |
| Browser, browser version, and OS | |
| Firmware path, size, and SHA-256 | |
| SSID suffix (never password/authorization code) | |
| Upload duration | |
| Time from upload completion to verified reboot | |
| Reported verification result | |
| Version and LED after reboot | |
| Post-update local portal result | |
| Post-update BLE regression result | |
| Serial error/status and recovery action | |

On macOS, record an artifact digest with:

```sh
shasum -a 256 path/to/firmware.bin
```

Mark hardware behavior **not tested** until the corresponding row has actually been run. Do not turn a compile result, browser progress bar, LED color alone, or inferred partition state into a hardware pass.
