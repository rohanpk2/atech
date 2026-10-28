'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol.js');

const vector = new TextEncoder().encode('123456789');
assert.equal(protocol.crc16(vector), 0x31C3, 'CRC16/CCITT init=0 golden vector');
assert.equal(protocol.crc32(vector), 0xCBF43926, 'CRC32 golden vector');

assert.equal(protocol.normalizeCommand('  BLINK   GREEN '), 'blink green');
assert.equal(protocol.normalizeCommand('get status'), 'get status');
assert.throws(() => protocol.normalizeCommand('run arbitrary code'), /Unsupported command/);

const nonce = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
const commandPacket = protocol.buildCommandPacket({
  requestId: 0x12345678,
  opcode: protocol.COMMANDS.ping,
  nonce,
});
assert.equal(commandPacket.byteLength, 20);
assert.deepEqual(protocol.parseCommandPacket(commandPacket), {
  requestId: 0x12345678,
  opcode: protocol.COMMANDS.ping,
  nonce,
});
const corruptedCommand = commandPacket.slice();
corruptedCommand[8] ^= 0x80;
assert.throws(() => protocol.parseCommandPacket(corruptedCommand), /CRC mismatch/);

const responsePacket = protocol.buildResponsePacket({
  requestId: 0x12345678,
  opcode: protocol.COMMANDS.ping,
  status: 0,
  ledMode: 2,
  nonce,
  firmwareVersion: 2,
  flags: 0,
});
const response = protocol.parseCommandResponse(responsePacket);
assert.equal(response.requestId, 0x12345678);
assert.equal(response.command, 'ping');
assert.equal(response.statusText, 'executed');
assert.equal(response.ledModeText, 'blinking green');
assert.equal(response.firmwareVersion, 2);
assert.equal(response.updating, false);
assert(protocol.bytesEqual(response.nonce, nonce), 'response echoes the exact challenge');
assert.equal(protocol.bytesToHex(response.nonce), '0011223344556677');

const busyResponse = protocol.parseCommandResponse(protocol.buildResponsePacket({
  requestId: 4,
  opcode: protocol.COMMANDS['get status'],
  status: 4,
  ledMode: 1,
  nonce: new Uint8Array(8),
  firmwareVersion: 1,
  flags: 1,
}));
assert.equal(busyResponse.statusText, 'device busy with OTA');
assert.equal(busyResponse.updating, true);

const start = protocol.buildStartPacket(0x12345678, 0x90ABCDEF);
assert.deepEqual([...start], [1, 0x78, 0x56, 0x34, 0x12, 0xEF, 0xCD, 0xAB, 0x90]);

const sample = new Uint8Array(64);
const sampleView = new DataView(sample.buffer);
sample[0] = 0xE9;
sampleView.setUint16(12, 9, true);
sampleView.setUint32(32, 0xABCD5432, true);
assert.doesNotThrow(() => protocol.validateEsp32S3Application(sample));
sampleView.setUint16(12, 0, true);
assert.throws(() => protocol.validateEsp32S3Application(sample), /not ESP32-S3/);

const projectRoot = path.join(__dirname, '..');
const firmwareSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.cpp'), 'utf8');
assert.match(firmwareSource, /COMMAND_PROTOCOL_VERSION = 1/);
assert.match(firmwareSource, /COMMAND_PACKET_SIZE = 20/);
assert.match(firmwareSource, /Ping = 0x01/);
assert.match(firmwareSource, /BlinkBlue = 0x02/);
assert.match(firmwareSource, /BlinkGreen = 0x03/);
assert.match(firmwareSource, /StopBlinking = 0x04/);
assert.match(firmwareSource, /GetStatus = 0x05/);
assert.match(firmwareSource, /ResumeApp = 0x06/);
assert.match(firmwareSource, /atech::coreBegin\(/);
assert.match(firmwareSource, /atech::coreAttachBle\(/);
assert.match(firmwareSource, /atech::coreSuspendApp\(\)/);
assert.match(firmwareSource, /"ATECH-BUILD:" ATECH_BUILD_ID/);
assert.match(firmwareSource, /#include "app\/app_build\.h"/);
assert.equal(protocol.LED_MODES[3], 'app controlled');
assert.equal(protocol.COMMANDS['resume app'], 0x06);
const userApp = fs.readFileSync(path.join(projectRoot, 'src', 'app', 'user_app.cpp'), 'utf8');
assert.match(userApp, /#include <AtechApp\.h>/);
assert.match(userApp, /void appSetup\(\)/);
assert.match(userApp, /void appLoop\(\)/);
const platformioIni = fs.readFileSync(path.join(projectRoot, 'platformio.ini'), 'utf8');
assert.match(platformioIni, /\[env:ai\]/);

const buildRoot = path.join(projectRoot, '.pio', 'build');
const firmwarePath = path.join(buildRoot, 'updated', 'firmware.bin');
const bootloaderPath = path.join(buildRoot, 'base', 'bootloader.bin');
if (fs.existsSync(firmwarePath)) {
  const firmware = new Uint8Array(fs.readFileSync(firmwarePath));
  assert.doesNotThrow(() => protocol.validateEsp32S3Application(firmware));
}
if (fs.existsSync(bootloaderPath)) {
  const bootloader = new Uint8Array(fs.readFileSync(bootloaderPath));
  assert.throws(() => protocol.validateEsp32S3Application(bootloader), /not an ESP application image/);
}

console.log('Command, challenge-response, and OTA protocol tests passed');
