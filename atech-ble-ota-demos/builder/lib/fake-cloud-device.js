'use strict';

// A Node simulation of the board's cloud OTA agent (shared/AtechCloudOta): the
// same login proof, bearer session, poll body, ranged download, image checks,
// status reports, reboot marker and acknowledgment handling, so the backend,
// the dashboard and the tests can exercise the whole cloud path without
// hardware. It is explicitly a SIMULATION: it proves protocol and state
// machine behaviour, never ESP32 radio, TLS or flash performance.
const crypto = require('node:crypto');
const {proofHex, parseKv} = require('./cloud-auth');

const DEVICE_MAX_FAILURES = 8;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateHeader(buf) {
  if (buf[0] !== 0xE9) return 'Not an ESP application image (bad magic byte)';
  if (buf.readUInt16LE(12) !== 9) return 'Firmware target is not ESP32-S3';
  if ((buf[3] >> 4) !== 4) return 'Firmware flash target is not the configured 16MB board';
  if (buf.readUInt32LE(32) !== 0xABCD5432) return 'Image is not an application firmware.bin (bootloader/merged images are rejected)';
  return null;
}

function createFakeCloudDevice({
  id = 'ATECH-A1B2C3D4E5F6', demo = 1, secret = 'fixture-ota-token-0123456789', baseUrl, build = 'stock', state = null,
  faults = {}, pollMs = 60, chunkBytes = 64 * 1024, log = () => {}, fetchImpl = globalThis.fetch, sync = null,
} = {}) {
  const shared = state || {};
  const defaults = {
    id, demo, build, previousBuild: null, app: 'blue default', ver: 1, fw: `simulated demo${demo} build ${build}`, slotSize: 0x600000,
    pending: false, safe: false, loops: 0, bootAt: Date.now(), confirmCount: 0, bootMarker: null, done: null, transferring: false, rebooting: false,
  };
  for (const [key, value] of Object.entries(defaults)) if (shared[key] === undefined) shared[key] = value;
  const device = {
    state: shared, faults, events: [], stats: {logins: 0, unclaimed: 0, authFailed: 0, polls: 0, downloads: 0, reports: 0, ranges: [], rollbacks: 0},
    session: null, running: false, loop: null, controller: null, sync,
  };
  const note = text => { device.events.push(text); log(text); };

  function identityBody(extra = {}) {
    const s = device.state;
    const up = Date.now() - s.bootAt;
    s.loops = s.safe ? 0 : Math.floor(up / 40);
    const body = {demo: String(s.demo), fw: s.fw, build: s.build, app: s.app, ver: String(s.ver), slot_size: String(s.slotSize), core: 'sim', agent: '1',
                  pending: s.pending ? '1' : '0', safe: s.safe ? '1' : '0', up: String(up), loops: String(s.loops), rssi: '-51',
                  heap: String(faults.heap || 180000), heap_min: String(faults.heap || 150000),
                  ...(device.sync ? {sync: JSON.stringify(device.sync.compact())} : {}), ...extra};
    return new URLSearchParams(body).toString();
  }

  async function call(method, path, {body = null, headers = {}} = {}) {
    device.controller = new AbortController();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method, body, redirect: 'manual', signal: device.controller.signal,
      headers: {...(body ? {'content-type': 'application/x-www-form-urlencoded'} : {}), ...(device.session ? {authorization: `Bearer ${device.session}`} : {}), ...headers},
    });
    return response;
  }

  async function login() {
    const challenge = await call('GET', `/api/device/challenge?id=${encodeURIComponent(id)}`);
    const kv = parseKv(await challenge.text());
    if (challenge.status !== 200 || !kv.nonce) throw new Error(`challenge failed: HTTP ${challenge.status}`);
    const proof = faults.wrongToken ? 'f'.repeat(64) : proofHex(secret, {deviceId: id, nonce: kv.nonce});
    const marker = device.state.bootMarker;
    const response = await call('POST', '/api/device/login', {
      body: `id=${encodeURIComponent(id)}&nonce=${kv.nonce}&proof=${proof}&` + identityBody(marker ? {boot_job: marker.job, boot_build: marker.build} : {}),
    });
    const result = parseKv(await response.text());
    if (response.status === 403 && result.code === 'unclaimed') { device.stats.unclaimed++; return false; }
    if (response.status === 401) { device.stats.authFailed++; note(`login refused: ${result.error}`); return false; }
    if (response.status !== 200 || !result.session) throw new Error(`login failed: HTTP ${response.status} ${result.error || ''}`);
    device.session = result.session;
    device.pollMs = Number(result.poll) || pollMs;
    device.stats.logins++;
    note('logged in');
    return true;
  }

  // faults.dropReports = {phase: count}: that many reports of the phase are "lost on the wire"
  // (never sent, treated as failed); Infinity loses them forever.
  async function report(job, phase, extra = {}) {
    const drops = faults.dropReports || {};
    if (drops[phase] > 0) { drops[phase] -= 1; device.stats.droppedReports = (device.stats.droppedReports || 0) + 1; return {ok: '0', dropped: '1', status: 0}; }
    const body = new URLSearchParams({phase, ...extra, heap: String(faults.heap || 180000), heap_min: String(faults.heap || 150000)}).toString();
    const response = await call('POST', `/api/device/jobs/${job}/status`, {body});
    device.stats.reports++;
    if (response.status === 401) device.session = null;
    return {...parseKv(await response.text()), status: response.status};
  }

  async function simulateReboot({newBuild = null, rollback = false} = {}) {
    const s = device.state;
    device.session = null;
    s.rebooting = true;
    note(`rebooting (${rollback ? 'rollback' : `into ${newBuild}`})`);
    await wait(faults.rebootMs || 100);
    s.bootAt = Date.now();
    s.loops = 0;
    if (rollback) {
      s.build = s.previousBuild || s.build;
      s.pending = false;
      s.safe = false;
    } else if (newBuild) {
      s.previousBuild = s.build;
      if (faults.rollbackOnReboot) { s.pending = false; }   // the bootloader returned to the previous image
      else { s.build = newBuild; s.pending = true; s.app = `app ${newBuild}`; s.ver += 1; s.safe = Boolean(faults.safeModeOnReboot); }
    }
    s.fw = `simulated demo${s.demo} build ${s.build}`;
    s.rebooting = false;
    note(`back online as build ${s.build}${s.pending ? ' (pending verification)' : ''}`);
  }

  async function runJob(job) {
    const s = device.state;
    const size = Number(job.size);
    if (Number(job.demo) !== s.demo) { await report(job.job, 'failed', {error: `Job is for Demo ${job.demo}; this board is Demo ${s.demo}`}); return; }
    if (job.job === s.done) { await report(job.job, 'failed', {error: 'Job already applied on this board'}); return; }
    s.transferring = true;
    device.stats.downloads = device.stats.downloads;   // counted per request below
    const data = Buffer.alloc(size);
    let received = 0;
    let failures = 0;
    let dropped = false;
    let headerChecked = false;
    const chunk = Math.min(chunkBytes, Number(job.chunk) || chunkBytes);
    try {
      while (received < size && device.running) {
        const end = Math.min(size, received + chunk) - 1;
        const range = `bytes=${received}-${end}`;
        device.stats.ranges.push(range);
        device.stats.downloads++;
        let response;
        try { response = await call('GET', job.url, {headers: {range}}); }
        catch (error) { if (!device.running) return; failures++; if (failures >= DEVICE_MAX_FAILURES) throw new Error(`download failed: ${error.message}`); continue; }
        if (response.status === 409 || response.status === 403 || response.status === 404 || response.status === 410) {
          const kv = parseKv(await response.text());
          throw new Error(`download refused: ${kv.error || `HTTP ${response.status}`}`);
        }
        if (response.status === 401) { device.session = null; await login(); continue; }
        if (response.status !== 206 && response.status !== 200) { failures++; if (failures >= DEVICE_MAX_FAILURES) throw new Error(`download failed: HTTP ${response.status}`); continue; }
        if (response.status === 200 && received !== 0) { received = 0; data.fill(0); headerChecked = false; }
        let bytes = Buffer.from(await response.arrayBuffer());
        if (faults.corruptChunks) { failures++; if (failures >= DEVICE_MAX_FAILURES) throw new Error('download failed: corrupt chunks'); continue; }
        if (faults.dropDownloadAfterBytes && !dropped && received + bytes.length > faults.dropDownloadAfterBytes) {
          bytes = bytes.subarray(0, faults.dropDownloadAfterBytes - received);
          dropped = true;
          failures++;
          note(`connection dropped at ${received + bytes.length} bytes`);
        }
        bytes.copy(data, received);
        received += bytes.length;
        if (!headerChecked && received >= 36) {
          const reason = validateHeader(data.subarray(0, 36));
          if (reason) throw new Error(reason);
          headerChecked = true;
        }
        await report(job.job, 'downloading', {received: String(received), total: String(size)});
        if (faults.vanishAfterPhase === 'downloading') { faults.offline = true; note('vanished during download'); return; }
      }
      if (!device.running) return;
      if (faults.shaMismatch) data[2048] ^= 0xFF;
      if (data.indexOf(`ATECH-OTA-APP-DEMO${s.demo}`, 0, 'latin1') < 0) throw new Error('Firmware belongs to a different Atech demo/target');
      if (data.indexOf(`ATECH-BUILD:${job.build}\0`, 0, 'latin1') < 0) throw new Error(`Image does not carry build id ${job.build}`);
      const targetAt = data.indexOf('ATECH-TARGET:', 0, 'latin1');
      if (targetAt >= 0) {
        const end = data.indexOf(0, targetAt + 13);
        const target = data.subarray(targetAt + 13, end < 0 ? targetAt + 33 : end).toString('latin1');
        if (target && target !== s.id) throw new Error(`Image was built for ${target}, not this board`);
      }
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      if (digest !== String(job.sha256).toLowerCase()) throw new Error('Image SHA-256 does not match the declared digest; inactive partition not selected');
      await report(job.job, 'installing', {received: String(size), total: String(size)});
      if (faults.vanishAfterPhase === 'installing') { faults.offline = true; return; }
      s.bootMarker = {job: job.job, build: job.build};
      await report(job.job, 'rebooting');
      s.transferring = false;
      if (faults.vanishAfterPhase === 'rebooting' || faults.noReboot) { faults.offline = true; note('never came back'); return; }
      await simulateReboot({newBuild: job.build});
    } catch (error) {
      s.transferring = false;
      if (!device.running) return;
      note(`job failed: ${error.message}`);
      try { await report(job.job, 'failed', {error: error.message, received: String(received), total: String(size)}); } catch { /* offline */ }
    } finally {
      s.transferring = false;
    }
  }

  async function handleAck(jobId, action) {
    const s = device.state;
    if (action === 'confirm') {
      if (s.safe) return;
      if (s.pending) { s.pending = false; s.confirmCount++; }
      // Like the firmware: the marker is cleared only once the backend has the success report,
      // so a lost report is repeated on the next poll instead of silently dropped.
      const answer = await report(jobId, 'succeeded', {build: s.build});
      if (answer.status !== 200) { note('success report lost; keeping the boot marker'); return; }
      s.done = jobId;
      s.bootMarker = null;
      note('boot confirmed');
    } else if (action === 'rollback') {
      device.stats.rollbacks++;
      s.bootMarker = null;
      await simulateReboot({rollback: true});
    } else {
      s.bootMarker = null;
    }
  }

  async function step() {
    if (faults.offline) { await wait(pollMs); return; }
    if (!device.session) {
      try { if (!(await login())) { await wait(pollMs * 2); return; } }
      catch (error) { if (device.running) note(`login error: ${error.message}`); await wait(pollMs * 2); return; }
    }
    const s = device.state;
    const marker = s.bootMarker;
    const ready = !faults.busy && !s.transferring;
    const body = identityBody({ready: ready ? '1' : '0', transferring: s.transferring ? '1' : '0', ...(marker ? {boot_job: marker.job, boot_build: marker.build} : {})});
    const response = await call('POST', '/api/device/poll', {body});
    if (response.status === 401) { device.session = null; return; }
    const kv = parseKv(await response.text());
    device.stats.polls++;
    if (kv.ack) await handleAck(kv.ack, kv.action);
    if (kv.sync && device.sync) { const result = device.sync.command(kv.sync, true); note(`sync command from the cloud: ${result.ok ? 'ok' : result.error}`); }
    if (kv.job && ready) await runJob(kv);
    await wait(Number(kv.poll) > 0 ? Math.min(Number(kv.poll), pollMs) : pollMs);
  }

  device.start = () => {
    if (device.running) return;
    device.running = true;
    device.loop = (async () => {
      while (device.running) {
        try { await step(); } catch (error) { if (device.running) { note(`error: ${error.message}`); await wait(pollMs); } }
      }
    })();
  };
  device.stop = async () => {
    device.running = false;
    try { device.controller?.abort(); } catch { /* ignore */ }
    if (device.loop) await device.loop;
  };
  device.waitFor = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (predicate()) return true; await wait(20); }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${predicate.toString().slice(0, 120)}`);
  };
  return device;
}

module.exports = {createFakeCloudDevice, validateHeader};
