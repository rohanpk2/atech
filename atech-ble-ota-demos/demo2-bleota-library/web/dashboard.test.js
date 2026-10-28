'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const installHtml = fs.readFileSync(path.join(__dirname, 'install.html'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const duplicateIds = [...htmlIds].filter(id => [...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length !== 1);
assert.deepEqual(duplicateIds, [], 'HTML IDs must be unique');
const referencedIds = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
assert.deepEqual([...referencedIds].filter(id => !htmlIds.has(id)), [], 'Every DOM ID referenced by app.js must exist');

const BUILDER_IDS = ['aiPrompt', 'aiBuild', 'aiStatus', 'aiBadge', 'aiSummary', 'aiCode', 'aiCodeMeta', 'aiDeploy',
  'aiDownload', 'aiTarget', 'aiConfirm', 'aiRollback', 'aiAttempts', 'aiLog', 'aiBackend', 'aiBrowserNote',
  'aiReview', 'aiProgress', 'aiProgressBar', 'aiExamples'];
for (const id of BUILDER_IDS) assert.ok(htmlIds.has(id), `builder card must include #${id}`);

const order = ['/shared/atech-identity.js', '/shared/atech-builder.js', 'src="bleota-client.js', 'src="app.js']
  .map(needle => html.indexOf(needle));
assert.ok(order.every(index => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]),
  'scripts must load identity, builder, bleota client, then app (which mounts the builder)');
assert.match(html, /<link rel="stylesheet" href="styles\.css(\?v=\d+)?">/);
assert.match(html, /<link rel="stylesheet" href="\/shared\/builder\.css(\?v=\d+)?">/);
assert.match(styles, /@media \(max-width:/);
assert.match(styles, /prefers-reduced-motion/);
assert.doesNotMatch(html + app + styles + installHtml, /—/, 'copy must not contain em dashes');

assert.match(html, /Atech-OTA-D2-&lt;suffix&gt;/, 'Wi-Fi fallback must identify the Demo 2 SoftAP');
assert.match(html, /http:\/\/192\.168\.4\.1/);
assert.match(html, /hold the physical <strong>BOOT<\/strong> button for about 3 seconds/);
assert.match(html, /This dashboard does not fetch or upload/);
assert.match(html, /href="install\.html"/);
assert.match(html, /gb88/, 'the dashboard must credit the gb88 protocol it speaks');

assert.match(app, /namePrefix: 'Atech-Library-OTA'/);
assert.match(app, /optionalServices: \[BLEOTA\.BLEOTA_SERVICE, AtechIdentity\.IDENTITY_SERVICE\]/);
assert.match(app, /writeValueWithResponse/, 'sector writes must use with-response writes so long writes work at any MTU');
assert.match(app, /BLEOTA\.buildSectorPackets\(/);
assert.match(app, /BLEOTA\.parseSectorAck\(/);
assert.match(app, /async function deployBytes\(/);
assert.match(app, /pendingOtaVerification\.buildId/);
assert.match(app, /window\.AtechDemo2Transport/);
assert.match(app, /AtechBuilder\.mount\(/);
assert.match(app, /Boolean\(navigator\.bluetooth\)/);
assert.match(app, /transport === 'wifi' && isConnected\(\)/, 'must refuse Wi-Fi handoff while BLE remains connected');
assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest/, 'app.js must not upload to the HTTP device portal');

assert.match(installHtml, /<esp-web-install-button[^>]*manifest="\/api\/installer\/2\/manifest\.json"/);
assert.match(installHtml, /esp-web-tools@10/);

console.log('Demo 2 dashboard structure tests passed');
