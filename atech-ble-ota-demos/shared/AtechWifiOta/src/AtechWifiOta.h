#pragma once

#include <Arduino.h>

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

private:
  struct Impl;
  Impl *_impl;
};
