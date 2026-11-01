import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEnv, hostedConfigSource, assembleDist} from '../build.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOOD_ENV = {ATECH_BACKEND_URL: 'https://api.example.com', ATECH_BUILDER_KEY: 'kEy-SeCrEt-123',
                  ATECH_DASHBOARD_USER: 'atech', ANTHROPIC_API_KEY: 'sk-ant-secret'};

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'atech-vercel-dist-')); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function walk(dir, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel)); else out.push(rel);
  }
  return out;
}

test('validateEnv names every missing variable', () => {
  const problems = validateEnv({});
  for (const name of ['ATECH_BACKEND_URL', 'ATECH_BUILDER_KEY', 'ATECH_DASHBOARD_USER']) {
    assert.ok(problems.some(p => p.includes(name)), `${name} must be reported: ${problems.join(' | ')}`);
  }
  assert.equal(problems.length, 3);
  assert.ok(!problems.some(p => p.includes('ATECH_DASHBOARD_PASSWORD')), 'the dashboard has no password');
  assert.deepEqual(validateEnv(GOOD_ENV), []);
});

test('validateEnv accepts only an https origin without a path for the backend URL', () => {
  for (const bad of ['http://api.example.com', 'https://api.example.com/', 'https://api.example.com/api', 'api.example.com', 'https://', 'https://api.example.com?x=1']) {
    assert.equal(validateEnv({...GOOD_ENV, ATECH_BACKEND_URL: bad}).length, 1, bad);
  }
  for (const good of ['https://api.example.com', 'https://api.example.com:8443', 'https://atech-api.example.co.uk']) {
    assert.deepEqual(validateEnv({...GOOD_ENV, ATECH_BACKEND_URL: good}), [], good);
  }
});

test('hostedConfigSource sets poll transport, hosted mode and a same-origin API base', () => {
  const source = hostedConfigSource();
  assert.match(source, /window\.ATECH_CONFIG = \{"apiBase":"","transport":"poll","hosted":true,"pollMs":3000\};/);
});

test('assembleDist copies both dashboards and the shared modules without tests or dotfiles, and writes the hosted config', async () => {
  const outDir = await tempDir();
  const {files} = await assembleDist({rootDir, outDir, env: GOOD_ENV});
  for (const file of ['demo1/index.html', 'demo1/install.html', 'demo1/app.js', 'demo1/protocol.js', 'demo1/styles.css',
                      'demo2/index.html', 'demo2/install.html', 'demo2/app.js', 'demo2/bleota-client.js',
                      'shared/atech-builder.js', 'shared/atech-identity.js', 'shared/builder.css', 'shared/atech-config.js']) {
    assert.ok(await exists(path.join(outDir, file)), `${file} must be in the output`);
    assert.ok(files.includes(file), `${file} must be reported`);
  }
  const all = await walk(outDir);
  assert.deepEqual(all.filter(f => f.endsWith('.test.js') || path.basename(f).startsWith('.') || f.includes('node_modules')), []);
  const config = await fs.readFile(path.join(outDir, 'shared/atech-config.js'), 'utf8');
  assert.match(config, /"transport":"poll"/);
  assert.match(config, /"hosted":true/);
  assert.match(config, /"pollMs":3000/);
  assert.doesNotMatch(config, /transport: 'auto'/, 'the local default must be replaced');
});

test('assembleDist leaves no configured secret value in the output', async () => {
  const outDir = await tempDir();
  await assembleDist({rootDir, outDir, env: GOOD_ENV});
  for (const file of await walk(outDir)) {
    const text = await fs.readFile(path.join(outDir, file), 'utf8');
    assert.ok(!text.includes('kEy-SeCrEt-123') && !text.includes('sk-ant-secret'), `${file} leaks a secret`);
  }
});

test('assembleDist fails when the environment is incomplete unless allowMissingEnv is set', async () => {
  await assert.rejects(assembleDist({rootDir, outDir: await tempDir(), env: {}}), /ATECH_BACKEND_URL/);
  const {files} = await assembleDist({rootDir, outDir: await tempDir(), env: {}, allowMissingEnv: true});
  assert.ok(files.length > 10);
});

test('assembleDist refuses an output that contains a secret value', async () => {
  // A "secret" that happens to appear in a copied file must be caught by the output scan.
  await assert.rejects(assembleDist({rootDir, outDir: await tempDir(), env: {...GOOD_ENV, ANTHROPIC_API_KEY: 'prefers-reduced-motion'}}),
                       /Secret value found in build output/);
});

test('assembleDist starts from an empty output directory', async () => {
  const outDir = await tempDir();
  await fs.mkdir(path.join(outDir, 'stale'), {recursive: true});
  await fs.writeFile(path.join(outDir, 'stale', 'old.txt'), 'old');
  await assembleDist({rootDir, outDir, env: GOOD_ENV});
  assert.equal(await exists(path.join(outDir, 'stale')), false);
});
