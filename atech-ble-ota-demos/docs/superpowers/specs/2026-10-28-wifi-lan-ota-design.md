# Wi-Fi primary OTA with Bluetooth fallback

Date: 2026-10-28. Status: implemented from the requester's written brief (the ten numbered sections); choices marked **(my call)** were made by the builder.

## Intent

Power the ESP32-S3 from a wall charger, open the Atech dashboard in Safari or Chrome, type a prompt, generate, click **Deploy**, and have the firmware arrive over the user's own Wi-Fi network in seconds instead of twelve minutes over BLE. Bluetooth stays as the backup, the device-hosted hotspot portal as the last resort.

## Browser constraints that shape the architecture

- A page served from `http://localhost:5173` (or the Mac's LAN address for phones) must not be relied on to upload to `http://<board-ip>`: Safari and Chrome apply CORS, Chrome applies Local Network Access checks, and an HTTPS-hosted dashboard would hit mixed-content blocking outright.
- Safari has no Web Bluetooth and no Web Serial.

**Decision (my call):** the browser never talks to the board. The dashboard asks the builder backend (same origin, plain `fetch` and `EventSource`, works in every listed browser) to deploy a validated build. The backend, which already holds the `firmware.bin`, streams it to the board over the LAN and reports progress over SSE. Nothing is proxied through the browser, no security check is disabled, no cloud is involved.

## Device side (protected core, never AI-generated)

New shared library `shared/AtechWifiLan`:

- **Station mode.** Credentials live in NVS (`Preferences`, namespace `atech_wifi`). On boot the core connects, disables Wi-Fi modem sleep, sets hostname `atech-<suffix>`, enables auto-reconnect and retries with its own 15 s watchdog. 2.4 GHz only (hardware).
- **mDNS.** `atech-<suffix>.local`, service `_atech-ota._tcp` on port 8080 with TXT `id, suffix, demo, fw, build, ver, proto`.
- **LAN service** on `esp_http_server` (own task on core 0, priority 5, 16 KiB receive buffer, keep-alive). Routes: `GET /api/identity`, `GET /api/ota/challenge`, `POST /api/ota/begin`, `PUT /api/ota/chunk?offset=`, `POST /api/ota/finish`, `POST /api/ota/abort`, `POST /api/control`.
- **Authentication.** Per-device secret = the existing NVS OTA authorization code (never sent over the LAN). Every begin/control request carries a fresh device-issued nonce (16 random bytes, 90 s TTL, single use) and `HMAC-SHA256(secret, "atech-ota-begin/1\n<device id>\n<nonce>\n<size>\n<sha256>\n<build id>\n")`. The HMAC binds the device id (wrong-board protection), the nonce (replay protection), the image digest and the build id (content binding). A chunk session id is a single-use bearer for one transfer only; injecting bytes into it just fails the digest check.
- **Streaming writes.** Chunks go straight into `esp_ota_write` on the inactive slot; the first 36 bytes are checked for ESP magic, chip id 9, 16 MB flash header and the app descriptor; the stream is scanned for the demo identity marker, `ATECH-BUILD:<id>` and `ATECH-TARGET:<id>` (empty or own id); SHA-256 is verified; `esp_ota_end` validates the image; only then `esp_ota_set_boot_partition`, respond, reboot. Session idle > 20 s aborts with `esp_ota_abort`.
- **Exclusivity.** `atech::coreTryAcquireOta("lan")` plus the existing busy callbacks: one writer at a time across BLE, hotspot and LAN. The app task is suspended only during a transfer. BLE advertising is paused during the transfer and resumed afterwards; a connected BLE client is not evicted.
- **Rollback, safe mode, boot confirmation** are unchanged; the LAN control endpoint exposes confirm/rollback/restart/echo with the same HMAC scheme.

Hotspot portal (`shared/AtechWifiOta`) gains a **Home Wi-Fi** card: scan, choose SSID, enter password, authorize with the OTA code, save; it reports the resulting IP. The AP now runs in AP+STA mode when credentials exist so the user can verify the join from the same page.

## Backend side

- `lib/mdns.js`: dependency-free mDNS querier (PTR/SRV/TXT/A).
- `lib/devices.js`: device registry `.ai-builds/devices.json` (id, suffix, demo, last IP, port, secret), pairing by HMAC echo, probing, control.
- `lib/lan-ota.js`: deployment jobs with phases `preflight, challenge, uploading, finishing, rebooting, verifying, confirming, verified | failed`, 128 KiB chunks over a keep-alive socket, measured transfer time (first chunk request to finish OK), reboot time and verification time reported separately.
- Routes under `/api/devices` and `/api/deployments`, plus `POST /api/builds/:id/deploy`.
- Optional dashboard key (`ATECH_BUILDER_KEY`) enforced automatically when the backend binds a non-loopback host.

## Dashboard

Shared `web-shared/atech-builder.js` owns the device panel, the builder card and the deployment panel. Method priority: Wi-Fi (registered device reachable) > Bluetooth (Web Bluetooth and a connected board) > Hotspot (instructions). A failed transfer is reported and never switched silently; the next method is offered.

## Non-goals

- Signed firmware, Secure Boot, flash encryption, TLS on the board (documented as the next step; `esp_https_server` is present in the pinned libs).
- Cloud relay. Backend authentication beyond the optional key.
