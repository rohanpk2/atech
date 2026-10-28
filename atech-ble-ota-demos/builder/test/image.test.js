'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {parseImage, validateImage} = require('../lib/image');

const SLOT = 6 * 1024 * 1024;
const MARGIN = 64 * 1024;

function syntheticImage({size = 4096, chipId = 9, flashNibble = 4, appDesc = 0xABCD5432,
                         markers = ['ATECH-OTA-APP-DEMO1', 'ATECH-BUILD:abcd1234']} = {}) {
  const buf = Buffer.alloc(size);
  buf[0] = 0xE9;
  buf[1] = 4;                      // segment count
  buf[2] = 0;                      // spi mode
  buf[3] = (flashNibble << 4) | 0; // flash size nibble | speed
  buf.writeUInt16LE(chipId, 12);
  buf.writeUInt32LE(appDesc, 32);
  let offset = 1024;
  for (const marker of markers) {
    buf.write(marker, offset, 'latin1');
    offset += marker.length + 1;
  }
  return buf;
}

test('parseImage reads the header fields', () => {
  const info = parseImage(syntheticImage());
  assert.equal(info.magic, 0xE9);
  assert.equal(info.segmentCount, 4);
  assert.equal(info.chipId, 9);
  assert.equal(info.flashSizeCode, 4);
  assert.equal(info.appDescMagic, 0xABCD5432);
});

test('a good image passes validation', () => {
  const result = validateImage(syntheticImage(), {
    slotSize: SLOT, sizeMargin: MARGIN, markers: ['ATECH-OTA-APP-DEMO1', 'ATECH-BUILD:abcd1234'],
  });
  assert.deepEqual(result, {ok: true, errors: [], size: 4096, chipId: 9});
});

test('wrong chip id is reported', () => {
  const result = validateImage(syntheticImage({chipId: 0}), {slotSize: SLOT, sizeMargin: MARGIN, markers: []});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /chip/i.test(e)));
});

test('wrong flash size nibble is reported', () => {
  const result = validateImage(syntheticImage({flashNibble: 2}), {slotSize: SLOT, sizeMargin: MARGIN, markers: []});
  assert.ok(result.errors.some(e => /16MB/.test(e)));
});

test('bootloader-like images without an app descriptor are reported', () => {
  const result = validateImage(syntheticImage({appDesc: 0}), {slotSize: SLOT, sizeMargin: MARGIN, markers: []});
  assert.ok(result.errors.some(e => /application/i.test(e)));
});

test('a missing marker names the marker', () => {
  const result = validateImage(syntheticImage(), {slotSize: SLOT, sizeMargin: MARGIN, markers: ['ATECH-OTA-APP-DEMO2']});
  assert.ok(result.errors.some(e => e.includes('ATECH-OTA-APP-DEMO2')));
});

test('an image that does not fit the slot with margin is reported', () => {
  const result = validateImage(syntheticImage({size: SLOT - 1000}), {slotSize: SLOT, sizeMargin: MARGIN, markers: []});
  assert.ok(result.errors.some(e => /slot/i.test(e)));
});

test('real Demo 1 base build passes and its bootloader fails', {skip: !fs.existsSync(
  path.join(__dirname, '..', '..', 'demo1-custom-gatt', '.pio', 'build', 'base', 'firmware.bin'))}, () => {
  const buildDir = path.join(__dirname, '..', '..', 'demo1-custom-gatt', '.pio', 'build', 'base');
  const firmware = fs.readFileSync(path.join(buildDir, 'firmware.bin'));
  const result = validateImage(firmware, {slotSize: SLOT, sizeMargin: MARGIN,
    markers: ['ATECH-OTA-APP-DEMO1', 'ATECH-BUILD:stock']});
  assert.equal(result.ok, true, result.errors.join('; '));
  const bootloader = fs.readFileSync(path.join(buildDir, 'bootloader.bin'));
  assert.equal(validateImage(bootloader, {slotSize: SLOT, sizeMargin: MARGIN, markers: []}).ok, false);
});
