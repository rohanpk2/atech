'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JobStore} = require('../lib/jobs');
const {tempConfig, GOOD_CODE, BAD_PIN_CODE, fakeProvider, fakeWorkspace} = require('./helpers');

function makeStore({responses, compileResults = [], config = tempConfig()}) {
  const provider = fakeProvider(responses);
  const workspace = fakeWorkspace(compileResults);
  const store = new JobStore({config, provider, deps: {
    prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace,
    readApiHeader: () => '// header\n',
  }});
  return {store, provider, workspace, config};
}

const ok = (name = 'Blink') => ({name, summary: 'Blinks the LED', code: GOOD_CODE});

test('a clean generation becomes ready with firmware metadata and a monotonic version', async () => {
  const {store, provider, config} = makeStore({responses: [ok(), ok('Second')]});
  const job = store.create({demo: 1, prompt: 'Blink the LED', deviceId: 'ATECH-AABBCCDDEEFF'});
  assert.equal(job.state, 'queued');
  assert.match(job.buildId, /^[0-9a-f]{8}$/);
  const done = await store.run(job.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.attempt, 1);
  assert.equal(done.appName, 'Blink');
  assert.equal(done.appVersion, 3);
  assert.equal(done.code, GOOD_CODE);
  assert.ok(done.firmware.size > 0);
  assert.match(done.firmware.crc32, /^[0-9a-f]{8}$/);
  assert.ok(fs.existsSync(path.join(config.buildsDir, 'jobs', job.id, 'firmware.bin')));
  assert.ok(fs.existsSync(path.join(config.buildsDir, 'jobs', job.id, 'attempt-1', 'user_app.cpp')));
  assert.match(provider.calls[0].messages[0].content, /Blink the LED/);
  assert.match(provider.calls[0].messages[0].content, /ATECH-AABBCCDDEEFF/);
  assert.match(provider.calls[0].system, /appSetup/);
  const second = await store.run(store.create({demo: 1, prompt: 'Again'}).id);
  assert.equal(second.appVersion, 4);
});

test('a compile error triggers one repair round with the diagnostics', async () => {
  const {store, provider, workspace} = makeStore({responses: [ok(), ok()], compileResults: [{ok: false}, {ok: true}]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'ready');
  assert.equal(done.attempt, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(workspace.compiled.length, 2);
  const repair = provider.calls[1].messages;
  assert.equal(repair.length, 3);
  assert.match(repair[2].content, /'ledd' was not declared/);
});

test('a policy violation is repaired without compiling', async () => {
  const bad = {name: 'Bad', summary: 's', code: BAD_PIN_CODE};
  const {store, provider, workspace} = makeStore({responses: [bad, ok()]});
  const done = await store.run(store.create({demo: 2, prompt: 'Drive pin 45'}).id);
  assert.equal(done.state, 'ready');
  assert.equal(workspace.compiled.length, 1);
  assert.match(provider.calls[1].messages[2].content, /GPIO 45/);
  assert.equal(done.violations.length, 0);
});

test('the job fails after the configured number of repairs', async () => {
  const {store} = makeStore({responses: [ok(), ok(), ok(), ok()],
                             compileResults: [{ok: false}, {ok: false}, {ok: false}, {ok: false}]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'failed');
  assert.equal(done.attempt, 4);
  assert.match(done.error, /'ledd' was not declared/);
  assert.equal(done.diagnostics.length, 1);
});

test('an image without the build marker fails validation', async () => {
  const {store} = makeStore({responses: [ok()], compileResults: [{ok: true, withBuildMarker: false}]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /ATECH-BUILD/);
  assert.equal(done.firmware, null);
});

test('subscribers see every stage in order', async () => {
  const {store} = makeStore({responses: [ok()]});
  const job = store.create({demo: 1, prompt: 'Blink'});
  const states = [];
  const unsubscribe = store.subscribe(job.id, snapshot => states.push(snapshot.state));
  await store.run(job.id);
  unsubscribe();
  const unique = states.filter((state, i) => states[i - 1] !== state);
  assert.deepEqual(unique, ['generating', 'compiling', 'validating', 'ready']);
});

test('a provider failure marks the job failed with the message', async () => {
  const {store} = makeStore({responses: [new Error('Not logged in')]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /Not logged in/);
});

test('create validates its input', () => {
  const {store} = makeStore({responses: []});
  assert.throws(() => store.create({demo: 3, prompt: 'x'}), /demo/);
  assert.throws(() => store.create({demo: 1, prompt: '   '}), /prompt/);
  assert.throws(() => store.create({demo: 1, prompt: 'x'.repeat(5000)}), /prompt/);
});

test('jobs persist across store instances', async () => {
  const config = tempConfig();
  const first = makeStore({responses: [ok()], config});
  const job = await first.store.run(first.store.create({demo: 1, prompt: 'Persist me'}).id);
  const second = new JobStore({config, provider: fakeProvider([]), deps: {readApiHeader: () => ''}});
  const loaded = second.get(job.id);
  assert.equal(loaded.state, 'ready');
  assert.equal(loaded.prompt, 'Persist me');
  assert.equal(second.list(1)[0].id, job.id);
});

test('provider failures are stored as readable errors with secrets redacted', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'unit-test-secret-value-1234';
  try {
    const failing = {name: 'fake', model: 'm',
                     async generate() { throw new Error('rejected unit-test-secret-value-1234 and sk-ant-api03-ZZZZZZZZZZ'); }};
    const workspace = fakeWorkspace([]);
    const store = new JobStore({config: tempConfig(), provider: failing, deps: {
      prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace, readApiHeader: () => '//',
    }});
    const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error, 'rejected [redacted] and sk-ant-[redacted]');
    const meta = JSON.parse(fs.readFileSync(path.join(store.jobsDir, done.id, 'meta.json'), 'utf8'));
    assert.doesNotMatch(meta.error, /unit-test-secret|ZZZZ/);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('job lifecycle is reported through the log hook with the failure reason and no secrets', async () => {
  const lines = [];
  const config = tempConfig();
  const provider = fakeProvider([ok(), new Error('provider exploded with sk-ant-secret123456 in the message')]);
  const workspace = fakeWorkspace([]);
  const store = new JobStore({config, provider, log: line => lines.push(line), deps: {
    prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace, readApiHeader: () => '// header\n',
  }});
  const first = store.create({demo: 1, prompt: 'Blink the LED please'});
  await store.run(first.id);
  const second = store.create({demo: 2, prompt: 'Explode'});
  await store.run(second.id);
  assert.match(lines[0], new RegExp(`^job ${first.id} demo 1 queued: "Blink the LED please"`));
  assert.ok(lines.some(l => l.startsWith(`job ${first.id} demo 1 compiling`)), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith(`job ${first.id} demo 1 ready`) && /\d+ bytes/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith(`job ${second.id} demo 2 failed`) && l.includes('provider exploded')), lines.join('\n'));
  assert.ok(!lines.some(l => l.includes('sk-ant-secret123456')), 'secret shapes must be redacted');
  assert.ok(!lines.some(l => /logTail|Compiling user_app/.test(l)), 'log tail pushes are not lifecycle events');
});

test('the log hook defaults to silence so library users and tests stay quiet', async () => {
  const {store} = makeStore({responses: [ok()]});
  const job = store.create({demo: 1, prompt: 'Quiet'});
  assert.equal((await store.run(job.id)).state, 'ready');
});

test('an image without the cloud agent marker fails validation', async () => {
  const {store} = makeStore({responses: [ok()], compileResults: [{ok: true, withAgentMarker: false}]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /ATECH-CLOUD-AGENT/);
  assert.equal(done.firmware, null);
});

test('a stock-app job compiles the checked-in user_app.cpp without calling the model', async () => {
  const {store, provider, config} = makeStore({responses: []});
  const job = store.createStock({demo: 1, ownerId: 'alice'});
  assert.equal(job.static, 'stock');
  assert.equal(job.prompt, 'stock app');
  assert.equal(job.appName, 'green default');
  assert.equal(job.ownerId, 'alice');
  assert.match(job.summary, /quick green blink/);
  const stock = fs.readFileSync(path.join(config.demos[1].dir, 'src', 'app', 'user_app.cpp'), 'utf8');
  assert.equal(job.code, stock);
  const done = await store.run(job.id);
  assert.equal(done.state, 'ready', done.error);
  assert.equal(done.appName, 'green default');
  assert.equal(done.code, stock);
  assert.equal(provider.calls.length, 0, 'the model is never consulted for a stock job');
  assert.ok(fs.existsSync(path.join(config.buildsDir, 'jobs', job.id, 'firmware.bin')));
  assert.throws(() => store.createStock({demo: 9}), /demo/);
});

test('an image without the provisioning service marker fails validation', async () => {
  const {store} = makeStore({responses: [ok()], compileResults: [{ok: true, withProvMarker: false}]});
  const done = await store.run(store.create({demo: 1, prompt: 'Blink'}).id);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /ATECH-PROV/);
  assert.equal(done.firmware, null);
});
