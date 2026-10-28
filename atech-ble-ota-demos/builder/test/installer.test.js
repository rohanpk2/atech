'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {manifest, partFile, PART_OFFSETS} = require('../lib/installer');
const {loadConfig} = require('../lib/config');

test('manifest lists the four parts at the ESP32-S3 offsets', () => {
  const config = loadConfig({});
  const result = manifest(1, {config});
  assert.equal(result.builds.length, 1);
  assert.equal(result.builds[0].chipFamily, 'ESP32-S3');
  assert.equal(result.new_install_prompt_erase, true);
  assert.equal(result.new_install_improv_wait_time, 0);
  assert.deepEqual(result.builds[0].parts.map(p => p.offset), [0, 32768, 57344, 65536]);
  assert.deepEqual(result.builds[0].parts.map(p => p.path), [
    '/api/installer/1/parts/bootloader.bin', '/api/installer/1/parts/partitions.bin',
    '/api/installer/1/parts/boot_app0.bin', '/api/installer/1/parts/firmware.bin',
  ]);
  assert.deepEqual(PART_OFFSETS, {'bootloader.bin': 0, 'partitions.bin': 0x8000, 'boot_app0.bin': 0xE000, 'firmware.bin': 0x10000});
});

test('partFile resolves build artifacts and the framework boot_app0', () => {
  const config = loadConfig({});
  assert.equal(partFile(2, 'firmware.bin', {config}), path.join(config.demos[2].dir, '.pio', 'build', 'base', 'firmware.bin'));
  assert.equal(partFile(1, 'boot_app0.bin', {config}), config.bootApp0);
  assert.equal(partFile(1, '../secret', {config}), null);
});
