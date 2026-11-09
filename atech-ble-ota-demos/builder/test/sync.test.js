'use strict';

// Board-to-board sync on the backend: the canonical LAN message, the simulated engine on an
// in-process bus (pairing codes, convergence, the tie-breaker), the dashboard route relaying
// commands over the LAN or queuing them for the cloud poll, the Bluetooth setup opcode on the
// reference board, and simulated boards with repeated demos.
const test = require('node:test');
const assert = require('node:assert/strict');
const {JobStore} = require('../lib/jobs');
const {DeviceRegistry} = require('../lib/devices');
const {DeploymentStore} = require('../lib/lan-ota');
const {CloudDeviceService} = require('../lib/cloud-devices');
const {CloudDeploymentStore} = require('../lib/cloud-ota');
const {createFakeDevice} = require('../lib/fake-device');
const {createFakeCloudDevice} = require('../lib/fake-cloud-device');
const {createFakeProvBoard} = require('../lib/fake-prov-board');
const {createSyncBus, createFakeSync, CODE_PATTERN} = require('../lib/fake-sync');
const {syncMessage, hmacHex} = require('../lib/lan-auth');
const {provisionGrantHex} = require('../lib/cloud-auth');
const {loadConfig} = require('../lib/config');
const {createServer, startSimulatedDevices} = require('../server');
const {tempConfig} = require('./helpers');
const AtechProvision = require('../../web-shared/atech-provision.js');

const A = 'ATECH-A1B2C3D4E5F6';
const B = 'ATECH-A1B2C3D4E5F7';   // the larger MAC: wins ties
const SECRET = 'fixture-ota-token-0123456789';
const FAST = {helloMs: 60, timeoutMs: 250, retryMs: 20};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 3000, what = predicate.toString().slice(0, 120)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await wait(10); }
  throw new Error(`timed out waiting for ${what}`);
}

test('sync message is canonical', () => {
  assert.equal(syncMessage({deviceId: A, nonce: 'AB', body: 'op=code'}), `atech-sync/1\n${A}\nab\nop=code\n`);
  assert.match(hmacHex(SECRET, syncMessage({deviceId: A, nonce: 'ab', body: ''})), /^[0-9a-f]{64}$/);
});

test('two simulated boards pair through codes and converge', async () => {
  const bus = createSyncBus({delayMs: 1});
  const a = createFakeSync({id: A, bus, ...FAST});
  const b = createFakeSync({id: B, bus, ...FAST});
  a.start(); b.start();
  try {
    assert.equal(a.status().paired, false);
    const refusedCode = a.command('op=code', false);
    assert.equal(refusedCode.ok, false);
    assert.match(refusedCode.error, /authorized/);
    const code = a.command('op=code', true);
    assert.equal(code.ok, true);
    assert.match(code.code, CODE_PATTERN);
    assert.equal(a.status().pairingOpen, true);
    assert.equal(a.status().pairingCode, code.code);
    assert.equal(b.command(`op=pair&code=${encodeURIComponent(code.code)}`, false).ok, false, 'pairing is privileged');
    assert.equal(b.command('op=pair&code=garbage', true).ok, false, 'a malformed code is refused');
    assert.equal(a.command(`op=pair&code=${encodeURIComponent(code.code)}`, true).ok, false, 'a board cannot pair with its own code');
    assert.equal(b.command(`op=pair&code=${encodeURIComponent(code.code)}`, true).ok, true);
    assert.equal(b.status().peerState, 'pairing');
    await until(() => a.status().connected && b.status().connected, 3000, 'both connected');
    assert.equal(a.status().pairingOpen, false);
    assert.equal(a.status().peer, B);
    assert.equal(b.status().peer, A);

    assert.equal(a.command('op=set&key=demo.power&value=true', false).ok, true);
    await until(() => b.get('demo.power') && b.get('demo.power').value === 'true', 2000, 'B sees true');
    assert.equal(b.get('demo.power').type, 'bool');
    assert.equal(b.get('demo.power').revision, 1);
    assert.equal(b.get('demo.power').writer, A);
    assert.equal(b.command('op=toggle&key=demo.power', false).ok, true);
    await until(() => a.get('demo.power').value === 'false', 2000, 'A sees false');
    assert.equal(a.get('demo.power').revision, 2);
    assert.equal(b.command('op=set&key=bad key&value=1', false).ok, false);
    assert.equal(b.command('op=event&name=button.pressed', false).ok, true);
    await until(() => a.events.length === 1, 2000, 'A got the event');
    assert.equal(a.events[0].name, 'button.pressed');
    assert.equal(a.events[0].source, B);

    // Conflicting writes while apart: both revision 1, the larger MAC wins on both boards.
    bus.partition = true;
    a.command('op=set&key=k&value=a', false);
    b.command('op=set&key=k&value=b', false);
    bus.partition = false;
    await until(() => a.get('k') && a.get('k').value === 'b' && b.get('k').value === 'b', 3000, 'tie-breaker');
    assert.equal(a.get('k').writer, B);

    // Apart for long: both report offline; back together they reconnect and reconcile.
    bus.partition = true;
    await until(() => a.status().peerState === 'offline' && b.status().peerState === 'offline', 3000, 'offline');
    assert.equal(a.status().connected, false);
    assert.equal(a.status().paired, true, 'paired is configuration, connected is live');
    b.command('op=set&key=late&value=3', false);
    bus.partition = false;
    await until(() => a.get('late') && a.status().connected, 3000, 'reconciled');

    assert.equal(a.command('op=unpair', true).ok, true);
    await until(() => !a.status().paired && !b.status().paired, 2000, 'unpaired both');
    assert.equal(a.status().peerState, 'none');
  } finally { a.stop(); b.stop(); }
});

async function bootServer({key = 'secret-key-123'} = {}) {
  const config = {...tempConfig({dashboardKey: key}), cloud: {...loadConfig({}).cloud, pollMs: 60, offlineAfterMs: 1000}};
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }}, deps: {readApiHeader: () => '//'}});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const cloud = new CloudDeviceService({config, devices});
  const deployments = new DeploymentStore({config, jobs, devices});
  const cloudDeployments = new CloudDeploymentStore({config, jobs, devices, cloud});
  const server = createServer({config, jobs, devices, deployments, cloud, cloudDeployments,
                               installer: {manifest: () => ({}), partFile: () => null, ensureBaseBuild: async () => ({})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, {user = 'alice', ...init} = {}) => fetch(base + p, {...init, headers: {'content-type': 'application/json', 'x-atech-key': key, ...(user ? {'x-atech-user': user} : {}), ...(init.headers || {})}});
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return {config, jobs, devices, cloud, server, base, api, stop};
}

test('LAN relay reaches a simulated board', async () => {
  const ctx = await bootServer();
  const bus = createSyncBus({delayMs: 1});
  const sync = createFakeSync({id: A, bus, ...FAST});
  const device = createFakeDevice({id: A, demo: 1, secret: SECRET, sync});
  const {host, port} = await device.start();
  sync.start();
  try {
    ctx.devices.upsert({id: A, suffix: 'D4E5F6', demo: 1, name: 'Desk', host, port, secret: SECRET, ownerId: 'alice', pairedAt: new Date().toISOString()});
    await ctx.devices.refresh();
    const code = await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'code'})});
    assert.equal(code.status, 200);
    const body = await code.json();
    assert.equal(body.via, 'lan');
    assert.equal(body.result.ok, true);
    assert.match(body.result.code, CODE_PATTERN);
    assert.equal(sync.status().pairingOpen, true);

    const set = await (await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'set', key: 'demo.power', value: 'true'})})).json();
    assert.equal(set.result.ok, true);
    assert.equal(sync.get('demo.power').value, 'true');
    const listed = await (await ctx.api('/api/devices?refresh=1')).json();
    assert.equal(listed.devices[0].identity.sync.state['demo.power'].v, 'true', 'the LAN identity carries the sync status');
    assert.equal(listed.devices[0].identity.sync.pairingCode, body.result.code);

    assert.equal((await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'bogus'})})).status, 400);
    assert.equal((await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'code'}), user: 'bob'})).status, 403);
    assert.equal((await ctx.api('/api/devices/ATECH-000000000000/sync', {method: 'POST', body: JSON.stringify({op: 'code'})})).status, 404);
    // The board itself refuses a bad HMAC.
    const {hmacHex: hmac} = require('../lib/lan-auth');
    const challenge = await (await fetch(`http://${host}:${port}/api/ota/challenge`)).json();
    const bad = await fetch(`http://${host}:${port}/api/sync`, {method: 'POST', body: 'op=unpair',
      headers: {'content-type': 'application/x-www-form-urlencoded', 'X-Atech-Device': A, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Auth': hmac('wrong-secret-wrong-secret', syncMessage({deviceId: A, nonce: challenge.nonce, body: 'op=unpair'}))}});
    assert.equal(bad.status, 401);
    assert.equal(sync.status().pairingOpen, true, 'the refused command changed nothing');
  } finally { sync.stop(); await device.stop(); await ctx.stop(); }
});

test('cloud sync command is queued and delivered in the poll', async () => {
  const ctx = await bootServer();
  const bus = createSyncBus({delayMs: 1});
  const sync = createFakeSync({id: A, bus, ...FAST});
  const device = createFakeCloudDevice({id: A, demo: 1, secret: SECRET, baseUrl: ctx.base, pollMs: 30, sync});
  sync.start();
  device.start();
  try {
    await device.waitFor(() => device.stats.unclaimed > 0, 2000);
    await ctx.cloud.claim({id: A, token: SECRET, name: 'Desk', ownerId: 'alice'});
    await device.waitFor(() => device.stats.logins > 0 && device.stats.polls > 0, 3000);
    const queued = await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'set', key: 'demo.power', value: 'true'})});
    assert.equal(queued.status, 202);
    const body = await queued.json();
    assert.equal(body.via, 'cloud');
    assert.equal(body.queued, true);
    assert.equal(body.pollMs, 60);
    await until(() => sync.get('demo.power') && sync.get('demo.power').value === 'true', 3000, 'delivered in the poll');
    await until(() => {
      const described = ctx.devices.describe(A);
      return described.identity && described.identity.sync && described.identity.sync.state['demo.power'] === 'true';
    }, 3000, 'the report carries the state');
    assert.equal(ctx.devices.describe(A).identity.sync.paired, false);

    // While the board is away, the latest command replaces the earlier one; it is not applied yet.
    device.faults.offline = true;
    await wait(100);
    await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'set', key: 'demo.power', value: 'false'})});
    const second = await (await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'code'})})).json();
    assert.equal(second.queued, true);
    assert.equal(ctx.cloud.pendingCommand(A), 'op=code');
    assert.equal(sync.get('demo.power').value, 'true', 'nothing applied while the board is away');
    device.faults.offline = false;
    await until(() => sync.status().pairingOpen, 3000, 'the queued code command ran on the board');
    assert.equal(ctx.cloud.pendingCommand(A), null);
    assert.equal((await ctx.api(`/api/devices/${A}/sync`, {method: 'POST', body: JSON.stringify({op: 'code'}), user: 'bob'})).status, 403);
  } finally { sync.stop(); await device.stop(); await ctx.stop(); }
});

test('the prov reference board gates pairing ops', async () => {
  const bus = createSyncBus({delayMs: 1});
  const sync = createFakeSync({id: A, bus, ...FAST});
  const board = createFakeProvBoard({id: A, token: SECRET, locked: true, sync});
  const session = AtechProvision.createSession({write: async frame => board.handleWrite(frame), subscribe: handler => board.onNotify(handler),
                                                timeoutMs: 1000, crypto: globalThis.crypto});
  try {
    const hello = await session.hello();
    assert.equal(hello.locked, true);
    const set = await session.sync({op: 'set', key: 'demo.power', value: 'true'});
    assert.equal(set.ok, true, 'state changes need no grant');
    assert.equal(sync.get('demo.power').value, 'true');
    const refused = await session.sync({op: 'code'});
    assert.equal(refused.ok, false);
    assert.match(refused.error, /locked/);
    assert.equal(sync.status().pairingOpen, false);
    const grant = provisionGrantHex(SECRET, {deviceId: A, nonce: hello.nonce, transcript: hello.transcript});
    const code = await session.sync({op: 'code', grant});
    assert.equal(code.ok, true);
    assert.match(code.code, CODE_PATTERN);
    assert.equal(sync.status().pairingOpen, true);
    board.pressButton();
    const unpaired = await session.sync({op: 'unpair'});
    assert.equal(unpaired.ok, true, 'a BOOT press authorizes a pairing change');
    assert.equal(sync.status().pairingOpen, false);
    const bad = await session.sync({op: 'pair', code: 'nope', grant});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Malformed/);
  } finally { session.close(); sync.stop(); }
});

test('simulated duplicate demos get distinct ids on one bus', async () => {
  const config = tempConfig({simulatedDevices: '1,1'});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const started = await startSimulatedDevices(config, devices, {log: () => {}});
  try {
    assert.equal(started.length, 2);
    assert.notEqual(started[0].state.id, started[1].state.id);
    assert.ok(started.every(sim => sim.state.demo === 1 && sim.sync), 'both are Demo 1 boards with a sync engine');
    assert.equal(started[0].sync.bus, started[1].sync.bus, 'one bus joins every simulated board');
    assert.ok(devices.list().every(d => /^ATECH-[0-9A-F]{12}$/.test(d.id)));
    const code = started[0].sync.command('op=code', true);
    assert.equal(started[1].sync.command(`op=pair&code=${encodeURIComponent(code.code)}`, true).ok, true);
    await until(() => started[0].sync.status().connected && started[1].sync.status().connected, 6000, 'the two simulated boards connect');
  } finally { for (const sim of started) await sim.stop(); }
});

test('the Bluetooth status payload stays under the GATT attribute cap in the worst case', () => {
  const bus = createSyncBus({delayMs: 1});
  const a = createFakeSync({id: A, bus, ...FAST});
  for (let i = 0; i < 16; i++) a.set(`k${String(i).padStart(2, '0')}.${'x'.repeat(27)}`, 'v'.repeat(96), 'string');
  assert.equal(a.status().state && Object.keys(a.status().state).length, 16);
  a.command('op=code', true);
  const ble = a.bleStatus();
  const text = JSON.stringify(ble);
  assert.ok(text.length <= 480, `BLE payload is ${text.length} bytes`);
  assert.equal(ble.truncated, true, 'the payload says when the state table did not fit');
  assert.equal(ble.code, a.status().pairingCode);
  assert.equal(typeof ble.lastAckAgoMs, 'number');
  const small = createFakeSync({id: B, bus, ...FAST});
  small.set('demo.power', 'true', 'bool');
  assert.equal(small.bleStatus().state['demo.power'], 'true');
  assert.equal(small.bleStatus().truncated, false);
});
