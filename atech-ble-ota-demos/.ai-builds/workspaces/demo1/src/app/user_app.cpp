#include <AtechApp.h>

void appSetup() {
  atech::log("Green blink app started: 2 blinks per second");
  atech::led.off();
}

void appLoop() {
  atech::led.set(0, 40, 0);
  delay(250);
  atech::led.off();
  delay(250);
}
