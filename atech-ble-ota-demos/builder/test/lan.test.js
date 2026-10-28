'use strict';

// LAN OTA backend: HMAC canonical strings, the mDNS parser, the device
// registry and the deployment engine, all exercised against the simulated
// board (lib/fake-device.js), which implements the firmware's protocol.
// These are simulations; they prove protocol and state-machine behaviour, not
// ESP32 radio or flash performance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../lib/lan-auth');
const mdns = require('../lib/mdns');
const {request} = require('../lib/lan-client');
const {DeviceRegistry} = require('../lib/devices');
const {DeploymentStore} = require('../lib/lan-ota');
const {createFakeDevice, syntheticFirmware} = require('../lib/fake-device');
const {JobStore} = require('../lib/jobs');
const {tempConfig} = require('./helpers');

const SECRET = 'fixture-ota-token-0123456789';
const BOARD = 'ATECH-A1B2C3D4E5F6';

test('canonical HMAC messages match the firmware layout', () => {
  const message = auth.beginMessage({deviceId: BOARD, nonce: 'ABCD', size: 1234, sha256: 'FF00', buildId: 'b1'});
  assert.equal(message, `atech-ota-begin/1\n${BOARD}\nabcd\n1234\nff00\nb1\n`);
  assert.equal(auth.controlMessage({deviceId: BOARD, nonce: '0A', op: 'Confirm'}), `atech-control/1\n${BOARD}\n0a\nconfirm\n`);
  assert.equal(auth.hmacHex('key', 'The quick brown fox jumps over the lazy dog'),
               'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8', 'RFC 2104 style known answer');
  assert.equal(auth.hmacHex(SECRET, message).length, 64);
  assert.equal(auth.constantTimeEqual('abc', 'abc'), true);
  assert.equal(auth.constantTimeEqual('abc', 'abd'), false);
});

function mdnsResponse() {
  // PTR _atech-ota._tcp.local -> "Atech 1A2B3C._atech-ota._tcp.local", SRV -> atech-1a2b3c.local:8080,
  // TXT id=..., A 192.168.1.50. Uses a compression pointer for the service name.
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);   // answers
  header.writeUInt16BE(3, 10);  // additional
  const service = mdns.encodeName('_atech-ota._tcp.local');
  const serviceOffset = 12;
  const instanceLabel = Buffer.from('Atech 1A2B3C');
  const instance = Buffer.concat([Buffer.from([instanceLabel.length]), instanceLabel, Buffer.from([0xC0, serviceOffset])]);
  const rr = (name, type, rdata) => {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(type, 0); head.writeUInt16BE(1, 2); head.writeUInt32BE(120, 4); head.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([name, head, rdata]);
  };
  const ptr = rr(service, mdns.TYPE.PTR, instance);
  const host = mdns.encodeName('atech-1a2b3c.local');
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1f, 0x90]), host]);
  const srv = rr(instance, mdns.TYPE.SRV, srvData);
  const txtEntries = [`id=${BOARD}`, 'suffix=D4E5F6', 'demo=1', 'proto=1'];
  const txtData = Buffer.concat(txtEntries.map(e => Buffer.concat([Buffer.from([e.length]), Buffer.from(e)])));
  const txt = rr(instance, mdns.TYPE.TXT, txtData);
  const a = rr(host, mdns.TYPE.A, Buffer.from([192, 168, 1, 50]));
  return Buffer.concat([header, ptr, srv, txt, a]);
}

test('mDNS responses with compression pointers assemble into service instances', () => {
  const records = mdns.parseResponse(mdnsResponse());
  assert.equal(records.filter(r => r.type === mdns.TYPE.PTR).length, 1);
  const [found] = mdns.assemble(records);
  assert.equal(found.instance, 'atech 1a2b3c');
  assert.equal(found.host, 'atech-1a2b3c.local');
  assert.equal(found.port, 8080);
  assert.deepEqual(found.addresses, ['192.168.1.50']);
  assert.equal(found.txt.id, BOARD);
  assert.equal(found.txt.demo, '1');
  assert.deepEqual(mdns.parseResponse(Buffer.alloc(3)), [], 'short packets are ignored');
  const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xC0, 12])]);
  loop.writeUInt16BE(1, 4);
  assert.deepEqual(mdns.parseResponse(loop), [], 'pointer loops do not hang or throw');
  const query = mdns.buildQuery('_atech-ota._tcp.local');
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query[12], '_atech-ota'.length);
});

async function boot({faults = {}, build = 'stock', demo = 1, firmware = {}} = {}) {
  const config = tempConfig();
  const device = createFakeDevice({id: BOARD, demo, build, secret: SECRET, faults, rebootMs: 150});
  await device.start();
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }},
                             deps: {readApiHeader: () => '//'}});
  // Hand-craft a ready job with a synthetic image that carries the right markers.
  const job = jobs.create({demo, prompt: 'blink', deviceId: firmware.deviceId ?? ''});
  const image = syntheticFirmware({demo: firmware.demo ?? demo, build: firmware.build ?? job.buildId, target: firmware.target ?? '', size: firmware.size ?? 300 * 1024});
  const raw = jobs.jobs.get(job.id);
  fs.writeFileSync(path.join(jobs.jobsDir, job.id, 'firmware.bin'), image);
  jobs.update(raw, {state: 'ready', stage: 'Ready', firmware: {size: image.length, crc32: '0', sha256: auth.sha256Hex(image), path: 'x'},
                    appName: 'Blink', summary: 's', code: '//'});
  const deployments = new DeploymentStore({config: {...config, lanChunkBytes: 64 * 1024, lanRebootWaitMs: 4000, lanLoopWaitMs: 1500}, jobs, devices, deps: {delay: ms => new Promise(r => setTimeout(r, Math.min(ms, 60)))}});
  return {config, device, devices, jobs, job: jobs.get(job.id), deployments, image};
}

test('pairing proves the OTA code with an HMAC echo and stores the device with a private file', async () => {
  const {config, device, devices} = await boot();
  try {
    await assert.rejects(devices.pair({host: '127.0.0.1', port: device.port, token: 'wrong-code-wrong-code'}), /rejected the OTA authorization code/);
    assert.equal(devices.list().length, 0, 'a failed pairing stores nothing');
    const paired = await devices.pair({host: '127.0.0.1', port: device.port, token: SECRET});
    assert.equal(paired.id, BOARD);
    assert.equal(paired.paired, true);
    assert.equal(paired.secret, undefined, 'public records never carry the secret');
    assert.equal(paired.identity.build, 'stock');
    const mode = fs.statSync(path.join(config.buildsDir, 'devices.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    const echo = await devices.control(BOARD, 'echo');
    assert.equal(echo.ok, true);
    await assert.rejects(devices.pair({host: '127.0.0.1', port: device.port, token: 'short'}), /at least 16 characters/);
  } finally { await device.stop(); }
});

test('nonces are single use and a replayed begin is refused', async () => {
  const {device} = await boot();
  try {
    const {host, port} = {host: '127.0.0.1', port: device.port};
    const challenge = (await request({host, port, path: '/api/ota/challenge'})).json;
    const headers = {'X-Atech-Device': BOARD, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Size': '4096',
                     'X-Atech-SHA256': 'a'.repeat(64), 'X-Atech-Build': 'b1'};
    headers['X-Atech-Auth'] = auth.hmacHex(SECRET, auth.beginMessage({deviceId: BOARD, nonce: challenge.nonce, size: 4096, sha256: 'a'.repeat(64), buildId: 'b1'}));
    const first = await request({host, port, method: 'POST', path: '/api/ota/begin', headers});
    assert.equal(first.status, 200);
    await request({host, port, method: 'POST', path: '/api/ota/abort', headers: {'X-Atech-Session': first.json.session}});
    const replay = await request({host, port, method: 'POST', path: '/api/ota/begin', headers});
    assert.equal(replay.status, 401, 'same nonce again');
    assert.match(replay.json.error, /nonce/);
    const other = (await request({host, port, path: '/api/ota/challenge'})).json;
    const wrongDevice = await request({host, port, method: 'POST', path: '/api/ota/begin', headers: {...headers, 'X-Atech-Nonce': other.nonce, 'X-Atech-Device': 'ATECH-000000000000'}});
    assert.equal(wrongDevice.status, 403, 'device id in the request must match the board');
    const bad = (await request({host, port, path: '/api/ota/challenge'})).json;
    const badAuth = await request({host, port, method: 'POST', path: '/api/ota/begin', headers: {...headers, 'X-Atech-Nonce': bad.nonce, 'X-Atech-Auth': 'f'.repeat(64)}});
    assert.equal(badAuth.status, 401, 'a device id plus a pairing code alone never authorizes');
    assert.equal(device.state.session, null);
  } finally { await device.stop(); }
});

test('the device rejects an image whose digest differs from the authenticated declaration', async () => {
  const {device, image, job} = await boot();
  try {
    const {host, port} = {host: '127.0.0.1', port: device.port};
    const challenge = (await request({host, port, path: '/api/ota/challenge'})).json;
    const declared = auth.sha256Hex(Buffer.from('something else'));
    const headers = {'X-Atech-Device': BOARD, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Size': String(image.length),
                     'X-Atech-SHA256': declared, 'X-Atech-Build': job.buildId,
                     'X-Atech-Auth': auth.hmacHex(SECRET, auth.beginMessage({deviceId: BOARD, nonce: challenge.nonce, size: image.length, sha256: declared, buildId: job.buildId}))};
    const begin = await request({host, port, method: 'POST', path: '/api/ota/begin', headers});
    assert.equal(begin.status, 200);
    for (let offset = 0; offset < image.length; offset += 128 * 1024) {
      const put = await request({host, port, method: 'PUT', path: `/api/ota/chunk?offset=${offset}`, body: image.subarray(offset, offset + 128 * 1024),
                                 headers: {'X-Atech-Session': begin.json.session}});
      assert.equal(put.status, 200, put.text);
    }
    const finish = await request({host, port, method: 'POST', path: '/api/ota/finish', headers: {'X-Atech-Session': begin.json.session}});
    assert.equal(finish.status, 422);
    assert.match(finish.json.error, /SHA-256/);
    assert.equal(device.state.build, 'stock', 'nothing was activated');
    assert.equal(device.state.otaOwner, '', 'flash ownership released');
  } finally { await device.stop(); }
});

async function pairAndDeploy(ctx, {abortAt = null} = {}) {
  const {device, devices, deployments, job} = ctx;
  await devices.pair({host: '127.0.0.1', port: device.port, token: SECRET});
  const created = deployments.create({jobId: job.id, deviceId: BOARD});
  const seen = [];
  deployments.subscribe(created.id, snapshot => {
    seen.push(snapshot);
    if (abortAt !== null && snapshot.state === 'uploading' && snapshot.acked >= abortAt && !created.abortSent) {
      created.abortSent = true;
      deployments.abort(created.id);
    }
  });
  const result = await deployments.run(created.id);
  return {result, seen};
}

test('a full Wi-Fi deployment uploads, verifies, confirms and reports real timings', async () => {
  const ctx = await boot();
  try {
    const {result, seen} = await pairAndDeploy(ctx);
    assert.equal(result.state, 'verified', result.error);
    const states = [...new Set(seen.map(s => s.state))];
    assert.deepEqual(states, ['preflight', 'uploading', 'finishing', 'rebooting', 'verifying', 'confirming', 'verified']);
    const acked = seen.filter(s => s.state === 'uploading').map(s => s.acked);
    assert.ok(acked.every((v, i) => i === 0 || v >= acked[i - 1]), 'progress never goes backwards');
    assert.equal(result.acked, ctx.image.length);
    assert.equal(result.percent, 100);
    assert.ok(result.speedBps > 0);
    for (const key of ['preflightMs', 'beginMs', 'transferMs', 'finishMs', 'rebootMs', 'verifyMs', 'totalMs']) {
      assert.ok(Number.isFinite(result.timings[key]), `timing ${key}`);
    }
    assert.ok(result.checks.some(c => /build .* running/.test(c)));
    assert.ok(result.checks.some(c => /rollback cancelled/.test(c)));
    assert.equal(ctx.device.state.build, ctx.job.buildId, 'the board now runs the new build');
    assert.equal(ctx.device.state.pending, false, 'confirm cancelled the rollback');
    assert.equal(ctx.device.state.confirmCount, 1);
    const job = ctx.jobs.get(ctx.job.id);
    assert.equal(job.deployments[0].result, 'verified');
    assert.equal(job.deployments[0].transport, 'wifi');
    assert.equal(result.after.build, ctx.job.buildId);
  } finally { await ctx.device.stop(); }
});

test('a build bound to another board or demo is refused before any byte is sent', async () => {
  const ctx = await boot({firmware: {deviceId: 'ATECH-FFFFFFFFFFFF'}});
  try {
    await ctx.devices.pair({host: '127.0.0.1', port: ctx.device.port, token: SECRET});
    assert.throws(() => ctx.deployments.create({jobId: ctx.job.id, deviceId: BOARD}), /bound to ATECH-FFFFFFFFFFFF/);
    assert.throws(() => ctx.deployments.create({jobId: ctx.job.id, deviceId: 'ATECH-FFFFFFFFFFFF'}), /Unknown device/);
  } finally { await ctx.device.stop(); }
  const wrongDemo = await boot({demo: 1, firmware: {demo: 2}});
  try {
    // The job says demo 1 but the board is demo 2: preflight compares identities.
    wrongDemo.device.state.demo = 2;
    const {result} = await pairAndDeploy(wrongDemo);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /Demo 1.*runs Demo 2/);
    assert.equal(result.acked, 0, 'nothing uploaded');
  } finally { await wrongDemo.device.stop(); }
});

test('the board refuses an image compiled for a different board and a wrong-demo image at finish', async () => {
  const ctx = await boot({firmware: {target: 'ATECH-FFFFFFFFFFFF'}});
  try {
    const {result} = await pairAndDeploy(ctx);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /built for ATECH-FFFFFFFFFFFF/);
    assert.equal(ctx.device.state.build, 'stock');
    assert.equal(ctx.device.state.session, null, 'session discarded');
  } finally { await ctx.device.stop(); }
  const demoMismatch = await boot({firmware: {demo: 2}});
  try {
    const {result} = await pairAndDeploy(demoMismatch);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /different Atech demo/);
  } finally { await demoMismatch.device.stop(); }
});

test('an invalid image (not an ESP32-S3 application) is rejected while streaming', async () => {
  const ctx = await boot();
  try {
    const bad = syntheticFirmware({demo: 1, build: ctx.job.buildId, chipId: 0, size: 100 * 1024});
    const raw = ctx.jobs.jobs.get(ctx.job.id);
    fs.writeFileSync(path.join(ctx.jobs.jobsDir, ctx.job.id, 'firmware.bin'), bad);
    ctx.jobs.update(raw, {firmware: {...raw.firmware, size: bad.length, sha256: auth.sha256Hex(bad)}});
    ctx.job = ctx.jobs.get(ctx.job.id);
    const {result} = await pairAndDeploy(ctx);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /not ESP32-S3/);
    assert.equal(ctx.device.state.build, 'stock');
  } finally { await ctx.device.stop(); }
});

test('an interrupted upload leaves the previous firmware running and a retry succeeds', async () => {
  const ctx = await boot({faults: {dropAfterBytes: 150 * 1024}});
  try {
    const {result} = await pairAndDeploy(ctx);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /closed the connection|Chunk at|socket hang up|did not answer/i);
    assert.equal(ctx.device.state.session, null, 'the board discarded the partial session');
    assert.match(ctx.device.state.lastTransferError, /Connection lost/);
    assert.equal(ctx.device.state.build, 'stock');
    assert.equal(ctx.device.state.otaOwner, '');
    ctx.device.state.faults = {};
    const retry = ctx.deployments.create({jobId: ctx.job.id, deviceId: BOARD});
    const again = await ctx.deployments.run(retry.id);
    assert.equal(again.state, 'verified', again.error);
    assert.equal(ctx.device.state.build, ctx.job.buildId);
  } finally { await ctx.device.stop(); }
});

test('an abort during transfer stops safely and never switches transports', async () => {
  const ctx = await boot({faults: {slowChunkMs: 30}});
  try {
    const {result, seen} = await pairAndDeploy(ctx, {abortAt: 64 * 1024});
    assert.equal(result.state, 'aborted');
    assert.match(result.error, /previous firmware keeps running/);
    assert.ok(!seen.some(s => ['finishing', 'rebooting'].includes(s.state)), 'no finish after abort');
    assert.equal(ctx.device.state.session, null);
    assert.equal(ctx.device.state.build, 'stock');
    assert.equal(ctx.jobs.get(ctx.job.id).deployments.at(-1).result, 'aborted');
  } finally { await ctx.device.stop(); }
});

test('a board that rolls back, hangs its app or boots into safe mode is reported, never marked verified', async () => {
  const rolled = await boot({faults: {rollbackOnReboot: true}});
  try {
    const {result} = await pairAndDeploy(rolled);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /reports build stock, expected/);
    assert.match(result.error, /rolled back/);
  } finally { await rolled.device.stop(); }
  const hung = await boot({faults: {appHangs: true}});
  try {
    const {result} = await pairAndDeploy(hung);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /did not execute/);
    assert.equal(hung.device.state.pending, true, 'the image stays pending so a reset rolls back');
    assert.equal(hung.device.state.confirmCount, 0);
  } finally { await hung.device.stop(); }
  const safe = await boot({faults: {safeModeAfterReboot: true}});
  try {
    const {result} = await pairAndDeploy(safe);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /safe mode/);
  } finally { await safe.device.stop(); }
});

test('an unreachable board fails preflight with an actionable message and the registry refreshes by mDNS', async () => {
  const ctx = await boot();
  try {
    await ctx.devices.pair({host: '127.0.0.1', port: ctx.device.port, token: SECRET});
    const port = ctx.device.port;
    await ctx.device.stop();
    const created = ctx.deployments.create({jobId: ctx.job.id, deviceId: BOARD});
    const result = await ctx.deployments.run(created.id);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /not reachable over Wi-Fi/);
    // Simulate the board coming back on a new address found through mDNS.
    const moved = createFakeDevice({id: BOARD, demo: 1, build: 'stock', secret: SECRET, rebootMs: 100});
    await moved.start();
    ctx.devices.deps.discover = async () => [{instance: 'x', host: 'atech-d4e5f6.local', port: moved.port, addresses: ['127.0.0.1'], txt: {id: BOARD}}];
    const refreshed = await ctx.devices.refresh();
    assert.equal(refreshed[0].online, true);
    assert.equal(ctx.devices.get(BOARD).port, moved.port);
    assert.notEqual(moved.port, port);
    await moved.stop();
  } finally { /* stopped above */ }
});

test('discovery merges mDNS answers with pairing state', async () => {
  const ctx = await boot();
  try {
    ctx.devices.deps.discover = async () => [{instance: 'Atech D4E5F6', host: 'atech-d4e5f6.local', port: ctx.device.port, addresses: ['127.0.0.1'], txt: {id: BOARD, demo: '1'}},
                                             {instance: 'ghost', host: 'ghost.local', port: 1, addresses: [], txt: {id: 'ATECH-000000000001'}}];
    const before = await ctx.devices.discover();
    assert.equal(before[0].id, BOARD);
    assert.equal(before[0].paired, false);
    assert.equal(before[0].identity.build, 'stock');
    assert.equal(before[1].identity, null);
    await ctx.devices.pair({host: '127.0.0.1', port: ctx.device.port, token: SECRET});
    const after = await ctx.devices.discover();
    assert.equal(after[0].paired, true);
    assert.equal(ctx.devices.remove(BOARD), true);
    assert.equal(ctx.devices.list().length, 0);
  } finally { await ctx.device.stop(); }
});
