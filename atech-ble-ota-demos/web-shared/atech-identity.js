'use strict';

// Atech identity service protocol shared by both dashboards.
// Service a7ec0100: identity (read, JSON), control (write), event (notify).
(function attachAtechIdentity(root) {
  const IDENTITY_SERVICE = 'a7ec0100-2e47-4dd2-82a4-9c2cf6eaa001';
  const IDENTITY_CHAR = 'a7ec0101-2e47-4dd2-82a4-9c2cf6eaa001';
  const CONTROL_CHAR = 'a7ec0102-2e47-4dd2-82a4-9c2cf6eaa001';
  const EVENT_CHAR = 'a7ec0103-2e47-4dd2-82a4-9c2cf6eaa001';
  const CONTROL = Object.freeze({confirm: 1, rollback: 2, echo: 3, restart: 4});
  const CONTROL_NAMES = Object.freeze({1: 'confirm', 2: 'rollback', 3: 'echo', 4: 'restart'});
  const CONTROL_STATUS = Object.freeze({0: 'ok', 1: 'unsupported', 2: 'refused'});
  const CONTROL_PACKET_SIZE = 9;
  const EVENT_PACKET_SIZE = 10;
  const DEVICE_ID = /^ATECH-[0-9A-F]{12}$/;

  function toText(input) {
    if (typeof input === 'string') return input;
    let bytes;
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('Identity must be a string or bytes');
    return new TextDecoder().decode(bytes);
  }

  function parseIdentity(input) {
    const text = toText(input).replace(/\0+$/, '').trim();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error('Identity is not valid JSON');
    }
    if (!data || typeof data !== 'object') throw new Error('Identity is not valid JSON');
    if (typeof data.id !== 'string' || !DEVICE_ID.test(data.id)) {
      throw new Error('Identity has an invalid device id');
    }
    const missing = ['demo', 'build', 'slotSize'].filter(key => data[key] === undefined || data[key] === null);
    if (missing.length) throw new Error(`Identity is missing ${missing.join(', ')}`);
    return {
      ...data,
      demo: Number(data.demo),
      slotSize: Number(data.slotSize),
      ver: Number(data.ver || 0),
      loops: Number(data.loops || 0),
      up: Number(data.up || 0),
      crashes: Number(data.crashes || 0),
      pending: Boolean(data.pending),
      canRollback: Boolean(data.canRollback),
      safe: Boolean(data.safe),
      paired: data.paired !== false,
      suffix: data.suffix || data.id.slice(-6),
      app: data.app || '',
      appState: data.appState || 'unknown',
    };
  }

  function describeIdentity(identity) {
    let text = `${identity.id} (pairing code ${identity.suffix}), Demo ${identity.demo}, build ${identity.build}, ` +
               `app "${identity.app}" v${identity.ver}, ${identity.appState}`;
    if (identity.safe) text += ', SAFE MODE';
    if (identity.pending) text += ', pending verification';
    return text;
  }

  function buildControlPacket(opcode, nonce) {
    if (!Object.values(CONTROL).includes(opcode)) throw new Error(`Unknown control opcode ${opcode}`);
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 8) throw new Error('Control nonce must be 8 bytes');
    const packet = new Uint8Array(CONTROL_PACKET_SIZE);
    packet[0] = opcode;
    packet.set(nonce, 1);
    return packet;
  }

  function parseControlEvent(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== EVENT_PACKET_SIZE) {
      throw new Error('Control event must be 10 bytes');
    }
    return {
      opcode: bytes[0],
      name: CONTROL_NAMES[bytes[0]] || `opcode ${bytes[0]}`,
      status: bytes[1],
      statusText: CONTROL_STATUS[bytes[1]] || `status ${bytes[1]}`,
      nonce: bytes.slice(2, 10),
    };
  }

  function randomNonce() {
    const nonce = new Uint8Array(8);
    const cryptoApi = root.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(nonce);
    else for (let i = 0; i < 8; i++) nonce[i] = Math.floor(Math.random() * 256);
    return nonce;
  }

  function bytesEqual(left, right) {
    return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
  }

  const api = Object.freeze({
    IDENTITY_SERVICE, IDENTITY_CHAR, CONTROL_CHAR, EVENT_CHAR,
    CONTROL, CONTROL_NAMES, CONTROL_STATUS,
    parseIdentity, describeIdentity, buildControlPacket, parseControlEvent, randomNonce, bytesEqual,
  });
  root.AtechIdentity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
