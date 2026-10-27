# BLE OTA hardware validation and benchmark

Run both demos on the same ESP32-S3 N16R8, host computer, browser version, distance, and USB power source. Record every attempt in `benchmark-results.csv`, including failures. Do not compare only successful runs.

## Preflight

1. Record the board model/revision, LED GPIO, Chrome version, macOS version, and Bluetooth adapter in the CSV notes.
2. Build both environments and record exact binary sizes:

   ```sh
   cd demo1-custom-gatt
   pio run -e base && pio run -e updated
   stat -f '%N,%z' .pio/build/{base,updated}/firmware.bin

   cd ../demo2-bleota-library
   pio run -e base && pio run -e updated
   stat -f '%N,%z' .pio/build/{base,updated}/firmware.bin
   ```

3. Close nRF Connect and other BLE clients. Keep Chrome foregrounded and the board about one metre from the computer.
4. USB-flash the demo's `base` environment once. All measured base/updated changes after that must use BLE.

## Normal transfer runs

For each demo, perform at least six alternating uploads (`base -> updated -> base ...`). Treat the first as warm-up and report the median and p95 of the remaining five.

Start the timer when the browser sends START. Stop transfer timing on the final successful ACK. Separately record seconds until the board advertises again and the UI reads the expected firmware version. Record:

- file bytes and total seconds;
- application throughput: `file_bytes / transfer_seconds`;
- success/failure and browser/serial error;
- selected or probed BLE payload size;
- reconnect-and-version-verification seconds.

Demo 1 prints average KiB/s in its transfer log. Demo 2's upstream page reports throughput and sector progress. Keep the raw values because the two binaries are not exactly the same size.

## Recovery matrix

Repeat each scenario at least three times per demo:

| Scenario | Procedure | Pass condition |
| --- | --- | --- |
| Browser disconnect | Disconnect around 25%, reconnect, restart the whole upload | Old firmware remains bootable; retry succeeds without USB/reset |
| Board power loss | Remove power around 25% and again around 75% | Old firmware boots and advertises; retry succeeds |
| Browser refresh/tab close | Refresh or close around 50%, reconnect, retry | Old firmware remains active; retry succeeds |
| Range degradation | Move away until packet loss/retry occurs | Clear failure or bounded retry; no false success |
| Wrong file | Select `bootloader.bin`, a text file renamed `.bin`, and a different-chip app | Rejected before activation; old firmware remains active |
| Corrupted transfer | Use an instrumented client that changes bytes after calculating CRC | Final CRC/signature check rejects it |
| Post-update boot failure | Install a deliberately non-confirming/crashing test image only on a recoverable test board | Document whether USB recovery is required; these Arduino demo bootloaders do not enable automatic rollback |

After every interrupted transfer, capture the serial log and verify which partition boots. A transfer is not a recovery success merely because the device resets—it must advertise, reconnect, and report the expected old or new version.

## Acceptance gates for an Atech pilot

- 20/20 normal updates on each supported desktop/browser combination.
- 10/10 recovery attempts for disconnect and power loss at multiple transfer points.
- No activation after size, target, CRC, signature, or authorization failure.
- Reconnect and firmware-version confirmation exposed in the Atech dashboard.
- Median and p95 deployment time acceptable for the production firmware size.
- Signed manifest/image verification, device authentication, anti-rollback policy, and boot rollback tested before field deployment.
