# Atech firmware builder

Describe what an ESP32-S3 board should do in plain English. Atech writes the firmware, checks it, and sends it to the board over Wi-Fi. No cables after the first setup.

## How it works

1. **Describe.** In the dashboard, type what the board should do, for example "blink the LED three times, pause, repeat".
2. **Generate.** The backend asks Claude for the code, compiles it with PlatformIO, and validates the image.
3. **Deploy.** The backend streams the image to the board over your Wi-Fi. The board flashes it, reboots, and confirms it is running. If the new code crashes, the board rolls back on its own.

Bluetooth (desktop Chrome) and the board's own hotspot are backups when Wi-Fi is not available.

## Parts

| Part | What it is |
| --- | --- |
| `builder/` | Node backend. Talks to the model, compiles, validates, deploys, and serves the dashboards. |
| `web-shared/` | The dashboard card shared by both demos. |
| `shared/` | Protected firmware core: device identity, sandboxed app task, Wi-Fi and Bluetooth OTA, rollback, safe mode. Generated code never touches it. |
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
2. Hold **BOOT** for three seconds, join the board's `Atech-OTA-…` hotspot, open http://192.168.4.1, enter the authorization code, and join your 2.4 GHz Wi-Fi. The hotspot password and code are printed on the serial console at boot.
3. In the dashboard, click **Find devices**, then **Pair** with the same code.

After that, every update is wireless.

## Status

Compiles, passes the automated tests, and works end to end against a simulated board. **Nothing has been verified on a physical ESP32-S3 yet.** These are prototypes: updates are authenticated with a per-device key and integrity-checked, but firmware is not cryptographically signed.

## More

- [AI_FIRMWARE_BUILDER.md](AI_FIRMWARE_BUILDER.md): what generated code may do, validation, identity and recovery.
- [WIFI_LAN_OTA.md](WIFI_LAN_OTA.md): Wi-Fi provisioning, deployment protocol, security review, browser support.
- [WIFI_OTA_TESTING.md](WIFI_OTA_TESTING.md): step-by-step hardware test procedures.
- [BENCHMARKING.md](BENCHMARKING.md): timing and recovery benchmarks.
- [deploy/README.md](deploy/README.md): server deployment with Docker, including HTTPS for the hosted dashboards.
- [vercel-frontend/README.md](vercel-frontend/README.md): hosting the dashboards on Vercel, exact settings and environment variables.
- [REFERENCE.md](REFERENCE.md): the detailed notes that used to live here: Demo 1 command protocol, hardware notes, hotspot fallback, pitfalls, transport shortlist, evaluation plan.
