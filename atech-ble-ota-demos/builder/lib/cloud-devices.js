'use strict';

// Device side of the cloud OTA path: boards prove their pairing token with an
// HMAC over a single-use nonce, get a bearer session, and are tracked by their
// last report. Unclaimed boards leave a commitment so a claim can be verified
// at once. Nothing here is reachable through the dashboard key.
const crypto = require('node:crypto');
const {proofHex, newSessionToken, CloudError} = require('./cloud-auth');
const {constantTimeEqual} = require('./lan-auth');
const {DEVICE_ID} = require('./devices');

const NONCE_TTL_MS = 90000;
const NONCE_SLOTS = 4;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_BOARD = 4;
const MAX_REGISTRATIONS = 64;
const REGISTRATION_TTL_MS = 10 * 60 * 1000;
const PERSIST_INTERVAL_MS = 30000;
const LIMITS = {ip: {capacity: 60, perMinute: 60}, id: {capacity: 20, perMinute: 20}};

const truthy = value => value === true || value === '1' || value === 'true';
const number = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

// Fields a board sends with login and poll, as strings from a form body, normalized once.
function normalizeReport(info = {}) {
  return {
    demo: number(info.demo), fw: String(info.fw || ''), build: String(info.build || ''), app: String(info.app || ''), ver: number(info.ver),
    slotSize: number(info.slot_size), core: String(info.core || ''), agent: info.agent === undefined ? null : String(info.agent),
    pending: truthy(info.pending), safe: truthy(info.safe), up: number(info.up), loops: number(info.loops), rssi: number(info.rssi),
    heap: number(info.heap), heapMin: number(info.heap_min), ready: truthy(info.ready), transferring: truthy(info.transferring),
    bootJob: String(info.boot_job || ''), bootBuild: String(info.boot_build || ''), state: String(info.state || ''),
  };
}

class RateLimiter {
  constructor(now) { this.now = now; this.buckets = new Map(); }
  allow(key, {capacity, perMinute}) {
    const now = this.now();
    const bucket = this.buckets.get(key) || {tokens: capacity, updatedAt: now};
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) / 60000 * perMinute);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) { this.buckets.set(key, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10000) this.buckets.delete(this.buckets.keys().next().value);
    return true;
  }
}

class CloudDeviceService {
  constructor({config, devices, now = Date.now, log = () => {}}) {
    this.config = config;
    this.devices = devices;
    this.now = now;
    this.log = log;
    this.nonces = new Map();          // id -> [{nonce, issuedAt}]
    this.sessions = new Map();        // token -> {deviceId, issuedAt, expiresAt}
    this.registrations = new Map();   // id -> {id, nonce, proof, info, seenAt, authFailed}
    this.lastPersist = new Map();     // id -> ms
    this.limiter = new RateLimiter(now);
  }

  iso(ms = this.now()) { return new Date(ms).toISOString(); }

  checkId(id) {
    if (!DEVICE_ID.test(String(id || ''))) throw new CloudError(400, 'bad_request', 'Board id must look like ATECH-XXXXXXXXXXXX');
  }

  limit(id, ip) {
    if (!this.limiter.allow(`ip:${ip || '?'}`, LIMITS.ip) || !this.limiter.allow(`id:${id}`, LIMITS.id)) {
      throw new CloudError(429, 'rate_limited', 'Too many attempts; try again in a minute');
    }
  }

  challenge({id, ip}) {
    this.checkId(id);
    this.limit(id, ip);
    const nonce = crypto.randomBytes(16).toString('hex');
    const slots = this.nonces.get(id) || [];
    slots.push({nonce, issuedAt: this.now()});
    while (slots.length > NONCE_SLOTS) slots.shift();
    this.nonces.set(id, slots);
    const record = this.devices.get(id);
    return {nonce, ttlMs: NONCE_TTL_MS, claimed: Boolean(record && record.secret), serverTime: this.now()};
  }

  consumeNonce(id, nonce) {
    const wanted = String(nonce || '').toLowerCase();
    const slots = this.nonces.get(id) || [];
    const index = slots.findIndex(slot => slot.nonce === wanted && this.now() - slot.issuedAt < NONCE_TTL_MS);
    if (index < 0) return false;
    slots.splice(index, 1);
    return true;
  }

  remember(id, {nonce, proof, info, authFailed}) {
    this.registrations.delete(id);
    this.registrations.set(id, {id, nonce, proof: String(proof || ''), info: normalizeReport(info), seenAt: this.now(), authFailed});
    while (this.registrations.size > MAX_REGISTRATIONS) this.registrations.delete(this.registrations.keys().next().value);
  }

  async login({id, nonce, proof, info = {}, ip}) {
    this.checkId(id);
    this.limit(id, ip);
    if (!this.consumeNonce(id, nonce)) throw new CloudError(401, 'nonce', 'Unknown, used or expired nonce; request a new challenge');
    const record = this.devices.get(id);
    if (!record || !record.secret) {
      this.remember(id, {nonce, proof, info, authFailed: false});
      throw new CloudError(403, 'unclaimed', 'This board has not been claimed in a dashboard yet');
    }
    const expected = proofHex(record.secret, {deviceId: id, nonce});
    const presented = String(proof || '').toLowerCase();
    if (presented.length !== 64 || !constantTimeEqual(expected, presented)) {
      this.remember(id, {nonce, proof, info, authFailed: true});
      this.devices.patchCloud(id, {lastAuthFailureAt: this.iso()});
      throw new CloudError(401, 'unauthorized', 'The pairing token does not match the one stored for this board');
    }
    const token = newSessionToken();
    const issuedAt = this.now();
    this.sessions.set(token, {deviceId: id, issuedAt, expiresAt: issuedAt + SESSION_TTL_MS});
    const mine = this.sessionsFor(id);
    while (mine.length > MAX_SESSIONS_PER_BOARD) this.sessions.delete(mine.shift());
    this.registrations.delete(id);
    const report = normalizeReport(info);
    const cloud = record.cloud || {};
    this.devices.upsert({id, suffix: record.suffix || id.slice(-6), demo: report.demo || record.demo || null,
                         firmware: report.fw || record.firmware, build: report.build || record.build,
                         cloud: {...cloud, registeredAt: cloud.registeredAt || this.iso(), verified: true, lastLoginAt: this.iso(),
                                 lastAuthFailureAt: null, agent: report.agent, lastSeenAt: this.iso(), lastReport: report}});
    this.lastPersist.set(id, issuedAt);
    this.log(`cloud: ${id} logged in (build ${report.build || '?'})`);
    return {session: token, expiresAt: issuedAt + SESSION_TTL_MS, pollMs: this.config.cloud.pollMs};
  }

  revokeSessions(id) {
    for (const token of this.sessionsFor(id)) this.sessions.delete(token);
  }

  sessionsFor(id) {
    return [...this.sessions.entries()].filter(([, s]) => s.deviceId === id).sort((a, b) => a[1].issuedAt - b[1].issuedAt).map(([token]) => token);
  }

  authenticate(header) {
    const match = /^Bearer\s+([0-9a-f]{48})$/i.exec(String(header || '').trim());
    const session = match ? this.sessions.get(match[1].toLowerCase()) : null;
    if (!session || this.now() >= session.expiresAt) {
      if (match) this.sessions.delete(match[1].toLowerCase());
      throw new CloudError(401, 'session', 'Session missing or expired; log in again');
    }
    return {deviceId: session.deviceId, session: match[1].toLowerCase()};
  }

  // Records a poll or status report: last seen now, last report replaced. The file is rewritten
  // at most every 30 s unless something the dashboard shows prominently changed.
  touch(id, info = {}) {
    const record = this.devices.get(id);
    if (!record) return null;
    const report = normalizeReport(info);
    const previous = (record.cloud && record.cloud.lastReport) || {};
    const changed = ['build', 'pending', 'safe', 'transferring'].some(key => previous[key] !== report[key]);
    const persist = changed || this.now() - (this.lastPersist.get(id) || 0) >= PERSIST_INTERVAL_MS;
    this.devices.patchCloud(id, {lastSeenAt: this.iso(), lastReport: report}, {persist});
    if (persist) this.lastPersist.set(id, this.now());
    return report;
  }

  // A contact that carries no identity (a status report): last seen only.
  seen(id) {
    const record = this.devices.get(id);
    if (!record) return;
    const persist = this.now() - (this.lastPersist.get(id) || 0) >= PERSIST_INTERVAL_MS;
    this.devices.patchCloud(id, {lastSeenAt: this.iso()}, {persist});
    if (persist) this.lastPersist.set(id, this.now());
  }

  isOnline(id) {
    const described = this.devices.describe(id);
    return Boolean(described && described.cloud.online);
  }

  pendingRegistrations() {
    for (const [id, entry] of this.registrations) if (this.now() - entry.seenAt > REGISTRATION_TTL_MS) this.registrations.delete(id);
    return [...this.registrations.values()].sort((a, b) => b.seenAt - a.seenAt).map(entry => ({
      id: entry.id, demo: entry.info.demo || null, fw: entry.info.fw, build: entry.info.build, app: entry.info.app, ver: entry.info.ver,
      slotSize: entry.info.slotSize, seenAt: this.iso(entry.seenAt), authFailed: entry.authFailed,
      claimed: Boolean(this.devices.get(entry.id) && this.devices.get(entry.id).secret),
    }));
  }

  // Binds a board to a principal. With a registration on file the token is checked against the
  // board's commitment immediately; otherwise it is checked at the board's next login.
  async claim({id, token, name = '', ownerId = null}) {
    this.checkId(id);
    const secret = String(token || '').trim();
    if (secret.length < 16) throw new CloudError(400, 'bad_request', 'The pairing token (OTA authorization code) is at least 16 characters');
    const existing = this.devices.get(id);
    if (existing && existing.ownerId != null && ownerId != null && existing.ownerId !== ownerId) {
      throw new CloudError(403, 'owned', 'This board belongs to another dashboard user');
    }
    const pending = this.registrations.get(id) || null;
    if (pending) {
      const expected = proofHex(secret, {deviceId: id, nonce: pending.nonce});
      if (!constantTimeEqual(expected, pending.proof.toLowerCase())) {
        throw new CloudError(400, 'token_mismatch', `The pairing token does not match the board that is online as ${id}; ` +
                             'check the OTA authorization code printed on its serial console');
      }
    }
    const previousCloud = (existing && existing.cloud) || {};
    const report = pending ? pending.info : previousCloud.lastReport || null;
    this.devices.upsert({
      id, suffix: (existing && existing.suffix) || id.slice(-6), demo: (report && report.demo) || (existing && existing.demo) || null,
      name: String(name || '').trim() || (existing && existing.name) || `Atech ${id.slice(-6)}`,
      firmware: (report && report.fw) || (existing && existing.firmware) || null, build: (report && report.build) || (existing && existing.build) || null,
      secret, ownerId, claimedAt: this.iso(),
      cloud: {...previousCloud, registeredAt: previousCloud.registeredAt || (pending ? this.iso(pending.seenAt) : null), verified: Boolean(pending),
              lastSeenAt: pending ? this.iso(pending.seenAt) : previousCloud.lastSeenAt || null, lastReport: report, lastAuthFailureAt: null},
    });
    if (pending) this.registrations.delete(id);
    this.log(`cloud: ${id} claimed by ${ownerId || 'anyone'}${pending ? ' (token verified against the online board)' : ' (waiting for the board)'}`);
    return this.devices.describe(id);
  }
}

module.exports = {CloudDeviceService, normalizeReport, NONCE_TTL_MS, SESSION_TTL_MS};
