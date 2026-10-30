// AtechCloudOta.h: the cloud OTA agent shared by both Atech demos. The board
// makes outbound HTTPS requests to the builder backend: it logs in with an HMAC
// proof of its pairing token, polls for a deployment job, downloads the image
// in ranged chunks over one kept-alive TLS connection, writes it to the
// inactive OTA slot, reboots, and confirms the boot only after the backend has
// acknowledged that the expected build is running. Part of the protected core;
// generated application code never sees this header.
#pragma once

#include <Arduino.h>

struct AtechCloudOtaConfig {
  uint8_t demo;                       // 1 or 2
  const char *imageIdentity;          // marker every valid image for this demo carries
  const char *preferencesNamespace;   // NVS namespace ("atech_cloud")
  const char *firmwareVersion;        // human-readable firmware string
  const char *appName;                // running app name (reported to the backend)
  uint16_t appVersion;                // running app version
  const char *defaultUrl;             // compiled-in server origin (ATECH_CLOUD_URL), may be empty
  bool allowInsecureHttp;             // accept http:// URLs (lab builds only; ATECH_CLOUD_ALLOW_HTTP)
  uint32_t pollIntervalMs;            // default 15000; the backend may adjust it per answer
  uint32_t confirmTimeoutMs;          // uptime without an acknowledgment after which a pending cloud image rolls back (180000)
  uint32_t chunkBytes;                // ranged download chunk (131072)
  // Per-device secret shared with the backend (the hotspot portal's OTA authorization code).
  String (*authToken)();
  // True while another transport (BLE OTA, hotspot upload, LAN upload) owns flash.
  bool (*otherOtaBusy)();
  // True while the station interface has an IP address.
  bool (*wifiConnected)();
};

class AtechCloudOta {
public:
  AtechCloudOta();
  ~AtechCloudOta();
  AtechCloudOta(const AtechCloudOta &) = delete;
  AtechCloudOta &operator=(const AtechCloudOta &) = delete;

  // Reads the stored server URL and boot marker, starts the agent task.
  bool begin(const AtechCloudOtaConfig &config);
  // Main-loop bookkeeping (nothing heavy; the agent runs on its own task).
  void loop();

  bool isEnabled() const;         // a server URL is configured
  bool isTransferring() const;    // a job owns flash right now
  bool holdsConfirm() const;      // a cloud-deployed image awaits the backend's acknowledgment

  // Server URL: the hotspot portal stores one in NVS; otherwise the compiled-in default.
  String serverUrl() const;
  bool hasStoredUrl() const;
  bool setServerUrl(const String &url);
  bool clearServerUrl();

  String statusJson() const;      // for the hotspot portal and the LAN identity
  String lastError() const;       // a copy: safe from any task
  const char *stateName() const;

private:
  struct Impl;
  Impl *_impl;
};
