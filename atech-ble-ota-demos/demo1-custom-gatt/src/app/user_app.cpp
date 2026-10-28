// Stock application for the Demo 1 images: the same slow blue (v1) or quick
// green (v2) blink the demo always had, now running as a sandboxed app task.
// The AI firmware builder replaces this file inside its isolated workspace;
// the checked-in copy is never modified by a build job.
#include <AtechApp.h>

#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif

void appSetup() {
  atech::log("stock Demo 1 app ready on %s", atech::deviceId());
}

void appLoop() {
#if DEMO_VERSION == 1
  led.set(0, 0, 40);
  delay(600);
  led.off();
  delay(600);
#else
  led.set(0, 40, 0);
  delay(175);
  led.off();
  delay(175);
#endif
}
