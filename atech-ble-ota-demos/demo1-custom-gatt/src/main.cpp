// Atech Demo 1: Web Bluetooth commands + custom GATT OTA.
// Prototype ONLY: transport CRCs detect accidents, not malicious firmware.
// Production devices require authenticated access and signed firmware.
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
#define SERVICE_UUID  "a7ec0001-2e47-4dd2-82a4-9c2cf6eaa001"
#define CONTROL_UUID  "a7ec0002-2e47-4dd2-82a4-9c2cf6eaa001"
#define DATA_UUID     "a7ec0003-2e47-4dd2-82a4-9c2cf6eaa001"
#define STATUS_UUID   "a7ec0004-2e47-4dd2-82a4-9c2cf6eaa001"
#define INFO_UUID     "a7ec0005-2e47-4dd2-82a4-9c2cf6eaa001"
#define COMMAND_UUID  "a7ec0006-2e47-4dd2-82a4-9c2cf6eaa001"
#define RESPONSE_UUID "a7ec0007-2e47-4dd2-82a4-9c2cf6eaa001"

constexpr uint16_t ESP32_S3_CHIP_ID = 9;
constexpr uint32_t OTA_IDLE_TIMEOUT_MS = 30000;
constexpr uint8_t COMMAND_PROTOCOL_VERSION = 1;
constexpr size_t COMMAND_PACKET_SIZE = 20;

enum class FrameKind : uint8_t { OtaControl, OtaData, Command };
enum class LedMode : uint8_t { Off = 0, BlinkBlue = 1, BlinkGreen = 2 };
enum class CommandOpcode : uint8_t {
  Ping = 0x01,
  BlinkBlue = 0x02,
  BlinkGreen = 0x03,
  StopBlinking = 0x04,
  GetStatus = 0x05,
};
enum class CommandStatus : uint8_t {
  Ok = 0,
  Malformed = 1,
  CrcError = 2,
  Unsupported = 3,
  Busy = 4,
};

// OTA data may use the negotiated 247-byte MTU (244-byte ATT payload).
struct Frame {
  FrameKind kind;
  uint16_t length;
  uint8_t bytes[244];
};

QueueHandle_t incoming;
BLECharacteristic *statusCharacteristic = nullptr;
BLECharacteristic *responseCharacteristic = nullptr;
BLEServer *bleServer = nullptr;
volatile bool deviceConnected = false;
volatile bool disconnectPending = false;
bool previouslyConnected = false;

Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
#if DEMO_VERSION == 1
LedMode ledMode = LedMode::BlinkBlue;
#else
LedMode ledMode = LedMode::BlinkGreen;
#endif

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

void putLe16(uint8_t *bytes, uint16_t value) {
  bytes[0] = uint8_t(value);
  bytes[1] = uint8_t(value >> 8);
}

void putLe32(uint8_t *bytes, uint32_t value) {
  bytes[0] = uint8_t(value);
  bytes[1] = uint8_t(value >> 8);
  bytes[2] = uint8_t(value >> 16);
  bytes[3] = uint8_t(value >> 24);
}

uint16_t crc16(const uint8_t *data, size_t length) {
  uint16_t crc = 0;
  for (size_t i = 0; i < length; ++i) {
    crc ^= uint16_t(data[i]) << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) ? uint16_t((crc << 1) ^ 0x1021)
                           : uint16_t(crc << 1);
    }
  }
  return crc;
}

uint32_t crc32Update(uint32_t crc, const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320UL : 0UL);
    }
  }
  return crc;
}

void notifyStatus(uint8_t code, uint32_t offset) {
  // OTA status: [event code, offset uint32 LE].
  uint8_t status[5] = {
    code, uint8_t(offset), uint8_t(offset >> 8),
    uint8_t(offset >> 16), uint8_t(offset >> 24)
  };
  statusCharacteristic->setValue(status, sizeof(status));
  statusCharacteristic->notify();
}

void notifyCommandResponse(uint32_t requestId, uint8_t opcode,
                           CommandStatus status, const uint8_t nonce[8]) {
  // Fixed 20-byte response, safe even with the minimum 23-byte ATT MTU:
  // version[1], request ID[4], opcode[1], status[1], LED mode[1],
  // nonce[8], firmware version[1], flags[1], CRC16[2].
  uint8_t response[COMMAND_PACKET_SIZE] = {};
  response[0] = COMMAND_PROTOCOL_VERSION;
  putLe32(&response[1], requestId);
  response[5] = opcode;
  response[6] = static_cast<uint8_t>(status);
  response[7] = static_cast<uint8_t>(ledMode);
  memcpy(&response[8], nonce, 8);
  response[16] = DEMO_VERSION;
  response[17] = updating ? 0x01 : 0x00;
  putLe16(&response[18], crc16(response, 18));
  responseCharacteristic->setValue(response, sizeof(response));
  responseCharacteristic->notify();
}

class InputCallbacks : public BLECharacteristicCallbacks {
public:
  explicit InputCallbacks(FrameKind inputKind) : kind(inputKind) {}

  void onWrite(BLECharacteristic *characteristic) override {
    const size_t length = characteristic->getLength();
    if (length == 0 || length > sizeof(Frame::bytes)) return;
    Frame frame = {};
    frame.kind = kind;
    frame.length = static_cast<uint16_t>(length);
    memcpy(frame.bytes, characteristic->getData(), length);
    if (xQueueSend(incoming, &frame, 0) != pdTRUE) {
      Serial.println("BLE input queue full");
    }
  }

private:
  FrameKind kind;
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
  if (opcode == 0x01 && frame.length == 9) { // START: opcode + size + CRC32
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
    led.clear();
    led.show();
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
    Serial.println("OTA image activated; rebooting for version verification");
    notifyStatus(0x12, received); // TRANSFER_DONE, not post-boot verified
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
  // Reject an image for another chip before committing its first bytes.
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

void handleCommand(const Frame &frame) {
  const uint32_t requestId = frame.length >= 5 ? le32(&frame.bytes[1]) : 0;
  const uint8_t opcode = frame.length >= 6 ? frame.bytes[5] : 0;
  uint8_t nonce[8] = {};
  if (frame.length >= 14) memcpy(nonce, &frame.bytes[6], sizeof(nonce));

  if (frame.length != COMMAND_PACKET_SIZE ||
      frame.bytes[0] != COMMAND_PROTOCOL_VERSION) {
    notifyCommandResponse(requestId, opcode, CommandStatus::Malformed, nonce);
    return;
  }
  if (le16(&frame.bytes[18]) != crc16(frame.bytes, 18)) {
    notifyCommandResponse(requestId, opcode, CommandStatus::CrcError, nonce);
    return;
  }
  if (updating) {
    notifyCommandResponse(requestId, opcode, CommandStatus::Busy, nonce);
    return;
  }

  CommandStatus status = CommandStatus::Ok;
  switch (static_cast<CommandOpcode>(opcode)) {
    case CommandOpcode::Ping:
    case CommandOpcode::GetStatus:
      break;
    case CommandOpcode::BlinkBlue:
      ledMode = LedMode::BlinkBlue;
      break;
    case CommandOpcode::BlinkGreen:
      ledMode = LedMode::BlinkGreen;
      break;
    case CommandOpcode::StopBlinking:
      ledMode = LedMode::Off;
      led.clear();
      led.show();
      break;
    default:
      status = CommandStatus::Unsupported;
      break;
  }

  Serial.printf("Command request=%lu opcode=0x%02x status=%u\n",
                (unsigned long)requestId, opcode, static_cast<unsigned>(status));
  notifyCommandResponse(requestId, opcode, status, nonce);
}

void renderLed() {
  if (ledMode == LedMode::Off) {
    led.clear();
    led.show();
    return;
  }
  const bool blue = ledMode == LedMode::BlinkBlue;
  const uint32_t color = blue ? led.Color(0, 0, 40) : led.Color(0, 40, 0);
  const uint32_t period = blue ? 1200 : 350;
  led.setPixelColor(0, (millis() % period < period / 2) ? color : 0);
  led.show();
}

void setup() {
  Serial.begin(115200);
  led.begin();
  led.clear();
  led.show();

  incoming = xQueueCreate(8, sizeof(Frame));
  if (!incoming) { Serial.println("Queue allocation failed"); abort(); }

  BLEDevice::init("Atech-Custom-OTA");
  BLEDevice::setMTU(247);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ConnectionCallbacks());
  BLEService *service = bleServer->createService(SERVICE_UUID);

  BLECharacteristic *control = service->createCharacteristic(
      CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new InputCallbacks(FrameKind::OtaControl));

  BLECharacteristic *data = service->createCharacteristic(
      DATA_UUID, BLECharacteristic::PROPERTY_WRITE);
  data->setCallbacks(new InputCallbacks(FrameKind::OtaData));

  statusCharacteristic = service->createCharacteristic(
      STATUS_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);

  BLECharacteristic *info = service->createCharacteristic(
      INFO_UUID, BLECharacteristic::PROPERTY_READ);
#if DEMO_VERSION == 1
  info->setValue("Atech demo1 / v1 / blue default");
#else
  info->setValue("Atech demo1 / v2 / green default");
#endif

  BLECharacteristic *command = service->createCharacteristic(
      COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  command->setCallbacks(new InputCallbacks(FrameKind::Command));

  responseCharacteristic = service->createCharacteristic(
      RESPONSE_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);

#if defined(CONFIG_BLUEDROID_ENABLED)
  statusCharacteristic->addDescriptor(new BLE2902());
  responseCharacteristic->addDescriptor(new BLE2902());
#endif

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Atech BLE command + OTA firmware v%d ready\n", DEMO_VERSION);
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
  // BLE callbacks only enqueue. The main loop owns commands and flash writes.
  if (xQueueReceive(incoming, &frame, 0) == pdTRUE) {
    switch (frame.kind) {
      case FrameKind::OtaControl: handleControl(frame); break;
      case FrameKind::OtaData: handleData(frame); break;
      case FrameKind::Command: handleCommand(frame); break;
    }
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
    renderLed();
    delay(20);
  } else {
    delay(1);
  }
}
