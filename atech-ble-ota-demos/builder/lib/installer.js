'use strict';

// ESP Web Tools manifest and parts for the one-time USB baseline install.
// Offsets are the standard Arduino-ESP32 layout for the ESP32-S3.
const fs = require('node:fs');
const path = require('node:path');
const {loadConfig} = require('./config');
const {runPio} = require('./pio');

const PART_OFFSETS = Object.freeze({
  'bootloader.bin': 0x0,
  'partitions.bin': 0x8000,
  'boot_app0.bin': 0xE000,
  'firmware.bin': 0x10000,
});
const PART_ORDER = ['bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin'];

function manifest(demo, {config = loadConfig()} = {}) {
  const entry = config.demos[demo];
  return {
    name: `Atech ${entry ? entry.name : `Demo ${demo}`} baseline`,
    version: 'base',
    home_assistant_domain: undefined,
    new_install_prompt_erase: true,
    new_install_improv_wait_time: 0,
    builds: [{
      chipFamily: 'ESP32-S3',
      parts: PART_ORDER.map(name => ({path: `/api/installer/${demo}/parts/${name}`, offset: PART_OFFSETS[name]})),
    }],
  };
}

function partFile(demo, name, {config = loadConfig()} = {}) {
  const entry = config.demos[demo];
  if (!entry || !Object.hasOwn(PART_OFFSETS, name)) return null;
  if (name === 'boot_app0.bin') return config.bootApp0;
  return path.join(entry.dir, '.pio', 'build', 'base', name);
}

function newestMtime(dir) {
  let newest = 0;
  const walk = current => {
    for (const item of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

function baseBuildIsStale(demo, {config = loadConfig()} = {}) {
  const entry = config.demos[demo];
  const firmware = path.join(entry.dir, '.pio', 'build', 'base', 'firmware.bin');
  if (!fs.existsSync(firmware)) return true;
  const built = fs.statSync(firmware).mtimeMs;
  return newestMtime(path.join(entry.dir, 'src')) > built || newestMtime(config.sharedDir) > built;
}

async function ensureBaseBuild(demo, {config = loadConfig(), force = false, onLine} = {}) {
  const entry = config.demos[demo];
  if (!entry) throw new Error(`Unknown demo ${demo}`);
  if (!force && !baseBuildIsStale(demo, {config})) return {dir: entry.dir, built: false};
  const result = await runPio(['run', '-e', 'base'], {cwd: entry.dir, onLine, pioBin: config.pio, jobs: config.pioJobs ?? null});
  if (result.code !== 0) throw new Error(`Base build for demo ${demo} failed (exit ${result.code})`);
  return {dir: entry.dir, built: true, log: result.log};
}

module.exports = {manifest, partFile, ensureBaseBuild, baseBuildIsStale, PART_OFFSETS, PART_ORDER};
