'use strict';
// Container health check: must pass the dashboard key, because the backend answers 401 on a keyed
// listener and a keyless probe would mark a healthy container unhealthy forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {check, readKey} = require('./healthcheck');

function stubBackend({key = 'k1', ok = true} = {}) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/health') { res.writeHead(404); res.end('{}'); return; }
    if (req.headers['x-atech-key'] !== key) { res.writeHead(401); res.end('{"error":"key"}'); return; }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok}));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port})));
}

test('check succeeds with the right key', async () => {
  const {server, port} = await stubBackend();
  try { assert.equal(await check({port, key: 'k1'}), true); }
  finally { server.close(); }
});

test('check fails with a wrong or missing key', async () => {
  const {server, port} = await stubBackend();
  try {
    assert.equal(await check({port, key: 'wrong'}), false);
    assert.equal(await check({port, key: null}), false);
  } finally { server.close(); }
});

test('check fails when the backend reports ok:false or is not listening', async () => {
  const {server, port} = await stubBackend({ok: false});
  try { assert.equal(await check({port, key: 'k1'}), false); }
  finally { server.close(); }
  const closed = await stubBackend();
  closed.server.close();
  await new Promise(resolve => closed.server.once('close', resolve));
  assert.equal(await check({port: closed.port, key: 'k1', timeoutMs: 500}), false);
});

test('readKey prefers the environment and falls back to <buildsDir>/dashboard.key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atech-health-'));
  assert.equal(readKey({env: {}, buildsDir: dir}), null);
  fs.writeFileSync(path.join(dir, 'dashboard.key'), 'from-file\n');
  assert.equal(readKey({env: {}, buildsDir: dir}), 'from-file');
  assert.equal(readKey({env: {ATECH_BUILDER_KEY: 'from-env'}, buildsDir: dir}), 'from-env');
  fs.rmSync(dir, {recursive: true, force: true});
});
