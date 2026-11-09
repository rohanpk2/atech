// AtechBleProv.h: one-time Wi-Fi onboarding over the dashboard's Bluetooth connection, shared
// by both Atech demos. A GATT service (a7ec0200) carries fragmented request/reply frames; an
// ephemeral ECDH P-256 exchange (HKDF-SHA256, AES-256-GCM) protects the Wi-Fi password, the cloud
// server URL and the board's pairing token; once the board has an owner (its cloud agent logged
// in), changes need the owner's grant (an HMAC with the pairing token, bound to this session) or
// a short press of the BOOT button. Part of the protected core; generated application code never
// sees this header. The byte layout is shared with web-shared/atech-provision.js and
// builder/lib/fake-prov-board.js; keep the three identical.
#pragma once

#include <Arduino.h>

class BLEServer;
class AtechWifiLan;
class AtechCloudOta;
class AtechSync;

struct AtechBleProvConfig {
  BLEServer *server;                  // the demo's GATT server (service created in begin)
  AtechWifiLan *lan;                  // station-mode Wi-Fi (credentials, scan, status)
  AtechCloudOta *cloud;               // cloud agent (server URL, login state)
  AtechSync *sync;                    // optional: board-to-board sync (pairing codes, state, events) over the same sealed session
  String (*authToken)();              // the pairing token (OTA authorization code); released only to an authorized client
  bool (*busy)();                     // true while any OTA transport owns flash: changes are refused
  uint32_t unlockWindowMs;            // how long a BOOT press unlocks an owned board (120000)
  const char *preferencesNamespace;   // NVS namespace for the lock ("atech_prov")
};

class AtechBleProv {
public:
  AtechBleProv();
  ~AtechBleProv();
  AtechBleProv(const AtechBleProv &) = delete;
  AtechBleProv &operator=(const AtechBleProv &) = delete;

  // Creates the GATT service on the given server and loads the lock state. Call after the
  // identity service is attached and before advertising starts.
  bool begin(const AtechBleProvConfig &config);
  // Services queued requests on the main loop (crypto, Wi-Fi scan and credential changes run here).
  void loop();
  // A short BOOT press: opens the physical-presence window on an owned board.
  void noteButtonPress();
  bool isLocked() const;
  bool unlockWindowOpen() const;
  // The status characteristic's JSON (no secrets): lock, Wi-Fi and cloud state.
  String statusJson();
  const String &lastError() const;

  // Implementation detail, public only so the GATT callback classes can reach it.
  struct Impl;

private:
  Impl *_impl;
};
