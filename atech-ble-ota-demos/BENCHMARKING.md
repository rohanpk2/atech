# BLE and Wi-Fi OTA hardware validation and benchmark

Run both demos on the same ESP32-S3 N16R8, host computer, browser version, distance, and USB power source. Exercise Bluetooth OTA and the independent Wi-Fi SoftAP portal as separate transports. Record every attempt in `benchmark-results.csv`, including failures. Do not compare only successful runs, and do not mark a row as hardware-tested unless the transfer was actually performed on a board.

## Preflight

1. Record the board model/revision, LED GPIO, BOOT-button GPIO (if confirmed), power source, macOS version, Chrome version, Safari version, iPhone model/iOS version, Bluetooth adapter, and test distance in the CSV notes.
2. Build both environments and record exact binary sizes:

   ```sh
   cd demo1-custom-gatt
   pio run -e base && pio run -e updated
   stat -f '%N,%z' .pio/build/{base,updated}/firmware.bin

   cd ../demo2-bleota-library
   pio run -e base && pio run -e updated
   stat -f '%N,%z' .pio/build/{base,updated}/firmware.bin
   ```

3. Confirm that the selected file is the environment's `firmware.bin`. Never select `bootloader.bin`, `partitions.bin`, or a merged flash image for a normal run.
4. For BLE runs, close nRF Connect and other BLE clients, keep Chrome foregrounded, and place the board about one metre from the computer.
5. Before an iPhone Wi-Fi run, AirDrop the required `firmware.bin` to the iPhone and save it in Files. Do this before joining the board hotspot because the hotspot intentionally has no Internet connection.
6. Obtain the device-specific hotspot password and separate OTA authorization credential using the documented USB/serial provisioning procedure. Verify the SSID suffix against the board under test. Do not put either credential in `benchmark-results.csv`, screenshots, or shared logs.
7. USB-flash the demo's `base` environment once at the start of that demo's test series. Every measured `base -> updated` or `updated -> base` change after provisioning must use the transport named in the CSV row; do not count a USB recovery flash as an OTA success.

## Browser and transport matrix

At minimum, run every non-empty cell below. Record exact browser and OS versions rather than assuming that all browsers behave alike.

| Demo | Bluetooth OTA | Wi-Fi OTA at `http://192.168.4.1` |
| --- | --- | --- |
| Demo 1: custom GATT | macOS Chrome, Atech dashboard | macOS Safari, iPhone Safari, and macOS Chrome |
| Demo 2: gb88 BLEOTA | macOS Chrome, upstream gb88 page | macOS Safari, iPhone Safari, and macOS Chrome |

On Safari, also confirm that Demo 1's hosted dashboard detects the lack of `navigator.bluetooth`, does not present Bluetooth as usable, and gives the Wi-Fi fallback procedure. On Chrome, confirm that Bluetooth remains the preferred option and that choosing the Wi-Fi instructions does not attempt a cross-origin HTTP upload from the hosted dashboard. Demo 2's upstream gb88 page remains the BLE interface; its Wi-Fi test starts from the board-hosted portal.

## Normal transfer runs

For each demo and each required browser/transport combination, perform at least six alternating uploads (`base -> updated -> base ...`). Treat the first as warm-up and report the median and p95 of the remaining five. Alternation is important: it proves that both the base and updated images retain both OTA methods.

### Bluetooth timing

Start the timer when the browser sends START. Stop transfer timing on the final successful ACK. Separately record seconds until the board advertises again and the UI reads the expected firmware version. Record:

- file bytes and total seconds;
- application throughput: `file_bytes / transfer_seconds`;
- success/failure and browser/serial error;
- selected or probed BLE payload size;
- reconnect-and-version-verification seconds.

Demo 1 prints average KiB/s in its transfer log. Demo 2's upstream page reports throughput and sector progress. Keep the raw values because the two binaries are not exactly the same size.

### Wi-Fi timing

Measure these phases separately so browser upload progress is not confused with completed flash verification:

1. Long-press BOOT for approximately three seconds while firmware is running. Record seconds until the named `Atech-OTA` hotspot becomes joinable. A different board must map `buttonPin` to a safe active-low runtime button (or add an explicit call to `wifiOta.start()`); that porting work is required before testing if GPIO0 is unavailable.
2. Join the WPA2 hotspot and record seconds until the local portal first loads at `http://192.168.4.1` and reports the expected device name and current firmware version.
3. Select the application `firmware.bin`, enter the separate OTA authorization credential, and start the deployment. Start transfer timing when **Deploy Firmware** is pressed.
4. Record the time when browser upload progress first reaches 100%. This is the upload/stream time, not success.
5. Record the time when the portal reports that image validation and flash verification succeeded. A response that only received all bytes is not a successful update.
6. Record seconds from deploy until the rebooted board's portal is reachable again and reports the new version. Confirm the expected LED behavior, then let Wi-Fi OTA mode time out and confirm BLE advertising/operation returns.

For Wi-Fi rows, calculate upload throughput as `file_bytes / browser_upload_seconds`; leave `payload_bytes` blank or note `HTTP stream` rather than inserting a BLE ATT payload size. Put hotspot-start, portal-load, validation, and post-reboot status timings in `error_or_observation` until the CSV gains dedicated columns. Also record whether iOS/macOS displayed a no-Internet warning or required manually opening the numeric IP.

## Recovery matrix

Repeat each applicable scenario at least three times per demo and transport:

| Scenario | BLE procedure | Wi-Fi procedure | Pass condition |
| --- | --- | --- | --- |
| Browser/radio disconnect | Disconnect around 25%, reconnect, and restart the whole upload | At 25% and 75%, disable Wi-Fi or leave the hotspot; reconnect and restart the whole upload | The running firmware remains bootable; retry succeeds without a USB flash; no partial image is selected |
| Board power loss | Remove power around 25% and again around 75% | Remove power around 25% and again around 75% | The previous firmware boots; its OTA interfaces return; a full retry succeeds |
| Browser refresh/tab close | Refresh or close around 50%, reconnect, and retry | Refresh or close around 50%, reopen the numeric IP, reauthorize, and retry | Clear failure/aborted state; the previous firmware remains active; retry succeeds |
| Range degradation | Move away until packet loss or retry occurs | Move away or attenuate the hotspot until the TCP upload breaks | Clear failure or bounded retry; no false success; normal operation returns |
| Wrong file type/target | Select `bootloader.bin`, `partitions.bin`, a merged image, text renamed `.bin`, and a different-chip app | Select the same invalid set in the local portal | Rejected before activation with a useful error; the current firmware remains active |
| Oversized or incomplete image | Attempt an image larger than the inactive slot and an intentionally truncated application image | Attempt the same through the local portal | Size/completeness validation fails; the running partition is not replaced |
| Corrupted transfer | Use an instrumented client that changes bytes after calculating CRC | Use an instrumented request that changes application bytes or the appended image hash | Final integrity verification rejects it; no success is shown; the current firmware remains active |
| Post-update boot failure | Install a deliberately non-confirming/crashing test image only on a recoverable test board | Same, only on a recoverable test board | Document whether USB recovery is required; do not infer rollback support from a reset alone |

### Wi-Fi-specific behavior

Run these additional cases on macOS Chrome and iPhone Safari where applicable:

| Scenario | Procedure | Pass condition |
| --- | --- | --- |
| Hotspot authentication | Try a wrong WPA2 password, then the correct password | Wrong password cannot join; correct password reaches only this board's portal |
| OTA authorization | With the correct hotspot password, omit or enter an incorrect OTA credential | Status may remain viewable, but deployment is rejected without writing or activating firmware |
| Idle timeout | Activate Wi-Fi OTA and send no requests for the documented timeout | Portal/AP stops cleanly and normal BLE advertising/commands return without a reset or flash |
| Upload stall | Start an upload, interrupt network delivery without closing the tab, and wait past the upload timeout | Incomplete OTA handle is aborted, a clear timeout/error is reported when possible, and a later full retry works |
| Concurrent Wi-Fi upload | Start a deployment, then submit a second authorized deployment from another browser | The single-client server may queue/refuse/reset it or report busy, but it cannot acquire a second OTA writer or disturb/falsely complete the first update |
| BLE-to-Wi-Fi exclusion | Start a BLE OTA, then hold BOOT long enough to request Wi-Fi mode | Wi-Fi OTA does not start while BLE flash writing is active; the BLE session either completes normally or reports a defined failure |
| Wi-Fi-to-BLE exclusion | Activate Wi-Fi OTA and begin uploading, then try to connect through the BLE interface | A BLE OTA cannot begin concurrently; the Wi-Fi upload has exclusive ownership of the inactive partition |
| Post-update portal | Complete a valid update and wait for reboot without changing networks manually | Temporary Wi-Fi access returns long enough for the portal to report the new version and verified status |
| Return to BLE | After post-update verification, wait for the temporary Wi-Fi window to expire | BLE reconnects and reports the new version; Demo 1 commands/ACKs or Demo 2 gb88 service still work |
| SoftAP start failure | Where safely reproducible, exhaust/disable the Wi-Fi resource or use a diagnostic build that forces AP-start failure | Serial/UI state reports failure, BLE remains usable, and no OTA session is left active |

After every interrupted transfer, capture the serial log and verify which partition boots. For BLE, reconnect and read the version. For Wi-Fi, reopen the portal during its post-reboot window and read the version, then verify BLE again after timeout. A transfer is not a recovery success merely because the device resets. It must reconnect through the expected interface, report the expected old or new version, and retain both OTA methods.

## Functional verification after every success

- Demo 1 base must report v1 and default to slow blue blinking; updated must report v2 and default to green. Run `ping`, `get status`, and at least one LED command, and verify the request ID and ACK still match.
- Demo 2 must report the expected base/updated version through the gb88 device information service; the updated image must show the documented fast green LED behavior.
- Re-enter Wi-Fi OTA mode from the newly installed firmware and load the portal once. This confirms that Wi-Fi OTA was not lost after the first update.
- Return to BLE and perform the next alternating update. This confirms that BLE OTA was not lost after a Wi-Fi update.
- Record portal/server errors and serial output verbatim where practical, but redact hotspot and OTA credentials.

## Acceptance gates for an Atech pilot

- 20/20 normal updates on every claimed demo/browser/transport combination, including iPhone Safari for Wi-Fi and macOS Chrome for BLE regression.
- 10/10 recovery attempts for disconnect and power loss at multiple transfer points on each transport.
- No activation after size, image type, chip target, completeness, integrity, or authorization failure.
- Upload completion, flash/image verification, reboot, and firmware-version confirmation are reported as distinct states.
- Both BLE and Wi-Fi OTA remain available after installing either the base or updated application image.
- The inactive/idle Wi-Fi portal times out and returns to normal BLE operation; concurrent BLE/Wi-Fi writes are prevented.
- Median and p95 deployment time acceptable for the production firmware size.
- Future production gate (not enabled by these demo builds): signed manifest/image failure, device authentication, anti-rollback policy, and boot rollback tested before field deployment.
