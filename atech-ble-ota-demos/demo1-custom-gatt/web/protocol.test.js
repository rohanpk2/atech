'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  crc32,
  buildStartPacket,
  validateEsp32S3Application,
} = require('./protocol.js');

assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);

const start = buildStartPacket(0x12345678, 0x90ABCDEF);
assert.deepEqual([...start], [1, 0x78, 0x56, 0x34, 0x12, 0xEF, 0xCD, 0xAB, 0x90]);

const sample = new Uint8Array(36);
const sampleView = new DataView(sample.buffer);
sample[0] = 0xE9;
sampleView.setUint16(12, 9, true);
sampleView.setUint32(32, 0xABCD5432, true);
assert.doesNotThrow(() => validateEsp32S3Application(sample));

sampleView.setUint16(12, 0, true);
assert.throws(() => validateEsp32S3Application(sample), /not ESP32-S3/);

const buildRoot = path.join(__dirname, '..', '.pio', 'build');
const firmwarePath = path.join(buildRoot, 'updated', 'firmware.bin');
const bootloaderPath = path.join(buildRoot, 'base', 'bootloader.bin');
if (fs.existsSync(firmwarePath)) {
  const firmware = new Uint8Array(fs.readFileSync(firmwarePath));
  assert.doesNotThrow(() => validateEsp32S3Application(firmware));
}
if (fs.existsSync(bootloaderPath)) {
  const bootloader = new Uint8Array(fs.readFileSync(bootloaderPath));
  assert.throws(() => validateEsp32S3Application(bootloader), /not an ESP application image/);
}

console.log('Custom GATT browser protocol tests passed');
