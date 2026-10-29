'use strict';
// The entrypoint must hand the backend a dashboard key that survives restarts: the backend
// generates a fresh random key on every start of a non-loopback listener unless one is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRYPOINT = path.join(__dirname, 'entrypoint.sh');
const PRINT_KEY = ['node', '-e', "process.stdout.write(process.env.ATECH_BUILDER_KEY || '')"];

// The entrypoint execs its arguments (the image's CMD is the backend), so the test runs a
// command that prints the key the backend would have received.
function runEntrypoint(env) {
  const result = spawnSync('sh', [ENTRYPOINT, ...PRINT_KEY], {env: {PATH: process.env.PATH, ...env}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('entrypoint generates a dashboard key once and reuses it on the next start', () => {
  const buildsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-entry-'));
  const first = runEntrypoint({ATECH_BUILDS_DIR: buildsDir});
  const second = runEntrypoint({ATECH_BUILDS_DIR: buildsDir});
  assert.ok(first.length >= 24, `key too short: ${first}`);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.equal(second, first);
  const keyFile = path.join(buildsDir, 'dashboard.key');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), first);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  fs.rmSync(buildsDir, {recursive: true, force: true});
});

test('entrypoint keeps a configured ATECH_BUILDER_KEY and writes no file', () => {
  const buildsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-entry-'));
  assert.equal(runEntrypoint({ATECH_BUILDS_DIR: buildsDir, ATECH_BUILDER_KEY: 'fixed-key'}), 'fixed-key');
  assert.equal(fs.existsSync(path.join(buildsDir, 'dashboard.key')), false);
  fs.rmSync(buildsDir, {recursive: true, force: true});
});
