'use strict';

// Loads each dashboard into jsdom with its real scripts, stubs the backend
// and Web Bluetooth surface, and checks the page boots without exceptions
// and that the builder card wires up. This stands in for a browser smoke
// test when no Chrome session is available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const {loadConfig} = require('../lib/config');

const config = loadConfig({});
const openWindows = [];
test.after(() => { for (const w of openWindows) { try { w.close(); } catch (_) { /* ignore */ } } });

function fakeFetch(routes) {
  return async (url) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '');
    const route = routes[key] || routes[key.split('?')[0]];
    if (!route) return {ok: false, status: 404, json: async () => ({error: 'not found'})};
    return {ok: true, status: 200, json: async () => route, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map()};
  };
}

async function bootDashboard(demo, {bluetooth = true} = {}) {
  const webDir = config.demos[demo].webDir;
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message || String(error)));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM(html, {url: 'http://localhost:5173/demo' + demo + '/', runScripts: 'outside-only', virtualConsole});
  const {window} = dom;
  openWindows.push(window);
  window.fetch = fakeFetch({
    '/api/health': {ok: true, provider: 'fake', model: 'fake-model'},
  });
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  if (bluetooth) {
    Object.defineProperty(window.navigator, 'bluetooth', {
      value: {requestDevice: async () => { throw new Error('no device in tests'); }}, configurable: true,
    });
  }
  try { Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true}); } catch (_) { /* jsdom already true */ }
  assert.equal(window.isSecureContext, true, 'test needs a secure context like http://localhost');
  window.EventSource = undefined;
  window.addEventListener('error', event => errors.push(event.message));
  const scripts = [...dom.window.document.querySelectorAll('script[src]')].map(node => node.getAttribute('src'));
  for (const src of scripts) {
    const file = src.startsWith('/shared/')
      ? path.join(config.webSharedDir, src.slice('/shared/'.length).split('?')[0])
      : path.join(webDir, src.split('?')[0]);
    window.eval(fs.readFileSync(file, 'utf8'));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  return {window, errors, scripts};
}

for (const demo of [1, 2]) {
  test(`Demo ${demo} dashboard boots in a DOM without errors and mounts the builder`, async () => {
    const {window, errors, scripts} = await bootDashboard(demo);
    const doc = window.document;
    assert.deepEqual(errors, [], `script errors: ${errors.join(' | ')}`);
    assert.ok(scripts.length >= 4, 'dashboard loads identity, protocol/client, app and builder scripts');
    assert.ok(window.AtechIdentity && window.AtechBuilder, 'shared modules attach to window');
    assert.ok(window[`AtechDemo${demo}Transport`], 'transport is exposed for the builder');
    assert.match(doc.getElementById('aiBackend').textContent, /Backend online: fake/);
    assert.equal(doc.getElementById('aiBuild').disabled, false, 'build button enables once the backend answers');
    assert.equal(doc.getElementById('aiDeploy').disabled, true, 'deploy stays disabled without a build');
    assert.equal(doc.getElementById('aiExamples').children.length, window.AtechBuilder.EXAMPLES.length);
    assert.match(doc.getElementById('aiTarget').textContent, /No board selected yet/);
    assert.equal(doc.getElementById('aiBrowserNote').hidden, true);
    assert.equal(doc.getElementById('devFind').disabled, false, 'Wi-Fi discovery is offered');
    assert.ok(doc.getElementById('log').children.length >= 1, 'activity log receives the ready line');
    assert.equal(doc.getElementById('connect').disabled, false);
  });

  test(`Demo ${demo} dashboard without Web Bluetooth (Safari) still offers Wi-Fi and explains the hotspot fallback`, async () => {
    const {window, errors} = await bootDashboard(demo, {bluetooth: false});
    const doc = window.document;
    assert.deepEqual(errors, []);
    assert.equal(doc.body.dataset.deployMethod, 'hotspot', 'no board reachable yet: hotspot instructions are shown');
    assert.equal(doc.getElementById('aiBrowserNote').hidden, false);
    assert.match(doc.getElementById('aiBrowserNote').textContent, /pairing and upload are manual/);
    assert.match(doc.getElementById('aiBrowserNote').textContent, /Wi-Fi deployment works in Safari and Chrome/);
    assert.equal(doc.getElementById('connect').disabled, true);
    assert.match(doc.getElementById('methodBleNote').textContent, /No Web Bluetooth/);
    assert.equal(doc.getElementById('devFind').disabled, false);
  });
}

test('the builder card renders a ready job and refuses to deploy a mismatched demo', async () => {
  const {window} = await bootDashboard(1);
  const doc = window.document;
  const job = {id: 'abc', demo: 2, state: 'ready', stage: 'Ready to deploy', attempt: 1, maxRepairs: 3, buildId: 'deadbeef',
               appName: 'Blink', appVersion: 3, summary: 'Blinks', code: 'void appLoop() {}', diagnostics: [], violations: [],
               firmware: {size: 1000, crc32: '00000000'}, model: 'fake'};
  window.fetch = fakeFetch({'/api/health': {ok: true, provider: 'fake', model: 'm'}, '/api/builds/abc': job,
                            '/api/builds': {id: 'abc', buildId: 'deadbeef', appVersion: 3}});
  doc.getElementById('aiPrompt').value = 'Blink';
  doc.getElementById('aiBuild').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(doc.getElementById('aiBadge').textContent, 'Validated');
  assert.equal(doc.getElementById('aiCode').textContent, 'void appLoop() {}');
  assert.equal(doc.getElementById('aiDownload').hidden, false);
  assert.match(doc.getElementById('aiDownload').getAttribute('href'), /\/api\/builds\/abc\/firmware\.bin/);
  assert.equal(doc.getElementById('aiDeploy').disabled, false, 'with no board reachable the button downloads for the hotspot');
  assert.match(doc.getElementById('aiDeploy').textContent, /Download firmware for the hotspot portal/);
  // A Demo 1 board connected over Bluetooth cannot receive a Demo 2 build.
  const transport = window.AtechDemo1Transport;
  transport.isConnected = () => true;
  transport.identity = () => ({id: 'ATECH-A1B2C3D4E5F6', suffix: 'D4E5F6', demo: 1, build: 'stock', app: 'x', ver: 1, slotSize: 6291456,
                               pending: false, canRollback: false, safe: false, paired: true, appState: 'running', loops: 1, up: 1});
  window.AtechBuilder; doc.getElementById('aiPrompt').dispatchEvent(new window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 10));
  doc.getElementById('methodBle').click();
  assert.equal(doc.getElementById('aiDeploy').disabled, true, 'demo mismatch blocks the deploy');
  assert.match(doc.getElementById('aiDeploy').title, /for Demo 2/);
});
