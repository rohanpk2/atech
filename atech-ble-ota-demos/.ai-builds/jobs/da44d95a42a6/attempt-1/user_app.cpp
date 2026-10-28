#include <AtechApp.h>

static const uint8_t kBrightness = 40;
static const unsigned long kOnMs = 150;
static const unsigned long kOffMs = 150;
static const unsigned long kPauseMs = 2000;

void appSetup() {
  atech::led.off();
  atech::log("Triple blink app started");
}

void appLoop() {
  for (int i = 0; i < 3; ++i) {
    atech::led.set(kBrightness, kBrightness, kBrightness);
    delay(kOnMs);
    atech::led.off();
    delay(kOffMs);
  }
  delay(kPauseMs);
}
