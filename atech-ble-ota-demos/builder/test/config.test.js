'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadDotEnv} = require('../lib/config');

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
