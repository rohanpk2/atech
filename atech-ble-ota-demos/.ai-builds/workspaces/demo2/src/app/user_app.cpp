#include <AtechApp.h>

static const uint8_t kBrightness = 40;
static const uint32_t kOnMs = 150;
static const uint32_t kOffMs = 150;
static const uint32_t kPauseMs = 2000;

void appSetup() {
  led.off();
  atech::log("Triple blink app started");
}

void appLoop() {
  for (int i = 0; i < 3; ++i) {
    led.set(kBrightness, kBrightness, kBrightness);
    delay(kOnMs);
    led.off();
    delay(kOffMs);
  }
  delay(kPauseMs);
}
