// Atech Demo 1: Web Bluetooth -> custom GATT OTA -> inactive flash partition.
// Prototype ONLY: CRC32 guards against accidental corruption, NOT malicious firmware.
// For shipping boards: require authenticated access + firmware signature verification.
#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <Update.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif

#define LED_PIN 48 // Change to 38 if your board's RGB LED uses GPIO38.
#define SERVICE_UUID "a7ec0001-2e47-4dd2-82a4-9c2cf6eaa001"
#define CONTROL_UUID "a7ec0002-2e47-4dd2-82a4-9c2cf6eaa001"
#define DATA_UUID    "a7ec0003-2e47-4dd2-82a4-9c2cf6eaa001"
#define STATUS_UUID  "a7ec0004-2e47-4dd2-82a4-9c2cf6eaa001"
#define INFO_UUID    "a7ec0005-2e47-4dd2-82a4-9c2cf6eaa001"

constexpr uint16_t ESP32_S3_CHIP_ID = 9;
constexpr uint32_t OTA_IDLE_TIMEOUT_MS = 30000;

// Browser sends one packet, waits for a flash-level ACK, then sends the next.
// 244 is an upper bound; the browser automatically tries smaller BLE chunks.
struct Frame {
  bool control;
  uint16_t length;
  uint8_t bytes[244];
};
QueueHandle_t incoming;
BLECharacteristic *statusCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
volatile bool disconnectPending = false;
bool previouslyConnected = false;

Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
bool updating = false;
uint32_t expectedSize = 0;
uint32_t expectedCRC = 0;
uint32_t runningCRC = 0xFFFFFFFFUL;
uint32_t received = 0;
uint32_t lastActivityMs = 0;

uint16_t le16(const uint8_t *bytes) {
  return uint16_t(bytes[0]) | (uint16_t(bytes[1]) << 8);
}

uint32_t le32(const uint8_t *bytes) {
  return uint32_t(bytes[0]) | (uint32_t(bytes[1]) << 8)
      | (uint32_t(bytes[2]) << 16) | (uint32_t(bytes[3]) << 24);
}

uint32_t crc32Update(uint32_t crc, const uint8_t *data, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320UL : 0UL);
  }
  return crc;
}

void notifyStatus(uint8_t code, uint32_t offset) {
  // Binary: [event code, offset uint32 LE]
  uint8_t status[5] = {
    code, uint8_t(offset), uint8_t(offset >> 8),
    uint8_t(offset >> 16), uint8_t(offset >> 24)
  };
  statusCharacteristic->setValue(status, sizeof(status));
  statusCharacteristic->notify();
}

class InputCallbacks : public BLECharacteristicCallbacks {
public:
  explicit InputCallbacks(bool isControl) : control(isControl) {}
  void onWrite(BLECharacteristic *characteristic) override {
    size_t len = characteristic->getLength();
    if (len == 0 || len > sizeof(Frame::bytes)) return;
    Frame frame = {};
    frame.control = control;
    frame.length = static_cast<uint16_t>(len);
    memcpy(frame.bytes, characteristic->getData(), len);
    if (xQueueSend(incoming, &frame, 0) != pdTRUE) {
      Serial.println("OTA RX queue full");
    }
  }
private:
  bool control;
};

class ConnectionCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { deviceConnected = true; }
#if defined(CONFIG_NIMBLE_ENABLED)
  void onConnect(BLEServer *server, ble_gap_conn_desc *description) override {
    server->requestConnParams(description->conn_handle, 0x06, 0x12, 0, 2000);
  }
#elif defined(CONFIG_BLUEDROID_ENABLED)
  void onConnect(BLEServer *server, esp_ble_gatts_cb_param_t *parameters) override {
    server->updateConnParams(parameters->connect.remote_bda, 0x06, 0x12, 0, 2000);
  }
#endif
  void onDisconnect(BLEServer *) override {
    deviceConnected = false;
    disconnectPending = true;
  }
};

void abortUpdate(uint8_t code = 0xE0, bool sendStatus = true) {
  if (updating) Update.abort();
  updating = false;
  if (sendStatus && deviceConnected) notifyStatus(code, received);
}

void handleControl(const Frame &frame) {
  const uint8_t opcode = frame.bytes[0];
  if (opcode == 0x01 && frame.length == 9) { // START: opcode + byte count + CRC32
    if (updating) { notifyStatus(0xE1, received); return; }
    expectedSize = le32(&frame.bytes[1]);
    expectedCRC = le32(&frame.bytes[5]);
    received = 0;
    runningCRC = 0xFFFFFFFFUL;
    if (!expectedSize || !Update.begin(expectedSize, U_FLASH)) {
      Serial.printf("Update.begin failed: %u\n", Update.getError());
      notifyStatus(0xE2, 0);
      return;
    }
    updating = true;
    lastActivityMs = millis();
    Serial.printf("OTA START %lu bytes\n", (unsigned long)expectedSize);
    notifyStatus(0x10, 0); // READY
  } else if (opcode == 0x02 && frame.length == 1) { // FINISH
    if (!updating || received != expectedSize ||
        (runningCRC ^ 0xFFFFFFFFUL) != expectedCRC) {
      Serial.println("OTA length or CRC mismatch");
      abortUpdate(0xE3);
      return;
    }
    if (!Update.end()) {
      Serial.printf("Update.end failed: %u\n", Update.getError());
      abortUpdate(0xE4);
      return;
    }
    updating = false;
    Serial.println("OTA COMPLETE; rebooting");
    notifyStatus(0x12, received); // DONE
    delay(900);
    ESP.restart();
  } else if (opcode == 0x03 && frame.length == 1) { // ABORT
    abortUpdate(0xE5);
  } else {
    notifyStatus(0xE6, received);
  }
}

void handleData(const Frame &frame) {
  if (!updating || received + frame.length > expectedSize) {
    notifyStatus(0xE7, received);
    return;
  }
  // Reject images for another chip before any flash data is committed.
  // Every browser packet used by this demo is at least 20 bytes.
  if (received == 0 &&
      (frame.length < 14 || frame.bytes[0] != 0xE9 ||
       le16(&frame.bytes[12]) != ESP32_S3_CHIP_ID)) {
    Serial.println("OTA image is not an ESP32-S3 application image");
    abortUpdate(0xE9);
    return;
  }
  if (Update.write(const_cast<uint8_t *>(frame.bytes), frame.length) != frame.length) {
    Serial.printf("Update.write failed: %u\n", Update.getError());
    abortUpdate(0xE8);
    return;
  }
  runningCRC = crc32Update(runningCRC, frame.bytes, frame.length);
  received += frame.length;
  lastActivityMs = millis();
  notifyStatus(0x11, received); // ACK after flash write
}

void setup() {
  Serial.begin(115200);
  led.begin();
  led.clear();
  led.show();

  incoming = xQueueCreate(5, sizeof(Frame));
  if (!incoming) { Serial.println("Queue allocation failed"); abort(); }

  BLEDevice::init("Atech-Custom-OTA");
  BLEDevice::setMTU(247);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ConnectionCallbacks());
  BLEService *service = bleServer->createService(SERVICE_UUID);

  BLECharacteristic *control = service->createCharacteristic(
      CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new InputCallbacks(true));

  BLECharacteristic *data = service->createCharacteristic(
      DATA_UUID, BLECharacteristic::PROPERTY_WRITE);
  data->setCallbacks(new InputCallbacks(false));

  statusCharacteristic = service->createCharacteristic(
      STATUS_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
#if defined(CONFIG_BLUEDROID_ENABLED)
  statusCharacteristic->addDescriptor(new BLE2902());
#endif

  BLECharacteristic *info = service->createCharacteristic(
      INFO_UUID, BLECharacteristic::PROPERTY_READ);
#if DEMO_VERSION == 1
  info->setValue("Atech demo1 / v1 / blue blink");
#else
  info->setValue("Atech demo1 / v2 / green blink");
#endif

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Atech custom BLE OTA v%d ready\n", DEMO_VERSION);
}

void loop() {
  if (disconnectPending) {
    disconnectPending = false;
    if (updating) {
      Serial.printf("OTA aborted after disconnect at %lu bytes\n",
                    (unsigned long)received);
      abortUpdate(0xE0, false);
    }
    xQueueReset(incoming);
  }

  Frame frame;
  // No flash writes from the BLE callback task: main loop owns Update.
  if (xQueueReceive(incoming, &frame, 0) == pdTRUE) {
    if (frame.control) handleControl(frame);
    else handleData(frame);
  }
  if (updating && millis() - lastActivityMs > OTA_IDLE_TIMEOUT_MS) {
    Serial.printf("OTA timed out at %lu bytes\n", (unsigned long)received);
    abortUpdate(0xEA);
  }
  if (!deviceConnected && previouslyConnected) {
    delay(250);
    bleServer->startAdvertising();
  }
  previouslyConnected = deviceConnected;
  if (!updating) {
    // LEDs are deliberately different so OTA success is visible.
#if DEMO_VERSION == 1
    const uint32_t color = led.Color(0, 0, 40);
    const uint32_t period = 1200;
#else
    const uint32_t color = led.Color(0, 40, 0);
    const uint32_t period = 350;
#endif
    led.setPixelColor(0, (millis() % period < period / 2) ? color : 0);
    led.show();
    delay(20);
  } else {
    delay(1);
  }
}
