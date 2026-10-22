'use strict';
const SERVICE = 'a7ec0001-2e47-4dd2-82a4-9c2cf6eaa001';
const CONTROL = 'a7ec0002-2e47-4dd2-82a4-9c2cf6eaa001';
const DATA = 'a7ec0003-2e47-4dd2-82a4-9c2cf6eaa001';
const STATUS = 'a7ec0004-2e47-4dd2-82a4-9c2cf6eaa001';
const INFO = 'a7ec0005-2e47-4dd2-82a4-9c2cf6eaa001';

const $ = (id) => document.getElementById(id);
let device, controlChar, dataChar, statusChar, infoChar;
let waiter = null;
let transferring = false;
const decoder = new TextDecoder();
function log(line) {
  $('log').textContent += `\n${new Date().toLocaleTimeString()} ${line}`;
  $('log').scrollTop = $('log').scrollHeight;
}
function progress(bytes, total, start) {
  const pct = Math.floor(bytes * 100 / total);
  const bps = (bytes / Math.max(.001, (performance.now() - start) / 1000));
  $('bar').style.width = `${pct}%`;
  $('progress').textContent = `${pct}% · ${bytes.toLocaleString()} / ${total.toLocaleString()} bytes · ${(bps/1024).toFixed(1)} KiB/s`;
}
function setState(s) { $('state').textContent = s; }
function refreshButtons() {
  const connected = !!(device?.gatt?.connected);
  $('connect').disabled = transferring || connected;
  $('disconnect').disabled = transferring || !connected;
  $('deploy').disabled = transferring || !connected || !$('bin').files.length;
}
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function onStatus(event) {
  const v = event.target.value;
  if (v.byteLength < 5) return;
  const data = {code:v.getUint8(0), offset:v.getUint32(1,true)};
  if (waiter && waiter.match(data)) {
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.resolve(data);
  }
}
function waitFor(match, timeout=20000) {
  if (waiter) throw new Error('Internal protocol error: multiple pending ACKs');
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { waiter = null; reject(new Error('Timed out waiting for board ACK')); }, timeout);
    waiter = {resolve,reject,match,timer};
  });
}
async function sendAndWait(characteristic, bytes, predicate, timeout=20000) {
  // Attach listener first: board can notify before writeValueWithResponse returns.
  const promise = waitFor(msg => msg.code >= 0xE0 || predicate(msg), timeout);
  try {
    await characteristic.writeValueWithResponse(bytes);
  } catch (error) {
    if (waiter) { clearTimeout(waiter.timer); waiter = null; }
    // Avoid leaving a rejected promise unobserved when the write fails.
    promise.catch(() => {});
    throw error;
  }
  const result = await promise;
  if (result.code >= 0xE0) throw new Error(`ESP32 OTA error 0x${result.code.toString(16)} after ${result.offset} bytes`);
  return result;
}
async function connect() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable. Use desktop Chrome on macOS, served from localhost or HTTPS.');
  device = await navigator.bluetooth.requestDevice({
    filters:[{namePrefix:'Atech-Custom-OTA'}], optionalServices:[SERVICE]
  });
  device.addEventListener('gattserverdisconnected', () => {
    $('device').textContent = 'Device: disconnected';
    refreshButtons();
    log('Bluetooth disconnected');
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE);
  controlChar = await service.getCharacteristic(CONTROL);
  dataChar = await service.getCharacteristic(DATA);
  statusChar = await service.getCharacteristic(STATUS);
  infoChar = await service.getCharacteristic(INFO);
  statusChar.addEventListener('characteristicvaluechanged', onStatus);
  await statusChar.startNotifications();
  const value = await infoChar.readValue();
  $('version').textContent = `Firmware: ${decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}`;
  $('device').textContent = `Connected: ${device.name}`;
  setState('Ready for firmware file.');
  log(`Connected to ${device.name}`);
  refreshButtons();
}
async function deploy() {
  if (!device?.gatt?.connected || !$('bin').files.length) return;
  const file = $('bin').files[0];
  if (!file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose a compiled firmware .bin file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > 5.9 * 1024 * 1024) throw new Error('Invalid firmware size for demo 6MB OTA slot');
  const hash = crc32(bytes);
  log(`Selected ${file.name}: ${bytes.length} bytes, CRC32 0x${hash.toString(16)}`);
  transferring = true;
  refreshButtons();
  const start = new Uint8Array(9);
  const dv = new DataView(start.buffer);
  start[0] = 1;
  dv.setUint32(1, bytes.length, true);
  dv.setUint32(5, hash, true);
  const startTime = performance.now();
  let initialized = false;
  try {
    setState('Starting OTA session…');
    await sendAndWait(controlChar, start, x => x.code===0x10 && x.offset===0);
    initialized = true;
    let size = Number($('chunk').value);
    for (let offset=0; offset<bytes.length;) {
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + size));
      setState('Transferring over Bluetooth…');
      try {
        await sendAndWait(dataChar, slice, x => x.code===0x11 && x.offset===offset+slice.length);
      } catch (err) {
        if (offset === 0 && size > 20 && (err.name === 'NetworkError' || err.name === 'NotSupportedError' || err.name === 'InvalidModificationError')) {
          size=20;
          log('Large GATT write rejected; retrying with 20-byte chunks');
          continue;
        }
        throw err;
      }
      offset += slice.length;
      progress(offset, bytes.length, startTime);
      if (offset % (size*100) === 0) log(`Committed ${offset.toLocaleString()} bytes`);
    }
    setState('Verifying CRC and activating new firmware…');
    await sendAndWait(controlChar, new Uint8Array([2]), x => x.code === 0x12, 30000);
    const sec = (performance.now() - startTime) / 1000;
    log(`OTA complete in ${sec.toFixed(1)}s; board should reboot`);
    setState('OTA complete. ESP32 rebooting. Reconnect to verify v2 firmware.');
  } catch (err) {
    log('ERROR: '+err.message);
    setState('OTA interrupted / failed. Existing firmware should remain bootable; reset and retry.');
    if (initialized && device?.gatt?.connected) {
      try { await controlChar.writeValueWithResponse(new Uint8Array([3])); } catch (_) {}
    }
    throw err;
  } finally { transferring = false; refreshButtons(); }
}
$('connect').addEventListener('click', async()=>{
  try { await connect(); } catch(e) { setState('Connection failed: '+e.message); log('ERROR: '+e.message); }
});
$('disconnect').addEventListener('click',()=> { if (device?.gatt?.connected) device.gatt.disconnect(); });
$('bin').addEventListener('change',refreshButtons);
$('deploy').addEventListener('click', async()=>{ try{await deploy();}catch(e){log(e.stack || e.message);} });
refreshButtons();
