# Atech firmware builder

Describe what an ESP32-S3 board should do in plain English. Atech writes the firmware, checks it, and sends it to the board over Wi-Fi. No cables after the first setup.

## How it works

1. **Describe.** In the dashboard, type what the board should do, for example "blink the LED three times, pause, repeat".
2. **Generate.** The backend asks Claude for the code, compiles it with PlatformIO, and validates the image.
3. **Deploy.** On your own network the backend streams the image to the board over Wi-Fi. From the hosted dashboard the board pulls it: it polls the backend over HTTPS, downloads the image, verifies its signature, flashes it, reboots, and confirms it is running once the backend has seen the new build. If the new code crashes, the board rolls back on its own. A board that cannot reach the cloud opens its own hotspot; the dashboard then prepares a signed update package you upload on the board's page (the local Wi-Fi update).

Bluetooth (desktop Chrome) is how a new board is put on Wi-Fi in the first place: an encrypted setup over the same connection, including WPA2-Enterprise networks with their CA certificate. Bluetooth never carries firmware in the standard build (the demos' original Bluetooth OTA protocols compile only with `-DATECH_BLE_OTA_DEMO=1`). The board's own hotspot page covers the setup when there is no Bluetooth.

## Parts

| Part | What it is |
| --- | --- |
| `builder/` | Node backend. Talks to the model, compiles, validates, deploys, and serves the dashboards. |
| `web-shared/` | The dashboard card shared by both demos. |
| `shared/` | Protected firmware core: device identity, sandboxed app task, Wi-Fi setup over Bluetooth, signed Wi-Fi OTA (cloud, LAN and the board's hotspot through one install engine), firmware signature verification (`AtechFwSign`), rollback, safe mode, and board-to-board sync over ESP-NOW (`AtechSync`). Generated code never touches it; it reaches the shared state through `atech::sync::*`. |
| `demo1-custom-gatt/` | Demo 1: Atech's own Bluetooth protocol. |
| `demo2-bleota-library/` | Demo 2: the same system on the open-source `gb88/BLEOTA` library (AGPL-3.0). |
| `deploy/` | Docker packaging for running the backend on a server. |

## Run it

```sh
cd builder
npm install
npm start
```

Open http://localhost:5173/demo1/ (or `/demo2/`). Put `ANTHROPIC_API_KEY` in `builder/.env` (or log in with the `claude` CLI) so the backend can reach the model.

No board? Start with `ATECH_SIMULATED_DEVICE=all npm start` to get two simulated boards.

No laptop? The dashboards can run on Vercel with the backend on a server: see [vercel-frontend/README.md](vercel-frontend/README.md).

## First-time board setup

1. Flash the base firmware once over USB: `pio run -e base -t upload` inside a demo folder, or use the browser installer at `/demo1/install.html`.
2. In desktop Chrome, click **Connect Bluetooth**, then in **Wi-Fi setup** pick your 2.4 GHz network, type its password and click **Join Wi-Fi**. The password goes to the board over an encrypted Bluetooth session and nowhere else; the board joins, reports to the build service and is claimed for you automatically.

After that, every update is wireless, from any browser. Builds generated before 2026-11-15 must be generated again before a deployment: their images predate firmware signing. No Bluetooth on this computer? The board's hotspot page still works: it comes up by itself on a board without Wi-Fi (or hold **BOOT** for three seconds), join `ATECH-…`, open http://192.168.4.1, enter the authorization code printed on the serial console, join your Wi-Fi (personal or enterprise), then **Claim a board** with the same code. See [WIFI_BLE_ONBOARDING.md](WIFI_BLE_ONBOARDING.md) and [UNIVERSAL_WIFI_OTA.md](UNIVERSAL_WIFI_OTA.md).

## Two boards

Two boards running the current firmware keep a shared state in agreement over ESP-NOW with no router or backend in the path. The stock app shows one boolean, `demo.power`, on both LEDs: a short press of **BOOT** on either board toggles both. Pair them from the serial console (`sync code` on one board, `sync pair <code>` on the other), from the dashboard's **Board connections** block over Bluetooth, or through the backend. See [BOARD_SYNC.md](BOARD_SYNC.md) for the exact commands, the two-board test procedure and the limits. Two simulated boards: `ATECH_SIMULATED_DEVICE=1,1 npm start`.

## Status

Compiles, passes the automated tests (including host-compiled tests of the board-to-board sync engine), and works end to end against simulated boards, including the cloud path, the Bluetooth Wi-Fi setup, the signed local update flow and pairing two simulated boards. **Nothing has been verified on a physical ESP32-S3 yet** beyond reading the boot log of the attached board (WIFI_BLE_ONBOARDING.md section 9). Updates are authenticated with a per-device key, integrity-checked and signed with the backend's ECDSA P-256 key, which the board verifies before selecting the new slot; downgrades need the owner's confirmation.

## More

- [UNIVERSAL_WIFI_OTA.md](UNIVERSAL_WIFI_OTA.md): firmware signing, the signed update package and the board's hotspot (local Wi-Fi update), enterprise Wi-Fi, captive-portal detection, the transport controller, the eleven test scenarios with expected results, and the limits.
- [WIFI_BLE_ONBOARDING.md](WIFI_BLE_ONBOARDING.md): one-time Wi-Fi setup over Bluetooth, the end-to-end cloud OTA flow, exact flash, redeploy and validation commands.
- [BOARD_SYNC.md](BOARD_SYNC.md): board-to-board sync over ESP-NOW: pairing, the shared state, the two-board test procedure, channel modes, security notes.
- [AI_FIRMWARE_BUILDER.md](AI_FIRMWARE_BUILDER.md): what generated code may do, validation, identity and recovery.
- [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md): Wi-Fi provisioning, deployment protocol, security review, browser support.
- [CLOUD_WIFI_OTA.md](CLOUD_WIFI_OTA.md): cloud deployments from the hosted dashboard, device API, claiming, rollback, the physical checklist.
- [WIFI_OTA_TESTING.md](WIFI_OTA_TESTING.md): step-by-step hardware test procedures.
- [BENCHMARKING.md](BENCHMARKING.md): timing and recovery benchmarks.
- [deploy/README.md](deploy/README.md): server deployment with Docker, including HTTPS for the hosted dashboards.
- [vercel-frontend/README.md](vercel-frontend/README.md): hosting the dashboards on Vercel, exact settings and environment variables.
- [REFERENCE.md](REFERENCE.md): the detailed notes that used to live here: Demo 1 command protocol, hardware notes, hotspot fallback, pitfalls, transport shortlist, evaluation plan.
