'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {redactSecrets, secretsFromEnv} = require('../lib/redact');

test('redactSecrets masks configured secret values and Anthropic key shapes', () => {
  const text = 'auth failed for key sk-ant-api03-ABCDEFGHIJKLMNOP-xyz and token tok_123456789 (tok_123456789)';
  assert.equal(redactSecrets(text, {secrets: ['tok_123456789']}),
               'auth failed for key sk-ant-[redacted] and token [redacted] ([redacted])');
});

test('secretsFromEnv picks credential-looking variables and ignores blanks and short values', () => {
  const env = {ANTHROPIC_API_KEY: 'abcdefgh12345', ANTHROPIC_AUTH_TOKEN: '', PATH: '/usr/bin:/bin',
               ATECH_LLM_MODEL: 'claude-opus-5-5', MY_SECRET: 'short', OTHER_TOKEN: 'longer-token-value'};
  assert.deepEqual(secretsFromEnv(env).sort(), ['abcdefgh12345', 'longer-token-value']);
});

test('redactSecrets uses the process environment by default and tolerates odd input', () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'unit-test-secret-value-0001';
  try {
    assert.equal(redactSecrets('key unit-test-secret-value-0001 rejected'), 'key [redacted] rejected');
    assert.equal(redactSecrets(undefined), '');
    assert.equal(redactSecrets(42, {secrets: ['']}), '42');
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});
