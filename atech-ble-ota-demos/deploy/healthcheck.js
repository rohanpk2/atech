#!/usr/bin/env node
'use strict';

// Docker HEALTHCHECK for the Atech builder container. The backend requires its dashboard key on
// every /api/* request when it listens on a non-loopback address (as it does inside the
// container), so the probe presents the key from ATECH_BUILDER_KEY or from the key file the
// entrypoint persists under the builds volume. Exit 0 when /api/health answers {ok:true}.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const KEY_FILE = 'dashboard.key';

function readKey({env = process.env, buildsDir = env.ATECH_BUILDS_DIR || '/data/builds'} = {}) {
  if (env.ATECH_BUILDER_KEY) return env.ATECH_BUILDER_KEY;
  try { return fs.readFileSync(path.join(buildsDir, KEY_FILE), 'utf8').trim() || null; }
  catch { return null; }
}

function check({host = '127.0.0.1', port = 5173, key = null, timeoutMs = 5000} = {}) {
  return new Promise(resolve => {
    const headers = key ? {'x-atech-key': key} : {};
    const req = http.get({host, port, path: '/api/health', headers, timeout: timeoutMs}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(false); return; }
        try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const port = Number(process.env.ATECH_BUILDER_PORT) || 5173;
  const ok = await check({port, key: readKey()});
  if (!ok) console.error(`healthcheck: GET http://127.0.0.1:${port}/api/health did not answer ok`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {check, readKey, KEY_FILE};
