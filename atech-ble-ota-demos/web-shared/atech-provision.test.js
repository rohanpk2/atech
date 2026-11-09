'use strict';

// Structure test for the Bluetooth provisioning module: the constants every other side pins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'atech-provision.js'), 'utf8');
const api = require('./atech-provision.js');

assert.equal(api.SERVICE, 'a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(api.STATUS_CHAR, 'a7ec0201-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(api.REQUEST_CHAR, 'a7ec0202-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(api.REPLY_CHAR, 'a7ec0203-2e47-4dd2-82a4-9c2cf6eaa001');
assert.deepEqual(api.OPS, {hello: 1, scan: 2, provision: 3, forget: 4, sync: 5});
assert.equal(api.MAX_FRAGMENT, 240);
assert.equal(api.MAX_MESSAGE, 1024);
assert.ok(source.includes("'atech-prov/1'"), 'HKDF info string');
assert.ok(source.includes("'P-256'") && source.includes('AES-GCM') && source.includes('HKDF'), 'ECDH P-256, HKDF and AES-GCM');
assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB/, 'the module never stores anything in the browser');
assert.doesNotMatch(source, /console\.log|console\.debug/, 'nothing is logged');
assert.doesNotMatch(source, /—/);
for (const name of ['fragment', 'createReassembler', 'createSession', 'parseStatus', 'transcriptHex']) {
  assert.equal(typeof api[name], 'function', `${name} must be exported`);
}
console.log('Atech provisioning module structure tests passed');
