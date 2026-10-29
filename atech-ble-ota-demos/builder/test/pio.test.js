'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseDiagnostics, runPio} = require('../lib/pio');

const SAMPLE_LOG = [
  'Compiling .pio/build/ai/src/app/user_app.cpp.o',
  'src/app/user_app.cpp:12:5: error: \'ledd\' was not declared in this scope',
  '   12 |     ledd.set(0, 0, 40);',
  'src/app/user_app.cpp:20:3: warning: unused variable \'x\' [-Wunused-variable]',
  '/abs/path/src/app/user_app.cpp:30:1: error: expected \';\' before \'}\' token',
  'Linking .pio/build/ai/firmware.elf',
  '/toolchain/ld: .pio/build/ai/libAtechCore.a(AtechCore.cpp.o): in function `appTaskMain\':',
  'AtechCore.cpp:(.text+0x1c): undefined reference to `appLoop()\'',
  '*** [.pio/build/ai/firmware.elf] Error 1',
].join('\n');

test('parseDiagnostics extracts compiler errors, warnings and linker errors', () => {
  const diagnostics = parseDiagnostics(SAMPLE_LOG);
  assert.equal(diagnostics.length, 4);
  assert.deepEqual(diagnostics[0], {
    file: 'src/app/user_app.cpp', line: 12, col: 5, severity: 'error',
    message: '\'ledd\' was not declared in this scope',
  });
  assert.equal(diagnostics[1].severity, 'warning');
  assert.equal(diagnostics[2].line, 30);
  assert.equal(diagnostics[3].severity, 'error');
  assert.match(diagnostics[3].message, /undefined reference to `appLoop\(\)'/);
  assert.equal(diagnostics.filter(d => d.severity === 'error').length, 3);
});

test('parseDiagnostics returns an empty list for a clean log', () => {
  assert.deepEqual(parseDiagnostics('Building...\n[SUCCESS] Took 1.00 seconds'), []);
});

test('runPio executes the real PlatformIO binary through the queue', async () => {
  const result = await runPio(['--version'], {cwd: __dirname, timeoutMs: 60000});
  assert.equal(result.code, 0);
  assert.match(result.log, /PlatformIO/);
});

// `echo` as the binary turns the argv into the log, so the test sees exactly what pio would receive.
test('runPio passes -j to pio run only when jobs is set', async () => {
  assert.equal((await runPio(['run', '-e', 'ai'], {pioBin: 'echo', jobs: 1})).log.trim(), 'run -e ai -j 1');
  assert.equal((await runPio(['run', '-e', 'ai'], {pioBin: 'echo', jobs: null})).log.trim(), 'run -e ai');
  assert.equal((await runPio(['system', 'info'], {pioBin: 'echo', jobs: 1})).log.trim(), 'system info');
});
