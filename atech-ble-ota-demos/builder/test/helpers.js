'use strict';
// Shared fakes for the job pipeline and server tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadConfig} = require('../lib/config');

function tempConfig(overrides = {}) {
  const buildsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-jobs-'));
  return {...loadConfig({}), buildsDir, maxRepairs: 3, ...overrides};
}

function syntheticFirmware(markers, size = 4096) {
  const buf = Buffer.alloc(size);
  buf[0] = 0xE9; buf[1] = 4; buf[3] = 0x40;
  buf.writeUInt16LE(9, 12);
  buf.writeUInt32LE(0xABCD5432, 32);
  let offset = 1024;
  for (const marker of markers) { buf.write(marker, offset, 'latin1'); offset += marker.length + 1; }
  return buf;
}

const GOOD_CODE = '#include <AtechApp.h>\nvoid appSetup() {}\nvoid appLoop() { led.set(0, 0, 40); delay(100); led.off(); delay(100); }\n';
const BAD_PIN_CODE = GOOD_CODE.replace('void appSetup() {}', 'void appSetup() { pinMode(45, OUTPUT); }');

function fakeProvider(responses) {
  const calls = [];
  return {
    name: 'fake', model: 'fake-model', calls,
    async generate({system, messages}) {
      calls.push({system, messages});
      const next = responses.shift();
      if (!next) throw new Error('fake provider has no more responses');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

// compileResults: array of {ok, diagnostics?, withBuildMarker?} consumed per call.
function fakeWorkspace(compileResults) {
  const prepared = [];
  const compiled = [];
  return {
    prepared, compiled,
    async prepareWorkspace(demo, {code, meta}, {config}) {
      const dir = path.join(config.buildsDir, 'workspaces', `demo${demo}`);
      fs.mkdirSync(path.join(dir, '.pio', 'build', 'ai'), {recursive: true});
      prepared.push({demo, code, meta});
      return {dir};
    },
    async compileWorkspace(demo, dir, {config, onLine}) {
      const spec = compileResults.shift() || {ok: true};
      compiled.push({demo, dir, spec});
      if (onLine) ['Compiling user_app.cpp', spec.ok ? '[SUCCESS]' : 'error: boom'].forEach(onLine);
      const firmwarePath = path.join(dir, '.pio', 'build', 'ai', 'firmware.bin');
      if (!spec.ok) {
        return {ok: false, code: 1, timedOut: false, log: 'build log\nerror', firmwarePath: null,
                diagnostics: spec.diagnostics || [{file: 'src/app/user_app.cpp', line: 3, col: 1, severity: 'error', message: "'ledd' was not declared in this scope"}]};
      }
      const meta = prepared[prepared.length - 1].meta;
      const markers = [config.demos[demo].imageIdentity];
      if (spec.withBuildMarker !== false) markers.push(`ATECH-BUILD:${meta.buildId}`);
      if (spec.withAgentMarker !== false) markers.push('ATECH-CLOUD-AGENT:1');
      if (spec.withProvMarker !== false) markers.push('ATECH-PROV:1');
      fs.writeFileSync(firmwarePath, syntheticFirmware(markers));
      return {ok: true, code: 0, timedOut: false, log: 'build log\n[SUCCESS]', firmwarePath, diagnostics: []};
    },
  };
}

module.exports = {tempConfig, syntheticFirmware, GOOD_CODE, BAD_PIN_CODE, fakeProvider, fakeWorkspace};
