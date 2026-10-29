#!/usr/bin/env node
'use strict';

// Warms the builder's PlatformIO state without the model. For each demo it prepares the AI
// workspace with the stock src/app/user_app.cpp, installs the workspace's packages and, unless
// --install-only, compiles it exactly as a job would, so the first real job reuses a full build
// cache. --base also rebuilds the USB installer images (pio run -e base) in the demo projects.
//
// Used at image build time (--install-only, no compile) and on the server as a hardware-free
// check that firmware compilation works: docker compose run --rm builder node deploy/warm-cache.js
const fs = require('node:fs');
const path = require('node:path');

const lib = name => require(path.join(__dirname, '..', 'builder', 'lib', name));
const {loadConfig} = lib('config');
const workspace = lib('workspace');
const installer = lib('installer');
const pio = lib('pio');
const {redactSecrets} = lib('redact');

const META = {buildId: 'warmcache', appName: 'warm cache', appVersion: 3, targetDeviceId: ''};

function parseArgs(argv) {
  const flags = {installOnly: false, base: false};
  for (const arg of argv) {
    if (arg === '--install-only') flags.installOnly = true;
    else if (arg === '--base') flags.base = true;
    else throw new Error(`Unknown option ${arg} (use --install-only and/or --base)`);
  }
  return flags;
}

async function warm({installOnly, base}, {config = loadConfig(process.env), deps = {}, log = console.log} = {}) {
  const {prepareWorkspace, compileWorkspace, ensureBaseBuild, runPio} = {
    prepareWorkspace: workspace.prepareWorkspace, compileWorkspace: workspace.compileWorkspace,
    ensureBaseBuild: installer.ensureBaseBuild, runPio: pio.runPio, ...deps,
  };
  const onLine = line => log(redactSecrets(line));
  let ok = true;
  for (const demo of [1, 2]) {
    const entry = config.demos[demo];
    const code = fs.readFileSync(path.join(entry.dir, 'src', 'app', 'user_app.cpp'), 'utf8');
    log(`== Demo ${demo}: preparing the AI workspace with the stock app`);
    const {dir} = await prepareWorkspace(demo, {code, meta: META}, {config});
    const installed = await runPio(['pkg', 'install', '-e', 'ai'], {cwd: dir, onLine, pioBin: config.pio, timeoutMs: 600000});
    if (installed.code !== 0) { log(`== Demo ${demo}: package install failed (exit ${installed.code})`); ok = false; continue; }
    if (!installOnly) {
      const compiled = await compileWorkspace(demo, dir, {config, onLine});
      if (!compiled.ok) {
        const errors = (compiled.diagnostics || []).filter(d => d.severity === 'error').map(d => d.message);
        log(`== Demo ${demo}: compile failed (exit ${compiled.code}${compiled.timedOut ? ', timed out' : ''}) ${errors.join('; ')}`);
        ok = false;
        continue;
      }
      log(`== Demo ${demo}: compiled ${compiled.firmwarePath}`);
    }
    if (base) {
      try {
        await ensureBaseBuild(demo, {config, force: true, onLine});
        log(`== Demo ${demo}: base image rebuilt in ${entry.dir}`);
      } catch (error) {
        log(`== Demo ${demo}: ${redactSecrets(error.message)}`);
        ok = false;
      }
    }
  }
  return ok;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const ok = await warm(flags);
  console.log(ok ? '== warm-cache: done' : '== warm-cache: FAILED');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main().catch(error => { console.error(redactSecrets(error.message)); process.exit(1); });

module.exports = {warm, parseArgs, META};
