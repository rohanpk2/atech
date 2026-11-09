'use strict';

// Registry of boards the backend may deploy to over the LAN. Pairing proves
// knowledge of the board's OTA authorization code with an HMAC echo (the code
// itself never travels); the code is then stored here (mode 0600) so later
// deployments need no typing. Nothing in this file touches the browser.
const fs = require('node:fs');
const path = require('node:path');
const {loadConfig} = require('./config');
const mdns = require('./mdns');
const {request} = require('./lan-client');
const {controlMessage, syncMessage, hmacHex, CONTROL_OPS} = require('./lan-auth');

const DEVICE_ID = /^ATECH-[0-9A-F]{12}$/;
const PROBE_TIMEOUT_MS = 2500;
const DEFAULT_PORT = 8080;
const LAN_ONLINE_MS = 20000;
const DEFAULT_OFFLINE_AFTER_MS = 45000;

// A record is reachable by its owner, by everyone when it has no owner (simulated boards,
// records from before ownership existed), and by a caller that presents no principal at all.
function canAccess(record, ownerId) {
  return !record || record.ownerId == null || ownerId == null || record.ownerId === ownerId;
}

// Identity shaped like a LAN probe answer, built from the board's last cloud report so the
// dashboard shows the same facts whichever way the board is reachable.
function cloudIdentity(record) {
  const r = (record.cloud && record.cloud.lastReport) || null;
  if (!r) return null;
  return {
    id: record.id, suffix: record.suffix || record.id.slice(-6), demo: Number(r.demo || record.demo || 0), fw: r.fw || record.firmware || '',
    build: r.build || record.build || '', app: r.app || '', ver: Number(r.ver || 0), slotSize: Number(r.slotSize || 0), pending: Boolean(r.pending),
    canRollback: false, safe: Boolean(r.safe), appState: r.safe ? 'disabled' : 'running', loops: Number(r.loops || 0), up: Number(r.up || 0),
    otaOwner: r.transferring ? 'cloud' : '', target: '', paired: true, source: 'cloud', heap: Number(r.heap || 0), heapMin: Number(r.heapMin || 0),
    sync: r.sync || null,
    wifi: {ssid: '', ip: '', rssi: Number(r.rssi || 0), hostname: '', mdns: '', port: 0, connected: true, transferring: Boolean(r.transferring),
           lastTransferError: '', lastTransferMs: 0},
  };
}

function publicRecord(record, extra = {}) {
  const {secret, ...rest} = record;
  return {...rest, paired: Boolean(secret), ...extra};
}

function summarizeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const net = identity.net || {};
  return {
    id: identity.id, suffix: identity.suffix, demo: Number(identity.demo), fw: identity.fw, build: identity.build,
    app: identity.app, ver: Number(identity.ver || 0), slotSize: Number(identity.slotSize || 0), pending: Boolean(identity.pending),
    canRollback: Boolean(identity.canRollback), safe: Boolean(identity.safe), appState: identity.appState, loops: Number(identity.loops || 0),
    up: Number(identity.up || 0), otaOwner: identity.otaOwner || '', target: identity.target || '', paired: identity.paired !== false,
    sync: identity.sync && typeof identity.sync === 'object' ? identity.sync : null,
    wifi: {ssid: net.ssid || '', ip: net.ip || '', rssi: Number(net.rssi || 0), hostname: net.hostname || '', mdns: net.mdns || '',
           port: Number(net.port || DEFAULT_PORT), connected: Boolean(net.connected), transferring: Boolean(net.transferring),
           lastTransferError: net.last_transfer_error || '', lastTransferMs: Number(net.last_transfer_ms || 0)},
  };
}

class DeviceRegistry {
  constructor({config = loadConfig(), deps = {}} = {}) {
    this.config = config;
    this.deps = {discover: mdns.discover, resolveHost: mdns.resolveHost, request, now: Date.now, ...deps};
    this.file = path.join(config.buildsDir, 'devices.json');
    this.devices = new Map();
    this.live = new Map();   // id -> {identity, at, error}
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const record of data.devices || []) if (record && DEVICE_ID.test(record.id)) this.devices.set(record.id, record);
    } catch { /* first run */ }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const data = {version: 1, devices: [...this.devices.values()]};
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), {mode: 0o600});
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  // Records the given principal may see; no principal lists everything.
  list(ownerId = null) {
    return [...this.devices.values()].filter(record => canAccess(record, ownerId)).map(record => this.describe(record.id));
  }

  canAccess(id, ownerId) { return canAccess(this.devices.get(id) || null, ownerId); }

  offlineAfterMs() { return (this.config.cloud && this.config.cloud.offlineAfterMs) || DEFAULT_OFFLINE_AFTER_MS; }

  describe(id) {
    const record = this.devices.get(id);
    if (!record) return null;
    const now = this.deps.now();
    const live = this.live.get(id) || null;
    const lanOnline = Boolean(live && live.identity && now - live.at < LAN_ONLINE_MS);
    const cloud = record.cloud || null;
    const lastSeenMs = cloud && cloud.lastSeenAt ? Date.parse(cloud.lastSeenAt) : NaN;
    const cloudOnline = Boolean(cloud && Number.isFinite(lastSeenMs) && now - lastSeenMs < this.offlineAfterMs());
    const identity = lanOnline ? live.identity : (cloud && cloud.lastReport) ? cloudIdentity(record) : (live ? live.identity : null);
    return publicRecord(record, {
      online: lanOnline || cloudOnline,
      via: lanOnline ? 'lan' : cloudOnline ? 'cloud' : null,
      identity,
      lastProbeAt: live ? new Date(live.at).toISOString() : null,
      lastProbeError: live ? live.error : null,
      cloud: {
        registered: Boolean(cloud && (cloud.registeredAt || cloud.lastSeenAt)),
        online: cloudOnline,
        lastSeenAt: cloud ? cloud.lastSeenAt || null : null,
        lastReport: cloud ? cloud.lastReport || null : null,
        lastAuthFailureAt: cloud ? cloud.lastAuthFailureAt || null : null,
        verified: cloud ? cloud.verified !== false : null,
      },
    });
  }

  // Merges cloud bookkeeping into a record; persistence is optional so frequent polls do not
  // rewrite the file every time.
  patchCloud(id, patch, {persist = true} = {}) {
    const record = this.devices.get(id);
    if (!record) return null;
    record.cloud = {...(record.cloud || {}), ...patch};
    if (persist) this.persist();
    return record;
  }

  get(id) { return this.devices.get(id) || null; }

  secret(id) { return (this.devices.get(id) || {}).secret || null; }

  remove(id) {
    const existed = this.devices.delete(id);
    this.live.delete(id);
    if (existed) this.persist();
    return existed;
  }

  upsert(record) {
    const existing = this.devices.get(record.id) || {};
    const merged = {...existing, ...record, updatedAt: new Date().toISOString()};
    if (!merged.createdAt) merged.createdAt = merged.updatedAt;
    this.devices.set(record.id, merged);
    this.persist();
    return merged;
  }

  // Reads /api/identity from a host; records the result when the id is registered.
  async probe({host, port = DEFAULT_PORT, id = null, timeoutMs = PROBE_TIMEOUT_MS}) {
    let identity = null;
    let error = null;
    try {
      const response = await this.deps.request({host, port, path: '/api/identity', timeoutMs});
      if (response.status !== 200 || !response.json || !DEVICE_ID.test(response.json.id)) {
        throw new Error(`${host}:${port} answered but is not an Atech board (HTTP ${response.status})`);
      }
      identity = summarizeIdentity(response.json);
    } catch (caught) {
      error = caught.message;
    }
    const target = identity ? identity.id : id;
    if (target && this.devices.has(target)) {
      this.live.set(target, {identity, at: Date.now(), error});
      if (identity) {
        const record = this.devices.get(target);
        const patch = {host, port, lastSeenAt: new Date().toISOString(), firmware: identity.fw, build: identity.build,
                       demo: identity.demo, suffix: identity.suffix, hostname: identity.wifi.hostname};
        if (Object.entries(patch).some(([key, value]) => record[key] !== value)) this.upsert({id: target, ...patch});
      }
    }
    if (error) throw new Error(error);
    return identity;
  }

  // Probes every registered device, re-resolving by mDNS when the last host is silent.
  async refresh({timeoutMs = PROBE_TIMEOUT_MS} = {}) {
    const results = [];
    let discovered = null;
    for (const record of this.devices.values()) {
      // A board known only through the cloud has no LAN address; probing or mDNS would only
      // add timeouts (and on a cloud host they can never answer).
      if (!record.host && !record.hostname) { results.push(this.describe(record.id)); continue; }
      let identity = null;
      let error = null;
      if (record.host) {
        try { identity = await this.probe({host: record.host, port: record.port || DEFAULT_PORT, id: record.id, timeoutMs}); }
        catch (caught) { error = caught.message; }
      }
      if (!identity) {
        if (!discovered) { try { discovered = await this.deps.discover({timeoutMs: 1200}); } catch { discovered = []; } }
        const match = discovered.find(entry => entry.txt && entry.txt.id === record.id && entry.addresses.length);
        if (match) {
          try { identity = await this.probe({host: match.addresses[0], port: match.port || DEFAULT_PORT, id: record.id, timeoutMs}); error = null; }
          catch (caught) { error = caught.message; }
        } else if (record.hostname) {
          const address = await this.deps.resolveHost(`${record.hostname}.local`, 1500);
          if (address && address !== record.host) {
            try { identity = await this.probe({host: address, port: record.port || DEFAULT_PORT, id: record.id, timeoutMs}); error = null; }
            catch (caught) { error = caught.message; }
          }
        }
        if (!identity) this.live.set(record.id, {identity: null, at: Date.now(), error: error || 'Not found on the network'});
      }
      results.push(this.describe(record.id));
    }
    return results;
  }

  // mDNS scan merged with the registry so the dashboard can show "pair" or "online".
  async discover({timeoutMs = 1500} = {}) {
    const found = await this.deps.discover({timeoutMs});
    const out = [];
    for (const entry of found) {
      const txt = entry.txt || {};
      const host = entry.addresses[0] || null;
      const port = entry.port || DEFAULT_PORT;
      let identity = null;
      let error = null;
      if (host) {
        try { identity = await this.probe({host, port, id: txt.id || null, timeoutMs: PROBE_TIMEOUT_MS}); }
        catch (caught) { error = caught.message; }
      }
      const id = (identity && identity.id) || txt.id || null;
      out.push({id, suffix: (identity && identity.suffix) || txt.suffix || null, demo: identity ? identity.demo : Number(txt.demo || 0) || null,
                host, port, hostname: entry.host ? entry.host.replace(/\.local$/, '') : null, instance: entry.instance,
                firmware: identity ? identity.fw : txt.fw || null, build: identity ? identity.build : null,
                paired: Boolean(id && this.secret(id)), identity, error});
    }
    return out;
  }

  async challenge({host, port}) {
    const response = await this.deps.request({host, port, path: '/api/ota/challenge', timeoutMs: PROBE_TIMEOUT_MS});
    if (response.status !== 200 || !response.json || !response.json.nonce) {
      throw new Error(`Board did not issue a challenge (HTTP ${response.status})`);
    }
    return response.json;
  }

  // Sends an authenticated control operation with the given secret.
  async controlWithSecret({host, port, deviceId, secret, op}) {
    if (!CONTROL_OPS.includes(op)) throw new Error(`Unsupported control operation ${op}`);
    const challenge = await this.challenge({host, port});
    if (challenge.device && challenge.device !== deviceId) {
      throw new Error(`${host}:${port} is ${challenge.device}, not ${deviceId}`);
    }
    const auth = hmacHex(secret, controlMessage({deviceId, nonce: challenge.nonce, op}));
    const response = await this.deps.request({host, port, method: 'POST', path: '/api/control', timeoutMs: PROBE_TIMEOUT_MS, headers: {
      'X-Atech-Device': deviceId, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Op': op, 'X-Atech-Auth': auth,
    }});
    if (response.status === 401) throw new Error('The board rejected the OTA authorization code');
    if (response.status !== 200 || !response.json) throw new Error((response.json && response.json.error) || `Control ${op} failed (HTTP ${response.status})`);
    return response.json;
  }

  // Relays a board-to-board sync command (form body) to the board's LAN service, signed with the
  // pairing token, and returns the board's JSON answer ({ok, code} or {ok: false, error}).
  async sync(id, form) {
    const record = this.devices.get(id);
    if (!record) throw new Error(`Unknown device ${id}`);
    if (!record.secret) throw new Error(`${id} is not paired`);
    if (!record.host) throw new Error(`${id} has no known address; find it first`);
    const host = record.host;
    const port = record.port || DEFAULT_PORT;
    const body = String(form);
    const challenge = await this.challenge({host, port});
    if (challenge.device && challenge.device !== id) throw new Error(`${host}:${port} is ${challenge.device}, not ${id}`);
    const auth = hmacHex(record.secret, syncMessage({deviceId: id, nonce: challenge.nonce, body}));
    const response = await this.deps.request({host, port, method: 'POST', path: '/api/sync', timeoutMs: PROBE_TIMEOUT_MS, body: Buffer.from(body, 'utf8'), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'X-Atech-Device': id, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Auth': auth,
    }});
    if (response.status === 401) throw new Error('The board rejected the OTA authorization code');
    if (response.status !== 200 || !response.json) throw new Error((response.json && response.json.error) || `Sync command failed (HTTP ${response.status})`);
    return response.json;
  }

  async control(id, op) {
    const record = this.devices.get(id);
    if (!record) throw new Error(`Unknown device ${id}`);
    if (!record.secret) throw new Error(`${id} is not paired`);
    if (!record.host) throw new Error(`${id} has no known address; find it first`);
    return this.controlWithSecret({host: record.host, port: record.port || DEFAULT_PORT, deviceId: id, secret: record.secret, op});
  }

  // Pairs a board: probe its identity, prove the code with an HMAC echo, store it.
  async pair({host, port = DEFAULT_PORT, token, name = '', ownerId = null}) {
    const secret = String(token || '').trim();
    if (secret.length < 16) throw new Error('The OTA authorization code is at least 16 characters (printed on the serial console at boot)');
    if (!host) throw new Error('A host or IP address is required');
    const response = await this.deps.request({host, port, path: '/api/identity', timeoutMs: PROBE_TIMEOUT_MS});
    if (response.status !== 200 || !response.json || !DEVICE_ID.test(response.json.id)) {
      throw new Error(`${host}:${port} is not an Atech board running the LAN service`);
    }
    const identity = summarizeIdentity(response.json);
    const echo = await this.controlWithSecret({host, port, deviceId: identity.id, secret, op: 'echo'});
    if (!echo.ok) throw new Error('The board did not accept the echo');
    const record = this.upsert({id: identity.id, suffix: identity.suffix, demo: identity.demo, name: name || `Atech ${identity.suffix}`,
                                host, port, hostname: identity.wifi.hostname, firmware: identity.fw, build: identity.build,
                                secret, ownerId, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString()});
    this.live.set(record.id, {identity, at: Date.now(), error: null});
    return this.describe(record.id);
  }
}

module.exports = {DeviceRegistry, summarizeIdentity, canAccess, cloudIdentity, DEVICE_ID, DEFAULT_PORT, PROBE_TIMEOUT_MS};
