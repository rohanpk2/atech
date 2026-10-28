#include <AtechApp.h>

static const uint8_t kBrightness = 40;
static const int kBlinkCount = 3;
static const uint32_t kOnMs = 120;
static const uint32_t kOffMs = 120;
static const uint32_t kPauseMs = 2000;

void appSetup() {
  led.off();
  atech::log("Triple blink app started");
}

void appLoop() {
  for (int i = 0; i < kBlinkCount; ++i) {
    led.set(kBrightness, kBrightness, kBrightness);
    delay(kOnMs);
    led.off();
    delay(kOffMs);
  }
  delay(kPauseMs);
}
