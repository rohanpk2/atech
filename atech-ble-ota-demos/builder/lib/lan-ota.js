'use strict';

// LAN deployments: stream a validated build to a paired board over the user's
// Wi-Fi network, wait for the reboot, verify the new image is running and
// confirm it (cancelling the bootloader rollback). Every phase and timing is
// pushed to subscribers so the dashboard can show real progress.
const crypto = require('node:crypto');
const fs = require('node:fs');
const {loadConfig} = require('./config');
const {request, keepAliveAgent} = require('./lan-client');
const {beginMessage, hmacHex, sha256Hex} = require('./lan-auth');
const {DEFAULT_PORT} = require('./devices');

const STATES = ['queued', 'preflight', 'uploading', 'finishing', 'rebooting', 'verifying', 'confirming', 'verified', 'failed', 'aborted'];
const DEFAULT_CHUNK = 128 * 1024;
const REBOOT_WAIT_MS = 60000;
const LOOP_WAIT_MS = 12000;
const PROGRESS_INTERVAL_MS = 150;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class DeploymentStore {
  constructor({config = loadConfig(), jobs, devices, deps = {}} = {}) {
    this.config = config;
    this.jobs = jobs;
    this.devices = devices;
    this.deps = {request, keepAliveAgent, delay, readFirmware: file => fs.readFileSync(file), ...deps};
    this.deployments = new Map();
    this.subscribers = new Map();
    this.chunkBytes = Number(config.lanChunkBytes) || DEFAULT_CHUNK;
    this.rebootWaitMs = Number(config.lanRebootWaitMs) || REBOOT_WAIT_MS;
    this.loopWaitMs = Number(config.lanLoopWaitMs) || LOOP_WAIT_MS;
    this.active = null;
  }

  list() {
    return [...this.deployments.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20).map(d => this.snapshot(d));
  }

  get(id) {
    const deployment = this.deployments.get(id);
    return deployment ? this.snapshot(deployment) : null;
  }

  snapshot(deployment) {
    return JSON.parse(JSON.stringify(deployment));
  }

  subscribe(id, fn) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(fn);
    return () => this.subscribers.get(id)?.delete(fn);
  }

  update(deployment, patch) {
    Object.assign(deployment, patch, {updatedAt: new Date().toISOString()});
    const snapshot = this.snapshot(deployment);
    for (const fn of this.subscribers.get(deployment.id) || []) {
      try { fn(snapshot); } catch { /* subscriber errors never break a deployment */ }
    }
  }

  create({jobId, deviceId}) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown build ${jobId}`);
    if (job.state !== 'ready' || !job.firmware) throw new Error(`Build ${job.buildId} is ${job.state}; only a ready build can be deployed`);
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`Unknown device ${deviceId}; find and pair it first`);
    if (!record.secret) throw new Error(`${deviceId} is not paired; enter its OTA authorization code first`);
    if (job.deviceId && job.deviceId !== deviceId) throw new Error(`Build ${job.buildId} is bound to ${job.deviceId}, not ${deviceId}`);
    if (this.active && !['verified', 'failed', 'aborted'].includes(this.active.state)) {
      throw new Error(`Deployment ${this.active.id} is still running; wait for it or abort it`);
    }
    const now = new Date().toISOString();
    const deployment = {
      id: crypto.randomBytes(5).toString('hex'), jobId, buildId: job.buildId, appName: job.appName, appVersion: job.appVersion,
      demo: job.demo, deviceId, transport: 'wifi', state: 'queued', stage: 'Queued', total: job.firmware.size, sent: 0, acked: 0,
      percent: 0, speedBps: 0, etaMs: null, timings: {}, checks: [], error: null, host: record.host, port: record.port || DEFAULT_PORT,
      abortRequested: false, createdAt: now, updatedAt: now, finishedAt: null,
    };
    this.deployments.set(deployment.id, deployment);
    this.active = deployment;
    return this.snapshot(deployment);
  }

  abort(id) {
    const deployment = this.deployments.get(id);
    if (!deployment) return null;
    if (['verified', 'failed', 'aborted'].includes(deployment.state)) return this.snapshot(deployment);
    deployment.abortRequested = true;
    this.update(deployment, {stage: 'Abort requested; stopping safely'});
    return this.snapshot(deployment);
  }

  run(id) {
    const deployment = this.deployments.get(id);
    if (!deployment) return Promise.reject(new Error(`Unknown deployment ${id}`));
    return this.execute(deployment).then(() => this.snapshot(deployment));
  }

  fail(deployment, error, extra = {}) {
    this.update(deployment, {state: 'failed', stage: 'Failed', error: error.message || String(error), finishedAt: new Date().toISOString(), ...extra});
    this.jobs.recordDeployment(deployment.jobId, {deviceId: deployment.deviceId, result: 'failed', detail: deployment.error, transport: 'wifi'});
  }

  async execute(deployment) {
    const startedAt = Date.now();
    const {request: send} = this.deps;
    const device = this.devices.get(deployment.deviceId);
    const secret = device.secret;
    let host = deployment.host;
    let port = deployment.port;
    let agent = null;
    let session = null;
    const abortIfRequested = () => { if (deployment.abortRequested) throw Object.assign(new Error('Aborted before the next chunk'), {aborted: true}); };
    try {
      // ---- preflight ----
      this.update(deployment, {state: 'preflight', stage: 'Checking the board and the build'});
      const job = this.jobs.get(deployment.jobId);
      const file = this.jobs.firmwarePath(deployment.jobId);
      if (!file) throw new Error('The build artifact is no longer available');
      const image = this.deps.readFirmware(file);
      if (image.length !== job.firmware.size) throw new Error('Firmware size on disk does not match the build record');
      const digest = sha256Hex(image);
      if (job.firmware.sha256 && job.firmware.sha256 !== digest) throw new Error('Firmware digest on disk does not match the build record');
      let identity = null;
      try { identity = await this.devices.probe({host, port, id: deployment.deviceId}); }
      catch (error) {
        const refreshed = await this.devices.refresh();
        const entry = refreshed.find(d => d.id === deployment.deviceId);
        if (!entry || !entry.identity) throw new Error(`${deployment.deviceId} is not reachable over Wi-Fi (${error.message})`);
        identity = entry.identity;
        host = this.devices.get(deployment.deviceId).host;
        port = this.devices.get(deployment.deviceId).port || DEFAULT_PORT;
        this.update(deployment, {host, port});
      }
      if (identity.id !== deployment.deviceId) throw new Error(`${host} is ${identity.id}, not ${deployment.deviceId}`);
      if (identity.demo !== deployment.demo) throw new Error(`This build is for Demo ${deployment.demo}; ${identity.id} runs Demo ${identity.demo}`);
      if (image.length > identity.slotSize) throw new Error(`The image (${image.length} bytes) is larger than the board's OTA slot (${identity.slotSize} bytes)`);
      if (identity.otaOwner) throw new Error(`The board's flash is owned by the ${identity.otaOwner} updater; wait for it to finish`);
      const preflightChecks = [`board ${identity.id} reachable at ${host}:${port}`, `Demo ${identity.demo} matches`, `image fits the ${identity.slotSize}-byte slot`];
      const preflightAt = Date.now();
      this.update(deployment, {checks: preflightChecks, timings: {...deployment.timings, preflightMs: Date.now() - startedAt},
                               before: {build: identity.build, fw: identity.fw, pending: identity.pending, up: identity.up}});
      abortIfRequested();

      // ---- challenge + begin ----
      const challenge = await this.devices.challenge({host, port});
      if (challenge.device && challenge.device !== deployment.deviceId) throw new Error(`${host} answered as ${challenge.device}`);
      const auth = hmacHex(secret, beginMessage({deviceId: deployment.deviceId, nonce: challenge.nonce, size: image.length,
                                                 sha256: digest, buildId: deployment.buildId}));
      const beginAt = Date.now();
      const begin = await send({host, port, method: 'POST', path: '/api/ota/begin', timeoutMs: 20000, headers: {
        'X-Atech-Device': deployment.deviceId, 'X-Atech-Nonce': challenge.nonce, 'X-Atech-Size': String(image.length),
        'X-Atech-SHA256': digest, 'X-Atech-Build': deployment.buildId, 'X-Atech-Auth': auth,
      }});
      if (begin.status !== 200 || !begin.json || !begin.json.session) {
        const detail = (begin.json && begin.json.error) || `HTTP ${begin.status}`;
        if (begin.status === 401) throw new Error(`The board rejected the pairing (${detail}). Re-pair with the current OTA authorization code.`);
        throw new Error(`The board refused to start the update: ${detail}`);
      }
      session = begin.json.session;
      const chunkBytes = Math.max(4096, Math.min(this.chunkBytes, Number(begin.json.chunk_max) || this.chunkBytes));
      this.update(deployment, {timings: {...deployment.timings, beginMs: Date.now() - beginAt, eraseMs: Number(begin.json.erase_ms) || 0},
                               partition: begin.json.partition || null, chunkBytes});

      // ---- upload ----
      agent = this.deps.keepAliveAgent();
      this.update(deployment, {state: 'uploading', stage: 'Transferring firmware over Wi-Fi'});
      const transferStart = Date.now();
      let lastProgress = 0;
      for (let offset = 0; offset < image.length;) {
        abortIfRequested();
        const chunk = image.subarray(offset, Math.min(image.length, offset + chunkBytes));
        const response = await send({host, port, method: 'PUT', path: `/api/ota/chunk?offset=${offset}`, body: chunk, agent, timeoutMs: 30000,
                                     headers: {'X-Atech-Session': session, 'Content-Type': 'application/octet-stream'}});
        if (response.status !== 200 || !response.json || !response.json.ok) {
          throw new Error(`Chunk at ${offset} rejected: ${(response.json && response.json.error) || `HTTP ${response.status}`}`);
        }
        offset = Number(response.json.received);
        const elapsed = Math.max(1, Date.now() - transferStart);
        const speed = offset * 1000 / elapsed;
        const patch = {acked: offset, sent: offset, percent: Math.floor(offset * 100 / image.length), speedBps: speed,
                       etaMs: speed > 0 ? Math.round((image.length - offset) / speed * 1000) : null};
        if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS || offset === image.length) { lastProgress = Date.now(); this.update(deployment, patch); }
        else Object.assign(deployment, patch);
      }
      const transferMs = Date.now() - transferStart;
      this.update(deployment, {percent: 100, acked: image.length, sent: image.length, etaMs: 0,
                               speedBps: image.length * 1000 / Math.max(1, transferMs),
                               timings: {...deployment.timings, transferMs}});

      // ---- finish ----
      this.update(deployment, {state: 'finishing', stage: 'Board is verifying the image'});
      const finishAt = Date.now();
      const finish = await send({host, port, method: 'POST', path: '/api/ota/finish', agent, timeoutMs: 45000,
                                 headers: {'X-Atech-Session': session}});
      session = null;
      if (finish.status !== 200 || !finish.json || !finish.json.ok) {
        throw new Error(`The board rejected the image: ${(finish.json && finish.json.error) || `HTTP ${finish.status}`}`);
      }
      if (finish.json.sha256 && finish.json.sha256 !== digest) throw new Error('The board reports a different image digest than the build');
      this.update(deployment, {checks: [...deployment.checks, `board verified SHA-256 ${digest.slice(0, 12)} and the ESP image`],
                               timings: {...deployment.timings, finishMs: Date.now() - finishAt,
                                         deviceTransferMs: Number(finish.json.transfer_ms) || null, deviceVerifyMs: Number(finish.json.verify_ms) || null}});
      try { agent.destroy(); } catch { /* ignore */ }
      agent = null;

      // ---- reboot ----
      this.update(deployment, {state: 'rebooting', stage: 'Board is rebooting into the new firmware'});
      const rebootStart = Date.now();
      await this.deps.delay((Number(finish.json.reboot_in_ms) || 1500) + 1200);
      let rebooted = null;
      let lastError = 'no answer yet';
      const deadline = rebootStart + this.rebootWaitMs;
      let rediscoverAt = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          rebooted = await this.devices.probe({host, port, id: deployment.deviceId, timeoutMs: 1500});
          // Only a fresh boot counts: had the board not restarted, its uptime
          // would have kept growing from the value seen at preflight.
          const expectedIfNotRebooted = identity.up + (Date.now() - preflightAt);
          if (rebooted && rebooted.up + 200 < expectedIfNotRebooted) break;
          lastError = `still running the previous boot (uptime ${rebooted ? Math.round(rebooted.up / 1000) : '?'} s)`;
          rebooted = null;
        } catch (error) { lastError = error.message; }
        if (Date.now() > rediscoverAt) {
          rediscoverAt = Date.now() + 10000;
          const refreshed = await this.devices.refresh({timeoutMs: 1500});
          const entry = refreshed.find(d => d.id === deployment.deviceId);
          if (entry && entry.host && (entry.host !== host || entry.port !== port)) { host = entry.host; port = entry.port; this.update(deployment, {host, port}); }
        }
        await this.deps.delay(1000);
      }
      if (!rebooted) throw new Error(`The board did not come back on the network within ${Math.round(this.rebootWaitMs / 1000)} s (${lastError}). ` +
                                     'If it rolled back, the previous firmware is still running.');
      this.update(deployment, {timings: {...deployment.timings, rebootMs: Date.now() - rebootStart}});

      // ---- verify ----
      this.update(deployment, {state: 'verifying', stage: 'Verifying the new firmware is running'});
      const verifyStart = Date.now();
      const checks = [...deployment.checks];
      if (rebooted.id !== deployment.deviceId) throw new Error(`Reconnected to ${rebooted.id}, not ${deployment.deviceId}`);
      checks.push(`device ${rebooted.id} matched after reboot`);
      if (rebooted.build !== deployment.buildId) {
        throw new Error(`The board reports build ${rebooted.build}, expected ${deployment.buildId}. The new image is not running ` +
                        '(the bootloader may have rolled back).');
      }
      checks.push(`build ${deployment.buildId} running (app "${rebooted.app}" v${rebooted.ver})`);
      if (rebooted.safe) throw new Error('The board booted into safe mode; the generated app is disabled.');
      const baseline = rebooted.loops;
      let live = rebooted;
      const loopDeadline = Date.now() + this.loopWaitMs;
      while (Date.now() < loopDeadline && live.loops <= baseline) {
        await this.deps.delay(1000);
        try { live = await this.devices.probe({host, port, id: deployment.deviceId, timeoutMs: 1500}); } catch { /* keep polling */ }
      }
      if (live.loops <= baseline) {
        throw new Error(`The generated app did not execute (state ${live.appState}). The image stays pending; a reset rolls back to the previous firmware.`);
      }
      checks.push(`app loop ran ${live.loops - baseline} times in the verification window`);
      const echo = await this.devices.control(deployment.deviceId, 'echo');
      if (!echo.ok) throw new Error(`Echo failed (${echo.status})`);
      checks.push('authenticated echo answered');
      this.update(deployment, {checks, timings: {...deployment.timings, verifyMs: Date.now() - verifyStart}});

      // ---- confirm ----
      this.update(deployment, {state: 'confirming', stage: 'Confirming the boot (cancelling rollback)'});
      const confirm = await this.devices.control(deployment.deviceId, 'confirm');
      if (!confirm.ok) throw new Error(`Confirm failed (${confirm.status})`);
      checks.push(live.pending ? 'boot confirmed, rollback cancelled' : 'boot already confirmed by the core');
      const final = await this.devices.probe({host, port, id: deployment.deviceId, timeoutMs: 2500}).catch(() => live);
      this.update(deployment, {state: 'verified', stage: `Verified on ${final.id}`, checks, finishedAt: new Date().toISOString(),
                               after: {build: final.build, fw: final.fw, pending: final.pending, ip: final.wifi.ip},
                               timings: {...deployment.timings, totalMs: Date.now() - startedAt}});
      this.jobs.recordDeployment(deployment.jobId, {deviceId: deployment.deviceId, result: 'verified', detail: checks.join('; '), transport: 'wifi'});
    } catch (error) {
      if (session) {
        try { await send({host, port, method: 'POST', path: '/api/ota/abort', timeoutMs: 4000, headers: {'X-Atech-Session': session}}); }
        catch { /* best effort */ }
      }
      if (agent) { try { agent.destroy(); } catch { /* ignore */ } }
      if (error.aborted) {
        this.update(deployment, {state: 'aborted', stage: 'Aborted', error: 'Deployment aborted; the incomplete image was discarded and the previous firmware keeps running',
                                 finishedAt: new Date().toISOString()});
        this.jobs.recordDeployment(deployment.jobId, {deviceId: deployment.deviceId, result: 'aborted', detail: 'aborted by the user', transport: 'wifi'});
      } else {
        this.fail(deployment, error);
      }
    }
  }
}

module.exports = {DeploymentStore, STATES, DEFAULT_CHUNK};
