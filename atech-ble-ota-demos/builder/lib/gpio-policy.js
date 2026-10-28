'use strict';

// GPIO policy for generated code on the ESP32-S3 DevKitC-1 N16R8. The firmware
// core enforces the same table at runtime (shared/AtechCore/src/AtechCore.cpp).
const ALLOWED_PINS = Object.freeze([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                                    21, 38, 39, 40, 41, 42, 47]);

const RESERVED = Object.freeze({
  0: 'BOOT button and strapping pin (used for the Wi-Fi OTA hold)',
  3: 'strapping pin (JTAG select)',
  19: 'USB D-',
  20: 'USB D+',
  26: 'SPI flash', 27: 'SPI flash', 28: 'SPI flash', 29: 'SPI flash', 30: 'SPI flash',
  31: 'SPI flash', 32: 'SPI flash',
  33: 'octal PSRAM', 34: 'octal PSRAM', 35: 'octal PSRAM', 36: 'octal PSRAM', 37: 'octal PSRAM',
  43: 'UART0 TX (serial console)',
  44: 'UART0 RX (serial console)',
  45: 'strapping pin (VDD_SPI voltage)',
  46: 'strapping pin (ROM log)',
  48: 'onboard NeoPixel LED, use atech::led instead',
});

function isPinAllowed(pin) {
  return Number.isInteger(pin) && ALLOWED_PINS.includes(pin);
}

function describe() {
  const reserved = Object.entries(RESERVED).map(([pin, reason]) => `GPIO ${pin}: ${reason}`);
  return `Allowed GPIO numbers: ${ALLOWED_PINS.join(', ')}.\n` +
         `Reserved (never use):\n${reserved.map(line => `  - ${line}`).join('\n')}\n` +
         'Any other GPIO number does not exist on this board.';
}

module.exports = {ALLOWED_PINS, RESERVED, isPinAllowed, describe};
