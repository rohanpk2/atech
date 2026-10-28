'use strict';

// Static policy for generated application code. This is a sandboxing aid for
// the protected core, not a security boundary: the firmware's guarded GPIO
// wrappers back it up at runtime.
const {ALLOWED_PINS} = require('./gpio-policy');

const MAX_SOURCE_BYTES = 64 * 1024;

const ALLOWED_INCLUDES = new Set([
  'AtechApp.h', 'Arduino.h',
  'stdint.h', 'string.h', 'math.h', 'stdio.h', 'stdlib.h', 'ctype.h', 'float.h', 'limits.h',
  'cstdint', 'cstring', 'cmath', 'cstdio', 'cstdlib', 'cctype', 'cfloat', 'climits',
  'algorithm', 'array', 'vector', 'string', 'functional', 'utility', 'numeric', 'limits',
]);

const FORBIDDEN_APIS = [
  [/\bWiFi\w*\b/, 'Wi-Fi'],
  [/\bBLE\w*\b|\bNimBLE\w*\b/, 'Bluetooth'],
  [/\bUpdate\s*\./, 'the OTA Update object'],
  [/\besp_ota_\w+/, 'esp_ota_* calls'],
  [/\besp_partition\w*/, 'partition access'],
  [/\bspi_flash\w*|\besp_flash\w*/, 'raw flash access'],
  [/\bnvs_\w+|\bPreferences\b/, 'NVS storage'],
  [/\besp_restart\b|\bESP\s*\.\s*restart\b|\babort\s*\(/, 'restarting or aborting the board'],
  [/\besp_deep_sleep\w*|\besp_light_sleep\w*|\besp_sleep_\w+/, 'sleep modes'],
  [/\bAdafruit_NeoPixel\b|\bneopixelWrite\b|\brgbLedWrite\b/, 'direct NeoPixel control (use atech::led)'],
  [/\bxTaskCreate\w*|\bvTaskDelete\b|\bvTaskSuspend\b|\bvTaskResume\b/, 'FreeRTOS task management'],
  [/__asm__|\basm\s*\(/, 'inline assembly'],
  [/\bsystem\s*\(/, 'system()'],
  [/\bWire\b/, 'I2C (Wire) in this version'],
  [/\bSPI\b/, 'SPI in this version'],
  [/\bSerial[12]\b|\bHardwareSerial\b/, 'extra UARTs (they bind pins without pinMode)'],
  [/\btone\s*\(|\bnoTone\s*\(/, 'tone()'],
  [/\btimerBegin\s*\(|\bhw_timer_t\b/, 'hardware timers'],
  [/\btouchRead\s*\(/, 'touch sensing'],
  [/\batech::core\w*/, 'core lifecycle functions'],
];

const GPIO_CALLS = /\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcAttach|ledcWrite|attachInterrupt)\s*\(\s*(\d+)\s*[,)]/g;
const GUARDED_NAMES = 'pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcAttach|ledcWrite|attachInterrupt';
const MACRO_BYPASS = new RegExp(`^\\s*#\\s*(undef|define)\\s+(${GUARDED_NAMES})\\b`, 'm');

// Replace comments and string literals with whitespace of the same shape so
// line numbers survive and prose never triggers an API rule.
function stripCommentsAndStrings(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, match => `"${' '.repeat(match.length - 2)}"`);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function checkSource(code) {
  const violations = [];
  const push = (rule, message, line = null) => violations.push({rule, message, line});
  const source = String(code);

  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    push('size', `Generated source is larger than ${MAX_SOURCE_BYTES / 1024} KiB`);
  }

  const stripped = stripCommentsAndStrings(source);

  if (!/\bvoid\s+appSetup\s*\(\s*(void)?\s*\)/.test(stripped)) {
    push('entry-points', 'The file must define void appSetup()');
  }
  if (!/\bvoid\s+appLoop\s*\(\s*(void)?\s*\)/.test(stripped)) {
    push('entry-points', 'The file must define void appLoop()');
  }
  const reservedEntry = stripped.match(/\bvoid\s+(setup|loop)\s*\(\s*(void)?\s*\)\s*\{/);
  if (reservedEntry) {
    push('reserved-entry', `Do not define ${reservedEntry[1]}(); the core owns setup() and loop()`,
         lineOf(stripped, reservedEntry.index));
  }

  const includePattern = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  let include;
  while ((include = includePattern.exec(stripped)) !== null) {
    const name = include[1].trim();
    if (!ALLOWED_INCLUDES.has(name)) {
      push('include', `#include <${name}> is not permitted; include only <AtechApp.h> and standard headers`,
           lineOf(stripped, include.index));
    }
  }

  for (const [pattern, label] of FORBIDDEN_APIS) {
    const match = stripped.match(pattern);
    if (match) {
      push('forbidden-api', `Generated code may not use ${label} (found "${match[0].trim()}")`,
           lineOf(stripped, match.index));
    }
  }

  let gpio;
  GPIO_CALLS.lastIndex = 0;
  while ((gpio = GPIO_CALLS.exec(stripped)) !== null) {
    const pin = Number(gpio[2]);
    if (!ALLOWED_PINS.includes(pin)) {
      push('gpio', `${gpio[1]}() on GPIO ${pin} is not permitted; allowed pins: ${ALLOWED_PINS.join(', ')}`,
           lineOf(stripped, gpio.index));
    }
  }

  const bypass = stripped.match(MACRO_BYPASS);
  if (bypass) {
    push('app-macro-bypass', `Redefining ${bypass[2]} bypasses the GPIO guard`, lineOf(stripped, bypass.index));
  }

  return {ok: violations.length === 0, violations};
}

module.exports = {checkSource, ALLOWED_INCLUDES, MAX_SOURCE_BYTES, stripCommentsAndStrings};
