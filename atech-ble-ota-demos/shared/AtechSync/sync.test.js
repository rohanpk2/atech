'use strict';

// Compiles the portable AtechSync engine (SyncCodec, SyncStore, SyncEngine) with the host C++
// compiler and runs the tests in test/host/. The engine has no Arduino dependency on purpose:
// the protocol, versioning, retries and reconciliation are proven here, on real C++, while the
// ESP32 wrapper (AtechSync.cpp) is pinned by wiring.test.js. Skips when no compiler is present.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = __dirname;
const src = path.join(root, 'src');
const hostDir = path.join(root, 'test', 'host');

function findCompiler() {
  for (const candidate of ['clang++', 'c++', 'g++']) {
    const probe = spawnSync(candidate, ['--version'], {encoding: 'utf8'});
    if (probe.status === 0) return candidate;
  }
  return null;
}

const compiler = findCompiler();
if (!compiler) {
  console.log('AtechSync host tests skipped: no C++ compiler (clang++, c++ or g++) on PATH');
  process.exit(0);
}

const sources = ['SyncCodec.cpp', 'SyncStore.cpp', 'SyncEngine.cpp']
  .map(name => path.join(src, name)).filter(file => fs.existsSync(file));
const tests = fs.readdirSync(hostDir).filter(name => name.endsWith('_test.cpp')).sort();
if (!tests.length) { console.error('no host tests found in', hostDir); process.exit(1); }
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-sync-host-'));
let failed = false;
for (const test of tests) {
  const binary = path.join(outDir, test.replace(/\.cpp$/, ''));
  const build = spawnSync(compiler, ['-std=c++17', '-Wall', '-Wextra', '-O1', '-I', src, '-I', hostDir,
                                     path.join(hostDir, test), ...sources, '-o', binary], {encoding: 'utf8'});
  if (build.status !== 0) {
    console.error(`compile failed for ${test}:\n${build.stdout}${build.stderr}`);
    failed = true;
    continue;
  }
  if (build.stderr.trim()) console.log(build.stderr.trim());
  const run = spawnSync(binary, [], {encoding: 'utf8', timeout: 60000});
  process.stdout.write(run.stdout || '');
  if (run.status !== 0) { console.error(`${test} failed (exit ${run.status})\n${run.stderr || ''}`); failed = true; }
}
fs.rmSync(outDir, {recursive: true, force: true});
if (failed) process.exit(1);
console.log('AtechSync host tests passed');
