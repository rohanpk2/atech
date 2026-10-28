'use strict';

// Backend configuration. Everything is derived from the repository layout and
// a handful of environment variables so `npm start` works with no setup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..', '..');

function findPio(env) {
  if (env.PLATFORMIO_BIN) return env.PLATFORMIO_BIN;
  const penv = path.join(os.homedir(), '.platformio', 'penv', 'bin', 'pio');
  return fs.existsSync(penv) ? penv : 'pio';
}

function demoEntry(demo, key, name, imageIdentity, blePrefix, ssidPrefix, otaProtocol) {
  const dir = path.join(rootDir, key);
  return {demo, key, name, dir, imageIdentity, blePrefix, ssidPrefix, otaProtocol,
          webDir: path.join(dir, 'web')};
}

function loadConfig(env = process.env) {
  const buildsDir = env.ATECH_BUILDS_DIR ? path.resolve(env.ATECH_BUILDS_DIR)
                                         : path.join(rootDir, '.ai-builds');
  return {
    rootDir,
    buildsDir,
    sharedDir: path.join(rootDir, 'shared'),
    webSharedDir: path.join(rootDir, 'web-shared'),
    demos: {
      1: demoEntry(1, 'demo1-custom-gatt', 'Demo 1 custom GATT OTA', 'ATECH-OTA-APP-DEMO1',
                   'Atech-Custom-OTA', 'Atech-OTA-D1', 'atech-custom-gatt'),
      2: demoEntry(2, 'demo2-bleota-library', 'Demo 2 gb88 BLEOTA', 'ATECH-OTA-APP-DEMO2',
                   'Atech-Library-OTA', 'Atech-OTA-D2', 'gb88-bleota'),
    },
    board: {id: 'esp32-s3-devkitc-1', flashSize: '16MB', memoryType: 'qio_opi', variant: 'N16R8'},
    slotSize: 0x600000,
    sizeMargin: 64 * 1024,
    pio: findPio(env),
    bootApp0: path.join(os.homedir(), '.platformio', 'packages', 'framework-arduinoespressif32',
                        'tools', 'partitions', 'boot_app0.bin'),
    model: env.ATECH_LLM_MODEL || 'claude-opus-5-5',
    maxRepairs: Number.isFinite(Number(env.ATECH_MAX_REPAIRS)) && env.ATECH_MAX_REPAIRS !== undefined
      ? Number(env.ATECH_MAX_REPAIRS) : 3,
    providerOverride: env.ATECH_LLM_PROVIDER || null,
    port: Number(env.ATECH_BUILDER_PORT) || 5173,
    host: env.ATECH_BUILDER_HOST || '127.0.0.1',
  };
}

module.exports = {loadConfig, rootDir};
