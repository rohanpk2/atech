'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const duplicateIds = [...htmlIds].filter(id =>
  [...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length !== 1
);
assert.deepEqual(duplicateIds, [], 'HTML IDs must be unique');

const referencedIds = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
const missingIds = [...referencedIds].filter(id => !htmlIds.has(id));
assert.deepEqual(missingIds, [], 'Every DOM ID referenced by app.js must exist in index.html');

assert.match(html, /<script src="protocol\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  'protocol.js must load before app.js');
assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
assert.match(styles, /@media \(max-width:/, 'dashboard must include a responsive layout');
assert.match(styles, /prefers-reduced-motion/, 'dashboard must respect reduced-motion preferences');

for (const uuidSuffix of ['0001', '0002', '0003', '0004', '0005', '0006', '0007']) {
  assert.match(app, new RegExp(`a7ec${uuidSuffix}-2e47-4dd2-82a4-9c2cf6eaa001`));
}

assert.match(app, /pendingOtaVerification/);
assert.match(app, /finishOtaVerification/);
assert.match(app, /currentFirmwareInfo === pendingOtaVerification\.previousVersion/,
  'OTA verification must reject an unchanged firmware version');
assert.match(app, /protocol\.bytesEqual\(response\.nonce, pending\.nonce\)/,
  'command success must require an exact echoed challenge');

console.log('Dashboard structure and verification-flow tests passed');
