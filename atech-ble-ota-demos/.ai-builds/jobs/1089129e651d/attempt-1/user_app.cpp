#include <AtechApp.h>

void appSetup() {
  atech::log("Green blink app started: 2 blinks per second");
  led.off();
}

void appLoop() {
  led.set(0, 40, 0);
  delay(250);
  led.off();
  delay(250);
}
