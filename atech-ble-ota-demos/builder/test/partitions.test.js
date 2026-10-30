'use strict';

// The partition table decides the OTA slot size; both demos must share it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {parsePartitions, appSlots, slotSizeFromCsv} = require('../lib/partitions');
const {loadConfig} = require('../lib/config');

const config = loadConfig({});
const demo1Csv = path.join(config.demos[1].dir, 'partitions.csv');
const demo2Csv = path.join(config.demos[2].dir, 'partitions.csv');

test('parsePartitions reads the demo table', () => {
  const parts = parsePartitions(fs.readFileSync(demo1Csv, 'utf8'));
  assert.deepEqual(parts.map(p => p.name), ['nvs', 'otadata', 'ota_0', 'ota_1', 'spiffs']);
  assert.equal(parts[2].type, 'app');
  assert.equal(parts[2].subtype, 'ota_0');
  assert.equal(parts[2].offset, 0x10000);
  assert.equal(parts[2].size, 0x600000);
  assert.equal(parts[3].offset, 0x610000);
});

test('parsePartitions accepts decimal sizes and ignores comments and blank lines', () => {
  const parts = parsePartitions('# comment\n\nnvs, data, nvs, 0x9000, 20480,\napp0, app, ota_0, 65536, 1M,\n');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].size, 20480);
  assert.equal(parts[1].offset, 65536);
  assert.equal(parts[1].size, 1024 * 1024);
});

test('both demos share one table with two equal 6 MiB app slots', () => {
  const one = parsePartitions(fs.readFileSync(demo1Csv, 'utf8'));
  const two = parsePartitions(fs.readFileSync(demo2Csv, 'utf8'));
  assert.deepEqual(one, two);
  const slots = appSlots(one);
  assert.equal(slots.ota0, 6291456);
  assert.equal(slots.ota1, 6291456);
  assert.equal(slotSizeFromCsv(demo1Csv), 6291456);
});

test('appSlots throws when a slot is missing', () => {
  const parts = parsePartitions('nvs, data, nvs, 0x9000, 0x5000,\nota_0, app, ota_0, 0x10000, 0x600000,\n');
  assert.throws(() => appSlots(parts), /ota_1/);
});
