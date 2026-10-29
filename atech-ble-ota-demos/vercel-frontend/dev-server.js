#!/usr/bin/env node
// Local emulation of what Vercel does with this project, for testing the hosted dashboards
// without deploying: Basic sign-in on every path, static files from dist/, the redirects from
// vercel.json, and /api/* proxied to a backend with the server-side key replacing any value the
// browser sent and the sign-in header removed. It is not Vercel; it mirrors vercel.json and middleware.js closely
// enough to exercise the dashboards, the auth and the proxying end to end.
//
//   PORT=3100 ATECH_BACKEND_URL=http://127.0.0.1:5173 ATECH_BUILDER_KEY=devkey \
//   ATECH_DASHBOARD_USER=atech ATECH_DASHBOARD_PASSWORD=... node dev-server.js
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {pipeline} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {authorize} from './lib/basic-auth.js';
import {assembleDist} from './build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REALM = 'Basic realm="Atech dashboard", charset="UTF-8"';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

// Resolve a URL path inside root, refusing anything that escapes it (same rule as builder/server.js).
function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

function serveStatic(res, root, urlPath) {
  let file = safeJoin(root, urlPath);
  if (!file) { sendJson(res, 404, {error: 'Not found'}); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { sendJson(res, 404, {error: 'Not found'}); return; }
  res.writeHead(200, {'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache'});
  fs.createReadStream(file).pipe(res);
}

export function createDevServer({distDir, backendUrl, builderKey = null, user = null, password = null, log = () => {}}) {
  const upstream = new URL(backendUrl);
  const client = upstream.protocol === 'https:' ? https : http;
  const signIn = Boolean(user && password);

  function proxy(req, res, url) {
    const headers = {...req.headers};
    delete headers.host;
    delete headers.authorization;                           // the sign-in stays between browser and proxy
    if (builderKey) headers['x-atech-key'] = builderKey;   // `set` semantics, like the Vercel transform
    const request = client.request({
      method: req.method, headers, hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
    }, response => {
      // The browser may have moved on (a reload during a slow device refresh): discard the answer
      // instead of piping into a closed response, which would throw and take the server down.
      if (res.destroyed || res.writableEnded) { response.resume(); return; }
      res.writeHead(response.statusCode, response.headers);
      pipeline(response, res, () => {});
    });
    request.on('error', error => {
      if (res.destroyed) return;
      log(`proxy error for ${req.method} ${url.pathname}: ${error.message}`);
      if (!res.headersSent) sendJson(res, 502, {error: `Backend unreachable: ${error.message}`}); else res.end();
    });
    res.on('close', () => { if (!res.writableEnded) request.destroy(); });   // client gone: stop the upstream call
    pipeline(req, request, () => {});
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (signIn && authorize(req.headers.authorization, {user, password}).status !== 'ok') {
      res.writeHead(401, {'www-authenticate': REALM, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end('Sign in to use the Atech dashboard.');
      return;
    }
    const {pathname} = url;
    if (pathname === '/') { res.writeHead(307, {location: '/demo1/'}); res.end(); return; }
    if (/^\/(demo1|demo2)$/.test(pathname)) { res.writeHead(308, {location: `${pathname}/`}); res.end(); return; }
    if (pathname.startsWith('/api/')) { proxy(req, res, url); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 404, {error: 'Not found'}); return; }
    serveStatic(res, distDir, pathname);
  });
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  const backendUrl = process.env.ATECH_BACKEND_URL || 'http://127.0.0.1:5173';
  const distDir = path.join(here, 'dist');
  const {files} = await assembleDist({rootDir: path.resolve(here, '..'), outDir: distDir, env: process.env, allowMissingEnv: true});
  const user = process.env.ATECH_DASHBOARD_USER || null;
  const password = process.env.ATECH_DASHBOARD_PASSWORD || null;
  const builderKey = process.env.ATECH_BUILDER_KEY || null;
  const server = createDevServer({distDir, backendUrl, builderKey, user, password, log: line => console.log(`  ${line}`)});
  server.listen(port, '127.0.0.1', () => {
    console.log('Atech hosted-dashboard emulation (not Vercel)');
    console.log(`  dist:     ${files.length} files in ${distDir} (hosted config: polling, no local backend copy)`);
    console.log(`  backend:  ${backendUrl}${builderKey ? ' with x-atech-key injected' : ' (no ATECH_BUILDER_KEY: client headers pass through)'}`);
    console.log(`  Demo 1:   http://127.0.0.1:${port}/demo1/`);
    console.log(`  Demo 2:   http://127.0.0.1:${port}/demo2/`);
    if (user && password) console.log(`  sign-in:  user ${user}`);
    else console.log('  WARNING: no ATECH_DASHBOARD_USER/ATECH_DASHBOARD_PASSWORD, so no sign-in. Vercel would answer 503 for everything.');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`dev-server failed: ${error.message}`); process.exit(1); });
}
