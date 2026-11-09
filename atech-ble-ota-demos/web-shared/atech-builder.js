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
  // Hosted: the backend counts a board as online only when it answered a probe in the last 20 s,
  // so the timer must keep probing; 15 s keeps that state accurate with half the requests of 8 s.
  const HOSTED_DEVICE_POLL_MS = 15000;
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
  // Cloud jobs (the board pulls the image from the backend): states and copy.
  const CLOUD_PHASES = [['pending', 'Queued'], ['downloading', 'Download'], ['installing', 'Install'], ['rebooting', 'Reboot'], ['succeeded', 'Done']];
  const CLOUD_BADGES = {pending: 'Queued', offline: 'Offline', downloading: 'Downloading', installing: 'Installing', rebooting: 'Restarting',
                        succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled'};
  const CLOUD_STAGE = {
    pending: 'Waiting for the board to pick up the job.', offline: 'The board is offline; the job waits for it to come online.',
    downloading: 'The board is downloading the firmware.', installing: 'The board is checking and installing the image.',
    rebooting: 'The board is restarting into the new firmware.', cancelled: 'Job cancelled before the board picked it up.',
  };
  const DEVICE_ID = /^ATECH-[0-9A-F]{12}$/;
  const KEY_STORAGE = 'atechBuilderKey';
  // Wi-Fi setup over Bluetooth: how often the board's status is read while it joins, and how
  // long a join is given before the dashboard stops waiting for it.
  const PROV_POLL_MS = 1500;
  const PROV_JOIN_TIMEOUT_MS = 45000;

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

  // "4 s ago", "2 min ago", "3 h ago", "5 d ago", "never".
  function formatAgo(iso) {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds} s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  // How the backend reaches (or is reached by) a registered board: 'lan' when the backend
  // probes it on the local network, 'cloud' when the board polls the backend. The hosted
  // dashboard prefers the cloud path for every cloud-registered board: a real board is never on
  // the cloud host's own network, so a LAN view there only happens for the simulated boards.
  function deviceVia(device, preferCloud = false) {
    if (!device) return null;
    const registered = Boolean(device.cloud && device.cloud.registered);
    if (preferCloud && registered) return 'cloud';
    if (device.via === 'lan') return 'lan';
    if (device.via === 'cloud' || registered || (!device.host && device.cloud)) return 'cloud';
    return 'lan';
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
    // Runtime configuration from /shared/atech-config.js (window.ATECH_CONFIG). The backend serves
    // the local default; the Vercel build writes transport 'poll' and hosted true. apiBase is a
    // same-origin path prefix, normally empty.
    const cfg = root.ATECH_CONFIG || {};
    const apiBase = String(cfg.apiBase || '').replace(/\/+$/, '');
    const usePolling = cfg.transport === 'poll';
    const hosted = Boolean(cfg.hosted);
    const pollMs = Number(cfg.pollMs) || POLL_MS;
    const devicePollMs = hosted ? HOSTED_DEVICE_POLL_MS : DEVICE_POLL_MS;
    const provPollMs = Number(cfg.provPollMs) || PROV_POLL_MS;
    function apiUrl(path) { return apiBase + path; }
    const reach = device => deviceVia(device, hosted);
    // Hosted: the proxy adds the backend key itself, so a key left in this browser by an old
    // ?key= link is ignored and never sent.
    const key = hosted ? null : adoptKey(win);
    const state = {
      job: null, source: null, pollTimer: null, busy: false, armedRollback: null, backendOk: false, keyRequired: false,
      devices: [], discovered: [], unclaimed: [], selectedDeviceId: null, devicePollTimer: null, deviceBusy: false,
      method: null,            // user-forced method or null for automatic
      deployment: null, deploySource: null, deployPollTimer: null, deployingVia: null, deployTransport: null,
      lastFailure: null,       // {method, message}
      lastVerified: false,     // the current build has been deployed and verified
      bleProgress: null,
      publicUrl: null,         // the backend's public origin, provisioned into boards as the cloud server
      // Wi-Fi setup over Bluetooth: one encrypted session per connection, the board's last status.
      prov: {session: null, status: null, busy: false, timer: null, joinUntil: 0, ticks: 0},
      // Board connections (AtechSync): the last status read over Bluetooth, the hook it came from,
      // the change subscription and the pairing code offered to the next board.
      sync: {status: null, busy: false, timer: null, unsubscribe: null, hookRef: null, hello: null, prefilled: '', armedUnpair: null},
    };
    try { state.selectedDeviceId = win.localStorage.getItem(`atechDevice${demo}`); } catch (_) { /* ignore */ }

    async function api(path, init = {}) {
      const headers = {...(init.headers || {})};
      if (key) headers['x-atech-key'] = key;
      const response = await fetch(apiUrl(path), {cache: 'no-store', ...init, headers});
      if (response.status === 401) {
        let body = null;
        try { body = await response.clone().json(); } catch (_) { body = null; }
        if (body && body.keyRequired) {
          state.keyRequired = true;
          $('keyBanner').hidden = false;
          $('keyBanner').textContent = hosted
            ? 'The build service rejected this dashboard\'s key. The Vercel environment variable ATECH_BUILDER_KEY must match the backend\'s key.'
            : 'This builder needs its dashboard key. Open the link the backend printed at start (it ends with ?key=...), then reload.';
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
        state.unclaimed = (body.unclaimed || []).filter(u => !u.demo || u.demo === demo);
        if (!selectedDevice()) {
          const candidate = state.devices.find(d => d.online) || state.devices[0];
          state.selectedDeviceId = candidate ? candidate.id : null;
        }
      } catch (error) {
        state.devices = [];
        state.unclaimed = [];
      }
      renderDevice();
      refresh();
      attachActiveDeployment();
      return state.devices;
    }

    function startDevicePolling() {
      if (state.devicePollTimer) clearInterval(state.devicePollTimer);
      state.devicePollTimer = setInterval(() => {
        if (state.deployment && !['verified', 'failed', 'aborted'].includes(state.deployment.state)) return;
        refreshDevices({probe: true}).catch(() => {});
      }, devicePollMs);
    }

    function wifiAvailability() {
      const device = selectedDevice();
      if (!state.backendOk) return {ok: false, reason: 'Backend offline.'};
      if (!device) {
        if (hosted) {
          return {ok: false, reason: state.unclaimed.length ? 'A board is waiting to be claimed: claim it in step 1.'
                                                           : 'No board claimed yet. Claim one in step 1 to deploy through the cloud.'};
        }
        return {ok: false, reason: state.devices.length ? 'Choose a device above.' : 'No board paired yet: click Find devices.'};
      }
      if (!device.paired) return {ok: false, reason: `${device.id} is not paired; enter its OTA authorization code.`};
      const identity = device.identity;
      if (identity && identity.demo !== demo) return {ok: false, reason: `${device.id} runs Demo ${identity.demo}, this dashboard is Demo ${demo}.`};
      const name = device.name || device.id;
      if (reach(device) === 'cloud') {
        const lastSeen = formatAgo(device.cloud && device.cloud.lastSeenAt);
        if (device.cloud && device.cloud.lastAuthFailureAt) {
          return {ok: false, via: 'cloud', reason: `${name} is online with a different pairing token; claim it again with the code from its serial console.`};
        }
        if (identity && identity.wifi && identity.wifi.transferring) return {ok: false, via: 'cloud', reason: 'The board is busy with another update.'};
        if (device.online) return {ok: true, via: 'cloud', offline: false, reason: `${name} online via the cloud (seen ${lastSeen}).`};
        return {ok: true, via: 'cloud', offline: true, reason: `${name} is offline (last seen ${lastSeen}); the job waits for it.`};
      }
      if (!device.online || !identity) return {ok: false, via: 'lan', reason: `${name} is not reachable on this network (${device.lastProbeError || 'no answer'}).`};
      if (identity.wifi.transferring) return {ok: false, via: 'lan', reason: 'The board is busy with another update.'};
      return {ok: true, via: 'lan', offline: false, reason: `${name} at ${identity.wifi.ip || device.host}`};
    }

    // "Cloud Wi-Fi" when the selected board is reached through the cloud, "Wi-Fi" on the LAN.
    function methodLabel(method) {
      if (method === 'wifi') return reach(selectedDevice()) === 'cloud' ? 'Cloud Wi-Fi' : 'Wi-Fi';
      return METHOD_NAMES[method] || method;
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
      const via = reach(device);
      if (device && via === 'cloud') {
        $('deviceName').textContent = device.name || `Atech ${device.suffix || device.id.slice(-6)}`;
        const online = Boolean(device.online);
        const lastSeen = formatAgo(device.cloud && device.cloud.lastSeenAt);
        dot.className = `dot ${online ? 'online' : 'offline'}`;
        $('devBadge').textContent = online ? (device.simulated ? 'Online (simulated)' : 'Online via cloud') : 'Offline';
        $('devBadge').className = `badge ${online ? 'success' : 'error'}`;
        let status = online ? `Online through the cloud, seen ${lastSeen}.`
          : `Offline. Last seen ${lastSeen}. The board polls the cloud every 15 s when it is powered and on Wi-Fi.`;
        if (device.cloud && device.cloud.lastAuthFailureAt) status += ' The board\'s pairing token differs from the one entered; claim it again.';
        else if (device.cloud && device.cloud.verified === false) status += ' Waiting for its first contact to verify the pairing token.';
        $('devStatus').textContent = status;
        $('devForget').hidden = false;
      } else if (device) {
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
        $('devStatus').textContent = hosted
          ? 'Connected over Bluetooth. Claim the board in step 1 to deploy through the cloud instead.'
          : 'Connected over Bluetooth. Pair it over Wi-Fi with Find devices for faster deployments.';
        $('devForget').hidden = true;
      } else {
        $('deviceName').textContent = 'No board yet';
        dot.className = 'dot';
        $('devBadge').textContent = 'Not found';
        $('devBadge').className = 'badge neutral';
        $('devStatus').textContent = hosted
          ? 'No board registered yet. Claim your board with its ID and pairing token, or connect over Bluetooth in Chrome or Edge.'
          : state.backendOk
            ? 'Click Find devices to look for a board on your Wi-Fi, or connect over Bluetooth.'
            : 'Start the builder backend to find boards.';
        $('devForget').hidden = true;
      }
      $('devFind').hidden = hosted;   // mDNS discovery would run on the cloud host, not on the user's Wi-Fi
      $('devClaimOpen').hidden = !state.backendOk || !$('devClaimForm').hidden;
      $('devFacts').hidden = !(device || bleIdentity || connectedBle);
      $('deviceId').textContent = identity ? identity.id : (device ? device.id : 'Unknown');
      $('pairingCode').textContent = identity ? identity.suffix : (device ? (device.suffix || 'Unknown') : 'Unknown');
      const wifi = device && device.identity ? device.identity.wifi : null;
      const heap = identity && identity.heap ? `, ${formatBytes(identity.heap)} free RAM` : '';
      $('devWifi').textContent = wifi ? (wifi.connected ? `${wifi.ssid || 'connected'} (${wifi.rssi} dBm)${heap}` : 'Not connected') : device ? 'Unknown (offline)' : 'Unknown';
      $('devIp').textContent = via === 'cloud' ? 'Through the cloud (the board calls the build service)'
        : wifi && wifi.ip ? `${wifi.ip}:${wifi.port}` : device && device.host ? `${device.host} (last known)` : 'Unknown';
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
      // Recovery controls need a command path: Bluetooth or the LAN service. A board reached only
      // through the cloud recovers on its own (automatic rollback) or by deploying another build.
      const canControl = connectedBle || (device && device.online && device.paired && via === 'lan');
      $('aiConfirm').hidden = !(identity && identity.pending && canControl);
      $('aiRollback').hidden = !(identity && identity.canRollback && canControl);
      renderDeviceList();
      renderProv();
      renderSync();
    }

    // ---------------------------------------------------------------- Wi-Fi setup over Bluetooth
    // The transport exposes `provisioning` when the connected board has the provisioning service:
    // {available(), session() -> AtechProvision session, readStatus() -> status JSON}. The Wi-Fi
    // password goes into one encrypted request and nowhere else: not the log, not storage, not the
    // backend. The board's token comes back inside the same session and is used once, to claim.
    function provisioning() {
      const hook = transport.provisioning;
      if (!hook || typeof hook.available !== 'function' || !hook.available() || !transport.isConnected()) return null;
      return hook;
    }

    function provSession() {
      const hook = provisioning();
      if (!hook) throw new Error('Connect the board over Bluetooth first');
      // A session belongs to one board: a different hook (another board connected) starts afresh.
      if (state.prov.session && state.prov.sessionHook !== hook) dropProvSession();
      if (!state.prov.session) { state.prov.session = hook.session(); state.prov.sessionHook = hook; }
      return state.prov.session;
    }

    function dropProvSession() {
      state.sync.hello = null;
      if (!state.prov.session) return;
      try { state.prov.session.close(); } catch (_) { /* ignore */ }
      state.prov.session = null;
      state.prov.sessionHook = null;
    }

    function cloudWords(cloud) {
      if (!cloud) return 'unknown';
      if (cloud.session) return 'online';
      switch (cloud.state) {
        case 'unclaimed': return 'waiting to be claimed';
        case 'waiting_wifi': return 'waiting for Wi-Fi';
        case 'disabled': return cloud.url ? 'starting' : 'not set up';
        case 'error': return cloud.last_error ? `error: ${cloud.last_error}` : 'error';
        default: return cloud.state || 'unknown';
      }
    }

    function stopProvPolling() {
      if (state.prov.timer) { clearInterval(state.prov.timer); state.prov.timer = null; }
    }

    function startProvPolling() {
      if (state.prov.timer) return;
      state.prov.ticks = 0;
      state.prov.timer = setInterval(() => {
        // Every tick while a join is in progress, every fourth tick otherwise.
        const joining = state.prov.joinUntil > Date.now();
        if (!joining && (++state.prov.ticks % 4) !== 0) return;
        pollProvStatus().catch(() => {});
      }, provPollMs);
      pollProvStatus().catch(() => {});
    }

    // A Bluetooth transfer owns the link: no status reads are interleaved with the OTA stream
    // (Android Chrome allows one GATT operation at a time; the board's host task stays free).
    function transferInFlight() {
      return state.busy || Boolean(typeof transport.transferring === 'function' && transport.transferring());
    }

    async function pollProvStatus() {
      const hook = provisioning();
      if (!hook) { renderProv(); return; }
      if (state.prov.busy || transferInFlight()) return;
      try { state.prov.status = await hook.readStatus(); }
      catch (_) { /* keep the previous status; the next tick tries again */ }
      const s = state.prov.status;
      if (s && state.prov.joinUntil) {
        const settled = s.wifi.connected || (s.wifi.reason && !s.wifi.connected);
        if (settled || Date.now() > state.prov.joinUntil) {
          state.prov.joinUntil = 0;
          if (s.wifi.connected) log(`Board joined ${s.wifi.ssid} as ${s.wifi.ip}; cloud ${cloudWords(s.cloud)}.`, 'BLUETOOTH', 'success');
          else if (s.wifi.reason) log(`Board could not join ${s.wifi.ssid} (reason ${s.wifi.reason}).`, 'BLUETOOTH', 'error');
          else log('The board did not report a Wi-Fi join within 45 s; it keeps trying on its own.', 'BLUETOOTH', 'warn');
          refreshDevices({probe: !hosted}).catch(() => {});
        }
      }
      renderProv();
    }

    function renderProv() {
      const panel = $('provPanel');
      if (!panel) return;
      const hook = provisioning();
      if (!hook) {
        panel.hidden = true;
        stopProvPolling();
        dropProvSession();
        state.prov.status = null;
        state.prov.joinUntil = 0;
        return;
      }
      panel.hidden = false;
      const s = state.prov.status;
      const joining = state.prov.joinUntil > Date.now();
      let text;
      let tone = 'neutral';
      if (!s) {
        text = 'Checking the board\'s Wi-Fi.';
      } else if (s.wifi.connected) {
        text = `On ${s.wifi.ssid || 'Wi-Fi'} (${s.wifi.ip}), cloud ${cloudWords(s.cloud)}.`;
        tone = s.cloud.session ? 'success' : 'neutral';
      } else if (s.wifi.configured && s.wifi.reason && !joining) {
        text = `Could not join ${s.wifi.ssid} (reason ${s.wifi.reason}). Check the password and try again.`;
        tone = 'error';
      } else if (s.wifi.configured) {
        text = `Joining ${s.wifi.ssid}.`;
        tone = 'working';
      } else {
        text = 'Not on Wi-Fi yet. Enter your 2.4 GHz network and its password.';
      }
      if (s && s.busy) text += ' The board is busy with an update.';
      $('provState').textContent = text;
      $('provState').className = `state ${tone}`;
      $('provProgress').hidden = !(state.prov.busy || (joining && !(s && s.wifi.connected)));
      $('provJoin').disabled = state.prov.busy;
      $('provScan').disabled = state.prov.busy;
      $('provForget').hidden = !(s && s.wifi.configured) || state.prov.busy;
      startProvPolling();
    }

    function provBoardId() {
      if (state.prov.status && DEVICE_ID.test(state.prov.status.id || '')) return state.prov.status.id;
      const identity = transport.identity();
      return identity && DEVICE_ID.test(identity.id) ? identity.id : null;
    }

    // The owner grant for an owned board: minted by the backend for the board's owner only.
    async function provGrant(id, hello) {
      const response = await api(`/api/devices/${id}/provision-grant`, {method: 'POST', headers: {'content-type': 'application/json'},
                                                                        body: JSON.stringify({nonce: hello.nonce, transcript: hello.transcript})});
      let body = {};
      try { body = await response.json(); } catch (_) { body = {}; }
      if (response.ok && body.grant) return {grant: body.grant, denied: null};
      return {grant: null, denied: body.error || `HTTP ${response.status}`};
    }

    async function scanWifi() {
      if (!provisioning() || state.prov.busy) return;
      state.prov.busy = true;
      $('provHint').textContent = 'Looking for networks nearby.';
      renderProv();
      try {
        const networks = await provSession().scan();
        const list = $('provNetworks');
        list.replaceChildren();
        for (const network of networks) {
          const option = doc.createElement('option');
          option.value = network.ssid;
          option.label = `${network.rssi} dBm${network.open ? ', open' : ''}`;
          list.append(option);
        }
        $('provHint').textContent = networks.length
          ? `${networks.length} network${networks.length === 1 ? '' : 's'} found. Pick yours, enter its password and click Join Wi-Fi.`
          : 'No 2.4 GHz network found nearby. Type the network name.';
        if (networks.length && !$('provSsid').value) $('provSsid').value = networks[0].ssid;
      } catch (error) {
        $('provHint').textContent = `Scan failed: ${error.message}`;
        dropProvSession();
      } finally {
        state.prov.busy = false;
        renderProv();
      }
    }

    async function joinWifi() {
      const hook = provisioning();
      if (!hook || state.prov.busy) return;
      const ssid = $('provSsid').value.trim();
      const secret = $('provPassword').value;
      if (!ssid || ssid.length > 32) { $('provHint').textContent = 'Enter the network name (1 to 32 characters).'; $('provSsid').focus(); return; }
      if (secret && (secret.length < 8 || secret.length > 63)) {
        $('provHint').textContent = 'Wi-Fi password must contain 8 to 63 characters (or be empty for an open network).';
        $('provPassword').focus();
        return;
      }
      state.prov.busy = true;
      $('provHint').textContent = '';
      renderProv();
      try {
        const session = provSession();
        const hello = await session.hello();
        const id = provBoardId();
        // Claim unless this dashboard user already owns the board: a record without an owner
        // (paired over the LAN before ownership existed) is claimed so it gets one.
        const known = id ? state.devices.find(d => d.id === id && d.paired && d.ownerId != null) : null;
        const payload = {ssid, pass: secret, claim: !known};
        if (state.publicUrl) payload.url = state.publicUrl;
        let denied = null;
        if (hello.locked && id) {
          const result = await provGrant(id, hello);
          if (result.grant) payload.grant = result.grant; else denied = result.denied;
        }
        if (hello.locked && !payload.grant) {
          // Only a fresh BOOT press lets the board accept this; otherwise the password stays here.
          let fresh = null;
          try { fresh = await hook.readStatus(); } catch (_) { fresh = null; }
          if (!(fresh && Number(fresh.unlock_ms) > 0)) {
            $('provPassword').value = '';
            $('provHint').textContent = `${denied ? `${denied}. ` : ''}This board already has an owner. Press the BOOT button on the board once, then click Join Wi-Fi again within two minutes.`;
            log('Wi-Fi setup not sent: the board has another owner and no BOOT press was seen.', 'BLUETOOTH', 'warn');
            return;
          }
        }
        $('provPassword').value = '';
        const reply = await session.provision(payload);
        payload.pass = null;
        if (!reply.ok) {
          const error = reply.error || 'The board refused the request';
          $('provHint').textContent = /locked/i.test(error)
            ? `${denied ? `${denied}. ` : ''}Press the BOOT button on the board once, then click Join Wi-Fi again within two minutes.`
            : error;
          log(`Wi-Fi setup refused by the board: ${error}.`, 'BLUETOOTH', 'error');
          return;
        }
        state.prov.joinUntil = Date.now() + PROV_JOIN_TIMEOUT_MS;
        log(`Wi-Fi credentials for ${ssid} sent to the board over Bluetooth${payload.url ? ', with the build service address' : ''}.`, 'BLUETOOTH', 'success');
        $('provHint').textContent = state.publicUrl ? '' : 'The build service has no public address (ATECH_PUBLIC_URL), so this board cannot reach it for cloud deployments yet.';
        if (reply.token && id) {
          const response = await api('/api/devices/claim', {method: 'POST', headers: {'content-type': 'application/json'},
                                                             body: JSON.stringify({id, token: reply.token, name: ''})});
          let body = {};
          try { body = await response.json(); } catch (_) { body = {}; }
          if (response.ok) {
            log(`Claimed ${id} in this dashboard; it is verified at the board's first cloud login.`, 'BACKEND', 'success');
            chooseDevice(id, {persist: true});
            await refreshDevices({probe: false});
          } else {
            $('provHint').textContent = `The board joined, but claiming it failed: ${body.error || `HTTP ${response.status}`}`;
            log(`Claim failed: ${body.error || response.status}`, 'BACKEND', 'error');
          }
        }
      } catch (error) {
        $('provHint').textContent = `Wi-Fi setup failed: ${error.message}`;
        log(`Wi-Fi setup failed: ${error.message}`, 'BLUETOOTH', 'error');
        dropProvSession();
      } finally {
        $('provPassword').value = '';
        state.prov.busy = false;
        renderProv();
        pollProvStatus().catch(() => {});
      }
    }

    async function forgetWifi() {
      if (!provisioning() || state.prov.busy) return;
      if (!state.armedForgetWifi || Date.now() - state.armedForgetWifi > 6000) {
        state.armedForgetWifi = Date.now();
        $('provForget').textContent = 'Click again to forget Wi-Fi';
        setTimeout(() => { state.armedForgetWifi = null; $('provForget').textContent = 'Forget Wi-Fi'; }, 6000);
        return;
      }
      state.armedForgetWifi = null;
      $('provForget').textContent = 'Forget Wi-Fi';
      state.prov.busy = true;
      renderProv();
      try {
        const session = provSession();
        const hello = await session.hello();
        const payload = {wifi: true};
        const id = provBoardId();
        if (hello.locked && id) { const result = await provGrant(id, hello); if (result.grant) payload.grant = result.grant; }
        const reply = await session.forget(payload);
        $('provHint').textContent = reply.ok ? 'The board forgot its Wi-Fi.' : /locked/i.test(reply.error || '') ? 'Press the BOOT button on the board once, then try again.' : reply.error;
        log(reply.ok ? 'Board forgot its Wi-Fi credentials.' : `Forget refused: ${reply.error}`, 'BLUETOOTH', reply.ok ? 'success' : 'error');
      } catch (error) {
        $('provHint').textContent = `Could not forget Wi-Fi: ${error.message}`;
        dropProvSession();
      } finally {
        state.prov.busy = false;
        renderProv();
        pollProvStatus().catch(() => {});
      }
    }

    // ---------------------------------------------------------------- Board connections (AtechSync)
    // The transport exposes `sync` when the connected board has the sync status service:
    // {available(), readStatus() -> status JSON, subscribe(handler) -> unsubscribe}. Commands go
    // through the Bluetooth setup session (sealed; pairing changes carry the owner grant, like a
    // Wi-Fi change) when the board is connected over Bluetooth, else through the backend, which
    // relays them over the LAN or queues them for the board's next cloud poll. "Paired" is
    // configuration; "Connected" means a frame from the peer in the last few seconds, nothing less.
    const syncModule = root.AtechSync;
    const DEMO_KEY = syncModule ? syncModule.DEMO_KEY : 'demo.power';

    function syncHook() {
      const hook = transport.sync;
      if (!hook || typeof hook.available !== 'function' || !hook.available() || !transport.isConnected()) return null;
      return hook;
    }

    function syncSource() {
      if (!syncModule) return null;
      if (syncHook()) return 'ble';
      const device = selectedDevice();
      if (device && device.identity && device.identity.sync) return 'backend';
      return null;
    }

    function syncBoardId() {
      if (syncSource() === 'backend') return selectedDevice().id;
      const identity = transport.identity();
      return identity && DEVICE_ID.test(identity.id) ? identity.id : '';
    }

    function currentSyncStatus() {
      const source = syncSource();
      if (!source) return null;
      if (source === 'ble') return state.sync.status ? syncModule.normalizeStatus(state.sync.status, syncBoardId()) : null;
      const device = selectedDevice();
      return syncModule.normalizeStatus(device.identity.sync, device.id);
    }

    function formatAgoMs(ms) {
      const seconds = Math.max(0, Math.round(ms / 1000));
      if (seconds < 60) return `${seconds} s ago`;
      if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
      return `${Math.round(seconds / 3600)} h ago`;
    }

    function storedSyncCode() {
      try { return syncModule.loadCode(win.sessionStorage); } catch (_) { return null; }
    }

    function stopSyncPolling() {
      if (state.sync.timer) { clearInterval(state.sync.timer); state.sync.timer = null; }
    }

    function unsubscribeSync() {
      if (state.sync.unsubscribe) { try { state.sync.unsubscribe(); } catch (_) { /* ignore */ } }
      state.sync.unsubscribe = null;
      state.sync.hookRef = null;
    }

    async function pollSyncStatus() {
      const hook = syncHook();
      if (!hook || state.sync.busy || transferInFlight()) return;
      try { state.sync.status = await hook.readStatus(); } catch (_) { /* keep the previous status */ }
      renderSync();
    }

    function onSyncChange(bytes) {
      const change = syncModule.parseChange(bytes);
      if (!change) return;
      if (change.k !== undefined) {
        if (state.sync.status) {
          if (!state.sync.status.state || typeof state.sync.status.state !== 'object') state.sync.status.state = {};
          state.sync.status.state[change.k] = {v: change.v, t: change.t, rev: change.rev, by: change.by};
        }
        log(`${change.k} is now ${change.v}${change.remote ? ` (changed on ${change.by})` : ' (set on this board)'}.`, 'BOARD SYNC');
        renderSync();
      } else if (change.peer) {
        log(`Peer ${change.peer}: ${change.state}.`, 'BOARD SYNC', change.state === 'connected' ? 'success' : 'warn');
        pollSyncStatus().catch(() => {});
      } else if (change.event) {
        log(`Event ${change.event} from ${change.from}${change.payload ? ` (${change.payload})` : ''}.`, 'BOARD SYNC');
      }
    }

    // Keeps the Bluetooth status fresh: one subscription per hook and a slow read, so a board
    // swapped under the same dashboard is never shown with the previous board's status.
    function trackSyncHook(hook) {
      if (state.sync.hookRef === hook) return;
      unsubscribeSync();
      state.sync.status = null;
      state.sync.hookRef = hook;
      if (typeof hook.subscribe === 'function') { try { state.sync.unsubscribe = hook.subscribe(onSyncChange); } catch (_) { state.sync.unsubscribe = null; } }
      if (!state.sync.timer) state.sync.timer = setInterval(() => { pollSyncStatus().catch(() => {}); }, provPollMs * 2);
      pollSyncStatus().catch(() => {});
    }

    function renderSync() {
      const panel = $('syncPanel');
      if (!panel) return;
      const source = syncSource();
      if (!source) {
        panel.hidden = true;
        stopSyncPolling();
        unsubscribeSync();
        state.sync.status = null;
        return;
      }
      panel.hidden = false;
      if (source === 'ble') trackSyncHook(syncHook());
      else { stopSyncPolling(); unsubscribeSync(); }
      const s = currentSyncStatus();
      const id = (s && s.id) || syncBoardId();
      $('syncSelf').textContent = id || 'Unknown';
      let badge = 'Not paired';
      let tone = 'neutral';
      let text;
      if (!s) {
        badge = 'Reading';
        text = 'Reading the board\'s connection status.';
      } else if (s.paired && s.connected) {
        badge = 'Connected'; tone = 'success';
        text = `Communicating with ${s.peer} over ESP-NOW.`;
      } else if (s.paired && s.peerState === 'pairing') {
        badge = 'Pairing'; tone = 'working';
        text = `Waiting for ${s.peer} to confirm the pairing. Make sure it is powered on and nearby.`;
      } else if (s.paired) {
        badge = 'Paired, not communicating'; tone = 'error';
        text = `Paired with ${s.peer}, but no answer in the last few seconds. Power it on, and keep both boards on the same Wi-Fi network or both off Wi-Fi.`;
      } else {
        text = 'Not paired. Click Connect another board to get a pairing code, then pair the second board with it.';
      }
      if (s && s.paused) text += ' Paused while a firmware update runs.';
      if (s && s.channelMismatch) text += ' The boards are on different Wi-Fi channels: they must share one network or both leave Wi-Fi.';
      $('syncBadge').textContent = badge;
      $('syncBadge').className = `badge ${tone}`;
      $('syncState').textContent = text;
      $('syncState').className = `state ${tone}`;
      $('syncPeer').textContent = s && s.peer ? s.peer : 'None';
      $('syncLink').textContent = !s ? 'Unknown' : s.lastAckAgoMs === null ? 'Unknown' : s.lastAckAgoMs < 0 ? 'Never' : formatAgoMs(s.lastAckAgoMs);
      const value = s ? s.value : null;
      $('syncValue').textContent = value === null ? 'Not set yet' : value === 'true' ? 'On' : value === 'false' ? 'Off' : value;
      $('syncToggle').textContent = `Turn ${DEMO_KEY} ${value === 'true' ? 'off' : 'on'}`;
      $('syncToggle').disabled = state.sync.busy || !s;   // never a blind toggle before a status exists
      $('syncConnect').disabled = state.sync.busy;
      $('syncUnpair').hidden = !(s && s.paired);
      $('syncUnpair').disabled = state.sync.busy;
      // The code this board issued (from its status, or the one we stored when we asked for it).
      const stored = storedSyncCode();
      const ownCode = (s && s.pairingCode) || (stored && stored.from === id ? stored.code : '');
      $('syncCode').hidden = !ownCode;
      if (ownCode) $('syncCode').value = ownCode;
      // A code from another board: offered to this one; a code typed by hand is accepted too.
      const offered = stored && stored.from && stored.from !== id ? stored : null;
      const input = $('syncPairInput');
      if (offered && (input.value.trim() === '' || input.value.trim() === state.sync.prefilled)) { input.value = offered.code; state.sync.prefilled = offered.code; }
      const typed = input.value.trim();
      $('syncPair').hidden = !typed;
      $('syncPair').textContent = offered && typed === offered.code ? `Pair with ${offered.from}` : 'Pair with this code';
      $('syncPair').disabled = state.sync.busy;
    }

    // One command, over whichever connection exists. pairingOp: the change needs the owner's
    // authority on an owned board (grant or BOOT press), exactly like a Wi-Fi change.
    async function syncCommand(payload, {pairingOp = false} = {}) {
      const source = syncSource();
      if (!source) return {ok: false, error: 'No connection to the board'};
      if (source === 'ble') {
        if (!provisioning()) return {ok: false, error: 'This firmware has no Bluetooth setup service; flash the current base image'};
        const session = provSession();
        if (pairingOp || !session.hasKey() || !state.sync.hello) state.sync.hello = await session.hello();
        const request = {...payload};
        let denied = null;
        if (pairingOp && state.sync.hello.locked) {
          const id = provBoardId();
          if (id) { const result = await provGrant(id, state.sync.hello); if (result.grant) request.grant = result.grant; else denied = result.denied; }
        }
        const reply = await session.sync(request);
        if (!reply.ok && /locked/i.test(reply.error || '')) {
          return {ok: false, locked: true, error: `${denied ? `${denied}. ` : ''}This board has an owner. Press the BOOT button on the board once, then try again within two minutes.`};
        }
        return {ok: Boolean(reply.ok), error: reply.error, code: reply.code, via: 'ble'};
      }
      const device = selectedDevice();
      const response = await api(`/api/devices/${device.id}/sync`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
      let body = {};
      try { body = await response.json(); } catch (_) { body = {}; }
      if (!response.ok) return {ok: false, error: body.error || `HTTP ${response.status}`, via: 'backend'};
      if (body.queued) return {ok: true, queued: true, pollMs: Number(body.pollMs) || 15000, via: 'cloud'};
      const result = body.result || {};
      return {ok: Boolean(result.ok), error: result.error, code: result.code, via: 'lan'};
    }

    function queuedHint(result) {
      return `Queued; the board picks it up within ${Math.max(1, Math.round(result.pollMs / 1000))} s. This block updates when the board reports back.`;
    }

    async function runSyncCommand(work) {
      if (!syncSource() || state.sync.busy) return;
      state.sync.busy = true;
      renderSync();
      try { await work(); }
      catch (error) {
        $('syncHint').textContent = `Board sync failed: ${error.message}`;
        log(`Board sync failed: ${error.message}`, 'BOARD SYNC', 'error');
        if (syncSource() === 'ble') dropProvSession();
      } finally {
        state.sync.busy = false;
        renderSync();
        if (syncSource() === 'ble') pollSyncStatus().catch(() => {});
        else refreshDevices({probe: !hosted}).catch(() => {});
      }
    }

    function connectAnotherBoard() {
      return runSyncCommand(async () => {
        const id = syncBoardId();
        const result = await syncCommand({op: 'code'}, {pairingOp: true});
        if (result.queued) { $('syncHint').textContent = `${queuedHint(result)} The pairing code appears here once the board reports it.`; return; }
        if (!result.ok) { $('syncHint').textContent = result.error || 'The board refused to issue a pairing code.'; log(`Pairing code refused: ${result.error}`, 'BOARD SYNC', 'error'); return; }
        if (result.code) {
          try { syncModule.storeCode(win.sessionStorage, {code: result.code, from: id, at: Date.now()}); } catch (_) { /* private mode */ }
          $('syncCode').value = result.code;
          $('syncCode').hidden = false;
        }
        $('syncHint').textContent = `Pairing code issued; it is valid for ten minutes. Now connect the other board (over Bluetooth, or pick it in the list above) and click Pair with ${id}. ` +
                                    `On a serial console the same code is accepted with: sync pair ${result.code || '<code>'}`;
        log(`Pairing code issued by ${id}.`, 'BOARD SYNC', 'success');
      });
    }

    function pairWithCode() {
      const code = $('syncPairInput').value.trim();
      if (!syncModule.CODE_PATTERN.test(code)) {
        $('syncHint').textContent = 'Enter a pairing code that looks like ATSYNC1-<board>-<channel>-<key>, from the other board\'s Board connections block or its serial console (sync code).';
        $('syncPairInput').focus();
        return;
      }
      const id = syncBoardId();
      if (syncModule.issuerOf(code) === id) { $('syncHint').textContent = 'That code was issued by this board; use it on the other board.'; return; }
      return runSyncCommand(async () => {
        const result = await syncCommand({op: 'pair', code}, {pairingOp: true});
        if (result.queued) { $('syncHint').textContent = queuedHint(result); return; }
        if (!result.ok) { $('syncHint').textContent = result.error || 'The board refused the pairing code.'; log(`Pairing refused: ${result.error}`, 'BOARD SYNC', 'error'); return; }
        const stored = storedSyncCode();
        if (stored && stored.code === code) { try { syncModule.storeCode(win.sessionStorage, null); } catch (_) { /* ignore */ } }
        $('syncPairInput').value = '';
        state.sync.prefilled = '';
        $('syncHint').textContent = `Pairing with ${syncModule.issuerOf(code)} requested. Both boards show Connected within a few seconds when they can hear each other.`;
        log(`${id} is pairing with ${syncModule.issuerOf(code)}.`, 'BOARD SYNC', 'success');
      });
    }

    function unpairBoard() {
      if (!state.sync.armedUnpair || Date.now() - state.sync.armedUnpair > 6000) {
        state.sync.armedUnpair = Date.now();
        $('syncUnpair').textContent = 'Click again to unpair';
        setTimeout(() => { state.sync.armedUnpair = null; $('syncUnpair').textContent = 'Unpair'; }, 6000);
        return;
      }
      state.sync.armedUnpair = null;
      $('syncUnpair').textContent = 'Unpair';
      return runSyncCommand(async () => {
        const result = await syncCommand({op: 'unpair'}, {pairingOp: true});
        if (result.queued) { $('syncHint').textContent = queuedHint(result); return; }
        $('syncHint').textContent = result.ok ? 'The board forgot its paired board. The other board notices within a few seconds.' : result.error;
        log(result.ok ? 'Unpaired.' : `Unpair refused: ${result.error}`, 'BOARD SYNC', result.ok ? 'success' : 'error');
      });
    }

    function toggleDemoState() {
      return runSyncCommand(async () => {
        const s = currentSyncStatus();
        const next = !(s && s.value === 'true');
        const result = await syncCommand({op: 'set', key: DEMO_KEY, value: next ? 'true' : 'false'});
        if (result.queued) { $('syncHint').textContent = queuedHint(result); return; }
        if (!result.ok) { $('syncHint').textContent = result.error || 'The board refused the change.'; return; }
        $('syncHint').textContent = '';
        log(`${DEMO_KEY} set to ${next} on ${syncBoardId()}${s && s.connected ? `; ${s.peer} follows within a second` : ''}.`, 'BOARD SYNC', 'success');
      });
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
      for (const waiting of state.unclaimed) {
        if (state.devices.some(d => d.id === waiting.id)) continue;
        rows.push({...waiting, kind: 'unclaimed'});
      }
      // The list only earns its space when there is something to choose, pair or claim.
      const onlyTheSelectedBoard = rows.length === 1 && rows[0].kind === 'paired' && rows[0].id === state.selectedDeviceId;
      list.hidden = rows.length === 0 || onlyTheSelectedBoard;
      for (const row of rows) {
        const element = doc.createElement('div');
        element.className = `device-row${row.id === state.selectedDeviceId ? ' selected' : ''}${row.kind === 'unclaimed' ? ' unclaimed' : ''}`;
        const dot = doc.createElement('span');
        dot.className = `dot ${row.kind === 'paired' ? (row.online ? 'online' : 'offline') : 'unknown'}`;
        const name = doc.createElement('strong');
        name.textContent = row.name || `Atech ${row.suffix || (row.id ? row.id.slice(-6) : '?')}`;
        const id = doc.createElement('span');
        id.className = 'mono';
        id.textContent = row.id || 'unknown id';
        const where = doc.createElement('span');
        where.className = 'ago';
        if (row.kind === 'paired' && reach(row) === 'cloud') {
          where.textContent = row.online ? `online via the cloud, seen ${formatAgo(row.cloud && row.cloud.lastSeenAt)}`
                                         : `offline, last seen ${formatAgo(row.cloud && row.cloud.lastSeenAt)}`;
        } else if (row.kind === 'paired') {
          where.textContent = row.online ? `online at ${row.identity.wifi.ip}` : 'offline';
        } else if (row.kind === 'unclaimed') {
          where.textContent = `seen by the cloud ${formatAgo(row.seenAt)}, waiting to be claimed${row.authFailed ? ' (online with a different pairing token)' : ''}`;
        } else {
          where.textContent = row.host ? `found at ${row.host}:${row.port}${row.demo ? `, Demo ${row.demo}` : ''}` : 'found by mDNS, no address yet';
        }
        const spacer = doc.createElement('span');
        spacer.className = 'spacer';
        element.append(dot, name, id, where, spacer);
        if (row.kind === 'unclaimed') {
          const claim = doc.createElement('button');
          claim.type = 'button';
          claim.className = 'btn secondary';
          claim.textContent = 'Claim';
          claim.addEventListener('click', () => openClaimForm(row.id));
          element.append(claim);
        } else if (row.kind === 'paired') {
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
      if (state.deviceBusy || hosted) return;
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

    function openClaimForm(prefillId = '') {
      $('devClaimForm').hidden = false;
      if (prefillId) $('devClaimId').value = prefillId;
      $('devHint').textContent = 'Enter the board ID and the pairing token (the OTA authorization code printed on its serial console at boot).';
      renderDevice();
      ($('devClaimId').value ? $('devClaimToken') : $('devClaimId')).focus();
    }

    // Claim a board for this dashboard user: id plus pairing token, verified by the backend
    // against the board's own login when it is online, at its first login otherwise.
    async function claimDevice() {
      const id = $('devClaimId').value.trim().toUpperCase();
      const token = $('devClaimToken').value.trim();
      const name = $('devClaimName').value.trim();
      if (!DEVICE_ID.test(id)) { $('devHint').textContent = 'Enter the board ID printed on its serial console (ATECH- followed by 12 hex characters).'; $('devClaimId').focus(); return; }
      if (!token) { $('devHint').textContent = 'Enter the pairing token: the OTA authorization code printed on the serial console at boot.'; $('devClaimToken').focus(); return; }
      $('devClaim').disabled = true;
      $('devProgress').hidden = false;
      $('devHint').textContent = `Claiming ${id}.`;
      try {
        const response = await api('/api/devices/claim', {method: 'POST', headers: {'content-type': 'application/json'},
                                                           body: JSON.stringify({id, token, name})});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        $('devClaimToken').value = '';
        $('devClaimForm').hidden = true;
        state.unclaimed = state.unclaimed.filter(u => u.id !== id);
        await refreshDevices({probe: false});
        chooseDevice(id);
        const verified = body.device && body.device.cloud && body.device.cloud.verified;
        $('devHint').textContent = verified ? `Claimed ${id}. Deployments go through the cloud.`
                                            : `Claimed ${id}. Waiting for the board to connect; power it on its Wi-Fi.`;
        log(`Claimed ${id}${verified ? ' (token verified against the online board)' : ' (waiting for the board)'}.`, 'BACKEND', 'success');
      } catch (error) {
        $('devHint').textContent = `Claim failed: ${error.message}`;
        log(`Claim failed: ${error.message}`, 'BACKEND', 'error');
      } finally {
        $('devClaim').disabled = false;
        $('devProgress').hidden = true;
        renderDevice();
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
      if (identity && identity.slotSize && job.firmware.size > identity.slotSize) return 'The image is larger than the board reports for its OTA slot.';
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
      const wifiTitle = $('methodWifi').querySelector('strong');
      if (wifiTitle) wifiTitle.textContent = methodLabel('wifi');
      $('wifiTransportPanel').hidden = effective !== 'hotspot';
      $('deployTransport').textContent = `over ${methodLabel(state.deployingVia || effective)}`;
      const deploy = $('aiDeploy');
      const blocker = deployBlocker();
      deploy.disabled = !canDeploy() || Boolean(blocker);
      deploy.title = blocker;
      deploy.textContent = effective === 'hotspot' ? 'Download firmware for the hotspot portal' : `Deploy over ${methodLabel(effective)}`;
      if (!state.busy && !state.deployment && state.job && state.job.state === 'ready') {
        if (blocker) $('deployBadge').textContent = 'Blocked';
        else $('deployBadge').textContent = `Ready: ${methodLabel(effective)}`;
        $('deployBadge').className = `badge ${blocker ? 'error' : 'neutral'}`;
        if (!state.lastFailure) $('deployStatus').textContent = blocker || (effective === 'hotspot'
          ? 'No Wi-Fi or Bluetooth path is available. Download the firmware and follow How to connect a new board in step 1.'
          : `Ready to deploy over ${methodLabel(effective)}.`);
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

    function renderPhases(current, {failed = false, phases = PHASES} = {}) {
      const container = $('deployPhases');
      container.replaceChildren();
      container.hidden = !current;
      if (!current) return;
      const order = phases.map(p => p[0]);
      const last = order[order.length - 1];
      const index = order.indexOf(current);
      for (const [id, label] of phases) {
        const chip = doc.createElement('span');
        const position = order.indexOf(id);
        let cls = '';
        if (current === last && id === last) cls = 'done';
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
      $('deploySpeed').textContent = speedBps === null ? '' : formatSpeed(speedBps || 0);
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

    // A cloud job: the board pulls the image and reports; the dashboard shows the board's reports.
    function renderCloudDeployment(deployment) {
      state.deployment = deployment;
      const failed = deployment.state === 'failed' || deployment.state === 'cancelled';
      const done = deployment.state === 'succeeded';
      const display = deployment.state === 'pending' && deployment.offline ? 'offline' : deployment.state;
      setDeployTone(failed ? 'error' : done ? 'success' : 'working');
      renderPhases(deployment.state === 'cancelled' ? 'pending' : deployment.state, {failed, phases: CLOUD_PHASES});
      const t = deployment.timings || {};
      renderTransfer({bytes: deployment.received || 0, total: deployment.total, percent: deployment.percent || 0, etaMs: null,
                      speedBps: t.downloadMs && deployment.received ? deployment.received * 1000 / t.downloadMs : null});
      renderChecks(deployment.checks);
      const parts = [];
      if (t.downloadMs) parts.push(`${formatDuration(t.downloadMs)} download`);
      if (t.rebootMs) parts.push(`${formatDuration(t.rebootMs)} reboot`);
      if (t.totalMs && done) parts.push(`${formatDuration(t.totalMs)} total`);
      $('deployTime').textContent = parts.join(', ');
      // The backend's stage text wins when it says more than the generic line (the board is busy
      // with another update, or is back online and confirming).
      const backendStage = deployment.stage && /busy|confirming|back online/i.test(deployment.stage) ? `${deployment.stage.replace(/\.$/, '')}.` : null;
      if (done) setDeployStatus(`Deployed and confirmed on ${deployment.deviceId}.`, 'success', CLOUD_BADGES.succeeded);
      else if (deployment.state === 'failed') setDeployStatus(`Cloud Wi-Fi deployment not verified: ${deployment.error}`, 'error', CLOUD_BADGES.failed);
      else if (deployment.state === 'cancelled') setDeployStatus(CLOUD_STAGE.cancelled, 'error', CLOUD_BADGES.cancelled);
      else setDeployStatus(backendStage || CLOUD_STAGE[display] || deployment.stage, 'working', CLOUD_BADGES[display] || 'Working');
      $('deployAbort').hidden = deployment.state !== 'pending';
    }

    // After a reload (routine on a phone) the selected board may still have a job in flight:
    // show it and follow it to the end, with Stop available while it is pending.
    async function attachActiveDeployment() {
      const device = selectedDevice();
      if (!device || state.busy || state.deployment || reach(device) !== 'cloud') return;
      let active = null;
      try {
        const response = await api(`/api/deployments?deviceId=${encodeURIComponent(device.id)}`);
        if (!response.ok) return;
        const list = await response.json();
        active = (Array.isArray(list) ? list : []).find(d => d.transport === 'cloud' && ['pending', 'downloading', 'installing', 'rebooting'].includes(d.state)) || null;
      } catch (_) { return; }
      if (!active || state.busy || state.deployment) return;
      state.busy = true;
      state.deployingVia = 'wifi';
      state.deployTransport = 'cloud';
      state.lastFailure = null;
      refresh();
      renderDeployment(active);
      log(`Following cloud deployment ${active.id} (${active.state}) for ${device.id}.`, 'BACKEND');
      try {
        const result = await followDeployment(active.id);
        if (result.state === 'succeeded') { state.lastVerified = true; await refreshDevices({probe: true}).catch(() => {}); }
        else { state.lastFailure = {method: 'wifi', message: result.error || result.state}; setDeployTone('error'); }
      } catch (error) {
        log(`Lost track of deployment ${active.id}: ${error.message}`, 'BACKEND', 'warn');
      } finally {
        state.busy = false;
        state.deployingVia = null;
        state.deployTransport = null;
        refresh();
      }
    }

    function deploymentFinished(deployment) {
      return deployment.transport === 'cloud' ? ['succeeded', 'failed', 'cancelled'].includes(deployment.state)
                                              : ['verified', 'failed', 'aborted'].includes(deployment.state);
    }

    function renderDeployment(deployment) {
      if (deployment.transport === 'cloud') { renderCloudDeployment(deployment); return; }
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
        const finished = deploymentFinished;
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
          state.deployPollTimer = setInterval(() => pollOnce().catch(error => reject(error)), pollMs);
        };
        if (usePolling || typeof win.EventSource !== 'function') { poll(); return; }
        const source = new win.EventSource(apiUrl(`/api/deployments/${id}/events`));
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
      const cloud = reach(device) === 'cloud';
      state.deployingVia = 'wifi';
      state.deployTransport = cloud ? 'cloud' : 'lan';
      renderMethods();
      setDeployTone('working');
      renderPhases(cloud ? 'pending' : 'preflight', cloud ? {phases: CLOUD_PHASES} : {});
      renderTransfer({bytes: 0, total: job.firmware.size, speedBps: cloud ? null : 0, etaMs: null});
      renderChecks([]);
      $('deployTime').textContent = '';
      setDeployStatus(cloud ? `Queuing the job for ${device.name || device.id}; the board picks it up on its next poll.`
                            : `Sending the firmware to ${device.name || device.id} over Wi-Fi.`, 'working', cloud ? 'Queued' : 'Starting');
      // A board reached through the cloud is asked for explicitly: the backend never tries the LAN for it.
      const response = await api(`/api/builds/${job.id}/deploy`, {method: 'POST', headers: {'content-type': 'application/json'},
                                                                   body: JSON.stringify(cloud ? {deviceId: device.id, via: 'cloud'} : {deviceId: device.id})});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      log(`${cloud ? 'Cloud' : 'Wi-Fi'} deployment ${body.id} ${cloud ? 'queued' : 'started'} for ${device.id}.`, 'BACKEND');
      const result = await followDeployment(body.id);
      const succeeded = result.transport === 'cloud' ? result.state === 'succeeded' : result.state === 'verified';
      if (!succeeded) {
        const error = new Error(result.error || `Deployment ${result.state}`);
        error.deployment = result;
        throw error;
      }
      const t = result.timings || {};
      if (result.transport === 'cloud') {
        log(`Cloud deployment ${result.id}: queued ${formatDuration(t.queuedMs)}, download ${formatDuration(t.downloadMs)}, ` +
            `install ${formatDuration(t.installMs)}, reboot ${formatDuration(t.rebootMs)}, total ${formatDuration(t.totalMs)}.`, 'BACKEND', 'success');
      } else {
        log(`Wi-Fi transfer ${formatBytes(result.total)} in ${formatDuration(t.transferMs)} (${formatSpeed(result.speedBps)}); ` +
            `reboot ${formatDuration(t.rebootMs)}; verify ${formatDuration(t.verifyMs)}; total ${formatDuration(t.totalMs)}.`, 'BACKEND', 'success');
      }
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
        const label = methodLabel(method);
        const cloudJob = error.deployment && error.deployment.transport === 'cloud';
        const other = method === 'wifi' ? bleAvailability() : method === 'ble' ? wifiAvailability() : {ok: false};
        const hint = other.ok ? ` ${methodLabel(method === 'wifi' ? 'ble' : 'wifi')} is available: choose it above and click Deploy again.`
                              : ' The previous firmware keeps running; fix the cause and click Deploy again.';
        setDeployStatus(`${label} deployment not verified: ${error.message}.${hint}`, 'error', cloudJob ? CLOUD_BADGES[error.deployment.state] || 'Failed' : 'Not verified');
        log(`${label} deployment failed: ${error.message}`, 'BUILDER', 'error');
        if (method === 'ble') await recordDeployment(job, 'failed', error.message, 'ble');
      } finally {
        state.busy = false;
        state.deployingVia = null;
        state.deployTransport = null;
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
      $('aiBrowserNote').hidden = transport.bluetoothAvailable || state.devices.some(d => d.online || reach(d) === 'cloud');
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
        state.publicUrl = (health.cloud && health.cloud.publicUrl) || null;
        $('aiBackend').textContent = `Backend online: ${health.provider || 'no provider'} (${health.model || 'no model'})`;
        $('aiBackend').className = 'ai-backend ok';
      } catch (error) {
        state.backendOk = false;
        $('aiBackend').textContent = hosted
          ? (state.keyRequired ? 'Build service refused the hosted dashboard key. Check ATECH_BUILDER_KEY on Vercel.'
                               : 'Build service unreachable. The hosted dashboard could not reach the backend; try again in a minute.')
          : state.keyRequired
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
        download.href = apiUrl(`/api/builds/${job.id}/firmware.bin${key ? `?key=${encodeURIComponent(key)}` : ''}`);
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
      state.pollTimer = setInterval(() => { pollOnce(id).catch(error => log(error.message, 'BUILDER', 'warn')); }, pollMs);
    }

    function follow(id) {
      stopFollowing();
      if (usePolling || typeof win.EventSource !== 'function') { poll(id); return; }
      const source = new win.EventSource(apiUrl(`/api/builds/${id}/events`));
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
    $('devClaimOpen').addEventListener('click', () => { openClaimForm(); });
    $('devClaim').addEventListener('click', () => { claimDevice(); });
    $('devClaimToken').addEventListener('keydown', event => { if (event.key === 'Enter') claimDevice(); });
    $('devForget').addEventListener('click', () => { forgetDevice(); });
    $('provScan').addEventListener('click', () => { scanWifi(); });
    $('provJoin').addEventListener('click', () => { joinWifi(); });
    $('provForget').addEventListener('click', () => { forgetWifi(); });
    $('provPassword').addEventListener('keydown', event => { if (event.key === 'Enter') joinWifi(); });
    $('syncToggle').addEventListener('click', () => { toggleDemoState(); });
    $('syncConnect').addEventListener('click', () => { connectAnotherBoard(); });
    $('syncPair').addEventListener('click', () => { pairWithCode(); });
    $('syncUnpair').addEventListener('click', () => { unpairBoard(); });
    $('syncPairInput').addEventListener('input', () => { renderSync(); });
    $('syncPairInput').addEventListener('keydown', event => { if (event.key === 'Enter') pairWithCode(); });
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
    $('aiBrowserNote').textContent = hosted
      ? 'This browser has no Web Bluetooth. Claim your board in step 1 and deploy through the cloud, or download the firmware for the board\'s hotspot page.'
      : 'This browser has no Web Bluetooth, so the Bluetooth backup is unavailable here. Wi-Fi deployment works in Safari and Chrome once the board is on your Wi-Fi and paired. Otherwise download the firmware and use the hotspot steps, where pairing and upload are manual.';
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

  const api = Object.freeze({mount, EXAMPLES, formatBytes, formatDuration, formatSpeed, formatAgo, CLOUD_PHASES});
  root.AtechBuilder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
