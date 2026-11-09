// Stock application for the Demo 2 images: the two-board demo. One shared boolean, demo.power,
// is kept in agreement with the paired board over ESP-NOW by the protected core (shared/AtechSync).
// Off: the slow blue (v1) or quick green (v2) blink the demo always had. On: solid warm white, on
// both boards. Toggled by a short press of the BOOT button (the core publishes it as the
// "button.pressed" event), by "sync toggle demo.power" on the serial console, or from the
// dashboard. Only the local button changes the local state: the state is what syncs, so a press
// on the other board is logged and nothing more. The AI firmware builder replaces this file
// inside its isolated workspace; the checked-in copy is never modified by a build job.
#include <AtechApp.h>

#ifndef DEMO_VERSION
#define DEMO_VERSION 1
#endif

static const char *POWER_KEY = "demo.power";
static bool powerOn = false;

static void onSyncChange(const atech::sync::StateChange &change) {
  if (strcmp(change.key, POWER_KEY) != 0) return;
  powerOn = strcmp(change.value, "true") == 0;
  atech::log("%s = %s (%s, revision %lu by %s)", change.key, change.value, change.remote ? "from the other board" : "set here",
             (unsigned long)change.revision, change.writer);
}

static void onSyncEvent(const atech::sync::Event &event) {
  if (strcmp(event.name, "button.pressed") != 0) return;
  if (event.remote) { atech::log("the other board (%s) pressed its button", event.source); return; }
  atech::sync::setBool(POWER_KEY, !atech::sync::getBool(POWER_KEY, false));
}

void appSetup() {
  atech::sync::onChange(onSyncChange);
  atech::sync::onEvent(onSyncEvent);
  powerOn = atech::sync::getBool(POWER_KEY, false);
  atech::log("stock Demo 2 app ready on %s; demo.power is %s; %s", atech::deviceId(), powerOn ? "on" : "off",
             atech::sync::paired() ? "paired" : "not paired yet (serial: sync code, then sync pair <code> on the other board)");
}

void appLoop() {
  if (powerOn) {
    led.set(40, 30, 18);
    atech::sync::wait(500);
    return;
  }
#if DEMO_VERSION == 1
  led.set(0, 0, 40);
  if (atech::sync::wait(600)) return;   // a change arrived: render it at once
  led.off();
  atech::sync::wait(600);
#else
  led.set(0, 40, 0);
  if (atech::sync::wait(175)) return;
  led.off();
  atech::sync::wait(175);
#endif
}
