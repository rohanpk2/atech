'use strict';

// Shared dashboard logic for both demos: the device panel, the AI firmware
// builder card and the deployment panel. Deployment order is Wi-Fi (through
// the builder backend on the same origin, so it works in Safari and Chrome),
// then Bluetooth (the demo's own OTA protocol through `transport`), then the
// board's hotspot portal (manual). A failed transfer is never retried on
// another transport silently.
//
//   transport = {
//     name: string,
//     bluetoothAvailable: boolean,
//     isConnected(): boolean,
//     identity(): object | null,            // last identity read over BLE
//     readIdentity(): Promise<object>,      // fresh read over BLE
//     deploy(bytes, meta): Promise<{identity}>,  // BLE OTA + reboot + reconnect
//     control(opcode): Promise<{status, statusText}>,
//   }
(function attachAtechBuilder(root) {
  const POLL_MS = 2000;
  const DEVICE_POLL_MS = 8000;
  const LOOP_WAIT_MS = 10000;
  const STAGE_PROGRESS = {queued: 5, generating: 25, repairing: 45, compiling: 65, validating: 85, ready: 100, failed: 100};
  const EXAMPLES = [
    'Make the onboard LED blink three times quickly, pause for two seconds, and repeat.',
    'Fade the LED from off to purple and back over three seconds, forever.',
    'Show a police strobe: two red flashes, two blue flashes, repeat.',
    'Blink green once per second and log the uptime in seconds on every blink.',
  ];
  const PHASES = [
    ['preflight', 'Checks'], ['uploading', 'Transfer'], ['finishing', 'Image check'], ['rebooting', 'Reboot'],
    ['verifying', 'Verify app'], ['confirming', 'Confirm'], ['verified', 'Done'],
  ];
  const METHOD_NAMES = {wifi: 'Wi-Fi', ble: 'Bluetooth', hotspot: 'Board hotspot'};
  const KEY_STORAGE = 'atechBuilderKey';

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }

  function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`;
    return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'Unknown';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Dashboard key: arrives once as ?key= (printed by the backend for LAN use),
  // then lives in localStorage and a same-site cookie for EventSource/downloads.
  function adoptKey(win) {
    let key = null;
    try {
      const url = new URL(win.location.href);
      const fromUrl = url.searchParams.get('key');
      if (fromUrl) {
        key = fromUrl;
        try { win.localStorage.setItem(KEY_STORAGE, key); } catch (_) { /* private mode */ }
        url.searchParams.delete('key');
        try { win.history.replaceState(null, '', url.pathname + url.search + url.hash); } catch (_) { /* ignore */ }
      } else {
        try { key = win.localStorage.getItem(KEY_STORAGE); } catch (_) { key = null; }
      }
      if (key) win.document.cookie = `atech_key=${encodeURIComponent(key)}; path=/; SameSite=Strict`;
    } catch (_) { /* no window */ }
    return key;
  }

  function mount({demo, transport, log = () => {}, root: doc = root.document}) {
    const $ = id => doc.getElementById(id);
    const protocol = root.AtechIdentity;
    const win = doc.defaultView || root;
    const key = adoptKey(win);
    const state = {
      job: null, source: null, pollTimer: null, busy: false, armedRollback: null, backendOk: false, keyRequired: false,
      devices: [], discovered: [], selectedDeviceId: null, devicePollTimer: null, deviceBusy: false,
      method: null,            // user-forced method or null for automatic
      deployment: null, deploySource: null, deployPollTimer: null, deployingVia: null,
      lastFailure: null,       // {method, message}
      lastVerified: false,     // the current build has been deployed and verified
      bleProgress: null,
    };
    try { state.selectedDeviceId = win.localStorage.getItem(`atechDevice${demo}`); } catch (_) { /* ignore */ }

    async function api(path, init = {}) {
      const headers = {...(init.headers || {})};
      if (key) headers['x-atech-key'] = key;
      const response = await fetch(path, {cache: 'no-store', ...init, headers});
      if (response.status === 401) {
        let body = null;
        try { body = await response.clone().json(); } catch (_) { body = null; }
        if (body && body.keyRequired) {
          state.keyRequired = true;
          $('keyBanner').hidden = false;
          $('keyBanner').textContent = 'This builder needs its dashboard key. Open the link the backend printed at start (it ends with ?key=...), then reload.';
        }
      }
      return response;
    }

    // ---------------------------------------------------------------- builder
    function setStatus(text, tone = 'neutral', badge) {
      $('aiStatus').textContent = text;
      $('aiStatus').className = `state ${tone}`;
      if (badge !== undefined) {
        $('aiBadge').textContent = badge;
        $('aiBadge').className = `badge ${tone === 'neutral' ? 'neutral' : tone}`;
      }
    }

    // Build bar: hidden while idle, indigo shimmer while working, green or red when done.
    function setProgress(percent, tone = 'neutral') {
      const bar = $('aiProgress');
      bar.hidden = percent === 0 && tone === 'neutral';
      bar.className = `progress ai-progress ${tone}`;
      $('aiProgressBar').style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
    }

    // Deployment bar and its numbers: hidden until a transfer starts.
    function setDeployTone(tone) {
      const bar = $('deployProgress');
      bar.hidden = tone === 'neutral';
      bar.className = `progress ${tone}`;
      $('deployMeta').hidden = tone === 'neutral';
    }

    // Step markers: 1 connect, 2 describe, 3 deploy.
    function setStep(id, value) {
      const element = $(id);
      if (element) element.dataset.state = value;
    }

    function renderSteps() {
      const avail = availability();
      const connected = avail.wifi.ok || avail.ble.ok;
      const job = state.job;
      const building = Boolean(job && !['ready', 'failed'].includes(job.state));
      const ready = Boolean(job && job.state === 'ready');
      setStep('stepConnect', connected ? 'done' : 'active');
      setStep('stepDescribe', ready ? 'done' : (building || connected || job) ? 'active' : 'todo');
      setStep('stepDeploy', state.lastVerified ? 'done' : ready ? 'active' : 'todo');
    }

    // ---------------------------------------------------------------- devices
    function selectedDevice() {
      return state.devices.find(d => d.id === state.selectedDeviceId) || null;
    }

    function boardIdentity() {
      // The identity the build should be bound to: the selected LAN device,
      // otherwise the Bluetooth-connected board.
      const device = selectedDevice();
      if (device && device.identity) return device.identity;
      return transport.identity();
    }

    function chooseDevice(id, {persist = true} = {}) {
      state.selectedDeviceId = id;
      if (persist) { try { win.localStorage.setItem(`atechDevice${demo}`, id || ''); } catch (_) { /* ignore */ } }
      renderDevice();
      refresh();
    }

    async function refreshDevices({probe = true} = {}) {
      try {
        const response = await api(`/api/devices${probe ? '?refresh=1' : ''}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        state.devices = (body.devices || []).filter(d => !d.demo || d.demo === demo);
        if (!selectedDevice()) {
          const candidate = state.devices.find(d => d.online) || state.devices[0];
          state.selectedDeviceId = candidate ? candidate.id : null;
        }
      } catch (error) {
        state.devices = [];
      }
      renderDevice();
      refresh();
      return state.devices;
    }

    function startDevicePolling() {
      if (state.devicePollTimer) clearInterval(state.devicePollTimer);
      state.devicePollTimer = setInterval(() => {
        if (state.deployment && !['verified', 'failed', 'aborted'].includes(state.deployment.state)) return;
        refreshDevices({probe: true}).catch(() => {});
      }, DEVICE_POLL_MS);
    }

    function wifiAvailability() {
      const device = selectedDevice();
      if (!state.backendOk) return {ok: false, reason: 'Backend offline.'};
      if (!device) return {ok: false, reason: state.devices.length ? 'Choose a device above.' : 'No board paired yet: click Find devices.'};
      if (!device.paired) return {ok: false, reason: `${device.id} is not paired; enter its OTA authorization code.`};
      if (!device.online || !device.identity) return {ok: false, reason: `${device.name || device.id} is not reachable on this network (${device.lastProbeError || 'no answer'}).`};
      if (device.identity.demo !== demo) return {ok: false, reason: `${device.id} runs Demo ${device.identity.demo}, this dashboard is Demo ${demo}.`};
      if (device.identity.wifi.transferring) return {ok: false, reason: 'The board is busy with another update.'};
      return {ok: true, reason: `${device.name || device.id} at ${device.identity.wifi.ip || device.host}`};
    }

    function bleAvailability() {
      if (!transport.bluetoothAvailable) return {ok: false, reason: 'No Web Bluetooth in this browser (Safari, or an insecure origin).'};
      if (!transport.isConnected()) return {ok: false, reason: 'Click Connect Bluetooth to use the backup path.'};
      const identity = transport.identity();
      if (identity && identity.demo !== demo) return {ok: false, reason: `Connected board runs Demo ${identity.demo}.`};
      return {ok: true, reason: `${identity ? identity.id : 'board'} connected over ${transport.name || 'Bluetooth'}`};
    }

    function availability() {
      return {wifi: wifiAvailability(), ble: bleAvailability(), hotspot: {ok: true, reason: 'Download the file and upload it on the board\'s own page.'}};
    }

    // The method Deploy will use: a user choice when it is available, otherwise
    // the first available in priority order. Never changes during a transfer.
    function effectiveMethod() {
      const avail = availability();
      if (state.method && avail[state.method] && avail[state.method].ok) return state.method;
      if (state.method === 'hotspot') return 'hotspot';
      for (const method of ['wifi', 'ble', 'hotspot']) if (avail[method].ok) return method;
      return 'hotspot';
    }

    function renderDevice() {
      const device = selectedDevice();
      const identity = boardIdentity();
      const bleIdentity = transport.identity();
      const connectedBle = transport.isConnected();
      const dot = $('devDot');
      if (device) {
        $('deviceName').textContent = device.name || `Atech ${device.suffix || device.id.slice(-6)}`;
        const online = device.online && device.identity;
        dot.className = `dot ${online ? 'online' : device.paired ? 'offline' : 'unknown'}`;
        $('devBadge').textContent = online ? (device.simulated ? 'Online (simulated)' : 'Online over Wi-Fi') : device.paired ? 'Offline' : 'Not paired';
        $('devBadge').className = `badge ${online ? 'success' : device.paired ? 'error' : 'neutral'}`;
        $('devStatus').textContent = online
          ? `Online at ${device.identity.wifi.ip || device.host} over Wi-Fi.`
          : device.paired ? `Not reachable right now${device.lastProbeError ? `: ${device.lastProbeError}` : ''}. Power the board and make sure it joined your Wi-Fi.`
                          : 'Pair this board with its OTA authorization code to deploy over Wi-Fi.';
        $('devForget').hidden = false;
      } else if (bleIdentity) {
        $('deviceName').textContent = `Atech ${bleIdentity.suffix}`;
        dot.className = 'dot unknown';
        $('devBadge').textContent = 'Bluetooth only';
        $('devBadge').className = 'badge working';
        $('devStatus').textContent = 'Connected over Bluetooth. Pair it over Wi-Fi with Find devices for faster deployments.';
        $('devForget').hidden = true;
      } else {
        $('deviceName').textContent = 'No board yet';
        dot.className = 'dot';
        $('devBadge').textContent = 'Not found';
        $('devBadge').className = 'badge neutral';
        $('devStatus').textContent = state.backendOk
          ? 'Click Find devices to look for a board on your Wi-Fi, or connect over Bluetooth.'
          : 'Start the builder backend to find boards.';
        $('devForget').hidden = true;
      }
      $('devFacts').hidden = !(device || bleIdentity || connectedBle);
      $('deviceId').textContent = identity ? identity.id : (device ? device.id : 'Unknown');
      $('pairingCode').textContent = identity ? identity.suffix : (device ? (device.suffix || 'Unknown') : 'Unknown');
      const wifi = device && device.identity ? device.identity.wifi : null;
      $('devWifi').textContent = wifi ? (wifi.connected ? `${wifi.ssid || 'connected'} (${wifi.rssi} dBm)` : 'Not connected') : device ? 'Unknown (offline)' : 'Unknown';
      $('devIp').textContent = wifi && wifi.ip ? `${wifi.ip}:${wifi.port}` : device && device.host ? `${device.host} (last known)` : 'Unknown';
      $('firmwareVersion').textContent = identity ? identity.fw || 'Unknown' : device && device.firmware ? device.firmware : 'Unknown';
      if (identity) {
        let appText = `${identity.app} v${identity.ver} (build ${identity.build}, ${identity.appState})`;
        if (identity.safe) appText += ', SAFE MODE';
        if (identity.pending) appText += ', pending confirmation';
        $('appInfo').textContent = appText;
      } else {
        $('appInfo').textContent = device && device.build ? `build ${device.build}` : 'Unknown';
      }
      $('devBle').textContent = connectedBle ? `Connected (${transport.name || 'BLE'})` : transport.bluetoothAvailable ? 'Not connected' : 'Unavailable in this browser';
      $('aiConfirm').hidden = !(identity && identity.pending && (connectedBle || (device && device.online && device.paired)));
      $('aiRollback').hidden = !(identity && identity.canRollback && (connectedBle || (device && device.online && device.paired)));
      renderDeviceList();
    }

    function renderDeviceList() {
      const list = $('devList');
      list.replaceChildren();
      const rows = [];
      for (const device of state.devices) rows.push({...device, kind: 'paired'});
      for (const found of state.discovered) {
        if (found.id && state.devices.some(d => d.id === found.id)) continue;
        rows.push({...found, kind: 'found'});
      }
      // The list only earns its space when there is something to choose or pair.
      const onlyTheSelectedBoard = rows.length === 1 && rows[0].kind === 'paired' && rows[0].id === state.selectedDeviceId;
      list.hidden = rows.length === 0 || onlyTheSelectedBoard;
      for (const row of rows) {
        const element = doc.createElement('div');
        element.className = `device-row${row.id === state.selectedDeviceId ? ' selected' : ''}`;
        const dot = doc.createElement('span');
        dot.className = `dot ${row.kind === 'paired' ? (row.online ? 'online' : 'offline') : 'unknown'}`;
        const name = doc.createElement('strong');
        name.textContent = row.name || `Atech ${row.suffix || (row.id ? row.id.slice(-6) : '?')}`;
        const id = doc.createElement('span');
        id.className = 'mono';
        id.textContent = row.id || 'unknown id';
        const where = doc.createElement('span');
        where.textContent = row.kind === 'paired'
          ? (row.online ? `online at ${row.identity.wifi.ip}` : 'offline')
          : (row.host ? `found at ${row.host}:${row.port}${row.demo ? `, Demo ${row.demo}` : ''}` : 'found by mDNS, no address yet');
        const spacer = doc.createElement('span');
        spacer.className = 'spacer';
        element.append(dot, name, id, where, spacer);
        if (row.kind === 'paired') {
          if (row.id !== state.selectedDeviceId) {
            const use = doc.createElement('button');
            use.type = 'button';
            use.className = 'btn text';
            use.textContent = 'Use this board';
            use.addEventListener('click', () => chooseDevice(row.id));
            element.append(use);
          }
        } else {
          const pair = doc.createElement('button');
          pair.type = 'button';
          pair.className = 'btn secondary';
          pair.textContent = 'Pair';
          pair.addEventListener('click', () => {
            $('devPairForm').hidden = false;
            $('devPairHost').value = row.host ? `${row.host}${row.port && row.port !== 8080 ? `:${row.port}` : ''}` : '';
            $('devPairToken').focus();
          });
          element.append(pair);
        }
        list.append(element);
      }
    }

    async function findDevices() {
      if (state.deviceBusy) return;
      state.deviceBusy = true;
      $('devFind').disabled = true;
      $('devProgress').hidden = false;
      $('devHint').textContent = 'Looking for boards on your Wi-Fi.';
      try {
        const response = await api('/api/devices/discover', {method: 'POST'});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        state.discovered = (body.found || []).filter(f => !f.demo || f.demo === demo);
        await refreshDevices({probe: true});
        const unpaired = state.discovered.filter(f => !f.paired);
        $('devHint').textContent = state.discovered.length
          ? `${state.discovered.length} board(s) found.${unpaired.length ? ' Pair a new board with its OTA authorization code.' : ''}`
          : 'No board answered. Make sure it is powered and on this Wi-Fi (see How to connect a new board), or enter its IP address below.';
        $('devPairForm').hidden = false;
        log(`Discovery found ${state.discovered.length} board(s).`, 'BACKEND');
      } catch (error) {
        $('devHint').textContent = `Search failed: ${error.message}. You can still enter the board's IP address below.`;
        $('devPairForm').hidden = false;
        log(error.message, 'BACKEND', 'error');
      } finally {
        state.deviceBusy = false;
        $('devFind').disabled = false;
        $('devProgress').hidden = true;
        renderDevice();
      }
    }

    async function pairDevice() {
      const raw = $('devPairHost').value.trim();
      const token = $('devPairToken').value.trim();
      if (!raw) { $('devHint').textContent = 'Enter the board IP address (shown on the hotspot page after it joins your Wi-Fi).'; return; }
      if (!token) { $('devHint').textContent = 'Enter the OTA authorization code printed on the serial console at boot.'; $('devPairToken').focus(); return; }
      const match = raw.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
      const host = match ? match[1] : raw;
      const port = match && match[2] ? Number(match[2]) : undefined;
      $('devPair').disabled = true;
      $('devProgress').hidden = false;
      $('devHint').textContent = `Pairing with ${host}.`;
      try {
        const response = await api('/api/devices/pair', {method: 'POST', headers: {'content-type': 'application/json'},
                                                          body: JSON.stringify({host, port, token})});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        $('devPairToken').value = '';
        $('devPairForm').hidden = true;
        state.discovered = state.discovered.filter(f => f.id !== body.device.id);
        await refreshDevices({probe: true});
        chooseDevice(body.device.id);
        $('devHint').textContent = `Paired ${body.device.id}. Deployments will go over Wi-Fi.`;
        log(`Paired ${body.device.id} at ${host}.`, 'BACKEND', 'success');
      } catch (error) {
        $('devHint').textContent = `Pairing failed: ${error.message}`;
        log(`Pairing failed: ${error.message}`, 'BACKEND', 'error');
      } finally {
        $('devPair').disabled = false;
        $('devProgress').hidden = true;
      }
    }

    async function forgetDevice() {
      const device = selectedDevice();
      if (!device) return;
      if (!state.armedForget || Date.now() - state.armedForget > 6000) {
        state.armedForget = Date.now();
        $('devForget').textContent = 'Click again to forget';
        setTimeout(() => { state.armedForget = null; $('devForget').textContent = 'Forget'; }, 6000);
        return;
      }
      state.armedForget = null;
      $('devForget').textContent = 'Forget';
      await api(`/api/devices/${device.id}`, {method: 'DELETE'});
      chooseDevice(null);
      await refreshDevices({probe: false});
    }

    // ---------------------------------------------------------------- deploy UI
    function canDeploy() {
      const job = state.job;
      return Boolean(job && job.state === 'ready' && job.firmware && !state.busy && state.backendOk);
    }

    function deployBlocker() {
      const job = state.job;
      if (!job || job.state !== 'ready') return 'Generate firmware first.';
      const method = effectiveMethod();
      const identity = boardIdentity();
      if (method === 'hotspot') return '';
      if (job.deviceId && identity && job.deviceId !== identity.id) return `This build is bound to ${job.deviceId}; the selected board is ${identity.id}.`;
      if (identity && job.demo !== identity.demo) return `This build is for Demo ${job.demo}; the board runs Demo ${identity.demo}.`;
      if (identity && job.firmware.size > identity.slotSize) return 'The image is larger than the board reports for its OTA slot.';
      return '';
    }

    function renderMethods() {
      const avail = availability();
      const effective = effectiveMethod();
      for (const method of ['wifi', 'ble', 'hotspot']) {
        const button = $(`method${method[0].toUpperCase()}${method.slice(1)}`);
        const note = $(`method${method[0].toUpperCase()}${method.slice(1)}Note`);
        button.classList.toggle('available', avail[method].ok);
        button.classList.toggle('unavailable', !avail[method].ok);
        button.classList.toggle('selected', effective === method);
        button.setAttribute('aria-pressed', String(effective === method));
        button.disabled = state.busy;
        note.textContent = avail[method].reason;
      }
      doc.body.dataset.deployMethod = effective;
      $('wifiTransportPanel').hidden = effective !== 'hotspot';
      $('deployTransport').textContent = `over ${METHOD_NAMES[state.deployingVia || effective]}`;
      const deploy = $('aiDeploy');
      const blocker = deployBlocker();
      deploy.disabled = !canDeploy() || Boolean(blocker);
      deploy.title = blocker;
      deploy.textContent = effective === 'hotspot' ? 'Download firmware for the hotspot portal' : `Deploy over ${METHOD_NAMES[effective]}`;
      if (!state.busy && !state.deployment && state.job && state.job.state === 'ready') {
        if (blocker) $('deployBadge').textContent = 'Blocked';
        else $('deployBadge').textContent = `Ready: ${METHOD_NAMES[effective]}`;
        $('deployBadge').className = `badge ${blocker ? 'error' : 'neutral'}`;
        if (!state.lastFailure) $('deployStatus').textContent = blocker || (effective === 'hotspot'
          ? 'No Wi-Fi or Bluetooth path is available. Download the firmware and follow How to connect a new board in step 1.'
          : `Ready to deploy over ${METHOD_NAMES[effective]}.`);
      }
    }

    function setDeployStatus(text, tone = 'neutral', badge) {
      $('deployStatus').textContent = text;
      $('deployStatus').className = `state ${tone}`;
      if (badge !== undefined) {
        $('deployBadge').textContent = badge;
        $('deployBadge').className = `badge ${tone === 'neutral' ? 'neutral' : tone}`;
      }
    }

    function renderPhases(current, {failed = false} = {}) {
      const container = $('deployPhases');
      container.replaceChildren();
      container.hidden = !current;
      if (!current) return;
      const order = PHASES.map(p => p[0]);
      const index = order.indexOf(current);
      for (const [id, label] of PHASES) {
        const chip = doc.createElement('span');
        const position = order.indexOf(id);
        let cls = '';
        if (current === 'verified' && id === 'verified') cls = 'done';
        else if (position < index) cls = 'done';
        else if (position === index) cls = failed ? 'failed' : 'active';
        chip.className = cls;
        chip.textContent = label;
        container.append(chip);
      }
    }

    function renderTransfer({bytes, total, speedBps, etaMs, percent}) {
      const pct = percent ?? (total ? Math.floor(bytes * 100 / total) : 0);
      $('deployProgressBar').style.width = `${pct}%`;
      $('deployProgress').setAttribute('aria-valuenow', String(pct));
      $('deployPercent').textContent = `${pct}%`;
      $('deployBytes').textContent = total ? `${formatBytes(bytes)} / ${formatBytes(total)}` : formatBytes(bytes);
      $('deploySpeed').textContent = formatSpeed(speedBps || 0);
      $('deployEta').textContent = etaMs === null || etaMs === undefined ? '' : etaMs <= 0 ? 'Done' : `${formatDuration(etaMs)} left`;
    }

    function renderChecks(checks) {
      const list = $('deployChecks');
      list.replaceChildren();
      for (const check of checks || []) {
        const item = doc.createElement('li');
        item.textContent = check;
        list.append(item);
      }
      list.hidden = !(checks && checks.length);
    }

    function renderDeployment(deployment) {
      state.deployment = deployment;
      const stageText = {
        preflight: 'Checking the board and the build.', uploading: 'Sending firmware over Wi-Fi.',
        finishing: 'Board is checking the image.',
        rebooting: 'Board is restarting.', verifying: 'Checking that the new firmware is running.',
        confirming: 'Confirming the boot.', verified: 'Deployed and verified.',
      };
      const failed = deployment.state === 'failed' || deployment.state === 'aborted';
      setDeployTone(failed ? 'error' : deployment.state === 'verified' ? 'success' : 'working');
      renderPhases(deployment.state === 'aborted' ? 'uploading' : deployment.state, {failed});
      renderTransfer({bytes: deployment.acked, total: deployment.total, speedBps: deployment.speedBps, etaMs: deployment.etaMs, percent: deployment.percent});
      renderChecks(deployment.checks);
      const t = deployment.timings || {};
      if (t.transferMs) {
        $('deployTime').textContent = `${formatDuration(t.transferMs)} transfer` +
          (t.rebootMs ? `, ${formatDuration(t.rebootMs)} reboot` : '') + (t.verifyMs ? `, ${formatDuration(t.verifyMs)} verify` : '');
      }
      if (deployment.state === 'verified') {
        setDeployStatus(`Deployed and verified on ${deployment.deviceId}.`, 'success', 'Verified');
      } else if (deployment.state === 'failed') {
        setDeployStatus(`Wi-Fi deployment not verified: ${deployment.error}`, 'error', 'Not verified');
      } else if (deployment.state === 'aborted') {
        setDeployStatus(deployment.error || 'Deployment aborted.', 'error', 'Aborted');
      } else {
        const badge = {queued: 'Starting', preflight: 'Checking', uploading: 'Sending', finishing: 'Checking image',
                       rebooting: 'Restarting', verifying: 'Verifying', confirming: 'Confirming'}[deployment.state] || 'Working';
        setDeployStatus(stageText[deployment.state] || deployment.stage, 'working', badge);
      }
      $('deployAbort').hidden = !['preflight', 'uploading'].includes(deployment.state);
    }

    function stopDeployFollowing() {
      if (state.deploySource) { state.deploySource.close(); state.deploySource = null; }
      if (state.deployPollTimer) { clearInterval(state.deployPollTimer); state.deployPollTimer = null; }
    }

    function followDeployment(id) {
      return new Promise((resolve, reject) => {
        const finished = d => ['verified', 'failed', 'aborted'].includes(d.state);
        const settle = d => { stopDeployFollowing(); resolve(d); };
        const pollOnce = async () => {
          const response = await api(`/api/deployments/${id}`);
          if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
          const d = await response.json();
          renderDeployment(d);
          if (finished(d)) settle(d);
          return d;
        };
        const poll = () => {
          stopDeployFollowing();
          state.deployPollTimer = setInterval(() => pollOnce().catch(error => reject(error)), POLL_MS);
        };
        if (typeof win.EventSource !== 'function') { poll(); return; }
        const source = new win.EventSource(`/api/deployments/${id}/events`);
        state.deploySource = source;
        source.addEventListener('deployment', event => { const d = JSON.parse(event.data); renderDeployment(d); if (finished(d)) settle(d); });
        source.addEventListener('done', () => { pollOnce().catch(() => {}); });
        source.onerror = () => {
          if (state.deploySource !== source) return;
          log('Live deployment stream dropped; polling the backend instead.', 'BACKEND', 'warn');
          poll();
        };
      });
    }

    async function deployWifi(job, device) {
      state.deployingVia = 'wifi';
      renderMethods();
      setDeployTone('working');
      renderPhases('preflight');
      renderTransfer({bytes: 0, total: job.firmware.size, speedBps: 0, etaMs: null});
      renderChecks([]);
      $('deployTime').textContent = '';
      setDeployStatus(`Sending the firmware to ${device.name || device.id} over Wi-Fi.`, 'working', 'Starting');
      const response = await api(`/api/builds/${job.id}/deploy`, {method: 'POST', headers: {'content-type': 'application/json'},
                                                                   body: JSON.stringify({deviceId: device.id})});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      log(`Wi-Fi deployment ${body.id} started for ${device.id}.`, 'BACKEND');
      const result = await followDeployment(body.id);
      if (result.state !== 'verified') {
        const error = new Error(result.error || `Deployment ${result.state}`);
        error.deployment = result;
        throw error;
      }
      const t = result.timings || {};
      log(`Wi-Fi transfer ${formatBytes(result.total)} in ${formatDuration(t.transferMs)} (${formatSpeed(result.speedBps)}); ` +
          `reboot ${formatDuration(t.rebootMs)}; verify ${formatDuration(t.verifyMs)}; total ${formatDuration(t.totalMs)}.`, 'BACKEND', 'success');
      return result;
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
      if (identity.build !== job.buildId) {
        throw new Error(`Board reports build ${identity.build}, expected ${job.buildId}. The new image is not running.`);
      }
      checks.push(`build ${job.buildId} running (app "${identity.app}" v${identity.ver})`);
      if (identity.safe) throw new Error('Board booted into safe mode; the generated app is disabled.');
      const live = await waitForLoops(identity.loops);
      if (!live || live.loops <= identity.loops) {
        throw new Error(`The generated app did not execute (state ${live ? live.appState : 'unknown'}). ` +
                        'The image stays pending; a reset rolls back to the previous firmware.');
      }
      checks.push(`app loop ran ${live.loops - identity.loops} times in the verification window`);
      const echo = await transport.control(protocol.CONTROL.echo);
      if (echo.status !== 0) throw new Error(`Echo failed: ${echo.statusText}`);
      checks.push('echo answered');
      const confirm = await transport.control(protocol.CONTROL.confirm);
      if (confirm.status !== 0) throw new Error(`Confirm failed: ${confirm.statusText}`);
      checks.push(live.pending ? 'boot confirmed, rollback cancelled' : 'boot already confirmed by the core');
      const final = await transport.readIdentity();
      return {checks, identity: final};
    }

    async function deployBle(job) {
      state.deployingVia = 'ble';
      renderMethods();
      const before = transport.identity();
      setDeployTone('working');
      renderPhases('uploading');
      renderChecks([]);
      renderTransfer({bytes: 0, total: job.firmware.size, speedBps: 0, etaMs: null});
      $('deployTime').textContent = '';
      setDeployStatus('Fetching the firmware from the backend.', 'working', 'Starting');
      const response = await api(`/api/builds/${job.id}/firmware.bin`);
      if (!response.ok) throw new Error(`Firmware download failed (HTTP ${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== job.firmware.size) throw new Error('Downloaded image size does not match the build record');
      log(`Deploying ${job.appName} (${formatBytes(bytes.length)}) to ${before.id} over ${transport.name || 'BLE'}.`, 'BUILDER');
      setDeployStatus('Sending the firmware over Bluetooth. Keep this tab in the foreground.', 'working', 'Transferring');
      const startedAt = Date.now();
      let transferMs = null;
      const {identity: rebooted} = await transport.deploy(bytes, {
        buildId: job.buildId, appName: job.appName, appVersion: job.appVersion, size: job.firmware.size, crc32: job.firmware.crc32,
        onProgress: ({bytes: sent, total}) => {
          const elapsed = Math.max(1, Date.now() - startedAt);
          const speed = sent * 1000 / elapsed;
          renderTransfer({bytes: sent, total, speedBps: speed, etaMs: speed > 0 ? (total - sent) / speed * 1000 : null});
        },
        onPhase: phase => {
          if (phase === 'validating') { transferMs = Date.now() - startedAt; $('deployTime').textContent = `${formatDuration(transferMs)} transfer`; renderPhases('finishing'); setDeployStatus('Board is checking the image.', 'working', 'Image check'); }
          if (phase === 'rebooting') { renderPhases('rebooting'); setDeployStatus('Board is restarting.', 'working', 'Rebooting'); }
          if (phase === 'verifying') { renderPhases('verifying'); setDeployStatus('Reconnecting over Bluetooth and checking the new firmware.', 'working', 'Verifying'); }
        },
      });
      renderPhases('verifying');
      setDeployStatus('Board is back. Checking that the new firmware is running.', 'working', 'Verifying');
      const {checks, identity} = await verifyAfterReboot(job, before.id, rebooted);
      renderPhases('verified');
      renderChecks(checks);
      setDeployTone('success');
      setDeployStatus(`Deployed and verified on ${identity.id}.`, 'success', 'Verified');
      log(`Bluetooth deployment verified: ${checks.join('; ')}.`, 'BUILDER', 'success');
      await recordDeployment(job, 'verified', checks.join('; '), 'ble');
      return {checks, identity};
    }

    async function recordDeployment(job, result, detail, transportName) {
      try {
        await api(`/api/builds/${job.id}/deployed`, {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({deviceId: (boardIdentity() || {}).id || '', result, detail, transport: transportName}),
        });
      } catch (_) { /* audit only */ }
    }

    async function deploy() {
      if (!canDeploy()) { setDeployStatus(deployBlocker() || 'Nothing to deploy yet.', 'error'); return; }
      const blocker = deployBlocker();
      if (blocker) { setDeployStatus(blocker, 'error', 'Blocked'); return; }
      const job = state.job;
      const method = effectiveMethod();
      if (method === 'hotspot') {
        $('aiDownload').click();
        $('wifiTransportPanel').hidden = false;
        $('wifiTransportPanel').open = true;
        setDeployStatus('Firmware downloaded. Follow How to connect a new board in step 1 to upload it on the board\'s own page.', 'neutral', 'Manual');
        return;
      }
      state.busy = true;
      state.lastFailure = null;
      state.lastVerified = false;
      state.deployment = null;
      refresh();
      try {
        if (method === 'wifi') await deployWifi(job, selectedDevice());
        else await deployBle(job);
        state.lastVerified = true;
        await refreshDevices({probe: true}).catch(() => {});
      } catch (error) {
        state.lastFailure = {method, message: error.message};
        setDeployTone('error');
        const other = method === 'wifi' ? bleAvailability() : method === 'ble' ? wifiAvailability() : {ok: false};
        const hint = other.ok ? ` ${METHOD_NAMES[method === 'wifi' ? 'ble' : 'wifi']} is available: choose it above and click Deploy again.`
                              : ' The previous firmware keeps running; fix the cause and click Deploy again.';
        setDeployStatus(`${METHOD_NAMES[method]} deployment not verified: ${error.message}.${hint}`, 'error', 'Not verified');
        log(`${METHOD_NAMES[method]} deployment failed: ${error.message}`, 'BUILDER', 'error');
        if (method === 'ble') await recordDeployment(job, 'failed', error.message, 'ble');
      } finally {
        state.busy = false;
        state.deployingVia = null;
        refresh();
      }
    }

    async function abortDeployment() {
      const deployment = state.deployment;
      if (!deployment) return;
      try { await api(`/api/deployments/${deployment.id}/abort`, {method: 'POST'}); log('Abort requested.', 'BACKEND', 'warn'); }
      catch (error) { log(`Abort failed: ${error.message}`, 'BACKEND', 'error'); }
    }

    // ---------------------------------------------------------------- refresh
    function refresh() {
      const identity = boardIdentity();
      const target = $('aiTarget');
      if (identity) {
        let text = `Builds target ${identity.id}.`;
        if (!identity.paired) text += ` Warning: its firmware was built for ${identity.target}.`;
        if (identity.safe) text += ' The board is in safe mode: the app crashed repeatedly and stays off until a new build is deployed or the board is power-cycled.';
        target.textContent = text;
        target.className = identity.safe || !identity.paired ? 'ai-target warn' : 'ai-target';
      } else {
        target.textContent = 'No board selected yet. You can generate now; connecting a board first binds the build to it.';
        target.className = 'ai-target';
      }
      $('aiBrowserNote').hidden = transport.bluetoothAvailable || state.devices.some(d => d.online);
      $('aiBuild').disabled = state.busy || !state.backendOk || (state.job && !['ready', 'failed'].includes(state.job.state));
      $('aiConfirm').disabled = state.busy;
      $('aiRollback').disabled = state.busy;
      renderMethods();
      renderSteps();
    }

    async function checkBackend() {
      try {
        const response = await api('/api/health');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = await response.json();
        state.backendOk = true;
        $('aiBackend').textContent = `Backend online: ${health.provider || 'no provider'} (${health.model || 'no model'})`;
        $('aiBackend').className = 'ai-backend ok';
      } catch (error) {
        state.backendOk = false;
        $('aiBackend').textContent = state.keyRequired
          ? 'Backend reachable but needs its dashboard key.'
          : 'Backend offline. Start it with: cd builder && npm start, then reload this page.';
        $('aiBackend').className = 'ai-backend error';
      }
      refresh();
      if (state.backendOk) { await refreshDevices({probe: true}); startDevicePolling(); }
    }

    // ---------------------------------------------------------------- build
    // Only a failed build shows its reasons; compiler output never appears while a build is running.
    function renderDiagnostics(job) {
      const list = $('aiLog');
      list.replaceChildren();
      const rows = [];
      if (job.state === 'failed') {
        for (const v of job.violations || []) rows.push(['policy', `${v.message}${v.line ? ` (line ${v.line})` : ''}`]);
        for (const d of (job.diagnostics || []).filter(d => d.severity === 'error')) rows.push(['error', d.message]);
      }
      for (const [kind, text] of rows.slice(0, 4)) {
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
                     validating: 'Validating', ready: 'Validated', failed: 'Failed'}[job.state] || job.state;
      setStatus(job.state === 'failed' ? `Build failed: ${job.error}` : job.state === 'ready'
        ? `Firmware ready (${formatBytes(job.firmware.size)}). Deploy it in step 3.` : job.stage || job.state, tone, badge);
      setProgress(STAGE_PROGRESS[job.state] ?? 0, tone);
      $('aiAttempts').textContent = job.attempt > 1 ? `Attempt ${job.attempt} of ${job.maxRepairs + 1}` : '';
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
        download.href = `/api/builds/${job.id}/firmware.bin${key ? `?key=${encodeURIComponent(key)}` : ''}`;
        download.hidden = false;
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
      const response = await api(`/api/builds/${id}`);
      if (!response.ok) throw new Error(`Backend returned HTTP ${response.status}`);
      const job = await response.json();
      render(job);
      if (['ready', 'failed'].includes(job.state)) stopFollowing();
      return job;
    }

    function poll(id) {
      stopFollowing();
      state.pollTimer = setInterval(() => { pollOnce(id).catch(error => log(error.message, 'BUILDER', 'warn')); }, POLL_MS);
    }

    function follow(id) {
      stopFollowing();
      if (typeof win.EventSource !== 'function') { poll(id); return; }
      const source = new win.EventSource(`/api/builds/${id}/events`);
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
      const identity = boardIdentity();
      stopFollowing();
      state.job = null;
      state.lastFailure = null;
      state.lastVerified = false;
      state.deployment = null;
      $('aiReview').hidden = true;
      $('aiDownload').hidden = true;
      $('aiLog').hidden = true;
      setStatus('Starting the build.', 'working', 'Starting');
      setProgress(STAGE_PROGRESS.queued, 'working');
      setDeployTone('neutral');
      renderPhases(null);
      renderChecks([]);
      setDeployStatus('', 'neutral', 'Waiting for a build');
      refresh();
      try {
        const response = await api('/api/builds', {
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

    // ---------------------------------------------------------------- recovery
    async function controlAny(opName) {
      // Prefer the LAN control endpoint when the selected device is online; else BLE.
      const device = selectedDevice();
      if (device && device.online && device.paired) {
        const response = await api(`/api/devices/${device.id}/control`, {method: 'POST', headers: {'content-type': 'application/json'},
                                                                           body: JSON.stringify({op: opName})});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (!body.ok) throw new Error(`Board refused: ${body.status}`);
        await refreshDevices({probe: true});
        return body;
      }
      const result = await transport.control(protocol.CONTROL[opName]);
      if (result.status !== 0) throw new Error(`Board refused: ${result.statusText}`);
      await transport.readIdentity();
      return result;
    }

    async function confirmBoot() {
      state.busy = true;
      refresh();
      try { await controlAny('confirm'); log('Boot confirmed; the pending image is now permanent.', 'BUILDER', 'success'); }
      catch (error) { log(`Confirm failed: ${error.message}`, 'BUILDER', 'error'); }
      finally { state.busy = false; refresh(); }
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
        await controlAny('rollback');
        setDeployStatus('Rollback accepted. The board restarts into its previous firmware; it reappears after the reboot.', 'working', 'Rolling back');
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

    // ---------------------------------------------------------------- wiring
    $('aiBuild').addEventListener('click', () => { build(); });
    $('aiDeploy').addEventListener('click', () => { deploy(); });
    $('deployAbort').addEventListener('click', () => { abortDeployment(); });
    $('aiConfirm').addEventListener('click', () => { confirmBoot(); });
    $('aiRollback').addEventListener('click', () => { rollback(); });
    $('devFind').addEventListener('click', () => { findDevices(); });
    $('devPair').addEventListener('click', () => { pairDevice(); });
    $('devPairToken').addEventListener('keydown', event => { if (event.key === 'Enter') pairDevice(); });
    $('devForget').addEventListener('click', () => { forgetDevice(); });
    for (const method of ['wifi', 'ble', 'hotspot']) {
      $(`method${method[0].toUpperCase()}${method.slice(1)}`).addEventListener('click', () => {
        if (state.busy) return;
        state.method = state.method === method ? null : method;
        state.lastFailure = null;
        refresh();
      });
    }
    $('aiPrompt').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); build(); }
    });
    $('aiBrowserNote').textContent = 'This browser has no Web Bluetooth, so the Bluetooth backup is unavailable here. Wi-Fi deployment works in Safari and Chrome once the board is on your Wi-Fi and paired. Otherwise download the firmware and use the hotspot steps, where pairing and upload are manual.';
    renderExamples();
    setStatus('', 'neutral', 'Idle');
    setProgress(0);
    setDeployTone('neutral');
    renderPhases(null);
    renderDevice();
    refresh();
    checkBackend();
    return {refresh, currentJob: () => state.job, checkBackend, refreshDevices, selectedDevice, effectiveMethod,
            chooseMethod: method => { state.method = method; refresh(); }, state};
  }

  const api = Object.freeze({mount, EXAMPLES, formatBytes, formatDuration, formatSpeed});
  root.AtechBuilder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
