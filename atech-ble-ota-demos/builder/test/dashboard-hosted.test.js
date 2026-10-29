'use strict';

// The hosted (Vercel) configuration of both dashboards in jsdom: the shared module reads
// window.ATECH_CONFIG, follows builds by polling only (no EventSource), keeps the download
// link same-origin, hides LAN discovery, and says plainly that cloud Wi-Fi deployment is not
// available yet while still offering Bluetooth when a board is connected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });
const BOARD = 'ATECH-A1B2C3D4E5F6';
const HOSTED = {apiBase: '', transport: 'poll', hosted: true, pollMs: 30};

function identity(overrides = {}) {
  return {id: BOARD, suffix: 'D4E5F6', demo: 1, fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1,
          slotSize: 6291456, pending: false, canRollback: false, safe: false, appState: 'running', loops: 10, up: 5000, otaOwner: '',
          target: '', paired: true, wifi: null, ...overrides};
}

function job(state, overrides = {}) {
  return {id: 'job1', demo: 1, state, stage: state, attempt: 1, maxRepairs: 3, buildId: 'deadbeef', appName: 'Blink',
          appVersion: 3, summary: 'Blinks', code: 'void appLoop() {}', diagnostics: [], violations: [], deviceId: '',
          firmware: state === 'ready' ? {size: 1000, crc32: '00000000', sha256: 'x'} : null, model: 'fake', error: null, ...overrides};
}

// A route whose answers are consumed in order; the last one repeats.
function sequence(answers) {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    calls.push({url: key, method: (init.method || 'GET').toUpperCase(), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null});
    const route = typeof routes[key] === 'function' ? routes[key](init) : routes[key];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'}), clone() { return this; }};
    const status = route.status || 200;
    return {ok: status < 400, status, json: async () => route.body ?? route, arrayBuffer: async () => new ArrayBuffer(1000),
            headers: new Map(), clone() { return this; }};
  };
}

async function bootDashboard(demo, {bluetooth = true, routes = {}, connected = false, calls = [], atechConfig = HOSTED, storedKey = null} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  const dom = new JSDOM(html, {url: `https://atech.example.vercel.app/demo${demo}/`, runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'anthropic', model: 'm'}, '/api/devices': {devices: []}, ...routes}, calls);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  if (bluetooth) {
    Object.defineProperty(window.navigator, 'bluetooth', {value: {requestDevice: async () => { throw new Error('no device'); }}, configurable: true});
  }
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* already true */ }
  window.EventSource = function EventSource() { throw new Error('EventSource must not be used in poll mode'); };
  window.addEventListener('error', event => errors.push(event.message));
  if (storedKey) window.localStorage.setItem('atechBuilderKey', storedKey);
  const scripts = [...dom.window.document.querySelectorAll('script[src]')].map(node => node.getAttribute('src'));
  assert.ok(scripts.some(src => src.startsWith('/shared/atech-config.js')), 'the page must load /shared/atech-config.js');
  for (const src of scripts) {
    const file = src.startsWith('/shared/') ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0]) : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
    if (src.startsWith('/shared/atech-config.js')) window.ATECH_CONFIG = atechConfig;   // what the Vercel build writes
  }
  if (connected) {
    const transport = window[`AtechDemo${demo}Transport`];
    transport.isConnected = () => true;
    transport.identity = () => identity({demo});
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  return {window, errors, calls, doc: window.document};
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('hosted dashboard polls a build to ready without EventSource and offers a same-origin download', async () => {
  const calls = [];
  const {doc, errors} = await bootDashboard(1, {calls, routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': sequence([job('generating'), job('compiling'), job('ready')]),
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(400);
  assert.deepEqual(errors, [], errors.join(' | '));
  assert.equal(doc.getElementById('aiBadge').textContent, 'Validated');
  assert.equal(doc.getElementById('aiCode').textContent, 'void appLoop() {}');
  const download = doc.getElementById('aiDownload');
  assert.equal(download.hidden, false);
  assert.ok(download.getAttribute('href').endsWith('/api/builds/job1/firmware.bin'), download.getAttribute('href'));
  assert.ok(calls.filter(c => c.url === '/api/builds/job1').length >= 3, 'the job was polled');
});

for (const demo of [1, 2]) {
  test(`Demo ${demo} hosted dashboard hides Find devices and explains that cloud Wi-Fi deployment is not available`, async () => {
    const {doc, errors} = await bootDashboard(demo);
    assert.deepEqual(errors, [], errors.join(' | '));
    assert.equal(doc.getElementById('devFind').hidden, true);
    assert.match(doc.getElementById('methodWifiNote').textContent, /hosted dashboard yet/);
    assert.match(doc.getElementById('devStatus').textContent, /not available yet/);
    assert.equal(doc.body.dataset.deployMethod, 'hotspot');
    assert.equal(doc.getElementById('aiBuild').disabled, false, 'generation does not need a board or Bluetooth');
  });
}

test('hosted dashboard still offers Bluetooth when a board is connected', async () => {
  const {doc} = await bootDashboard(1, {connected: true});
  assert.equal(doc.body.dataset.deployMethod, 'ble');
  assert.equal(doc.getElementById('devFind').hidden, true);
});

test('a failed build ends polling with the Failed badge and its error', async () => {
  const calls = [];
  const {doc} = await bootDashboard(1, {calls, routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': sequence([job('generating'), job('failed', {error: 'boom'})]),
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(200);
  assert.equal(doc.getElementById('aiBadge').textContent, 'Failed');
  assert.match(doc.getElementById('aiStatus').textContent, /boom/);
  const polls = calls.filter(c => c.url === '/api/builds/job1').length;
  await wait(150);
  assert.equal(calls.filter(c => c.url === '/api/builds/job1').length, polls, 'polling stops once the job is final');
});

test('one failed poll does not stop polling', async () => {
  const {doc} = await bootDashboard(1, {routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': sequence([job('generating'), {status: 500, body: {error: 'hiccup'}}, job('ready')]),
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(400);
  assert.equal(doc.getElementById('aiBadge').textContent, 'Validated');
});

test('hosted copy on a refused key names the Vercel variable', async () => {
  const {doc} = await bootDashboard(1, {routes: {'/api/health': {status: 401, body: {error: 'key', keyRequired: true}}}});
  assert.match(doc.getElementById('aiBackend').textContent, /ATECH_BUILDER_KEY on Vercel/);
  assert.match(doc.getElementById('keyBanner').textContent, /must match the backend's key/);
  assert.equal(doc.getElementById('keyBanner').hidden, false);
});

test('hosted dashboard ignores a key left in the browser and never sends one', async () => {
  const calls = [];
  const {doc} = await bootDashboard(1, {calls, storedKey: 'old-key', routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': job('ready'),
  }});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(100);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every(c => !('x-atech-key' in c.headers)), 'no request carries a browser-held key');
  assert.doesNotMatch(doc.getElementById('aiDownload').getAttribute('href'), /key=/);
});

test('local default config keeps the current behaviour: EventSource is used when available', async () => {
  const calls = [];
  const {window, doc} = await bootDashboard(1, {calls, atechConfig: {apiBase: '', transport: 'auto', hosted: false, pollMs: 2000}, routes: {
    '/api/builds': {status: 202, body: {id: 'job1', buildId: 'deadbeef', appVersion: 3}},
    '/api/builds/job1': job('generating'),
  }});
  let opened = null;
  window.EventSource = function EventSource(url) { opened = url; this.addEventListener = () => {}; this.close = () => {}; };
  assert.equal(doc.getElementById('devFind').hidden, false);
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await wait(60);
  assert.equal(opened, '/api/builds/job1/events');
});
