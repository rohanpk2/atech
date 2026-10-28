#include <AtechApp.h>

static const uint8_t kBright = 60;
static const int kFlashOnMs = 60;
static const int kFlashOffMs = 60;
static const int kGroupGapMs = 120;

static void flashTwice(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < 2; ++i) {
    atech::led.set(r, g, b);
    delay(kFlashOnMs);
    atech::led.off();
    delay(kFlashOffMs);
  }
}

void appSetup() {
  atech::log("Police strobe started");
  atech::led.off();
}

void appLoop() {
  flashTwice(kBright, 0, 0);
  delay(kGroupGapMs);
  flashTwice(0, 0, kBright);
  delay(kGroupGapMs);
}
