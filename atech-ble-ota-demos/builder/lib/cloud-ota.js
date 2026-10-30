'use strict';

// Cloud deployment jobs: the dashboard queues one, the board pulls it. The
// backend never contacts the board; it hands the job out when the board polls,
// serves the image in ranges, records the board's reports, decides what the
// board does after its reboot, and applies the timeouts. Jobs persist so a
// backend restart does not lose a pending deployment.
const fs = require('node:fs');
const path = require('node:path');
const {loadConfig} = require('./config');
const {validateImage} = require('./image');
const {AGENT_MARKER} = require('./jobs');
const {canAccess} = require('./devices');
const {normalizeReport} = require('./cloud-devices');
const {newJobId, CloudError} = require('./cloud-auth');
const {sha256Hex} = require('./lan-auth');

const STATES = ['pending', 'downloading', 'installing', 'rebooting', 'succeeded', 'failed', 'cancelled'];
const ACTIVE = new Set(['pending', 'downloading', 'installing', 'rebooting']);
const LATE_SUCCESS_REASONS = new Set(['reboot_timeout', 'stalled', 'confirm_timeout']);
const KEEP = 100;
const MAX_ERROR_LENGTH = 300;

const STAGES = {
  pending: 'Waiting for the board to pick up the job',
  busy: 'Board is busy with another update',
  downloading: 'The board is downloading the firmware',
  installing: 'The board is checking and installing the image',
  rebooting: 'The board is restarting into the new firmware',
  confirming: 'Back online; confirming the new firmware',
  succeeded: 'Deployed and confirmed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function parseRange(header, size) {
  if (!header) return {start: 0, end: size - 1, partial: false};
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(header).trim());
  if (!match) throw new CloudError(416, 'range', 'Unsupported Range header');
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isFinite(start) || start >= size || start > end) throw new CloudError(416, 'range', `Range starts past the end of the ${size}-byte image`);
  return {start, end, partial: true};
}

class CloudDeploymentStore {
  constructor({config = loadConfig(), jobs, devices, cloud, now = Date.now, log = () => {}}) {
    this.config = config;
    this.jobs = jobs;
    this.devices = devices;
    this.cloud = cloud;
    this.now = now;
    this.log = log;
    this.file = path.join(config.buildsDir, 'cloud-deployments.json');
    this.deployments = new Map();
    this.subscribers = new Map();
    this.load();
  }

  iso(ms = this.now()) { return new Date(ms).toISOString(); }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const d of data.deployments || []) if (d && d.id) this.deployments.set(d.id, d);
    } catch { /* first run */ }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const deployments = [...this.deployments.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, KEEP);
    fs.writeFileSync(this.file, JSON.stringify({version: 1, deployments}, null, 2));
  }

  snapshot(d) {
    const copy = JSON.parse(JSON.stringify(d));
    const described = this.devices.describe(d.deviceId);
    copy.offline = d.state === 'pending' && !this.cloud.isOnline(d.deviceId);
    copy.deviceLastSeenAt = described ? described.cloud.lastSeenAt : null;
    return copy;
  }

  subscribe(id, fn) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(fn);
    return () => this.subscribers.get(id)?.delete(fn);
  }

  update(d, patch = {}) {
    Object.assign(d, patch, {updatedAt: this.iso()});
    this.persist();
    const snapshot = this.snapshot(d);
    for (const fn of this.subscribers.get(d.id) || []) {
      try { fn(snapshot); } catch { /* subscriber errors never break a deployment */ }
    }
    return snapshot;
  }

  list({ownerId = null, deviceId = null} = {}) {
    return [...this.deployments.values()]
      .filter(d => canAccess({ownerId: d.ownerId}, ownerId) && (!deviceId || d.deviceId === deviceId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50).map(d => this.snapshot(d));
  }

  get(id) {
    const d = this.deployments.get(id);
    return d ? this.snapshot(d) : null;
  }

  activeFor(deviceId) {
    return [...this.deployments.values()].find(d => d.deviceId === deviceId && ACTIVE.has(d.state)) || null;
  }

  create({jobId, deviceId, ownerId = null}) {
    const job = this.jobs.get(jobId);
    if (!job) throw new CloudError(400, 'bad_request', `Unknown build ${jobId}`);
    if (job.state !== 'ready' || !job.firmware) throw new CloudError(400, 'bad_request', `Build ${job.buildId} is ${job.state}; only a ready build can be deployed`);
    const record = this.devices.get(deviceId);
    if (!record) throw new CloudError(400, 'bad_request', `Unknown device ${deviceId}; claim it first`);
    if (!record.secret) throw new CloudError(400, 'bad_request', `${deviceId} is not claimed; enter its pairing token first`);
    if (!canAccess(record, ownerId)) throw new CloudError(403, 'owned', 'This board belongs to another dashboard user');
    if (record.demo && job.demo !== Number(record.demo)) throw new CloudError(400, 'bad_request', `This build is for Demo ${job.demo}; ${deviceId} runs Demo ${record.demo}`);
    if (job.deviceId && job.deviceId !== deviceId) throw new CloudError(400, 'bad_request', `Build ${job.buildId} is bound to ${job.deviceId}, not ${deviceId}`);
    const lastReport = (record.cloud && record.cloud.lastReport) || {};
    if (lastReport.slotSize && job.firmware.size > lastReport.slotSize) {
      throw new CloudError(400, 'bad_request', `The image (${job.firmware.size} bytes) is larger than the board's OTA slot (${lastReport.slotSize} bytes)`);
    }
    const file = this.jobs.firmwarePath(jobId);
    if (!file || !fs.existsSync(file)) throw new CloudError(400, 'bad_request', 'The build artifact is no longer available');
    const image = fs.readFileSync(file);
    const entry = this.config.demos[job.demo];
    const validation = validateImage(image, {slotSize: this.config.slotSize, sizeMargin: this.config.sizeMargin,
                                             markers: [entry.imageIdentity, `ATECH-BUILD:${job.buildId}`, AGENT_MARKER]});
    if (!validation.ok) throw new CloudError(400, 'bad_request', `Image validation failed: ${validation.errors.join('; ')}`);
    const sha256 = sha256Hex(image);
    if (job.firmware.sha256 && job.firmware.sha256 !== sha256) throw new CloudError(400, 'bad_request', 'Firmware digest on disk does not match the build record');
    const active = this.activeFor(deviceId);
    if (active) throw new CloudError(409, 'duplicate', `Deployment ${active.id} (${active.state}) is still active for ${deviceId}; wait for it or cancel it`);
    const now = this.now();
    const d = {
      id: newJobId(), transport: 'cloud', jobId, buildId: job.buildId, appName: job.appName, appVersion: job.appVersion, demo: job.demo,
      deviceId, ownerId, state: 'pending', stage: STAGES.pending, total: image.length, sha256, received: 0, percent: 0, attempts: 0,
      nextOffset: 0, error: null, reason: null, checks: [], timings: {}, createdAt: this.iso(now), updatedAt: this.iso(now),
      expiresAt: this.iso(now + this.config.cloud.jobTtlMs), claimedAt: null, installingAt: null, rebootingAt: null, ackAt: null,
      lastReportAt: null, finishedAt: null, before: {build: lastReport.build || record.build || null}, after: {build: null}, note: null, heap: null,
    };
    this.deployments.set(d.id, d);
    this.persist();
    this.log(`cloud deployment ${d.id}: build ${d.buildId} queued for ${deviceId}`);
    return this.snapshot(d);
  }

  cancel(id) {
    const d = this.deployments.get(id);
    if (!d) throw new CloudError(404, 'not_found', 'Unknown deployment');
    if (d.state !== 'pending') {
      throw new CloudError(409, 'not_pending', d.state === 'cancelled' ? 'The job is already cancelled'
        : ACTIVE.has(d.state) ? 'The board already picked up this job; it cannot be stopped from the cloud' : `The job already ${d.state}`);
    }
    this.finish(d, 'cancelled', 'cancelled', 'Job cancelled before the board picked it up');
    return this.snapshot(d);
  }

  finish(d, state, reason, message) {
    const now = this.now();
    this.update(d, {state, reason, error: message, stage: state === 'failed' ? STAGES.failed : STAGES.cancelled, finishedAt: this.iso(now),
                    timings: {...d.timings, totalMs: now - Date.parse(d.createdAt)}});
    this.jobs.recordDeployment(d.jobId, {deviceId: d.deviceId, result: state, detail: message, transport: 'cloud'});
    this.log(`cloud deployment ${d.id}: ${state} (${reason}) ${message}`);
  }

  fail(d, reason, message) { this.finish(d, 'failed', reason, message); }

  // The board confirmed the new build: final state, audit entry, timings.
  succeed(d, {build, note = null} = {}) {
    const now = this.now();
    const checks = ['board came back online after the reboot', `build ${d.buildId} running`, 'boot confirmed, rollback cancelled'];
    this.update(d, {state: 'succeeded', stage: `${STAGES.succeeded} on ${d.deviceId}`, finishedAt: this.iso(now), checks, reason: null, error: null,
                    after: {build: String(build || d.buildId)}, note: note || d.note,
                    timings: {...d.timings, rebootMs: now - Date.parse(d.rebootingAt || d.updatedAt), totalMs: now - Date.parse(d.createdAt)}});
    this.jobs.recordDeployment(d.jobId, {deviceId: d.deviceId, result: 'succeeded', detail: checks.join('; '), transport: 'cloud'});
    this.log(`cloud deployment ${d.id}: succeeded on ${d.deviceId}${note ? ` (${note})` : ''}`);
  }

  // Every active job of a board ends when the board is forgotten or changes owner, so the next
  // owner never inherits a queued build and the board never installs one for a dashboard that
  // no longer claims it.
  cancelAllFor(deviceId, message = 'The board was forgotten') {
    let count = 0;
    for (const d of this.deployments.values()) {
      if (d.deviceId !== deviceId || !ACTIVE.has(d.state)) continue;
      this.finish(d, 'cancelled', 'cancelled', message);
      count++;
    }
    return count;
  }

  manifest(d) {
    return {job: d.id, build: d.buildId, size: d.total, sha256: d.sha256, demo: d.demo, app: d.appName || '', ver: d.appVersion || 0,
            url: `/api/device/jobs/${d.id}/firmware`, chunk: this.config.cloud.chunkBytes};
  }

  // The board's poll: hand out the next job when the board is ready, and decide what a board
  // that just rebooted into a cloud-deployed image should do.
  poll(deviceId, report = {}) {
    const info = normalizeReport(report);
    const result = {job: null, ack: null, pollMs: this.config.cloud.pollMs};
    if (info.bootJob) {
      const d = this.deployments.get(info.bootJob);
      result.ack = d && d.deviceId === deviceId ? this.acknowledgeBoot(d, info) : {jobId: info.bootJob, action: 'clear'};
    }
    const active = this.activeFor(deviceId);
    if (active && active.state === 'pending') {
      if (this.now() >= Date.parse(active.expiresAt)) this.fail(active, 'expired', this.expiredMessage());
      else if (!info.ready) { if (active.stage !== STAGES.busy) this.update(active, {stage: STAGES.busy}); }
      else {
        const now = this.now();
        // The board's own report is the best record of what ran before (a board claimed while
        // offline had nothing on file at create time).
        this.update(active, {state: 'downloading', stage: STAGES.downloading, claimedAt: this.iso(now), lastReportAt: this.iso(now),
                             before: {build: active.before.build || info.build || null},
                             timings: {...active.timings, queuedMs: now - Date.parse(active.createdAt)}});
        result.job = this.manifest(active);
      }
    } else if (active && active.state === 'downloading' && info.ready && !info.transferring) {
      // The board lost the transfer (reset mid-download): offer the job again; ranges let it resume.
      active.lastReportAt = this.iso();
      result.job = this.manifest(active);
    } else if (active && active.state === 'rebooting' && active.ackAt && !info.bootJob && info.build === active.buildId && !info.pending) {
      // Acknowledged, confirmed on the board (not pending any more), but its success report never
      // arrived: the poll itself proves the outcome.
      this.succeed(active, {build: info.build, note: 'reconciled from the board\'s poll: the success report never arrived'});
    }
    return result;
  }

  expiredMessage() {
    const minutes = Math.round(this.config.cloud.jobTtlMs / 60000);
    return `The board did not pick up the job within ${minutes} minutes`;
  }

  acknowledgeBoot(d, info) {
    const expected = d.buildId;
    const lateSuccess = d.state === 'failed' && LATE_SUCCESS_REASONS.has(d.reason);
    // A board that reports this job's marker has installed and rebooted, whatever the backend
    // last heard (its installing and rebooting reports may have been lost).
    const awaiting = ['downloading', 'installing', 'rebooting'].includes(d.state) || lateSuccess;
    if (!awaiting) return {jobId: d.id, action: 'clear'};
    if (info.bootBuild !== expected || info.build !== expected) {
      this.fail(d, 'rolled_back', `The board rolled back to build ${info.build || '?'} instead of ${expected}`);
      return {jobId: d.id, action: 'clear'};
    }
    if (info.safe) {
      this.fail(d, 'safe_mode', 'The board booted into safe mode; the generated app crashed repeatedly, rolling back');
      return {jobId: d.id, action: 'rollback'};
    }
    if (d.ackAt && !info.pending) {
      // Already acknowledged and the image is no longer pending: the board confirmed it but its
      // success report never arrived. The marker it still carries is cleared.
      this.succeed(d, {build: info.build, note: 'reconciled from the board\'s poll: the success report never arrived'});
      return {jobId: d.id, action: 'clear'};
    }
    const now = this.now();
    this.update(d, {state: 'rebooting', stage: STAGES.confirming, ackAt: this.iso(now), reason: null, error: null, finishedAt: null,
                    rebootingAt: d.rebootingAt || this.iso(now), note: lateSuccess ? 'The board returned after the timeout; the job succeeded after the timeout' : d.note});
    return {jobId: d.id, action: 'confirm'};
  }

  openFirmware(jobId, deviceId, {range = null} = {}) {
    const d = this.deployments.get(jobId);
    if (!d) throw new CloudError(404, 'not_found', 'Unknown job');
    if (d.deviceId !== deviceId) throw new CloudError(403, 'owned', 'This job belongs to another board');
    if (d.state !== 'downloading') throw new CloudError(409, 'not_downloading', `The job is ${d.state}; nothing to download`);
    const {start, end, partial} = parseRange(range, d.total);
    if (d.attempts === 0 || start !== d.nextOffset) {
      d.attempts += 1;
      if (d.attempts > this.config.cloud.maxAttempts) {
        this.fail(d, 'attempts', `The board could not download the image after ${this.config.cloud.maxAttempts} attempts`);
        throw new CloudError(409, 'attempts', 'Too many download attempts; the job failed');
      }
    }
    const file = this.jobs.firmwarePath(d.jobId);
    if (!file || !fs.existsSync(file)) {
      this.fail(d, 'artifact', 'The build artifact is no longer available');
      throw new CloudError(410, 'artifact', 'The build artifact is no longer available');
    }
    d.nextOffset = end + 1;
    d.lastReportAt = this.iso();
    this.persist();
    return {stream: fs.createReadStream(file, {start, end}), status: partial ? 206 : 200, start, end, size: d.total, sha256: d.sha256, buildId: d.buildId};
  }

  report(jobId, deviceId, body = {}) {
    const d = this.deployments.get(jobId);
    if (!d) throw new CloudError(404, 'not_found', 'Unknown job');
    if (d.deviceId !== deviceId) throw new CloudError(403, 'owned', 'This job belongs to another board');
    const phase = String(body.phase || '');
    const received = Math.max(0, Math.min(d.total, Number(body.received) || 0));
    const error = String(body.error || '').slice(0, MAX_ERROR_LENGTH);
    const now = this.now();
    d.lastReportAt = this.iso(now);
    if (body.heap !== undefined) d.heap = {free: Number(body.heap) || 0, min: Number(body.heap_min) || 0};
    if (phase === 'downloading' && d.state === 'downloading') {
      this.update(d, {received, percent: Math.floor(received * 100 / d.total), stage: STAGES.downloading});
    } else if (phase === 'installing' && d.state === 'downloading') {
      this.update(d, {state: 'installing', stage: STAGES.installing, received: d.total, percent: 100, installingAt: this.iso(now),
                      timings: {...d.timings, downloadMs: now - Date.parse(d.claimedAt || d.createdAt)}});
    } else if (phase === 'rebooting' && (d.state === 'downloading' || d.state === 'installing')) {
      this.update(d, {state: 'rebooting', stage: STAGES.rebooting, received: d.total, percent: 100, rebootingAt: this.iso(now),
                      timings: {...d.timings, installMs: now - Date.parse(d.installingAt || d.claimedAt || d.createdAt)}});
    } else if (phase === 'succeeded' && d.state === 'rebooting') {
      this.succeed(d, {build: body.build});
    } else if (phase === 'succeeded' && d.state === 'succeeded') {
      this.persist();   // a repeated report after a lost answer: already done
    } else if (phase === 'failed' && ACTIVE.has(d.state)) {
      this.fail(d, 'device', error || 'The board reported a failure');
    } else {
      this.persist();
    }
    return this.snapshot(d);
  }

  // Timeouts, run every few seconds by the server. Returns how many jobs changed.
  tick() {
    const now = this.now();
    let changed = 0;
    const {stallMs, rebootTimeoutMs, confirmTimeoutMs} = this.config.cloud;
    for (const d of this.deployments.values()) {
      if (d.state === 'pending' && now >= Date.parse(d.expiresAt)) { this.fail(d, 'expired', this.expiredMessage()); changed++; }
      else if ((d.state === 'downloading' || d.state === 'installing') && now - Date.parse(d.lastReportAt || d.claimedAt) > stallMs) {
        this.fail(d, 'stalled', 'Lost contact with the board during the download'); changed++;
      } else if (d.state === 'rebooting' && !d.ackAt && now - Date.parse(d.rebootingAt) > rebootTimeoutMs) {
        this.fail(d, 'reboot_timeout', 'The board did not come back online after the reboot. If it rolled back, the previous firmware is running.'); changed++;
      } else if (d.state === 'rebooting' && d.ackAt && now - Date.parse(d.ackAt) > confirmTimeoutMs) {
        this.fail(d, 'confirm_timeout', 'The board came back but never confirmed the new firmware'); changed++;
      }
    }
    return changed;
  }
}

module.exports = {CloudDeploymentStore, STATES, STAGES, parseRange};
