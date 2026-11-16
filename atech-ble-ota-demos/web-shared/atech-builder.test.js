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
  'methodWifi',
  // Wi-Fi setup over Bluetooth (step 1)
  'provPanel', 'provState', 'provSsid', 'provNetworks', 'provPassword', 'provScan', 'provJoin', 'provForget', 'provProgress', 'provHint',
  // enterprise Wi-Fi (PEAP, TTLS, EAP-TLS) in the same block
  'provAuth', 'provEnterprise', 'provIdentity', 'provUsername', 'provPhase2', 'provDomain', 'provCaBundle', 'provCa', 'provCert', 'provKey',
  // board connections (step 1): pairing two boards and the shared demo state
  'syncPanel', 'syncBadge', 'syncState', 'syncSelf', 'syncPeer', 'syncLink', 'syncValue', 'syncToggle', 'syncConnect', 'syncCode',
  'syncPairInput', 'syncPair', 'syncUnpair', 'syncHint',
  // the local Wi-Fi update flow (step 3): package, hotspot credentials, the board's page, completion
  'localPanel', 'localState', 'localPrepare', 'localHint', 'localSsid', 'localPass', 'localOpen', 'localHost', 'localToken', 'localDone', 'localFile']);
const referenced = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
assert.ok(referenced.length > 10, 'module must address the builder card by element id');
assert.deepEqual(referenced.filter(id => !KNOWN_IDS.has(id)), [], 'every referenced id must be documented');

assert.match(source, /AtechBuilder\s*=\s*\{|root\.AtechBuilder\s*=/, 'module must expose AtechBuilder');
assert.match(source, /function mount\(/);
assert.match(source, /job\.demo !== identity\.demo/, 'deploy guard must compare the demo');
assert.match(source, /job\.firmware\.size > identity\.slotSize/, 'deploy guard must compare the slot size');
assert.match(source, /job\.deviceId !== identity\.id/, 'deploy guard must honour the bound device id');
assert.match(source, /for \(const method of \['wifi', 'hotspot'\]\) if \(avail\[method\]\.ok\) return method/,
  'automatic selection must try Wi-Fi (cloud or LAN), then the local Wi-Fi update; Bluetooth is not a firmware transport');
assert.doesNotMatch(source, /transport\.deploy\(/, 'the shared panel never streams firmware over Bluetooth');
assert.match(source, /Device offline: local Wi-Fi update available/, 'the offline badge copy');
assert.match(source, /\/api\/builds\/\$\{[^}]+\}\/package/, 'the local update downloads the signed package from the backend');
assert.match(source, /local-credentials/, 'the hotspot credentials come from the backend, owner only');
assert.match(source, /allowDowngrade/, 'a downgrade is sent only after the user confirmed it');
assert.match(source, /older version/, 'the downgrade confirmation names the situation');
assert.match(source, /DOWNGRADE_ARM_MS\s*=\s*60000\b/, 'a downgrade confirmation is valid for a minute');
assert.match(source, /downgradeConfirmed = \{jobId: job\.id, deviceId:/, 'a downgrade confirmation is bound to the board it was given for');
assert.match(source, /Downgrade refused/, 'a board refusal arms the confirmation for the next click');
assert.match(source, /hold the BOOT button for about 3 seconds/, 'the local update says how to bring the hotspot up by hand');
assert.match(source, /A certificate or key is too long \(4 KiB limit\)/, 'the per-file certificate limit is the board\'s');
assert.match(source, /Bluetooth setup carries at most 6 KiB/, 'an oversize enterprise profile is explained before it is sent');
assert.match(source, /\/api\/builds\/\$\{job\.id\}\/deploy/, 'Wi-Fi deployment goes through the same-origin backend');
assert.match(source, /\/api\/deployments\/\$\{id\}\/events/, 'deployment progress streams over SSE');
assert.match(source, /\/api\/devices\/pair/, 'pairing goes through the backend');
assert.doesNotMatch(source, /http:\/\/\$\{|192\.168\./, 'the browser never addresses the board directly');
assert.match(source, /choose it above and click Deploy again/, 'a failed transfer must offer, not auto-switch, the next transport');
assert.match(source, /KiB\/s/, 'transfer speed must be shown in KiB/s');
assert.match(source, /etaMs/, 'estimated time remaining must be shown');
assert.match(source, /EventSource\(/, 'progress must stream over SSE');
assert.match(source, /setInterval\(|function poll/, 'progress must fall back to polling');
assert.match(source, /build === job\.buildId/, 'the local update completes only when the board reports the new build id');
assert.match(source, /protocol\.CONTROL\[opName\]/, 'recovery controls go through the identity service');
assert.match(source, /board's own page|board's page/, 'the local update copy names the board page');
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

// Board connections: commands reach a board only over a connection that exists; "connected" is live.
assert.match(source, /\/api\/devices\/\$\{[^}]+\}\/sync/, 'backend-reached boards get sync commands through the relay route');
assert.match(source, /Paired, not communicating/, 'a configured pairing without recent traffic is never shown as connected');
assert.match(source, /Queued; the board picks it up/, 'a cloud-queued command is reported as queued, not applied');
assert.match(source, /sessionStorage/, 'the pairing code is kept for the next board in this tab only');
assert.match(source, /pairingOp: true/, 'pairing changes ask for the owner grant like a Wi-Fi change');

console.log('Atech builder UI structure tests passed');
