'use strict';
// warm-cache.js drives the real workspace pipeline with the stock app; these tests pin the
// sequence with fakes so the script cannot silently skip a demo or ignore a failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {warm, parseArgs} = require('./warm-cache');
const {loadConfig} = require('../builder/lib/config');

function fakes({compileOk = true, installCode = 0} = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      prepareWorkspace: async (demo, {code, meta}, {config}) => {
        calls.push(['prepare', demo, meta.buildId, code.length > 0]);
        return {dir: path.join(config.buildsDir, 'workspaces', `demo${demo}`)};
      },
      runPio: async (args, {cwd}) => { calls.push(['pio', ...args, path.basename(cwd)]); return {code: installCode, log: ''}; },
      compileWorkspace: async (demo, dir) => { calls.push(['compile', demo, path.basename(dir)]); return {ok: compileOk, log: '', diagnostics: []}; },
      ensureBaseBuild: async (demo, {force}) => { calls.push(['base', demo, force]); return {built: true}; },
    },
  };
}

test('parseArgs recognises --install-only and --base', () => {
  assert.deepEqual(parseArgs([]), {installOnly: false, base: false});
  assert.deepEqual(parseArgs(['--install-only']), {installOnly: true, base: false});
  assert.deepEqual(parseArgs(['--base', '--install-only']), {installOnly: true, base: true});
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

test('warm prepares both workspaces with the stock app, installs their packages and compiles', async () => {
  const {calls, deps} = fakes();
  const ok = await warm({installOnly: false, base: false}, {config: loadConfig({}), deps, log: () => {}});
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ['prepare', 1, 'warmcache', true], ['pio', 'pkg', 'install', '-e', 'ai', 'demo1'], ['compile', 1, 'demo1'],
    ['prepare', 2, 'warmcache', true], ['pio', 'pkg', 'install', '-e', 'ai', 'demo2'], ['compile', 2, 'demo2'],
  ]);
});

test('warm --install-only skips the compile and --base rebuilds the USB installer images', async () => {
  const {calls, deps} = fakes();
  assert.equal(await warm({installOnly: true, base: true}, {config: loadConfig({}), deps, log: () => {}}), true);
  assert.deepEqual(calls.filter(c => c[0] !== 'prepare' && c[0] !== 'pio'), [['base', 1, true], ['base', 2, true]]);
});

test('warm reports failure when a compile or install fails', async () => {
  assert.equal(await warm({installOnly: false, base: false}, {config: loadConfig({}), deps: fakes({compileOk: false}).deps, log: () => {}}), false);
  assert.equal(await warm({installOnly: true, base: false}, {config: loadConfig({}), deps: fakes({installCode: 1}).deps, log: () => {}}), false);
});

test('the stock app source exists for both demos', () => {
  for (const demo of [1, 2]) assert.ok(fs.existsSync(path.join(loadConfig({}).demos[demo].dir, 'src', 'app', 'user_app.cpp')));
});
