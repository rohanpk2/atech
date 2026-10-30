'use strict';

// The device-facing HTTP API (/api/device/*). Boards authenticate with their
// own credentials, never with the dashboard key, and read key=value lines.
// Mounted by server.js and by the tests.
const {pipeline} = require('node:stream');
const {encodeKv, parseForm, CloudError} = require('./cloud-auth');
const {redactSecrets} = require('./redact');

const MAX_FORM_BYTES = 16 * 1024;

function sendKv(res, status, body) {
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(encodeKv(body));
}

function readForm(req, limit = MAX_FORM_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new CloudError(413, 'too_large', 'Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(parseForm(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || '?';
}

function createDeviceHandler({cloud, cloudDeployments, now = Date.now}) {
  return async function handleDeviceRequest(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/device/')) return false;
    try {
      const ip = clientIp(req);
      if (req.method === 'GET' && pathname === '/api/device/challenge') {
        const result = cloud.challenge({id: url.searchParams.get('id'), ip});
        sendKv(res, 200, {ok: 1, nonce: result.nonce, ttl: result.ttlMs, claimed: result.claimed, server_time: result.serverTime});
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/device/login') {
        const {id, nonce, proof, ...info} = await readForm(req);
        const result = await cloud.login({id, nonce, proof, info, ip});
        sendKv(res, 200, {ok: 1, session: result.session, expires: result.expiresAt, poll: result.pollMs, server_time: now()});
        return true;
      }
      const {deviceId} = cloud.authenticate(req.headers.authorization);
      if (req.method === 'POST' && pathname === '/api/device/poll') {
        const body = await readForm(req);
        cloud.touch(deviceId, body);
        const result = cloudDeployments.poll(deviceId, body);
        const job = result.job;
        sendKv(res, 200, {
          ok: 1, poll: result.pollMs, server_time: now(),
          job: job ? job.job : '', build: job ? job.build : '', size: job ? job.size : '', sha256: job ? job.sha256 : '', demo: job ? job.demo : '',
          app: job ? job.app : '', ver: job ? job.ver : '', url: job ? job.url : '', chunk: job ? job.chunk : '',
          ack: result.ack ? result.ack.jobId : '', action: result.ack ? result.ack.action : '',
        });
        return true;
      }
      const match = pathname.match(/^\/api\/device\/jobs\/([0-9a-f]+)\/(firmware|status)$/);
      if (match && match[2] === 'firmware' && req.method === 'GET') {
        let firmware;
        try {
          firmware = cloudDeployments.openFirmware(match[1], deviceId, {range: req.headers.range});
        } catch (error) {
          if (error.status === 416) {
            const d = cloudDeployments.get(match[1]);
            res.writeHead(416, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-range': `bytes */${d ? d.total : 0}`});
            res.end(encodeKv({ok: 0, code: error.code, error: error.message}));
            return true;
          }
          throw error;
        }
        cloud.seen(deviceId);
        const headers = {
          'content-type': 'application/octet-stream', 'content-length': firmware.end - firmware.start + 1, 'cache-control': 'no-store',
          'accept-ranges': 'bytes', 'x-atech-sha256': firmware.sha256, 'x-atech-build': firmware.buildId, 'x-atech-size': firmware.size,
        };
        if (firmware.status === 206) headers['content-range'] = `bytes ${firmware.start}-${firmware.end}/${firmware.size}`;
        res.writeHead(firmware.status, headers);
        // pipeline closes the file when the board drops the connection mid-chunk; pipe would not.
        pipeline(firmware.stream, res, () => { if (!firmware.stream.destroyed) firmware.stream.destroy(); });
        return true;
      }
      if (match && match[2] === 'status' && req.method === 'POST') {
        const body = await readForm(req);
        cloud.seen(deviceId);
        const snapshot = cloudDeployments.report(match[1], deviceId, body);
        sendKv(res, 200, {ok: 1, state: snapshot.state, server_time: now()});
        return true;
      }
      sendKv(res, 404, {ok: 0, code: 'not_found', error: 'Not found'});
      return true;
    } catch (error) {
      const status = Number(error.status) || 500;
      if (!res.headersSent) sendKv(res, status, {ok: 0, code: error.code || 'error', error: redactSecrets(error.message || String(error))});
      else res.end();
      return true;
    }
  };
}

module.exports = {createDeviceHandler, sendKv, readForm, clientIp};
