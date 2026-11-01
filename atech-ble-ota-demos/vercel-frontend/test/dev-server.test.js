import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleDist} from '../build.js';
import {createDevServer} from '../dev-server.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const seen = [];
let backend; let dev; let base;

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

test.before(async () => {
  backend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({method: req.method, url: req.url, headers: req.headers, body});
      if (req.url === '/api/slow') { setTimeout(() => { res.writeHead(200, {'content-type': 'application/json'}); res.end('{"slow":true}'); }, 400); return; }
      if (req.url.startsWith('/api/health')) { res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify({ok: true, key: req.headers['x-atech-key'] || null})); return; }
      if (req.url === '/api/builds' && req.method === 'POST') { res.writeHead(202, {'content-type': 'application/json'}); res.end(JSON.stringify({id: 'job1', echoed: JSON.parse(body)})); return; }
      if (req.url === '/api/builds/job1/firmware.bin') {
        res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': 1000, 'content-disposition': 'attachment; filename="atech-demo1-deadbeef.bin"', 'x-atech-build-id': 'deadbeef'});
        res.end(Buffer.alloc(1000, 0xE9)); return;
      }
      res.writeHead(404, {'content-type': 'application/json'}); res.end('{"error":"nope"}');
    });
  });
  const backendPort = await listen(backend);
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atech-vercel-dev-'));
  await assembleDist({rootDir, outDir: distDir, env: {}, allowMissingEnv: true});
  dev = createDevServer({distDir, backendUrl: `http://127.0.0.1:${backendPort}`, builderKey: 'srv-key'});
  base = `http://127.0.0.1:${await listen(dev)}`;
});
test.after(() => { dev?.close(); backend?.close(); });

test('pages are served with no sign-in', async () => {
  const ok = await fetch(`${base}/demo1/`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('www-authenticate'), null);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  assert.match(await ok.text(), /Atech Device Console/);
});

test('static files and the hosted config are served with the right types', async () => {
  const css = await fetch(`${base}/shared/builder.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const config = await fetch(`${base}/shared/atech-config.js`);
  assert.match(await config.text(), /"hosted":true/);
  const demo2 = await fetch(`${base}/demo2/install.html`);
  assert.equal(demo2.status, 200);
});

test('trailing slash and root redirects match vercel.json', async () => {
  const noSlash = await fetch(`${base}/demo1`, {redirect: 'manual'});
  assert.equal(noSlash.status, 308);
  assert.equal(noSlash.headers.get('location'), '/demo1/');
  const root = await fetch(`${base}/`, {redirect: 'manual'});
  assert.equal(root.status, 307);
  assert.equal(root.headers.get('location'), '/demo1/');
});

test('/api requests are proxied with the server-side key replacing any client value, query string intact', async () => {
  const response = await fetch(`${base}/api/health?x=1`, {headers: {authorization: 'Basic dXNlcjpwYXNz', 'x-atech-key': 'client-key'}});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.key, 'srv-key');
  const hit = seen.find(r => r.url === '/api/health?x=1');
  assert.ok(hit, 'the backend saw the path and query');
  assert.equal(hit.headers['x-atech-key'], 'srv-key');
  assert.equal(response.headers.get('cache-control'), 'no-store', 'upstream headers pass through');
  assert.equal(hit.headers.authorization, undefined, 'a browser Authorization header is not forwarded to the backend');
});

test('POST bodies and statuses pass through', async () => {
  const response = await fetch(`${base}/api/builds`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({demo: 1, prompt: 'Blink'})});
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {id: 'job1', echoed: {demo: 1, prompt: 'Blink'}});
});

test('binary downloads stream through unchanged', async () => {
  const response = await fetch(`${base}/api/builds/job1/firmware.bin`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="atech-demo1-deadbeef.bin"');
  assert.equal(response.headers.get('x-atech-build-id'), 'deadbeef');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 1000);
  assert.ok(bytes.every(b => b === 0xE9));
});

test('a client that gives up on a slow backend call does not take the server down', async () => {
  const controller = new AbortController();
  const aborted = fetch(`${base}/api/slow`, {signal: controller.signal}).catch(error => error.name);
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  assert.equal(await aborted, 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 600));   // the upstream answer arrives after the client left
  const alive = await fetch(`${base}/api/health?after=abort`);
  assert.equal(alive.status, 200);
  const slow = await fetch(`${base}/api/slow`);
  assert.deepEqual(await slow.json(), {slow: true});
});

test('path traversal is refused', async () => {
  const encoded = await fetch(`${base}/demo1/%2e%2e/%2e%2e/package.json`);
  assert.equal(encoded.status, 404);
  const raw = await new Promise(resolve => {
    const req = http.request(`${base}/../package.json`, {path: '/../package.json'}, res => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(raw, 404);
});
