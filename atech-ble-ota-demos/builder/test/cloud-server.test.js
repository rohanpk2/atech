'use strict';

// HTTP surface of the cloud path: device routes without the dashboard key,
// owner-scoped dashboard routes, unified deployment routes, simulated boards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JobStore} = require('../lib/jobs');
const {DeviceRegistry} = require('../lib/devices');
const {DeploymentStore} = require('../lib/lan-ota');
const {CloudDeviceService} = require('../lib/cloud-devices');
const {CloudDeploymentStore} = require('../lib/cloud-ota');
const {createFakeCloudDevice} = require('../lib/fake-cloud-device');
const {syntheticFirmware} = require('../lib/fake-device');
const {sha256Hex} = require('../lib/lan-auth');
const {loadConfig} = require('../lib/config');
const {createServer, principalOf, startSimulatedDevices} = require('../server');
const {tempConfig} = require('./helpers');

const SECRET = 'fixture-ota-token-0123456789';
const BOARD = 'ATECH-A1B2C3D4E5F6';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boot({key = 'secret-key-123', faults = {}, startDevice = true} = {}) {
  const config = {...tempConfig({dashboardKey: key}), cloud: {...loadConfig({}).cloud, pollMs: 60, offlineAfterMs: 300, jobTtlMs: 5000, stallMs: 1000, rebootTimeoutMs: 2000, confirmTimeoutMs: 1000}};
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }}, deps: {readApiHeader: () => '//'}});
  const job = jobs.create({demo: 1, prompt: 'blink'});
  const image = syntheticFirmware({demo: 1, build: job.buildId, size: 150 * 1024});
  fs.writeFileSync(path.join(jobs.jobsDir, job.id, 'firmware.bin'), image);
  jobs.update(jobs.jobs.get(job.id), {state: 'ready', firmware: {size: image.length, crc32: '0', sha256: sha256Hex(image), path: 'x'}, appName: 'Blink'});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const cloud = new CloudDeviceService({config, devices});
  const deployments = new DeploymentStore({config, jobs, devices});
  const cloudDeployments = new CloudDeploymentStore({config, jobs, devices, cloud});
  const server = createServer({config, jobs, devices, deployments, cloud, cloudDeployments, installer: {manifest: () => ({}), partFile: () => null, ensureBaseBuild: async () => ({})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, {user = 'alice', ...init} = {}) => fetch(base + p, {...init, headers: {'content-type': 'application/json', ...(key ? {'x-atech-key': key} : {}), ...(user ? {'x-atech-user': user} : {}), ...(init.headers || {})}});
  const device = createFakeCloudDevice({id: BOARD, demo: 1, secret: SECRET, baseUrl: base, faults, pollMs: 40, chunkBytes: 32 * 1024});
  if (startDevice) device.start();
  const stop = async () => { await device.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return {config, jobs, job, devices, cloud, deployments, cloudDeployments, server, base, api, device, stop};
}

async function readSse(response, until) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(until)) {
    const {value, done} = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

test('device routes work without the dashboard key and dashboard routes still require it', async () => {
  const ctx = await boot({startDevice: false});
  try {
    const challenge = await fetch(`${ctx.base}/api/device/challenge?id=${BOARD}`);
    assert.equal(challenge.status, 200);
    assert.match(challenge.headers.get('content-type'), /text\/plain/);
    const text = await challenge.text();
    assert.match(text, /^ok=1\n/);
    assert.match(text, /\nclaimed=0\n/);
    const bad = await fetch(`${ctx.base}/api/device/challenge?id=nope`);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /^ok=0\ncode=bad_request\n/);
    assert.equal((await fetch(`${ctx.base}/api/device/poll`, {method: 'POST', body: ''})).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/devices`)).status, 401, 'dashboard routes still need the key');
    assert.equal((await ctx.api('/api/devices')).status, 200);
    const health = await (await ctx.api('/api/health')).json();
    assert.equal(health.cloud.pollMs, 60);
    assert.equal(health.cloud.devicePath, '/api/device/');
    assert.equal(ctx.server.keepAliveTimeout, 65000, 'boards reuse one TLS connection between a chunk and its status report');
  } finally { await ctx.stop(); }
});

test('claim, list with last seen and unclaimed, deploy via cloud, follow over SSE and polling', async () => {
  const ctx = await boot();
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    const before = await (await ctx.api('/api/devices')).json();
    assert.deepEqual(before.devices, []);
    assert.equal(before.unclaimed[0].id, BOARD);
    assert.equal(before.unclaimed[0].demo, 1);
    const wrong = await ctx.api('/api/devices/claim', {method: 'POST', body: JSON.stringify({id: BOARD, token: 'wrong-token-wrong-token'})});
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /does not match/);
    const claim = await ctx.api('/api/devices/claim', {method: 'POST', body: JSON.stringify({id: BOARD, token: SECRET, name: 'Desk board'})});
    assert.equal(claim.status, 200);
    const {device} = await claim.json();
    assert.equal(device.ownerId, 'alice');
    assert.equal(device.name, 'Desk board');
    assert.equal(device.secret, undefined);
    await ctx.device.waitFor(() => ctx.device.stats.logins > 0, 2000);
    const listed = await (await ctx.api('/api/devices')).json();
    assert.equal(listed.devices[0].id, BOARD);
    assert.equal(listed.devices[0].online, true);
    assert.equal(listed.devices[0].via, 'cloud');
    assert.equal(listed.devices[0].cloud.online, true);
    assert.ok(listed.devices[0].cloud.lastSeenAt);
    assert.equal(listed.devices[0].identity.build, 'stock');
    assert.deepEqual(listed.unclaimed, []);
    const started = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    assert.equal(started.status, 202);
    const {id, deployment} = await started.json();
    assert.equal(deployment.transport, 'cloud');
    assert.equal(deployment.state, 'pending');
    const duplicate = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    assert.equal(duplicate.status, 409);
    const events = await ctx.api(`/api/deployments/${id}/events`);
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const text = await readSse(events, 'event: done');
    assert.match(text, /"state":"downloading"/);
    assert.match(text, /"state":"succeeded"/);
    const final = await (await ctx.api(`/api/deployments/${id}`)).json();
    assert.equal(final.state, 'succeeded', final.error);
    assert.equal(final.transport, 'cloud');
    assert.equal(final.percent, 100);
    const list = await (await ctx.api('/api/deployments')).json();
    assert.equal(list[0].id, id);
    assert.equal((await (await ctx.api(`/api/builds/${ctx.job.id}`)).json()).deployments.at(-1).transport, 'cloud');
    assert.equal(ctx.device.state.build, ctx.job.buildId);
    const again = await (await ctx.api('/api/devices')).json();
    assert.equal(again.devices[0].identity.build, ctx.job.buildId, 'the list reflects the board\'s latest report');
  } finally { await ctx.stop(); }
});

test("ownership: bob cannot see, deploy to, or forget alice's board", async () => {
  const ctx = await boot({startDevice: false});
  try {
    await ctx.api('/api/devices/claim', {method: 'POST', body: JSON.stringify({id: BOARD, token: SECRET})});
    assert.deepEqual((await (await ctx.api('/api/devices', {user: 'bob'})).json()).devices, []);
    const deploy = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', user: 'bob', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    assert.equal(deploy.status, 403);
    assert.match((await deploy.json()).error, /another dashboard user/);
    assert.equal((await ctx.api(`/api/devices/${BOARD}`, {method: 'DELETE', user: 'bob'})).status, 403);
    assert.equal((await ctx.api(`/api/devices/${BOARD}/control`, {method: 'POST', user: 'bob', body: JSON.stringify({op: 'echo'})})).status, 403);
    const reclaim = await ctx.api('/api/devices/claim', {method: 'POST', user: 'bob', body: JSON.stringify({id: BOARD, token: SECRET})});
    assert.equal(reclaim.status, 403);
    const started = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    assert.equal(started.status, 202);
    const {id} = await started.json();
    assert.equal((await ctx.api(`/api/deployments/${id}`, {user: 'bob'})).status, 403);
    assert.deepEqual(await (await ctx.api('/api/deployments', {user: 'bob'})).json(), []);
    assert.equal((await ctx.api(`/api/deployments/${id}/abort`, {method: 'POST', user: 'bob'})).status, 403);
    assert.equal((await ctx.api(`/api/devices/${BOARD}`, {method: 'DELETE'})).status, 200, 'the owner can forget it');
  } finally { await ctx.stop(); }
});

test('principalOf honours the header only behind the dashboard key', () => {
  assert.equal(principalOf({headers: {'x-atech-user': 'a'}}, {dashboardKey: null}), 'local');
  assert.equal(principalOf({headers: {'x-atech-user': ' a '}}, {dashboardKey: 'k'}), 'a');
  assert.equal(principalOf({headers: {}}, {dashboardKey: 'k'}), 'local');
  assert.equal(principalOf({headers: {'x-atech-user': 'x'.repeat(100)}}, {dashboardKey: 'k'}).length, 64);
});

test('a cancelled pending job is reported and the board never receives it', async () => {
  const ctx = await boot({startDevice: false});
  try {
    await ctx.api('/api/devices/claim', {method: 'POST', body: JSON.stringify({id: BOARD, token: SECRET})});
    const started = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    const {id} = await started.json();
    const pending = await (await ctx.api(`/api/deployments/${id}`)).json();
    assert.equal(pending.offline, true);
    const cancelled = await ctx.api(`/api/deployments/${id}/abort`, {method: 'POST'});
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, 'cancelled');
    assert.equal((await ctx.api(`/api/deployments/${id}/abort`, {method: 'POST'})).status, 409);
    ctx.device.start();
    await ctx.device.waitFor(() => ctx.device.stats.polls > 2, 2000);
    assert.equal(ctx.device.stats.downloads, 0);
    const events = await ctx.api(`/api/deployments/${id}/events`);
    assert.match(await readSse(events, 'event: done'), /"state":"cancelled"/);
  } finally { await ctx.stop(); }
});

test('simulated boards register over the cloud too', async () => {
  const config = {...tempConfig({simulatedDevices: 'all'}), cloud: {...loadConfig({}).cloud, pollMs: 50, offlineAfterMs: 1000}};
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }}, deps: {readApiHeader: () => '//'}});
  const cloud = new CloudDeviceService({config, devices});
  const cloudDeployments = new CloudDeploymentStore({config, jobs, devices, cloud});
  const server = createServer({config, jobs, devices, cloud, cloudDeployments, installer: {manifest: () => ({}), partFile: () => null, ensureBaseBuild: async () => ({})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = await startSimulatedDevices(config, devices, {baseUrl: base});
  try {
    assert.equal(started.length, 2);
    assert.ok(started.every(sim => sim.cloudAgent), 'each simulated board runs a cloud agent');
    await started[0].cloudAgent.waitFor(() => started.every(sim => sim.cloudAgent.stats.logins > 0), 3000);
    const list = devices.list('anyone');
    assert.deepEqual(list.map(d => d.demo).sort(), [1, 2]);
    assert.ok(list.every(d => d.paired && d.simulated && d.cloud.online), JSON.stringify(list.map(d => d.cloud)));
    assert.ok(list.every(d => d.ownerId == null), 'simulated boards belong to everyone');
    assert.deepEqual(await startSimulatedDevices(tempConfig({simulatedDevices: null}), devices), []);
  } finally {
    for (const sim of started) await sim.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('forgetting a board over HTTP cancels its pending job and the board is logged out', async () => {
  const ctx = await boot();
  try {
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0, 2000);
    await ctx.api('/api/devices/claim', {method: 'POST', body: JSON.stringify({id: BOARD, token: SECRET})});
    await ctx.device.waitFor(() => ctx.device.stats.logins > 0, 2000);
    ctx.device.faults.busy = true;   // the board polls but is not ready, so the job stays pending
    const started = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD, via: 'cloud'})});
    const {id} = await started.json();
    await ctx.device.waitFor(() => ctx.store?.get?.(id)?.state === 'pending' || true, 10);
    assert.equal((await ctx.api(`/api/devices/${BOARD}`, {method: 'DELETE'})).status, 200);
    const cancelled = await (await ctx.api(`/api/deployments/${id}`)).json();
    assert.equal(cancelled.state, 'cancelled');
    assert.match(cancelled.error, /forgotten/);
    const polls = ctx.device.stats.polls;
    await ctx.device.waitFor(() => ctx.device.stats.unclaimed > 0 && ctx.device.stats.polls === polls, 4000);
    ctx.device.faults.busy = false;
    await wait(300);
    assert.equal(ctx.device.stats.downloads, 0);
  } finally { await ctx.stop(); }
});
