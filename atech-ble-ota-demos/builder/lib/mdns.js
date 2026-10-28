'use strict';

// Dependency-free mDNS (RFC 6762) querier for the board's _atech-ota._tcp
// service. Sends one multicast PTR query per interface and collects the
// PTR/SRV/TXT/A records that come back within the timeout.
const dgram = require('node:dgram');
const dns = require('node:dns');
const os = require('node:os');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_atech-ota._tcp.local';
const TYPE = {A: 1, PTR: 12, TXT: 16, SRV: 33};

function encodeName(name) {
  const parts = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildQuery(name, {unicastResponse = false} = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);  // id
  header.writeUInt16BE(0, 2);  // flags: standard query
  header.writeUInt16BE(1, 4);  // qdcount
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE.PTR, 0);
  question.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2);
  return Buffer.concat([header, encodeName(name), question]);
}

// Reads a (possibly compressed) name. Returns {name, next}.
function readName(buf, offset, depth = 0) {
  const labels = [];
  let next = null;
  let pos = offset;
  for (let hops = 0; hops < 64; hops++) {
    if (pos >= buf.length) throw new Error('truncated name');
    const len = buf[pos];
    if (len === 0) { pos += 1; break; }
    if ((len & 0xC0) === 0xC0) {
      if (pos + 1 >= buf.length) throw new Error('truncated pointer');
      const pointer = ((len & 0x3F) << 8) | buf[pos + 1];
      if (next === null) next = pos + 2;
      if (depth > 8) throw new Error('pointer loop');
      const target = readName(buf, pointer, depth + 1);
      labels.push(target.name);
      return {name: labels.filter(Boolean).join('.'), next};
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
  }
  return {name: labels.join('.'), next: next === null ? pos : next};
}

function parseTxt(data) {
  const txt = {};
  let pos = 0;
  while (pos < data.length) {
    const len = data[pos];
    const entry = data.subarray(pos + 1, pos + 1 + len).toString('utf8');
    pos += 1 + len;
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq < 0) txt[entry] = '';
    else txt[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return txt;
}

function parseResponse(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);
  let pos = 12;
  try {
    for (let i = 0; i < qd; i++) {
      const {next} = readName(buf, pos);
      pos = next + 4;
    }
  } catch { return []; }
  const records = [];
  for (let i = 0; i < an + ns + ar; i++) {
    if (pos >= buf.length) break;
    const {name, next} = readName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const ttl = buf.readUInt32BE(pos + 4);
    const rdlength = buf.readUInt16BE(pos + 8);
    const rdata = buf.subarray(pos + 10, pos + 10 + rdlength);
    const rdataOffset = pos + 10;
    pos += 10 + rdlength;
    const record = {name: name.toLowerCase(), type, ttl};
    try {
      if (type === TYPE.PTR) record.ptr = readName(buf, rdataOffset).name.toLowerCase();
      else if (type === TYPE.SRV) {
        record.port = rdata.readUInt16BE(4);
        record.target = readName(buf, rdataOffset + 6).name.toLowerCase();
      } else if (type === TYPE.TXT) record.txt = parseTxt(rdata);
      else if (type === TYPE.A && rdlength === 4) record.address = [...rdata].join('.');
      else continue;
    } catch { continue; }
    records.push(record);
  }
  return records;
}

function ipv4Interfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push({name, address: iface.address});
    }
  }
  return out;
}

// Assembles service instances from a bag of records.
function assemble(records, service = SERVICE) {
  const instances = new Map();
  const srv = new Map();
  const txt = new Map();
  const addresses = new Map();
  for (const record of records) {
    if (record.type === TYPE.PTR && record.name === service) instances.set(record.ptr, true);
    else if (record.type === TYPE.SRV) srv.set(record.name, record);
    else if (record.type === TYPE.TXT) txt.set(record.name, record.txt);
    else if (record.type === TYPE.A) {
      if (!addresses.has(record.name)) addresses.set(record.name, new Set());
      addresses.get(record.name).add(record.address);
    }
  }
  const found = [];
  for (const instance of instances.keys()) {
    const service_ = srv.get(instance);
    const host = service_ ? service_.target : null;
    found.push({
      instance: instance.replace(`.${service}`, ''),
      host, port: service_ ? service_.port : null,
      addresses: host && addresses.has(host) ? [...addresses.get(host)] : [],
      txt: txt.get(instance) || {},
    });
  }
  return found;
}

async function resolveHost(hostname, timeoutMs = 2000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    dns.lookup(hostname, {family: 4}, (error, address) => { clearTimeout(timer); resolve(error ? null : address); });
  });
}

// Discovers service instances. Resolves to [{instance, host, port, addresses, txt}].
async function discover({service = SERVICE, timeoutMs = 1500, interfaces = ipv4Interfaces(), bindPort = MDNS_PORT} = {}) {
  const records = [];
  const sockets = [];
  const open = (port, address) => new Promise(resolve => {
    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    socket.on('error', () => resolve(null));
    socket.on('message', message => { try { records.push(...parseResponse(message)); } catch { /* ignore */ } });
    socket.bind(port, address, () => {
      try { socket.setMulticastTTL(255); } catch { /* ignore */ }
      resolve(socket);
    });
  });
  // One socket per interface so the query leaves on every LAN; a bind failure
  // on 5353 (another responder without SO_REUSEPORT) falls back to an
  // ephemeral port with a legacy unicast-response query.
  const targets = interfaces.length ? interfaces : [{name: 'any', address: '0.0.0.0'}];
  for (const iface of targets) {
    let socket = await open(bindPort, '0.0.0.0');
    let legacy = false;
    if (!socket) { socket = await open(0, '0.0.0.0'); legacy = true; }
    if (!socket) continue;
    try { socket.addMembership(MDNS_GROUP, iface.address); } catch { /* interface may not support multicast */ }
    try { socket.setMulticastInterface(iface.address); } catch { /* ignore */ }
    sockets.push(socket);
    const query = buildQuery(service, {unicastResponse: legacy});
    const send = () => socket.send(query, 0, query.length, MDNS_PORT, MDNS_GROUP, () => {});
    send();
    setTimeout(send, Math.min(400, timeoutMs / 3));
  }
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
  for (const socket of sockets) { try { socket.close(); } catch { /* ignore */ } }
  const found = assemble(records, service);
  for (const entry of found) {
    if (!entry.addresses.length && entry.host) {
      const address = await resolveHost(entry.host, 1000);
      if (address) entry.addresses.push(address);
    }
  }
  return found;
}

module.exports = {discover, resolveHost, parseResponse, assemble, buildQuery, encodeName, readName, parseTxt, SERVICE, TYPE, ipv4Interfaces};
