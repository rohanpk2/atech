'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/gpio-policy');

test('ALLOWED_PINS is exactly the DevKitC-1 N16R8 safe set', () => {
  assert.deepEqual(policy.ALLOWED_PINS,
    [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47]);
});

test('reserved pins are refused with a reason', () => {
  assert.equal(policy.isPinAllowed(48), false);
  assert.equal(policy.isPinAllowed(0), false);
  assert.equal(policy.isPinAllowed(19), false);
  assert.equal(policy.isPinAllowed(35), false);
  assert.equal(policy.isPinAllowed(4), true);
  assert.match(policy.RESERVED[48], /LED/);
  assert.match(policy.RESERVED[0], /BOOT/);
});

test('describe() lists allowed pins and every reserved reason', () => {
  const text = policy.describe();
  assert.match(text, /1, 2, 4/);
  assert.match(text, /48/);
  assert.match(text, /USB/);
});
