// AtechWifiLan.h: station-mode Wi-Fi, mDNS and the authenticated LAN OTA
// service shared by both Atech demos. Part of the protected core; generated
// application code never sees this header.
#pragma once

#include <Arduino.h>
#include <IPAddress.h>

struct AtechWifiLanConfig {
  uint8_t demo;                       // 1 or 2
  const char *imageIdentity;          // marker every valid image for this demo carries
  const char *preferencesNamespace;   // NVS namespace for the Wi-Fi credentials
  const char *firmwareVersion;        // human-readable firmware string for mDNS/identity
  const char *hostnamePrefix;         // "atech" -> atech-<suffix>.local
  uint16_t port;                      // LAN service port (default 8080)
  uint32_t rebootDelayMs;             // delay after a verified image before restart
  uint32_t sessionTimeoutMs;          // idle time after which an upload session is aborted
  uint32_t reconnectIntervalMs;       // station reconnect watchdog
  // Per-device secret shared with the backend (the hotspot portal's OTA
  // authorization code). Evaluated per request so the portal can own it.
  String (*authToken)();
  // True while another transport (BLE OTA, hotspot upload) owns flash.
  bool (*otherOtaBusy)();
  // Optional: a JSON object appended to /api/identity as "cloud" (the cloud OTA agent's status).
  String (*extraIdentity)();
};

class AtechWifiLan {
public:
  AtechWifiLan();
  ~AtechWifiLan();
  AtechWifiLan(const AtechWifiLan &) = delete;
  AtechWifiLan &operator=(const AtechWifiLan &) = delete;

  // Loads stored credentials, connects when present and starts the service.
  bool begin(const AtechWifiLanConfig &config);
  // Services reconnects, session timeouts and the post-update restart.
  void loop();

  // Credentials (used by the hotspot provisioning page).
  bool hasCredentials() const;
  bool saveCredentials(const String &ssid, const String &password);
  bool forgetCredentials();
  String configuredSsid() const;

  // Station state.
  bool isConnected() const;
  bool stationEnabled() const;     // credentials stored and station mode wanted
  IPAddress ip() const;
  int rssi() const;
  String hostname() const;
  uint16_t port() const;
  String statusJson() const;       // for the portal and the identity endpoint
  String scanJson();               // blocking scan of 2.4 GHz networks

  // Wi-Fi mode arbitration with the hotspot portal: AP + STA when both are
  // wanted, STA only otherwise, off when nothing is wanted.
  void setSoftApActive(bool active);

  // True while an authenticated LAN upload session owns flash.
  bool isTransferring() const;
  bool serviceRunning() const;
  const String &lastError() const;

private:
  struct Impl;
  Impl *_impl;
};
