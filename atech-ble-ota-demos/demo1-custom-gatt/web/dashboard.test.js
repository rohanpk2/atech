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

const shared = fs.readFileSync(path.join(__dirname, '..', '..', 'web-shared', 'atech-builder.js'), 'utf8');
const referencedIds = new Set([...(app + shared).matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
const missingIds = [...referencedIds].filter(id => !htmlIds.has(id) && !/^method[A-Z]/.test(id));
assert.deepEqual(missingIds, [], 'Every DOM ID referenced by app.js and the shared module must exist in index.html');

assert.match(html, /<script src="protocol\.js(\?v=\d+)?"><\/script>\s*<script src="app\.js(\?v=\d+)?"><\/script>/,
  'protocol.js must load before app.js');
assert.match(html, /<link rel="stylesheet" href="styles\.css(\?v=\d+)?">/);
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
assert.doesNotMatch(app, /selectedTransport|selectTransport\(/,
  'method selection moved to the shared deployment panel (Wi-Fi first, Bluetooth backup, hotspot last)');
assert.match(html, /id="methodWifi"[\s\S]*id="methodBle"[\s\S]*id="methodHotspot"/,
  'deployment panel must list Wi-Fi, Bluetooth and hotspot in priority order');
assert.match(html, /Atech-OTA-D1-&lt;suffix&gt;/,
  'hotspot fallback must identify the Demo 1 SoftAP');
assert.match(html, /http:\/\/192\.168\.4\.1/,
  'hotspot fallback must point at the device-hosted portal');
assert.match(html, /hold the physical <strong>BOOT<\/strong> button for about 3 seconds/,
  'hotspot fallback must explain runtime BOOT activation');
assert.match(html, /This dashboard does not fetch or upload/,
  'dashboard must hand off hotspot upload to the device portal');
assert.match(html, /Disconnect any active Bluetooth session/,
  'hotspot fallback must require BLE disconnection for exclusive OTA ownership');
assert.match(html, /Join this network/, 'hotspot steps must cover home Wi-Fi provisioning');
assert.match(app, /meta\.onProgress/, 'BLE OTA must report progress to the shared deployment panel');
assert.match(app, /meta\.onPhase/, 'BLE OTA must report phases to the shared deployment panel');
assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest/,
  'the demo script never talks HTTP; only the shared module talks to the same-origin backend');

// AI firmware builder integration
const BUILDER_IDS = ['aiPrompt', 'aiBuild', 'aiStatus', 'aiBadge', 'aiSummary', 'aiCode', 'aiCodeMeta', 'aiDeploy',
  'aiDownload', 'aiTarget', 'aiConfirm', 'aiRollback', 'aiAttempts', 'aiLog', 'aiBackend', 'aiBrowserNote',
  'aiReview', 'aiProgress', 'aiProgressBar', 'aiExamples',
  // device panel and deployment panel
  'devDot', 'devBadge', 'devStatus', 'devWifi', 'devIp', 'devBle', 'devFind', 'devForget', 'devList', 'devPairForm',
  'devPairHost', 'devPairToken', 'devPair', 'devHint', 'keyBanner', 'methodWifi', 'methodBle', 'methodHotspot',
  'methodWifiNote', 'methodBleNote', 'methodHotspotNote', 'deployStatus', 'deployBadge', 'deployProgress',
  'deployProgressBar', 'deployTransport', 'deployPercent', 'deployBytes', 'deploySpeed', 'deployEta', 'deployTime',
  'deployPhases', 'deployChecks', 'deployAbort'];
for (const id of BUILDER_IDS) assert.ok(htmlIds.has(id), `builder card must include #${id}`);
assert.match(html, /<link rel="stylesheet" href="\/shared\/builder\.css(\?v=\d+)?">/,
  'builder stylesheet must be linked from the shared backend path');
assert.ok(html.indexOf('/shared/atech-identity.js') < html.indexOf('src="protocol.js'),
  'identity protocol must load before the dashboard scripts');
assert.ok(html.indexOf('/shared/atech-builder.js') < html.indexOf('src="app.js'),
  'builder UI must load before app.js, which mounts it');
assert.match(html, /href="install\.html"/, 'dashboard must link to the USB installer page');
assert.match(app, /a7ec0101-2e47-4dd2-82a4-9c2cf6eaa001/, 'app.js must read the identity characteristic');
assert.match(app, /AtechIdentity\.parseIdentity\(/);
assert.match(app, /AtechBuilder\.mount\(/, 'app.js must mount the shared builder card');
assert.match(app, /async function deployBytes\(/, 'OTA must accept bytes so the builder can deploy without a file');
assert.match(app, /pendingOtaVerification\.buildId/, 'post-reboot verification must compare the build id when known');
assert.match(app, /pendingOtaVerification\.deviceIdentity/, 'post-reboot verification must compare the Atech device id');
assert.match(app, /optionalServices: \[SERVICE, AtechIdentity\.IDENTITY_SERVICE, AtechProvision\.SERVICE\]/);
assert.match(app, /AtechProvision\.createSession\(/, 'app.js must build the Wi-Fi setup session from the provisioning characteristics');
assert.ok(html.indexOf('/shared/atech-provision.js') < html.indexOf('/shared/atech-builder.js'), 'the provisioning module must load before the builder');
assert.match(app, /window\.AtechDemo1Transport/, 'app.js must expose the transport for the builder');

const installHtml = fs.readFileSync(path.join(__dirname, 'install.html'), 'utf8');
assert.match(installHtml, /<esp-web-install-button[^>]*manifest="\/api\/installer\/1\/manifest\.json"/);
assert.match(installHtml, /esp-web-tools@10/);
assert.match(installHtml, /Chrome/);
assert.match(installHtml, /Edge/);
assert.match(installHtml, /Safari/);
assert.doesNotMatch(installHtml, /\u2014/);

console.log('Dashboard structure and verification-flow tests passed');
