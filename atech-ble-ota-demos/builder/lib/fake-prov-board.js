'use strict';

// A Node reference of the board's Bluetooth provisioning service (shared/AtechBleProv): the
// same frames, the same ECDH P-256 / HKDF / AES-256-GCM session, the same grant check and the
// same refusals, written with node:crypto rather than the browser module so the tests prove the
// two sides interoperate byte for byte. Used by the protocol tests and by the jsdom dashboard
// tests through a fake transport. It is a SIMULATION: it proves protocol behaviour, never radio.
const crypto = require('node:crypto');
const {provisionGrantHex} = require('./cloud-auth');

const FLAG_LAST = 0x01;
const FLAG_FIRST = 0x02;
const MAX_FRAGMENT = 240;
const MAX_MESSAGE = 1024;
const REPLY_BIT = 0x80;
const ERROR_OP = 0xff;
const OP_HELLO = 1;
const OP_SCAN = 2;
const OP_PROVISION = 3;
const OP_FORGET = 4;
const OP_SYNC = 5;
const HKDF_INFO = 'atech-prov/1';

// The sealed plaintext is a form body on both sides: strings percent-encoded, booleans 1/0.
function encodeForm(object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  return params.toString();
}

function decodeForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  if (out.claim !== undefined) out.claim = out.claim === '1';
  if (out.wifi !== undefined) out.wifi = out.wifi === '1';
  if (out.url !== undefined && /^[01]$/.test(out.url) && out.op === undefined) out.urlFlag = out.url === '1';
  return out;
}

function fragment(message) {
  const frames = [];
  for (let offset = 0, seq = 0; offset < message.length; offset += MAX_FRAGMENT, seq++) {
    const payload = message.subarray(offset, Math.min(message.length, offset + MAX_FRAGMENT));
    const flags = (offset === 0 ? FLAG_FIRST : 0) | (offset + payload.length >= message.length ? FLAG_LAST : 0);
    frames.push(Buffer.concat([Buffer.from([flags, seq & 0xff]), payload]));
  }
  return frames;
}

function createFakeProvBoard({
  id = 'ATECH-A1B2C3D4E5F6', token = 'fixture-ota-token-0123456789', locked = false, networks = [], faults = {},
  unlockWindowMs = 120000, allowHttp = false, now = Date.now, sync = null,
} = {}) {
  const state = {
    id, locked, unlockUntil: 0, ssid: '', pass: '', url: '', joining: false, connected: false, ip: '', rssi: 0, reason: 0,
    cloudState: 'disabled', cloudSession: false, busy: false, lastClientPub: null, lastBoardPub: null, nonce: null, key: null,
    transcript: null, plaintextSeen: [], tokenReleased: 0, requests: [],
  };
  const handlers = new Set();
  let parts = [];
  let expected = 0;
  let open = false;
  let size = 0;

  const emit = message => {
    if (faults.silent) return;
    for (const frame of fragment(message)) {
      for (const handler of handlers) setTimeout(() => handler(new Uint8Array(frame)), 0);
    }
  };
  const reply = (opcode, body) => emit(Buffer.concat([Buffer.from([opcode]), Buffer.from(body)]));
  const errorReply = text => reply(ERROR_OP, Buffer.from(text, 'utf8'));

  function sealed(opcode, object) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
    cipher.setAAD(Buffer.from([opcode]));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(encodeForm(object), 'utf8')), cipher.final()]);
    if (faults.tamperReply && ciphertext.length) ciphertext[0] ^= 0x01;
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
  }

  function unseal(opcode, body) {
    if (!state.key) throw new Error('No session: send hello first');
    if (body.length < 12 + 16) throw new Error('Could not decrypt the request (too short)');
    const iv = body.subarray(0, 12);
    const tag = body.subarray(body.length - 16);
    const ciphertext = body.subarray(12, body.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', state.key, iv);
    decipher.setAAD(Buffer.from([opcode]));
    decipher.setAuthTag(tag);
    let plaintext;
    try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
    catch (_) { throw new Error('Could not decrypt the request (authentication failed)'); }
    const text = plaintext.toString('utf8');
    state.plaintextSeen.push(text);
    return decodeForm(text);
  }

  function authorized(grant) {
    if (!state.locked) return true;
    if (now() < state.unlockUntil) return true;
    if (!grant || !state.nonce) return false;
    const expectedGrant = provisionGrantHex(token, {deviceId: id, nonce: state.nonce.toString('hex'), transcript: state.transcript});
    const presented = String(grant).toLowerCase();
    return presented.length === expectedGrant.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expectedGrant));
  }

  function hello(body) {
    if (body.length !== 65 || body[0] !== 0x04) { errorReply('Malformed public key'); return; }
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const boardPub = ecdh.getPublicKey();
    let shared;
    try { shared = ecdh.computeSecret(body); } catch (_) { errorReply('Invalid public key'); return; }
    state.nonce = crypto.randomBytes(16);
    state.key = Buffer.from(crypto.hkdfSync('sha256', shared, state.nonce, HKDF_INFO, 32));
    state.lastClientPub = Buffer.from(body);
    state.lastBoardPub = Buffer.from(boardPub);
    state.transcript = crypto.createHash('sha256').update(Buffer.concat([state.lastClientPub, state.lastBoardPub])).digest('hex');
    const flags = (state.locked ? 0x01 : 0) | (state.ssid ? 0x02 : 0) | (state.url ? 0x04 : 0);
    reply(OP_HELLO | REPLY_BIT, Buffer.concat([boardPub, state.nonce, Buffer.from([flags])]));
  }

  function scan() {
    const lines = networks.slice(0, 12).map(n => `${n.ssid}\t${n.rssi}\t${n.open ? 1 : 0}`).join('\n');
    reply(OP_SCAN | REPLY_BIT, Buffer.from(lines ? lines + '\n' : '', 'utf8'));
  }

  function provision(body) {
    let request;
    try { request = unseal(OP_PROVISION, body); } catch (error) { errorReply(error.message); return; }
    state.requests.push({op: 'provision', ...request, pass: request.pass ? '<redacted>' : undefined});
    const answer = object => reply(OP_PROVISION | REPLY_BIT, sealed(OP_PROVISION | REPLY_BIT, object));
    if (!authorized(request.grant)) { answer({ok: false, error: 'This board is locked: it already has an owner. Ask the owner\'s dashboard for a grant or press the BOOT button once'}); return; }
    if (state.busy) { answer({ok: false, error: 'The board is busy with an update; try again when it is done'}); return; }
    const ssid = request.ssid === undefined ? null : String(request.ssid);
    const pass = request.pass === undefined ? '' : String(request.pass);
    const url = request.url === undefined ? null : String(request.url).trim().replace(/\/+$/, '');
    if (ssid !== null && (ssid.length < 1 || ssid.length > 32)) { answer({ok: false, error: 'SSID must contain 1 to 32 characters'}); return; }
    if (ssid !== null && pass && (pass.length < 8 || pass.length > 63)) { answer({ok: false, error: 'Wi-Fi password must contain 8 to 63 characters (or be empty for an open network)'}); return; }
    if (url !== null && url && !(url.startsWith('https://') || (allowHttp && url.startsWith('http://')))) {
      answer({ok: false, error: allowHttp ? 'Server URL must start with https:// or http://' : 'Server URL must start with https:// (the certificate is validated)'});
      return;
    }
    if (ssid !== null) { state.ssid = ssid; state.pass = pass; state.joining = true; state.connected = false; state.reason = 0; }
    if (url !== null) { state.url = url; state.cloudState = url ? 'waiting_wifi' : 'disabled'; }
    const result = {ok: true, joining: ssid !== null};
    if (request.claim) { result.token = token; state.tokenReleased++; }
    answer(result);
  }

  function forget(body) {
    let request;
    try { request = unseal(OP_FORGET, body); } catch (error) { errorReply(error.message); return; }
    const answer = object => reply(OP_FORGET | REPLY_BIT, sealed(OP_FORGET | REPLY_BIT, object));
    if (!authorized(request.grant)) { answer({ok: false, error: 'This board is locked: it already has an owner'}); return; }
    if (request.wifi) { state.ssid = ''; state.pass = ''; state.connected = false; state.joining = false; }
    if (request.url === '1' || request.urlFlag) { state.url = ''; state.cloudState = 'disabled'; }
    answer({ok: true});
  }

  // Board-to-board sync over the sealed session: pairing ops (code, pair, unpair) are gated like a
  // Wi-Fi change on an owned board; state and events are not.
  function syncRequest(body) {
    let request;
    try { request = unseal(OP_SYNC, body); } catch (error) { errorReply(error.message); return; }
    const answer = object => reply(OP_SYNC | REPLY_BIT, sealed(OP_SYNC | REPLY_BIT, object));
    const op = String(request.op || '');
    const privileged = authorized(request.grant);
    if (['code', 'pair', 'unpair'].includes(op) && !privileged) { answer({ok: false, error: 'This board is locked: it already has an owner. Ask the owner\'s dashboard for a grant or press the BOOT button once'}); return; }
    if (!sync) { answer({ok: false, error: 'This image has no board-to-board sync'}); return; }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) if (key !== 'grant' && value !== undefined && value !== null) params.set(key, String(value));
    const result = sync.command(params.toString(), privileged);
    state.requests.push({...request, syncOp: request.op, op: 'sync', grant: request.grant ? '<grant>' : undefined});
    answer(result.ok ? {ok: true, ...(result.code ? {code: result.code} : {})} : {ok: false, error: result.error});
  }

  function handle(message) {
    const opcode = message[0];
    const body = message.subarray(1);
    if (opcode === OP_HELLO) hello(body);
    else if (opcode === OP_SCAN) scan();
    else if (opcode === OP_PROVISION) provision(body);
    else if (opcode === OP_FORGET) forget(body);
    else if (opcode === OP_SYNC) syncRequest(body);
    else errorReply(`Unknown request ${opcode}`);
  }

  const board = {
    state,
    onNotify(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    handleWrite(input) {
      const frame = Buffer.from(input);
      if (frame.length < 3) { parts = []; open = false; return; }
      const flags = frame[0];
      const seq = frame[1];
      if (flags & FLAG_FIRST) { parts = []; size = 0; expected = 0; open = true; }
      if (!open || seq !== expected) { parts = []; open = false; return; }
      const payload = frame.subarray(2);
      if (size + payload.length > MAX_MESSAGE) { parts = []; open = false; return; }
      parts.push(payload);
      size += payload.length;
      expected = (expected + 1) & 0xff;
      if (!(flags & FLAG_LAST)) return;
      const message = Buffer.concat(parts);
      parts = []; open = false; size = 0;
      handle(message);
    },
    status() {
      return JSON.stringify({
        prov: 1, id, locked: state.locked, unlock_ms: Math.max(0, state.unlockUntil - now()), session: Boolean(state.key),
        wifi: {configured: Boolean(state.ssid), ssid: state.ssid, connected: state.connected, ip: state.ip, rssi: state.rssi, reason: state.reason, joining: state.joining},
        cloud: {url: state.url, state: state.cloudState, session: state.cloudSession, last_error: '', last_contact_ms: 0},
        busy: state.busy,
      });
    },
    pressButton() { state.unlockUntil = now() + unlockWindowMs; },
    // Test helpers: the Wi-Fi join and the cloud agent are simulated by the test, not by the board.
    setWifi(patch) { Object.assign(state, patch, {joining: false}); },
    setCloud({state: cloudState, session}) {
      if (cloudState !== undefined) state.cloudState = cloudState;
      if (session !== undefined) { state.cloudSession = session; if (session) state.locked = true; }
    },
  };
  return board;
}

module.exports = {createFakeProvBoard, MAX_FRAGMENT, MAX_MESSAGE, HKDF_INFO};
