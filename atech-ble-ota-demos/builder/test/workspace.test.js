'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadConfig} = require('../lib/config');
const {rewritePlatformioIni, renderAppBuildHeader, prepareWorkspace, compileWorkspace} = require('../lib/workspace');

const baseConfig = loadConfig({});
const demo1Ini = fs.readFileSync(path.join(baseConfig.demos[1].dir, 'platformio.ini'), 'utf8');

function tempConfig() {
  const buildsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-builds-'));
  return {...baseConfig, buildsDir};
}

test('rewritePlatformioIni points lib_extra_dirs at the absolute shared dir and adds a build cache', () => {
  const out = rewritePlatformioIni(demo1Ini, {sharedDir: '/abs/shared', cacheDir: '/abs/cache'});
  assert.match(out, /^lib_extra_dirs = \/abs\/shared$/m);
  assert.match(out, /^build_cache_dir = \/abs\/cache$/m);
  assert.match(out, /\[env:base\]/);
  assert.match(out, /\[env:ai\]/);
  assert.doesNotMatch(out, /lib_extra_dirs = \.\.\/shared/);
});

test('rewritePlatformioIni adds [env:ai] when the project lacks one', () => {
  const stripped = demo1Ini.replace(/\n;[^\n]*\n;[^\n]*\n\[env:ai\][^\n]*\n[^\n]*\n?/, '\n');
  assert.doesNotMatch(stripped, /\[env:ai\]/);
  const out = rewritePlatformioIni(stripped, {sharedDir: '/s', cacheDir: '/c'});
  assert.match(out, /\[env:ai\]\nbuild_flags = \$\{env\.build_flags\} -DDEMO_VERSION=3 -DATECH_AI_BUILD=1/);
});

test('renderAppBuildHeader escapes strings and keeps the version numeric', () => {
  const header = renderAppBuildHeader({buildId: 'ab12cd34', appName: 'Say "hi"', appVersion: 7,
                                       targetDeviceId: 'ATECH-AABBCCDDEEFF'});
  assert.match(header, /#define ATECH_BUILD_ID "ab12cd34"/);
  assert.match(header, /#define ATECH_APP_NAME "Say \\"hi\\""/);
  assert.match(header, /#define ATECH_APP_VERSION 7$/m);
  assert.match(header, /#define ATECH_TARGET_DEVICE_ID "ATECH-AABBCCDDEEFF"/);
});

test('prepareWorkspace copies the core sources and writes the generated app', async () => {
  const config = tempConfig();
  const code = '#include <AtechApp.h>\nvoid appSetup() {}\nvoid appLoop() { delay(10); }\n';
  const meta = {buildId: 'deadbeef', appName: 'Test', appVersion: 3, targetDeviceId: ''};
  const {dir} = await prepareWorkspace(1, {code, meta}, {config});
  assert.equal(dir, path.join(config.buildsDir, 'workspaces', 'demo1'));
  assert.ok(fs.existsSync(path.join(dir, 'platformio.ini')));
  assert.ok(fs.existsSync(path.join(dir, 'partitions.csv')));
  assert.ok(fs.existsSync(path.join(dir, 'src', 'main.cpp')));
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'app', 'user_app.cpp'), 'utf8'), code);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'app', 'app_build.h'), 'utf8'), /deadbeef/);
  assert.match(fs.readFileSync(path.join(dir, 'platformio.ini'), 'utf8'),
               new RegExp(`lib_extra_dirs = ${config.sharedDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // A second job overwrites the generated file in the persistent workspace.
  const second = await prepareWorkspace(1, {code: code + '// v2\n', meta}, {config});
  assert.equal(second.dir, dir);
  assert.match(fs.readFileSync(path.join(dir, 'src', 'app', 'user_app.cpp'), 'utf8'), /\/\/ v2/);
  fs.rmSync(config.buildsDir, {recursive: true, force: true});
});

test('compileWorkspace builds the stock app for real', {skip: !process.env.ATECH_REAL_BUILD}, async () => {
  const config = tempConfig();
  const code = fs.readFileSync(path.join(config.demos[1].dir, 'src', 'app', 'user_app.cpp'), 'utf8');
  const meta = {buildId: 'realtest', appName: 'Real build test', appVersion: 3, targetDeviceId: ''};
  const {dir} = await prepareWorkspace(1, {code, meta}, {config});
  const lines = [];
  const result = await compileWorkspace(1, dir, {config, onLine: line => lines.push(line)});
  assert.equal(result.ok, true, result.diagnostics.map(d => d.message).join('\n'));
  assert.ok(fs.existsSync(result.firmwarePath));
  assert.ok(lines.length > 10);
  assert.deepEqual(result.diagnostics.filter(d => d.severity === 'error'), []);
});
