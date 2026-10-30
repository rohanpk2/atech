'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {manifest, partFile, baseBuildIsStale, ensureBaseBuild, PART_OFFSETS, BASE_STAMP} = require('../lib/installer');
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

// A demo directory with a built base image, so staleness can be checked without PlatformIO.
function fakeDemo(stamp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-demo-'));
  fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'src', 'main.cpp'), '// old');
  const build = path.join(dir, '.pio', 'build', 'base');
  fs.mkdirSync(build, {recursive: true});
  fs.writeFileSync(path.join(build, 'firmware.bin'), 'fw');
  if (stamp !== undefined) fs.writeFileSync(path.join(build, BASE_STAMP), stamp);
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(build, 'firmware.bin'), future, future);
  return dir;
}

test('the base image is stale when it was built for a different cloud server URL', () => {
  const config = loadConfig({});
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-shared-'));
  const demo = {...config.demos[1], dir: fakeDemo('https://old.example')};
  const withOld = {...config, sharedDir: shared, publicUrl: 'https://old.example', demos: {...config.demos, 1: demo}};
  assert.equal(baseBuildIsStale(1, {config: withOld}), false, 'same URL, fresh image');
  assert.equal(baseBuildIsStale(1, {config: {...withOld, publicUrl: 'https://new.example'}}), true, 'the URL changed');
  assert.equal(baseBuildIsStale(1, {config: {...withOld, publicUrl: null}}), true, 'the URL was removed');
  const unstamped = {...config, sharedDir: shared, publicUrl: 'https://old.example', demos: {...config.demos, 1: {...demo, dir: fakeDemo()}}};
  assert.equal(baseBuildIsStale(1, {config: unstamped}), true, 'an image built before the URL existed');
  assert.equal(baseBuildIsStale(1, {config: {...unstamped, publicUrl: null}}), false, 'no URL wanted and none stamped');
});

test('ensureBaseBuild bakes the public URL into the base image for real', {skip: !process.env.ATECH_REAL_BUILD}, async () => {
  const config = {...loadConfig({}), publicUrl: 'https://cloud.example.test'};
  const result = await ensureBaseBuild(1, {config, force: true});
  assert.equal(result.built, true);
  const image = fs.readFileSync(path.join(config.demos[1].dir, '.pio', 'build', 'base', 'firmware.bin'));
  assert.ok(image.indexOf('https://cloud.example.test', 0, 'latin1') >= 0, 'the URL string is in the image');
  assert.equal(fs.readFileSync(path.join(config.demos[1].dir, '.pio', 'build', 'base', BASE_STAMP), 'utf8'), 'https://cloud.example.test');
  assert.equal(baseBuildIsStale(1, {config}), false);
});
