'use strict';

// Browser deployment selection in jsdom: Wi-Fi first when a paired board is
// reachable, Bluetooth as the backup when Web Bluetooth has a connected board,
// the hotspot instructions last. Also: a failed Wi-Fi transfer is reported and
// never retried over Bluetooth by itself, and the dashboard key banner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const BOARD = 'ATECH-A1B2C3D4E5F6';

function identity(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1,
          slotSize: 6291456, pending: false, canRollback: false, safe: false, appState: 'running', loops: 10, up: 5000, otaOwner: '',
          target: '', paired: true, wifi: {ssid: 'Home', ip: '192.168.1.50', rssi: -50, hostname: 'atech-d4e5f6', mdns: 'atech-d4e5f6.local',
                                           port: 8080, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0}, ...overrides};
}

function readyJob(overrides = {}) {
  return {id: 'job1', demo: 1, state: 'ready', stage: 'Ready to deploy', attempt: 1, maxRepairs: 3, buildId: 'deadbeef', appName: 'Blink',
          appVersion: 3, summary: 'Blinks', code: 'void appLoop() {}', diagnostics: [], violations: [], deviceId: '',
          firmware: {size: 1000, crc32: '00000000', sha256: 'x'}, model: 'fake', ...overrides};
}

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push({url: key, method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body) : null});
    const route = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'}), clone() { return this; }};
    const status = route.status || 200;
    return {ok: status < 400, status, json: async () => route.body ?? route, arrayBuffer: async () => new ArrayBuffer(1000),
            headers: new Map(), clone() { return this; }};
  };
}

async function bootDashboard(demo, {bluetooth = true, routes = {}, connected = false, bleIdentity = null, calls = []} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `http://localhost:5173/demo${demo}/`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'fake', model: 'm'}, '/api/devices': {devices: []}, ...routes}, calls);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* already true */ }
  if (bluetooth) {
    Object.defineProperty(window.navigator, 'bluetooth', {value: {requestDevice: async () => { throw new Error('no device'); }}, configurable: true});
  }
  window.EventSource = undefined;
  window.addEventListener('error', event => errors.push(event.message));
  for (const node of dom.window.document.querySelectorAll('script[src]')) {
    const src = node.getAttribute('src');
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
  }
  if (connected) {
    // Pretend a board is connected over BLE by patching the transport the demo exposed.
    const transport = window[`AtechDemo${demo}Transport`];
    transport.isConnected = () => true;
    transport.identity = () => bleIdentity || identity({wifi: null});
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  return {window, errors, calls, doc: window.document};
}

for (const demo of [1, 2]) {
  test(`Demo ${demo} dashboard boots with the device and deployment panels and no script errors`, async () => {
    const {doc, errors} = await bootDashboard(demo);
    assert.deepEqual(errors, [], errors.join(' | '));
    assert.equal(doc.getElementById('aiBuild').disabled, false);
    assert.equal(doc.getElementById('aiDeploy').disabled, true);
    assert.equal(doc.body.dataset.deployMethod, 'hotspot', 'nothing reachable: hotspot instructions are the only option');
    assert.equal(doc.getElementById('wifiTransportPanel').hidden, false);
    assert.match(doc.getElementById('devStatus').textContent, /Find devices/);
  });
}

test('a paired, reachable board makes Wi-Fi the automatic method and Deploy posts to the backend', async () => {
  const device = {id: BOARD, suffix: 'D4E5F6', demo: 1, name: 'Desk board', host: '192.168.1.50', port: 8080, paired: true, online: true, identity: identity()};
  const calls = [];
  const deployment = {id: 'dep1', state: 'verified', stage: 'Verified', total: 1000, acked: 1000, percent: 100, speedBps: 500000, etaMs: 0,
                      timings: {transferMs: 2, rebootMs: 3, verifyMs: 4, totalMs: 9}, checks: ['build deadbeef running'], deviceId: BOARD, error: null};
  const {doc, window} = await bootDashboard(1, {calls, routes: {
    '/api/devices': {devices: [device]}, '/api/builds': {id: 'job1', buildId: 'deadbeef', appVersion: 3}, '/api/builds/job1': readyJob(),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep1'}}, '/api/deployments/dep1': deployment,
  }});
  assert.equal(doc.body.dataset.deployMethod, 'wifi');
  assert.equal(doc.getElementById('wifiTransportPanel').hidden, true);
  assert.match(doc.getElementById('deviceName').textContent, /Desk board/);
  assert.match(doc.getElementById('devIp').textContent, /192\.168\.1\.50:8080/);
  assert.match(doc.getElementById('devWifi').textContent, /Home/);
  assert.match(doc.getElementById('devBadge').textContent, /Online over Wi-Fi/);
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  const build = calls.find(c => c.url === '/api/builds' && c.method === 'POST');
  assert.equal(build.body.deviceId, BOARD, 'the build is bound to the selected Wi-Fi board');
  assert.equal(doc.getElementById('aiDeploy').disabled, false);
  assert.match(doc.getElementById('aiDeploy').textContent, /Deploy over Wi-Fi/);
  doc.getElementById('aiDeploy').click();
  await new Promise(resolve => setTimeout(resolve, 2300));
  const deploy = calls.find(c => c.url === '/api/builds/job1/deploy');
  assert.deepEqual(deploy.body, {deviceId: BOARD});
  assert.match(doc.getElementById('deployBadge').textContent, /Verified/);
  assert.equal(doc.getElementById('deployPercent').textContent, '100%');
  assert.match(doc.getElementById('deploySpeed').textContent, /KiB\/s/);
  assert.match(doc.getElementById('deployTime').textContent, /transfer/);
  assert.equal(window.AtechBuilder, window.AtechBuilder);
});

test('without a reachable board, a connected Bluetooth board is the backup and Safari gets honest copy', async () => {
  const withBle = await bootDashboard(1, {connected: true});
  assert.equal(withBle.doc.body.dataset.deployMethod, 'ble');
  assert.match(withBle.doc.getElementById('methodBleNote').textContent, /connected over/);
  assert.match(withBle.doc.getElementById('devBle').textContent, /Connected/);
  const safari = await bootDashboard(1, {bluetooth: false});
  assert.equal(safari.doc.body.dataset.deployMethod, 'hotspot');
  assert.equal(safari.doc.getElementById('aiBrowserNote').hidden, false);
  assert.match(safari.doc.getElementById('aiBrowserNote').textContent, /Wi-Fi deployment works in Safari and Chrome/);
  assert.match(safari.doc.getElementById('methodBleNote').textContent, /No Web Bluetooth/);
  assert.equal(safari.doc.getElementById('connect').disabled, true);
  const safariWifi = await bootDashboard(1, {bluetooth: false, routes: {'/api/devices': {devices: [{id: BOARD, demo: 1, paired: true, online: true, identity: identity()}]}}});
  assert.equal(safariWifi.doc.body.dataset.deployMethod, 'wifi', 'Safari deploys over Wi-Fi without Web Bluetooth');
  assert.equal(safariWifi.doc.getElementById('aiBrowserNote').hidden, true);
});

test('a failed Wi-Fi deployment is reported and offers Bluetooth instead of switching silently', async () => {
  const device = {id: BOARD, suffix: 'D4E5F6', demo: 1, paired: true, online: true, identity: identity()};
  const calls = [];
  const failed = {id: 'dep2', state: 'failed', stage: 'Failed', total: 1000, acked: 300, percent: 30, speedBps: 1000, etaMs: null, timings: {},
                  checks: [], deviceId: BOARD, error: 'The board closed the connection'};
  const {doc} = await bootDashboard(1, {connected: true, calls, routes: {
    '/api/devices': {devices: [device]}, '/api/builds': {id: 'job1', buildId: 'deadbeef', appVersion: 3}, '/api/builds/job1': readyJob(),
    '/api/builds/job1/deploy': {status: 202, body: {id: 'dep2'}}, '/api/deployments/dep2': failed,
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  doc.getElementById('aiDeploy').click();
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.match(doc.getElementById('deployStatus').textContent, /Wi-Fi deployment not verified: The board closed the connection/);
  assert.match(doc.getElementById('deployStatus').textContent, /Bluetooth is available: choose it above and click Deploy again/);
  assert.equal(calls.filter(c => c.url === '/api/builds/job1/firmware.bin').length, 0, 'no Bluetooth transfer was started automatically');
  assert.equal(doc.body.dataset.deployMethod, 'wifi', 'the automatic choice stays Wi-Fi until the user picks another method');
  doc.getElementById('methodBle').click();
  assert.equal(doc.body.dataset.deployMethod, 'ble');
  assert.match(doc.getElementById('aiDeploy').textContent, /Deploy over Bluetooth/);
});

test('deploy is blocked when the build is bound to a different board or demo', async () => {
  const device = {id: BOARD, suffix: 'D4E5F6', demo: 1, paired: true, online: true, identity: identity()};
  const {doc} = await bootDashboard(1, {routes: {
    '/api/devices': {devices: [device]}, '/api/builds': {id: 'job1', buildId: 'deadbeef', appVersion: 3},
    '/api/builds/job1': readyJob({deviceId: 'ATECH-FFFFFFFFFFFF'}),
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(doc.getElementById('aiDeploy').disabled, true);
  assert.match(doc.getElementById('aiDeploy').title, /bound to ATECH-FFFFFFFFFFFF/);
  const mismatch = await bootDashboard(1, {routes: {
    '/api/devices': {devices: [{...device, identity: identity({demo: 2})}]}, '/api/builds': {id: 'job1', buildId: 'deadbeef', appVersion: 3},
    '/api/builds/job1': readyJob(),
  }});
  assert.match(mismatch.doc.getElementById('methodWifiNote').textContent, /runs Demo 2/);
});

test('the dashboard adopts a ?key= link and shows a banner when the backend demands a key', async () => {
  const webDir = config.demos[1].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {url: 'http://10.0.0.5:5173/demo1/?key=abc123', runScripts: 'outside-only'});
  const {window} = dom;
  const seen = [];
  window.fetch = async (url, init = {}) => { seen.push(init.headers || {}); return {ok: false, status: 401, json: async () => ({keyRequired: true}), clone() { return this; }}; };
  window.TextDecoder = TextDecoder; window.EventSource = undefined;
  for (const node of window.document.querySelectorAll('script[src]')) {
    const src = node.getAttribute('src');
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(seen[0]['x-atech-key'], 'abc123', 'the key from the link is sent as a header');
  assert.match(window.document.cookie, /atech_key=abc123/);
  assert.equal(window.localStorage.getItem('atechBuilderKey'), 'abc123');
  assert.equal(window.location.search, '', 'the key is stripped from the address bar');
  assert.equal(window.document.getElementById('keyBanner').hidden, false);
});
