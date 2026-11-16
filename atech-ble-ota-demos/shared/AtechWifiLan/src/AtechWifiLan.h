// AtechWifiLan.h: station-mode Wi-Fi, mDNS and the authenticated LAN OTA
// service shared by both Atech demos. Part of the protected core; generated
// application code never sees this header.
#pragma once

#include <Arduino.h>
#include <IPAddress.h>

// Wi-Fi security methods of the stored profile.
enum : uint8_t { ATECH_WIFI_PERSONAL = 0, ATECH_WIFI_PEAP = 1, ATECH_WIFI_TTLS = 2, ATECH_WIFI_TLS = 3 };
// TTLS phase 2 methods, in the esp_eap_ttls_phase2_types order.
enum : uint8_t { ATECH_TTLS_EAP = 0, ATECH_TTLS_MSCHAPV2 = 1, ATECH_TTLS_MSCHAP = 2, ATECH_TTLS_PAP = 3, ATECH_TTLS_CHAP = 4 };

// The one Wi-Fi network the board joins: personal (passphrase) or enterprise (PEAP, EAP-TTLS,
// EAP-TLS). An enterprise profile always validates the authentication server's certificate, with
// the given CA or the built-in bundle; there is no way to turn that off.
struct AtechWifiProfile {
  String ssid;
  String pass;              // personal passphrase, or the PEAP/TTLS account password
  uint8_t auth = ATECH_WIFI_PERSONAL;
  String identity;          // anonymous (outer) identity; the EAP-TLS identity
  String username;          // PEAP and TTLS
  String ca;                // PEM CA certificate(s); empty when caBundle
  String cert;              // PEM client certificate (EAP-TLS)
  String key;               // PEM private key (EAP-TLS)
  String domain;            // expected server name, optional
  uint8_t phase2 = ATECH_TTLS_MSCHAPV2;
  bool caBundle = false;    // validate the server against the built-in Mozilla bundle
};

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
  // Optional: a JSON object appended to /api/identity as "transport" (the hotspot controller's state).
  String (*transportIdentity)();
  // Optional: board-to-board sync. POST /api/sync (HMAC "atech-sync/1" with the pairing token)
  // hands the form body to syncCommand and answers its JSON; syncIdentity is appended to
  // /api/identity as "sync".
  String (*syncCommand)(const String &form);
  String (*syncIdentity)();
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

  // The stored profile (hotspot page and Bluetooth setup). saveCredentials is the personal-network
  // shortcut; saveProfile validates, stores and connects any method. lastError() explains a false.
  bool hasCredentials() const;
  bool saveCredentials(const String &ssid, const String &password);
  bool saveProfile(const AtechWifiProfile &profile);
  bool forgetCredentials();
  AtechWifiProfile profile() const;   // a copy with the secrets (pass, key) blank
  String configuredSsid() const;
  uint8_t authMethod() const;
  const char *authName() const;       // personal|peap|ttls|tls
  static const char *authName(uint8_t auth);
  static bool parseAuth(const String &text, uint8_t &auth);
  static const char *phase2Name(uint8_t phase2);
  static bool parsePhase2(const String &text, uint8_t &phase2);
  int lastDisconnectReason() const;   // wifi_err_reason_t of the last station disconnect, 0 when none

  // Station state.
  bool isConnected() const;
  bool stationEnabled() const;     // credentials stored and station mode wanted
  IPAddress ip() const;
  int rssi() const;
  String hostname() const;
  String stationMac() const;       // the station interface MAC (for IT device registration)
  // Internet reachability after association: "unknown", "checking", "ok", "captive" (a sign-in page
  // intercepts HTTP) or "offline". Probed on a small task after every connect and on request.
  const char *internetState() const;
  String captiveUrl() const;       // the sign-in page the probe was redirected to, if any
  void recheckInternet();
  uint16_t port() const;
  // Starts the mDNS responder for atech-<suffix>.local if it is not running yet (the hotspot uses it
  // so the board is reachable by name on its own network as well).
  bool ensureMdns();
  String statusJson() const;       // for the portal and the identity endpoint
  String scanJson();
  // The same scan as compact text lines "ssid<TAB>rssi<TAB>open" (strongest first, one per SSID)
  // for the Bluetooth provisioning service, at most maxNetworks entries.
  String scanLines(size_t maxNetworks = 12);               // blocking scan of 2.4 GHz networks

  // Wi-Fi mode arbitration with the hotspot portal: AP + STA when both are
  // wanted, STA only otherwise, off when nothing is wanted.
  void setSoftApActive(bool active);
  // ESP-NOW (AtechSync) needs the Wi-Fi driver started even without credentials: while held,
  // the mode is never OFF (station mode, not connecting).
  void setRadioHold(bool hold);
  bool radioHeld() const;

  // True while an authenticated LAN upload session owns flash.
  bool isTransferring() const;
  bool serviceRunning() const;
  const String &lastError() const;

private:
  struct Impl;
  Impl *_impl;
};
