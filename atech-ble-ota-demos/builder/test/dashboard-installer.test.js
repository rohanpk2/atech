'use strict';

// The USB installer page (install.html of both demos) in jsdom: when the base image parts are
// missing or stale it starts the base build on the backend by itself and polls until the parts
// are ready, in the hosted configuration as well as locally. No step asks for an operator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const HOSTED = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30};
const LOCAL = {apiBase: '', transport: 'auto', hosted: false, pollMs: 30};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function status(demo, overrides = {}) {
  const parts = ['bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin'].map(name => ({name, available: true}));
  return {demo, ready: true, parts, stale: false, building: false, startedAt: null, finishedAt: null, built: null, error: null, ...overrides};
}

function sequence(answers) {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

function fakeFetch(routes, calls) {
  return async (url, init = {}) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push({url: key, method: (init.method || 'GET').toUpperCase()});
    const route = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'})};
    if (route.throws) throw new Error(route.throws);
    const code = route.status || 200;
    return {ok: code < 400, status: code, json: async () => route.body ?? route};
  };
}

async function bootInstaller(demo, {routes = {}, atechConfig = HOSTED, calls = []} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'install.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `https://atech.example.vercel.app/demo${demo}/install.html`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch(routes, calls);
  window.addEventListener('error', event => errors.push(event.message));
  const scripts = [...window.document.querySelectorAll('script')];
  for (const node of scripts) {
    const src = node.getAttribute('src');
    if (src && /^https?:/.test(src)) continue;                         // ESP Web Tools from the CDN
    if (src) {
      const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
      window.eval(fs.readFileSync(file, 'utf8'));
      if (src.startsWith('/shared/atech-config.js')) window.ATECH_CONFIG = atechConfig;
    } else {
      window.eval(node.textContent);
    }
  }
  await wait(20);
  return {doc: window.document, errors, calls};
}

for (const [label, atechConfig] of [['hosted', HOSTED], ['local', LOCAL]]) {
  test(`${label}: a missing base image is built by the page itself and followed to Ready`, async () => {
    const calls = [];
    const {doc, errors} = await bootInstaller(1, {atechConfig, calls, routes: {
      '/api/installer/1/status': sequence([status(1, {ready: false}), status(1, {ready: false, building: true, startedAt: 'now'}), status(1, {built: true})]),
      '/api/installer/1/build': {status: 202, body: {ok: true, building: true, startedAt: 'now', finishedAt: null, built: null, error: null}},
    }});
    assert.deepEqual(errors, [], errors.join(' | '));
    assert.equal(calls.filter(c => c.url === '/api/installer/1/build' && c.method === 'POST').length, 1, 'the page started the build');
    await wait(150);
    assert.equal(doc.getElementById('installerBadge').textContent, 'Ready');
    assert.match(doc.getElementById('installerStatus').textContent, /ready/i);
    assert.ok(calls.filter(c => c.url === '/api/installer/1/status').length >= 3, 'the status was polled while building');
    assert.doesNotMatch(doc.body.textContent, /operator/i, 'nobody is told to ask an operator');
    assert.equal(doc.getElementById('buildBase').hidden, true, 'nothing to build once the parts are ready');
  });
}

test('while the build runs the page says so and polls without starting a second build', async () => {
  const calls = [];
  const {doc} = await bootInstaller(2, {calls, routes: {
    '/api/installer/2/status': sequence([status(2, {ready: false, building: true, startedAt: 'now'}), status(2, {ready: false, building: true, startedAt: 'now'}), status(2, {built: true})]),
    '/api/installer/2/build': {status: 202, body: {ok: true, building: true}},
  }});
  assert.equal(doc.getElementById('installerBadge').textContent, 'Building');
  assert.match(doc.getElementById('installerStatus').textContent, /Demo 2 base image/);
  assert.equal(doc.getElementById('buildBase').disabled, true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'a running build is only watched');
  await wait(150);
  assert.equal(doc.getElementById('installerBadge').textContent, 'Ready');
});

test('a stale base image is rebuilt by the page itself', async () => {
  const calls = [];
  const {doc} = await bootInstaller(1, {calls, routes: {
    '/api/installer/1/status': sequence([status(1, {stale: true}), status(1, {stale: true, building: true}), status(1, {built: true})]),
    '/api/installer/1/build': {status: 202, body: {ok: true, building: true}},
  }});
  assert.equal(calls.filter(c => c.url === '/api/installer/1/build' && c.method === 'POST').length, 1);
  await wait(150);
  assert.equal(doc.getElementById('installerBadge').textContent, 'Ready');
});

test('a failed build shows the error and leaves the button for a retry', async () => {
  const calls = [];
  const {doc} = await bootInstaller(1, {calls, routes: {
    '/api/installer/1/status': sequence([status(1, {ready: false}), status(1, {ready: false, error: 'Base build for demo 1 failed (exit 1)'})]),
    '/api/installer/1/build': {status: 202, body: {ok: true, building: true}},
  }});
  await wait(150);
  assert.equal(doc.getElementById('installerBadge').textContent, 'Failed');
  assert.match(doc.getElementById('installerStatus').textContent, /exit 1/);
  assert.equal(doc.getElementById('buildBase').hidden, false);
  assert.equal(doc.getElementById('buildBase').disabled, false);
  const polls = calls.filter(c => c.url === '/api/installer/1/status').length;
  await wait(100);
  assert.equal(calls.filter(c => c.url === '/api/installer/1/status').length, polls, 'polling stops after a failure');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'a failed build is not retried without a click');
  doc.getElementById('buildBase').click();
  await wait(20);
  assert.equal(calls.filter(c => c.method === 'POST').length, 2, 'the button retries');
});

test('ready and current parts need no build and hide the button', async () => {
  const calls = [];
  const {doc} = await bootInstaller(1, {calls, routes: {'/api/installer/1/status': status(1)}});
  await wait(60);
  assert.equal(doc.getElementById('installerBadge').textContent, 'Ready');
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(doc.getElementById('buildBase').hidden, true);
});

test('an unreachable backend reads differently hosted and locally', async () => {
  const hosted = await bootInstaller(1, {routes: {'/api/installer/1/status': {throws: 'network'}}});
  assert.equal(hosted.doc.getElementById('installerBadge').textContent, 'Offline');
  assert.match(hosted.doc.getElementById('installerStatus').textContent, /build service/);
  const local = await bootInstaller(1, {atechConfig: LOCAL, routes: {'/api/installer/1/status': {throws: 'network'}}});
  assert.match(local.doc.getElementById('installerStatus').textContent, /npm start/);
});
