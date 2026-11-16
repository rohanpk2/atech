'use strict';

// The hosted dashboard with cloud-registered boards in jsdom: registered list
// with last-seen, claiming, Cloud Wi-Fi deploy and every job state, Bluetooth
// and the download fallback untouched, Safari through the cloud path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');
const {buildPackage} = require('../lib/signing');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const BOARD = 'ATECH-A1B2C3D4E5F6';
const OTHER = 'ATECH-000000000002';
const HOSTED = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30};
const LOCAL = {apiBase: '', transport: 'auto', hosted: false, pollMs: 2000};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ago = ms => new Date(Date.now() - ms).toISOString();

function identity(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1,
          slotSize: 6291456, pending: false, canRollback: false, safe: false, appState: 'running', loops: 10, up: 5000, otaOwner: '',
          target: '', paired: true, source: 'cloud', heap: 150000, heapMin: 120000,
          wifi: {ssid: '', ip: '', rssi: -55, hostname: '', mdns: '', port: 0, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0}, ...overrides};
}

function cloudDevice(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, name: 'Desk board', paired: true, ownerId: 'atech', online: true, via: 'cloud', host: null, port: null,
          identity: identity(),
          cloud: {registered: true, online: true, lastSeenAt: ago(4000), lastReport: {build: 'stock', heap: 150000}, lastAuthFailureAt: null, verified: true},
          ...overrides};
}

function job(state, overrides = {}) {
  return {id: 'job1', demo: 1, state, stage: state, attempt: 1, maxRepairs: 3, buildId: 'deadbeef', appName: 'Blink',
          appVersion: 3, summary: 'Blinks', code: 'void appLoop() {}', diagnostics: [], violations: [], deviceId: '',
          firmware: state === 'ready' ? {size: 1000, crc32: '00000000', sha256: 'x'} : null, model: 'fake', error: null, ...overrides};
}

function cloudJob(state, overrides = {}) {
  return {id: 'dep1', transport: 'cloud', jobId: 'job1', buildId: 'deadbeef', appName: 'Blink', appVersion: 3, demo: 1, deviceId: BOARD, ownerId: 'atech',
          state, stage: state, offline: false, total: 1000, received: 0, percent: 0, attempts: 0, error: null, reason: null, checks: [],
          timings: {}, createdAt: ago(1000), updatedAt: ago(0), expiresAt: new Date(Date.now() + 60000).toISOString(), claimedAt: null, finishedAt: null,
          deviceLastSeenAt: ago(4000), before: {build: 'stock'}, after: {build: null}, note: null, ...overrides};
}

function sequence(answers) {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push({url: key, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null});
    const route = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'}), clone() { return this; }};
    const status = route.status || 200;
    const bytes = route.bytes ? route.bytes.buffer.slice(route.bytes.byteOffset, route.bytes.byteOffset + route.bytes.byteLength) : new ArrayBuffer(1000);
    return {ok: status < 400, status, json: async () => route.body ?? route, arrayBuffer: async () => bytes,
            headers: new Map(), clone() { return this; }};
  };
}

async function bootDashboard(demo, {bluetooth = true, routes = {}, connected = false, calls = [], atechConfig = HOSTED} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `https://atech.example.vercel.app/demo${demo}/`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'anthropic', model: 'm'}, '/api/devices': {devices: [], unclaimed: []}, ...routes}, calls);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  if (bluetooth) Object.defineProperty(window.navigator, 'bluetooth', {value: {requestDevice: async () => { throw new Error('no device'); }}, configurable: true});
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* already true */ }
  window.EventSource = function EventSource() { throw new Error('EventSource must not be used in poll mode'); };
  window.addEventListener('error', event => errors.push(event.message));
  for (const node of dom.window.document.querySelectorAll('script[src]')) {
    const src = node.getAttribute('src');
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
    if (src.startsWith('/shared/atech-config.js')) window.ATECH_CONFIG = atechConfig;
  }
  if (connected) {
    const transport = window[`AtechDemo${demo}Transport`];
    transport.isConnected = () => true;
    transport.identity = () => identity({demo, source: 'ble', wifi: null});
  }
  await wait(40);
  return {window, errors, calls, doc: window.document};
}

async function buildAndGetReady(doc) {
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(60);
}

test('hosted dashboard lists registered boards with last seen and offers the claim form', async () => {
  const {doc, errors} = await bootDashboard(1, {routes: {
    '/api/devices': {devices: [cloudDevice()], unclaimed: [{id: OTHER, demo: 1, build: 'stock', seenAt: ago(2000), authFailed: false, claimed: false}]},
  }});
  assert.deepEqual(errors, [], errors.join(' | '));
  assert.match(doc.getElementById('devBadge').textContent, /Online via cloud/);
  assert.match(doc.getElementById('devStatus').textContent, /seen 4 s ago/);
  assert.equal(doc.getElementById('devFind').hidden, true, 'mDNS discovery stays hidden on the hosted dashboard');
  assert.equal(doc.body.dataset.deployMethod, 'wifi');
  assert.equal(doc.getElementById('methodWifi').querySelector('strong').textContent, 'Cloud Wi-Fi');
  assert.match(doc.getElementById('methodWifiNote').textContent, /online via the cloud \(seen 4 s ago\)/);
  const list = doc.getElementById('devList');
  assert.equal(list.hidden, false);
  assert.match(list.textContent, /ATECH-000000000002/);
  assert.match(list.textContent, /waiting to be claimed/);
  const claim = [...list.querySelectorAll('button')].find(b => b.textContent === 'Claim');
  assert.ok(claim, 'unclaimed boards get a Claim button');
  claim.click();
  assert.equal(doc.getElementById('devClaimForm').hidden, false);
  assert.equal(doc.getElementById('devClaimId').value, OTHER);
  assert.equal(doc.getElementById('aiConfirm').hidden, true, 'no cloud recovery controls');

  const offline = await bootDashboard(1, {routes: {
    '/api/devices': {devices: [cloudDevice({online: false, via: null, cloud: {registered: true, online: false, lastSeenAt: ago(2 * 3600 * 1000), lastReport: {build: 'stock'}, lastAuthFailureAt: null, verified: true}})], unclaimed: []},
  }});
  assert.equal(offline.doc.getElementById('devBadge').textContent, 'Offline');
  assert.match(offline.doc.getElementById('devStatus').textContent, /Last seen 2 h ago/);
  assert.match(offline.doc.getElementById('methodWifiNote').textContent, /is offline \(last seen 2 h ago\); the job waits for it/);
  assert.equal(offline.doc.body.dataset.deployMethod, 'hotspot', 'an offline board defaults to the local update; the cloud queue stays one click away');
  offline.doc.getElementById('methodWifi').click();
  assert.equal(offline.doc.body.dataset.deployMethod, 'wifi', 'a claimed but offline board can still be given a cloud job');
});

test('hosted dashboard without any board explains claiming', async () => {
  for (const demo of [1, 2]) {
    const {doc, errors} = await bootDashboard(demo, {bluetooth: false});
    assert.deepEqual(errors, []);
    assert.match(doc.getElementById('devStatus').textContent, /No board registered yet/);
    assert.match(doc.getElementById('methodWifiNote').textContent, /Claim one in step 1/);
    assert.equal(doc.body.dataset.deployMethod, 'hotspot');
    assert.equal(doc.getElementById('aiBrowserNote').hidden, false);
    assert.match(doc.getElementById('aiBrowserNote').textContent, /Claim your board in step 1 and deploy through the cloud/);
    assert.equal(doc.getElementById('devClaimOpen').hidden, false);
  }
});

test('claiming posts id, token and name and selects the board', async () => {
  const calls = [];
  const {doc} = await bootDashboard(1, {calls, routes: {
    '/api/devices': sequence([{devices: [], unclaimed: []}, {devices: [cloudDevice()], unclaimed: []}]),
    '/api/devices/claim': {device: cloudDevice()},
  }});
  doc.getElementById('devClaimOpen').click();
  doc.getElementById('devClaimId').value = BOARD;
  doc.getElementById('devClaimToken').value = 'fixture-ota-token-0123456789';
  doc.getElementById('devClaimName').value = 'Desk board';
  doc.getElementById('devClaim').click();
  await wait(60);
  const claim = calls.find(c => c.url === '/api/devices/claim');
  assert.deepEqual(claim.body, {id: BOARD, token: 'fixture-ota-token-0123456789', name: 'Desk board'});
  assert.equal(doc.getElementById('devClaimToken').value, '', 'the token never lingers in the form');
  assert.match(doc.getElementById('deviceName').textContent, /Desk board/);
  assert.match(doc.getElementById('devHint').textContent, /Claimed ATECH-A1B2C3D4E5F6/);
});

test('cloud deploy posts via cloud and renders every state', async () => {
  const calls = [];
  const {doc} = await bootDashboard(1, {calls, routes: {
    '/api/devices': {devices: [cloudDevice()], unclaimed: []},
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': job('ready'),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep1', deployment: cloudJob('pending', {offline: true}), transport: 'cloud'}},
    '/api/deployments/dep1': sequence([cloudJob('pending', {offline: true}), cloudJob('downloading', {received: 300, percent: 30}),
                                       cloudJob('installing', {received: 1000, percent: 100}), cloudJob('rebooting', {received: 1000, percent: 100}),
                                       cloudJob('succeeded', {received: 1000, percent: 100, after: {build: 'deadbeef'}, checks: ['build deadbeef running', 'boot confirmed, rollback cancelled'],
                                                             timings: {queuedMs: 5, downloadMs: 1200, installMs: 300, rebootMs: 4000, totalMs: 6000}})]),
  }});
  await buildAndGetReady(doc);
  assert.equal(doc.getElementById('aiDeploy').disabled, false);
  assert.match(doc.getElementById('aiDeploy').textContent, /Deploy over Cloud Wi-Fi/);
  const badges = [];
  const sampler = setInterval(() => { const text = doc.getElementById('deployBadge').textContent; if (badges.at(-1) !== text) badges.push(text); }, 3);
  doc.getElementById('aiDeploy').click();
  await wait(400);
  clearInterval(sampler);
  const deploy = calls.find(c => c.url === '/api/builds/job1/deploy');
  assert.deepEqual(deploy.body, {deviceId: BOARD, via: 'cloud'});
  for (const badge of ['Offline', 'Downloading', 'Installing', 'Restarting', 'Succeeded']) assert.ok(badges.includes(badge), `badge ${badge} in ${badges.join(' > ')}`);
  assert.match(doc.getElementById('deployStatus').textContent, /Deployed and confirmed on ATECH-A1B2C3D4E5F6/);
  assert.equal(doc.getElementById('deployPercent').textContent, '100%');
  assert.deepEqual([...doc.getElementById('deployPhases').children].map(c => c.textContent), ['Queued', 'Download', 'Install', 'Reboot', 'Done']);
  assert.ok([...doc.getElementById('deployPhases').children].every(c => c.className === 'done'));
  assert.match(doc.getElementById('deployTime').textContent, /1\.2 s download, 4\.0 s reboot/);
  assert.match(doc.getElementById('deployTransport').textContent, /over Cloud Wi-Fi/);
  assert.equal(doc.getElementById('stepDeploy').dataset.state, 'done');
});

test('a failed cloud job is reported with the failed badge and the local update is offered', async () => {
  const {doc} = await bootDashboard(1, {connected: true, routes: {
    '/api/devices': {devices: [cloudDevice()], unclaimed: []},
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': job('ready'),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep1', deployment: cloudJob('pending'), transport: 'cloud'}},
    '/api/deployments/dep1': sequence([cloudJob('pending'), cloudJob('failed', {reason: 'rolled_back', error: 'The board rolled back to build stock instead of deadbeef'})]),
  }});
  await buildAndGetReady(doc);
  doc.getElementById('aiDeploy').click();
  await wait(200);
  assert.equal(doc.getElementById('deployBadge').textContent, 'Failed');
  assert.match(doc.getElementById('deployStatus').textContent, /Cloud Wi-Fi deployment not verified: The board rolled back to build stock/);
  assert.match(doc.getElementById('deployStatus').textContent, /local Wi-Fi update is available: choose it above and click Deploy again/i);
  assert.equal(doc.body.dataset.deployMethod, 'wifi', 'nothing switches transports by itself');
  doc.getElementById('methodHotspot').click();
  assert.equal(doc.body.dataset.deployMethod, 'hotspot');
  assert.match(doc.getElementById('aiDeploy').textContent, /local Wi-Fi update/i);
});

test('cloud board of the other demo keeps Wi-Fi unavailable', async () => {
  const {doc} = await bootDashboard(1, {routes: {'/api/devices': {devices: [cloudDevice({identity: identity({demo: 2})})], unclaimed: []}}});
  assert.match(doc.getElementById('methodWifiNote').textContent, /runs Demo 2, this dashboard is Demo 1/);
  assert.equal(doc.body.dataset.deployMethod, 'hotspot');
  assert.equal(doc.getElementById('methodWifi').classList.contains('unavailable'), true);
});

test('a connected Bluetooth board is not a firmware transport on the hosted dashboard; the local update and the raw download remain', async () => {
  const {doc, calls} = await bootDashboard(1, {connected: true, calls: [], routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}}, '/api/builds/job1': job('ready'),
  }});
  assert.equal(doc.body.dataset.deployMethod, 'hotspot');
  await buildAndGetReady(doc);
  assert.match(doc.getElementById('aiDeploy').textContent, /local Wi-Fi update/i);
  const download = doc.getElementById('aiDownload');
  assert.equal(download.hidden, false);
  assert.ok(download.getAttribute('href').endsWith('/api/builds/job1/firmware.bin'));
  assert.ok(calls.every(c => !('x-atech-key' in c.headers)));
});

test('Safari with a claimed board deploys through the cloud without Web Bluetooth', async () => {
  const {doc} = await bootDashboard(1, {bluetooth: false, routes: {'/api/devices': {devices: [cloudDevice()], unclaimed: []}}});
  assert.equal(doc.body.dataset.deployMethod, 'wifi');
  assert.equal(doc.getElementById('aiBrowserNote').hidden, true);
  assert.equal(doc.getElementById('connect').disabled, true);
});

test('local dashboard still offers Find devices and LAN pairing next to claiming', async () => {
  const {doc, errors} = await bootDashboard(1, {atechConfig: LOCAL, routes: {'/api/devices': {devices: [], unclaimed: []}}});
  assert.deepEqual(errors, []);
  assert.equal(doc.getElementById('devFind').hidden, false);
  assert.equal(doc.getElementById('devClaimOpen').hidden, false);
  doc.getElementById('devClaimOpen').click();
  assert.equal(doc.getElementById('devClaimForm').hidden, false);
  assert.match(doc.getElementById('devStatus').textContent, /Find devices/);
});

test('hosted dashboard prefers the cloud path for a board the backend also sees on its own LAN', async () => {
  const both = cloudDevice({host: '127.0.0.1', port: 59002, via: 'lan', simulated: true, identity: identity({source: 'lan', wifi: {ssid: 'SimulatedNet', ip: '127.0.0.1', rssi: -51, hostname: 'x', mdns: 'x.local', port: 59002, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0}})});
  const hosted = await bootDashboard(1, {routes: {'/api/devices': {devices: [both], unclaimed: []}}});
  assert.equal(hosted.doc.getElementById('methodWifi').querySelector('strong').textContent, 'Cloud Wi-Fi');
  assert.match(hosted.doc.getElementById('devBadge').textContent, /simulated/);
  assert.match(hosted.doc.getElementById('devStatus').textContent, /through the cloud/);
  const local = await bootDashboard(1, {atechConfig: LOCAL, routes: {'/api/devices': {devices: [both], unclaimed: []}}});
  assert.equal(local.doc.getElementById('methodWifi').querySelector('strong').textContent, 'Wi-Fi', 'locally the LAN path stays first');
  assert.match(local.doc.getElementById('devStatus').textContent, /over Wi-Fi/);
});

test('reloading the hosted dashboard re-attaches to the active cloud job of the selected board', async () => {
  const calls = [];
  const {doc} = await bootDashboard(1, {calls, routes: {
    '/api/devices': {devices: [cloudDevice()], unclaimed: []},
    '/api/deployments': [cloudJob('pending', {offline: false, stage: 'Board is busy with another update'})],
    '/api/deployments/dep1': sequence([...Array(6).fill(cloudJob('pending', {stage: 'Board is busy with another update'})), cloudJob('downloading', {received: 500, percent: 50}),
                                       cloudJob('succeeded', {received: 1000, percent: 100, after: {build: 'deadbeef'}, checks: ['build deadbeef running']})]),
  }});
  await wait(80);
  const listed = calls.find(c => c.url === '/api/deployments');
  assert.ok(listed, 'the dashboard asks the backend for the board\'s deployments');
  assert.equal(doc.getElementById('deployAbort').hidden, false, 'a pending job can be stopped after a reload');
  assert.match(doc.getElementById('deployStatus').textContent, /busy with another update/, 'the backend\'s stage text is shown');
  await wait(400);
  assert.equal(doc.getElementById('deployBadge').textContent, 'Succeeded');
  assert.equal(doc.getElementById('deployAbort').hidden, true);
});

test('a captive board says it needs a sign-in', async () => {
  const captive = cloudDevice({online: false, cloud: {registered: true, online: false, lastSeenAt: ago(600000), lastReport: {build: 'stock', internet: 'captive', transport: 'hotspot', hotspotActive: true}, lastAuthFailureAt: null, verified: true},
                               identity: identity({wifi: {ssid: 'Campus', ip: '10.1.2.3', rssi: -60, hostname: 'atech-d4e5f6', mdns: '', port: 8080, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0,
                                                          internet: 'captive', captiveUrl: 'http://portal.campus.edu/login', transport: 'hotspot', hotspot: true, mac: 'A1:B2:C3:D4:E5:F6', auth: 'peap'}})});
  const {doc, errors} = await bootDashboard(1, {routes: {'/api/devices': {devices: [captive], unclaimed: []}}});
  assert.deepEqual(errors, []);
  await wait(60);
  assert.match(doc.getElementById('devStatus').textContent, /needs a sign-in/i, 'the captive network is named as the reason');
  assert.match(doc.getElementById('devWifi').textContent, /Campus/);
  assert.match(doc.getElementById('devWifi').textContent, /sign-in/i);
});

test('an offline cloud board shows the local update flow with the hotspot credentials and completes when the board reports the new build', async () => {
  const offline = cloudDevice({online: false, hotspot: {ssid: 'ATECH-D4E5F6'},
                               cloud: {registered: true, online: false, lastSeenAt: ago(300000), lastReport: {build: 'stock', transport: 'hotspot', hotspotActive: true}, lastAuthFailureAt: null, verified: true},
                               identity: identity({wifi: {...identity().wifi, hostname: 'atech-d4e5f6', transport: 'hotspot', transportReason: 'offline', hotspot: true}})});
  let devices = [offline];
  const calls = [];
  const {doc, errors} = await bootDashboard(1, {calls, routes: {
    '/api/devices': () => ({devices, unclaimed: []}),
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}}, '/api/builds/job1': job('ready'),
    [`/api/devices/${BOARD}/local-credentials`]: {ssid: 'ATECH-D4E5F6', pass: 'hotspot-secret-123', token: 'fixture-ota-token-0123456789', hostname: 'atech-d4e5f6'},
    '/api/builds/job1/package': {bytes: buildPackage({image: Buffer.alloc(1000, 7), header: {v: 1, build: 'deadbeef', demo: 1, size: 1000, sha256: 'x'.repeat(64), version: 3, ver: 3,
                                                       downgrade: false, target: BOARD, sig: 'ab'.repeat(64), kid: '00000000', pub: '04' + '00'.repeat(64), app: 'Blink'}})},
  }});
  assert.deepEqual(errors, []);
  await buildAndGetReady(doc);
  assert.equal(doc.body.dataset.deployMethod, 'hotspot');
  assert.equal(doc.getElementById('deployBadge').textContent, 'Device offline: local Wi-Fi update available');
  assert.match(doc.getElementById('methodHotspotNote').textContent, /offline/i);
  assert.match(doc.getElementById('aiDeploy').textContent, /local Wi-Fi update/i);
  doc.getElementById('aiDeploy').click();
  await wait(120);
  assert.equal(doc.getElementById('localPanel').hidden, false);
  assert.equal(doc.getElementById('localSsid').textContent, 'ATECH-D4E5F6');
  assert.equal(doc.getElementById('localPass').textContent, 'hotspot-secret-123');
  assert.equal(doc.getElementById('localToken').textContent, 'fixture-ota-token-0123456789');
  assert.match(doc.getElementById('localHost').textContent, /atech-d4e5f6\.local/);
  assert.equal(calls.filter(c => c.url === '/api/builds/job1/package').length, 0, 'nothing is downloaded until the user prepares the update');
  doc.getElementById('localPrepare').click();
  await wait(120);
  const pkg = calls.find(c => c.url === '/api/builds/job1/package');
  assert.ok(pkg, 'the signed package is fetched from the backend');
  assert.match(doc.getElementById('localState').textContent, /atech-demo1-deadbeef\.atech/);
  devices = [cloudDevice({...offline, online: true, build: 'deadbeef', cloud: {...offline.cloud, online: true, lastSeenAt: ago(1000), lastReport: {build: 'deadbeef', transport: 'cloud'}},
                           identity: identity({build: 'deadbeef', app: 'Blink', ver: 3})})];
  await until(() => doc.getElementById('deployBadge').textContent === 'Update complete', 4000);
  assert.match(doc.getElementById('localDone').textContent, /running build deadbeef/);
  assert.match(doc.getElementById('deployStatus').textContent, /Update complete/);
});

test('a lower version asks for confirmation before deploying', async () => {
  const calls = [];
  const newer = cloudDevice({identity: identity({ver: 5, app: 'Later'}), cloud: {registered: true, online: true, lastSeenAt: ago(2000), lastReport: {build: 'stock', maxVersion: 5}, lastAuthFailureAt: null, verified: true}});
  const {doc} = await bootDashboard(1, {calls, routes: {
    '/api/devices': {devices: [newer], unclaimed: []},
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}}, '/api/builds/job1': job('ready'),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep1', deployment: cloudJob('pending'), transport: 'cloud'}},
    '/api/deployments/dep1': sequence([cloudJob('pending'), cloudJob('succeeded', {after: {build: 'deadbeef'}, timings: {totalMs: 5000}})]),
  }});
  await buildAndGetReady(doc);
  doc.getElementById('aiDeploy').click();
  await wait(60);
  assert.match(doc.getElementById('deployStatus').textContent, /version 3 .*version 5.*older version/);
  assert.equal(calls.filter(c => c.url === '/api/builds/job1/deploy').length, 0, 'nothing is deployed before the confirmation');
  doc.getElementById('aiDeploy').click();
  await wait(200);
  const deploy = calls.find(c => c.url === '/api/builds/job1/deploy');
  assert.deepEqual(deploy.body, {deviceId: BOARD, via: 'cloud', allowDowngrade: true});
  assert.equal(doc.getElementById('deployBadge').textContent, 'Succeeded');
});

test('a downgrade confirmation expires after a minute', async () => {
  const calls = [];
  const newer = cloudDevice({identity: identity({ver: 5, app: 'Later'}), cloud: {registered: true, online: true, lastSeenAt: ago(2000), lastReport: {build: 'stock', maxVersion: 5}, lastAuthFailureAt: null, verified: true}});
  const {doc, window} = await bootDashboard(1, {calls, routes: {
    '/api/devices': {devices: [newer], unclaimed: []},
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}}, '/api/builds/job1': job('ready'),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep1', deployment: cloudJob('pending'), transport: 'cloud'}},
    '/api/deployments/dep1': cloudJob('succeeded', {after: {build: 'deadbeef'}}),
  }});
  await buildAndGetReady(doc);
  doc.getElementById('aiDeploy').click();
  await wait(60);
  assert.match(doc.getElementById('deployStatus').textContent, /older version/);
  const realNow = window.Date.now;
  window.Date.now = () => realNow() + 61000;
  try {
    doc.getElementById('aiDeploy').click();
    await wait(60);
    assert.equal(calls.filter(c => c.url === '/api/builds/job1/deploy').length, 0, 'a stale confirmation does not deploy; the warning is shown again');
    assert.match(doc.getElementById('deployStatus').textContent, /older version/);
  } finally { window.Date.now = realNow; }
});

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await wait(20); }
  throw new Error(`timed out waiting for ${predicate.toString().slice(0, 100)}`);
}
