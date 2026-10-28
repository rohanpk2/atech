'use strict';

const SERVICE = 'a7ec0001-2e47-4dd2-82a4-9c2cf6eaa001';
const CONTROL = 'a7ec0002-2e47-4dd2-82a4-9c2cf6eaa001';
const DATA = 'a7ec0003-2e47-4dd2-82a4-9c2cf6eaa001';
const STATUS = 'a7ec0004-2e47-4dd2-82a4-9c2cf6eaa001';
const INFO = 'a7ec0005-2e47-4dd2-82a4-9c2cf6eaa001';
const COMMAND = 'a7ec0006-2e47-4dd2-82a4-9c2cf6eaa001';
const RESPONSE = 'a7ec0007-2e47-4dd2-82a4-9c2cf6eaa001';
// Shared Atech identity service (a7ec0100): a7ec0101 identity, a7ec0102 control, a7ec0103 events.
const IDENTITY_CHARACTERISTIC = 'a7ec0101-2e47-4dd2-82a4-9c2cf6eaa001';
const OTA_SLOT_BYTES = 6 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 8000;
const protocol = globalThis.AtechOtaProtocol;
const decoder = new TextDecoder();
const $ = id => document.getElementById(id);

let device = null;
let observedDevice = null;
let controlChar = null;
let dataChar = null;
let statusChar = null;
let infoChar = null;
let commandChar = null;
let responseChar = null;
let identityChar = null;
let identityControlChar = null;
let identityEventChar = null;
let currentFirmwareInfo = 'Unknown';
let currentIdentity = null;
let transferring = false;
let otaPhase = 'idle';
let otaWaiter = null;
let heartbeatTimer = null;
let heartbeatInFlight = false;
let requestSequence = (Date.now() >>> 0) || 1;
let challengeAttempts = 0;
let challengeSuccesses = 0;
let pendingOtaVerification = null;
let selectedFileValid = false;
let builder = null;
const bluetoothAvailable = window.isSecureContext && Boolean(navigator.bluetooth);
let selectedTransport = bluetoothAvailable ? 'ble' : 'wifi';
const pendingCommands = new Map();
const pendingControls = new Map();

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isConnected() {
  return Boolean(device?.gatt?.connected);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function timestamp() {
  return new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

function log(message, source = 'BROWSER', level = 'info') {
  const row = document.createElement('div');
  row.className = `log-row ${level}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = timestamp();
  const badge = document.createElement('span');
  badge.className = `log-source ${source.toLowerCase().replace(/\s+/g, '-')}`;
  badge.textContent = source;
  const text = document.createElement('span');
  text.className = 'log-message';
  text.textContent = message;
  row.append(time, badge, text);
  $('log').append(row);
  $('log').scrollTop = $('log').scrollHeight;
}

function setConnectionState(state, label) {
  $('globalConnection').className = `status ${state}`;
  $('globalConnectionText').textContent = label;
}

function setSignalState(state, label) {
  $('signalState').className = `signal ${state}`;
  $('signalState').textContent = label;
}

function setOtaState(message, tone = 'neutral', badge = 'Ready') {
  $('otaState').textContent = message;
  $('otaState').className = `state ${tone}`;
  $('otaBadge').textContent = badge;
  $('otaBadge').className = `badge ${tone}`;
}

function selectTransport(transport) {
  if (transport === 'ble' && !bluetoothAvailable) return;
  if (transferring) {
    log('Finish or abort the active Bluetooth transfer before changing transports.', 'BROWSER', 'warn');
    return;
  }
  if (transport === 'wifi' && isConnected()) {
    $('compatibility').hidden = false;
    $('compatibility').textContent = 'Disconnect the active Bluetooth session before starting the exclusive Wi-Fi OTA mode.';
    $('disconnect').focus();
    return;
  }
  selectedTransport = transport;
  document.body.dataset.otaTransport = transport;

  const usingBluetooth = transport === 'ble';
  $('useBluetooth').classList.toggle('selected', usingBluetooth);
  $('useBluetooth').setAttribute('aria-pressed', String(usingBluetooth));
  $('useWifi').classList.toggle('selected', !usingBluetooth);
  $('useWifi').setAttribute('aria-pressed', String(!usingBluetooth));
  $('wifiTransportPanel').hidden = usingBluetooth;
  $('bleConsole').hidden = !usingBluetooth;
  refreshButtons();
}

function refreshButtons() {
  const connected = isConnected();
  $('useBluetooth').disabled = transferring || !bluetoothAvailable;
  $('useWifi').disabled = transferring;
  $('connect').disabled = transferring || connected || selectedTransport !== 'ble' || !bluetoothAvailable;
  $('disconnect').disabled = transferring || !connected;
  $('testConnection').disabled = transferring || !connected;
  $('sendCommand').disabled = transferring || !connected;
  $('commandInput').disabled = transferring || !connected;
  document.querySelectorAll('[data-command]').forEach(button => {
    button.disabled = transferring || !connected;
  });
  $('bin').disabled = transferring;
  $('chunk').disabled = transferring;
  $('deploy').disabled = transferring || !connected || !selectedFileValid;
  if (builder) builder.refresh();
}

function updateLastSeen() {
  $('lastSeen').textContent = timestamp();
  setSignalState('live', 'Live');
}

function clearGattHandles() {
  controlChar = dataChar = statusChar = infoChar = commandChar = responseChar = null;
  identityChar = identityControlChar = identityEventChar = null;
}

function renderIdentity() {
  if (!currentIdentity) {
    $('deviceId').textContent = 'Unknown';
    $('pairingCode').textContent = 'Unknown';
    $('appInfo').textContent = 'Unknown';
    return;
  }
  $('deviceId').textContent = currentIdentity.id;
  $('pairingCode').textContent = currentIdentity.suffix;
  let appText = `${currentIdentity.app} v${currentIdentity.ver} (build ${currentIdentity.build}, ${currentIdentity.appState})`;
  if (currentIdentity.safe) appText += ', SAFE MODE';
  if (currentIdentity.pending) appText += ', pending confirmation';
  $('appInfo').textContent = appText;
}

function rejectOtaWaiter(error) {
  if (!otaWaiter) return;
  const current = otaWaiter;
  otaWaiter = null;
  clearTimeout(current.timer);
  current.reject(error);
}

function rejectAllCommands(error) {
  for (const pending of pendingCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingCommands.clear();
  for (const pending of pendingControls.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingControls.clear();
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatInFlight = false;
}

function handleDisconnect(event) {
  if (event.target !== device) return;
  rejectOtaWaiter(new Error('Bluetooth disconnected during OTA transfer'));
  rejectAllCommands(new Error('Bluetooth disconnected before the ESP32 acknowledged the request'));
  stopHeartbeat();
  clearGattHandles();
  setConnectionState('offline', 'Disconnected');
  setSignalState('offline', 'None');
  $('deviceName').textContent = device?.name || 'Previously selected device';
  log('GATT connection closed; live device acknowledgments stopped.', 'BROWSER',
      otaPhase === 'rebooting' || otaPhase === 'verifying' ? 'info' : 'warn');
  if (otaPhase === 'uploading') {
    setOtaState('Transfer interrupted. The previous firmware should remain active; reconnect and retry.', 'error', 'Interrupted');
  }
  refreshButtons();
}

function observeDevice(selectedDevice) {
  if (observedDevice === selectedDevice) return;
  selectedDevice.addEventListener('gattserverdisconnected', handleDisconnect);
  observedDevice = selectedDevice;
}

function onOtaStatus(event) {
  const value = event.target.value;
  if (value.byteLength < 5) return;
  const status = {code: value.getUint8(0), offset: value.getUint32(1, true)};
  if (otaWaiter && otaWaiter.match(status)) {
    const current = otaWaiter;
    otaWaiter = null;
    clearTimeout(current.timer);
    current.resolve(status);
  }
}

function onCommandResponse(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let response;
  try {
    response = protocol.parseCommandResponse(bytes);
  } catch (error) {
    log(`Ignored malformed response: ${error.message}`, 'ESP32 ACK', 'error');
    return;
  }

  updateLastSeen();
  const pending = pendingCommands.get(response.requestId);
  if (!pending) {
    log(`Unmatched response #${response.requestId} (${response.command}).`, 'ESP32 ACK', 'warn');
    return;
  }
  pendingCommands.delete(response.requestId);
  clearTimeout(pending.timer);
  const latencyMs = performance.now() - pending.startedAt;

  if (response.opcode !== pending.opcode) {
    pending.reject(new Error(`Response opcode mismatch for request #${response.requestId}`));
    return;
  }
  if (!protocol.bytesEqual(response.nonce, pending.nonce)) {
    pending.reject(new Error(`Challenge mismatch for request #${response.requestId}`));
    return;
  }

  log(`#${response.requestId} ${response.statusText}; ${response.ledModeText}; ${latencyMs.toFixed(1)} ms.`,
      'ESP32 ACK', response.status === 0 ? 'success' : 'error');
  pending.resolve({...response, latencyMs});
}

function onControlEvent(event) {
  const value = event.target.value;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let parsed;
  try {
    parsed = AtechIdentity.parseControlEvent(bytes);
  } catch (error) {
    log(`Ignored malformed control event: ${error.message}`, 'ESP32 ACK', 'error');
    return;
  }
  updateLastSeen();
  const key = protocol.bytesToHex(parsed.nonce);
  const pending = pendingControls.get(key);
  if (!pending) {
    log(`Unmatched control event ${parsed.name} (${parsed.statusText}).`, 'ESP32 ACK', 'warn');
    return;
  }
  pendingControls.delete(key);
  clearTimeout(pending.timer);
  log(`Core ${parsed.name}: ${parsed.statusText}.`, 'ESP32 ACK', parsed.status === 0 ? 'success' : 'error');
  pending.resolve(parsed);
}

async function readIdentity() {
  if (!identityChar) throw new Error('The connected firmware has no Atech identity service');
  const raw = await identityChar.readValue();
  currentIdentity = AtechIdentity.parseIdentity(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  renderIdentity();
  if (builder) builder.refresh();
  return currentIdentity;
}

async function sendControl(opcode, {timeout = 5000} = {}) {
  if (!isConnected() || !identityControlChar) throw new Error('Connect to a board with the Atech identity service first');
  const nonce = AtechIdentity.randomNonce();
  const key = protocol.bytesToHex(nonce);
  const packet = AtechIdentity.buildControlPacket(opcode, nonce);
  const eventPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControls.delete(key);
      reject(new Error(`Timed out waiting for the core to answer ${AtechIdentity.CONTROL_NAMES[opcode]}`));
    }, timeout);
    pendingControls.set(key, {resolve, reject, timer});
  });
  eventPromise.catch(() => {});
  try {
    await identityControlChar.writeValueWithResponse(packet);
  } catch (error) {
    const pending = pendingControls.get(key);
    if (pending) { clearTimeout(pending.timer); pendingControls.delete(key); pending.reject(error); }
    throw error;
  }
  return eventPromise;
}

async function connectGatt() {
  if (!device) throw new Error('No Bluetooth device has been selected');
  setConnectionState('connecting', 'Connecting…');
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  [controlChar, dataChar, statusChar, infoChar, commandChar, responseChar] = await Promise.all([
    service.getCharacteristic(CONTROL),
    service.getCharacteristic(DATA),
    service.getCharacteristic(STATUS),
    service.getCharacteristic(INFO),
    service.getCharacteristic(COMMAND),
    service.getCharacteristic(RESPONSE),
  ]);

  statusChar.addEventListener('characteristicvaluechanged', onOtaStatus);
  responseChar.addEventListener('characteristicvaluechanged', onCommandResponse);
  await Promise.all([statusChar.startNotifications(), responseChar.startNotifications()]);
  const rawInfo = await infoChar.readValue();
  currentFirmwareInfo = decoder.decode(
    new Uint8Array(rawInfo.buffer, rawInfo.byteOffset, rawInfo.byteLength)
  ).replace(/\0/g, '').trim();

  currentIdentity = null;
  try {
    const identityService = await server.getPrimaryService(AtechIdentity.IDENTITY_SERVICE);
    [identityChar, identityControlChar, identityEventChar] = await Promise.all([
      identityService.getCharacteristic(IDENTITY_CHARACTERISTIC),
      identityService.getCharacteristic(AtechIdentity.CONTROL_CHAR),
      identityService.getCharacteristic(AtechIdentity.EVENT_CHAR),
    ]);
    identityEventChar.addEventListener('characteristicvaluechanged', onControlEvent);
    await identityEventChar.startNotifications();
    await readIdentity();
  } catch (error) {
    identityChar = identityControlChar = identityEventChar = null;
    renderIdentity();
    log(`No Atech identity service on this firmware (${error.message}). Flash the current base image to use the AI builder.`,
        'BROWSER', 'warn');
  }

  $('deviceName').textContent = device.name || 'Unnamed ESP32-S3';
  $('firmwareVersion').textContent = currentFirmwareInfo;
  setConnectionState('online', 'Connected');
  setSignalState('waiting', 'Waiting');
  log(`GATT ready on ${device.name || 'ESP32-S3'}, ${currentFirmwareInfo}` +
      (currentIdentity ? `, ${currentIdentity.id}.` : '.'), 'BROWSER', 'success');
  refreshButtons();
  return currentFirmwareInfo;
}

async function selectAndConnect() {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is unavailable. Use desktop Chrome on localhost or HTTPS.');
  }
  if (pendingOtaVerification && device) {
    log('Reusing the authorized device to finish post-reboot verification.', 'BROWSER');
  } else {
    device = await navigator.bluetooth.requestDevice({
      filters: [{namePrefix: 'Atech-Custom-OTA'}],
      optionalServices: [SERVICE, AtechIdentity.IDENTITY_SERVICE],
    });
    observeDevice(device);
  }
  await connectGatt();
  if (pendingOtaVerification) {
    await finishOtaVerification();
  } else {
    startHeartbeat();
  }
}

function nextRequestId() {
  requestSequence = (requestSequence + 1) >>> 0;
  if (requestSequence === 0) requestSequence = 1;
  return requestSequence;
}

function randomNonce() {
  const nonce = new Uint8Array(8);
  crypto.getRandomValues(nonce);
  return nonce;
}

async function sendDeviceCommand(opcode, options = {}) {
  const {nonce = new Uint8Array(8), timeout = 5000, quiet = false,
         allowDuringTransfer = false} = options;
  if (!isConnected() || !commandChar) throw new Error('Connect to the ESP32 first');
  if (transferring && !allowDuringTransfer) throw new Error('Commands are paused during OTA');

  const requestId = nextRequestId();
  const packet = protocol.buildCommandPacket({requestId, opcode, nonce});
  const startedAt = performance.now();
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error(`Timed out waiting for ESP32 acknowledgment #${requestId}`));
    }, timeout);
    pendingCommands.set(requestId, {resolve, reject, timer, opcode, nonce, startedAt});
  });
  responsePromise.catch(() => {});

  if (!quiet) {
    log(`#${requestId} ${protocol.COMMAND_NAMES[opcode]} written; waiting for ESP32 ACK.`, 'BROWSER TX');
  }
  try {
    await commandChar.writeValueWithResponse(packet);
  } catch (error) {
    const pending = pendingCommands.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCommands.delete(requestId);
      pending.reject(error);
    }
    throw error;
  }

  const response = await responsePromise;
  if (response.status !== 0) {
    const error = new Error(`ESP32 rejected request #${requestId}: ${response.statusText}`);
    error.response = response;
    throw error;
  }
  return response;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!isConnected() || transferring || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      await sendDeviceCommand(protocol.COMMANDS.ping, {
        nonce: randomNonce(), timeout: 3500, quiet: true,
      });
    } catch (error) {
      setSignalState('stale', 'Heartbeat missed');
      log(error.message, 'HEARTBEAT', 'warn');
    } finally {
      heartbeatInFlight = false;
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function renderCommandResponse(response, success = true) {
  $('commandResult').className = `result ${success ? 'success' : 'error'}`;
  $('commandResultTitle').textContent = success ? 'Executed by ESP32' : 'Rejected';
  $('ackRequest').textContent = response ? `#${response.requestId}` : 'None';
  $('ackStatus').textContent = response?.statusText || 'No valid acknowledgment';
  $('ackDevice').textContent = response?.ledModeText || 'Unknown';
  $('ackFirmware').textContent = response ? `v${response.firmwareVersion}` : 'Unknown';
  $('ackLatency').textContent = response ? `${response.latencyMs.toFixed(1)} ms` : 'None';
}

async function executeCommand(value) {
  const command = protocol.normalizeCommand(value);
  $('commandInput').value = command;
  $('commandResult').className = 'result pending';
  $('commandResultTitle').textContent = 'Waiting for ESP32 acknowledgment';
  try {
    const response = await sendDeviceCommand(protocol.COMMANDS[command]);
    renderCommandResponse(response, true);
  } catch (error) {
    renderCommandResponse(error.response, false);
    log(error.message, 'BROWSER', 'error');
    throw error;
  }
}

async function runChallengeTest() {
  challengeAttempts += 1;
  const nonce = randomNonce();
  const challenge = protocol.bytesToHex(nonce);
  $('challengeValue').textContent = challenge;
  $('testResult').textContent = 'Waiting for exact echo';
  $('testResult').className = 'test-result waiting';
  $('testLatency').textContent = 'Pending';
  log(`Challenge ${challenge} sent; browser write alone does not count as success.`, 'BROWSER TX');
  try {
    const response = await sendDeviceCommand(protocol.COMMANDS.ping, {nonce, timeout: 5000, quiet: true});
    challengeSuccesses += 1;
    $('testResult').textContent = 'Verified echo from ESP32';
    $('testResult').className = 'test-result success';
    $('testLatency').textContent = `${response.latencyMs.toFixed(1)} ms`;
    $('testCount').textContent = `${challengeSuccesses} / ${challengeAttempts}`;
    log(`Challenge echoed exactly by firmware v${response.firmwareVersion}.`, 'ESP32 ACK', 'success');
  } catch (error) {
    $('testResult').textContent = 'Failed';
    $('testResult').className = 'test-result error';
    $('testCount').textContent = `${challengeSuccesses} / ${challengeAttempts}`;
    log(error.message, 'BROWSER', 'error');
    throw error;
  }
}

function waitForOta(match, timeout = 20000) {
  if (otaWaiter) throw new Error('Internal OTA protocol error: multiple pending ACKs');
  return new Promise((resolve, reject) => {
    const pending = {resolve, reject, match, timer: null};
    pending.timer = setTimeout(() => {
      if (otaWaiter === pending) otaWaiter = null;
      reject(new Error('Timed out waiting for ESP32 OTA acknowledgment'));
    }, timeout);
    otaWaiter = pending;
  });
}

async function sendOtaAndWait(characteristic, bytes, predicate, timeout = 20000) {
  const ackPromise = waitForOta(message => message.code >= 0xE0 || predicate(message), timeout);
  ackPromise.catch(() => {});
  try {
    await characteristic.writeValueWithResponse(bytes);
  } catch (error) {
    rejectOtaWaiter(error);
    throw error;
  }
  const result = await ackPromise;
  if (result.code >= 0xE0) {
    throw new Error(`ESP32 OTA error 0x${result.code.toString(16)} after ${result.offset} bytes`);
  }
  return result;
}

function updateProgress(bytes, total, startedAt) {
  const percent = Math.floor(bytes * 100 / total);
  const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const bytesPerSecond = bytes / seconds;
  $('bar').style.width = `${percent}%`;
  $('bar').parentElement.setAttribute('aria-valuenow', String(percent));
  $('progressPercent').textContent = `${percent}%`;
  $('progressBytes').textContent = `${formatBytes(bytes)} / ${formatBytes(total)}`;
  $('progressSpeed').textContent = `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
}

async function waitForBoardDisconnect(timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (isConnected() && performance.now() < deadline) await delay(150);
  if (isConnected()) throw new Error('ESP32 did not disconnect for its expected OTA reboot');
}

async function finishOtaVerification() {
  if (!pendingOtaVerification) throw new Error('No OTA verification is pending');
  if (!isConnected()) throw new Error('Reconnect the updated ESP32 to verify it');
  if (device.id !== pendingOtaVerification.deviceId) {
    throw new Error('Connected device does not match the board that received the update');
  }
  if (pendingOtaVerification.deviceIdentity && currentIdentity &&
      currentIdentity.id !== pendingOtaVerification.deviceIdentity) {
    throw new Error(`Reconnected board reports ${currentIdentity.id}, not ${pendingOtaVerification.deviceIdentity}`);
  }
  if (pendingOtaVerification.buildId) {
    if (!currentIdentity) throw new Error('Board reconnected without an identity service; the new image is not running');
    if (currentIdentity.build !== pendingOtaVerification.buildId) {
      throw new Error(`Board reports build ${currentIdentity.build}, expected ${pendingOtaVerification.buildId}`);
    }
  } else if (currentFirmwareInfo === pendingOtaVerification.previousVersion) {
    throw new Error(`Board reconnected but still reports ${currentFirmwareInfo}`);
  }

  const pong = await sendDeviceCommand(protocol.COMMANDS.ping, {
    nonce: randomNonce(), timeout: 5000, quiet: true, allowDuringTransfer: true,
  });
  const reportedVersion = currentFirmwareInfo.match(/\/ v(\d+) \//)?.[1];
  if (reportedVersion && (Number(reportedVersion) & 0xFF) !== pong.firmwareVersion) {
    throw new Error('Firmware info and command acknowledgment versions disagree');
  }

  const previousVersion = pendingOtaVerification.previousVersion;
  pendingOtaVerification = null;
  otaPhase = 'verified';
  setOtaState(`Update verified on the ESP32: ${previousVersion} is now ${currentFirmwareInfo}. PING acknowledged after reboot.`,
              'success', 'Verified');
  log(`Post-reboot verification passed, ${currentFirmwareInfo}, PING ${pong.latencyMs.toFixed(1)} ms.`,
      'ESP32 ACK', 'success');
}

async function reconnectAndVerifyOta() {
  await waitForBoardDisconnect();
  otaPhase = 'verifying';
  setOtaState('Board reboot detected. Reconnecting and verifying firmware version…', 'working', 'Verifying');
  const deadline = performance.now() + 30000;
  let lastError = new Error('ESP32 has not advertised after reboot');
  while (performance.now() < deadline) {
    try {
      await connectGatt();
      await finishOtaVerification();
      return;
    } catch (error) {
      lastError = error;
      if (isConnected()) device.gatt.disconnect();
      await delay(1000);
    }
  }
  throw new Error(`Automatic verification timed out: ${lastError.message}. Press Connect to retry verification.`);
}

// Streams an application image over the custom GATT protocol, waits for the
// reboot, reconnects and verifies. Used by the file picker and by the AI
// builder (which passes the build id it expects to see after reboot).
async function deployBytes(bytes, meta = {}) {
  if (!isConnected()) throw new Error('Connect to the ESP32 first');
  if (transferring) throw new Error('A transfer is already in progress');
  const label = meta.fileName || meta.appName || 'firmware.bin';
  if (bytes.length < 1024 || bytes.length > OTA_SLOT_BYTES) {
    throw new Error('Firmware does not fit the 6 MiB OTA slot');
  }
  if (currentIdentity && bytes.length > currentIdentity.slotSize) {
    throw new Error(`Firmware is larger than the board's ${formatBytes(currentIdentity.slotSize)} OTA slot`);
  }
  protocol.validateEsp32S3Application(bytes);
  const hash = protocol.crc32(bytes);
  const previousVersion = currentFirmwareInfo;
  const selectedDeviceId = device.id;
  const deviceIdentity = currentIdentity ? currentIdentity.id : null;
  const startPacket = protocol.buildStartPacket(bytes.length, hash);
  const startedAt = performance.now();
  let initialized = false;

  transferring = true;
  otaPhase = 'uploading';
  stopHeartbeat();
  refreshButtons();
  updateProgress(0, bytes.length, startedAt);
  log(`${label} validated, ${formatBytes(bytes.length)}, CRC32 0x${hash.toString(16).padStart(8, '0')}.`,
      'BROWSER', 'success');

  try {
    setOtaState('Starting a real write to the inactive OTA partition…', 'working', 'Starting');
    await sendOtaAndWait(controlChar, startPacket, message => message.code === 0x10 && message.offset === 0);
    initialized = true;
    let chunkSize = Number($('chunk').value);

    for (let offset = 0; offset < bytes.length;) {
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      setOtaState('Transferring firmware locally over Bluetooth…', 'working', 'Uploading');
      try {
        await sendOtaAndWait(dataChar, slice,
          message => message.code === 0x11 && message.offset === offset + slice.length);
      } catch (error) {
        const mtuError = ['NetworkError', 'NotSupportedError', 'InvalidModificationError'].includes(error.name);
        if (offset === 0 && chunkSize > 20 && mtuError) {
          chunkSize = 20;
          $('chunk').value = '20';
          log('Large GATT write rejected; retrying with the minimum 20-byte payload.', 'BROWSER', 'warn');
          continue;
        }
        throw error;
      }
      offset += slice.length;
      updateProgress(offset, bytes.length, startedAt);
      if (offset % (chunkSize * 100) === 0) {
        log(`${formatBytes(offset)} committed by ESP32 flash acknowledgments.`, 'ESP32 ACK');
      }
    }

    setOtaState('ESP32 is validating CRC32 and activating the new image…', 'working', 'Validating');
    await sendOtaAndWait(controlChar, new Uint8Array([0x02]), message => message.code === 0x12, 30000);
    const seconds = (performance.now() - startedAt) / 1000;
    log(`Transfer accepted in ${seconds.toFixed(1)} s at ${(bytes.length / seconds / 1024).toFixed(1)} KiB/s. Success is still pending reboot verification.`,
        'ESP32 ACK', 'success');
    pendingOtaVerification = {deviceId: selectedDeviceId, deviceIdentity, previousVersion,
                              fileName: label, buildId: meta.buildId || null};
    otaPhase = 'rebooting';
    setOtaState('Image transferred and CRC-validated. Waiting for the ESP32 to reboot. The update is not yet verified.',
                'working', 'Rebooting');
    await reconnectAndVerifyOta();
    return {identity: currentIdentity, firmwareInfo: currentFirmwareInfo};
  } catch (error) {
    log(error.message, 'BROWSER', 'error');
    if (otaPhase === 'uploading') {
      setOtaState('OTA failed or was interrupted. The previous firmware should remain bootable.', 'error', 'Failed');
      if (initialized && isConnected()) {
        try { await controlChar.writeValueWithResponse(new Uint8Array([0x03])); } catch (_) {}
      }
    } else if (pendingOtaVerification) {
      otaPhase = 'verification-pending';
      setOtaState(`${error.message} The dashboard has not marked this update successful.`, 'error', 'Needs verification');
    }
    throw error;
  } finally {
    transferring = false;
    refreshButtons();
    if (isConnected()) startHeartbeat();
  }
}

async function deploy() {
  if (!isConnected() || !$('bin').files.length) return;
  if (!selectedFileValid) throw new Error('Select a valid ESP32-S3 firmware.bin first');
  const file = $('bin').files[0];
  if (!file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose a compiled firmware.bin file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  await deployBytes(bytes, {fileName: file.name});
}

async function validateSelectedFile() {
  const file = $('bin').files[0];
  selectedFileValid = false;
  if (!file) {
    $('fileName').textContent = 'No firmware selected';
    $('fileMeta').textContent = 'Choose the updated PlatformIO firmware.bin';
    refreshButtons();
    return;
  }
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = `${formatBytes(file.size)}, validating image header`;
  try {
    if (!file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose a compiled firmware.bin file');
    if (file.size < 1024) throw new Error('File is too small to be an ESP32 application image');
    if (file.size > OTA_SLOT_BYTES) throw new Error('File exceeds the 6 MiB OTA slot');
    const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    protocol.validateEsp32S3Application(header);
    selectedFileValid = true;
    $('fileMeta').textContent = `${formatBytes(file.size)}, ESP32-S3 application image`;
    setOtaState('Firmware file looks valid. Connect a board and deploy when ready.', 'neutral', 'Ready');
  } catch (error) {
    $('fileMeta').textContent = error.message;
    setOtaState(error.message, 'error', 'Invalid file');
  }
  refreshButtons();
}

$('connect').addEventListener('click', async () => {
  try {
    await selectAndConnect();
  } catch (error) {
    setConnectionState('offline', 'Connection failed');
    if (isConnected()) device.gatt.disconnect();
    log(error.message, 'BROWSER', 'error');
    if (pendingOtaVerification) {
      setOtaState(`${error.message} The update remains unverified.`, 'error', 'Needs verification');
    }
    refreshButtons();
  }
});

$('disconnect').addEventListener('click', () => {
  if (isConnected()) device.gatt.disconnect();
});

$('testConnection').addEventListener('click', async () => {
  try { await runChallengeTest(); } catch (_) {}
});

$('sendCommand').addEventListener('click', async () => {
  try { await executeCommand($('commandInput').value); } catch (_) {}
});

$('commandInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('sendCommand').click();
});

document.querySelectorAll('[data-command]').forEach(button => {
  button.addEventListener('click', () => {
    $('commandInput').value = button.dataset.command;
    $('sendCommand').click();
  });
});

$('bin').addEventListener('change', validateSelectedFile);
$('deploy').addEventListener('click', async () => {
  try { await deploy(); } catch (_) {}
});
$('clearLog').addEventListener('click', () => {
  $('log').replaceChildren();
  log('Activity log cleared.');
});

$('useBluetooth').addEventListener('click', () => selectTransport('ble'));
$('useWifi').addEventListener('click', () => selectTransport('wifi'));

if (!bluetoothAvailable) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = !window.isSecureContext
    ? 'Web Bluetooth requires HTTPS or http://localhost. Wi-Fi fallback is selected and does not require Web Bluetooth.'
    : 'This browser does not expose Web Bluetooth. Wi-Fi fallback is selected for Safari and other unsupported browsers.';
  $('useBluetooth').disabled = true;
}

// Transport handed to the shared AI firmware builder card.
window.AtechDemo1Transport = {
  name: 'custom GATT OTA',
  bluetoothAvailable,
  isConnected,
  identity: () => currentIdentity,
  readIdentity,
  deploy: deployBytes,
  control: opcode => sendControl(opcode),
};

setConnectionState('offline', 'Disconnected');
setSignalState('offline', 'None');
setOtaState('Connect an ESP32-S3 and select a compiled firmware.bin.', 'neutral', 'Ready');
renderIdentity();
selectTransport(selectedTransport);
log('Dashboard ready. No device action is considered successful without an ESP32 acknowledgment.');
if (globalThis.AtechBuilder) {
  builder = AtechBuilder.mount({demo: 1, transport: window.AtechDemo1Transport, log});
} else {
  log('AI builder module did not load; serve this page from the builder backend (cd builder && npm start).', 'BROWSER', 'warn');
}
