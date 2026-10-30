// AtechCore.h: protected firmware core shared by both Atech demos.
// Never regenerated. See AtechApp.h for the contract generated code uses.
#pragma once

#include <Arduino.h>
#include <BLEServer.h>

struct AtechCoreConfig {
  uint8_t demo;                 // 1 (custom GATT) or 2 (gb88 BLEOTA)
  const char *board;            // "esp32-s3-devkitc-1"
  const char *variant;          // "N16R8"
  const char *firmwareInfo;     // demo-specific firmware string
  const char *buildId;          // "stock" or the backend job build id
  const char *appName;          // human-readable generated app name
  uint16_t appVersion;          // monotonically increasing app version
  const char *targetDeviceId;   // device the build was made for ("" = any)
  int ledPin;                   // onboard NeoPixel pin (48)
  uint32_t autoConfirmMs;       // uptime after which a pending image is confirmed
  bool (*otaBusy)();            // true while any OTA transport owns flash
  // Optional: true while another verifier (the cloud OTA agent waiting for the backend's
  // acknowledgment) must decide about the pending image instead of the uptime rule.
  bool (*holdAutoConfirm)();
};

namespace atech {

// Identity
const char *deviceId();          // "ATECH-" + 12 uppercase hex MAC digits
const char *pairingSuffix();     // last three MAC bytes, 6 uppercase hex digits
const char *buildId();           // the running image's build id ("stock" or a backend job id)
const char *coreVersion();       // ATECH_CORE_VERSION
String bleName(const char *prefix);

// Lifecycle (called from each demo's main.cpp)
bool coreBegin(const AtechCoreConfig &config);
void coreAttachBle(BLEServer *server);
void coreLoop();
void coreSuspendApp();
void coreResumeApp();
bool coreAppRunning();

// LED arbitration between dashboard commands and the generated app
enum class LedOwner : uint8_t { Off = 0, BlinkBlue = 1, BlinkGreen = 2, App = 3 };
void setLedOwner(LedOwner owner);
LedOwner ledOwner();

// Flash ownership shared by every OTA transport (BLE, hotspot portal, LAN).
// Only one writer may hold it; the owner label is reported in identity JSON.
bool coreTryAcquireOta(const char *owner);
void coreReleaseOta(const char *owner);
const char *coreOtaOwner();   // "" when free

// Identity, verification and recovery
String identityJson();
bool confirmBoot();
bool rollbackToPrevious();
bool rollbackPending();
bool canRollback();
bool safeMode();
uint32_t crashCount();
uint32_t appLoops();

}  // namespace atech
