'use strict';

// Shared AI firmware builder card. Each dashboard mounts it with a transport
// object that knows how to talk to its board:
//   transport = {
//     bluetoothAvailable: boolean,
//     isConnected(): boolean,
//     identity(): object | null,            // last identity read from the board
//     readIdentity(): Promise<object>,      // fresh read
//     deploy(bytes, meta): Promise<{identity}>,  // OTA + reboot + reconnect
//     control(opcode): Promise<{status, statusText}>,
//   }
(function attachAtechBuilder(root) {
  const POLL_MS = 2000;
  const LOOP_WAIT_MS = 10000;
  const STAGE_PROGRESS = {queued: 5, generating: 25, repairing: 45, compiling: 65, validating: 85, ready: 100, failed: 100};
  const EXAMPLES = [
    'Make the onboard LED blink three times quickly, pause for two seconds, and repeat.',
    'Fade the LED from off to purple and back over three seconds, forever.',
    'Show a police strobe: two red flashes, two blue flashes, repeat.',
    'Blink green once per second and log the uptime in seconds on every blink.',
  ];

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function mount({demo, transport, log = () => {}, root: doc = root.document}) {
    const $ = id => doc.getElementById(id);
    const protocol = root.AtechIdentity;
    const state = {job: null, source: null, pollTimer: null, busy: false, armedRollback: null, backendOk: false};

    function setStatus(text, tone = 'neutral', badge) {
      $('aiStatus').textContent = text;
      $('aiStatus').className = `state ${tone}`;
      if (badge !== undefined) {
        $('aiBadge').textContent = badge;
        $('aiBadge').className = `badge ${tone === 'neutral' ? 'neutral' : tone}`;
      }
    }

    function setProgress(percent) {
      $('aiProgressBar').style.width = `${percent}%`;
      $('aiProgress').setAttribute('aria-valuenow', String(percent));
    }

    function identity() {
      return transport.identity();
    }

    function canDeploy() {
      const job = state.job;
      const identity = transport.identity();
      return Boolean(job && job.state === 'ready' && job.firmware && !state.busy && transport.isConnected() &&
                     identity && job.demo === identity.demo &&
                     (!job.deviceId || job.deviceId === identity.id) &&
                     job.firmware.size <= identity.slotSize);
    }

    function deployBlocker() {
      const job = state.job;
      const identity = transport.identity();
      if (!job || job.state !== 'ready') return 'Build firmware first.';
      if (!transport.bluetoothAvailable) return 'This browser has no Web Bluetooth. Download the firmware and use the Wi-Fi steps.';
      if (!transport.isConnected() || !identity) return 'Connect the board to deploy.';
      if (job.demo !== identity.demo) return `This build is for Demo ${job.demo}; the connected board runs Demo ${identity.demo}.`;
      if (job.deviceId && job.deviceId !== identity.id) return `This build is bound to ${job.deviceId}; the connected board is ${identity.id}.`;
      if (job.firmware.size > identity.slotSize) return 'The image is larger than the board reports for its OTA slot.';
      return '';
    }

    function refresh() {
      const identity = transport.identity();
      const target = $('aiTarget');
      if (identity) {
        let text = protocol.describeIdentity(identity);
        if (!identity.paired) text += `. Warning: this firmware was built for ${identity.target}.`;
        if (identity.safe) text += '. Safe mode: the app crashed repeatedly and is disabled until a new build is deployed or the board is power-cycled.';
        target.textContent = text;
        target.className = identity.safe || !identity.paired ? 'ai-target warn' : 'ai-target';
      } else {
        target.textContent = transport.bluetoothAvailable
          ? 'No device connected. You can build now and connect before deploying; connecting first binds the build to this board.'
          : 'No Bluetooth in this browser. Builds still work; deployment uses the Wi-Fi portal with the downloaded file.';
        target.className = 'ai-target';
      }
      $('aiConfirm').hidden = !(identity && identity.pending && transport.isConnected());
      $('aiRollback').hidden = !(identity && identity.canRollback && transport.isConnected());
      $('aiBrowserNote').hidden = transport.bluetoothAvailable;
      $('aiBuild').disabled = state.busy || !state.backendOk ||
        (state.job && !['ready', 'failed'].includes(state.job.state));
      $('aiDeploy').disabled = !canDeploy();
      $('aiDeploy').title = deployBlocker();
      $('aiConfirm').disabled = state.busy;
      $('aiRollback').disabled = state.busy;
    }

    async function checkBackend() {
      try {
        const response = await fetch('/api/health', {cache: 'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = await response.json();
        state.backendOk = true;
        $('aiBackend').textContent = `Backend online: ${health.provider || 'no provider'} (${health.model || 'no model'})`;
        $('aiBackend').className = 'ai-backend ok';
      } catch (error) {
        state.backendOk = false;
        $('aiBackend').textContent = 'Backend offline. Start it with: cd builder && npm start, then reload this page.';
        $('aiBackend').className = 'ai-backend error';
      }
      refresh();
    }

    function renderDiagnostics(job) {
      const list = $('aiLog');
      list.replaceChildren();
      const rows = [];
      for (const v of job.violations || []) rows.push(['policy', `${v.message}${v.line ? ` (line ${v.line})` : ''}`]);
      for (const d of job.diagnostics || []) {
        rows.push([d.severity, d.file ? `${d.file}:${d.line}:${d.col}: ${d.message}` : d.message]);
      }
      if (!rows.length && job.logTail && ['compiling', 'repairing'].includes(job.state)) {
        rows.push(['build', job.logTail.split('\n').slice(-6).join('\n')]);
      }
      if (job.error) rows.push(['error', job.error]);
      for (const [kind, text] of rows) {
        const row = doc.createElement('div');
        row.className = `ai-diag ${kind}`;
        const label = doc.createElement('span');
        label.className = 'ai-diag-kind';
        label.textContent = kind;
        const body = doc.createElement('pre');
        body.textContent = text;
        row.append(label, body);
        list.append(row);
      }
      list.hidden = rows.length === 0;
    }

    function render(job) {
      state.job = job;
      const tone = job.state === 'ready' ? 'success' : job.state === 'failed' ? 'error' : 'working';
      const badge = {queued: 'Queued', generating: 'Generating', repairing: 'Repairing', compiling: 'Compiling',
                     validating: 'Validating', ready: 'Ready to deploy', failed: 'Failed'}[job.state] || job.state;
      setStatus(job.state === 'failed' ? `Build failed: ${job.error}` : job.stage || job.state, tone, badge);
      setProgress(STAGE_PROGRESS[job.state] ?? 0);
      $('aiAttempts').textContent = job.attempt ? `Attempt ${job.attempt} of ${job.maxRepairs + 1}` : '';
      $('aiSummary').textContent = job.summary || '';
      $('aiReview').hidden = !job.code;
      if (job.code) $('aiCode').textContent = job.code;
      const meta = [];
      if (job.appName) meta.push(`${job.appName} v${job.appVersion}`);
      meta.push(`build ${job.buildId}`);
      if (job.firmware) meta.push(`${formatBytes(job.firmware.size)}, CRC32 ${job.firmware.crc32}`);
      if (job.model) meta.push(job.model);
      $('aiCodeMeta').textContent = meta.join(' | ');
      renderDiagnostics(job);
      const download = $('aiDownload');
      if (job.state === 'ready') {
        download.href = `/api/builds/${job.id}/firmware.bin`;
        download.hidden = false;
        download.classList.toggle('primary', !transport.bluetoothAvailable);
        download.classList.toggle('secondary', transport.bluetoothAvailable);
      } else {
        download.hidden = true;
      }
      refresh();
    }

    function stopFollowing() {
      if (state.source) { state.source.close(); state.source = null; }
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }

    async function pollOnce(id) {
      const response = await fetch(`/api/builds/${id}`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
      const job = await response.json();
      render(job);
      if (['ready', 'failed'].includes(job.state)) stopFollowing();
      return job;
    }

    function poll(id) {
      stopFollowing();
      state.pollTimer = setInterval(() => {
        pollOnce(id).catch(error => log(error.message, 'BUILDER', 'warn'));
      }, POLL_MS);
    }

    function follow(id) {
      stopFollowing();
      if (typeof root.EventSource !== 'function') { poll(id); return; }
      const source = new root.EventSource(`/api/builds/${id}/events`);
      state.source = source;
      source.addEventListener('job', event => render(JSON.parse(event.data)));
      source.addEventListener('done', () => { stopFollowing(); pollOnce(id).catch(() => {}); });
      source.onerror = () => {
        if (state.source !== source) return;
        log('Live progress stream dropped; polling the backend instead.', 'BUILDER', 'warn');
        poll(id);
      };
    }

    async function build() {
      const prompt = $('aiPrompt').value.trim();
      if (!prompt) { setStatus('Describe what the board should do first.', 'error', 'Needs prompt'); return; }
      const identity = transport.identity();
      stopFollowing();
      state.job = null;
      $('aiReview').hidden = true;
      $('aiDownload').hidden = true;
      setStatus('Sending the prompt to the builder backend.', 'working', 'Starting');
      setProgress(STAGE_PROGRESS.queued);
      refresh();
      try {
        const response = await fetch('/api/builds', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({demo, prompt, deviceId: identity ? identity.id : ''}),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        log(`Build ${body.buildId} queued (app version ${body.appVersion})${identity ? ` for ${identity.id}` : ''}.`, 'BUILDER');
        await pollOnce(body.id);
        if (!['ready', 'failed'].includes(state.job.state)) follow(body.id);
      } catch (error) {
        setStatus(`Could not start the build: ${error.message}`, 'error', 'Failed');
        log(error.message, 'BUILDER', 'error');
        refresh();
      }
    }

    async function waitForLoops(baseline) {
      const deadline = Date.now() + LOOP_WAIT_MS;
      let latest = null;
      while (Date.now() < deadline) {
        latest = await transport.readIdentity();
        if (latest.loops > baseline) return latest;
        await delay(1000);
      }
      return latest;
    }

    async function verifyAfterReboot(job, expectedDeviceId, identity) {
      const checks = [];
      if (identity.id !== expectedDeviceId) {
        throw new Error(`Reconnected to ${identity.id}, not the board that was updated (${expectedDeviceId})`);
      }
      checks.push(`device ${identity.id} matched`);
      const buildMatches = identity.build === job.buildId;
      if (!buildMatches) {
        throw new Error(`Board reports build ${identity.build}, expected ${job.buildId}. The new image is not running.`);
      }
      checks.push(`build ${job.buildId} running (app "${identity.app}" v${identity.ver})`);
      if (identity.safe) throw new Error('Board booted into safe mode; the generated app is disabled.');
      const live = await waitForLoops(identity.loops);
      if (!live || live.loops <= identity.loops) {
        throw new Error(`The generated app did not execute (state ${live ? live.appState : 'unknown'}). ` +
                        'The image stays pending; a reset rolls back to the previous firmware.');
      }
      checks.push(`app loop ran ${live.loops - rebooted.loops} times in the verification window`);
      const echo = await transport.control(protocol.CONTROL.echo);
      if (echo.status !== 0) throw new Error(`Echo failed: ${echo.statusText}`);
      checks.push('echo answered');
      const confirm = await transport.control(protocol.CONTROL.confirm);
      if (confirm.status !== 0) throw new Error(`Confirm failed: ${confirm.statusText}`);
      checks.push(live.pending ? 'boot confirmed, rollback cancelled' : 'boot already confirmed by the core');
      const final = await transport.readIdentity();
      return {checks, identity: final};
    }

    async function recordDeployment(job, result, detail) {
      try {
        await fetch(`/api/builds/${job.id}/deployed`, {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({deviceId: (transport.identity() || {}).id || '', result, detail}),
        });
      } catch (_) { /* audit only */ }
    }

    async function deploy() {
      if (!canDeploy()) { setStatus(deployBlocker(), 'error'); return; }
      const job = state.job;
      const before = transport.identity();
      state.busy = true;
      refresh();
      try {
        setStatus(`Fetching build ${job.buildId} from the backend.`, 'working', 'Deploying');
        const response = await fetch(`/api/builds/${job.id}/firmware.bin`, {cache: 'no-store'});
        if (!response.ok) throw new Error(`Firmware download failed (HTTP ${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== job.firmware.size) throw new Error('Downloaded image size does not match the build record');
        log(`Deploying ${job.appName} (${formatBytes(bytes.length)}) to ${before.id} over ${transport.name || 'BLE'}.`, 'BUILDER');
        setStatus('Transferring the new firmware to the board. Keep this tab in the foreground.', 'working', 'Deploying');
        const {identity: rebooted} = await transport.deploy(bytes, {
          buildId: job.buildId, appName: job.appName, appVersion: job.appVersion,
          size: job.firmware.size, crc32: job.firmware.crc32,
        });
        setStatus('Board is back. Verifying identity, build id, app execution and echo.', 'working', 'Verifying');
        const {checks, identity} = await verifyAfterReboot(job, before.id, rebooted);
        setStatus(`Verified on ${identity.id}: ${checks.join('; ')}.`, 'success', 'Verified');
        log(`Deployment verified: ${checks.join('; ')}.`, 'BUILDER', 'success');
        await recordDeployment(job, 'verified', checks.join('; '));
      } catch (error) {
        setStatus(`Deployment not verified: ${error.message}`, 'error', 'Not verified');
        log(error.message, 'BUILDER', 'error');
        await recordDeployment(job, 'failed', error.message);
      } finally {
        state.busy = false;
        refresh();
      }
    }

    async function confirmBoot() {
      state.busy = true;
      refresh();
      try {
        const result = await transport.control(protocol.CONTROL.confirm);
        if (result.status !== 0) throw new Error(`Board refused: ${result.statusText}`);
        await transport.readIdentity();
        log('Boot confirmed; the pending image is now permanent.', 'BUILDER', 'success');
      } catch (error) {
        log(`Confirm failed: ${error.message}`, 'BUILDER', 'error');
      } finally {
        state.busy = false;
        refresh();
      }
    }

    async function rollback() {
      const button = $('aiRollback');
      if (!state.armedRollback || Date.now() - state.armedRollback > 6000) {
        state.armedRollback = Date.now();
        button.textContent = 'Click again to roll back';
        setTimeout(() => { if (state.armedRollback) { state.armedRollback = null; button.textContent = 'Roll back to previous firmware'; } }, 6000);
        return;
      }
      state.armedRollback = null;
      button.textContent = 'Roll back to previous firmware';
      state.busy = true;
      refresh();
      try {
        const result = await transport.control(protocol.CONTROL.rollback);
        if (result.status !== 0) throw new Error(`Board refused the rollback: ${result.statusText}`);
        setStatus('Rollback accepted. The board restarts into its previous firmware; reconnect to verify.', 'working', 'Rolling back');
        log('Rollback accepted by the board.', 'BUILDER', 'success');
      } catch (error) {
        log(error.message, 'BUILDER', 'error');
      } finally {
        state.busy = false;
        refresh();
      }
    }

    function renderExamples() {
      const container = $('aiExamples');
      container.replaceChildren();
      for (const example of EXAMPLES) {
        const chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = example.length > 46 ? `${example.slice(0, 44)}...` : example;
        chip.title = example;
        chip.addEventListener('click', () => { $('aiPrompt').value = example; $('aiPrompt').focus(); });
        container.append(chip);
      }
    }

    $('aiBuild').addEventListener('click', () => { build(); });
    $('aiDeploy').addEventListener('click', () => { deploy(); });
    $('aiConfirm').addEventListener('click', () => { confirmBoot(); });
    $('aiRollback').addEventListener('click', () => { rollback(); });
    $('aiPrompt').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); build(); }
    });
    $('aiBrowserNote').textContent = 'This browser has no Web Bluetooth. You can still build, then download the firmware and follow the Wi-Fi steps, where pairing and upload are manual: hold BOOT, join the board hotspot and upload the file on its own page at http://192.168.4.1. Nothing here pairs or deploys automatically.';
    renderExamples();
    setStatus('Describe the behaviour you want, then build. Deploying always needs an explicit click after review.', 'neutral', 'Idle');
    setProgress(0);
    checkBackend();
    return {refresh, currentJob: () => state.job, checkBackend};
  }

  const api = Object.freeze({mount, EXAMPLES});
  root.AtechBuilder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
