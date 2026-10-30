'use strict';

// Atech Bluetooth provisioning protocol (service a7ec0200), shared by both dashboards.
// The board exposes three characteristics: status (read, JSON without secrets), request (write)
// and reply (notify). Requests and replies are fragmented frames; everything that carries the
// Wi-Fi password, the server URL or the board's token travels inside an AES-256-GCM session whose
// key comes from an ephemeral ECDH P-256 exchange (HKDF-SHA256, salt = the board's nonce,
// info "atech-prov/1"). The firmware (shared/AtechBleProv) and the backend's reference board
// (builder/lib/fake-prov-board.js) implement the same byte layout; keep them identical.
//
//   frame   = [flags][seq][payload <= 240]     flags: bit0 last, bit1 first
//   message = [opcode][body], at most 1024 bytes reassembled
//   hello   : body = client public key (65 bytes, uncompressed)
//             reply 0x81 = [board public key 65][nonce 16][flags 1: bit0 locked, bit1 wifi, bit2 url]
//   scan    : reply 0x82 = text lines "ssid<TAB>rssi<TAB>open"
//   provision / forget: body = [iv 12][ciphertext][tag 16], AAD = the opcode byte; the reply
//             (0x83 / 0x84) is encrypted the same way with its own opcode as AAD. The plaintext
//             on both sides is a form body (key=value&..., percent-encoded, booleans as 1/0):
//             the board already speaks that format and needs no JSON parser.
//   error   : opcode 0xFF, body = UTF-8 text (only for requests that cannot be answered in a session)
(function attachAtechProvision(root) {
  const SERVICE = 'a7ec0200-2e47-4dd2-82a4-9c2cf6eaa001';
  const STATUS_CHAR = 'a7ec0201-2e47-4dd2-82a4-9c2cf6eaa001';
  const REQUEST_CHAR = 'a7ec0202-2e47-4dd2-82a4-9c2cf6eaa001';
  const REPLY_CHAR = 'a7ec0203-2e47-4dd2-82a4-9c2cf6eaa001';
  const OPS = Object.freeze({hello: 1, scan: 2, provision: 3, forget: 4});
  const REPLY_BIT = 0x80;
  const ERROR_OP = 0xff;
  const FLAG_LAST = 0x01;
  const FLAG_FIRST = 0x02;
  const MAX_FRAGMENT = 240;
  const MAX_MESSAGE = 1024;
  const PUBLIC_KEY_BYTES = 65;
  const NONCE_BYTES = 16;
  const IV_BYTES = 12;
  const TAG_BYTES = 16;
  const HKDF_INFO = 'atech-prov/1';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected bytes');
  }

  function hex(bytes) {
    return Array.from(toBytes(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }

  function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  // Splits one message into write-sized frames.
  function fragment(message) {
    const bytes = toBytes(message);
    if (bytes.length === 0) throw new Error('Empty message');
    if (bytes.length > MAX_MESSAGE) throw new Error(`Message exceeds ${MAX_MESSAGE} bytes`);
    const frames = [];
    for (let offset = 0, seq = 0; offset < bytes.length; offset += MAX_FRAGMENT, seq++) {
      const payload = bytes.subarray(offset, Math.min(bytes.length, offset + MAX_FRAGMENT));
      const frame = new Uint8Array(2 + payload.length);
      frame[0] = (offset === 0 ? FLAG_FIRST : 0) | (offset + payload.length >= bytes.length ? FLAG_LAST : 0);
      frame[1] = seq & 0xff;
      frame.set(payload, 2);
      frames.push(frame);
    }
    return frames;
  }

  // Rebuilds messages from frames. A first flag starts over; a wrong sequence number or an
  // oversized message drops what was collected, so one bad frame never poisons the next request.
  function createReassembler() {
    let parts = [];
    let size = 0;
    let expected = 0;
    let open = false;
    const reset = () => { parts = []; size = 0; expected = 0; open = false; };
    return {
      reset,
      push(input) {
        const frame = toBytes(input);
        if (frame.length < 3) { reset(); return null; }
        const flags = frame[0];
        const seq = frame[1];
        if (flags & FLAG_FIRST) { reset(); open = true; }
        if (!open || seq !== expected) { reset(); return null; }
        const payload = frame.subarray(2);
        if (size + payload.length > MAX_MESSAGE) { reset(); return null; }
        parts.push(payload);
        size += payload.length;
        expected = (expected + 1) & 0xff;
        if (!(flags & FLAG_LAST)) return null;
        const message = concat(...parts);
        reset();
        return message;
      },
    };
  }

  function parseStatus(input) {
    const text = decoder.decode(toBytes(input)).replace(/\0+$/, '').trim();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('Status is not an object');
    return {...data, wifi: data.wifi || {}, cloud: data.cloud || {}};
  }

  function parseScan(text) {
    const networks = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const [ssid, rssi, open] = line.split('\t');
      if (!ssid) continue;
      networks.push({ssid, rssi: Number(rssi) || 0, open: open === '1'});
    }
    return networks;
  }

  async function sha256Hex(bytes, cryptoApi) {
    return hex(await cryptoApi.subtle.digest('SHA-256', toBytes(bytes)));
  }

  // The value the owner grant is bound to: both public keys of this session.
  function transcriptHex(clientPub, boardPub, cryptoApi = root.crypto) {
    return sha256Hex(concat(toBytes(clientPub), toBytes(boardPub)), cryptoApi);
  }

  // write(frame): sends one frame to the request characteristic; subscribe(handler): delivers
  // every reply frame to handler and returns an unsubscribe function.
  function createSession({write, subscribe, timeoutMs = 8000, crypto: cryptoApi = root.crypto} = {}) {
    if (typeof write !== 'function' || typeof subscribe !== 'function') throw new TypeError('write and subscribe are required');
    if (!cryptoApi || !cryptoApi.subtle) throw new Error('WebCrypto is unavailable');
    const reassembler = createReassembler();
    let pending = null;
    let aesKey = null;
    let session = null;   // {nonce (hex), transcript (hex)}
    const unsubscribe = subscribe(frame => {
      const message = reassembler.push(frame);
      if (!message || !pending) return;
      const opcode = message[0];
      if (opcode !== (pending.op | REPLY_BIT) && opcode !== ERROR_OP) return;
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.resolve({opcode, body: message.subarray(1)});
    });

    async function request(op, body = new Uint8Array(0)) {
      if (pending) throw new Error('Another provisioning request is still in progress');
      const message = concat(Uint8Array.of(op), toBytes(body));
      const answer = new Promise((resolve, reject) => {
        pending = {op, resolve, reject, timer: setTimeout(() => {
          if (!pending) return;
          pending = null;
          reject(new Error('The board did not answer in time; timed out'));
        }, timeoutMs)};
      });
      answer.catch(() => {});
      try {
        for (const frame of fragment(message)) await write(frame);
      } catch (error) {
        if (pending) { clearTimeout(pending.timer); pending = null; }
        throw error;
      }
      return answer;
    }

    function errorText(body) {
      return decoder.decode(body).replace(/\0+$/, '').trim() || 'The board refused the request';
    }

    async function hello() {
      aesKey = null;
      session = null;
      const keyPair = await cryptoApi.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, false, ['deriveBits']);
      const clientPub = new Uint8Array(await cryptoApi.subtle.exportKey('raw', keyPair.publicKey));
      if (clientPub.length !== PUBLIC_KEY_BYTES) throw new Error('Unexpected public key length');
      const {opcode, body} = await request(OPS.hello, clientPub);
      if (opcode === ERROR_OP) throw new Error(errorText(body));
      if (body.length !== PUBLIC_KEY_BYTES + NONCE_BYTES + 1) throw new Error('Malformed hello reply from the board');
      const boardPub = body.subarray(0, PUBLIC_KEY_BYTES);
      const nonce = body.subarray(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + NONCE_BYTES);
      const flags = body[PUBLIC_KEY_BYTES + NONCE_BYTES];
      const boardKey = await cryptoApi.subtle.importKey('raw', boardPub, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
      const shared = await cryptoApi.subtle.deriveBits({name: 'ECDH', public: boardKey}, keyPair.privateKey, 256);
      const ikm = await cryptoApi.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
      aesKey = await cryptoApi.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: nonce, info: encoder.encode(HKDF_INFO)},
                                               ikm, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
      session = {nonce: hex(nonce), transcript: await transcriptHex(clientPub, boardPub, cryptoApi)};
      return {locked: Boolean(flags & 0x01), wifiConfigured: Boolean(flags & 0x02), urlSet: Boolean(flags & 0x04),
              nonce: session.nonce, transcript: session.transcript};
    }

    async function scan() {
      const {opcode, body} = await request(OPS.scan);
      if (opcode === ERROR_OP) throw new Error(errorText(body));
      return parseScan(decoder.decode(body));
    }

    // Form body: strings as given, booleans as 1/0, undefined and null left out.
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
      const result = {ok: out.ok === '1'};
      if (out.joining !== undefined) result.joining = out.joining === '1';
      if (out.token) result.token = out.token;
      if (out.error) result.error = out.error;
      return result;
    }

    async function seal(op, object) {
      const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
      const plaintext = encoder.encode(encodeForm(object));
      const sealed = new Uint8Array(await cryptoApi.subtle.encrypt({name: 'AES-GCM', iv, additionalData: Uint8Array.of(op), tagLength: TAG_BYTES * 8}, aesKey, plaintext));
      return concat(iv, sealed);
    }

    async function unseal(op, body) {
      if (body.length < IV_BYTES + TAG_BYTES) throw new Error('Reply could not be decrypted (too short)');
      const iv = body.subarray(0, IV_BYTES);
      let plaintext;
      try {
        plaintext = await cryptoApi.subtle.decrypt({name: 'AES-GCM', iv, additionalData: Uint8Array.of(op), tagLength: TAG_BYTES * 8}, aesKey, body.subarray(IV_BYTES));
      } catch (_) {
        throw new Error('Reply could not be decrypted (authentication failed)');
      }
      return decodeForm(decoder.decode(plaintext));
    }

    async function sealedRequest(op, payload) {
      if (!aesKey) return {ok: false, error: 'No secure session with the board yet: run hello first'};
      const {opcode, body} = await request(op, await seal(op, payload));
      if (opcode === ERROR_OP) return {ok: false, error: errorText(body)};
      return unseal(op | REPLY_BIT, body);
    }

    // {ssid, pass, url, grant, claim}: every field optional; only what is present is applied.
    function provision(payload) { return sealedRequest(OPS.provision, payload || {}); }
    // {wifi, url, grant}
    function forget(payload) { return sealedRequest(OPS.forget, payload || {}); }

    function close() {
      try { unsubscribe(); } catch (_) { /* ignore */ }
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Session closed')); pending = null; }
      aesKey = null;
      session = null;
    }

    return {hello, scan, provision, forget, close, hasKey: () => Boolean(aesKey), current: () => session};
  }

  const api = Object.freeze({
    SERVICE, STATUS_CHAR, REQUEST_CHAR, REPLY_CHAR, OPS, ERROR_OP, MAX_FRAGMENT, MAX_MESSAGE,
    fragment, createReassembler, createSession, parseStatus, parseScan, transcriptHex, hex,
  });
  root.AtechProvision = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
