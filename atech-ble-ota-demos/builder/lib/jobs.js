'use strict';

// Job pipeline: generating -> compiling -> (repairing) -> validating -> ready | failed.
// Every state change is persisted under <buildsDir>/jobs/<id>/ and pushed to
// subscribers (the SSE endpoint and tests).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {loadConfig} = require('./config');
const {checkSource} = require('./source-policy');
const {validateImage} = require('./image');
const workspace = require('./workspace');
const {buildSystemPrompt, buildMessages} = require('./generate');

const STATES = ['queued', 'generating', 'compiling', 'repairing', 'validating', 'ready', 'failed'];
const MAX_PROMPT = 4000;
const LOG_TAIL_LINES = 40;
const FIRST_AI_VERSION = 3;

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

function defaultReadApiHeader(config) {
  return fs.readFileSync(path.join(config.sharedDir, 'AtechCore', 'src', 'AtechAppApi.h'), 'utf8');
}

class JobStore {
  constructor({config = loadConfig(), provider, deps = {}} = {}) {
    this.config = config;
    this.provider = provider;
    this.deps = {
      checkSource,
      validateImage,
      prepareWorkspace: workspace.prepareWorkspace,
      compileWorkspace: workspace.compileWorkspace,
      readApiHeader: () => defaultReadApiHeader(config),
      ...deps,
    };
    this.jobs = new Map();
    this.subscribers = new Map();
    this.queue = Promise.resolve();
    this.jobsDir = path.join(config.buildsDir, 'jobs');
    this.statePath = path.join(config.buildsDir, 'state.json');
    fs.mkdirSync(this.jobsDir, {recursive: true});
    this.loadExisting();
  }

  loadExisting() {
    for (const id of fs.readdirSync(this.jobsDir)) {
      const metaPath = path.join(this.jobsDir, id, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        // A job interrupted by a restart can never finish; say so.
        if (!['ready', 'failed'].includes(job.state)) {
          job.state = 'failed';
          job.error = job.error || 'The builder was restarted while this job was running';
        }
        this.jobs.set(job.id, job);
      } catch { /* ignore unreadable job */ }
    }
  }

  nextAppVersion(demo) {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { state = {}; }
    const key = `demo${demo}`;
    const version = Number(state[key]?.nextVersion) || FIRST_AI_VERSION;
    state[key] = {nextVersion: version + 1};
    fs.mkdirSync(path.dirname(this.statePath), {recursive: true});
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    return version;
  }

  create({demo, prompt, deviceId = ''}) {
    const demoNumber = Number(demo);
    if (!this.config.demos[demoNumber]) throw new Error(`Unknown demo "${demo}"; use 1 or 2`);
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('A prompt is required');
    if (text.length > MAX_PROMPT) throw new Error(`The prompt must be at most ${MAX_PROMPT} characters`);
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const job = {
      id, demo: demoNumber, prompt: text, deviceId: String(deviceId || '').trim(),
      state: 'queued', stage: 'Queued', attempt: 0, maxRepairs: this.config.maxRepairs,
      buildId: crypto.randomBytes(4).toString('hex'), appName: null, appVersion: this.nextAppVersion(demoNumber),
      summary: null, code: null, diagnostics: [], violations: [], logTail: '', firmware: null,
      error: null, createdAt: now, updatedAt: now, provider: this.provider?.name || null,
      model: this.provider?.model || null, deployments: [], usage: [],
    };
    this.jobs.set(id, job);
    fs.mkdirSync(path.join(this.jobsDir, id), {recursive: true});
    this.persist(job);
    return this.snapshot(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  list(demo) {
    return [...this.jobs.values()]
      .filter(job => !demo || job.demo === Number(demo))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 20)
      .map(job => this.snapshot(job, {withoutCode: true}));
  }

  subscribe(id, fn) {
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id).add(fn);
    return () => this.subscribers.get(id)?.delete(fn);
  }

  snapshot(job, {withoutCode = false} = {}) {
    const copy = JSON.parse(JSON.stringify(job));
    if (withoutCode) delete copy.code;
    if (copy.firmware) delete copy.firmware.path;
    return copy;
  }

  persist(job) {
    job.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.jobsDir, job.id, 'meta.json'), JSON.stringify(job, null, 2));
  }

  update(job, patch) {
    Object.assign(job, patch);
    this.persist(job);
    const snapshot = this.snapshot(job);
    for (const fn of this.subscribers.get(job.id) || []) {
      try { fn(snapshot); } catch { /* subscriber errors never break the pipeline */ }
    }
  }

  recordDeployment(id, record) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.deployments.push({...record, at: new Date().toISOString()});
    this.persist(job);
    return this.snapshot(job);
  }

  firmwarePath(id) {
    const job = this.jobs.get(id);
    return job && job.state === 'ready' ? path.join(this.jobsDir, id, 'firmware.bin') : null;
  }

  run(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`Unknown job ${id}`));
    const task = () => this.execute(job).then(() => this.snapshot(job));
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  async execute(job) {
    const {config, deps, provider} = this;
    const entry = config.demos[job.demo];
    const jobDir = path.join(this.jobsDir, job.id);
    const attempts = [];
    const system = buildSystemPrompt({demo: job.demo, apiHeader: deps.readApiHeader(config)});
    const maxAttempts = config.maxRepairs + 1;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.update(job, {state: attempt === 1 ? 'generating' : 'repairing', attempt,
                          stage: attempt === 1 ? 'Generating firmware with the model'
                                               : `Repairing (attempt ${attempt} of ${maxAttempts})`});
        const messages = buildMessages({prompt: job.prompt, demo: job.demo, deviceId: job.deviceId, attempts});
        const generated = await provider.generate({system, messages});
        const attemptDir = path.join(jobDir, `attempt-${attempt}`);
        fs.mkdirSync(attemptDir, {recursive: true});
        fs.writeFileSync(path.join(attemptDir, 'user_app.cpp'), generated.code);
        if (generated.usage) job.usage.push({attempt, usage: generated.usage, costUsd: generated.costUsd ?? null});
        this.update(job, {appName: generated.name, summary: generated.summary, code: generated.code,
                          model: generated.model || job.model});

        const policy = deps.checkSource(generated.code);
        if (!policy.ok) {
          attempts.push({code: generated.code, diagnostics: [], violations: policy.violations, logTail: ''});
          this.update(job, {violations: policy.violations, diagnostics: []});
          if (attempt === maxAttempts) {
            throw new Error(`Generated code violated the policy: ${policy.violations.map(v => v.message).join('; ')}`);
          }
          continue;
        }

        this.update(job, {state: 'compiling', stage: 'Compiling with PlatformIO', violations: [], diagnostics: [], logTail: ''});
        const meta = {buildId: job.buildId, appName: generated.name, appVersion: job.appVersion,
                      targetDeviceId: job.deviceId};
        const {dir} = await deps.prepareWorkspace(job.demo, {code: generated.code, meta}, {config});
        const tail = [];
        let lastPush = 0;
        const compiled = await deps.compileWorkspace(job.demo, dir, {config, onLine: line => {
          tail.push(line);
          if (tail.length > LOG_TAIL_LINES) tail.shift();
          const now = Date.now();
          if (now - lastPush > 500) { lastPush = now; this.update(job, {logTail: tail.join('\n')}); }
        }});
        fs.writeFileSync(path.join(attemptDir, 'build.log'), compiled.log || '');
        const logTail = tail.join('\n');
        if (!compiled.ok) {
          attempts.push({code: generated.code, diagnostics: compiled.diagnostics, violations: [], logTail});
          this.update(job, {diagnostics: compiled.diagnostics, logTail});
          if (attempt === maxAttempts) {
            const errors = compiled.diagnostics.filter(d => d.severity === 'error');
            const last = errors[errors.length - 1] || compiled.diagnostics[compiled.diagnostics.length - 1];
            throw new Error(last ? `Build failed after ${attempt} attempts: ${last.message}`
                                 : `Build failed after ${attempt} attempts (exit ${compiled.code}${compiled.timedOut ? ', timed out' : ''})`);
          }
          continue;
        }

        this.update(job, {state: 'validating', stage: 'Validating the image', diagnostics: compiled.diagnostics, logTail});
        const image = fs.readFileSync(compiled.firmwarePath);
        const validation = deps.validateImage(image, {
          slotSize: config.slotSize, sizeMargin: config.sizeMargin,
          markers: [entry.imageIdentity, `ATECH-BUILD:${job.buildId}`],
        });
        if (!validation.ok) throw new Error(`Image validation failed: ${validation.errors.join('; ')}`);
        const target = path.join(jobDir, 'firmware.bin');
        fs.copyFileSync(compiled.firmwarePath, target);
        this.update(job, {
          state: 'ready', stage: 'Ready to deploy',
          firmware: {size: image.length, crc32: crc32(image),
                     sha256: crypto.createHash('sha256').update(image).digest('hex'), path: target},
        });
        return;
      }
    } catch (error) {
      this.update(job, {state: 'failed', stage: 'Failed', error: error.message || String(error), firmware: null});
    }
  }
}

module.exports = {JobStore, STATES, crc32};
