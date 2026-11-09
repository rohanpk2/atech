'use strict';

// Demo 2 dashboard: speaks the gb88 BLEOTA protocol (bleota-client.js) for
// firmware transfer and the shared Atech identity service for verification.
const BLEOTA = globalThis.AtechBleota;
const Identity = globalThis.AtechIdentity;
const OTA_SLOT_BYTES = 6 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 8000;
const SECTOR_RETRIES = 3;
const ESP_IMAGE_MAGIC = 0xE9;
const ESP32_S3_CHIP_ID = 9;
const ESP_APP_DESC_MAGIC = 0xABCD5432;
const decoder = new TextDecoder();
const $ = id => document.getElementById(id);

let device = null;
let observedDevice = null;
let fwChar = null;
let cmdChar = null;
let identityChar = null;
let identityControlChar = null;
let identityEventChar = null;
let currentIdentity = null;
let currentFirmwareVersion = 'Unknown';
let transferring = false;
let otaPhase = 'idle';
let cmdWaiter = null;
let fwWaiter = null;
let heartbeatTimer = null;
let heartbeatInFlight = false;
let challengeAttempts = 0;
let challengeSuccesses = 0;
let pendingOtaVerification = null;
let selectedFileValid = false;
let builder = null;
const bluetoothAvailable = window.isSecureContext && Boolean(navigator.bluetooth);
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

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
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

function validateEsp32S3Application(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 36) {
    throw new Error('File is too small to be an ESP32 application image');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== ESP_IMAGE_MAGIC) throw new Error('Invalid ESP firmware image magic');
  const chipId = view.getUint16(12, true);
  if (chipId !== ESP32_S3_CHIP_ID) throw new Error(`Firmware targets ESP chip ID ${chipId}, not ESP32-S3 (chip ID 9)`);
  if (view.getUint32(32, true) !== ESP_APP_DESC_MAGIC) {
    throw new Error('File is not an ESP application image (use firmware.bin, not bootloader.bin)');
  }
}

function refreshButtons() {
  const connected = isConnected();
  $('connect').disabled = transferring || connected || !bluetoothAvailable;
  $('disconnect').disabled = transferring || !connected;
  $('testConnection').disabled = transferring || !connected || !identityControlChar;
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
  fwChar = cmdChar = identityChar = identityControlChar = identityEventChar = null;
  provStatusChar = provRequestChar = provReplyChar = null;
  if (window.AtechDemo2Transport) window.AtechDemo2Transport.provisioning = null;
  syncStatusChar = syncChangeChar = null;
  if (window.AtechDemo2Transport) window.AtechDemo2Transport.sync = null;
}
// Board-to-board sync status (shared/AtechSync, service a7ec0300): a status read and a change
// notification. Commands travel in the Bluetooth setup session (opcode sync); the shared builder
// card drives both through transport.sync and transport.provisioning.
let syncStatusChar = null;
let syncChangeChar = null;

function makeSync() {
  return {
    available: () => Boolean(syncStatusChar && isConnected()),
    readStatus: async () => {
      const raw = await syncStatusChar.readValue();
      return AtechSync.parseStatus(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    },
    subscribe: handler => {
      const characteristic = syncChangeChar;
      if (!characteristic) return () => {};
      const listener = event => {
        const value = event.target.value;
        handler(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      };
      characteristic.addEventListener('characteristicvaluechanged', listener);
      return () => characteristic.removeEventListener('characteristicvaluechanged', listener);
    },
  };
}

async function discoverSync(server, transport) {
  syncStatusChar = syncChangeChar = null;
  if (transport) transport.sync = null;
  try {
    const service = await server.getPrimaryService(AtechSync.SERVICE);
    [syncStatusChar, syncChangeChar] = await Promise.all([
      service.getCharacteristic(AtechSync.STATUS_CHAR),
      service.getCharacteristic(AtechSync.CHANGE_CHAR),
    ]);
    await syncChangeChar.startNotifications();
    if (transport) transport.sync = makeSync();
  } catch (error) {
    syncStatusChar = syncChangeChar = null;
    log(`No board sync service on this firmware (${error.message}). Flash the current base image to pair two boards.`, 'BROWSER', 'warn');
  }
}
// Wi-Fi setup over Bluetooth (shared/AtechBleProv on the board, web-shared/atech-provision.js
// here): the shared builder card drives it through transport.provisioning. The characteristics
// are discovered on connect; nothing here ever logs or stores what travels inside the session.
let provStatusChar = null;
let provRequestChar = null;
let provReplyChar = null;

function makeProvisioning() {
  return {
    available: () => Boolean(provRequestChar && provReplyChar && provStatusChar && isConnected()),
    session: () => AtechProvision.createSession({
      write: frame => provRequestChar.writeValueWithResponse(frame),
      subscribe: handler => {
        const characteristic = provReplyChar;
        const listener = event => {
          const value = event.target.value;
          handler(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        };
        characteristic.addEventListener('characteristicvaluechanged', listener);
        return () => characteristic.removeEventListener('characteristicvaluechanged', listener);
      },
    }),
    readStatus: async () => {
      const raw = await provStatusChar.readValue();
      return AtechProvision.parseStatus(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    },
  };
}

async function discoverProvisioning(server, transport) {
  provStatusChar = provRequestChar = provReplyChar = null;
  if (transport) transport.provisioning = null;
  try {
    const service = await server.getPrimaryService(AtechProvision.SERVICE);
    [provStatusChar, provRequestChar, provReplyChar] = await Promise.all([
      service.getCharacteristic(AtechProvision.STATUS_CHAR),
      service.getCharacteristic(AtechProvision.REQUEST_CHAR),
      service.getCharacteristic(AtechProvision.REPLY_CHAR),
    ]);
    await provReplyChar.startNotifications();
    if (transport) transport.provisioning = makeProvisioning();
  } catch (error) {
    provStatusChar = provRequestChar = provReplyChar = null;
    log(`No Wi-Fi setup service on this firmware (${error.message}). Flash the current base image to set up Wi-Fi over Bluetooth.`,
        'BROWSER', 'warn');
  }
}


function renderIdentity() {
  // The shared builder module renders the device panel from the LAN registry
  // and this BLE identity; nothing to do here beyond a refresh.
  if (builder) builder.refresh();
}

function rejectWaiters(error) {
  for (const waiter of [cmdWaiter, fwWaiter]) {
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  cmdWaiter = fwWaiter = null;
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
  rejectWaiters(new Error('Bluetooth disconnected'));
  stopHeartbeat();
  clearGattHandles();
  setConnectionState('offline', 'Bluetooth off');
  setSignalState('offline', 'None');
  if (builder) builder.refresh();
  log('GATT connection closed.', 'BROWSER', otaPhase === 'rebooting' || otaPhase === 'verifying' ? 'info' : 'warn');
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

function valueBytes(event) {
  const value = event.target.value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function onCommandNotification(event) {
  let ack;
  try {
    ack = BLEOTA.parseCommandAck(valueBytes(event));
  } catch (error) {
    log(`Ignored malformed BLEOTA command frame: ${error.message}`, 'ESP32 ACK', 'warn');
    return;
  }
  updateLastSeen();
  if (cmdWaiter) {
    const waiter = cmdWaiter;
    cmdWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(ack);
  } else {
    log(`Unexpected BLEOTA command ack ${ack.commandId}: ${ack.statusText}.`, 'ESP32 ACK', 'warn');
  }
}

function onFirmwareNotification(event) {
  let ack;
  try {
    ack = BLEOTA.parseSectorAck(valueBytes(event));
  } catch (error) {
    log(`Ignored malformed BLEOTA sector frame: ${error.message}`, 'ESP32 ACK', 'warn');
    return;
  }
  updateLastSeen();
  if (fwWaiter) {
    const waiter = fwWaiter;
    fwWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(ack);
  }
}

function onControlEvent(event) {
  let parsed;
  try {
    parsed = Identity.parseControlEvent(valueBytes(event));
  } catch (error) {
    log(`Ignored malformed control event: ${error.message}`, 'ESP32 ACK', 'error');
    return;
  }
  updateLastSeen();
  const pending = pendingControls.get(bytesToHex(parsed.nonce));
  if (!pending) {
    log(`Unmatched control event ${parsed.name} (${parsed.statusText}).`, 'ESP32 ACK', 'warn');
    return;
  }
  pendingControls.delete(bytesToHex(parsed.nonce));
  clearTimeout(pending.timer);
  log(`Core ${parsed.name}: ${parsed.statusText}.`, 'ESP32 ACK', parsed.status === 0 ? 'success' : 'error');
  pending.resolve({...parsed, latencyMs: performance.now() - pending.startedAt});
}

function waitForCommandAck(timeout = 15000) {
  if (cmdWaiter) throw new Error('Internal BLEOTA error: multiple pending command acks');
  return new Promise((resolve, reject) => {
    const waiter = {resolve, reject, timer: null};
    waiter.timer = setTimeout(() => {
      if (cmdWaiter === waiter) cmdWaiter = null;
      reject(new Error('Timed out waiting for the BLEOTA command acknowledgment'));
    }, timeout);
    cmdWaiter = waiter;
  });
}

function waitForSectorAck(timeout = 15000) {
  if (fwWaiter) throw new Error('Internal BLEOTA error: multiple pending sector acks');
  return new Promise((resolve, reject) => {
    const waiter = {resolve, reject, timer: null};
    waiter.timer = setTimeout(() => {
      if (fwWaiter === waiter) fwWaiter = null;
      reject(new Error('Timed out waiting for the BLEOTA sector acknowledgment'));
    }, timeout);
    fwWaiter = waiter;
  });
}

async function readIdentity() {
  if (!identityChar) throw new Error('The connected firmware has no Atech identity service');
  const raw = await identityChar.readValue();
  currentIdentity = Identity.parseIdentity(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  currentFirmwareVersion = currentIdentity.fw || currentFirmwareVersion;
  $('firmwareVersion').textContent = currentFirmwareVersion;
  renderIdentity();
  if (builder) builder.refresh();
  return currentIdentity;
}

async function sendControl(opcode, {timeout = 5000, quiet = false} = {}) {
  if (!isConnected() || !identityControlChar) throw new Error('Connect to a board with the Atech identity service first');
  const nonce = Identity.randomNonce();
  const key = bytesToHex(nonce);
  const packet = Identity.buildControlPacket(opcode, nonce);
  const startedAt = performance.now();
  const eventPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControls.delete(key);
      reject(new Error(`Timed out waiting for the core to answer ${Identity.CONTROL_NAMES[opcode]}`));
    }, timeout);
    pendingControls.set(key, {resolve, reject, timer, startedAt});
  });
  eventPromise.catch(() => {});
  if (!quiet) log(`Core ${Identity.CONTROL_NAMES[opcode]} with challenge ${key} written.`, 'BROWSER TX');
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
  const otaService = await server.getPrimaryService(BLEOTA.BLEOTA_SERVICE);
  [fwChar, cmdChar] = await Promise.all([
    otaService.getCharacteristic(BLEOTA.RECV_FW_CHAR),
    otaService.getCharacteristic(BLEOTA.COMMAND_CHAR),
  ]);
  cmdChar.addEventListener('characteristicvaluechanged', onCommandNotification);
  fwChar.addEventListener('characteristicvaluechanged', onFirmwareNotification);
  await Promise.all([cmdChar.startNotifications(), fwChar.startNotifications()]);

  currentIdentity = null;
  try {
    const identityService = await server.getPrimaryService(Identity.IDENTITY_SERVICE);
    [identityChar, identityControlChar, identityEventChar] = await Promise.all([
      identityService.getCharacteristic(Identity.IDENTITY_CHAR),
      identityService.getCharacteristic(Identity.CONTROL_CHAR),
      identityService.getCharacteristic(Identity.EVENT_CHAR),
    ]);
    identityEventChar.addEventListener('characteristicvaluechanged', onControlEvent);
    await identityEventChar.startNotifications();
    await readIdentity();
  } catch (error) {
    identityChar = identityControlChar = identityEventChar = null;
    currentFirmwareVersion = 'Unknown (no identity service)';
    $('firmwareVersion').textContent = currentFirmwareVersion;
    renderIdentity();
    log(`No Atech identity service on this firmware (${error.message}). Flash the current base image to use the AI builder.`,
        'BROWSER', 'warn');
  }

  await discoverProvisioning(server, window.AtechDemo2Transport);
  await discoverSync(server, window.AtechDemo2Transport);

  if (!currentIdentity) $('deviceName').textContent = device.name || 'Unnamed ESP32-S3';
  setConnectionState('online', 'Connected');
  setSignalState('waiting', 'Waiting');
  log(`BLEOTA service ready on ${device.name || 'ESP32-S3'}` +
      (currentIdentity ? `, ${currentIdentity.id}, ${currentFirmwareVersion}.` : '.'), 'BROWSER', 'success');
  refreshButtons();
}

async function selectAndConnect() {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is unavailable. Use desktop Chrome on localhost or HTTPS.');
  }
  if (pendingOtaVerification && device) {
    log('Reusing the authorized device to finish post-reboot verification.', 'BROWSER');
  } else {
    device = await navigator.bluetooth.requestDevice({
      filters: [{namePrefix: 'Atech-Library-OTA'}],
      optionalServices: [BLEOTA.BLEOTA_SERVICE, AtechIdentity.IDENTITY_SERVICE, AtechProvision.SERVICE, AtechSync.SERVICE],
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

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!isConnected() || transferring || heartbeatInFlight || !identityControlChar) return;
    heartbeatInFlight = true;
    try {
      await sendControl(Identity.CONTROL.echo, {timeout: 3500, quiet: true});
    } catch (error) {
      setSignalState('stale', 'Heartbeat missed');
      log(error.message, 'HEARTBEAT', 'warn');
    } finally {
      heartbeatInFlight = false;
    }
  }, HEARTBEAT_INTERVAL_MS);
}

async function runChallengeTest() {
  challengeAttempts += 1;
  $('testResult').textContent = 'Waiting for the core echo';
  $('testResult').className = 'test-result waiting';
  $('testLatency').textContent = 'Pending';
  try {
    const result = await sendControl(Identity.CONTROL.echo, {timeout: 5000});
    $('challengeValue').textContent = bytesToHex(result.nonce);
    if (result.status !== 0) throw new Error(`Core answered ${result.statusText}`);
    challengeSuccesses += 1;
    $('testResult').textContent = 'Verified echo from the Atech core';
    $('testResult').className = 'test-result success';
    $('testLatency').textContent = `${result.latencyMs.toFixed(1)} ms`;
  } catch (error) {
    $('testResult').textContent = 'Failed';
    $('testResult').className = 'test-result error';
    log(error.message, 'BROWSER', 'error');
    throw error;
  } finally {
    $('testCount').textContent = `${challengeSuccesses} / ${challengeAttempts}`;
  }
}

function updateProgress(bytes, total, startedAt) {
  const percent = Math.floor(bytes * 100 / total);
  const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  $('bar').style.width = `${percent}%`;
  $('bar').parentElement.setAttribute('aria-valuenow', String(percent));
  $('progressPercent').textContent = `${percent}%`;
  $('progressBytes').textContent = `${formatBytes(bytes)} / ${formatBytes(total)}`;
  $('progressSpeed').textContent = `${(bytes / seconds / 1024).toFixed(1)} KiB/s`;
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
  if (!currentIdentity) throw new Error('Board reconnected without an identity service; the new image is not running');
  if (pendingOtaVerification.deviceIdentity && currentIdentity.id !== pendingOtaVerification.deviceIdentity) {
    throw new Error(`Reconnected board reports ${currentIdentity.id}, not ${pendingOtaVerification.deviceIdentity}`);
  }
  if (pendingOtaVerification.buildId) {
    if (currentIdentity.build !== pendingOtaVerification.buildId) {
      throw new Error(`Board reports build ${currentIdentity.build}, expected ${pendingOtaVerification.buildId}`);
    }
  } else if (currentIdentity.fw === pendingOtaVerification.previousVersion &&
             currentIdentity.build === pendingOtaVerification.previousBuild) {
    throw new Error(`Board reconnected but still reports ${currentIdentity.fw} (build ${currentIdentity.build})`);
  }
  const echo = await sendControl(Identity.CONTROL.echo, {timeout: 5000, quiet: true});
  if (echo.status !== 0) throw new Error(`Post-reboot echo answered ${echo.statusText}`);
  const previous = pendingOtaVerification.previousVersion;
  pendingOtaVerification = null;
  otaPhase = 'verified';
  setOtaState(`Update verified on ${currentIdentity.id}: ${previous} is now ${currentIdentity.fw} (build ${currentIdentity.build}). Echo answered after reboot.`,
              'success', 'Verified');
  log(`Post-reboot verification passed, ${currentIdentity.fw}, echo ${echo.latencyMs.toFixed(1)} ms.`, 'ESP32 ACK', 'success');
}

async function reconnectAndVerifyOta(onPhase) {
  await waitForBoardDisconnect();
  otaPhase = 'verifying';
  if (onPhase) onPhase('verifying');
  setOtaState('Board reboot detected. Reconnecting and verifying the running build…', 'working', 'Verifying');
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

async function writeFirmwarePacket(packet) {
  // With-response writes use the ATT long-write procedure for values larger
  // than the negotiated MTU, so any payload size up to 512 bytes is safe.
  await fwChar.writeValueWithResponse(packet);
}

async function sendSector(sector, index, payloadSize) {
  for (let attempt = 1; attempt <= SECTOR_RETRIES; attempt++) {
    const packets = BLEOTA.buildSectorPackets(sector, index, payloadSize);
    const ackPromise = waitForSectorAck();
    ackPromise.catch(() => {});
    try {
      for (const packet of packets) await writeFirmwarePacket(packet);
    } catch (error) {
      if (fwWaiter) { clearTimeout(fwWaiter.timer); fwWaiter = null; }
      throw error;
    }
    const ack = await ackPromise;
    if (ack.status === 0 && ack.sectorIndex === index) return {ok: true};
    if (ack.status === 2) return {ok: false, rewindTo: ack.expectedIndex};
    if (ack.status === 5) throw new Error('ESP32 could not start the update (start error 0x0005: slot busy or image too large)');
    log(`Sector ${index} rejected (${ack.statusText}); retry ${attempt} of ${SECTOR_RETRIES}.`, 'ESP32 ACK', 'warn');
  }
  throw new Error(`Sector ${index} was rejected ${SECTOR_RETRIES} times`);
}

// Streams an application image with the gb88 BLEOTA protocol, waits for the
// reboot, reconnects and verifies through the Atech identity service.
async function deployBytes(bytes, meta = {}) {
  if (!isConnected() || !fwChar || !cmdChar) throw new Error('Connect to the ESP32 first');
  if (transferring) throw new Error('A transfer is already in progress');
  const label = meta.fileName || meta.appName || 'firmware.bin';
  if (bytes.length < 1024 || bytes.length > OTA_SLOT_BYTES) throw new Error('Firmware does not fit the 6 MiB OTA slot');
  if (currentIdentity && bytes.length > currentIdentity.slotSize) {
    throw new Error(`Firmware is larger than the board's ${formatBytes(currentIdentity.slotSize)} OTA slot`);
  }
  validateEsp32S3Application(bytes);
  const previousVersion = currentFirmwareVersion;
  const previousBuild = currentIdentity ? currentIdentity.build : null;
  const selectedDeviceId = device.id;
  const deviceIdentity = currentIdentity ? currentIdentity.id : null;
  const startedAt = performance.now();
  let payloadSize = Number($('chunk').value);
  let started = false;

  transferring = true;
  otaPhase = 'uploading';
  stopHeartbeat();
  refreshButtons();
  updateProgress(0, bytes.length, startedAt);
  log(`${label} validated, ${formatBytes(bytes.length)}, ${Math.ceil(bytes.length / BLEOTA.SECTOR_SIZE)} sectors.`, 'BROWSER', 'success');

  try {
    setOtaState('Sending BLEOTA START…', 'working', 'Starting');
    const startAck = waitForCommandAck();
    startAck.catch(() => {});
    await cmdChar.writeValueWithResponse(BLEOTA.buildStartFrame(bytes.length));
    const start = await startAck;
    if (start.commandId !== BLEOTA.COMMANDS.startFlash || start.status !== 0) {
      throw new Error(`ESP32 refused START: ${start.statusText}`);
    }
    started = true;

    const sectors = BLEOTA.splitSectors(bytes);
    let index = 0;
    let sent = 0;
    while (index < sectors.length) {
      setOtaState(`Transferring sector ${index + 1} of ${sectors.length} over Bluetooth…`, 'working', 'Uploading');
      let result;
      try {
        result = await sendSector(sectors[index], index, payloadSize);
      } catch (error) {
        const mtuError = ['NetworkError', 'NotSupportedError', 'InvalidModificationError'].includes(error.name);
        if (index === 0 && payloadSize > 17 && mtuError) {
          payloadSize = 17;
          $('chunk').value = '17';
          log('Large GATT write rejected; retrying with the minimum 17-byte payload.', 'BROWSER', 'warn');
          continue;
        }
        throw error;
      }
      if (!result.ok) {
        log(`ESP32 expects sector ${result.rewindTo}; rewinding.`, 'ESP32 ACK', 'warn');
        index = result.rewindTo;
        sent = index * BLEOTA.SECTOR_SIZE;
        continue;
      }
      sent += sectors[index].length;
      index += 1;
      updateProgress(sent, bytes.length, startedAt);
      if (meta.onProgress) meta.onProgress({bytes: sent, total: bytes.length, startedAt});
      if (index % 32 === 0) log(`${formatBytes(sent)} acknowledged sector by sector.`, 'ESP32 ACK');
    }

    setOtaState('Sending BLEOTA STOP; the ESP32 finalises and verifies the image…', 'working', 'Validating');
    if (meta.onPhase) meta.onPhase('validating');
    const stopAck = waitForCommandAck(30000);
    stopAck.catch(() => {});
    await cmdChar.writeValueWithResponse(BLEOTA.buildStopFrame());
    const stop = await stopAck;
    if (stop.commandId !== BLEOTA.COMMANDS.stop || stop.status !== 0) {
      throw new Error(`ESP32 rejected the image at STOP: ${stop.statusText}`);
    }
    const seconds = (performance.now() - startedAt) / 1000;
    log(`Transfer accepted in ${seconds.toFixed(1)} s at ${(bytes.length / seconds / 1024).toFixed(1)} KiB/s. Success is still pending reboot verification.`,
        'ESP32 ACK', 'success');
    pendingOtaVerification = {deviceId: selectedDeviceId, deviceIdentity, previousVersion, previousBuild,
                              fileName: label, buildId: meta.buildId || null};
    otaPhase = 'rebooting';
    setOtaState('Image accepted by the ESP32. Waiting for the reboot. The update is not yet verified.', 'working', 'Rebooting');
    if (meta.onPhase) meta.onPhase('rebooting');
    await reconnectAndVerifyOta(meta.onPhase);
    return {identity: currentIdentity, firmwareInfo: currentFirmwareVersion};
  } catch (error) {
    log(error.message, 'BROWSER', 'error');
    if (otaPhase === 'uploading') {
      setOtaState('OTA failed or was interrupted. The previous firmware should remain bootable.', 'error', 'Failed');
      if (started && isConnected()) {
        // gb88 has no abort command; a fresh START resets its state machine on the next attempt.
        log('No BLEOTA abort command exists; the device resets its OTA state on the next START.', 'BROWSER', 'warn');
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
    validateEsp32S3Application(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
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
    if (pendingOtaVerification) setOtaState(`${error.message} The update remains unverified.`, 'error', 'Needs verification');
    refreshButtons();
  }
});
$('disconnect').addEventListener('click', () => { if (isConnected()) device.gatt.disconnect(); });
$('testConnection').addEventListener('click', async () => { try { await runChallengeTest(); } catch (_) {} });
$('bin').addEventListener('change', validateSelectedFile);
$('deploy').addEventListener('click', async () => { try { await deploy(); } catch (_) {} });
$('clearLog').addEventListener('click', () => { $('log').replaceChildren(); log('Activity log cleared.'); });
if (!bluetoothAvailable) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = !window.isSecureContext
    ? 'Web Bluetooth requires HTTPS or http://localhost, so the Bluetooth backup is unavailable here. Wi-Fi deployment through the builder backend does not need it.'
    : 'This browser does not expose Web Bluetooth (Safari). Wi-Fi deployment through the builder backend works here; Bluetooth is unavailable as a backup.';
  $('connect').disabled = true;
}

// Transport handed to the shared AI firmware builder card.
window.AtechDemo2Transport = {
  name: 'gb88 BLEOTA',
  bluetoothAvailable,
  isConnected,
  identity: () => currentIdentity,
  readIdentity,
  deploy: deployBytes,
  control: opcode => sendControl(opcode),
  provisioning: null,   // set on connect when the board has the Wi-Fi setup service
  sync: null,           // set on connect when the board has the board sync status service
  transferring: () => transferring,
};

setConnectionState('offline', 'Bluetooth off');
setSignalState('offline', 'None');
setOtaState('Connect an ESP32-S3 running the Demo 2 image, then build with the AI card or choose a firmware.bin.', 'neutral', 'Ready');
renderIdentity();
log('Dashboard ready. gb88 BLEOTA transport with Atech identity verification; nothing counts as success without the board reporting the new build.');
if (globalThis.AtechBuilder) {
  builder = AtechBuilder.mount({demo: 2, transport: window.AtechDemo2Transport, log});
} else {
  log('AI builder module did not load; serve this page from the builder backend (cd builder && npm start).', 'BROWSER', 'warn');
}
