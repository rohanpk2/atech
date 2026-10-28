'use strict';

// HTTP routes for devices and LAN deployments, the optional dashboard key and
// the deployment SSE stream, against the simulated board.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JobStore} = require('../lib/jobs');
const {DeviceRegistry} = require('../lib/devices');
const {DeploymentStore} = require('../lib/lan-ota');
const {createFakeDevice, syntheticFirmware} = require('../lib/fake-device');
const {sha256Hex} = require('../lib/lan-auth');
const {createServer, keyPresented, startSimulatedDevices} = require('../server');
const {tempConfig} = require('./helpers');

const SECRET = 'fixture-ota-token-0123456789';
const BOARD = 'ATECH-A1B2C3D4E5F6';

async function boot({key = null} = {}) {
  const config = tempConfig({dashboardKey: key});
  const device = createFakeDevice({id: BOARD, demo: 1, build: 'stock', secret: SECRET, rebootMs: 120});
  await device.start();
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error('unused'); }}, deps: {readApiHeader: () => '//'}});
  const job = jobs.create({demo: 1, prompt: 'blink'});
  const image = syntheticFirmware({demo: 1, build: job.buildId, size: 200 * 1024});
  fs.writeFileSync(path.join(jobs.jobsDir, job.id, 'firmware.bin'), image);
  jobs.update(jobs.jobs.get(job.id), {state: 'ready', firmware: {size: image.length, crc32: '0', sha256: sha256Hex(image), path: 'x'}, appName: 'Blink'});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [{instance: 'a', host: 'atech-d4e5f6.local', port: device.port, addresses: ['127.0.0.1'], txt: {id: BOARD}}], resolveHost: async () => null}});
  const deployments = new DeploymentStore({config: {...config, lanRebootWaitMs: 4000, lanLoopWaitMs: 1500}, jobs, devices, deps: {delay: ms => new Promise(r => setTimeout(r, Math.min(ms, 50)))}});
  const server = createServer({config, jobs, devices, deployments, installer: {manifest: () => ({}), partFile: () => null, ensureBaseBuild: async () => ({})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, init = {}) => fetch(base + p, {...init, headers: {'content-type': 'application/json', ...(key ? {'x-atech-key': key} : {}), ...(init.headers || {})}});
  return {server, base, api, device, jobs, job, devices, deployments, config};
}

test('devices can be discovered, paired, probed, controlled and forgotten over HTTP', async () => {
  const ctx = await boot();
  try {
    const health = await (await ctx.api('/api/health')).json();
    assert.equal(health.lan.devicePort, 8080);
    assert.equal(health.keyRequired, false);
    const found = await (await ctx.api('/api/devices/discover', {method: 'POST'})).json();
    assert.equal(found.found[0].id, BOARD);
    assert.equal(found.found[0].paired, false);
    const bad = await ctx.api('/api/devices/pair', {method: 'POST', body: JSON.stringify({host: '127.0.0.1', port: ctx.device.port, token: 'nope-nope-nope-nope'})});
    assert.equal(bad.status, 400);
    const pair = await ctx.api('/api/devices/pair', {method: 'POST', body: JSON.stringify({host: '127.0.0.1', port: ctx.device.port, token: SECRET, name: 'Desk board'})});
    assert.equal(pair.status, 200);
    const {device} = await pair.json();
    assert.equal(device.name, 'Desk board');
    assert.equal(device.secret, undefined);
    const list = await (await ctx.api('/api/devices?refresh=1')).json();
    assert.equal(list.devices[0].online, true);
    assert.equal(list.devices[0].identity.wifi.ip, '127.0.0.1');
    const probe = await ctx.api(`/api/devices/${BOARD}/probe`, {method: 'POST', body: JSON.stringify({})});
    assert.equal(probe.status, 200);
    const control = await (await ctx.api(`/api/devices/${BOARD}/control`, {method: 'POST', body: JSON.stringify({op: 'echo'})})).json();
    assert.equal(control.ok, true);
    const traversal = await ctx.api('/api/devices/ATECH-ZZZZZZZZZZZZ/probe', {method: 'POST', body: '{}'});
    assert.equal(traversal.status, 404);
    assert.equal((await ctx.api(`/api/devices/${BOARD}`, {method: 'DELETE'})).status, 200);
    assert.equal((await (await ctx.api('/api/devices')).json()).devices.length, 0);
  } finally { ctx.server.close(); await ctx.device.stop(); }
});

test('a deployment streams phases over SSE and ends verified', async () => {
  const ctx = await boot();
  try {
    await ctx.api('/api/devices/pair', {method: 'POST', body: JSON.stringify({host: '127.0.0.1', port: ctx.device.port, token: SECRET})});
    const refused = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: 'ATECH-000000000000'})});
    assert.equal(refused.status, 400);
    const started = await ctx.api(`/api/builds/${ctx.job.id}/deploy`, {method: 'POST', body: JSON.stringify({deviceId: BOARD})});
    assert.equal(started.status, 202);
    const {id} = await started.json();
    const response = await ctx.api(`/api/deployments/${id}/events`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: done')) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.match(text, /"state":"uploading"/);
    assert.match(text, /"state":"verified"/);
    const final = await (await ctx.api(`/api/deployments/${id}`)).json();
    assert.equal(final.state, 'verified', final.error);
    assert.equal(final.percent, 100);
    assert.ok(final.timings.transferMs >= 0);
    const list = await (await ctx.api('/api/deployments')).json();
    assert.equal(list[0].id, id);
    assert.equal((await ctx.api(`/api/deployments/${id}/abort`, {method: 'POST'})).status, 200, 'abort after completion is a no-op');
  } finally { ctx.server.close(); await ctx.device.stop(); }
});

test('the dashboard key gates every API call by header, query or cookie', async () => {
  const ctx = await boot({key: 'secret-key-123'});
  try {
    const blocked = await fetch(`${ctx.base}/api/health`);
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).keyRequired, true);
    assert.equal((await fetch(`${ctx.base}/api/health?key=secret-key-123`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/health`, {headers: {cookie: 'atech_key=secret-key-123'}})).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/health`, {headers: {'x-atech-key': 'wrong'}})).status, 401);
    assert.equal((await fetch(`${ctx.base}/demo1/`)).status, 200, 'static pages still load so the key prompt can appear');
    const req = {headers: {}};
    assert.equal(keyPresented(req, new URL('http://x/api/health'), null), true);
    assert.equal(keyPresented({headers: {cookie: 'a=b; atech_key=k'}}, new URL('http://x/api/health'), 'k'), true);
  } finally { ctx.server.close(); await ctx.device.stop(); }
});

test('simulated boards register themselves as paired devices', async () => {
  const config = tempConfig({simulatedDevices: 'all'});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const started = await startSimulatedDevices(config, devices);
  try {
    assert.equal(started.length, 2);
    const list = devices.list();
    assert.deepEqual(list.map(d => d.demo).sort(), [1, 2]);
    assert.ok(list.every(d => d.paired && d.simulated));
    const refreshed = await devices.refresh();
    assert.ok(refreshed.every(d => d.online));
  } finally { for (const sim of started) await sim.stop(); }
  assert.deepEqual(await startSimulatedDevices(tempConfig({simulatedDevices: null}), devices), []);
});
