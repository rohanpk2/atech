// Atech Demo 2: gb88/BLEOTA, the reference sector-based BLE OTA library.
// Library license: AGPL-3.0; legal review REQUIRED before product use.
//
// Application logic lives in src/app/user_app.cpp and runs on its own task
// through the protected Atech core (shared/AtechCore). The gb88 protocol is
// untouched; the core only pauses the app while a transfer owns flash.
#include <Arduino.h>
#include <AtechCore.h>
#include <AtechWifiOta.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEOTA.h>

#include "app/app_build.h"

#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif
#ifndef ATECH_WIFI_AP_PASSWORD
#define ATECH_WIFI_AP_PASSWORD ""
#endif
#ifndef ATECH_WIFI_OTA_TOKEN
#define ATECH_WIFI_OTA_TOKEN ""
#endif

#define ATECH_STR_(value) #value
#define ATECH_STR(value) ATECH_STR_(value)

#define LED_PIN 48 // On some ESP32-S3 boards, the RGB LED uses GPIO38 instead.
constexpr int WIFI_OTA_BUTTON_PIN = 0;  // DevKitC BOOT, sampled only after boot.
constexpr uint32_t WIFI_OTA_BUTTON_HOLD_MS = 3000;
constexpr uint32_t WIFI_OTA_INACTIVITY_MS = 10UL * 60UL * 1000UL;
constexpr uint32_t AUTO_CONFIRM_MS = 20000;
constexpr char WIFI_OTA_IMAGE_IDENTITY[] = "ATECH-OTA-APP-DEMO2";
constexpr char BLE_NAME_PREFIX[] = "Atech-Library-OTA";

// Stock images keep reporting demo2-1.0.0 / demo2-2.0.0; AI builds report
// their backend-assigned version. The app name travels in the identity JSON.
constexpr char FIRMWARE_VERSION[] = "demo2-" ATECH_STR(ATECH_APP_VERSION) ".0.0";
// Embedded so the backend can prove a firmware.bin belongs to its build job.
constexpr char BUILD_MARKER[] = "ATECH-BUILD:" ATECH_BUILD_ID;

BLEOTAClass BLEOTA;
BLEServer *server = nullptr;
AtechWifiOtaPortal wifiOta;
volatile bool connected = false;
volatile bool abortRequested = false;
bool wasConnected = false;
bool wifiUploadWasActive = false;
String bleDeviceName;

bool otherOtaBusy() {
  return connected || BLEOTA.isRunning();
}

bool anyOtaBusy() {
  return BLEOTA.isRunning() || wifiOta.isUpdating();
}

void wifiOtaModeChanged(bool active) {
  if (active) {
    BLEDevice::stopAdvertising();
    Serial.println("BLE advertising paused for exclusive Wi-Fi OTA mode");
  } else if (!connected && server != nullptr) {
    server->startAdvertising();
    Serial.println("BLE advertising restored after Wi-Fi OTA mode");
  }
}

// gb88 declares the BLEOTACallbacks virtuals without defining them anywhere,
// so the base vtable only exists if the sketch defines them (as the library's
// own callback example does). Keep them empty and override in the subclass.
void BLEOTACallbacks::beforeStartOTA() {}
void BLEOTACallbacks::beforeStartSPIFFS() {}
void BLEOTACallbacks::afterStop() {}
void BLEOTACallbacks::afterAbort() {}

// gb88 runs these from BLEOTA.process() on the main loop.
class OtaCallbacks : public BLEOTACallbacks {
  void beforeStartOTA() override {
    atech::coreSuspendApp();
    Serial.println("BLE OTA started; app paused");
  }
  void beforeStartSPIFFS() override { atech::coreSuspendApp(); }
  void afterStop() override { Serial.println("BLE OTA complete; rebooting"); }
  void afterAbort() override {
    atech::coreResumeApp();
    Serial.println("BLE OTA aborted; app resumed");
  }
};
OtaCallbacks otaCallbacks;

class Callbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; }
#if defined(CONFIG_NIMBLE_ENABLED)
  void onConnect(BLEServer *bleServer, ble_gap_conn_desc *description) override {
    bleServer->requestConnParams(description->conn_handle, 0x06, 0x12, 0, 2000);
  }
#elif defined(CONFIG_BLUEDROID_ENABLED)
  void onConnect(BLEServer *bleServer, esp_ble_gatts_cb_param_t *parameters) override {
    bleServer->updateConnParams(parameters->connect.remote_bda, 0x06, 0x12, 0, 2000);
  }
#endif
  void onDisconnect(BLEServer *) override {
    connected = false;
    abortRequested = true;
  }
};

void setup() {
  Serial.begin(115200);

  AtechCoreConfig coreConfig = {};
  coreConfig.demo = 2;
  coreConfig.board = "esp32-s3-devkitc-1";
  coreConfig.variant = "N16R8";
  coreConfig.firmwareInfo = FIRMWARE_VERSION;
  coreConfig.buildId = BUILD_MARKER + sizeof("ATECH-BUILD:") - 1; // id after the marker prefix
  coreConfig.appName = ATECH_APP_NAME;
  coreConfig.appVersion = ATECH_APP_VERSION;
  coreConfig.targetDeviceId = ATECH_TARGET_DEVICE_ID;
  coreConfig.ledPin = LED_PIN;
  coreConfig.autoConfirmMs = AUTO_CONFIRM_MS;
  coreConfig.otaBusy = anyOtaBusy;
  if (!atech::coreBegin(coreConfig)) {
    Serial.println("Atech core initialization failed");
  }

  bleDeviceName = atech::bleName(BLE_NAME_PREFIX);
  BLEDevice::init(bleDeviceName);
  server = BLEDevice::createServer();
  server->setCallbacks(new Callbacks());
  BLEOTA.begin(server);
  BLEOTA.setModel("Atech-ESP32-S3-N16R8");
  BLEOTA.setSerialNumber(atech::deviceId());
  BLEOTA.setFWVersion(FIRMWARE_VERSION);
  BLEOTA.setManufactuer("Atech"); // Existing library's spelling.
  BLEOTA.setCallbacks(&otaCallbacks);
  BLEOTA.init();
  // Identity, control and event characteristics shared with Demo 1.
  atech::coreAttachBle(server);
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEOTA.getBLEOTAuuid());
  adv->setScanResponse(true);

  AtechWifiOtaConfig wifiOtaConfig = {};
  wifiOtaConfig.deviceName = bleDeviceName.c_str();
  wifiOtaConfig.firmwareVersion = FIRMWARE_VERSION;
  wifiOtaConfig.ssidPrefix = "Atech-OTA-D2";
  wifiOtaConfig.imageIdentity = WIFI_OTA_IMAGE_IDENTITY;
  wifiOtaConfig.preferencesNamespace = "atech_ota_d2";
  wifiOtaConfig.apPasswordOverride = ATECH_WIFI_AP_PASSWORD;
  wifiOtaConfig.otaTokenOverride = ATECH_WIFI_OTA_TOKEN;
  wifiOtaConfig.buttonPin = WIFI_OTA_BUTTON_PIN;
  wifiOtaConfig.buttonActiveLow = true;
  wifiOtaConfig.buttonHoldMs = WIFI_OTA_BUTTON_HOLD_MS;
  wifiOtaConfig.inactivityTimeoutMs = WIFI_OTA_INACTIVITY_MS;
  wifiOtaConfig.rebootDelayMs = 2200;
  wifiOtaConfig.otherOtaBusy = otherOtaBusy;
  wifiOtaConfig.modeChanged = wifiOtaModeChanged;
  if (!wifiOta.begin(wifiOtaConfig)) {
    Serial.printf("Wi-Fi OTA initialization failed: %s\n",
                  wifiOta.lastError().c_str());
  }
  if (!wifiOta.isActive()) BLEDevice::startAdvertising();
  Serial.printf("Atech BLEOTA library demo ready: %s (%s)\n", FIRMWARE_VERSION, BUILD_MARKER);
}

void loop() {
  // Always service the runtime BOOT-button detector and an active local portal.
  wifiOta.loop();
  // The app pauses only while a Wi-Fi upload is actually streaming into flash.
  const bool wifiUploading = wifiOta.isUpdating();
  if (wifiUploading && !wifiUploadWasActive) atech::coreSuspendApp();
  if (!wifiUploading && wifiUploadWasActive && !BLEOTA.isRunning()) atech::coreResumeApp();
  wifiUploadWasActive = wifiUploading;
  atech::coreLoop();

  if (abortRequested) {
    abortRequested = false;
    if (BLEOTA.isRunning()) {
      BLEOTA.abort();
      atech::coreResumeApp();
      Serial.println("BLE OTA aborted after disconnect");
    }
  }

  // The shared portal owns the inactive partition while Wi-Fi mode is active.
  // Keep gb88's protocol untouched, but do not service or re-advertise it until
  // Wi-Fi exits. A connected/running BLE session prevents Wi-Fi from starting.
  if (!wifiOta.isActive()) {
    BLEOTA.process();
    if (!connected && wasConnected) {
      delay(250);
      server->startAdvertising();
    }
  }
  wasConnected = connected;
  delay(BLEOTA.isRunning() ? 1 : 20);
}
