'use strict';

// The "Board connections" block in step 1 (jsdom): hidden without a board; status rendering that
// never calls a silent board connected; toggling demo.power over Bluetooth with a live change
// notification; the connect-another-board flow through the stored pairing code; cloud commands
// shown as queued; the owner grant for pairing changes on an owned board.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');
const {createFakeProvBoard} = require('../lib/fake-prov-board');
const {createSyncBus, createFakeSync} = require('../lib/fake-sync');
const {provisionGrantHex} = require('../lib/cloud-auth');
const AtechProvision = require('../../web-shared/atech-provision.js');
const AtechSync = require('../../web-shared/atech-sync.js');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const A = 'ATECH-A1B2C3D4E5F6';
const B = 'ATECH-A1B2C3D4E5F7';
const SECRET = 'fixture-ota-token-0123456789';
const LOCAL = {apiBase: '', transport: 'auto', hosted: false, pollMs: 30, provPollMs: 40};
const HOSTED = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30, provPollMs: 40};
const FAST = {helloMs: 60, timeoutMs: 250, retryMs: 20};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ago = ms => new Date(Date.now() - ms).toISOString();

function identity(overrides = {}) {
  return {id: A, suffix: 'D4E5F6', demo: 1, fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1,
          slotSize: 6291456, pending: false, canRollback: false, safe: false, appState: 'running', loops: 10, up: 5000, otaOwner: '',
          target: '', paired: true, source: 'ble', wifi: null, ...overrides};
}

function cloudDevice(sync, overrides = {}) {
  return {id: A, suffix: 'D4E5F6', demo: 1, name: 'Desk board', paired: true, ownerId: 'atech', online: true, via: 'cloud', host: null, port: null,
          identity: {...identity(), source: 'cloud', sync, wifi: {ssid: '', ip: '', rssi: -55, hostname: '', mdns: '', port: 0, connected: true, transferring: false, lastTransferError: '', lastTransferMs: 0}},
          cloud: {registered: true, online: true, lastSeenAt: ago(4000), lastReport: {build: 'stock'}, lastAuthFailureAt: null, verified: true}, ...overrides};
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

function fakeProvisioning(board) {
  return {
    available: () => true,
    session: () => AtechProvision.createSession({write: async frame => board.handleWrite(frame), subscribe: handler => board.onNotify(handler),
                                                 timeoutMs: 1000, crypto: globalThis.crypto}),
    readStatus: async () => AtechProvision.parseStatus(Buffer.from(board.status())),
  };
}

// The transport's sync hook the way app.js builds it from the status and change characteristics.
function fakeSyncHook(statusFn, {onSubscribe = null} = {}) {
  return {
    available: () => true,
    readStatus: async () => AtechSync.parseStatus(Buffer.from(JSON.stringify(statusFn()))),
    subscribe: handler => { if (onSubscribe) onSubscribe(handler); return () => {}; },
  };
}

async function bootDashboard(demo, {routes = {}, calls = [], board = null, syncHook = null, connected = true, atechConfig = LOCAL, storage = null} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `http://localhost:5173/demo${demo}/`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'anthropic', model: 'm', cloud: {publicUrl: 'https://api.example'}},
                            '/api/devices': {devices: [], unclaimed: []}, ...routes}, calls);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  Object.defineProperty(window.navigator, 'bluetooth', {value: {requestDevice: async () => { throw new Error('no device'); }}, configurable: true});
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* already true */ }
  window.EventSource = undefined;
  if (storage) for (const [key, value] of Object.entries(storage)) window.sessionStorage.setItem(key, value);
  window.addEventListener('error', event => errors.push(event.message));
  let builder = null;
  for (const node of dom.window.document.querySelectorAll('script[src]')) {
    const src = node.getAttribute('src');
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
    if (src.startsWith('/shared/atech-config.js')) window.ATECH_CONFIG = atechConfig;
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
  if (syncHook) transport.sync = syncHook;
  await wait(80);
  return {window, errors, calls, doc: window.document, transport, builder: () => builder};
}

async function until(predicate, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await wait(15); }
  throw new Error(`timed out waiting for ${what}`);
}

const notPaired = () => ({sync: 1, id: A, paired: false, connected: false, peer: '', peerState: 'none', pairingOpen: false, pairingCode: '', lastAckAgoMs: -1, state: {}});

test('the block is hidden without a board and shown for a Bluetooth board with the sync service', async () => {
  const without = await bootDashboard(1, {connected: true});
  assert.deepEqual(without.errors, [], without.errors.join(' | '));
  assert.equal(without.doc.getElementById('syncPanel').hidden, true, 'no sync hook: hidden');
  const disconnected = await bootDashboard(1, {connected: false, syncHook: fakeSyncHook(notPaired)});
  assert.equal(disconnected.doc.getElementById('syncPanel').hidden, true, 'hook present but no connection: hidden');
  const shown = await bootDashboard(1, {syncHook: fakeSyncHook(notPaired)});
  await until(() => shown.doc.getElementById('syncBadge').textContent === 'Not paired', 2000, 'panel shown with its first status');
  assert.deepEqual(shown.errors, []);
  assert.equal(shown.doc.getElementById('syncPanel').hidden, false);
  assert.equal(shown.doc.getElementById('syncSelf').textContent, A);
  assert.equal(shown.doc.getElementById('syncPeer').textContent, 'None');
  assert.equal(shown.doc.getElementById('syncValue').textContent, 'Not set yet');
  assert.equal(shown.doc.getElementById('syncUnpair').hidden, true);
  assert.match(shown.doc.getElementById('syncState').textContent, /Connect another board/);
});

test('before the first status read the block says it is reading and does not offer a blind toggle', async () => {
  let release = null;
  const slow = {available: () => true, subscribe: () => () => {},
                readStatus: () => new Promise(resolve => { release = () => resolve(AtechSync.parseStatus(Buffer.from(JSON.stringify(notPaired())))); })};
  const ctx = await bootDashboard(1, {syncHook: slow});
  await until(() => !ctx.doc.getElementById('syncPanel').hidden, 2000, 'panel');
  assert.equal(ctx.doc.getElementById('syncBadge').textContent, 'Reading');
  assert.equal(ctx.doc.getElementById('syncToggle').disabled, true, 'no blind toggle before a status exists');
  assert.ok(release, 'a status read is in flight');
  release();
  await until(() => ctx.doc.getElementById('syncBadge').textContent === 'Not paired', 2000, 'status rendered');
  assert.equal(ctx.doc.getElementById('syncToggle').disabled, false);
});

test('paired but silent board is shown as not communicating', async () => {
  const silent = () => ({...notPaired(), paired: true, connected: false, peer: B, peerState: 'offline', lastAckAgoMs: 42000, state: {'demo.power': {v: 'true', t: 'bool', rev: 3, by: B}}});
  const ctx = await bootDashboard(1, {syncHook: fakeSyncHook(silent)});
  await until(() => ctx.doc.getElementById('syncBadge').textContent === 'Paired, not communicating', 2000, 'badge');
  assert.equal(ctx.doc.getElementById('syncBadge').className, 'badge error');
  assert.equal(ctx.doc.getElementById('syncPeer').textContent, B);
  assert.match(ctx.doc.getElementById('syncState').textContent, /no answer/i);
  assert.doesNotMatch(ctx.doc.getElementById('syncState').textContent, /^Connected/);
  assert.equal(ctx.doc.getElementById('syncLink').textContent, '42 s ago');
  assert.equal(ctx.doc.getElementById('syncValue').textContent, 'On');
  assert.equal(ctx.doc.getElementById('syncUnpair').hidden, false);
  const pairing = () => ({...silent(), peerState: 'pairing', lastAckAgoMs: -1});
  const ctx2 = await bootDashboard(1, {syncHook: fakeSyncHook(pairing)});
  await until(() => ctx2.doc.getElementById('syncBadge').textContent === 'Pairing', 2000, 'pairing badge');
  assert.equal(ctx2.doc.getElementById('syncLink').textContent, 'Never');
});

test('connected board shows peer, last ack and the demo state, and toggles over Bluetooth', async () => {
  const bus = createSyncBus({delayMs: 1});
  const node = createFakeSync({id: A, bus, ...FAST});
  node.start();
  const board = createFakeProvBoard({id: A, token: SECRET, sync: node});
  let pushChange = null;
  // The Bluetooth read returns the compact payload the board's GATT characteristic serves.
  const connectedStatus = () => ({...node.bleStatus(), paired: true, connected: true, peer: B, peerState: 'connected', lastAckAgoMs: 300});
  const ctx = await bootDashboard(1, {board, syncHook: fakeSyncHook(connectedStatus, {onSubscribe: handler => { pushChange = handler; }})});
  try {
    await until(() => ctx.doc.getElementById('syncBadge').textContent === 'Connected', 2000, 'connected badge');
    assert.equal(ctx.doc.getElementById('syncBadge').className, 'badge success');
    assert.match(ctx.doc.getElementById('syncState').textContent, /Communicating with ATECH-A1B2C3D4E5F7/);
    assert.equal(ctx.doc.getElementById('syncLink').textContent, '0 s ago');
    assert.equal(ctx.doc.getElementById('syncToggle').textContent, 'Turn demo.power on');
    ctx.doc.getElementById('syncToggle').click();
    await until(() => node.get('demo.power') && node.get('demo.power').value === 'true', 3000, 'board received the set');
    assert.ok(board.state.requests.some(r => r.op === 'sync' && r.key === 'demo.power' && r.value === 'true'), 'op=set went through the sealed session');
    await until(() => ctx.doc.getElementById('syncValue').textContent === 'On', 2000, 'value rendered');
    assert.equal(ctx.doc.getElementById('syncToggle').textContent, 'Turn demo.power off');
    // The other board changes the value: the change notification updates the block at once.
    assert.ok(pushChange, 'the dashboard subscribed to change notifications');
    node.set('demo.power', 'false', 'bool');
    pushChange(Buffer.from(JSON.stringify({k: 'demo.power', v: 'false', t: 'bool', rev: 2, by: B, remote: true})));
    await until(() => ctx.doc.getElementById('syncValue').textContent === 'Off', 1000, 'notification applied');
    assert.match(ctx.doc.getElementById('log').textContent, /demo\.power/);
  } finally { node.stop(); }
});

test('connect another board stores the code and the next board offers to pair with it', async () => {
  const bus = createSyncBus({delayMs: 1});
  const a = createFakeSync({id: A, bus, ...FAST});
  const b = createFakeSync({id: B, bus, ...FAST});
  a.start(); b.start();
  const boardA = createFakeProvBoard({id: A, token: SECRET, sync: a});
  const boardB = createFakeProvBoard({id: B, token: SECRET, sync: b});
  const ctx = await bootDashboard(1, {board: boardA, syncHook: fakeSyncHook(() => a.status())});
  try {
    await until(() => !ctx.doc.getElementById('syncPanel').hidden, 2000, 'panel');
    ctx.doc.getElementById('syncConnect').click();
    await until(() => a.status().pairingOpen, 2000, 'code issued on A');
    const code = a.status().pairingCode;
    await until(() => ctx.doc.getElementById('syncCode').value === code, 2000, 'code shown');
    assert.equal(ctx.doc.getElementById('syncCode').hidden, false);
    assert.match(ctx.doc.getElementById('syncHint').textContent, /other board/i);
    const stored = JSON.parse(ctx.window.sessionStorage.getItem('atechSyncCode'));
    assert.equal(stored.code, code);
    assert.equal(stored.from, A);
    assert.equal(ctx.doc.getElementById('syncPair').hidden, true, 'the issuing board is not offered its own code');

    // The user connects board B in the same dashboard: the stored code is offered for it.
    ctx.transport.identity = () => identity({id: B, suffix: 'D4E5F7'});
    ctx.transport.provisioning = fakeProvisioning(boardB);
    ctx.transport.sync = fakeSyncHook(() => b.status());
    await ctx.builder().refreshDevices({probe: false});
    await until(() => ctx.doc.getElementById('syncSelf').textContent === B, 2000, 'board B rendered');
    assert.equal(ctx.doc.getElementById('syncPair').hidden, false);
    assert.equal(ctx.doc.getElementById('syncPair').textContent, `Pair with ${A}`);
    assert.equal(ctx.doc.getElementById('syncPairInput').value, code);
    ctx.doc.getElementById('syncPair').click();
    await until(() => a.status().connected && b.status().connected, 4000, 'both boards connected');
    assert.ok(boardB.state.requests.some(r => r.op === 'sync' && r.code === code), 'op=pair carried the code');
    await until(() => ctx.doc.getElementById('syncBadge').textContent === 'Connected', 3000, 'B shows connected');
    assert.equal(ctx.window.sessionStorage.getItem('atechSyncCode'), null, 'a used code is forgotten');
    // A code typed by hand (from a serial console) is also accepted.
    ctx.doc.getElementById('syncPairInput').value = 'garbage';
    ctx.doc.getElementById('syncPair').click();
    await until(() => /ATSYNC1/.test(ctx.doc.getElementById('syncHint').textContent), 1000, 'format hint');
  } finally { a.stop(); b.stop(); }
});

test('cloud board commands show as queued and the compact report renders the state', async () => {
  const calls = [];
  const device = cloudDevice({paired: true, connected: true, peer: B, peerState: 'connected', code: '', state: {'demo.power': 'true'}});
  const ctx = await bootDashboard(1, {connected: false, atechConfig: HOSTED, calls, routes: {
    '/api/devices': {devices: [device], unclaimed: []},
    [`/api/devices/${A}/sync`]: () => ({status: 202, body: {ok: true, via: 'cloud', queued: true, pollMs: 15000}}),
  }});
  await until(() => !ctx.doc.getElementById('syncPanel').hidden, 2000, 'panel from the backend status');
  assert.deepEqual(ctx.errors, []);
  assert.equal(ctx.doc.getElementById('syncBadge').textContent, 'Connected');
  assert.equal(ctx.doc.getElementById('syncValue').textContent, 'On');
  assert.equal(ctx.doc.getElementById('syncLink').textContent, 'Unknown', 'the compact cloud report carries no acknowledgment time');
  ctx.doc.getElementById('syncToggle').click();
  await until(() => calls.some(c => c.url === `/api/devices/${A}/sync` && c.method === 'POST'), 2000, 'command posted');
  const posted = calls.find(c => c.url === `/api/devices/${A}/sync`);
  assert.deepEqual(posted.body, {op: 'set', key: 'demo.power', value: 'false'});
  await until(() => /Queued/.test(ctx.doc.getElementById('syncHint').textContent), 2000, 'queued hint');
  assert.match(ctx.doc.getElementById('syncHint').textContent, /15 s/);
  assert.equal(ctx.doc.getElementById('syncValue').textContent, 'On', 'nothing is shown as applied until the board reports');
});

test('pairing ops on an owned board use the owner grant', async () => {
  const bus = createSyncBus({delayMs: 1});
  const node = createFakeSync({id: A, bus, ...FAST});
  node.start();
  const board = createFakeProvBoard({id: A, token: SECRET, locked: true, sync: node});
  const calls = [];
  const ctx = await bootDashboard(1, {board, syncHook: fakeSyncHook(() => node.status()), calls, routes: {
    '/api/devices': {devices: [{id: A, suffix: 'D4E5F6', demo: 1, name: 'Desk', paired: true, ownerId: 'local', online: false, via: null, cloud: {registered: true}}], unclaimed: []},
    [`/api/devices/${A}/provision-grant`]: ({json}) => ({body: {grant: provisionGrantHex(SECRET, {deviceId: A, nonce: json.nonce, transcript: json.transcript})}}),
  }});
  try {
    await until(() => !ctx.doc.getElementById('syncPanel').hidden, 2000, 'panel');
    ctx.doc.getElementById('syncConnect').click();
    await until(() => node.status().pairingOpen, 3000, 'the locked board accepted the grant and issued a code');
    assert.ok(calls.some(c => c.url === `/api/devices/${A}/provision-grant`), 'the grant was requested from the backend');
    assert.ok(board.state.requests.some(r => r.op === 'sync' && r.grant === '<grant>'), 'the grant travelled in the sealed request');
  } finally { node.stop(); }
});
