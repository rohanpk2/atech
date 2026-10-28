#!/usr/bin/env node
'use strict';

// Atech AI firmware builder backend. Serves both dashboards, the shared
// browser modules and the JSON API. Dependency-free (node:http).
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {loadConfig, loadDotEnv} = require('./lib/config');
const gpio = require('./lib/gpio-policy');
const {JobStore} = require('./lib/jobs');
const {DeviceRegistry} = require('./lib/devices');
const {DeploymentStore} = require('./lib/lan-ota');
const {createFakeDevice} = require('./lib/fake-device');
const installerModule = require('./lib/installer');
const {selectProvider} = require('./lib/generate');
const {runPio} = require('./lib/pio');
const {redactSecrets} = require('./lib/redact');

const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.bin': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Request body must be JSON')); }
    });
    req.on('error', reject);
  });
}

// Resolve a URL path inside a root directory, refusing anything that escapes it.
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
  res.writeHead(200, {'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                      'cache-control': 'no-cache'});
  fs.createReadStream(file).pipe(res);
}

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

// Dashboard key check: header, query (EventSource cannot set headers) or the
// cookie the dashboard sets from a ?key= link. Only enforced when configured.
function keyPresented(req, url, key) {
  if (!key) return true;
  const header = req.headers['x-atech-key'];
  const query = url.searchParams.get('key');
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('atech_key='));
  const cookieValue = cookie ? decodeURIComponent(cookie.slice('atech_key='.length)) : null;
  const expected = Buffer.from(key);
  for (const candidate of [header, query, cookieValue]) {
    if (typeof candidate !== 'string') continue;
    const buf = Buffer.from(candidate);
    if (buf.length === expected.length && crypto.timingSafeEqual(buf, expected)) return true;
  }
  return false;
}

function createServer({config, jobs, devices = null, deployments = null, installer = installerModule, pioVersion = null, simulated = []}) {
  const handlers = [];
  const route = (method, pattern, handler) => handlers.push({method, pattern, handler});
  devices = devices || new DeviceRegistry({config});
  deployments = deployments || new DeploymentStore({config, jobs, devices});
  let lastRefreshAt = 0;
  let refreshPromise = null;

  route('GET', /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, {
      ok: true, provider: jobs.provider?.name || null, model: jobs.provider?.model || null,
      pio: pioVersion, host: config.host, port: config.port, lanUrls: lanUrls(config.port),
      demos: Object.values(config.demos).map(d => ({demo: d.demo, name: d.name, path: `/${d.key.split('-')[0]}/`})),
      maxRepairs: config.maxRepairs,
      lan: {chunkBytes: deployments.chunkBytes, devicePort: config.lanPort, simulated: simulated.map(s => ({id: s.state.id, demo: s.state.demo}))},
      keyRequired: Boolean(config.dashboardKey),
    });
  });

  // ---- devices: discovery, pairing, status, control ----
  route('GET', /^\/api\/devices$/, async (req, res, [], url) => {
    if (url.searchParams.get('refresh') === '1') {
      // Probe each registered board at most every few seconds; coalesce concurrent requests.
      if (!refreshPromise && Date.now() - lastRefreshAt > 4000) {
        refreshPromise = devices.refresh().catch(() => {}).finally(() => { refreshPromise = null; lastRefreshAt = Date.now(); });
      }
      if (refreshPromise) await refreshPromise;
    }
    sendJson(res, 200, {devices: devices.list(), refreshedAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null});
  });

  route('POST', /^\/api\/devices\/discover$/, async (req, res) => {
    try { sendJson(res, 200, {found: await devices.discover({timeoutMs: 1800})}); }
    catch (error) { sendJson(res, 500, {error: redactSecrets(error.message)}); }
  });

  route('POST', /^\/api\/devices\/pair$/, async (req, res) => {
    const body = await readJson(req);
    try {
      const device = await devices.pair({host: String(body.host || '').trim(), port: Number(body.port) || config.lanPort,
                                         token: body.token, name: body.name});
      sendJson(res, 200, {device});
    } catch (error) { sendJson(res, 400, {error: redactSecrets(error.message)}); }
  });

  route('POST', /^\/api\/devices\/(ATECH-[0-9A-F]{12})\/probe$/, async (req, res, [id]) => {
    const body = await readJson(req);
    const record = devices.get(id);
    const host = String(body.host || (record && record.host) || '').trim();
    const port = Number(body.port) || (record && record.port) || config.lanPort;
    if (!host) { sendJson(res, 400, {error: 'No address known for this device; enter its IP address'}); return; }
    try {
      const identity = await devices.probe({host, port, id});
      if (identity.id !== id) { sendJson(res, 409, {error: `${host}:${port} is ${identity.id}, not ${id}`}); return; }
      sendJson(res, 200, {device: devices.describe(id) || {id, host, port, identity, paired: false}});
    } catch (error) { sendJson(res, 502, {error: redactSecrets(error.message), device: devices.describe(id)}); }
  });

  route('DELETE', /^\/api\/devices\/(ATECH-[0-9A-F]{12})$/, async (req, res, [id]) => {
    sendJson(res, devices.remove(id) ? 200 : 404, {ok: true});
  });

  route('POST', /^\/api\/devices\/(ATECH-[0-9A-F]{12})\/control$/, async (req, res, [id]) => {
    const body = await readJson(req);
    try { sendJson(res, 200, await devices.control(id, String(body.op || '').toLowerCase())); }
    catch (error) { sendJson(res, 400, {error: redactSecrets(error.message)}); }
  });

  // ---- deployments over the LAN ----
  route('POST', /^\/api\/builds\/([0-9a-f]+)\/deploy$/, async (req, res, [id]) => {
    const body = await readJson(req);
    let deployment;
    try { deployment = deployments.create({jobId: id, deviceId: String(body.deviceId || '').trim()}); }
    catch (error) { sendJson(res, 400, {error: redactSecrets(error.message)}); return; }
    deployments.run(deployment.id).catch(() => {});
    sendJson(res, 202, {id: deployment.id, deployment});
  });

  route('GET', /^\/api\/deployments$/, async (req, res) => { sendJson(res, 200, deployments.list()); });

  route('GET', /^\/api\/deployments\/([0-9a-f]+)$/, async (req, res, [id]) => {
    const deployment = deployments.get(id);
    if (!deployment) { sendJson(res, 404, {error: 'Unknown deployment'}); return; }
    sendJson(res, 200, deployment);
  });

  route('POST', /^\/api\/deployments\/([0-9a-f]+)\/abort$/, async (req, res, [id]) => {
    const deployment = deployments.abort(id);
    if (!deployment) { sendJson(res, 404, {error: 'Unknown deployment'}); return; }
    sendJson(res, 200, deployment);
  });

  route('GET', /^\/api\/deployments\/([0-9a-f]+)\/events$/, async (req, res, [id]) => {
    const deployment = deployments.get(id);
    if (!deployment) { sendJson(res, 404, {error: 'Unknown deployment'}); return; }
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const finished = state => ['verified', 'failed', 'aborted'].includes(state);
    const finish = snapshot => { send('done', {state: snapshot.state}); res.end(); };
    send('deployment', deployment);
    if (finished(deployment.state)) { finish(deployment); return; }
    const unsubscribe = deployments.subscribe(id, snapshot => {
      send('deployment', snapshot);
      if (finished(snapshot.state)) { unsubscribe(); finish(snapshot); }
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  });

  route('GET', /^\/api\/demos\/(\d)$/, async (req, res, [demo]) => {
    const entry = config.demos[Number(demo)];
    if (!entry) { sendJson(res, 404, {error: 'Unknown demo'}); return; }
    sendJson(res, 200, {
      demo: entry.demo, name: entry.name, blePrefix: entry.blePrefix, ssidPrefix: entry.ssidPrefix,
      otaProtocol: entry.otaProtocol, imageIdentity: entry.imageIdentity, board: config.board,
      slotSize: config.slotSize, sizeMargin: config.sizeMargin,
      allowedPins: gpio.ALLOWED_PINS, reservedPins: gpio.RESERVED,
    });
  });

  route('GET', /^\/api\/builds$/, async (req, res, [], url) => {
    sendJson(res, 200, jobs.list(url.searchParams.get('demo')));
  });

  route('POST', /^\/api\/builds$/, async (req, res) => {
    const body = await readJson(req);
    let job;
    try { job = jobs.create({demo: body.demo, prompt: body.prompt, deviceId: body.deviceId}); }
    catch (error) { sendJson(res, 400, {error: error.message}); return; }
    jobs.run(job.id).catch(() => {});
    sendJson(res, 202, {id: job.id, buildId: job.buildId, appVersion: job.appVersion});
  });

  route('GET', /^\/api\/builds\/([0-9a-f]+)$/, async (req, res, [id]) => {
    const job = jobs.get(id);
    if (!job) { sendJson(res, 404, {error: 'Unknown job'}); return; }
    sendJson(res, 200, job);
  });

  route('GET', /^\/api\/builds\/([0-9a-f]+)\/events$/, async (req, res, [id]) => {
    const job = jobs.get(id);
    if (!job) { sendJson(res, 404, {error: 'Unknown job'}); return; }
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const finish = snapshot => { send('done', {state: snapshot.state}); res.end(); };
    send('job', job);
    if (['ready', 'failed'].includes(job.state)) { finish(job); return; }
    const unsubscribe = jobs.subscribe(id, snapshot => {
      send('job', snapshot);
      if (['ready', 'failed'].includes(snapshot.state)) { unsubscribe(); finish(snapshot); }
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
  });

  route('GET', /^\/api\/builds\/([0-9a-f]+)\/firmware\.bin$/, async (req, res, [id]) => {
    const job = jobs.get(id);
    if (!job) { sendJson(res, 404, {error: 'Unknown job'}); return; }
    const file = jobs.firmwarePath(id);
    if (!file || !fs.existsSync(file)) { sendJson(res, 409, {error: `Job is ${job.state}, firmware is not available`}); return; }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="atech-demo${job.demo}-${job.buildId}.bin"`,
      'x-atech-build-id': job.buildId, 'x-atech-crc32': job.firmware?.crc32 || '',
    });
    fs.createReadStream(file).pipe(res);
  });

  route('POST', /^\/api\/builds\/([0-9a-f]+)\/deployed$/, async (req, res, [id]) => {
    const body = await readJson(req);
    const job = jobs.recordDeployment(id, {deviceId: body.deviceId || '', result: body.result || 'unknown',
                                           detail: body.detail || '', transport: body.transport || ''});
    if (!job) { sendJson(res, 404, {error: 'Unknown job'}); return; }
    sendJson(res, 200, {ok: true, deployments: job.deployments});
  });

  route('GET', /^\/api\/installer\/(\d)\/manifest\.json$/, async (req, res, [demo]) => {
    if (!config.demos[Number(demo)]) { sendJson(res, 404, {error: 'Unknown demo'}); return; }
    sendJson(res, 200, installer.manifest(Number(demo), {config}));
  });

  route('GET', /^\/api\/installer\/(\d)\/parts\/([A-Za-z0-9_.-]+)$/, async (req, res, [demo, name]) => {
    const file = installer.partFile(Number(demo), name, {config});
    if (!file || !fs.existsSync(file)) {
      sendJson(res, 404, {error: `Part ${name} is not available; build the base image first (POST /api/installer/${demo}/build)`});
      return;
    }
    res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size,
                        'cache-control': 'no-store'});
    fs.createReadStream(file).pipe(res);
  });

  route('GET', /^\/api\/installer\/(\d)\/status$/, async (req, res, [demo]) => {
    const number = Number(demo);
    if (!config.demos[number]) { sendJson(res, 404, {error: 'Unknown demo'}); return; }
    const parts = installerModule.PART_ORDER.map(name => {
      const file = installer.partFile(number, name, {config});
      return {name, available: Boolean(file && fs.existsSync(file))};
    });
    sendJson(res, 200, {demo: number, ready: parts.every(p => p.available), parts,
                        stale: installer.baseBuildIsStale ? installer.baseBuildIsStale(number, {config}) : null});
  });

  route('POST', /^\/api\/installer\/(\d)\/build$/, async (req, res, [demo]) => {
    try {
      const result = await installer.ensureBaseBuild(Number(demo), {config});
      sendJson(res, 200, {ok: true, built: result.built});
    } catch (error) {
      sendJson(res, 500, {error: redactSecrets(error.message)});
    }
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/') && !keyPresented(req, url, config.dashboardKey)) {
        sendJson(res, 401, {error: 'This builder requires its dashboard key. Open the link printed by the backend (it carries ?key=).', keyRequired: true});
        return;
      }
      for (const {method, pattern, handler} of handlers) {
        const match = pathname.match(pattern);
        if (match && req.method === method) { await handler(req, res, match.slice(1), url); return; }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 404, {error: 'Not found'}); return; }
      if (pathname === '/') { res.writeHead(302, {location: '/demo1/'}); res.end(); return; }
      if (pathname === '/demo1' || pathname === '/demo2') { res.writeHead(302, {location: `${pathname}/`}); res.end(); return; }
      if (pathname.startsWith('/demo1/')) { serveStatic(res, config.demos[1].webDir, pathname.slice('/demo1/'.length)); return; }
      if (pathname.startsWith('/demo2/')) { serveStatic(res, config.demos[2].webDir, pathname.slice('/demo2/'.length)); return; }
      if (pathname.startsWith('/shared/')) { serveStatic(res, config.webSharedDir, pathname.slice('/shared/'.length)); return; }
      sendJson(res, 404, {error: 'Not found'});
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.message?.includes('body') ? 400 : 500, {error: redactSecrets(error.message)});
      else res.end();
    }
  });
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const hostIndex = args.indexOf('--host');
  const portIndex = args.indexOf('--port');
  loadDotEnv(); // builder/.env, if present; shell variables take precedence
  const config = loadConfig(process.env);
  if (hostIndex >= 0) config.host = args[hostIndex + 1];
  if (portIndex >= 0) config.port = Number(args[portIndex + 1]);

  const provider = await selectProvider(config);
  const jobs = new JobStore({config, provider});
  let pioVersion = null;
  try { pioVersion = (await runPio(['--version'], {timeoutMs: 60000, pioBin: config.pio})).log.trim(); }
  catch (error) { console.warn(`PlatformIO not found at ${config.pio}: ${error.message}`); }

  const loopback = config.host === '127.0.0.1' || config.host === 'localhost' || config.host === '::1';
  if (!loopback && !config.dashboardKey) config.dashboardKey = crypto.randomBytes(12).toString('base64url');
  const devices = new DeviceRegistry({config});
  const deployments = new DeploymentStore({config, jobs, devices});
  const simulated = await startSimulatedDevices(config, devices);
  const server = createServer({config, jobs, devices, deployments, pioVersion, simulated});
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} on ${config.host} is already in use (an old "python3 -m http.server ${config.port}" ` +
                    'from the previous README instructions is the usual cause). Stop it or pass --port <other>.');
      process.exit(1);
    }
    throw error;
  });
  // A wildcard listener left by another process (for example python's http.server on *:PORT) would
  // still capture http://localhost requests over IPv6 even though our IPv4 bind succeeded.
  const probe = require('node:net').createServer();
  probe.once('error', () => console.warn(
    `Warning: another process already listens on port ${config.port} over IPv6. Browsers that resolve ` +
    `localhost to ::1 will reach that process instead; open http://127.0.0.1:${config.port}/ or stop it.`));
  probe.once('listening', () => probe.close());
  probe.listen(config.port, '::1');
  server.listen(config.port, config.host, () => {
    console.log(`Atech AI firmware builder`);
    console.log(`  provider: ${provider.name} (${provider.model})`);
    console.log(`  pio:      ${pioVersion || 'not found'}`);
    console.log(`  builds:   ${config.buildsDir}`);
    const suffix = config.dashboardKey ? `?key=${config.dashboardKey}` : '';
    console.log(`  Demo 1:   http://localhost:${config.port}/demo1/${suffix}`);
    console.log(`  Demo 2:   http://localhost:${config.port}/demo2/${suffix}`);
    console.log(`  devices:  ${devices.list().length} paired (${devices.file})`);
    for (const sim of simulated) {
      console.log(`  SIMULATED board ${sim.state.id} (Demo ${sim.state.demo}) at http://127.0.0.1:${sim.port}/api/identity; no hardware involved`);
    }
    if (!loopback) {
      for (const url of lanUrls(config.port)) console.log(`  LAN:      ${url}/demo1/${suffix}  (Safari on iPhone/iPad: open this link; Wi-Fi deploy needs no Bluetooth)`);
      console.log('  The dashboard key above is required for every API call on this non-loopback listener.');
    } else {
      console.log('  Pass --host 0.0.0.0 to open the dashboard to phones on the same Wi-Fi (a dashboard key is then generated).');
    }
  });
}

// Simulated boards for hardware-free demos and browser testing. They run the
// same protocol as the firmware but prove nothing about real ESP32 speed.
async function startSimulatedDevices(config, devices) {
  const spec = String(config.simulatedDevices || '').trim().toLowerCase();
  if (!spec || spec === '0' || spec === 'false') return [];
  const demos = spec === 'all' || spec === 'true' ? [1, 2] : spec.split(',').map(Number).filter(n => n === 1 || n === 2);
  const started = [];
  for (const demo of demos.length ? demos : [1]) {
    const id = `ATECH-51D0000000E${demo}`;
    const secret = `simulated-board-${demo}-authorization-code`;
    const device = createFakeDevice({id, demo, build: 'stock', secret, host: '127.0.0.1', port: 0, rebootMs: 1500,
                                     log: text => console.log(`  [simulated ${id}] ${text}`)});
    const {host, port} = await device.start();
    devices.upsert({id, suffix: id.slice(-6), demo, name: `Simulated Demo ${demo} board`, host, port, hostname: `atech-${id.slice(-6).toLowerCase()}`,
                    firmware: device.state.fw, build: 'stock', secret, simulated: true, pairedAt: new Date().toISOString()});
    started.push(device);
  }
  return started;
}

if (require.main === module) {
  main().catch(error => { console.error(redactSecrets(error.message)); process.exit(1); });
}

module.exports = {createServer, safeJoin, keyPresented, startSimulatedDevices};
