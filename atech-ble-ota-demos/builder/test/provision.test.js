'use strict';

// Bluetooth provisioning: the owner grant the backend mints for a claimed board.
const test = require('node:test');
const assert = require('node:assert/strict');
const {JobStore} = require('../lib/jobs');
const {DeviceRegistry} = require('../lib/devices');
const {DeploymentStore} = require('../lib/lan-ota');
const {CloudDeviceService} = require('../lib/cloud-devices');
const {CloudDeploymentStore} = require('../lib/cloud-ota');
const {proofHex, provisionGrantMessage, provisionGrantHex} = require('../lib/cloud-auth');
const {hmacHex} = require('../lib/lan-auth');
const {loadConfig} = require('../lib/config');
const {createServer} = require('../server');
const {tempConfig} = require('./helpers');

const BOARD = 'ATECH-A1B2C3D4E5F6';
const SECRET = 'fixture-ota-token-0123456789';
const NONCE = 'AB'.repeat(16);
const TRANSCRIPT = 'cd'.repeat(32);

test('the grant message is the canonical lowercase string', () => {
  assert.equal(provisionGrantMessage({deviceId: BOARD, nonce: NONCE, transcript: TRANSCRIPT.toUpperCase()}),
               `atech-prov-grant/1\n${BOARD}\n${NONCE.toLowerCase()}\n${TRANSCRIPT}\n`);
  assert.equal(provisionGrantHex(SECRET, {deviceId: BOARD, nonce: NONCE, transcript: TRANSCRIPT}),
               hmacHex(SECRET, `atech-prov-grant/1\n${BOARD}\n${NONCE.toLowerCase()}\n${TRANSCRIPT}\n`));
  assert.match(provisionGrantHex(SECRET, {deviceId: BOARD, nonce: NONCE, transcript: TRANSCRIPT}), /^[0-9a-f]{64}$/);
});

async function bootServer({key = 'secret-key-123'} = {}) {
  const config = {...tempConfig({dashboardKey: key}), cloud: {...loadConfig({}).cloud}};
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
  // A board that logged in once (so the claim can verify the token immediately) and is claimed by alice.
  const login = async () => {
    const {nonce} = cloud.challenge({id: BOARD, ip: '10.0.0.1'});
    return cloud.login({id: BOARD, nonce, proof: proofHex(SECRET, {deviceId: BOARD, nonce}), info: {demo: '1', build: 'stock'}, ip: '10.0.0.1'}).catch(() => null);
  };
  return {config, jobs, devices, cloud, server, base, api, stop, login};
}

test('the grant route answers the owner only and binds nonce and transcript', async () => {
  const ctx = await bootServer();
  try {
    const body = JSON.stringify({nonce: NONCE, transcript: TRANSCRIPT});
    const unclaimed = await ctx.api(`/api/devices/${BOARD}/provision-grant`, {method: 'POST', body});
    assert.equal(unclaimed.status, 404);
    assert.equal((await unclaimed.json()).code, 'unclaimed');

    await ctx.login();
    await ctx.cloud.claim({id: BOARD, token: SECRET, name: 'Desk', ownerId: 'alice'});
    const ok = await ctx.api(`/api/devices/${BOARD}/provision-grant`, {method: 'POST', body});
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).grant, provisionGrantHex(SECRET, {deviceId: BOARD, nonce: NONCE, transcript: TRANSCRIPT}));

    const other = await ctx.api(`/api/devices/${BOARD}/provision-grant`, {method: 'POST', body, user: 'bob'});
    assert.equal(other.status, 403);

    const badNonce = await ctx.api(`/api/devices/${BOARD}/provision-grant`, {method: 'POST', body: JSON.stringify({nonce: '0123456789', transcript: TRANSCRIPT})});
    assert.equal(badNonce.status, 400);
    const badTranscript = await ctx.api(`/api/devices/${BOARD}/provision-grant`, {method: 'POST', body: JSON.stringify({nonce: NONCE, transcript: 'zz'})});
    assert.equal(badTranscript.status, 400);
    assert.equal((await fetch(`${ctx.base}/api/devices/${BOARD}/provision-grant`, {method: 'POST', body})).status, 401, 'the dashboard key is required');
  } finally { await ctx.stop(); }
});

module.exports = {bootServer, BOARD, SECRET};

// ---- the Bluetooth protocol: framing, the encrypted session and the Node reference board ----
const AtechProvision = require('../../web-shared/atech-provision.js');
const {createFakeProvBoard} = require('../lib/fake-prov-board');
const crypto = require('node:crypto');

test('frames fragment and reassemble at the pinned sizes', () => {
  const {fragment, createReassembler, MAX_FRAGMENT, MAX_MESSAGE} = AtechProvision;
  assert.equal(MAX_FRAGMENT, 240);
  assert.equal(MAX_MESSAGE, 1024);
  for (const size of [1, 240, 241, 1024]) {
    const message = crypto.randomBytes(size);
    const frames = fragment(message);
    assert.equal(frames.length, Math.ceil(size / 240));
    assert.ok(frames.every(f => f.length <= 242));
    assert.equal(frames[0][0] & 0x02, 0x02, 'first flag');
    assert.equal(frames[frames.length - 1][0] & 0x01, 0x01, 'last flag');
    const reassembler = createReassembler();
    let out = null;
    for (const frame of frames) out = reassembler.push(frame) || out;
    assert.deepEqual(Buffer.from(out), message, `${size} bytes round trip`);
  }
  assert.throws(() => fragment(crypto.randomBytes(1025)), /1024/);
  const frames = fragment(crypto.randomBytes(500));
  const reassembler = createReassembler();
  assert.equal(reassembler.push(frames[0]), null);
  assert.equal(reassembler.push(frames[2]), null, 'an out-of-order fragment resets the message');
  assert.equal(reassembler.push(frames[1]), null);
  let out = null;
  for (const frame of frames) out = reassembler.push(frame) || out;
  assert.equal(out.length, 500, 'a fresh first fragment starts over cleanly');
});

// Wires a session to the fake board the way app.js wires it to the GATT characteristics.
function link(board, options = {}) {
  return AtechProvision.createSession({
    write: async frame => board.handleWrite(frame),
    subscribe: handler => board.onNotify(handler),
    timeoutMs: 1000,
    ...options,
  });
}

test('hello agrees on a key with the board and exposes the lock flags and the transcript', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, networks: [{ssid: 'Home', rssi: -50, open: false}]});
  const session = link(board);
  const hello = await session.hello();
  assert.match(hello.nonce, /^[0-9a-f]{32}$/);
  assert.equal(hello.locked, false);
  assert.equal(hello.wifiConfigured, false);
  assert.equal(hello.urlSet, false);
  const expected = crypto.createHash('sha256').update(Buffer.concat([board.state.lastClientPub, board.state.lastBoardPub])).digest('hex');
  assert.equal(hello.transcript, expected);
  assert.equal(hello.transcript, await AtechProvision.transcriptHex(board.state.lastClientPub, board.state.lastBoardPub));
  assert.deepEqual(await session.scan(), [{ssid: 'Home', rssi: -50, open: false}]);
  session.close();
});

test('provisioning an unlocked board stores the credentials and returns the token once', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  const session = link(board);
  await session.hello();
  const reply = await session.provision({ssid: 'Home', pass: 'secret123', url: 'https://api.example', claim: true});
  assert.deepEqual(reply, {ok: true, joining: true, token: SECRET});
  assert.deepEqual({ssid: board.state.ssid, pass: board.state.pass, url: board.state.url}, {ssid: 'Home', pass: 'secret123', url: 'https://api.example'});
  assert.ok(!board.state.plaintextSeen.includes('secret123'), 'the fake saw the password only after decryption');
  const noToken = await session.provision({url: 'https://api.example'});
  assert.equal(noToken.ok, true);
  assert.equal(noToken.token, undefined, 'the token is only returned when claim is requested');
  const bad = await session.provision({ssid: 'x'.repeat(33), pass: 'secret123'});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /32/);
  const shortPass = await session.provision({ssid: 'Home', pass: 'short'});
  assert.equal(shortPass.ok, false);
  assert.match(shortPass.error, /8 to 63/);
  const forgotten = await session.forget({wifi: true});
  assert.equal(forgotten.ok, true);
  assert.equal(board.state.ssid, '');
  session.close();
});

test('a locked board needs the owner grant bound to this session, or a BOOT press', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, locked: true});
  const session = link(board);
  const hello = await session.hello();
  assert.equal(hello.locked, true);
  const refused = await session.provision({ssid: 'Home', pass: 'secret123', claim: true});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /locked/);
  assert.equal(board.state.ssid, '');
  const wrong = await session.provision({ssid: 'Home', pass: 'secret123', grant: 'f'.repeat(64)});
  assert.equal(wrong.ok, false);
  const grant = provisionGrantHex(SECRET, {deviceId: BOARD, nonce: hello.nonce, transcript: hello.transcript});
  const ok = await session.provision({ssid: 'Home', pass: 'secret123', grant, claim: true});
  assert.deepEqual(ok, {ok: true, joining: true, token: SECRET});
  // The grant is bound to the session: a new hello invalidates it.
  const again = await session.hello();
  assert.notEqual(again.nonce, hello.nonce);
  const stale = await session.provision({ssid: 'Home2', pass: 'secret123', grant});
  assert.equal(stale.ok, false);
  board.pressButton();
  const pressed = await session.provision({ssid: 'Home2', pass: 'secret123'});
  assert.equal(pressed.ok, true);
  assert.equal(board.state.ssid, 'Home2');
  session.close();
});

test('tampered ciphertext is refused on both sides and a session-less request is an error reply', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET});
  const tamper = createFakeProvBoard({id: BOARD, token: SECRET, faults: {tamperReply: true}});
  const session = link(board, {write: async frame => { if (frame[2] === 0x03) frame[frame.length - 1] ^= 0x01; board.handleWrite(frame); }});
  await session.hello();
  const reply = await session.provision({ssid: 'Home', pass: 'secret123'});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /decrypt|auth/i);
  assert.equal(board.state.ssid, '');
  session.close();
  const tampered = link(tamper);
  await tampered.hello();
  await assert.rejects(tampered.provision({ssid: 'Home', pass: 'secret123'}), /decrypt|auth/i);
  tampered.close();
  const fresh = link(createFakeProvBoard({id: BOARD, token: SECRET}));
  const noSession = await fresh.provision({ssid: 'Home', pass: 'secret123'});
  assert.equal(noSession.ok, false);
  assert.match(noSession.error, /hello|session/i);
  fresh.close();
});

test('status parses the board JSON and a missing reply times out', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, faults: {silent: true}});
  const status = AtechProvision.parseStatus(Buffer.from(board.status()));
  assert.equal(status.id, BOARD);
  assert.equal(status.prov, 1);
  assert.equal(status.wifi.connected, false);
  const session = link(board, {timeoutMs: 50});
  await assert.rejects(session.hello(), /timed out/i);
  session.close();
});

test('hello and scan still answer while a transfer owns flash; only changes are refused', async () => {
  const board = createFakeProvBoard({id: BOARD, token: SECRET, networks: [{ssid: 'Home', rssi: -50, open: false}]});
  board.state.busy = true;
  const session = link(board);
  const hello = await session.hello();
  assert.match(hello.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(await session.scan(), [{ssid: 'Home', rssi: -50, open: false}]);
  const refused = await session.provision({url: 'https://api.example'});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /busy/);
  session.close();
});
