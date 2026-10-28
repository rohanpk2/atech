'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {checkSource} = require('../lib/source-policy');

const GOOD = `#include <AtechApp.h>
#include <math.h>

static int phase = 0;

void appSetup() {
  pinMode(4, OUTPUT);
  atech::log("ready");
}

void appLoop() {
  for (int i = 0; i < 3; i++) {
    led.set(0, 0, 60);
    delay(100);
    led.off();
    delay(100);
  }
  digitalWrite(4, HIGH);
  delay(2000);
}
`;

const rules = result => result.violations.map(v => v.rule);

test('a valid blink program passes', () => {
  const result = checkSource(GOOD);
  assert.deepEqual(result, {ok: true, violations: []});
});

test('missing entry points are reported', () => {
  const result = checkSource('#include <AtechApp.h>\nvoid appSetup() {}\n');
  assert.equal(result.ok, false);
  assert.deepEqual(rules(result), ['entry-points']);
  assert.match(result.violations[0].message, /appLoop/);
});

test('defining setup or loop is rejected', () => {
  const result = checkSource(GOOD + '\nvoid setup() {}\nvoid loop() {}\n');
  assert.ok(rules(result).includes('reserved-entry'));
});

test('non-allowlisted includes are rejected', () => {
  const result = checkSource('#include <WiFi.h>\n' + GOOD);
  assert.ok(rules(result).includes('include'));
  assert.match(result.violations.find(v => v.rule === 'include').message, /WiFi\.h/);
});

test('forbidden APIs are rejected even without an include', () => {
  for (const snippet of ['ESP.restart();', 'esp_ota_begin(0, 0, 0);', 'Wire.begin(8, 9);',
                         'Serial1.begin(9600);', 'tone(4, 440);', 'xTaskCreate(0, "x", 1024, 0, 1, 0);']) {
    const result = checkSource(GOOD.replace('delay(2000);', `delay(2000); ${snippet}`));
    assert.ok(rules(result).includes('forbidden-api'), `${snippet} should be refused`);
  }
});

test('a reserved GPIO literal is rejected with its line number', () => {
  const source = GOOD.replace('pinMode(4, OUTPUT);', 'pinMode(45, OUTPUT);');
  const result = checkSource(source);
  const violation = result.violations.find(v => v.rule === 'gpio');
  assert.ok(violation);
  assert.equal(violation.line, 7);
  assert.match(violation.message, /GPIO 45/);
});

test('the onboard LED pin is only reachable through the facade', () => {
  const result = checkSource(GOOD.replace('digitalWrite(4, HIGH);', 'digitalWrite(48, HIGH);'));
  assert.ok(rules(result).includes('gpio'));
});

test('bypassing the guard macros is rejected', () => {
  const result = checkSource('#undef pinMode\n' + GOOD);
  assert.ok(rules(result).includes('app-macro-bypass'));
});

test('comments do not trigger API rules', () => {
  const result = checkSource(GOOD + '\n// WiFi.begin would be wrong here\n/* ESP.restart() too */\n');
  assert.equal(result.ok, true);
});

test('oversized sources are rejected', () => {
  const result = checkSource(GOOD + '\n' + '// x\n'.repeat(20000));
  assert.ok(rules(result).includes('size'));
});
