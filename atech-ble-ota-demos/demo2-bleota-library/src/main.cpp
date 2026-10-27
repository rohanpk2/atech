// Atech Demo 2: gb88/BLEOTA — reference sector-based BLE OTA library.
// Library license: AGPL-3.0; legal review REQUIRED before product use.
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEOTA.h>
#include <Adafruit_NeoPixel.h>
#include <AtechWifiOta.h>
#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif
#ifndef ATECH_WIFI_AP_PASSWORD
#define ATECH_WIFI_AP_PASSWORD ""
#endif
#ifndef ATECH_WIFI_OTA_TOKEN
#define ATECH_WIFI_OTA_TOKEN ""
#endif

#define LED_PIN 48 // On some ESP32-S3 boards, the RGB LED uses GPIO38 instead.
constexpr int WIFI_OTA_BUTTON_PIN = 0;  // DevKitC BOOT, sampled only after boot.
constexpr uint32_t WIFI_OTA_BUTTON_HOLD_MS = 3000;
constexpr uint32_t WIFI_OTA_INACTIVITY_MS = 10UL * 60UL * 1000UL;
constexpr char WIFI_OTA_IMAGE_IDENTITY[] = "ATECH-OTA-APP-DEMO2";

#if DEMO_VERSION == 1
constexpr char FIRMWARE_VERSION[] = "demo2-1.0.0";
#else
constexpr char FIRMWARE_VERSION[] = "demo2-2.0.0";
#endif

Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
BLEOTAClass BLEOTA;
BLEServer *server = nullptr;
AtechWifiOtaPortal wifiOta;
volatile bool connected = false;
volatile bool abortRequested = false;
bool wasConnected = false;

bool otherOtaBusy() {
  return connected || BLEOTA.isRunning();
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
  led.begin(); led.clear(); led.show();
  BLEDevice::init("Atech-Library-OTA");
  server = BLEDevice::createServer();
  server->setCallbacks(new Callbacks());
  BLEOTA.begin(server);
  BLEOTA.setModel("Atech-ESP32-S3-N16R8");
  BLEOTA.setFWVersion(FIRMWARE_VERSION);
  BLEOTA.setManufactuer("Atech"); // Existing library's spelling.
  BLEOTA.init();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEOTA.getBLEOTAuuid());
  adv->setScanResponse(true);

  const AtechWifiOtaConfig wifiOtaConfig = {
    .deviceName = "Atech-Library-OTA",
    .firmwareVersion = FIRMWARE_VERSION,
    .ssidPrefix = "Atech-OTA-D2",
    .imageIdentity = WIFI_OTA_IMAGE_IDENTITY,
    .preferencesNamespace = "atech_ota_d2",
    .apPasswordOverride = ATECH_WIFI_AP_PASSWORD,
    .otaTokenOverride = ATECH_WIFI_OTA_TOKEN,
    .buttonPin = WIFI_OTA_BUTTON_PIN,
    .buttonActiveLow = true,
    .buttonHoldMs = WIFI_OTA_BUTTON_HOLD_MS,
    .inactivityTimeoutMs = WIFI_OTA_INACTIVITY_MS,
    .rebootDelayMs = 2200,
    .otherOtaBusy = otherOtaBusy,
    .modeChanged = wifiOtaModeChanged,
  };
  if (!wifiOta.begin(wifiOtaConfig)) {
    Serial.printf("Wi-Fi OTA initialization failed: %s\n",
                  wifiOta.lastError().c_str());
  }
  if (!wifiOta.isActive()) BLEDevice::startAdvertising();
  Serial.printf("Atech BLEOTA library demo v%d ready\n", DEMO_VERSION);
}

void loop() {
  // Always service the runtime BOOT-button detector and an active local portal.
  wifiOta.loop();

  if (abortRequested) {
    abortRequested = false;
    if (BLEOTA.isRunning()) {
      BLEOTA.abort();
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
  if (!BLEOTA.isRunning()) {
#if DEMO_VERSION == 1
    const uint32_t color = led.Color(0,0,40);
    const uint32_t interval = 1200;
#else
    const uint32_t color = led.Color(0,40,0);
    const uint32_t interval = 350;
#endif
    led.setPixelColor(0, (millis()%interval < interval/2) ? color : 0);
    led.show();
    delay(20);
  } else {
    delay(1);
  }
}
