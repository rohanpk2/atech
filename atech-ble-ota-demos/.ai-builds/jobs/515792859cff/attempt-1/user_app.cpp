#include <AtechApp.h>
#include <math.h>

// Peak purple colour (comfortable brightness)
static const float PEAK_R = 48.0f;
static const float PEAK_G = 0.0f;
static const float PEAK_B = 64.0f;

static const int HALF_MS = 1500;   // 1.5 s up, 1.5 s down = 3 s cycle
static const int STEP_MS = 20;
static const int STEPS = HALF_MS / STEP_MS;  // 75 steps per half

static bool rising = true;

static void showLevel(float level) {
  if (level < 0.0f) level = 0.0f;
  if (level > 1.0f) level = 1.0f;
  uint8_t r = (uint8_t)lroundf(PEAK_R * level);
  uint8_t g = (uint8_t)lroundf(PEAK_G * level);
  uint8_t b = (uint8_t)lroundf(PEAK_B * level);
  if (r == 0 && g == 0 && b == 0) {
    led.off();
  } else {
    led.set(r, g, b);
  }
}

void appSetup() {
  led.off();
  atech::log("Purple breathing fade started");
}

void appLoop() {
  // One half of the cycle per pass: rising, then falling.
  for (int i = 0; i <= STEPS; ++i) {
    float t = (float)i / (float)STEPS;            // 0..1
    float eased = 0.5f - 0.5f * cosf((float)M_PI * t);  // smooth 0..1
    float level = rising ? eased : (1.0f - eased);
    showLevel(level);
    if (i < STEPS) delay(STEP_MS);
  }
  rising = !rising;
}
