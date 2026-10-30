'use strict';

// A Node simulation of the board's LAN OTA service (shared/AtechWifiLan).
// It implements the same routes, nonce/HMAC rules, streaming image checks and
// reboot behaviour so the backend, the dashboard and the tests can exercise
// the whole Wi-Fi deployment flow without hardware. It is explicitly a
// SIMULATION: nothing here measures real ESP32 flash or radio performance.
const crypto = require('node:crypto');
const http = require('node:http');
const {beginMessage, controlMessage, hmacHex, constantTimeEqual} = require('./lan-auth');

const NONCE_TTL_MS = 90000;
const CHUNK_MAX = 256 * 1024;
const SESSION_TIMEOUT_MS = 20000;

function syntheticFirmware({demo = 1, build = 'stock', target = '', size = 64 * 1024, chipId = 9, flashCode = 4, appDesc = true} = {}) {
  const buf = Buffer.alloc(size);
  buf[0] = 0xE9; buf[1] = 4; buf[3] = (flashCode << 4) & 0xF0;
  buf.writeUInt16LE(chipId, 12);
  if (appDesc) buf.writeUInt32LE(0xABCD5432, 32);
  let offset = 1024;
  for (const marker of [`ATECH-OTA-APP-DEMO${demo}\0`, `ATECH-BUILD:${build}\0`, `ATECH-TARGET:${target}\0`, 'ATECH-CLOUD-AGENT:1\0']) {
    buf.write(marker, offset, 'latin1');
    offset += marker.length + 3;
  }
  crypto.randomFillSync(buf, 2048, Math.min(size - 2048, 8192));
  return buf;
}

function createFakeDevice({
  id = 'ATECH-A1B2C3D4E5F6', demo = 1, build = 'stock', app = 'blue default', ver = 1, secret = 'fixture-ota-token-0123456789',
  slotSize = 0x600000, host = '127.0.0.1', port = 0, rebootMs = 800, faults = {}, log = () => {},
} = {}) {
  const state = {
    id, suffix: id.slice(-6), demo, build, app, ver, fw: `simulated demo${demo} build ${build}`, secret, slotSize,
    pending: false, canRollback: false, safe: false, loops: 0, bootAt: Date.now(), otaOwner: '', previousBuild: null,
    nonces: new Map(), session: null, rebooting: false, lastTransferError: '', lastTransferMs: 0, confirmCount: 0,
    events: [], faults: {...faults}, port, ip: host, stopped: false, rebootTimer: null,
  };
  const note = (text) => { state.events.push(text); log(text); };

  function identity() {
    const up = Date.now() - state.bootAt;
    state.loops = state.faults.appHangs ? 0 : Math.floor(up / 40);
    return {
      id: state.id, suffix: state.suffix, demo: state.demo, board: 'esp32-s3-devkitc-1', variant: 'N16R8', core: 'sim',
      fw: state.fw, build: state.build, app: state.app, ver: state.ver, slot: 'ota_0', slotSize: state.slotSize,
      pending: state.pending, canRollback: state.canRollback, safe: state.safe, crashes: 0, target: '', paired: true,
      appState: state.safe ? 'disabled' : 'running', otaOwner: state.otaOwner, loops: state.loops, up,
      net: {enabled: true, configured_ssid: 'SimulatedNet', connected: true, ssid: 'SimulatedNet', ip: state.ip, rssi: -51,
            hostname: `atech-${state.suffix.toLowerCase()}`, mdns: `atech-${state.suffix.toLowerCase()}.local`, port: state.port, proto: 1,
            service: true, transferring: Boolean(state.session), ap_active: false, last_disconnect_reason: 0,
            last_transfer_error: state.lastTransferError, last_transfer_ms: state.lastTransferMs},
    };
  }

  function json(res, status, body, close = false) {
    const text = JSON.stringify(body);
    const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
    if (close) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
  }
  const fail = (res, status, error, close = false) => json(res, status, {ok: false, error}, close);

  function issueNonce() {
    const nonce = crypto.randomBytes(16).toString('hex');
    state.nonces.set(nonce, Date.now());
    if (state.nonces.size > 4) state.nonces.delete(state.nonces.keys().next().value);
    return nonce;
  }
  function consumeNonce(nonce) {
    const key = String(nonce || '').toLowerCase();
    const issued = state.nonces.get(key);
    if (issued === undefined) return false;
    state.nonces.delete(key);
    return Date.now() - issued < NONCE_TTL_MS;
  }

  function abortSession(reason) {
    if (!state.session) return;
    state.session = null;
    state.otaOwner = '';
    state.lastTransferError = reason;
    note(`aborted: ${reason}`);
  }

  function validateHeader(buf) {
    if (buf[0] !== 0xE9) return 'Not an ESP application image (bad magic byte)';
    if (buf.readUInt16LE(12) !== 9) return 'Firmware target is not ESP32-S3';
    if ((buf[3] >> 4) !== 4) return 'Firmware flash target is not the configured 16MB board';
    if (buf.readUInt32LE(32) !== 0xABCD5432) return 'Image is not an application firmware.bin (bootloader/merged images are rejected)';
    return null;
  }

  function simulateReboot({newBuild, rollback = false}) {
    state.rebooting = true;
    note(`rebooting (${rollback ? 'rollback' : 'new image'})`);
    server.closeAllConnections();
    server.close(() => {
      if (state.stopped) return;
      state.rebootTimer = setTimeout(() => {
        state.rebootTimer = null;
        if (state.stopped) return;
        state.bootAt = Date.now();
        state.rebooting = false;
        state.otaOwner = '';
        if (!rollback) {
          state.previousBuild = state.build;
          state.build = newBuild;
          state.pending = !state.faults.autoConfirm;
          state.canRollback = true;
          state.app = `app ${newBuild}`;
          state.ver += 1;
          state.safe = Boolean(state.faults.safeModeAfterReboot);
        } else {
          state.pending = false;
        }
        server.listen(state.port, host, () => note(`back online as build ${state.build}`));
      }, rebootMs);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://device');
    const path = url.pathname;
    const header = name => String(req.headers[name.toLowerCase()] || '');
    if (req.method === 'GET' && path === '/api/identity') { json(res, 200, identity()); return; }
    if (req.method === 'GET' && path === '/api/ota/challenge') {
      json(res, 200, {ok: true, nonce: issueNonce(), ttl_ms: NONCE_TTL_MS, device: state.id, proto: 1});
      return;
    }
    if (req.method === 'POST' && path === '/api/ota/begin') {
      const device = header('X-Atech-Device');
      if (device !== state.id) { fail(res, 403, `This upload is addressed to ${device || 'no device'}; this board is ${state.id}`); return; }
      if (!consumeNonce(header('X-Atech-Nonce'))) { fail(res, 401, 'Unknown, used or expired nonce; request a new challenge'); return; }
      const size = Number(header('X-Atech-Size'));
      const sha = header('X-Atech-SHA256').toLowerCase();
      const buildId = header('X-Atech-Build');
      if (!Number.isInteger(size) || size < 1024) { fail(res, 400, 'Missing or invalid firmware size'); return; }
      if (!/^[0-9a-f]{64}$/.test(sha)) { fail(res, 400, 'Missing or invalid firmware SHA-256'); return; }
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(buildId)) { fail(res, 400, 'Missing or invalid build id'); return; }
      const expected = hmacHex(state.secret, beginMessage({deviceId: device, nonce: header('X-Atech-Nonce'), size, sha256: sha, buildId}));
      if (!constantTimeEqual(expected, header('X-Atech-Auth').toLowerCase())) { fail(res, 401, 'Authorization failed; pair the backend with this board\'s OTA authorization code'); return; }
      if (state.faults.refuseBegin) { fail(res, 409, state.faults.refuseBegin); return; }
      if (state.session && Date.now() - state.session.lastActivity < SESSION_TIMEOUT_MS) { fail(res, 409, 'Another LAN upload is in progress'); return; }
      if (state.otaOwner && state.otaOwner !== 'lan') { fail(res, 409, `Flash is owned by the ${state.otaOwner} updater`); return; }
      if (size > state.slotSize) { fail(res, 413, `Firmware is larger than the inactive OTA slot (${state.slotSize} bytes)`); return; }
      state.otaOwner = 'lan';
      state.session = {id: crypto.randomBytes(16).toString('hex'), size, sha, buildId, received: 0, data: Buffer.alloc(size),
                       startedAt: Date.now(), firstChunkAt: 0, lastActivity: Date.now()};
      state.lastTransferError = '';
      note(`session begun for ${size} bytes build ${buildId}`);
      json(res, 200, {ok: true, session: state.session.id, chunk_max: CHUNK_MAX, partition: 'ota_1', slot_size: state.slotSize, erase_ms: 120});
      return;
    }
    if (req.method === 'PUT' && path === '/api/ota/chunk') {
      const session = state.session;
      if (!session || !constantTimeEqual(session.id, header('X-Atech-Session'))) { fail(res, 409, 'No matching upload session; begin again', true); return; }
      const offset = Number(url.searchParams.get('offset'));
      if (offset !== session.received) { fail(res, 409, `Unexpected offset; the board has ${session.received} bytes`, true); return; }
      const length = Number(req.headers['content-length']);
      if (!length || length > CHUNK_MAX) { fail(res, 413, 'Chunk size out of range', true); return; }
      if (length > session.size - session.received) { abortSession('Received more bytes than declared'); fail(res, 413, 'Chunk exceeds the declared firmware size', true); return; }
      if (!session.firstChunkAt) session.firstChunkAt = Date.now();
      const chunks = [];
      req.on('data', chunk => {
        chunks.push(chunk);
        if (state.faults.dropAfterBytes && session.received + chunks.reduce((n, c) => n + c.length, 0) > state.faults.dropAfterBytes) {
          abortSession('Connection lost during upload; incomplete image discarded');
          req.socket.destroy();
        }
      });
      req.on('end', () => {
        if (!state.session) return;
        const data = Buffer.concat(chunks);
        data.copy(session.data, session.received);
        if (session.received < 36 && session.received + data.length >= 36) {
          const reason = validateHeader(session.data.subarray(0, 36));
          if (reason) { abortSession(reason); fail(res, 422, reason, true); return; }
        }
        session.received += data.length;
        session.lastActivity = Date.now();
        const respond = () => json(res, 200, {ok: true, received: session.received, elapsed_ms: Date.now() - session.firstChunkAt});
        if (state.faults.slowChunkMs) setTimeout(respond, state.faults.slowChunkMs); else respond();
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/ota/finish') {
      const session = state.session;
      if (!session || !constantTimeEqual(session.id, header('X-Atech-Session'))) { fail(res, 409, 'No matching upload session'); return; }
      if (session.received !== session.size) { const r = `Upload incomplete: ${session.received} of ${session.size} bytes`; abortSession(r); fail(res, 422, r); return; }
      const data = session.data;
      if (data.indexOf(`ATECH-OTA-APP-DEMO${state.demo}`, 0, 'latin1') < 0) { abortSession('Firmware belongs to a different Atech demo/target'); fail(res, 422, 'Firmware belongs to a different Atech demo/target'); return; }
      if (data.indexOf(`ATECH-BUILD:${session.buildId}\0`, 0, 'latin1') < 0) { const r = `Image does not carry build id ${session.buildId}`; abortSession(r); fail(res, 422, r); return; }
      const targetAt = data.indexOf('ATECH-TARGET:', 0, 'latin1');
      if (targetAt >= 0) {
        const end = data.indexOf(0, targetAt + 13);
        const target = data.subarray(targetAt + 13, end < 0 ? targetAt + 33 : end).toString('latin1');
        if (target && target !== state.id) { const r = `Image was built for ${target}, not this board`; abortSession(r); fail(res, 422, r); return; }
      }
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      if (digest !== session.sha) { abortSession('Image SHA-256 does not match the declared digest; inactive partition not selected'); fail(res, 422, 'Image SHA-256 does not match the declared digest'); return; }
      if (state.faults.failFinish) { abortSession(state.faults.failFinish); fail(res, 422, state.faults.failFinish); return; }
      const transferMs = Date.now() - session.firstChunkAt;
      state.lastTransferMs = transferMs;
      state.session = null;
      const newBuild = session.buildId;
      note(`verified ${session.size} bytes in ${transferMs} ms`);
      json(res, 200, {ok: true, stage: 'verified', bytes: session.size, sha256: digest, transfer_ms: transferMs, verify_ms: 30, partition: 'ota_1', reboot_in_ms: 200}, true);
      if (!state.faults.noReboot) setTimeout(() => simulateReboot({newBuild, rollback: Boolean(state.faults.rollbackOnReboot)}), 200);
      return;
    }
    if (req.method === 'POST' && path === '/api/ota/abort') {
      const session = state.session;
      if (!session || !constantTimeEqual(session.id, header('X-Atech-Session'))) { fail(res, 409, 'No matching upload session'); return; }
      abortSession('Aborted by the backend');
      json(res, 200, {ok: true, stage: 'aborted'});
      return;
    }
    if (req.method === 'POST' && path === '/api/control') {
      const device = header('X-Atech-Device');
      const op = header('X-Atech-Op').toLowerCase();
      if (device !== state.id) { fail(res, 403, `Request addressed to another board; this board is ${state.id}`); return; }
      if (!['echo', 'confirm', 'rollback', 'restart'].includes(op)) { fail(res, 400, 'Unsupported control operation'); return; }
      if (!consumeNonce(header('X-Atech-Nonce'))) { fail(res, 401, 'Unknown, used or expired nonce; request a new challenge'); return; }
      const expected = hmacHex(state.secret, controlMessage({deviceId: device, nonce: header('X-Atech-Nonce'), op}));
      if (!constantTimeEqual(expected, header('X-Atech-Auth').toLowerCase())) { fail(res, 401, 'Authorization failed'); return; }
      let status = 'ok';
      if (op === 'confirm') { state.pending = false; state.confirmCount += 1; }
      else if (op === 'rollback') {
        if (!state.canRollback || state.session) status = 'refused';
        else { setTimeout(() => { state.build = state.previousBuild || state.build; state.canRollback = false; simulateReboot({rollback: true}); }, 100); }
      } else if (op === 'restart') { if (state.session) status = 'refused'; else setTimeout(() => simulateReboot({rollback: true}), 100); }
      note(`control ${op}: ${status}`);
      json(res, 200, {ok: status === 'ok', op, status, pending: state.pending, canRollback: state.canRollback});
      return;
    }
    fail(res, 404, 'Not found');
  });
  server.keepAliveTimeout = 30000;

  const start = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(state.port, host, () => { state.port = server.address().port; resolve({host, port: state.port}); });
  });
  const stop = () => new Promise(resolve => {
    state.stopped = true;
    if (state.rebootTimer) { clearTimeout(state.rebootTimer); state.rebootTimer = null; }
    if (!server.listening) { resolve(); return; }
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return {server, state, start, stop, identity, get port() { return state.port; }, host};
}

module.exports = {createFakeDevice, syntheticFirmware};
