'use strict';

// A Node model of the board's AtechSync engine (shared/AtechSync/src/SyncEngine.cpp): the same
// pairing codes, the same (revision, writer MAC) versioning and tie-breaker, acknowledgments
// with retries, duplicate suppression, heartbeats, the connected/offline rule and the full
// exchange after a reconnection, joined to other simulated boards through an in-process bus
// that stands in for ESP-NOW. It is a SIMULATION of the protocol's observable behaviour so the
// backend, the dashboards and the tests can pair two boards and toggle shared state without
// hardware; it proves nothing about radio, channels or encryption (frames carry the pairing key
// in clear as `seal` and the receiver compares it, which models the GCM check and nothing more).
const crypto = require('node:crypto');

const CODE_PATTERN = /^ATSYNC1-([0-9A-F]{12})-([0-9a-f]{2})-([0-9a-f]{32})$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const LIMITS = Object.freeze({maxValue: 96, maxName: 32, maxPayload: 96, maxKeys: 16, maxPeers: 4, queue: 20, attempts: 5, dedupe: 16});
const PAIRING_OPS = new Set(['code', 'pair', 'unpair']);
const OPS = new Set(['code', 'pair', 'unpair', 'set', 'toggle', 'event', 'status']);

function createSyncBus({delayMs = 3, lossRate = 0} = {}) {
  const nodes = new Map();
  const bus = {
    nodes, partition: false, delayMs, lossRate, delivered: 0, dropped: 0,
    attach(mac, node) { nodes.set(mac, node); },
    detach(mac) { nodes.delete(mac); },
    send(from, to, message) {
      if (bus.partition || (bus.lossRate && Math.random() < bus.lossRate)) { bus.dropped++; return; }
      const target = nodes.get(to);
      if (!target) return;
      const copy = JSON.parse(JSON.stringify(message));
      setTimeout(() => { if (nodes.get(to) === target) { bus.delivered++; target.receive(from, copy); } }, bus.delayMs);
    },
  };
  return bus;
}

function validValue(type, value) {
  if (typeof value !== 'string' || value.length > LIMITS.maxValue) return false;
  switch (type) {
    case 'bool': return value === 'true' || value === 'false';
    case 'int': return /^-?\d{1,10}$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
    case 'float': return value !== '' && Number.isFinite(Number(value));
    case 'string': return true;
    case 'json': return value.startsWith('{') || value.startsWith('[');
    default: return false;
  }
}

function inferType(value) {
  if (value === 'true' || value === 'false') return 'bool';
  if (validValue('int', value)) return 'int';
  if (validValue('float', value)) return 'float';
  if (value.startsWith('{') || value.startsWith('[')) return 'json';
  return 'string';
}

// Higher revision first, then the numerically larger writer MAC (same-length uppercase hex).
function compareVersion(revA, writerA, revB, writerB) {
  if (revA !== revB) return revA > revB ? 1 : -1;
  return writerA > writerB ? 1 : writerA < writerB ? -1 : 0;
}

function createFakeSync({id, bus, helloMs = 3000, timeoutMs = 8000, retryMs = 150, pairWindowMs = 600000, pairReqMs = 1000, tickMs = 20,
                         now = Date.now, log = () => {}} = {}) {
  if (!bus) throw new Error('createFakeSync needs a bus');
  const mac = String(id).replace(/^ATECH-/, '').toUpperCase();
  const toId = m => `ATECH-${m}`;
  const stats = {sent: 0, acked: 0, retries: 0, dropped: 0, received: 0, duplicates: 0, stale: 0, rejected: 0, forwarded: 0, authFailures: 0, unknownSenders: 0};
  const peers = [];            // {mac, key, channel, confirmed, state, lastRxMs, lastAckMs, lastTxMs, nextPairMs, pairAttempts, nonce, dedupe, digestMisses}
  const store = new Map();     // key -> {type, value, revision, writer}
  const queue = [];            // {peer, type, msgId, body, attempts, nextAt, key}
  const listeners = [];
  let pairing = null;          // {key, until}
  let pairingCode = '';
  let msgId = crypto.randomInt(1, 0x7fffffff);
  let timer = null;
  let paused = false;
  const channel = 1;

  const node = {id, mac, bus, stats, events: [], changes: [], get paused() { return paused; }, set paused(value) { paused = Boolean(value); }};
  const nextId = () => { msgId = (msgId + 1) >>> 0 || 1; return msgId; };
  const peerFor = m => peers.find(p => p.mac === m) || null;
  const pairingOpen = () => Boolean(pairing && now() < pairing.until);
  const digest = () => {
    const parts = [...store.entries()].map(([k, e]) => `${k}:${e.revision}:${e.writer}`).sort();
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  };
  const notify = change => { node.changes.push(change); for (const fn of listeners) { try { fn(change); } catch { /* ignore */ } } };

  function transmit(peer, type, body = {}) {
    bus.send(mac, peer.mac, {type, msgId: nextId(), seal: peer.key, ...body});
    peer.lastTxMs = now();
  }

  function hello(peer, ack = false, ackOf = 0) {
    transmit(peer, ack ? 'helloAck' : 'hello', {ackOf, channel, stateCount: store.size, digest: digest()});
  }

  function enqueue(peerMac, type, body, key = null) {
    let slot = type === 'state' ? queue.find(q => q.peer === peerMac && q.type === 'state' && q.key === key) : null;
    const replacing = Boolean(slot);
    if (!slot) {
      if (queue.length >= LIMITS.queue) { stats.dropped++; return false; }
      slot = {peer: peerMac, type, key, nextAt: now()};
      queue.push(slot);
    }
    slot.body = body;
    slot.msgId = nextId();
    slot.attempts = 0;
    if (replacing) { /* keep the schedule */ }
    return true;
  }

  const enqueueState = (peerMac, key) => {
    const e = store.get(key);
    enqueue(peerMac, 'state', {key, valueType: e.type, value: e.value, revision: e.revision, writer: e.writer}, key);
  };
  const sendAll = peer => { for (const key of store.keys()) enqueueState(peer.mac, key); };
  const queuedFor = peerMac => queue.filter(q => q.peer === peerMac).length;

  function touch(peer) {
    peer.lastRxMs = now();
    if (peer.state === 'connected') return false;
    const previous = peer.state;
    peer.state = 'connected';
    peer.confirmed = true;
    log(`${id}: peer ${toId(peer.mac)} ${previous} -> connected`);
    return true;
  }

  function seen(peer, incomingId) {
    if (peer.dedupe.includes(incomingId)) return true;
    peer.dedupe.push(incomingId);
    if (peer.dedupe.length > LIMITS.dedupe) peer.dedupe.shift();
    return false;
  }

  function applyRemote(entry) {
    if (!KEY_PATTERN.test(entry.key) || !validValue(entry.valueType, entry.value) || !(entry.revision >= 1)) return 'rejected';
    const local = store.get(entry.key);
    if (!local && store.size >= LIMITS.maxKeys) return 'rejected';
    if (local) {
      const order = compareVersion(entry.revision, entry.writer, local.revision, local.writer);
      if (order === 0) return 'duplicate';
      if (order < 0) return 'stale';
    }
    store.set(entry.key, {type: entry.valueType, value: entry.value, revision: entry.revision, writer: entry.writer});
    return 'applied';
  }

  function receive(from, message) {
    const peer = peerFor(from);
    const expectedKey = peer ? peer.key : (message.type === 'pairReq' && pairingOpen() ? pairing.key : null);
    if (!expectedKey) { stats.unknownSenders++; return; }
    if (message.seal !== expectedKey) { stats.authFailures++; return; }
    if (message.type === 'pairReq') {
      if (!pairingOpen()) { stats.rejected++; return; }
      let p = peer;
      if (!p) {
        if (peers.length >= LIMITS.maxPeers) { stats.rejected++; return; }
        p = {mac: from, dedupe: [], state: 'none'};
        peers.push(p);
      }
      const previous = p.state;
      Object.assign(p, {key: pairing.key, channel: message.channel || 0, confirmed: true, state: 'connected', lastRxMs: now(), lastAckMs: 0, lastTxMs: 0,
                        pairAttempts: 0, digestMisses: 0});
      stats.received++;
      transmit(p, 'pairAck', {nonce: message.nonce, channel});
      pairing = null;
      pairingCode = '';
      log(`${id}: paired with ${toId(from)} (${previous} -> connected)`);
      return;
    }
    if (!peer) { stats.rejected++; return; }
    if (message.type === 'pairAck' && peer.state === 'pairing' && message.nonce !== peer.nonce) { stats.rejected++; return; }
    stats.received++;
    const justConnected = touch(peer);
    switch (message.type) {
      case 'hello':
      case 'helloAck': {
        if (message.channel) peer.channel = message.channel;
        if (message.type === 'hello' && !paused) hello(peer, true, message.msgId);
        const differ = message.digest !== digest() || message.stateCount !== store.size;
        if (differ && justConnected) { peer.digestMisses = 0; sendAll(peer); }
        else if (!differ) peer.digestMisses = 0;
        else if (queuedFor(peer.mac) === 0 && ++peer.digestMisses >= 2) { peer.digestMisses = 0; sendAll(peer); }
        break;
      }
      case 'state': {
        if (seen(peer, message.msgId)) { stats.duplicates++; transmit(peer, 'stateAck', {ackOf: message.msgId}); break; }
        const result = applyRemote(message);
        transmit(peer, 'stateAck', {ackOf: message.msgId});
        if (result === 'applied') {
          const e = store.get(message.key);
          notify({key: message.key, type: e.type, value: e.value, revision: e.revision, writer: toId(e.writer), remote: true});
          for (const other of peers) if (other.mac !== peer.mac && other.confirmed) { enqueueState(other.mac, message.key); stats.forwarded++; }
        } else if (result === 'duplicate') stats.duplicates++;
        else if (result === 'stale') { stats.stale++; enqueueState(peer.mac, message.key); }
        else stats.rejected++;
        break;
      }
      case 'event': {
        if (seen(peer, message.msgId)) { stats.duplicates++; transmit(peer, 'eventAck', {ackOf: message.msgId}); break; }
        transmit(peer, 'eventAck', {ackOf: message.msgId});
        node.events.push({name: message.name, payload: message.payload || '', source: toId(peer.mac), remote: true});
        for (const other of peers) if (other.mac !== peer.mac && other.confirmed) { enqueue(other.mac, 'event', {name: message.name, payload: message.payload}); stats.forwarded++; }
        break;
      }
      case 'stateAck':
      case 'eventAck': {
        const index = queue.findIndex(q => q.peer === peer.mac && q.msgId === message.ackOf);
        if (index >= 0) { queue.splice(index, 1); stats.acked++; peer.lastAckMs = now(); }
        break;
      }
      case 'pairAck':
        if (message.channel) peer.channel = message.channel;
        break;
      case 'unpair':
        removePeer(peer, false);
        break;
      default:
        stats.rejected++;
    }
  }

  function removePeer(peer, tell) {
    if (tell && peer.confirmed) transmit(peer, 'unpair');
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].peer === peer.mac) queue.splice(i, 1);
    peers.splice(peers.indexOf(peer), 1);
    log(`${id}: peer ${toId(peer.mac)} ${peer.state} -> none`);
  }

  function tick() {
    const t = now();
    for (const peer of [...peers]) {
      if (!peer.confirmed) {
        if (!paused && t >= peer.nextPairMs) {
          transmit(peer, 'pairReq', {nonce: peer.nonce, channel});
          peer.pairAttempts++;
          peer.nextPairMs = t + (peer.pairAttempts < 20 ? pairReqMs : pairReqMs * 10);
        }
        continue;
      }
      if (peer.state === 'connected' && t - peer.lastRxMs > timeoutMs) { peer.state = 'offline'; log(`${id}: peer ${toId(peer.mac)} connected -> offline`); }
      if (!paused && (!peer.lastTxMs || t - peer.lastTxMs >= helloMs)) hello(peer);
    }
    if (paused) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (t < q.nextAt) continue;
      if (q.attempts >= LIMITS.attempts) { queue.splice(i, 1); stats.dropped++; continue; }
      const peer = peerFor(q.peer);
      if (!peer) { queue.splice(i, 1); continue; }
      bus.send(mac, peer.mac, {type: q.type, msgId: q.msgId, seal: peer.key, ...q.body});
      peer.lastTxMs = t;
      q.attempts++;
      stats.sent++;
      if (q.attempts > 1) stats.retries++;
      q.nextAt = t + retryMs * 2 ** (q.attempts - 1);
    }
  }

  function setLocal(key, type, value) {
    if (!KEY_PATTERN.test(key)) return {ok: false, error: 'Key must be 1 to 32 letters, digits, \'.\', \'_\' or \'-\''};
    if (!validValue(type, value)) return {ok: false, error: `Value is not a valid ${type}`};
    const existing = store.get(key);
    if (!existing && store.size >= LIMITS.maxKeys) return {ok: false, error: 'The state table is full (16 keys)'};
    const entry = {type, value, revision: (existing ? existing.revision : 0) + 1, writer: mac};
    store.set(key, entry);
    notify({key, type, value, revision: entry.revision, writer: toId(mac), remote: false});
    for (const peer of peers) if (peer.confirmed) enqueueState(peer.mac, key);
    return {ok: true};
  }

  function command(form, privileged) {
    const params = new URLSearchParams(String(form || ''));
    const op = params.get('op') || '';
    const result = {ok: false, error: '', code: ''};
    if (!OPS.has(op)) { result.error = 'Unknown op'; return result; }
    if (PAIRING_OPS.has(op) && !privileged) { result.error = 'Pairing changes need an authorized connection'; return result; }
    if (op === 'code') {
      const key = crypto.randomBytes(16).toString('hex');
      pairing = {key, until: now() + pairWindowMs};
      pairingCode = `ATSYNC1-${mac}-${channel.toString(16).padStart(2, '0')}-${key}`;
      log(`${id}: pairing code issued`);
      return {ok: true, error: '', code: pairingCode};
    }
    if (op === 'pair') {
      const match = CODE_PATTERN.exec(String(params.get('code') || '').trim());
      if (!match) { result.error = 'Malformed pairing code (expected ATSYNC1-<MAC>-<channel>-<key>)'; return result; }
      const [, peerMac, channelHex, key] = match;
      if (peerMac === mac) { result.error = 'That code was issued by this very board; use it on the other board'; return result; }
      let peer = peerFor(peerMac);
      if (!peer) {
        if (peers.length >= LIMITS.maxPeers) { result.error = 'Peer table full; unpair first'; return result; }
        peer = {mac: peerMac, dedupe: []};
        peers.push(peer);
      }
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].peer === peerMac) queue.splice(i, 1);
      Object.assign(peer, {key, channel: parseInt(channelHex, 16), confirmed: false, state: 'pairing', lastRxMs: 0, lastAckMs: 0, lastTxMs: 0,
                           nextPairMs: now(), pairAttempts: 0, nonce: crypto.randomBytes(8).toString('hex'), digestMisses: 0});
      pairing = null;
      pairingCode = '';
      log(`${id}: pairing with ${toId(peerMac)}`);
      return {ok: true, error: '', code: ''};
    }
    if (op === 'unpair') {
      for (const peer of [...peers]) removePeer(peer, true);
      pairing = null;
      pairingCode = '';
      return {ok: true, error: '', code: ''};
    }
    if (op === 'set') {
      const value = params.get('value') || '';
      const type = params.get('type') || inferType(value);
      if (!['bool', 'int', 'float', 'string', 'json'].includes(type)) { result.error = 'Unknown value type'; return result; }
      return {...setLocal(params.get('key') || '', type, value), code: ''};
    }
    if (op === 'toggle') {
      const key = params.get('key') || '';
      const entry = store.get(key);
      if (entry && entry.type !== 'bool') { result.error = 'That key is not a boolean'; return result; }
      return {...setLocal(key, 'bool', entry && entry.value === 'true' ? 'false' : 'true'), code: ''};
    }
    if (op === 'event') {
      const name = params.get('name') || '';
      const payload = params.get('payload') || '';
      if (name.length < 1 || name.length > LIMITS.maxName || payload.length > LIMITS.maxPayload) { result.error = 'Event name must be 1 to 32 characters, payload at most 96'; return result; }
      node.events.push({name, payload, source: toId(mac), remote: false});
      for (const peer of peers) if (peer.confirmed) enqueue(peer.mac, 'event', {name, payload});
      return {ok: true, error: '', code: ''};
    }
    return {ok: true, error: '', code: ''};
  }

  function status() {
    const t = now();
    const first = peers[0] || null;
    const state = {};
    for (const [key, e] of store) state[key] = {v: e.value, t: e.type, rev: e.revision, by: toId(e.writer)};
    return {
      sync: 1, id, mac, channel, wifi: false, radio: true, paused, pairingOpen: pairingOpen(), pairingCode: pairingOpen() ? pairingCode : '',
      paired: Boolean(first), connected: Boolean(first && first.state === 'connected'), peer: first ? toId(first.mac) : '',
      peerState: first ? first.state : 'none', peerChannel: first ? first.channel || 0 : 0, channelMismatch: false,
      lastAckAgoMs: first && first.lastAckMs ? t - first.lastAckMs : -1, lastSeenAgoMs: first && first.lastRxMs ? t - first.lastRxMs : -1,
      peers: peers.map(p => ({id: toId(p.mac), state: p.state, confirmed: Boolean(p.confirmed), channel: p.channel || 0})),
      state, queued: queue.length, stats: {...stats},
    };
  }

  // What the board's GATT status characteristic serves: the compact facts plus the live ones, state
  // entries added while the whole payload stays under the firmware's BLE_STATUS_BUDGET (440 bytes).
  const BLE_STATUS_BUDGET = 440;
  function bleStatus() {
    const t = now();
    const first = peers[0] || null;
    const base = {sync: 1, id, paired: Boolean(first), connected: Boolean(first && first.state === 'connected'), peer: first ? toId(first.mac) : '',
                  peerState: first ? first.state : 'none', pairingOpen: pairingOpen(), code: pairingOpen() ? pairingCode : '', paused, channelMismatch: false,
                  channel, lastAckAgoMs: first && first.lastAckMs ? t - first.lastAckMs : -1, state: {}, truncated: false};
    for (const [key, e] of store) {
      const candidate = {...base, state: {...base.state, [key]: e.value}};
      if (JSON.stringify(candidate).length > BLE_STATUS_BUDGET) { base.truncated = true; break; }
      base.state[key] = e.value;
    }
    return base;
  }

  function compact() {
    const first = peers[0] || null;
    const state = {};
    for (const [key, e] of store) state[key] = e.value;
    return {paired: Boolean(first), connected: Boolean(first && first.state === 'connected'), peer: first ? toId(first.mac) : '',
            peerState: first ? first.state : 'none', code: pairingOpen() ? pairingCode : '', state};
  }

  Object.assign(node, {
    receive, command, status, compact, bleStatus,
    get: key => { const e = store.get(key); return e ? {type: e.type, value: e.value, revision: e.revision, writer: toId(e.writer)} : null; },
    set: (key, value, type) => setLocal(key, type || inferType(String(value)), String(value)),
    onChange: fn => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
    start() { if (timer) return; bus.attach(mac, node); timer = setInterval(tick, tickMs); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = null; bus.detach(mac); },
  });
  return node;
}

module.exports = {createSyncBus, createFakeSync, CODE_PATTERN, LIMITS, compareVersion, inferType, validValue};
