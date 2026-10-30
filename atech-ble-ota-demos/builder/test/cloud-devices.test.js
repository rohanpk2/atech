'use strict';

// Cloud device service: nonces, login proofs, bearer sessions, pending
// registrations, claiming with ownership, last-seen bookkeeping and rate limits.
const test = require('node:test');
const assert = require('node:assert/strict');
const {DeviceRegistry} = require('../lib/devices');
const {CloudDeviceService} = require('../lib/cloud-devices');
const {proofHex} = require('../lib/cloud-auth');
const {loadConfig} = require('../lib/config');
const {tempConfig} = require('./helpers');

const BOARD = 'ATECH-A1B2C3D4E5F6';
const SECRET = 'fixture-ota-token-0123456789';
const DAY = 24 * 60 * 60 * 1000;

function info(overrides = {}) {
  return {demo: '1', fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: '1', slot_size: '6291456',
          core: '1.2.0', agent: '1', pending: '0', safe: '0', up: '1000', loops: '3', rssi: '-50', heap: '100000', heap_min: '90000', ...overrides};
}

function boot() {
  const config = {...tempConfig(), cloud: {...loadConfig({}).cloud, offlineAfterMs: 200}};
  let t = 1_000_000;
  const now = () => t;
  const advance = ms => { t += ms; };
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null, now}});
  const cloud = new CloudDeviceService({config, devices, now});
  const login = async (id = BOARD, secret = SECRET, extra = {}) => {
    const {nonce} = cloud.challenge({id, ip: '10.0.0.1'});
    return cloud.login({id, nonce, proof: proofHex(secret, {deviceId: id, nonce}), info: info(extra), ip: '10.0.0.1'});
  };
  return {config, devices, cloud, now, advance, login};
}

test('an unclaimed board gets a nonce, is refused at login and shows up as waiting to be claimed', async () => {
  const {cloud, login} = boot();
  const challenge = cloud.challenge({id: BOARD, ip: '10.0.0.1'});
  assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
  assert.equal(challenge.claimed, false);
  assert.equal(challenge.ttlMs, 90000);
  await assert.rejects(login(), error => error.status === 403 && error.code === 'unclaimed');
  const pending = cloud.pendingRegistrations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, BOARD);
  assert.equal(pending[0].demo, 1);
  assert.equal(pending[0].build, 'stock');
  assert.ok(pending[0].seenAt);
});

test('claiming verifies the token against the board commitment and binds the owner', async () => {
  const {cloud, devices, login} = boot();
  await login().catch(() => {});
  await assert.rejects(cloud.claim({id: BOARD, token: 'wrong-token-wrong-token', name: 'Desk', ownerId: 'alice'}),
                       error => error.code === 'token_mismatch' && /does not match/.test(error.message));
  assert.equal(devices.get(BOARD), null, 'a failed claim stores nothing');
  const record = await cloud.claim({id: BOARD, token: SECRET, name: 'Desk', ownerId: 'alice'});
  assert.equal(record.id, BOARD);
  assert.equal(record.paired, true);
  assert.equal(record.ownerId, 'alice');
  assert.equal(record.name, 'Desk');
  assert.equal(record.demo, 1);
  assert.equal(record.secret, undefined, 'public records never carry the token');
  assert.equal(record.cloud.registered, true);
  assert.equal(record.cloud.verified, true);
  assert.equal(record.cloud.online, true, 'the board that just logged in counts as online');
  assert.equal(cloud.pendingRegistrations().length, 0);
  assert.deepEqual(devices.list('bob').map(d => d.id), []);
  assert.deepEqual(devices.list('alice').map(d => d.id), [BOARD]);
  assert.deepEqual(devices.list().map(d => d.id), [BOARD]);
  await assert.rejects(cloud.claim({id: BOARD, token: SECRET, ownerId: 'bob'}), error => error.status === 403);
});

test('a board id plus a wrong proof never gets a session', async () => {
  const {cloud, devices, login} = boot();
  await login().catch(() => {});
  await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  await assert.rejects(login(BOARD, 'not-the-token-not-the-token'), error => error.status === 401 && error.code === 'unauthorized');
  assert.ok(devices.get(BOARD).cloud.lastAuthFailureAt);
  assert.equal(devices.describe(BOARD).cloud.lastAuthFailureAt, devices.get(BOARD).cloud.lastAuthFailureAt);
  const challenge = cloud.challenge({id: BOARD, ip: '10.0.0.1'});
  await assert.rejects(cloud.login({id: BOARD, nonce: challenge.nonce, proof: '', info: info(), ip: '10.0.0.1'}), error => error.status === 401);
});

test('login with the right proof returns a bearer session and the nonce is single use', async () => {
  const {cloud, devices, login} = boot();
  await login().catch(() => {});
  await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  const {nonce} = cloud.challenge({id: BOARD, ip: '10.0.0.1'});
  const proof = proofHex(SECRET, {deviceId: BOARD, nonce});
  const result = await cloud.login({id: BOARD, nonce, proof, info: info(), ip: '10.0.0.1'});
  assert.match(result.session, /^[0-9a-f]{48}$/);
  assert.equal(result.pollMs, 15000);
  assert.ok(result.expiresAt > 0);
  await assert.rejects(cloud.login({id: BOARD, nonce, proof, info: info(), ip: '10.0.0.1'}), error => error.status === 401 && error.code === 'nonce');
  assert.equal(cloud.authenticate(`Bearer ${result.session}`).deviceId, BOARD);
  assert.throws(() => cloud.authenticate('Bearer nope'), error => error.status === 401 && error.code === 'session');
  assert.throws(() => cloud.authenticate(undefined), error => error.status === 401);
  assert.equal(devices.get(BOARD).cloud.lastAuthFailureAt, null);
  assert.equal(devices.get(BOARD).cloud.agent, '1');
});

test('sessions expire and are bounded per board', async () => {
  const {cloud, login, advance} = boot();
  await login().catch(() => {});
  await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  const first = await login();
  advance(DAY + 1);
  assert.throws(() => cloud.authenticate(`Bearer ${first.session}`), error => error.status === 401);
  const sessions = [];
  for (let i = 0; i < 5; i++) sessions.push((await login()).session);
  assert.equal(cloud.sessionsFor(BOARD).length, 4);
  assert.throws(() => cloud.authenticate(`Bearer ${sessions[0]}`), error => error.status === 401, 'the oldest session was evicted');
  assert.equal(cloud.authenticate(`Bearer ${sessions[4]}`).deviceId, BOARD);
});

test('touch keeps last seen and online state', async () => {
  const {cloud, devices, login, advance} = boot();
  await login().catch(() => {});
  await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  await login();
  cloud.touch(BOARD, info({build: 'deadbeef', pending: '1', loops: '42', rssi: '-61', transferring: '1'}));
  assert.equal(cloud.isOnline(BOARD), true);
  const described = devices.describe(BOARD);
  assert.equal(described.online, true);
  assert.equal(described.via, 'cloud');
  assert.equal(described.identity.build, 'deadbeef');
  assert.equal(described.identity.pending, true);
  assert.equal(described.identity.loops, 42);
  assert.equal(described.identity.wifi.rssi, -61);
  assert.equal(described.identity.wifi.connected, true);
  assert.equal(described.identity.wifi.transferring, true);
  assert.equal(described.cloud.lastReport.heap, 100000);
  advance(300);
  assert.equal(cloud.isOnline(BOARD), false);
  const later = devices.describe(BOARD);
  assert.equal(later.cloud.online, false);
  assert.equal(later.online, false);
  assert.equal(later.via, null);
  assert.ok(later.cloud.lastSeenAt);
});

test('claiming before the board ever connected is verified at first login', async () => {
  const {cloud, devices, login} = boot();
  const record = await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  assert.equal(record.cloud.verified, false);
  assert.equal(record.cloud.online, false);
  await login();
  assert.equal(devices.describe(BOARD).cloud.verified, true);
  const other = 'ATECH-000000000002';
  await cloud.claim({id: other, token: 'claimed-with-a-wrong-token', ownerId: 'alice'});
  await assert.rejects(login(other, SECRET), error => error.status === 401);
  assert.ok(devices.get(other).cloud.lastAuthFailureAt);
  assert.equal(cloud.pendingRegistrations().find(p => p.id === other).authFailed, true, 'the owner can see the board is online with a different token');
});

test('challenge and login are rate limited per ip', () => {
  const {cloud} = boot();
  for (let i = 0; i < 60; i++) cloud.challenge({id: `ATECH-0000000000${String(i).padStart(2, '0')}`, ip: 'x'});
  assert.throws(() => cloud.challenge({id: 'ATECH-0000000000FF', ip: 'x'}), error => error.status === 429 && error.code === 'rate_limited');
  cloud.challenge({id: 'ATECH-0000000000FF', ip: 'y'});
  for (let i = 0; i < 20; i++) cloud.challenge({id: BOARD, ip: `ip${i}`});
  assert.throws(() => cloud.challenge({id: BOARD, ip: 'fresh'}), error => error.status === 429, 'per board id as well');
});

test('a cloud-only record is not probed over the LAN', async () => {
  const {cloud, devices, login} = boot();
  await login().catch(() => {});
  await cloud.claim({id: BOARD, token: SECRET, ownerId: 'alice'});
  devices.deps.discover = async () => { throw new Error('mDNS must not run for cloud-only boards'); };
  devices.deps.request = async () => { throw new Error('no LAN probe for cloud-only boards'); };
  const refreshed = await devices.refresh();
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].via, 'cloud');
  assert.equal(refreshed[0].lastProbeError, null);
});

test('LAN pairing records the owner', async () => {
  const {devices} = boot();
  devices.deps.request = async ({path}) => path === '/api/identity'
    ? {status: 200, json: {id: BOARD, suffix: 'D4E5F6', demo: 1, fw: 'x', build: 'stock', app: 'a', ver: 1, slotSize: 1, net: {}}}
    : path === '/api/ota/challenge' ? {status: 200, json: {ok: true, nonce: 'ab'.repeat(16), device: BOARD}} : {status: 200, json: {ok: true}};
  const paired = await devices.pair({host: '127.0.0.1', port: 1, token: SECRET, ownerId: 'carol'});
  assert.equal(paired.ownerId, 'carol');
  assert.deepEqual(devices.list('carol').map(d => d.id), [BOARD]);
  assert.deepEqual(devices.list('dave'), []);
});
