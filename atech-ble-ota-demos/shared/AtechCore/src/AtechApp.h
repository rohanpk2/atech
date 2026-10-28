// AtechApp.h: the ONLY header a generated application file may include.
//
// Generated code defines two functions and nothing else at the entry level:
//
//   void appSetup();   // runs once on its own FreeRTOS task
//   void appLoop();    // runs repeatedly; delay() inside is fine
//
// The protected Atech core keeps BLE, OTA, Wi-Fi, identity and recovery
// running regardless of what the app does. GPIO calls made from the app are
// routed through guarded wrappers that refuse reserved pins at runtime.
#pragma once

#include <Arduino.h>
#include "AtechAppApi.h"

using atech::led;

// Route the Arduino GPIO API used by generated code through the guards.
#define pinMode(pin, mode) atech::guardedPinMode((pin), (mode))
#define digitalWrite(pin, value) atech::guardedDigitalWrite((pin), (value))
#define digitalRead(pin) atech::guardedDigitalRead((pin))
#define analogRead(pin) atech::guardedAnalogRead((pin))
#define analogWrite(pin, value) atech::guardedAnalogWrite((pin), (value))
#define ledcAttach(pin, freq, resolution) atech::guardedLedcAttach((pin), (freq), (resolution))
#define ledcWrite(pin, duty) atech::guardedLedcWrite((pin), (duty))
#define attachInterrupt(pin, isr, mode) atech::guardedAttachInterrupt((pin), (isr), (mode))

void appSetup();
void appLoop();
