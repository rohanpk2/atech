// AtechAppApi.h: declarations of the application-facing API. Included by both
// AtechApp.h (which adds the GPIO macros for generated code) and the core
// implementation, so neither sees the other's macros.
#pragma once

#include <Arduino.h>

namespace atech {

// The single onboard NeoPixel. Writes are ignored while the core owns the
// LED (for example during an OTA or when a dashboard LED command is active).
class Led {
public:
  void set(uint8_t r, uint8_t g, uint8_t b);
  void off();
};
extern Led led;

const char *deviceId();
void log(const char *fmt, ...);
bool isPinAllowed(int pin);

bool guardedPinMode(int pin, uint8_t mode);
bool guardedDigitalWrite(int pin, uint8_t value);
int guardedDigitalRead(int pin);
int guardedAnalogRead(int pin);
bool guardedAnalogWrite(int pin, int value);
bool guardedLedcAttach(int pin, uint32_t freq, uint8_t resolution);
bool guardedLedcWrite(int pin, uint32_t duty);
bool guardedAttachInterrupt(int pin, void (*isr)(), int mode);

}  // namespace atech
