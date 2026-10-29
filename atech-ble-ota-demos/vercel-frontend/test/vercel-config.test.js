import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json');
const text = fs.readFileSync(file, 'utf8');
const config = JSON.parse(text);

test('build settings: Other preset, npm run build, dist output', () => {
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'dist');
});

test('trailingSlash is not used: it would 308 every extension-less /api path before the proxy route runs', () => {
  assert.equal(config.trailingSlash, undefined);
  assert.equal(config.cleanUrls, undefined);
});

test('explicit redirects: root to Demo 1, and /demo1 and /demo2 to their slashed form so relative assets resolve', () => {
  assert.ok(config.redirects.some(r => r.source === '/' && r.destination === '/demo1/' && r.permanent === false));
  for (const demo of ['demo1', 'demo2']) {
    assert.ok(config.redirects.some(r => r.source === `/${demo}` && r.destination === `/${demo}/` && r.permanent === true), demo);
  }
});

test('exactly one route proxies /api to the backend from an environment variable and injects the key', () => {
  const apiRoutes = config.routes.filter(r => /api/.test(r.src));
  assert.equal(apiRoutes.length, 1);
  const [route] = apiRoutes;
  assert.equal(route.src, '^/api/(.*)$');
  assert.equal(route.dest, '${ATECH_BACKEND_URL}/api/$1');
  assert.deepEqual(route.env, ['ATECH_BACKEND_URL']);
  assert.deepEqual(route.transforms, [
    {type: 'request.headers', op: 'set', target: {key: 'x-atech-key'}, args: '$ATECH_BUILDER_KEY', env: ['ATECH_BUILDER_KEY']},
    {type: 'request.headers', op: 'delete', target: {key: 'authorization'}},
  ], 'the backend key is set server-side and the sign-in credentials never reach the backend');
});

test('no backend host or secret is hardcoded', () => {
  const urls = [...text.matchAll(/https?:\/\/[^"\s]+/g)].map(m => m[0]);
  assert.deepEqual(urls, ['https://openapi.vercel.sh/vercel.json']);
  assert.doesNotMatch(text, /x-atech-key"\s*\}\s*,\s*"args":\s*"[^$]/, 'the key must come from $ATECH_BUILDER_KEY');
});
