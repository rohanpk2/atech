'use strict';

// Canonical strings and HMAC for the board's LAN OTA service. The firmware
// (shared/AtechWifiLan) builds byte-identical messages; keep them in sync.
const crypto = require('node:crypto');

const PROTOCOL = 1;
const CONTROL_OPS = Object.freeze(['echo', 'confirm', 'rollback', 'restart']);

function beginMessage({deviceId, nonce, size, sha256, buildId}) {
  return `atech-ota-begin/1\n${deviceId}\n${String(nonce).toLowerCase()}\n${Number(size)}\n${String(sha256).toLowerCase()}\n${buildId}\n`;
}

function controlMessage({deviceId, nonce, op}) {
  return `atech-control/1\n${deviceId}\n${String(nonce).toLowerCase()}\n${String(op).toLowerCase()}\n`;
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(message, 'utf8').digest('hex');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {PROTOCOL, CONTROL_OPS, beginMessage, controlMessage, hmacHex, sha256Hex, constantTimeEqual};
