'use strict';

// Structure test for the shared builder UI module (no DOM available here).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'atech-builder.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'builder.css'), 'utf8');

const KNOWN_IDS = new Set(['aiPrompt', 'aiBuild', 'aiStatus', 'aiBadge', 'aiSummary', 'aiCode', 'aiCodeMeta',
  'aiDeploy', 'aiDownload', 'aiTarget', 'aiConfirm', 'aiRollback', 'aiAttempts', 'aiLog', 'aiBackend',
  'aiBrowserNote', 'aiReview', 'aiProgress', 'aiProgressBar', 'aiExamples',
  'keyBanner', 'deviceName', 'deviceId', 'pairingCode', 'firmwareVersion', 'appInfo',
  'devDot', 'devBadge', 'devStatus', 'devWifi', 'devIp', 'devBle', 'devFind', 'devForget', 'devList', 'devPairForm',
  'devPairHost', 'devPairToken', 'devPair', 'devHint', 'wifiTransportPanel',
  'deployStatus', 'deployBadge', 'deployProgress', 'deployProgressBar', 'deployTransport', 'deployPercent',
  'deployBytes', 'deploySpeed', 'deployEta', 'deployTime', 'deployPhases', 'deployChecks', 'deployAbort',
  // step flow: scan bar, board facts disclosure, deployment numbers, step markers
  'devProgress', 'devFacts', 'deployMeta', 'stepConnect', 'stepDescribe', 'stepDeploy',
  // cloud: claim a registered board by id and pairing token
  'devClaimOpen', 'devClaimForm', 'devClaimId', 'devClaimToken', 'devClaimName', 'devClaim',
  // the first method card is relabelled Cloud Wi-Fi for a cloud-registered board
  'methodWifi']);
const referenced = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
assert.ok(referenced.length > 10, 'module must address the builder card by element id');
assert.deepEqual(referenced.filter(id => !KNOWN_IDS.has(id)), [], 'every referenced id must be documented');

assert.match(source, /AtechBuilder\s*=\s*\{|root\.AtechBuilder\s*=/, 'module must expose AtechBuilder');
assert.match(source, /function mount\(/);
assert.match(source, /job\.demo !== identity\.demo/, 'deploy guard must compare the demo');
assert.match(source, /job\.firmware\.size > identity\.slotSize/, 'deploy guard must compare the slot size');
assert.match(source, /job\.deviceId !== identity\.id/, 'deploy guard must honour the bound device id');
assert.match(source, /for \(const method of \['wifi', 'ble', 'hotspot'\]\) if \(avail\[method\]\.ok\) return method/,
  'automatic selection must try Wi-Fi, then Bluetooth, then the hotspot');
assert.match(source, /\/api\/builds\/\$\{job\.id\}\/deploy/, 'Wi-Fi deployment goes through the same-origin backend');
assert.match(source, /\/api\/deployments\/\$\{id\}\/events/, 'deployment progress streams over SSE');
assert.match(source, /\/api\/devices\/pair/, 'pairing goes through the backend');
assert.doesNotMatch(source, /http:\/\/\$\{|192\.168\./, 'the browser never addresses the board directly');
assert.match(source, /choose it above and click Deploy again/, 'a failed transfer must offer, not auto-switch, the next transport');
assert.match(source, /KiB\/s/, 'transfer speed must be shown in KiB/s');
assert.match(source, /etaMs/, 'estimated time remaining must be shown');
assert.match(source, /EventSource\(/, 'progress must stream over SSE');
assert.match(source, /setInterval\(|function poll/, 'progress must fall back to polling');
assert.match(source, /identity\.build !== job\.buildId/, 'verification must compare the build id');
assert.match(source, /loops/, 'verification must watch the loop counter');
assert.match(source, /CONTROL\.echo/, 'verification must request an echo');
assert.match(source, /CONTROL\.confirm/, 'verification must confirm the boot');
assert.match(source, /pairing and upload are manual/, 'hotspot copy must be honest');
assert.doesNotMatch(source, /\bconfirm\(|\balert\(/, 'no blocking browser dialogs');
assert.doesNotMatch(source + css, /—/, 'copy must not contain em dashes');
assert.match(source, /\/api\/builds\/\$\{[^}]+\}\/firmware\.bin/, 'download link must point at the backend');
assert.match(css, /prefers-reduced-motion/);

// Runtime configuration (web-shared/atech-config.js): same-origin API base, poll-only transport for the
// hosted dashboard, honest copy about cloud Wi-Fi deployment.
assert.match(source, /root\.ATECH_CONFIG/, 'module must read window.ATECH_CONFIG');
assert.match(source, /function apiUrl\(/, 'every backend URL must go through apiUrl');
assert.match(source, /transport === 'poll'/, 'a poll-only transport must be supported');
assert.match(source, /usePolling \|\| typeof win\.EventSource !== 'function'/, 'poll mode must never open an EventSource');
assert.match(source, /Claim one in step 1/, 'hosted copy must point at claiming a board');
assert.match(source, /\/api\/devices\/claim/, 'claiming goes through the backend');
assert.match(source, /via: 'cloud'/, 'cloud deployments are requested explicitly');
assert.match(source, /Cloud Wi-Fi/, 'the cloud path is named');
assert.doesNotMatch(source, /fetch\((?!apiUrl)/, 'fetch must only be called through apiUrl');

console.log('Atech builder UI structure tests passed');
