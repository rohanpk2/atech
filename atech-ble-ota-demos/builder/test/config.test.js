'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadConfig, loadDotEnv} = require('../lib/config');

function tempEnvFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  return file;
}

test('loadDotEnv fills in variables from the file without overriding the shell', () => {
  const file = tempEnvFile('ANTHROPIC_API_KEY=sk-ant-from-file\n# comment\nATECH_LLM_MODEL="claude-opus-5-5"\n');
  const env = {ATECH_LLM_MODEL: 'from-shell'};
  assert.equal(loadDotEnv(file, env), true);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-from-file');
  assert.equal(env.ATECH_LLM_MODEL, 'from-shell');
});

test('loadDotEnv treats blank values as unset so template lines do not shadow other logins', () => {
  const file = tempEnvFile('ANTHROPIC_API_KEY=\nATECH_BUILDER_PORT=""\n');
  const env = {};
  assert.equal(loadDotEnv(file, env), true);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ATECH_BUILDER_PORT, undefined);
});

test('loadDotEnv is a no-op when the file does not exist', () => {
  const env = {};
  assert.equal(loadDotEnv(path.join(os.tmpdir(), 'atech-env-missing', '.env'), env), false);
  assert.deepEqual(env, {});
});

test('loadDotEnv defaults to builder/.env', () => {
  // Resolve the default without reading it: a missing file must still return false.
  const builderDir = path.resolve(__dirname, '..');
  assert.equal(path.resolve(loadDotEnv.defaultFile), path.join(builderDir, '.env'));
});

test('loadConfig honours PLATFORMIO_CORE_DIR for the pio binary and boot_app0', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-pio-core-'));
  assert.equal(loadConfig({PLATFORMIO_CORE_DIR: core}).pio, 'pio', 'no penv yet: fall back to PATH');
  fs.mkdirSync(path.join(core, 'penv', 'bin'), {recursive: true});
  fs.writeFileSync(path.join(core, 'penv', 'bin', 'pio'), '');
  const config = loadConfig({PLATFORMIO_CORE_DIR: core});
  assert.equal(config.pio, path.join(core, 'penv', 'bin', 'pio'));
  assert.equal(config.bootApp0, path.join(core, 'packages', 'framework-arduinoespressif32', 'tools', 'partitions', 'boot_app0.bin'));
  assert.equal(loadConfig({PLATFORMIO_CORE_DIR: core, PLATFORMIO_BIN: '/usr/bin/pio'}).pio, '/usr/bin/pio');
  fs.rmSync(core, {recursive: true, force: true});
});

test('loadConfig falls back to the home directory PlatformIO core when PLATFORMIO_CORE_DIR is unset', () => {
  const config = loadConfig({});
  assert.equal(config.bootApp0, path.join(os.homedir(), '.platformio', 'packages', 'framework-arduinoespressif32', 'tools', 'partitions', 'boot_app0.bin'));
});

test('loadConfig parses ATECH_PIO_JOBS and ignores nonsense', () => {
  assert.equal(loadConfig({}).pioJobs, null);
  assert.equal(loadConfig({ATECH_PIO_JOBS: '2'}).pioJobs, 2);
  assert.equal(loadConfig({ATECH_PIO_JOBS: '0'}).pioJobs, null);
  assert.equal(loadConfig({ATECH_PIO_JOBS: 'lots'}).pioJobs, null);
  assert.equal(loadConfig({ATECH_PIO_JOBS: '1.5'}).pioJobs, null);
});

test('loadConfig derives the OTA slot size from the partition table', () => {
  assert.equal(loadConfig({}).slotSize, 6291456);
});

test('loadConfig accepts an https or http origin as the public URL and nothing else', () => {
  assert.equal(loadConfig({}).publicUrl, null);
  assert.equal(loadConfig({ATECH_PUBLIC_URL: 'https://api.example.com/'}).publicUrl, 'https://api.example.com');
  assert.equal(loadConfig({ATECH_PUBLIC_URL: 'http://127.0.0.1:5199'}).publicUrl, 'http://127.0.0.1:5199');
  assert.equal(loadConfig({ATECH_PUBLIC_URL: 'ftp://x'}).publicUrl, null);
  assert.equal(loadConfig({ATECH_PUBLIC_URL: 'https://api.example.com/api'}).publicUrl, null);
});

test('loadConfig exposes the cloud timings with documented defaults and env overrides', () => {
  const cloud = loadConfig({}).cloud;
  assert.deepEqual(cloud, {pollMs: 15000, jobTtlMs: 30 * 60 * 1000, stallMs: 120000, rebootTimeoutMs: 300000,
                           confirmTimeoutMs: 120000, offlineAfterMs: 45000, maxAttempts: 5, chunkBytes: 131072});
  assert.equal(loadConfig({ATECH_CLOUD_JOB_TTL_MIN: '5'}).cloud.jobTtlMs, 300000);
  assert.equal(loadConfig({ATECH_CLOUD_POLL_MS: '5000'}).cloud.pollMs, 5000);
  assert.equal(loadConfig({ATECH_CLOUD_STALL_S: '30'}).cloud.stallMs, 30000);
  assert.equal(loadConfig({ATECH_CLOUD_OFFLINE_S: '10'}).cloud.offlineAfterMs, 10000);
  assert.equal(loadConfig({ATECH_CLOUD_MAX_ATTEMPTS: 'lots'}).cloud.maxAttempts, 5);
});
