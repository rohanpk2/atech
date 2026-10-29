import test from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.js';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const request = (headers = {}, path = '/demo1/') => new Request(`https://atech.example.vercel.app${path}`, {headers});

function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('without configured credentials every path answers 503 and names the variables', async () => {
  const response = await withEnv({ATECH_DASHBOARD_USER: undefined, ATECH_DASHBOARD_PASSWORD: undefined}, () => middleware(request()));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /ATECH_DASHBOARD_USER/);
  assert.match(text, /ATECH_DASHBOARD_PASSWORD/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a request without credentials gets a 401 Basic challenge, including API paths', async () => {
  for (const path of ['/demo1/', '/api/health', '/shared/atech-builder.js']) {
    const response = await withEnv({ATECH_DASHBOARD_USER: 'atech', ATECH_DASHBOARD_PASSWORD: 's3cret'}, () => middleware(request({}, path)));
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="Atech dashboard", charset="UTF-8"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('wrong credentials are denied', async () => {
  const response = await withEnv({ATECH_DASHBOARD_USER: 'atech', ATECH_DASHBOARD_PASSWORD: 's3cret'},
    () => middleware(request({authorization: `Basic ${b64('atech:nope')}`})));
  assert.equal(response.status, 401);
});

test('right credentials continue to the site (next())', async () => {
  const response = await withEnv({ATECH_DASHBOARD_USER: 'atech', ATECH_DASHBOARD_PASSWORD: 's3cret'},
    () => middleware(request({authorization: `Basic ${b64('atech:s3cret')}`})));
  assert.equal(response.headers.get('x-middleware-next'), '1');
});
