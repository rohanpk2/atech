// AtechWifiOta.h: the board's own hotspot (ATECH-<suffix>) and its update page, shared by both
// Atech demos. The page uploads the signed .atech package the dashboard produced, behind the
// per-device OTA authorization code; the image is installed through atech::ImageSink (the same
// engine the cloud agent and the LAN service use), so the signature, the digest, the markers and
// the version policy are checked once, in one place. The portal also sets up Wi-Fi and the cloud
// server and can pin the firmware signing key. Part of the protected core.
#pragma once

#include <Arduino.h>

class AtechWifiLan;
class AtechCloudOta;

struct AtechWifiOtaConfig {
  const char *deviceName;
  const char *firmwareVersion;
  uint8_t demo;                 // 1 or 2: a package for the other demo is refused before the upload
  const char *ssidPrefix;       // "ATECH" -> ATECH-<six hex MAC digits>
  const char *hostnamePrefix;   // "atech" -> atech-<suffix>.local, answered on the hotspot too
  // A short marker compiled into every valid image for this demo (for example,
  // "ATECH-OTA-APP-DEMO1"). It prevents accidentally crossing the two demo bins.
  const char *imageIdentity;
  const char *preferencesNamespace;
  const char *apPasswordOverride;
  const char *otaTokenOverride;
  int buttonPin;
  bool buttonActiveLow;
  uint32_t buttonHoldMs;
  uint32_t inactivityTimeoutMs;
  uint32_t rebootDelayMs;
  bool (*otherOtaBusy)();
  void (*modeChanged)(bool active);
  // Optional: called once when BOOT is released before buttonHoldMs (a short press). The
  // Bluetooth provisioning service uses it as the physical-presence unlock of an owned board.
  void (*shortPress)();
  // Optional station-mode manager. When set, the portal gains the home Wi-Fi
  // provisioning card and runs the hotspot in AP+STA mode so the user can
  // watch the join succeed from the same page.
  AtechWifiLan *lan;
  // Optional cloud OTA agent. When set, the portal gains the Cloud card (server URL and
  // agent status) behind the same authorization code.
  AtechCloudOta *cloud;
  // Transport controller. With autoStart the hotspot comes up by itself when the board has no Wi-Fi
  // profile, or when the cloud agent is enabled but has had no session for offlineGraceMs (offline,
  // captive network, no internet), and goes away onlineGraceMs after the cloud session is back, never
  // during an upload, while the sign-in helper runs, or while a client used the page in the last two
  // minutes. A hotspot started by holding BOOT is left to the inactivity timeout.
  bool autoStart;
  uint32_t offlineGraceMs;      // default 90000
  uint32_t onlineGraceMs;       // default 60000
};

class AtechWifiOtaPortal {
public:
  AtechWifiOtaPortal();
  ~AtechWifiOtaPortal();

  AtechWifiOtaPortal(const AtechWifiOtaPortal &) = delete;
  AtechWifiOtaPortal &operator=(const AtechWifiOtaPortal &) = delete;

  // Initializes the runtime BOOT-button detector and persistent credentials.
  // A one-shot successful-update marker automatically restores the AP after reboot.
  bool begin(const AtechWifiOtaConfig &config);
  void loop();

  bool start();
  bool stop();
  bool isActive() const;
  bool isUpdating() const;
  const String &ssid() const;
  String hostname() const;
  const String &lastError() const;
  // The per-device OTA authorization code; shared with the LAN service and the cloud agent as
  // the HMAC secret. Never exposed by any HTTP endpoint.
  const String &otaToken() const;
  // The hotspot's WPA2 password. Reported to the owner's backend once per cloud login (TLS,
  // device-authenticated) so the dashboard can show it for a local update; never over HTTP.
  const String &apPassword() const;
  // "ap_ssid=...&ap_pass=..." for the cloud login body (AtechCloudOtaConfig::extraLogin).
  String hotspotReport() const;
  // The transport an update would take right now: "cloud" (session up), "hotspot" (the page is up and
  // the cloud is not) or "none"; the reason: online|no_wifi|no_cloud_url|captive|offline|manual.
  const char *transport() const;
  const char *transportReason() const;
  String transportJson() const;     // {"transport","reason","hotspot","ssid","hostname","helper"}
  String transportReport() const;   // transport=..&reason=..&hotspot=1|0 for the cloud poll

private:
  struct Impl;
  Impl *_impl;
};
