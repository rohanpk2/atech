#pragma once

#include <Arduino.h>

class AtechWifiLan;
class AtechCloudOta;

struct AtechWifiOtaConfig {
  const char *deviceName;
  const char *firmwareVersion;
  const char *ssidPrefix;
  // A short marker compiled into every valid image for this demo (for example,
  // "ATECH-APP-DEMO1"). It prevents accidentally crossing the two demo bins.
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
  // Optional station-mode manager. When set, the portal gains the home Wi-Fi
  // provisioning card and runs the hotspot in AP+STA mode so the user can
  // watch the join succeed from the same page.
  AtechWifiLan *lan;
  // Optional cloud OTA agent. When set, the portal gains the Cloud card (server URL and
  // agent status) behind the same authorization code.
  AtechCloudOta *cloud;
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
  const String &lastError() const;
  // The per-device OTA authorization code; shared with the LAN service as
  // the HMAC secret. Never exposed by any HTTP endpoint.
  const String &otaToken() const;

private:
  struct Impl;
  Impl *_impl;
};
