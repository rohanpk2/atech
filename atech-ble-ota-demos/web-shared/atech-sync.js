'use strict';

// Board-to-board sync (shared/AtechSync) as the dashboards see it: the GATT status service
// (a7ec0300: status read, change notify), the pairing code format, and one normalized status
// shape whether it came from the board over Bluetooth (the full status JSON), from the LAN
// identity (the same JSON under "sync") or from a cloud poll report (the compact form, values as
// plain text). Commands do not live here: they travel in the Bluetooth setup session
// (atech-provision.js, opcode sync) or through the backend (/api/devices/:id/sync).
(function attachAtechSync(root) {
  const SERVICE = 'a7ec0300-2e47-4dd2-82a4-9c2cf6eaa001';
  const STATUS_CHAR = 'a7ec0301-2e47-4dd2-82a4-9c2cf6eaa001';
  const CHANGE_CHAR = 'a7ec0302-2e47-4dd2-82a4-9c2cf6eaa001';
  const CODE_PATTERN = /^ATSYNC1-([0-9A-F]{12})-([0-9a-f]{2})-([0-9a-f]{32})$/;
  const DEMO_KEY = 'demo.power';
  const CODE_STORAGE = 'atechSyncCode';
  const CODE_TTL_MS = 10 * 60 * 1000;   // the board's pairing window

  function toText(input) {
    if (typeof input === 'string') return input;
    let bytes;
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('Expected a string or bytes');
    return new TextDecoder().decode(bytes);
  }

  function parseJson(input) {
    let data;
    try { data = JSON.parse(toText(input).replace(/\0+$/, '').trim()); } catch (_) { return null; }
    return data && typeof data === 'object' ? data : null;
  }

  function parseStatus(input) {
    const data = parseJson(input);
    if (!data) throw new Error('Sync status is not valid JSON');
    return data;
  }

  // A change notification: {k, v, t, rev, by, remote}, {event, payload, from, remote} or {peer, state}.
  function parseChange(input) { return parseJson(input); }

  // One shape for every source. lastAckAgoMs is null when the source does not carry it (the
  // compact cloud report); value is the demo key's text, or null when the key is not set.
  function normalizeStatus(raw, fallbackId = '') {
    if (!raw || typeof raw !== 'object') return null;
    const table = raw.state && typeof raw.state === 'object' ? raw.state : {};
    const entry = table[DEMO_KEY];
    const value = entry === undefined || entry === null ? null : typeof entry === 'object' ? String(entry.v) : String(entry);
    const ack = raw.lastAckAgoMs;
    return {
      id: raw.id || fallbackId || '',
      paired: Boolean(raw.paired),
      connected: Boolean(raw.connected),
      peer: raw.peer || '',
      peerState: raw.peerState || (raw.paired ? 'offline' : 'none'),
      pairingCode: raw.pairingCode || raw.code || '',
      pairingOpen: Boolean(raw.pairingOpen || raw.code),
      paused: Boolean(raw.paused),
      channelMismatch: Boolean(raw.channelMismatch),
      lastAckAgoMs: typeof ack === 'number' && Number.isFinite(ack) ? ack : null,
      value,
      state: table,
    };
  }

  function issuerOf(code) {
    const match = CODE_PATTERN.exec(String(code || '').trim());
    return match ? `ATECH-${match[1]}` : null;
  }

  // The last pairing code this dashboard obtained, kept for the next board in this tab only.
  function storeCode(storage, record) {
    try {
      if (!record) storage.removeItem(CODE_STORAGE);
      else storage.setItem(CODE_STORAGE, JSON.stringify({code: record.code, from: record.from, at: record.at || Date.now()}));
    } catch (_) { /* private mode */ }
  }

  function loadCode(storage) {
    try {
      const raw = storage.getItem(CODE_STORAGE);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (!record || !CODE_PATTERN.test(record.code) || Date.now() - Number(record.at || 0) > CODE_TTL_MS) return null;
      return record;
    } catch (_) { return null; }
  }

  const api = Object.freeze({SERVICE, STATUS_CHAR, CHANGE_CHAR, CODE_PATTERN, DEMO_KEY, CODE_STORAGE, CODE_TTL_MS,
                             parseStatus, parseChange, normalizeStatus, issuerOf, storeCode, loadCode});
  root.AtechSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
