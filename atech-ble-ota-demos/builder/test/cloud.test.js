'use strict';

// Cloud deployment store and device API, exercised over HTTP by the simulated
// cloud board (lib/fake-cloud-device.js). Simulations prove protocol and state
// machine behaviour, not ESP32 radio, TLS or flash performance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {DeviceRegistry} = require('../lib/devices');
const {CloudDeviceService} = require('../lib/cloud-devices');
const {CloudDeploymentStore} = require('../lib/cloud-ota');
const {createDeviceHandler} = require('../lib/cloud-routes');
const {createFakeCloudDevice} = require('../lib/fake-cloud-device');
const {syntheticFirmware} = require('../lib/fake-device');
const {proofHex, parseKv} = require('../lib/cloud-auth');
const {sha256Hex} = require('../lib/lan-auth');
const {JobStore} = require('../lib/jobs');
const {loadConfig} = require('../lib/config');
const {tempConfig} = require('./helpers');

const BOARD = 'ATECH-A1B2C3D4E5F6';
const OTHER = 'ATECH-000000000002';
const SECRET = 'fixture-ota-token-0123456789';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boot({demo = 1, jobDemo = null, firmware = {}, faults = {}, cloudOverrides = {}, startDevice = true} = {}) {
  const config = {...tempConfig(), cloud: {...loadConfig({}).cloud, pollMs: 60, jobTtlMs: 2000, stallMs: 400, rebootTimeoutMs: 800,
                                           confirmTimeoutMs: 400, offlineAfterMs: 200, maxAttempts: 5, chunkBytes: 65536, ...cloudOverrides}};
  let offset = 0;
  const now = () => Date.now() + offset;
  const advance = ms => { offset += ms; };
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null, now}});
  const cloud = new CloudDeviceService({config, devices, now});
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }}, deps: {readApiHeader: () => '//'}});
  const job = jobs.create({demo: jobDemo || demo, prompt: 'blink', deviceId: firmware.deviceId ?? ''});
  const image = syntheticFirmware({demo: firmware.demo ?? (jobDemo || demo), build: firmware.build ?? job.buildId, target: firmware.target ?? '', size: firmware.size ?? 300 * 1024});
  fs.writeFileSync(path.join(jobs.jobsDir, job.id, 'firmware.bin'), image);
  jobs.update(jobs.jobs.get(job.id), {state: 'ready', stage: 'Ready', firmware: {size: image.length, crc32: '0', sha256: sha256Hex(image), path: 'x'},
                                      appName: 'Blink', summary: 's', code: '//'});
  const store = new CloudDeploymentStore({config, jobs, devices, cloud, now});
  const handler = createDeviceHandler({cloud, cloudDeployments: store});
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://device-api');
    if (!(await handler(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const device = createFakeCloudDevice({id: BOARD, demo, secret: SECRET, baseUrl, faults, pollMs: 40, chunkBytes: 65536});
  if (startDevice) device.start();
  const claim = (ownerId = 'alice') => cloud.claim({id: BOARD, token: SECRET, name: 'Desk', ownerId});
  const create = (ownerId = 'alice', deviceId = BOARD) => store.create({jobId: job.id, deviceId, ownerId});
  const states = [];
  const follow = id => store.subscribe(id, snapshot => { if (states.at(-1) !== snapshot.state) states.push(snapshot.state); });
  const stop = async () => { await device.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  // A session for direct calls against the device API, independent of the fake board.
  const session = async (id = BOARD) => {
    const {nonce} = cloud.challenge({id, ip: 'test'});
    return (await cloud.login({id, nonce, proof: proofHex(SECRET, {deviceId: id, nonce}), info: {demo: String(demo), build: 'stock'}, ip: 'test'})).session;
  };
  return {config, devices, cloud, jobs, job: jobs.get(job.id), image, store, server, baseUrl, device, claim, create, states, follow, stop, advance, now, session};
}

test('pairing: wrong token refused, right token claims, other owner cannot deploy', async () => {
  const ctx = await boot();
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await assert.rejects(ctx.cloud.claim({id: BOARD, token: 'wrong-token-wrong-token', ownerId: 'alice'}), error => error.code === 'token_mismatch');
    const record = await ctx.claim('alice');
    assert.equal(record.ownerId, 'alice');
    assert.throws(() => ctx.create('bob'), error => error.status === 403);
    const created = ctx.create('alice');
    assert.equal(created.state, 'pending');
    assert.equal(created.transport, 'cloud');
    assert.equal(created.ownerId, 'alice');
    assert.ok(created.expiresAt);
  } finally { await ctx.stop(); }
});

test('wrong device id: a job addressed to another board is never offered to this board', async () => {
  const ctx = await boot();
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    await ctx.cloud.claim({id: OTHER, token: 'other-board-token-0123456789', ownerId: 'alice'});
    const created = ctx.create('alice', OTHER);
    await wait(300);
    assert.equal(ctx.store.get(created.id).state, 'pending');
    assert.equal(ctx.device.stats.downloads, 0);
    const token = await ctx.session();
    const response = await fetch(`${ctx.baseUrl}/api/device/jobs/${created.id}/firmware`, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(response.status, 403);
    assert.match(parseKv(await response.text()).error, /another board/);
    assert.throws(() => ctx.store.openFirmware(created.id, BOARD, {}), error => error.status === 403);
    assert.throws(() => ctx.store.openFirmware('nope', BOARD, {}), error => error.status === 404);
  } finally { await ctx.stop(); }
});

test('firmware mismatch: demo and bound-device mismatches are refused at create, a digest mismatch is refused by the board', async () => {
  const wrongDemo = await boot({demo: 1, jobDemo: 2});
  try {
    await wrongDemo.device.waitFor(() => wrongDemo.device.stats.unclaimed > 0, 2000);
    await wrongDemo.claim();
    assert.throws(() => wrongDemo.create(), /Demo 2.*runs Demo 1/);
  } finally { await wrongDemo.stop(); }
  const bound = await boot({firmware: {deviceId: 'ATECH-FFFFFFFFFFFF'}});
  try {
    await bound.device.waitFor(() => bound.device.stats.unclaimed > 0, 2000);
    await bound.claim();
    assert.throws(() => bound.create(), /bound to ATECH-FFFFFFFFFFFF/);
  } finally { await bound.stop(); }
  const digest = await boot({faults: {shaMismatch: true}});
  try {
    await digest.device.waitFor(() => digest.device.stats.unclaimed > 0, 2000);
    await digest.claim();
    const created = digest.create();
    await digest.device.waitFor(() => ['failed', 'succeeded'].includes(digest.store.get(created.id).state), 4000);
    const final = digest.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'device');
    assert.match(final.error, /SHA-256/);
    assert.equal(digest.device.state.build, 'stock', 'nothing was activated');
  } finally { await digest.stop(); }
});

test('duplicate deployments are refused while one is active', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim();
    const first = ctx.create();
    assert.throws(() => ctx.create(), error => error.status === 409 && error.code === 'duplicate');
    ctx.store.cancel(first.id);
    const second = ctx.create();
    assert.notEqual(second.id, first.id);
  } finally { await ctx.stop(); }
});

test('an offline board shows offline, then picks the job up and succeeds', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim();
    const created = ctx.create();
    ctx.follow(created.id);
    assert.equal(ctx.store.get(created.id).offline, true, 'the board has never polled');
    assert.equal(ctx.store.get(created.id).state, 'pending');
    ctx.device.faults.offline = false;
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'succeeded', final.error);
    assert.equal(final.offline, false);
    assert.deepEqual(ctx.states, ['downloading', 'installing', 'rebooting', 'succeeded']);
    assert.equal(final.percent, 100);
    assert.equal(final.received, ctx.image.length);
    assert.equal(final.after.build, ctx.job.buildId);
    assert.equal(final.before.build, 'stock');
    assert.ok(final.checks.some(c => /confirmed/.test(c)));
    for (const key of ['queuedMs', 'downloadMs', 'installMs', 'rebootMs', 'totalMs']) assert.ok(Number.isFinite(final.timings[key]), key);
    assert.equal(ctx.device.state.build, ctx.job.buildId);
    assert.equal(ctx.device.state.pending, false, 'the board confirmed only after the backend acknowledged the new build');
    assert.equal(ctx.device.state.confirmCount, 1);
    assert.equal(ctx.device.state.bootMarker, null);
    assert.equal(ctx.device.state.done, created.id);
    assert.equal(ctx.cloud.isOnline(BOARD), true);
    const job = ctx.jobs.get(ctx.job.id);
    assert.equal(job.deployments.at(-1).result, 'succeeded');
    assert.equal(job.deployments.at(-1).transport, 'cloud');
    assert.ok(ctx.devices.describe(BOARD).cloud.lastReport.heap > 0, 'reports carry the free heap');
  } finally { await ctx.stop(); }
});

test('an interrupted download resumes with a range and succeeds', async () => {
  const ctx = await boot({faults: {dropDownloadAfterBytes: 100 * 1024}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'succeeded', final.error);
    assert.equal(final.attempts, 2, 'one fresh start plus one resumption');
    assert.ok(ctx.device.stats.ranges.some(r => r.startsWith('bytes=102400-')), ctx.device.stats.ranges.join(' '));
    assert.equal(ctx.device.state.build, ctx.job.buildId);
  } finally { await ctx.stop(); }
});

test('download retries are capped', async () => {
  const ctx = await boot({faults: {corruptChunks: true}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'attempts');
    assert.equal(final.attempts, 6);
    assert.equal(ctx.device.state.build, 'stock');
    assert.equal(ctx.device.state.transferring, false);
  } finally { await ctx.stop(); }
});

test('an expired job fails and is never handed out', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim();
    const created = ctx.create();
    ctx.advance(3000);
    assert.equal(ctx.store.tick(), 1);
    const expired = ctx.store.get(created.id);
    assert.equal(expired.state, 'failed');
    assert.equal(expired.reason, 'expired');
    assert.match(expired.error, /30 minutes|did not pick up/i);
    assert.equal(ctx.store.poll(BOARD, {ready: '1'}).job, null);
    ctx.device.faults.offline = false;
    await wait(300);
    assert.equal(ctx.device.stats.downloads, 0);
    assert.equal(ctx.store.get(created.id).state, 'failed');
  } finally { await ctx.stop(); }
});

test('lost network during download fails the job after the stall timeout', async () => {
  const ctx = await boot({faults: {vanishAfterPhase: 'downloading'}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ctx.store.get(created.id).state === 'downloading' && ctx.store.get(created.id).received > 0, 3000);
    assert.equal(ctx.device.faults.offline, true, 'the simulated board vanished');
    assert.equal(ctx.store.tick(), 0, 'nothing times out before the stall window');
    ctx.advance(500);
    assert.equal(ctx.store.tick(), 1);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'stalled');
    assert.ok(final.received > 0 && final.received < ctx.image.length);
  } finally { await ctx.stop(); }
});

test('reboot confirmation: a rolled back board fails the job, safe mode asks for a rollback, never returning fails after the timeout', async () => {
  const rolled = await boot({faults: {rollbackOnReboot: true}});
  try {
    await rolled.device.waitFor(() => rolled.device.stats.unclaimed > 0, 2000);
    await rolled.claim();
    const created = rolled.create();
    await rolled.device.waitFor(() => ['failed', 'succeeded'].includes(rolled.store.get(created.id).state), 5000);
    const final = rolled.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'rolled_back');
    assert.match(final.error, /rolled back to build stock/);
    await rolled.device.waitFor(() => rolled.device.state.bootMarker === null, 2000);
    assert.equal(rolled.device.state.confirmCount, 0);
  } finally { await rolled.stop(); }
  const safe = await boot({faults: {safeModeOnReboot: true}});
  try {
    await safe.device.waitFor(() => safe.device.stats.unclaimed > 0, 2000);
    await safe.claim();
    const created = safe.create();
    await safe.device.waitFor(() => ['failed', 'succeeded'].includes(safe.store.get(created.id).state), 5000);
    const final = safe.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'safe_mode');
    await safe.device.waitFor(() => safe.device.state.build === 'stock' && !safe.device.state.safe, 2000);
    assert.equal(safe.device.stats.rollbacks, 1, 'the backend asked the board to roll back');
    assert.equal(safe.device.state.confirmCount, 0);
  } finally { await safe.stop(); }
  const gone = await boot({faults: {noReboot: true}});
  try {
    await gone.device.waitFor(() => gone.device.stats.unclaimed > 0, 2000);
    await gone.claim();
    const created = gone.create();
    await gone.device.waitFor(() => gone.store.get(created.id).state === 'rebooting', 5000);
    assert.equal(gone.store.tick(), 0);
    gone.advance(1000);
    assert.equal(gone.store.tick(), 1);
    const final = gone.store.get(created.id);
    assert.equal(final.state, 'failed');
    assert.equal(final.reason, 'reboot_timeout');
  } finally { await gone.stop(); }
});

test('late success: a board that returns after the reboot timeout still completes the job', async () => {
  const ctx = await boot({faults: {rebootMs: 500}, cloudOverrides: {rebootTimeoutMs: 100}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ctx.store.get(created.id).state === 'rebooting', 5000);
    await wait(150);
    assert.equal(ctx.store.tick(), 1);
    assert.equal(ctx.store.get(created.id).reason, 'reboot_timeout');
    await ctx.device.waitFor(() => ctx.store.get(created.id).state === 'succeeded', 5000);
    const final = ctx.store.get(created.id);
    assert.match(final.note, /after the timeout/);
    assert.equal(final.reason, null);
    assert.equal(ctx.device.state.pending, false);
  } finally { await ctx.stop(); }
});

test('poll with ready=0 leaves the job pending', async () => {
  const ctx = await boot({faults: {busy: true}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ctx.device.stats.polls > 3, 2000);
    const waiting = ctx.store.get(created.id);
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.offline, false);
    assert.match(waiting.stage, /busy with another update/);
    assert.equal(ctx.device.stats.downloads, 0);
    ctx.device.faults.busy = false;
    await ctx.device.waitFor(() => ctx.store.get(created.id).state === 'succeeded', 5000);
  } finally { await ctx.stop(); }
});

test('firmware range handling', async () => {
  const ctx = await boot({startDevice: false});
  try {
    await ctx.claim();
    const created = ctx.create();
    const token = await ctx.session();
    const handed = ctx.store.poll(BOARD, {ready: '1', build: 'stock'});
    assert.equal(handed.job.job, created.id);
    assert.equal(handed.job.size, ctx.image.length);
    assert.equal(handed.job.sha256, sha256Hex(ctx.image));
    assert.equal(handed.job.url, `/api/device/jobs/${created.id}/firmware`);
    assert.equal(ctx.store.get(created.id).state, 'downloading');
    const beyond = await fetch(`${ctx.baseUrl}${handed.job.url}`, {headers: {authorization: `Bearer ${token}`, range: 'bytes=999999-'}});
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${ctx.image.length}`);
    const first = await fetch(`${ctx.baseUrl}${handed.job.url}`, {headers: {authorization: `Bearer ${token}`, range: 'bytes=0-65535'}});
    assert.equal(first.status, 206);
    assert.equal(first.headers.get('content-range'), `bytes 0-65535/${ctx.image.length}`);
    assert.equal(first.headers.get('x-atech-sha256'), sha256Hex(ctx.image));
    assert.equal(first.headers.get('x-atech-build'), ctx.job.buildId);
    assert.equal((await first.arrayBuffer()).byteLength, 65536);
    const whole = await fetch(`${ctx.baseUrl}${handed.job.url}`, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(whole.status, 200);
    assert.equal(Number(whole.headers.get('content-length')), ctx.image.length);
    assert.equal(Buffer.compare(Buffer.from(await whole.arrayBuffer()), ctx.image), 0);
    const unauthenticated = await fetch(`${ctx.baseUrl}${handed.job.url}`);
    assert.equal(unauthenticated.status, 401);
    ctx.store.report(created.id, BOARD, {phase: 'installing', received: String(ctx.image.length), total: String(ctx.image.length)});
    assert.equal(ctx.store.get(created.id).state, 'installing');
    const late = await fetch(`${ctx.baseUrl}${handed.job.url}`, {headers: {authorization: `Bearer ${token}`, range: 'bytes=0-10'}});
    assert.equal(late.status, 409);
    assert.throws(() => ctx.store.openFirmware(created.id, BOARD, {range: 'bytes=0-1'}), error => error.status === 409);
  } finally { await ctx.stop(); }
});

test('reports from another board are refused', async () => {
  const ctx = await boot({startDevice: false});
  try {
    await ctx.claim();
    const created = ctx.create();
    assert.throws(() => ctx.store.report(created.id, OTHER, {phase: 'failed', error: 'boom'}), error => error.status === 403);
    assert.equal(ctx.store.get(created.id).state, 'pending');
    assert.throws(() => ctx.store.report('nope', BOARD, {phase: 'failed'}), error => error.status === 404);
  } finally { await ctx.stop(); }
});

test('cancel works only while pending and the board never sees a cancelled job', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim();
    const created = ctx.create();
    const cancelled = ctx.store.cancel(created.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'cancelled');
    assert.throws(() => ctx.store.cancel(created.id), error => error.status === 409);
    assert.equal(ctx.jobs.get(ctx.job.id).deployments.at(-1).result, 'cancelled');
    ctx.device.faults.offline = false;
    await wait(300);
    assert.equal(ctx.device.stats.downloads, 0);
    const again = ctx.create();
    await ctx.device.waitFor(() => ctx.store.get(again.id).state !== 'pending', 3000);
    assert.throws(() => ctx.store.cancel(again.id), error => error.status === 409 && /picked up/.test(error.message));
  } finally { await ctx.stop(); }
});

test('the store survives a restart', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim();
    const created = ctx.create();
    const reloaded = new CloudDeploymentStore({config: ctx.config, jobs: ctx.jobs, devices: ctx.devices, cloud: ctx.cloud, now: ctx.now});
    assert.equal(reloaded.get(created.id).state, 'pending');
    assert.equal(reloaded.list({ownerId: 'alice'}).length, 1);
    assert.equal(reloaded.list({ownerId: 'bob'}).length, 0);
    assert.equal(reloaded.list({deviceId: OTHER}).length, 0);
    assert.ok(reloaded.activeFor(BOARD));
  } finally { await ctx.stop(); }
});

test('a lost success report is repeated on the next poll instead of failing the job', async () => {
  const ctx = await boot({faults: {dropReports: {succeeded: 1}}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    assert.equal(ctx.store.get(created.id).state, 'succeeded', ctx.store.get(created.id).error);
    assert.equal(ctx.device.stats.droppedReports, 1);
    assert.equal(ctx.device.state.confirmCount, 1, 'confirmed once');
    // The repeated report is answered on the poll after the one that marked the job succeeded.
    await ctx.device.waitFor(() => ctx.device.state.bootMarker === null, 2000);
    assert.equal(ctx.device.state.bootMarker, null, 'the marker is cleared after the repeated report');
  } finally { await ctx.stop(); }
});

test('a board that confirmed but can never report success is reconciled from its poll', async () => {
  const ctx = await boot({faults: {dropReports: {succeeded: Infinity}}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'succeeded', final.error);
    assert.match(final.note || '', /reconciled/);
    assert.equal(final.after.build, ctx.job.buildId);
  } finally { await ctx.stop(); }
});

test('lost installing and rebooting reports: the booted board is still acknowledged', async () => {
  const ctx = await boot({faults: {dropReports: {installing: 1, rebooting: 1}}});
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.claim();
    const created = ctx.create();
    await ctx.device.waitFor(() => ['failed', 'succeeded'].includes(ctx.store.get(created.id).state), 5000);
    const final = ctx.store.get(created.id);
    assert.equal(final.state, 'succeeded', final.error);
    assert.equal(ctx.device.state.build, ctx.job.buildId);
    assert.equal(ctx.device.state.pending, false);
    assert.ok(ctx.device.stats.downloads <= 5, `one install, not a second download (${ctx.device.stats.downloads} chunk requests)`);
  } finally { await ctx.stop(); }
});

test('forgetting a board cancels its jobs and revokes its sessions; the next owner starts clean', async () => {
  const ctx = await boot({faults: {offline: true}});
  try {
    await ctx.claim('alice');
    const created = ctx.create('alice');
    const token = await ctx.session();
    ctx.store.cancelAllFor(BOARD, 'The board was forgotten');
    ctx.cloud.revokeSessions(BOARD);
    assert.equal(ctx.store.get(created.id).state, 'cancelled');
    assert.throws(() => ctx.cloud.authenticate(`Bearer ${token}`), error => error.status === 401);
    assert.equal(ctx.store.activeFor(BOARD), null);
    ctx.devices.remove(BOARD);
    ctx.device.faults.offline = false;
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 3000);
    assert.equal(ctx.device.stats.downloads, 0, 'the forgotten board never received the old job');
    await ctx.cloud.claim({id: BOARD, token: SECRET, ownerId: 'bob'});
    const again = ctx.create('bob');
    assert.equal(again.ownerId, 'bob');
    await ctx.device.waitFor(() => ctx.store.get(again.id).state === 'succeeded', 5000);
  } finally { await ctx.stop(); }
});

test('an aborted firmware download closes the file stream', async () => {
  const ctx = await boot({startDevice: false, firmware: {size: 2 * 1024 * 1024}});
  try {
    await ctx.claim();
    const created = ctx.create();
    const token = await ctx.session();
    const handed = ctx.store.poll(BOARD, {ready: '1', build: 'stock'});
    const streams = [];
    const original = ctx.store.openFirmware.bind(ctx.store);
    ctx.store.openFirmware = (...args) => { const result = original(...args); streams.push(result.stream); return result; };
    const controller = new AbortController();
    const response = await fetch(`${ctx.baseUrl}${handed.job.url}`, {headers: {authorization: `Bearer ${token}`}, signal: controller.signal});
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await wait(200);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].destroyed, true, 'the read stream is closed when the board goes away');
  } finally { await ctx.stop(); }
});

test('an image from before the provisioning service is refused with a rebuild hint', async () => {
  const ctx = await boot({startDevice: false});
  try {
    await ctx.claim();
    const file = path.join(ctx.jobs.jobsDir, ctx.job.id, 'firmware.bin');
    const image = Buffer.from(fs.readFileSync(file));
    const at = image.indexOf('ATECH-PROV:1', 0, 'latin1');
    assert.ok(at > 0);
    image.fill(0, at, at + 'ATECH-PROV:1'.length);
    fs.writeFileSync(file, image);
    ctx.jobs.update(ctx.jobs.jobs.get(ctx.job.id), {firmware: {size: image.length, crc32: '0', sha256: sha256Hex(image), path: 'x'}});
    assert.throws(() => ctx.create(), error => error.code === 'rebuild' && /before 2026-10-29|rebuild/i.test(error.message));
  } finally { await ctx.stop(); }
});
