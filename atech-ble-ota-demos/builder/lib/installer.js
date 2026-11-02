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
  // An image built for another server URL (or before one was configured) must be rebuilt.
  if ((readStamp(entry) || '') !== (config.publicUrl || '')) return true;
  const built = fs.statSync(firmware).mtimeMs;
  return newestMtime(path.join(entry.dir, 'src')) > built || newestMtime(config.sharedDir) > built;
}

// The USB baseline carries the backend's public URL too, so a freshly installed board knows
// where to report without typing anything on the hotspot page. PLATFORMIO_BUILD_FLAGS is split
// like a shell line (shlex), so the inner double quotes only survive inside single quotes.
function buildFlagsEnv(config) {
  if (!config.publicUrl) return {};
  return {PLATFORMIO_BUILD_FLAGS: `'-DATECH_CLOUD_URL="${String(config.publicUrl).replace(/["'\\\s]/g, '')}"'`};
}

// Records which server URL a base image was built with, next to firmware.bin.
const BASE_STAMP = 'atech-cloud-url.stamp';

function stampPath(entry) { return path.join(entry.dir, '.pio', 'build', 'base', BASE_STAMP); }

function readStamp(entry) {
  try { return fs.readFileSync(stampPath(entry), 'utf8'); } catch { return null; }
}

async function ensureBaseBuild(demo, {config = loadConfig(), force = false, onLine} = {}) {
  const entry = config.demos[demo];
  if (!entry) throw new Error(`Unknown demo ${demo}`);
  if (!force && !baseBuildIsStale(demo, {config})) return {dir: entry.dir, built: false};
  const result = await runPio(['run', '-e', 'base'], {cwd: entry.dir, onLine, pioBin: config.pio, jobs: config.pioJobs ?? null,
                                                      env: buildFlagsEnv(config)});
  if (result.code !== 0) throw new Error(`Base build for demo ${demo} failed (exit ${result.code})`);
  try { fs.writeFileSync(stampPath(entry), config.publicUrl || ''); } catch { /* the next check rebuilds */ }
  return {dir: entry.dir, built: true, log: result.log};
}

// Base builds in the background, one at a time per demo. A dashboard reaches the backend through
// a proxy with its own request timeout (Vercel), so POST /build cannot hold a connection open for a
// multi-minute compile: it starts the build here and the page polls GET /status for the outcome.
function createBaseBuildTracker({ensure = ensureBaseBuild} = {}) {
  const states = new Map();
  const blank = () => ({building: false, startedAt: null, finishedAt: null, built: null, error: null});
  const state = demo => ({...(states.get(Number(demo)) || blank())});
  function start(demo, {config, force = false, onLine} = {}) {
    const key = Number(demo);
    const current = states.get(key);
    if (current && current.building) return {...current};
    const next = {...blank(), building: true, startedAt: new Date().toISOString()};
    states.set(key, next);
    let run;
    try { run = Promise.resolve(ensure(key, {config, force, onLine})); } catch (error) { run = Promise.reject(error); }
    run.then(result => { states.set(key, {...next, building: false, finishedAt: new Date().toISOString(), built: Boolean(result && result.built)}); },
            error => { states.set(key, {...next, building: false, finishedAt: new Date().toISOString(), error: error.message || String(error)}); });
    return {...next};
  }
  return {start, state};
}

module.exports = {manifest, partFile, ensureBaseBuild, baseBuildIsStale, buildFlagsEnv, createBaseBuildTracker,
                  PART_OFFSETS, PART_ORDER, BASE_STAMP};
