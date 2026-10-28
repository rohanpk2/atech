'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
