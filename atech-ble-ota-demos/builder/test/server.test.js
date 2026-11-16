'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JobStore} = require('../lib/jobs');
const {createServer} = require('../server');
const {tempConfig, GOOD_CODE, fakeProvider, fakeWorkspace} = require('./helpers');

async function boot() {
  const config = tempConfig();
  const workspace = fakeWorkspace([]);
  const jobs = new JobStore({config, provider: fakeProvider([
    {name: 'Blink', summary: 'Blinks', code: GOOD_CODE},
    {name: 'Blink', summary: 'Blinks', code: GOOD_CODE},
  ]), deps: {prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace,
             readApiHeader: () => '// header'}});
  const server = createServer({config, jobs, installer: {manifest: () => ({builds: []}), partFile: () => null,
                               ensureBaseBuild: async () => ({dir: '/nowhere'})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {server, base, jobs, config};
}

async function waitForState(base, id, wanted, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await (await fetch(`${base}/api/builds/${id}`)).json();
    if (wanted.includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for job state');
}

test('health, demo info and the build lifecycle over HTTP', async () => {
  const {server, base} = await boot();
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.provider, 'fake');
    const info = await (await fetch(`${base}/api/demos/1`)).json();
    assert.equal(info.blePrefix, 'Atech-Custom-OTA');
    assert.equal(info.slotSize, 6291456);
    assert.ok(info.allowedPins.includes(4));

    const created = await fetch(`${base}/api/builds`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({demo: 1, prompt: 'Blink', deviceId: 'ATECH-AABBCCDDEEFF'})});
    assert.equal(created.status, 202);
    const {id} = await created.json();
    const job = await waitForState(base, id, ['ready', 'failed']);
    assert.equal(job.state, 'ready', job.error);

    const bin = await fetch(`${base}/api/builds/${id}/firmware.bin`);
    assert.equal(bin.status, 200);
    assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
    assert.match(bin.headers.get('content-disposition'), new RegExp(`atech-demo1-${job.buildId}\\.bin`));
    assert.equal((await bin.arrayBuffer()).byteLength, job.firmware.size);

    const list = await (await fetch(`${base}/api/builds?demo=1`)).json();
    assert.equal(list[0].id, id);

    const deployed = await fetch(`${base}/api/builds/${id}/deployed`, {method: 'POST',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({deviceId: 'ATECH-AABBCCDDEEFF', result: 'verified'})});
    assert.equal(deployed.status, 200);
    const after = await (await fetch(`${base}/api/builds/${id}`)).json();
    assert.equal(after.deployments[0].result, 'verified');
  } finally {
    server.close();
  }
});

test('firmware download is refused before the job is ready and for unknown jobs', async () => {
  const {server, base} = await boot();
  try {
    assert.equal((await fetch(`${base}/api/builds/nope/firmware.bin`)).status, 404);
    const bad = await fetch(`${base}/api/builds`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({demo: 9, prompt: 'x'})});
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /demo/);
  } finally {
    server.close();
  }
});

test('the events endpoint streams job updates and ends with done', async () => {
  const {server, base} = await boot();
  try {
    const created = await fetch(`${base}/api/builds`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({demo: 2, prompt: 'Blink'})});
    const {id} = await created.json();
    const response = await fetch(`${base}/api/builds/${id}/events`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: done')) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.match(text, /event: job\ndata: \{"id":"/);
    assert.match(text, /"state":"ready"/);
    assert.match(text, /event: done/);
  } finally {
    server.close();
  }
});

test('static dashboards are served and traversal is refused', async () => {
  const {server, base} = await boot();
  try {
    const page = await fetch(`${base}/demo1/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Atech Device Console/);
    assert.equal((await fetch(`${base}/demo1/../../builder/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/demo1/%2e%2e/%2e%2e/builder/package.json`)).status, 404);
    const root = await fetch(`${base}/`, {redirect: 'manual'});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/demo1/');
  } finally {
    server.close();
  }
});

test('API responses never contain the configured key, even when a provider error echoes it', async () => {
  const secret = 'unit-test-secret-value-5678';
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = secret;
  const config = tempConfig();
  const jobs = new JobStore({config, provider: {name: 'fake', model: 'm', async generate() { throw new Error(`401 invalid key ${secret}`); }},
                             deps: {readApiHeader: () => '//'}});
  const server = createServer({config, jobs, installer: {manifest: () => ({builds: []}), partFile: () => null,
                               ensureBaseBuild: async () => { throw new Error(`pio failed with ${secret}`); }}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const leak = new RegExp(secret);
    assert.doesNotMatch(await (await fetch(`${base}/api/health`)).text(), leak);
    const created = await fetch(`${base}/api/builds`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({demo: 1, prompt: 'Blink'})});
    const {id} = await created.json();
    const job = await waitForState(base, id, ['ready', 'failed']);
    assert.equal(job.state, 'failed');
    assert.equal(job.error, '401 invalid key [redacted]');
    assert.doesNotMatch(await (await fetch(`${base}/api/builds/${id}`)).text(), leak);
    assert.doesNotMatch(await (await fetch(`${base}/api/builds`)).text(), leak);
    assert.doesNotMatch(await (await fetch(`${base}/api/builds/${id}/events`)).text(), leak);
    const installer = await fetch(`${base}/api/installer/1/build`, {method: 'POST'});
    assert.equal(installer.status, 202);
    assert.doesNotMatch(await installer.text(), leak);
    await new Promise(resolve => setTimeout(resolve, 20));
    const status = await (await fetch(`${base}/api/installer/1/status`)).json();
    assert.equal(status.building, false);
    assert.equal(status.error, 'pio failed with [redacted]');
  } finally {
    server.close();
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('builds are scoped to the dashboard user that created them', async () => {
  const key = 'scoped-key-123';
  const config = tempConfig({dashboardKey: key});
  const workspace = fakeWorkspace([]);
  const jobs = new JobStore({config, provider: fakeProvider([{name: 'Blink', summary: 'Blinks', code: GOOD_CODE}]),
                             deps: {prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace, readApiHeader: () => '// header'}});
  // A build from before ownership existed: no ownerId in its record.
  const legacyDir = path.join(jobs.jobsDir, 'abcdef012345');
  fs.mkdirSync(legacyDir, {recursive: true});
  fs.writeFileSync(path.join(legacyDir, 'meta.json'), JSON.stringify({id: 'abcdef012345', demo: 1, prompt: 'old', state: 'failed', error: 'old', buildId: '01234567',
                                                                       createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deployments: [], usage: []}));
  jobs.loadExisting();
  const server = createServer({config, jobs, installer: {manifest: () => ({builds: []}), partFile: () => null, ensureBaseBuild: async () => ({dir: '/nowhere'})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user, p, init = {}) => fetch(base + p, {...init, headers: {'content-type': 'application/json', 'x-atech-key': key, ...(user ? {'x-atech-user': user} : {}), ...(init.headers || {})}});
  try {
    const created = await as('alice', '/api/builds', {method: 'POST', body: JSON.stringify({demo: 1, prompt: 'Blink'})});
    assert.equal(created.status, 202);
    const {id} = await created.json();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !['ready', 'failed'].includes((await (await as('alice', `/api/builds/${id}`)).json()).state)) await new Promise(r => setTimeout(r, 20));
    assert.equal((await (await as('alice', `/api/builds/${id}`)).json()).state, 'ready');

    for (const [method, p] of [['GET', `/api/builds/${id}`], ['GET', `/api/builds/${id}/firmware.bin`], ['GET', `/api/builds/${id}/events`],
                               ['POST', `/api/builds/${id}/deployed`], ['POST', `/api/builds/${id}/deploy`]]) {
      const response = await as('bob', p, {method, body: method === 'POST' ? JSON.stringify({deviceId: 'ATECH-000000000001', result: 'x'}) : undefined});
      assert.equal(response.status, 403, `${method} ${p} as bob`);
      assert.match((await response.json()).error, /another dashboard user/);
    }
    const bobList = await (await as('bob', '/api/builds?demo=1')).json();
    assert.deepEqual(bobList.map(j => j.id), ['abcdef012345'], 'bob sees only the legacy build');
    const aliceList = await (await as('alice', '/api/builds?demo=1')).json();
    assert.deepEqual(aliceList.map(j => j.id).sort(), [id, 'abcdef012345'].sort(), 'alice sees hers and the legacy build');
    const localList = await (await as(null, '/api/builds?demo=1')).json();
    assert.deepEqual(localList.map(j => j.id), ['abcdef012345'], 'a key holder without a user header is the local principal');
    assert.equal((await as('bob', '/api/builds/abcdef012345')).status, 200, 'legacy builds stay reachable');
    assert.equal((await as('alice', `/api/builds/${id}/firmware.bin`)).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('POST /api/builds/stock queues the stock app for the caller', async () => {
  const {server, base} = await boot();
  try {
    const created = await fetch(`${base}/api/builds/stock`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({demo: 1})});
    assert.equal(created.status, 202);
    const {id, buildId} = await created.json();
    assert.match(buildId, /^[0-9a-f]{8}$/);
    const job = await waitForState(base, id, ['ready', 'failed']);
    assert.equal(job.state, 'ready', job.error);
    assert.equal(job.static, 'stock');
    assert.equal(job.appName, 'green default');
    const bad = await fetch(`${base}/api/builds/stock`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({demo: 7})});
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('the base image builds in the background: POST starts it, GET status follows it', async () => {
  const config = tempConfig();
  const jobs = new JobStore({config, provider: fakeProvider([]), deps: {readApiHeader: () => '//'}});
  let finish;
  let starts = 0;
  const installer = {manifest: () => ({builds: []}), partFile: () => null,
                     ensureBaseBuild: () => { starts += 1; return new Promise(resolve => { finish = resolve; }); }};
  const server = createServer({config, jobs, installer});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await (await fetch(`${base}/api/installer/1/status`)).json();
    assert.equal(before.ready, false);
    assert.equal(before.building, false);
    assert.equal(before.error, null);
    const started = await fetch(`${base}/api/installer/1/build`, {method: 'POST'});
    assert.equal(started.status, 202, 'the request returns before the compile finishes');
    const body = await started.json();
    assert.equal(body.ok, true);
    assert.equal(body.building, true);
    const again = await (await fetch(`${base}/api/installer/1/build`, {method: 'POST'})).json();
    assert.equal(again.building, true);
    assert.equal(starts, 1, 'a build already running is joined, not duplicated');
    const during = await (await fetch(`${base}/api/installer/1/status`)).json();
    assert.equal(during.building, true);
    assert.ok(during.startedAt);
    finish({built: true});
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = await (await fetch(`${base}/api/installer/1/status`)).json();
    assert.equal(after.building, false);
    assert.equal(after.built, true);
    assert.equal(after.error, null);
    assert.equal((await fetch(`${base}/api/installer/9/build`, {method: 'POST'})).status, 404, 'unknown demos are refused');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('package route serves a signed package to the owner and refuses others', async () => {
  const {createSigner, parsePackage} = require('../lib/signing');
  const {DeviceRegistry} = require('../lib/devices');
  const {CloudDeviceService} = require('../lib/cloud-devices');
  const {DeploymentStore} = require('../lib/lan-ota');
  const {CloudDeploymentStore} = require('../lib/cloud-ota');
  const {sha256Hex} = require('../lib/lan-auth');
  const {loadConfig} = require('../lib/config');
  const key = 'package-key-123';
  const config = {...tempConfig({dashboardKey: key}), cloud: {...loadConfig({}).cloud}};
  const signer = createSigner({file: config.signingKeyFile});
  const workspace = fakeWorkspace([]);
  const jobs = new JobStore({config, provider: fakeProvider([{name: 'Blink', summary: 'Blinks', code: GOOD_CODE}]),
                             deps: {prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace, readApiHeader: () => '//'}});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const cloud = new CloudDeviceService({config, devices});
  const server = createServer({config, jobs, devices, deployments: new DeploymentStore({config, jobs, devices}), cloud,
                               cloudDeployments: new CloudDeploymentStore({config, jobs, devices, cloud}), signer,
                               installer: {manifest: () => ({builds: []}), partFile: () => null, ensureBaseBuild: async () => ({dir: '/nowhere'})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user, p, init = {}) => fetch(base + p, {...init, headers: {'x-atech-key': key, 'x-atech-user': user, 'content-type': 'application/json', ...(init.headers || {})}});
  const BOARD = 'ATECH-A1B2C3D4E5F6';
  try {
    const health = await (await as('alice', '/api/health')).json();
    assert.deepEqual(health.signing, {keyId: signer.keyId(), publicKey: signer.publicKeyHex()});
    const {id} = await (await as('alice', '/api/builds', {method: 'POST', body: JSON.stringify({demo: 1, prompt: 'Blink'})})).json();
    let ready = await (await as('alice', `/api/builds/${id}`)).json();
    for (let i = 0; i < 200 && !['ready', 'failed'].includes(ready.state); i++) { await new Promise(r => setTimeout(r, 20)); ready = await (await as('alice', `/api/builds/${id}`)).json(); }
    assert.equal(ready.state, 'ready');
    await cloud.claim({id: BOARD, token: 'fixture-ota-token-0123456789', name: 'Desk', ownerId: 'alice'});

    const response = await as('alice', `/api/builds/${id}/package?deviceId=${BOARD}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="atech-demo1-${ready.buildId}.atech"`);
    const {header, image} = parsePackage(Buffer.from(await response.arrayBuffer()));
    assert.equal(header.v, 1);
    assert.equal(header.build, ready.buildId);
    assert.equal(header.demo, 1);
    assert.equal(header.target, BOARD);
    assert.equal(header.ver, ready.appVersion);
    assert.equal(header.version, ready.appVersion);
    assert.equal(header.downgrade, false);
    assert.equal(header.size, ready.firmware.size);
    assert.equal(header.sha256, sha256Hex(image));
    assert.equal(header.sha256, ready.firmware.sha256);
    assert.equal(header.kid, signer.keyId());
    assert.equal(header.pub, signer.publicKeyHex());
    assert.equal(header.app, 'Blink');
    assert.ok(Date.parse(header.created) > 0);
    assert.equal(signer.verify({build: header.build, demo: header.demo, size: header.size, sha256: header.sha256, version: header.version, downgrade: header.downgrade, target: header.target}, header.sig), true);

    const downgrade = parsePackage(Buffer.from(await (await as('alice', `/api/builds/${id}/package?deviceId=${BOARD}&downgrade=1`)).arrayBuffer()));
    assert.equal(downgrade.header.downgrade, true);
    assert.equal(signer.verify({...downgrade.header, downgrade: true}, downgrade.header.sig), true);
    assert.equal(signer.verify({...downgrade.header, downgrade: false}, downgrade.header.sig), false, 'the flag is inside the signature');

    const unbound = parsePackage(Buffer.from(await (await as('alice', `/api/builds/${id}/package`)).arrayBuffer()));
    assert.equal(unbound.header.target, '', 'no device selected: the package is good for any board of the demo');

    assert.equal((await as('bob', `/api/builds/${id}/package?deviceId=${BOARD}`)).status, 403, 'another user\'s build');
    assert.equal((await as('alice', `/api/builds/${id}/package?deviceId=not-a-board`)).status, 400);
    assert.equal((await as('alice', '/api/builds/nope/package')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('local-credentials gives the owner the hotspot password and the authorization code, nobody else', async () => {
  const {DeviceRegistry} = require('../lib/devices');
  const {CloudDeviceService} = require('../lib/cloud-devices');
  const {DeploymentStore} = require('../lib/lan-ota');
  const {CloudDeploymentStore} = require('../lib/cloud-ota');
  const {proofHex} = require('../lib/cloud-auth');
  const {loadConfig} = require('../lib/config');
  const key = 'creds-key-123';
  const config = {...tempConfig({dashboardKey: key}), cloud: {...loadConfig({}).cloud}};
  const jobs = new JobStore({config, provider: fakeProvider([]), deps: {readApiHeader: () => '//'}});
  const devices = new DeviceRegistry({config, deps: {discover: async () => [], resolveHost: async () => null}});
  const cloud = new CloudDeviceService({config, devices});
  const server = createServer({config, jobs, devices, deployments: new DeploymentStore({config, jobs, devices}), cloud,
                               cloudDeployments: new CloudDeploymentStore({config, jobs, devices, cloud}),
                               installer: {manifest: () => ({builds: []}), partFile: () => null, ensureBaseBuild: async () => ({dir: '/nowhere'})}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user, p) => fetch(base + p, {headers: {'x-atech-key': key, 'x-atech-user': user}});
  const BOARD = 'ATECH-A1B2C3D4E5F6';
  const SECRET = 'fixture-ota-token-0123456789';
  try {
    assert.equal((await as('alice', `/api/devices/${BOARD}/local-credentials`)).status, 404, 'unknown board');
    await cloud.claim({id: BOARD, token: SECRET, name: 'Desk', ownerId: 'alice'});
    const before = await as('alice', `/api/devices/${BOARD}/local-credentials`);
    assert.equal(before.status, 409, 'the board has not reported its hotspot yet');
    const {nonce} = cloud.challenge({id: BOARD, ip: 'x'});
    await cloud.login({id: BOARD, nonce, proof: proofHex(SECRET, {deviceId: BOARD, nonce}), ip: 'x',
                       info: {demo: '1', build: 'stock', ap_ssid: 'ATECH-D4E5F6', ap_pass: 'hotspot-secret-123'}});
    const ok = await as('alice', `/api/devices/${BOARD}/local-credentials`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {ssid: 'ATECH-D4E5F6', pass: 'hotspot-secret-123', token: SECRET, hostname: 'atech-d4e5f6'});
    assert.equal((await as('bob', `/api/devices/${BOARD}/local-credentials`)).status, 403);
    assert.equal((await fetch(`${base}/api/devices/${BOARD}/local-credentials`)).status, 401, 'the dashboard key is required');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
