// Atech Demo 2: gb88/BLEOTA — reference sector-based BLE OTA library.
// Library license: AGPL-3.0; legal review REQUIRED before product use.
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEOTA.h>
#include <Adafruit_NeoPixel.h>
#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif

#define LED_PIN 48 // On some ESP32-S3 boards, the RGB LED uses GPIO38 instead.
Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
BLEOTAClass BLEOTA;
BLEServer *server = nullptr;
volatile bool connected = false;
bool wasConnected = false;

class Callbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; }
  void onDisconnect(BLEServer *) override { connected = false; }
};

void setup() {
  Serial.begin(115200);
  led.begin(); led.clear(); led.show();
  BLEDevice::init("Atech-Library-OTA");
  server = BLEDevice::createServer();
  server->setCallbacks(new Callbacks());
  BLEOTA.begin(server);
  BLEOTA.setModel("Atech-ESP32-S3-N16R8");
#if DEMO_VERSION == 1
  BLEOTA.setFWVersion("demo2-1.0.0");
#else
  BLEOTA.setFWVersion("demo2-2.0.0");
#endif
  BLEOTA.setManufactuer("Atech"); // Existing library's spelling.
  BLEOTA.init();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEOTA.getBLEOTAuuid());
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Atech BLEOTA library demo v%d ready\n", DEMO_VERSION);
}

void loop() {
  BLEOTA.process();
  if (!connected && wasConnected) {
    delay(250);
    server->startAdvertising();
  }
  wasConnected = connected;
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
}
