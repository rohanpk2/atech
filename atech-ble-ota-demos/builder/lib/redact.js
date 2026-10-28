'use strict';

// Keeps credentials out of anything the backend stores, logs or returns.
// Error messages from providers, PlatformIO or the CLI could in principle
// echo an environment value; every such message passes through here first.
const SECRET_ENV = /(API_KEY|AUTH_TOKEN|_TOKEN|_SECRET|PASSWORD)$/i;
const MIN_SECRET_LENGTH = 8;
const KEY_SHAPES = [[/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[redacted]']];

function secretsFromEnv(env = process.env) {
  const out = [];
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV.test(key) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) out.push(value);
  }
  return out;
}

function redactSecrets(text, {secrets = secretsFromEnv()} = {}) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of KEY_SHAPES) out = out.replace(pattern, replacement);
  return out;
}

module.exports = {redactSecrets, secretsFromEnv};
