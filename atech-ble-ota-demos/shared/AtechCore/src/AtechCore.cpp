// AtechCore.cpp: protected firmware core shared by both Atech demos.
// Generated application code never lives here; it only sees AtechApp.h.
#include "AtechCore.h"
#include "AtechAppApi.h"

#include <Adafruit_NeoPixel.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif
#include <Update.h>
#include <esp_attr.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <stdarg.h>
#include <string.h>

// Defined by the generated application file (src/app/user_app.cpp).
void appSetup();
void appLoop();

namespace {

constexpr char ATECH_CORE_VERSION[] = "1.1.0";
constexpr char IDENTITY_SERVICE_UUID[] = "a7ec0100-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char IDENTITY_CHAR_UUID[] = "a7ec0101-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char CONTROL_CHAR_UUID[] = "a7ec0102-2e47-4dd2-82a4-9c2cf6eaa001";
constexpr char EVENT_CHAR_UUID[] = "a7ec0103-2e47-4dd2-82a4-9c2cf6eaa001";

// GPIO the generated app may touch on the ESP32-S3 DevKitC-1 N16R8. Reserved:
// 0 BOOT, 3 strapping, 19/20 USB, 26-37 flash and OPI PSRAM, 43/44 UART0,
// 45/46 strapping, 48 onboard NeoPixel (reachable only through atech::led).
constexpr int ALLOWED_PINS[] = {1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                                21, 38, 39, 40, 41, 42, 47};

constexpr uint32_t CRASH_MAGIC = 0xA7EC0C0DUL;
constexpr uint32_t CRASH_THRESHOLD = 3;
constexpr uint32_t CRASH_CLEAR_MS = 60000;
constexpr uint32_t FORCED_SUSPEND_MS = 3000;
constexpr uint32_t RESTART_DELAY_MS = 700;
constexpr size_t CONTROL_PACKET_SIZE = 9;   // opcode + 8-byte nonce
constexpr size_t EVENT_PACKET_SIZE = 10;    // opcode + status + nonce
constexpr uint32_t APP_TASK_STACK = 8192;

enum ControlOpcode : uint8_t { Confirm = 0x01, Rollback = 0x02, Echo = 0x03, Restart = 0x04 };
enum ControlStatus : uint8_t { Ok = 0, Unsupported = 1, Refused = 2 };
enum AppState : uint8_t { Disabled = 0, Setup = 1, Running = 2, Suspended = 3 };

// Survives panic/watchdog/software resets but not a power cycle; the magic word
// detects garbage after power-on.
RTC_NOINIT_ATTR uint32_t crashMagic;
RTC_NOINIT_ATTR uint32_t crashCounter;

AtechCoreConfig config = {};
char deviceIdText[20] = "ATECH-000000000000";
char suffixText[7] = "000000";
Adafruit_NeoPixel *pixel = nullptr;
SemaphoreHandle_t ledMutex = nullptr;
TaskHandle_t appTask = nullptr;
QueueHandle_t controlQueue = nullptr;
BLECharacteristic *identityChar = nullptr;
BLECharacteristic *controlChar = nullptr;
BLECharacteristic *eventChar = nullptr;

volatile uint32_t loopCounter = 0;
volatile uint8_t appState = Disabled;
volatile bool suspendRequested = false;
uint32_t suspendRequestedAt = 0;
atech::LedOwner owner = atech::LedOwner::App;
bool pendingVerify = false;
bool safeModeActive = false;
bool crashCleared = false;
bool bleAttached = false;
uint32_t restartAtMs = 0;
int lastCoreLedState = -1;
portMUX_TYPE otaLock = portMUX_INITIALIZER_UNLOCKED;
char otaOwnerText[12] = "";

const char *appStateName() {
  switch (appState) {
    case Setup: return "setup";
    case Running: return "running";
    case Suspended: return "suspended";
    default: return "disabled";
  }
}

String jsonEscape(const char *text) {
  String out;
  if (!text) return out;
  for (const char *p = text; *p; ++p) {
    const char c = *p;
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (static_cast<uint8_t>(c) < 0x20) { /* drop control characters */ }
    else out += c;
  }
  return out;
}

void computeIdentity() {
  uint8_t mac[6] = {};
  esp_efuse_mac_get_default(mac);
  snprintf(deviceIdText, sizeof(deviceIdText), "ATECH-%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(suffixText, sizeof(suffixText), "%02X%02X%02X", mac[3], mac[4], mac[5]);
}

bool ledTake() {
  return ledMutex && xSemaphoreTake(ledMutex, pdMS_TO_TICKS(50)) == pdTRUE;
}

void ledGive() {
  if (ledMutex) xSemaphoreGive(ledMutex);
}

void ledShow(uint32_t color) {
  if (!pixel || !ledTake()) return;
  pixel->setPixelColor(0, color);
  pixel->show();
  ledGive();
}

void appTaskMain(void *) {
  appState = Setup;
  appSetup();
  appState = Running;
  for (;;) {
    if (suspendRequested) {
      appState = Suspended;
      vTaskSuspend(nullptr);
      appState = Running;
      continue;
    }
    appLoop();
    loopCounter = loopCounter + 1;
    vTaskDelay(1);
  }
}

void startAppTask() {
  if (appTask || safeModeActive) return;
  if (xTaskCreatePinnedToCore(appTaskMain, "atech_app", APP_TASK_STACK, nullptr, 1,
                              &appTask, 1) != pdPASS) {
    appTask = nullptr;
    Serial.println("[core] app task creation failed; app disabled");
  }
}

void readRollbackState() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  pendingVerify = running && esp_ota_get_state_partition(running, &state) == ESP_OK &&
                  state == ESP_OTA_IMG_PENDING_VERIFY;
}

void readCrashState() {
  if (crashMagic != CRASH_MAGIC) {
    crashMagic = CRASH_MAGIC;
    crashCounter = 0;
  }
  const esp_reset_reason_t reason = esp_reset_reason();
  const bool crash = reason == ESP_RST_PANIC || reason == ESP_RST_TASK_WDT ||
                     reason == ESP_RST_INT_WDT || reason == ESP_RST_WDT ||
                     reason == ESP_RST_BROWNOUT;
  crashCounter = crash ? crashCounter + 1 : 0;
  safeModeActive = crashCounter >= CRASH_THRESHOLD;
}

void sendEvent(uint8_t opcode, uint8_t status, const uint8_t nonce[8]) {
  if (!eventChar) return;
  uint8_t packet[EVENT_PACKET_SIZE] = {};
  packet[0] = opcode;
  packet[1] = status;
  memcpy(&packet[2], nonce, 8);
  eventChar->setValue(packet, sizeof(packet));
  eventChar->notify();
}

void handleControl(const uint8_t *packet) {
  const uint8_t opcode = packet[0];
  const uint8_t *nonce = &packet[1];
  uint8_t status = Ok;
  switch (opcode) {
    case Confirm:
      atech::confirmBoot();
      break;
    case Rollback:
      if (!atech::canRollback() || !atech::rollbackToPrevious()) status = Refused;
      else restartAtMs = millis() + RESTART_DELAY_MS;
      break;
    case Echo:
      break;
    case Restart:
      restartAtMs = millis() + RESTART_DELAY_MS;
      break;
    default:
      status = Unsupported;
      break;
  }
  Serial.printf("[core] control opcode=0x%02x status=%u\n", opcode, status);
  sendEvent(opcode, status, nonce);
}

void renderCoreLed() {
  const uint32_t now = millis();
  if (owner == atech::LedOwner::App) {
    if (!safeModeActive) return;
    // Safe mode: slow red breathing so the board is recognisable at a glance.
    const uint32_t phase = now % 2000;
    const uint32_t level = phase < 1000 ? phase * 40 / 1000 : (2000 - phase) * 40 / 1000;
    const int state = static_cast<int>(level);
    if (state == lastCoreLedState) return;
    lastCoreLedState = state;
    ledShow(Adafruit_NeoPixel::Color(level, 0, 0));
    return;
  }
  if (owner == atech::LedOwner::Off) {
    if (lastCoreLedState == 0) return;
    lastCoreLedState = 0;
    ledShow(0);
    return;
  }
  const bool blue = owner == atech::LedOwner::BlinkBlue;
  const uint32_t period = blue ? 1200 : 350;
  const bool on = now % period < period / 2;
  const int state = (blue ? 10 : 20) + (on ? 1 : 0);
  if (state == lastCoreLedState) return;
  lastCoreLedState = state;
  ledShow(on ? (blue ? Adafruit_NeoPixel::Color(0, 0, 40) : Adafruit_NeoPixel::Color(0, 40, 0)) : 0);
}

class IdentityCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *characteristic) override {
    characteristic->setValue(atech::identityJson());
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (characteristic->getLength() != CONTROL_PACKET_SIZE || !controlQueue) return;
    uint8_t packet[CONTROL_PACKET_SIZE];
    memcpy(packet, characteristic->getData(), CONTROL_PACKET_SIZE);
    xQueueSend(controlQueue, packet, 0);
  }
};

}  // namespace

// Arduino-ESP32 calls this weak hook during initArduino(). Returning true keeps
// a freshly flashed OTA image in PENDING_VERIFY until the core confirms it, so
// an app that panics before confirmation rolls back automatically.
extern "C" bool verifyRollbackLater() { return true; }

namespace atech {

Led led;

void Led::set(uint8_t r, uint8_t g, uint8_t b) {
  if (owner != LedOwner::App || suspendRequested || safeModeActive) return;
  ledShow(Adafruit_NeoPixel::Color(r, g, b));
}

void Led::off() { set(0, 0, 0); }

const char *deviceId() { return deviceIdText; }
const char *pairingSuffix() { return suffixText; }

String bleName(const char *prefix) {
  return String(prefix ? prefix : "Atech") + "-" + suffixText;
}

void log(const char *fmt, ...) {
  char buffer[160];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buffer, sizeof(buffer), fmt, args);
  va_end(args);
  Serial.printf("[app] %s\n", buffer);
}

bool isPinAllowed(int pin) {
  for (int allowed : ALLOWED_PINS) {
    if (allowed == pin) return true;
  }
  return false;
}

static bool refuse(const char *call, int pin) {
  log("refused %s on GPIO %d: reserved pin", call, pin);
  return false;
}

bool guardedPinMode(int pin, uint8_t mode) {
  if (!isPinAllowed(pin)) return refuse("pinMode", pin);
  pinMode(pin, mode);
  return true;
}

bool guardedDigitalWrite(int pin, uint8_t value) {
  if (!isPinAllowed(pin)) return refuse("digitalWrite", pin);
  digitalWrite(pin, value);
  return true;
}

int guardedDigitalRead(int pin) {
  if (!isPinAllowed(pin)) { refuse("digitalRead", pin); return 0; }
  return digitalRead(pin);
}

int guardedAnalogRead(int pin) {
  if (!isPinAllowed(pin)) { refuse("analogRead", pin); return 0; }
  return analogRead(pin);
}

bool guardedAnalogWrite(int pin, int value) {
  if (!isPinAllowed(pin)) return refuse("analogWrite", pin);
  analogWrite(pin, value);
  return true;
}

bool guardedLedcAttach(int pin, uint32_t freq, uint8_t resolution) {
  if (!isPinAllowed(pin)) return refuse("ledcAttach", pin);
  return ledcAttach(pin, freq, resolution);
}

bool guardedLedcWrite(int pin, uint32_t duty) {
  if (!isPinAllowed(pin)) return refuse("ledcWrite", pin);
  return ledcWrite(pin, duty);
}

bool guardedAttachInterrupt(int pin, void (*isr)(), int mode) {
  if (!isPinAllowed(pin)) return refuse("attachInterrupt", pin);
  attachInterrupt(digitalPinToInterrupt(pin), isr, mode);
  return true;
}

bool coreBegin(const AtechCoreConfig &userConfig) {
  config = userConfig;
  if (config.autoConfirmMs == 0) config.autoConfirmMs = 20000;
  computeIdentity();
  readCrashState();
  readRollbackState();

  ledMutex = xSemaphoreCreateMutex();
  controlQueue = xQueueCreate(4, CONTROL_PACKET_SIZE);
  pixel = new Adafruit_NeoPixel(1, config.ledPin, NEO_GRB + NEO_KHZ800);
  pixel->begin();
  pixel->clear();
  pixel->show();

  Serial.printf("[core] device %s (pairing suffix %s) build %s app \"%s\" v%u\n",
                deviceIdText, suffixText, config.buildId ? config.buildId : "?",
                config.appName ? config.appName : "?", config.appVersion);
  if (pendingVerify) Serial.println("[core] OTA image pending verification; rollback armed");
  if (safeModeActive) {
    Serial.printf("[core] SAFE MODE: %lu consecutive crash resets; app disabled\n",
                  static_cast<unsigned long>(crashCounter));
  } else {
    startAppTask();
  }
  return ledMutex && controlQueue;
}

void coreAttachBle(BLEServer *server) {
  if (!server || bleAttached) return;
  BLEService *service = server->createService(IDENTITY_SERVICE_UUID);
  identityChar = service->createCharacteristic(IDENTITY_CHAR_UUID, BLECharacteristic::PROPERTY_READ);
  identityChar->setCallbacks(new IdentityCallbacks());
  identityChar->setValue(identityJson());
  controlChar = service->createCharacteristic(CONTROL_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
  controlChar->setCallbacks(new ControlCallbacks());
  eventChar = service->createCharacteristic(
      EVENT_CHAR_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
#if defined(CONFIG_BLUEDROID_ENABLED)
  eventChar->addDescriptor(new BLE2902());
#endif
  service->start();
  bleAttached = true;
}

void coreLoop() {
  const uint32_t now = millis();

  if (controlQueue) {
    uint8_t packet[CONTROL_PACKET_SIZE];
    while (xQueueReceive(controlQueue, packet, 0) == pdTRUE) handleControl(packet);
  }

  if (suspendRequested && appTask && appState != Suspended && appState != Disabled &&
      now - suspendRequestedAt > FORCED_SUSPEND_MS) {
    vTaskSuspend(appTask);
    appState = Suspended;
    Serial.println("[core] app did not yield; suspended forcibly for OTA");
  }

  if (!crashCleared && now >= CRASH_CLEAR_MS) {
    crashCleared = true;
    if (!safeModeActive) crashCounter = 0;
  }

  // Confirm a pending image only once the generated app has provably run:
  // appSetup() returned and appLoop() completed at least once. A hung or
  // crashing app therefore never cancels the bootloader rollback by itself.
  if (pendingVerify && bleAttached && !safeModeActive && loopCounter > 0 &&
      now >= config.autoConfirmMs) {
    Serial.println("[core] app running and uptime healthy; confirming OTA image automatically");
    confirmBoot();
  }

  if (restartAtMs && now >= restartAtMs) {
    Serial.println("[core] restarting");
    delay(50);
    ESP.restart();
  }

  renderCoreLed();
}

void coreSuspendApp() {
  if (suspendRequested) return;
  suspendRequested = true;
  suspendRequestedAt = millis();
  lastCoreLedState = -1;
  ledShow(0);
}

void coreResumeApp() {
  if (!suspendRequested) return;
  suspendRequested = false;
  if (appTask && appState == Suspended) vTaskResume(appTask);
}

bool coreAppRunning() { return appTask && appState == Running; }

void setLedOwner(LedOwner newOwner) {
  owner = newOwner;
  lastCoreLedState = -1;
  if (newOwner == LedOwner::App || newOwner == LedOwner::Off) ledShow(0);
}

LedOwner ledOwner() { return owner; }

bool coreTryAcquireOta(const char *owner) {
  if (!owner || !*owner) return false;
  bool acquired = false;
  portENTER_CRITICAL(&otaLock);
  if (!otaOwnerText[0] || strcmp(otaOwnerText, owner) == 0) {
    strncpy(otaOwnerText, owner, sizeof(otaOwnerText) - 1);
    otaOwnerText[sizeof(otaOwnerText) - 1] = '\0';
    acquired = true;
  }
  portEXIT_CRITICAL(&otaLock);
  return acquired;
}

void coreReleaseOta(const char *owner) {
  portENTER_CRITICAL(&otaLock);
  if (!owner || strcmp(otaOwnerText, owner) == 0) otaOwnerText[0] = '\0';
  portEXIT_CRITICAL(&otaLock);
}

const char *coreOtaOwner() { return otaOwnerText; }

String identityJson() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  const bool paired = !config.targetDeviceId || !*config.targetDeviceId ||
                      strcmp(config.targetDeviceId, deviceIdText) == 0;
  String json;
  json.reserve(420);
  json += "{\"id\":\""; json += deviceIdText;
  json += "\",\"suffix\":\""; json += suffixText;
  json += "\",\"demo\":"; json += String(config.demo);
  json += ",\"board\":\""; json += jsonEscape(config.board);
  json += "\",\"variant\":\""; json += jsonEscape(config.variant);
  json += "\",\"core\":\""; json += ATECH_CORE_VERSION;
  json += "\",\"fw\":\""; json += jsonEscape(config.firmwareInfo);
  json += "\",\"build\":\""; json += jsonEscape(config.buildId);
  json += "\",\"app\":\""; json += jsonEscape(config.appName);
  json += "\",\"ver\":"; json += String(config.appVersion);
  json += ",\"slot\":\""; json += running ? running->label : "";
  json += "\",\"slotSize\":"; json += String(running ? running->size : 0);
  json += ",\"pending\":"; json += pendingVerify ? "true" : "false";
  json += ",\"canRollback\":"; json += canRollback() ? "true" : "false";
  json += ",\"safe\":"; json += safeModeActive ? "true" : "false";
  json += ",\"crashes\":"; json += String(crashCounter);
  json += ",\"target\":\""; json += jsonEscape(config.targetDeviceId);
  json += "\",\"paired\":"; json += paired ? "true" : "false";
  json += ",\"appState\":\""; json += appStateName();
  json += "\",\"otaOwner\":\""; json += otaOwnerText;
  json += "\",\"loops\":"; json += String(loopCounter);
  json += ",\"up\":"; json += String(millis());
  json += "}";
  return json;
}

bool confirmBoot() {
  if (!pendingVerify) return true;
  const esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();
  if (result == ESP_OK) {
    pendingVerify = false;
    Serial.println("[core] OTA image confirmed; rollback cancelled");
    return true;
  }
  Serial.printf("[core] confirm failed: %s\n", esp_err_to_name(result));
  return false;
}

bool rollbackToPrevious() {
  if (!Update.canRollBack()) return false;
  const bool ok = Update.rollBack();
  Serial.printf("[core] rollback %s\n", ok ? "armed; restarting" : "failed");
  return ok;
}

bool rollbackPending() { return pendingVerify; }
bool canRollback() { return Update.canRollBack(); }
bool safeMode() { return safeModeActive; }
uint32_t crashCount() { return crashCounter; }
uint32_t appLoops() { return loopCounter; }

}  // namespace atech
