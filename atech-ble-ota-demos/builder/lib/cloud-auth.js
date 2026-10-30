'use strict';

// Canonical strings, tokens and the line-based wire format of the cloud device
// API. The firmware (shared/AtechCloudOta) builds byte-identical login
// messages and parses the same key=value lines; keep both in sync.
const crypto = require('node:crypto');
const {hmacHex} = require('./lan-auth');

const PROTOCOL = 1;

function loginMessage({deviceId, nonce}) {
  return `atech-cloud-login/1\n${deviceId}\n${String(nonce).toLowerCase()}\n`;
}

function proofHex(secret, {deviceId, nonce}) {
  return hmacHex(secret, loginMessage({deviceId, nonce}));
}

// One key=value per line. Values are flattened to a single line; booleans
// become 1/0; null and undefined become the empty string.
function encodeKv(object) {
  let out = '';
  for (const [key, raw] of Object.entries(object)) {
    let value;
    if (raw === null || raw === undefined) value = '';
    else if (typeof raw === 'boolean') value = raw ? '1' : '0';
    else value = String(raw).replace(/[\r\n]/g, '');
    out += `${key}=${value}\n`;
  }
  return out;
}

function parseKv(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function parseForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(String(text))) out[key] = value;
  return out;
}

function newSessionToken() { return crypto.randomBytes(24).toString('hex'); }
function newJobId() { return crypto.randomBytes(12).toString('hex'); }

class CloudError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

module.exports = {PROTOCOL, loginMessage, proofHex, encodeKv, parseKv, parseForm, newSessionToken, newJobId, CloudError};
