
#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#define LED_PIN 48

Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);

volatile bool blinking = false;

#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

class LEDCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    auto command = characteristic->getValue();

    if (command == "1") {
      blinking = true;
    }

    if (command == "0") {
      blinking = false;
    }
  }
};

void setup() {
  Serial.begin(115200);

  led.begin();
  led.clear();
  led.show();

  BLEDevice::init("ESP32-BLINK");

  BLEServer *server = BLEDevice::createServer();

  BLEService *service = server->createService(SERVICE_UUID);

  BLECharacteristic *characteristic =
    service->createCharacteristic(
      CHAR_UUID,
      BLECharacteristic::PROPERTY_READ |
      BLECharacteristic::PROPERTY_WRITE
    );

  characteristic->setCallbacks(new LEDCallbacks());
  characteristic->setValue("0");

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->start();

  Serial.println("Bluetooth ready!");
}

void loop() {
  if (blinking) {
    led.setPixelColor(0, led.Color(0, 0, 50));
    led.show();
    delay(300);

    led.clear();
    led.show();
    delay(300);
  } else {
    led.clear();
    led.show();
    delay(100);
  }
}
