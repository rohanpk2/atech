#include <AtechApp.h>

static const int kBlinkCount = 3;
static const unsigned long kOnMs = 150;
static const unsigned long kOffMs = 150;
static const unsigned long kPauseMs = 2000;

void appSetup() {
  led.off();
  atech::log("Triple blink app started");
}

void appLoop() {
  for (int i = 0; i < kBlinkCount; ++i) {
    led.set(40, 40, 40);
    delay(kOnMs);
    led.off();
    delay(kOffMs);
  }
  delay(kPauseMs);
}
