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
assert.doesNotMatch(html + app + styles, /\u2014/, 'dashboard copy must not contain em dashes');

for (const uuidSuffix of ['0001', '0002', '0003', '0004', '0005', '0006', '0007']) {
  assert.match(app, new RegExp(`a7ec${uuidSuffix}-2e47-4dd2-82a4-9c2cf6eaa001`));
}

assert.match(app, /pendingOtaVerification/);
assert.match(app, /finishOtaVerification/);
assert.match(app, /currentFirmwareInfo === pendingOtaVerification\.previousVersion/,
  'OTA verification must reject an unchanged firmware version');
assert.match(app, /protocol\.bytesEqual\(response\.nonce, pending\.nonce\)/,
  'command success must require an exact echoed challenge');

assert.match(app, /Boolean\(navigator\.bluetooth\)/,
  'dashboard must detect Web Bluetooth availability');
assert.match(app, /bluetoothAvailable \? 'ble' : 'wifi'/,
  'dashboard must prefer BLE and select Wi-Fi when BLE is unavailable');
assert.match(html, /Atech-OTA-D1-&lt;suffix&gt;/,
  'Wi-Fi fallback must identify the Demo 1 SoftAP');
assert.match(html, /http:\/\/192\.168\.4\.1/,
  'Wi-Fi fallback must point at the device-hosted portal');
assert.match(html, /hold the physical <strong>BOOT<\/strong> button for about 3 seconds/,
  'Wi-Fi fallback must explain runtime BOOT activation');
assert.match(html, /This dashboard does not fetch or upload/,
  'dashboard must hand off Wi-Fi upload to the device portal');
assert.match(html, /Disconnect any active Bluetooth session/,
  'Wi-Fi fallback must require BLE disconnection for exclusive OTA ownership');
assert.match(app, /transport === 'wifi' && isConnected\(\)/,
  'dashboard must refuse Wi-Fi handoff while BLE remains connected');
assert.match(app, /\$\('useWifi'\)\.disabled = transferring/,
  'dashboard must lock transport switching during BLE transfer');
assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest/,
  'hosted dashboard must not upload to the HTTP device portal');

console.log('Dashboard structure and verification-flow tests passed');
