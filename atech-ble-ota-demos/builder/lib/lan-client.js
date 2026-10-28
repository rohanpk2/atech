'use strict';

// Small HTTP client for the board's LAN service: JSON requests with a strict
// timeout, optional keep-alive agent, and a raw-body PUT for firmware chunks.
const http = require('node:http');

function request({host, port, method = 'GET', path, headers = {}, body = null, timeoutMs = 4000, agent = null}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host, port, method, path, headers: {...headers}, agent: agent || false}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({status: res.statusCode, headers: res.headers, text, json});
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timed out after ${timeoutMs} ms waiting for ${host}:${port}${path}`)); });
    req.on('error', error => reject(describe(error, host, port)));
    if (body) {
      req.setHeader('Content-Length', body.length);
      req.end(body);
    } else {
      req.end();
    }
  });
}

function describe(error, host, port) {
  const code = error && error.code;
  if (code === 'ECONNREFUSED') return new Error(`${host}:${port} refused the connection (is the board on this network and running the LAN service?)`);
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new Error(`${host} is not reachable from this computer`);
  if (code === 'ETIMEDOUT') return new Error(`${host}:${port} did not answer (timed out)`);
  if (code === 'ECONNRESET') return new Error(`${host}:${port} closed the connection`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${host} could not be resolved`);
  return error instanceof Error ? error : new Error(String(error));
}

function keepAliveAgent() {
  return new http.Agent({keepAlive: true, maxSockets: 1, keepAliveMsecs: 1000, timeout: 30000});
}

module.exports = {request, keepAliveAgent, describe};
