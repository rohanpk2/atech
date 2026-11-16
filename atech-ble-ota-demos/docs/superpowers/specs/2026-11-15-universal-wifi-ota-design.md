# Universal Wi-Fi OTA: design record (2026-11-15)

The brief ("Atech ESP32-S3: Universal Wi-Fi OTA System") is the specification. This document records
what the audit found in the repository, which parts of the brief already exist, and the decisions the
brief leaves to the implementer. The plan in `docs/superpowers/plans/2026-11-15-universal-wifi-ota.md`
argues from both.

## 1. Audit of the existing implementation

Toolchain: PlatformIO `espressif32 @ 8.0.0`, Arduino-ESP32 **3.3.12** on ESP-IDF **5.5.5**
(`framework-arduinoespressif32-esp32s3-libs`, variant `qio_opi`). Relevant sdkconfig facts of the
precompiled libraries (they cannot be changed from this project): `CONFIG_LWIP_IPV4_NAPT=y`,
`CONFIG_LWIP_IP_FORWARD=y`, `CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT=y`, `CONFIG_MBEDTLS_ECDSA_C=y`,
`CONFIG_MBEDTLS_ECP_DP_SECP256R1_ENABLED=y`, `CONFIG_MBEDTLS_PEM_PARSE_C=y`,
`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y`, `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`,
`CONFIG_LWIP_DHCPS_ADD_DNS=y`, `CONFIG_SECURE_BOOT_V2_PREFERRED=y` (Secure Boot itself is not enabled;
it would need eFuse programming and is out of scope).

Partition table (both demos): `nvs 0x5000`, `otadata 0x2000`, `ota_0` and `ota_1` of 6 MiB each,
`spiffs`. Dual-slot OTA with bootloader rollback (`verifyRollbackLater()` returns true;
`esp_ota_mark_app_valid_cancel_rollback` after the app has run). Images are 1.85 to 1.87 MB.

| Brief section | Already in the repository | Missing |
| --- | --- | --- |
| Method A, cloud pull | `shared/AtechCloudOta`: own task, HTTPS with the Mozilla bundle, HMAC login with the per-device pairing token, bearer session, 15 s poll, 128 KiB ranged download over one kept-alive TLS connection, inactive-slot install through `atech::ImageSink`, boot marker, backend acknowledgment, confirm after the app ran, rollback after 3 min without acknowledgment, 5 download attempts. Backend `builder/lib/cloud-*.js`: jobs, device API `/api/device/*`, ownership, timeouts. Dashboard: Cloud Wi-Fi card with every state. | Firmware **signing** (only SHA-256 + HMAC today), **downgrade prevention**, the hotspot credentials never reach the owner, no notion of "internet reachable". |
| Method B, hotspot | `shared/AtechWifiOta`: WPA2 SoftAP `Atech-OTA-D1-<suffix>` with a random NVS password, catch-all DNS, token-gated portal at `http://192.168.4.1`, multipart upload with CRC32 and SHA-256, ESP header checks, `esp_ota_end` before activation, post-reboot verification page, 10 min inactivity timeout, manual start by holding BOOT 3 s. | SSID `ATECH-XXXX`, **its own flash writer** (duplicates `ImageSink`), no signature, the user must type the OTA code and pick a raw `firmware.bin`, no discoverable hostname on the hotspot, no dashboard flow that prepares the file before the network switch, hotspot never starts by itself when the board is offline. |
| Universal Wi-Fi | `shared/AtechWifiLan`: WPA/WPA2/WPA3-Personal with SSID and password in NVS, auto-reconnect, mDNS, scan. Provisioned over BLE (`AtechBleProv`, ECDH + AES-GCM, owner grant) or the hotspot page. | **Enterprise** (PEAP, TTLS, EAP-TLS, CA validation), **captive portal detection**, scan classification, any sign-in assistance. |
| Transport selection | Flash lock `coreTryAcquireOta` shared by BLE, LAN, hotspot and cloud; the dashboard picks Wi-Fi then Bluetooth then hotspot. | A controller that knows whether the cloud is reachable and starts the hotspot when it is not; the dashboard offers Bluetooth as a firmware transport. |
| Dashboard | Three-step page, claim/pair, Cloud Wi-Fi deploy with phases, Wi-Fi setup over Bluetooth. | "Device offline: local Wi-Fi update available" flow, hotspot credentials, enterprise fields, captive copy, downgrade confirmation. |
| Rollback, health | Pending-verify image, crash counter, safe mode, confirm only after `appLoop()` ran, backend-acknowledged confirm for cloud images. | Nothing (reused as is). |

Verified facts: `cd builder && npm test` and every `shared/*/*.test.js` pass on `main` before this
work. No ESP32-S3 is attached to this machine (`/dev/cu.usbmodem*` is empty), so nothing in this
work is a hardware result.

## 2. Decisions

### D1. Firmware signing: ECDSA P-256 over a signed manifest, one verifier for every path

- The backend owns one P-256 key pair (`<buildsDir>/signing/firmware-signing.pem`, mode 0600,
  generated on first start; `ATECH_SIGNING_KEY_FILE` overrides). The public key travels as the
  65-byte uncompressed point in hex (130 characters); `kid` is the first 8 hex of its SHA-256.
- Signed statement (canonical string, both sides build it byte for byte):
  `atech-fw/1\n<build id>\n<demo>\n<size>\n<sha256 lowercase hex>\n<version>\n<downgrade 0|1>\n<target device id or empty>\n`.
  Signature: ECDSA P-256 over SHA-256 of that string, raw `r||s`, 128 hex characters. It binds the
  image bytes (through the digest the sink verifies), the build, the demo, the app version, the
  downgrade authorization and the board the deployment is for. It is produced at deployment time,
  so a manifest for board A cannot be replayed to board B.
- The board verifies in `atech::ImageSink::finish()` after the digest check and before
  `esp_ota_set_boot_partition`, with `mbedtls_ecdsa_verify`. The hotspot portal and the LAN
  service migrate to `ImageSink`, so cloud, LAN and hotspot share one installation engine.
- Public key on the board: compiled in (`-DATECH_FW_PUBKEY="<hex>"`, baked by the backend into
  generated images and the installer's base build) or pinned in NVS (`atech_fw/pubkey`). Pinning
  happens only over an authenticated channel: the cloud login answer (TLS to the owner-provisioned
  server), a LAN `begin` (HMAC with the pairing token), a hotspot upload (OTA authorization code)
  or a Bluetooth provision (unlocked board, owner grant or BOOT press). A pinned key is never
  replaced by a different one except through the hotspot or Bluetooth setup paths with the same
  authorization. With a key known, unsigned images are refused everywhere; without any key, images
  are refused unless the lab flag `-DATECH_ALLOW_UNSIGNED=1` is set (prints a warning at boot).
- Downgrade prevention: the board stores the highest app version it has confirmed (`atech_fw/ver`)
  and refuses a lower `version` unless the signed manifest says `downgrade=1`. The dashboard sets
  that flag only after the user confirms a downgrade; the backend signs it per deployment. A
  bootloader rollback is not a downgrade (nothing is recorded for an image that never confirmed).
- Every image embeds `ATECH-FWSIGN:1`; the backend requires it next to the agent and provisioning
  markers before a cloud or LAN deployment.

### D2. Direct Wi-Fi hotspot OTA

- SSID `ATECH-<six hex of the MAC>` (both demos), WPA2 with the existing per-device random
  password. The owner learns the password from the dashboard: the board reports `ap_ssid` and
  `ap_pass` once per cloud login (TLS, device-authenticated), the backend stores them in
  `devices.json` (0600) and shows them only to the board's owner. The Bluetooth setup session
  returns them too (`hotspot=1` in a provision request).
- One file: the signed update package `atech-demo<d>-<build>.atech` =
  `"ATECHPKG1\n"` + 4-byte little-endian JSON length + JSON header
  (`v, build, demo, size, sha256, ver, downgrade, target, sig, kid, pub, app, created`) + the
  firmware bytes. The dashboard downloads it from `GET /api/builds/:id/package?deviceId=..` before
  the user leaves their network. The board's page reads the header in the browser and uploads the
  firmware bytes with the manifest in request headers (`X-Atech-Build`, `X-Atech-Version`,
  `X-Atech-Downgrade`, `X-Atech-Target`, `X-Atech-SHA256`, `X-Atech-Sig`, `X-Atech-Key`, plus
  `X-Atech-OTA-Key`). A raw `.bin` is still accepted by the form but is refused by the sink once a
  key is known.
- Discovery without an IP: captive-portal probes (`/hotspot-detect.html`, `/generate_204`,
  catch-all DNS) make macOS, iOS and Android open the page by themselves on joining; the board also
  answers `atech-<suffix>.local` over mDNS on the hotspot. `http://192.168.4.1` remains the fallback.
- The portal keeps the OTA authorization code gate; the dashboard shows the code to the owner next
  to the hotspot password (both are the board's secrets held by the owner's backend).

### D3. Enterprise Wi-Fi

- One stored profile (`atech_wifi`): `ssid`, `pass`, `auth` (0 personal, 1 PEAP, 2 TTLS, 3 TLS),
  `ident` (anonymous identity), `user`, `ca` (PEM blob), `crt`, `key`, `ph2` (TTLS phase 2:
  `ESP_EAP_TTLS_PHASE2_EAP|MSCHAPV2|MSCHAP|PAP|CHAP`), `domain` (expected server name), `cabund`
  (use the built-in Mozilla bundle). An enterprise profile is refused unless it carries a CA PEM or
  `cabund=1`; the server certificate is always validated (`esp_eap_client_set_ca_cert` or
  `esp_eap_client_use_default_cert_bundle(true)`, plus `esp_eap_client_set_domain_name` when a
  domain is given). The certificate validity window is not checked before the first time sync
  (`esp_eap_client_set_disable_time_check(true)`): the board has no clock before it is on a
  network. SNTP starts once the station has an address.
- Scan results carry the security class (`open`, `personal`, `enterprise`) from the access point's
  auth mode; the dashboard and the portal preselect the method and let the user override it.
- The Bluetooth setup message limit rises from 1024 to 6144 bytes so a CA chain and a client
  certificate fit; the frame size (240) and the session crypto are unchanged.

### D4. Captive portals

- After every station connect the board probes `http://connectivitycheck.gstatic.com/generate_204`
  (fallback `http://captive.apple.com/hotspot-detect.html`) from a small task: 204 (or the Apple
  "Success" body) means `ok`; a redirect or another body means `captive` and the redirect target is
  kept as `captive_url`; a failure means `offline`. The cloud agent reports `captive` instead of
  silently failing TLS, and the dashboards say "This network needs a sign-in".
- Sign-in helper (SoftAP + STA with NAT): on the hotspot page, "Sign in to the network" enables
  `esp_netif_napt_enable` on the AP interface, hands out the upstream DNS instead of the catch-all,
  and opens the portal's own captured URL (or `http://neverssl.com/`). The user's laptop browses
  through the board, the campus portal sees the board's station MAC, and after the sign-in the
  connectivity check passes and the helper turns itself off. This works for MAC-keyed portals only;
  the page also shows the board's station MAC for IT device registration, and the direct hotspot
  update stays available.

### D5. Transport selection

- The hotspot portal becomes the controller: with `autoStart` it starts the hotspot (AP+STA, the
  station keeps retrying) when the board has no Wi-Fi profile, or when the cloud agent is enabled
  but has had no session for 90 s (offline, captive or no internet). It stops the hotspot 60 s after
  the cloud session is back, never during an upload or while a client talked to it in the last two
  minutes. Holding BOOT 3 s still toggles it by hand, and a manual start is kept until the 10 min
  inactivity timeout. `transportJson()` (`cloud|hotspot|none` and a reason) is part of the LAN
  identity, the Bluetooth status and every cloud poll, so the dashboard knows which path to offer.
- The dashboard's deployment methods are Cloud Wi-Fi (or Wi-Fi on the LAN) and Local Wi-Fi
  (hotspot). Bluetooth is no longer a firmware transport in the shared panel; the demos' Advanced
  cards keep their original Bluetooth protocol demos, labelled as such. USB stays the recovery path.

### D6. Dashboard offline flow

Badge "Device offline: local Wi-Fi update available" (the structure test forbids em dashes in the
module, hence the colon). Steps: prepare the update (download the package), join `ATECH-XXXX` with
the shown password, open the board's page (link to `http://atech-<suffix>.local/` and
`http://192.168.4.1/`), upload the package there and watch its progress, come back to the normal
network; the dashboard then watches the board's next cloud report and shows "Update complete" when
it carries the new build id.

## 3. Out of scope, named

Secure Boot V2 and flash encryption (eFuse operations), TLS on the LAN service, per-user accounts,
WPA3-Enterprise 192-bit suite B, EAP-FAST, portals that require a browser certificate or a
per-session web token on the client itself, and any hardware result (no board attached).
