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

// Board-to-board sync command relayed over the LAN (shared/AtechSync through AtechWifiLan): the
// whole form body is signed so a relayed command cannot be altered in flight.
const SYNC_OPS = Object.freeze(['code', 'pair', 'unpair', 'set', 'toggle', 'event', 'status']);

function syncMessage({deviceId, nonce, body}) {
  return `atech-sync/1\n${deviceId}\n${String(nonce).toLowerCase()}\n${String(body)}\n`;
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

module.exports = {PROTOCOL, CONTROL_OPS, SYNC_OPS, beginMessage, controlMessage, syncMessage, hmacHex, sha256Hex, constantTimeEqual};
