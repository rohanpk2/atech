'use strict';

// The Wi-Fi setup block in step 1 (jsdom): shown only for a Bluetooth-connected board with the
// provisioning service, scan, join with automatic claim, the owner grant for an owned board, the
// BOOT hint when no grant is available, busy refusal, and the password never leaving the request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');
const {createFakeProvBoard} = require('../lib/fake-prov-board');
const {provisionGrantHex} = require('../lib/cloud-auth');
const AtechProvision = require('../../web-shared/atech-provision.js');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const BOARD = 'ATECH-A1B2C3D4E5F6';
const SECRET = 'fixture-ota-token-0123456789';
const PUBLIC_URL = 'https://api.example';
const HOSTED = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30, provPollMs: 40};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ago = ms => new Date(Date.now() - ms).toISOString();

function identity(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1,
          slotSize: 6291456, pending: false, canRollback: false, safe: false, appState: 'running', loops: 10, up: 5000, otaOwner: '',
          target: '', paired: true, source: 'ble', wifi: null, ...overrides};
}

function cloudDevice(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, name: 'Desk board', paired: true, ownerId: 'atech', online: true, via: 'cloud', host: null, port: null,
          identity: {...identity(), source: 'cloud', wifi: {ssid: '', ip: '', rssi: -55, hostname: '', mdns: '', port: 0, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0}},
          cloud: {registered: true, online: true, lastSeenAt: ago(4000), lastReport: {build: 'stock', heap: 150000}, lastAuthFailureAt: null, verified: true},
          ...overrides};
}

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({url: key, method: (init.method || 'GET').toUpperCase(), body});
    const route = typeof routes[key] === 'function' ? routes[key]({...init, json: body}) : routes[key];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'}), clone() { return this; }};
    const status = route.status || 200;
    return {ok: status < 400, status, json: async () => route.body ?? route, headers: new Map(), clone() { return this; }};
  };
}

// The transport's provisioning hook the way app.js builds it from the three characteristics,
// backed by the Node reference board.
function fakeProvisioning(board) {
  return {
    available: () => true,
    session: () => AtechProvision.createSession({write: async frame => board.handleWrite(frame), subscribe: handler => board.onNotify(handler),
                                                 timeoutMs: 1000, crypto: globalThis.crypto}),
    readStatus: async () => AtechProvision.parseStatus(Buffer.from(board.status())),
  };
}

async function bootDashboard(demo, {routes = {}, calls = [], board = null, connected = true, atechConfig = HOSTED} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `https://atech.example.vercel.app/demo${demo}/`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'anthropic', model: 'm', cloud: {publicUrl: PUBLIC_URL}},
                            '/api/devices': {devices: [], unclaimed: []}, ...routes}, calls);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  Object.defineProperty(window.navigator, 'bluetooth', {value: {requestDevice: async () => { throw new Error('no device'); }}, configurable: true});
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* already true */ }
  window.EventSource = function EventSource() { throw new Error('EventSource must not be used in poll mode'); };
  window.addEventListener('error', event => errors.push(event.message));
  let builder = null;
  for (const node of dom.window.document.querySelectorAll('script[src]')) {
    const src = node.getAttribute('src');
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
    if (src.startsWith('/shared/atech-config.js')) window.ATECH_CONFIG = atechConfig;
    // Capture the mounted card so tests can reach its state (app.js keeps it in a script-local binding).
    if (src.startsWith('/shared/atech-builder.js')) {
      const api = window.AtechBuilder;
      window.AtechBuilder = {...api, mount: (...args) => { builder = api.mount(...args); return builder; }};
    }
  }
  const transport = window[`AtechDemo${demo}Transport`];
  if (connected) {
    transport.isConnected = () => true;
    transport.identity = () => identity({demo});
  }
  if (board) transport.provisioning = fakeProvisioning(board);
  await wait(80);
  return {window, errors, calls, doc: window.document, transport, builder: () => builder};
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await wait(20); }
  throw new Error(`timed out waiting for ${predicate.toString().slice(0, 100)}`);
}

function leaks(window, doc, secret) {
  const places = [];
  try { for (let i = 0; i < window.localStorage.length; i++) if (String(window.localStorage.getItem(window.localStorage.key(i))).includes(secret)) places.push('localStorage'); } catch (_) { /* ignore */ }
  if (String(doc.cookie).includes(secret)) places.push('cookie');
  if (doc.getElementById('log').textContent.includes(secret)) places.push('log');
  if (doc.getElementById('provHint').textContent.includes(secret) || doc.getElementById('provState').textContent.includes(secret)) places.push('status');
  return places;
}

test('the Wi-Fi setup block only appears for a connected board with the provisioning service', async () => {
  const without = await bootDashboard(1, {connected: true});
  assert.deepEqual(without.errors, [], without.errors.join(' | '));
  assert.equal(without.doc.getElementById('provPanel').hidden, true, 'no provisioning hook: hidden');
  const disconnected = await bootDashboard(1, {connected: false, board: createFakeProvBoard({id: BOARD, token: SECRET})});
  assert.equal(disconnected.doc.getElementById('provPanel').hidden, true, 'not connected over Bluetooth: hidden');
  for (const demo of [1, 2]) {
    const {doc, errors} = await bootDashboard(demo, {board: createFakeProvBoard({id: BOARD, token: SECRET})});
    assert.deepEqual(errors, [], errors.join(' | '));
    assert.equal(doc.getElementById('provPanel').hidden, false, `demo ${demo}: shown for a connected board`);
    assert.match(doc.getElementById('provState').textContent, /Not on Wi-Fi yet/);
  }
});

test('scan fills the network list and join provisions Wi-Fi, the server URL and claims the board once', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, networks: [{ssid: 'Home', rssi: -50, open: false}, {ssid: 'Cafe', rssi: -80, open: true}]});
  const calls = [];
  let claimed = false;
  const {doc, window, errors} = await bootDashboard(1, {board, calls, routes: {
    '/api/devices': () => ({devices: claimed ? [cloudDevice()] : [], unclaimed: []}),
    '/api/devices/claim': () => { claimed = true; return {device: cloudDevice()}; },
  }});
  doc.getElementById('provScan').click();
  await until(() => doc.getElementById('provNetworks').querySelectorAll('option').length === 2);
  assert.deepEqual([...doc.getElementById('provNetworks').querySelectorAll('option')].map(o => o.value), ['Home', 'Cafe']);
  assert.match(doc.getElementById('provHint').textContent, /2 networks/);

  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => board.state.ssid === 'Home');
  assert.equal(board.state.pass, 'secret123');
  assert.equal(board.state.url, PUBLIC_URL, 'the backend public URL is provisioned with the credentials');
  assert.equal(doc.getElementById('provPassword').value, '', 'the password field is cleared as soon as the request is sent');
  assert.equal(doc.getElementById('provProgress').hidden, false, 'a bar shows while the board joins');
  await until(() => calls.some(c => c.url === '/api/devices/claim'));
  const claim = calls.find(c => c.url === '/api/devices/claim');
  assert.deepEqual(claim.body, {id: BOARD, token: SECRET, name: ''});
  assert.equal(board.state.tokenReleased, 1);

  board.setWifi({connected: true, ip: '10.0.0.7', rssi: -51});
  board.setCloud({state: 'idle', session: true});
  await until(() => /On Home/.test(doc.getElementById('provState').textContent));
  assert.match(doc.getElementById('provState').textContent, /On Home \(10\.0\.0\.7\)/);
  assert.match(doc.getElementById('provState').textContent, /cloud online/);
  assert.equal(doc.getElementById('provProgress').hidden, true);
  await until(() => /Online via cloud/.test(doc.getElementById('devBadge').textContent));
  assert.equal(calls.filter(c => c.url === '/api/devices/claim').length, 1, 'claimed exactly once');
  assert.deepEqual(leaks(window, doc, 'secret123'), []);
  assert.deepEqual(leaks(window, doc, SECRET), [], 'the token is used for the claim and never shown');
  assert.deepEqual(errors, [], errors.join(' | '));
});

test('a board already claimed by this dashboard user is not claimed again', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  const calls = [];
  const {doc} = await bootDashboard(1, {board, calls, routes: {'/api/devices': {devices: [cloudDevice()], unclaimed: []}}});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => board.state.ssid === 'Home');
  await wait(100);
  assert.equal(calls.filter(c => c.url === '/api/devices/claim').length, 0);
  assert.equal(board.state.tokenReleased, 0, 'no token is requested when the board is already claimed');
});

test('an owned board is provisioned with the owner grant from the backend', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, locked: true});
  const calls = [];
  const {doc, errors} = await bootDashboard(1, {board, calls, routes: {
    '/api/devices': {devices: [cloudDevice()], unclaimed: []},
    [`/api/devices/${BOARD}/provision-grant`]: ({json}) => ({grant: provisionGrantHex(SECRET, {deviceId: BOARD, nonce: json.nonce, transcript: json.transcript})}),
  }});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => board.state.ssid === 'Home');
  const grant = calls.find(c => c.url === `/api/devices/${BOARD}/provision-grant`);
  assert.ok(grant, 'the grant was requested');
  assert.match(grant.body.nonce, /^[0-9a-f]{32}$/);
  assert.match(grant.body.transcript, /^[0-9a-f]{64}$/);
  assert.deepEqual(errors, [], errors.join(' | '));
});

test('an owned board without a grant asks for a BOOT press and changes nothing', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, locked: true});
  const {doc} = await bootDashboard(1, {board, routes: {
    [`/api/devices/${BOARD}/provision-grant`]: {status: 403, body: {error: 'This board belongs to another dashboard user'}},
  }});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => /BOOT/.test(doc.getElementById('provHint').textContent));
  assert.match(doc.getElementById('provHint').textContent, /Press the BOOT button/);
  assert.match(doc.getElementById('provHint').textContent, /another dashboard user/);
  assert.equal(board.state.ssid, '');
  assert.equal(doc.getElementById('provPassword').value, '');
  board.pressButton();
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => board.state.ssid === 'Home');
});

test('a busy board refuses changes with a clear message and an empty password is validated locally', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  board.state.busy = true;
  const {doc} = await bootDashboard(1, {board});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'short';
  doc.getElementById('provJoin').click();
  await until(() => /8 to 63/.test(doc.getElementById('provHint').textContent));
  assert.equal(board.state.requests.length, 0, 'a password of the wrong length never reaches the board');
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => /busy/.test(doc.getElementById('provHint').textContent));
  assert.equal(board.state.ssid, '');
});

test('status polling pauses while a deployment is in flight and resumes afterwards', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  const {doc, window, builder: ctxBuilder} = await bootDashboard(1, {board});
  const hook = window.AtechDemo1Transport.provisioning;
  let reads = 0;
  const readStatus = hook.readStatus;
  hook.readStatus = async () => { reads++; return readStatus(); };
  const card = ctxBuilder();
  card.state.busy = true;          // a Bluetooth deployment owns the link
  await wait(60);
  const before = reads;
  await wait(200);
  assert.equal(reads, before, 'no status read while the dashboard is deploying');
  card.state.busy = false;
  await until(() => reads > before);
  assert.equal(doc.getElementById('provPanel').hidden, false);
});

test('a visible record without an owner is claimed so the board gets an owner', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  const calls = [];
  const {doc} = await bootDashboard(1, {board, calls, routes: {
    '/api/devices': {devices: [cloudDevice({ownerId: null, via: 'lan', host: '172.20.10.8'})], unclaimed: []},
    '/api/devices/claim': {device: cloudDevice()},
  }});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => calls.some(c => c.url === '/api/devices/claim'));
  assert.equal(board.state.tokenReleased, 1, 'the token is requested because the record has no owner');
});

test('an owned board with no grant and no BOOT window never receives the password', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, locked: true});
  const {doc} = await bootDashboard(1, {board, routes: {
    [`/api/devices/${BOARD}/provision-grant`]: {status: 403, body: {error: 'This board belongs to another dashboard user'}},
  }});
  doc.getElementById('provSsid').value = 'Home';
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => /BOOT/.test(doc.getElementById('provHint').textContent));
  assert.equal(board.state.requests.length, 0, 'no provision request reached the board');
  assert.ok(!board.state.plaintextSeen.some(t => t.includes('secret123')), 'the board never decrypted the password');
  board.pressButton();
  doc.getElementById('provPassword').value = 'secret123';
  doc.getElementById('provJoin').click();
  await until(() => board.state.ssid === 'Home');
});
