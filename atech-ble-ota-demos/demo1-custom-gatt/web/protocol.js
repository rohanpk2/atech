'use strict';

(function attachAtechBleProtocol(root) {
  const ESP_IMAGE_MAGIC = 0xE9;
  const ESP32_S3_CHIP_ID = 9;
  const ESP_APP_DESC_MAGIC = 0xABCD5432;
  const COMMAND_PROTOCOL_VERSION = 1;
  const COMMAND_PACKET_SIZE = 20;

  const COMMANDS = Object.freeze({
    'ping': 0x01,
    'blink blue': 0x02,
    'blink green': 0x03,
    'stop blinking': 0x04,
    'get status': 0x05,
    'resume app': 0x06,
  });
  const COMMAND_NAMES = Object.freeze(Object.fromEntries(
    Object.entries(COMMANDS).map(([name, opcode]) => [opcode, name])
  ));
  const LED_MODES = Object.freeze({0: 'stopped', 1: 'blinking blue', 2: 'blinking green', 3: 'app controlled'});
  const RESPONSE_STATUSES = Object.freeze({
    0: 'executed',
    1: 'malformed request',
    2: 'request CRC error',
    3: 'unsupported command',
    4: 'device busy with OTA',
  });

  function asBytes(value, expectedLength) {
    if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
    if (expectedLength !== undefined && value.byteLength !== expectedLength) {
      throw new Error(`Expected ${expectedLength} bytes, received ${value.byteLength}`);
    }
    return value;
  }

  function crc16(bytes) {
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc;
  }

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) >>> 0;
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function normalizeCommand(value) {
    const command = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!Object.hasOwn(COMMANDS, command)) {
      throw new Error(`Unsupported command. Use: ${Object.keys(COMMANDS).join(', ')}`);
    }
    return command;
  }

  function bytesToHex(bytes) {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function bytesEqual(left, right) {
    return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
  }

  function buildCommandPacket({requestId, opcode, nonce = new Uint8Array(8)}) {
    asBytes(nonce, 8);
    if (!Number.isInteger(requestId) || requestId < 0 || requestId > 0xFFFFFFFF) {
      throw new Error('Request ID must be a uint32');
    }
    const packet = new Uint8Array(COMMAND_PACKET_SIZE);
    const view = new DataView(packet.buffer);
    packet[0] = COMMAND_PROTOCOL_VERSION;
    view.setUint32(1, requestId, true);
    packet[5] = opcode;
    packet.set(nonce, 6);
    view.setUint16(18, crc16(packet.subarray(0, 18)), true);
    return packet;
  }

  function parseCommandPacket(packet) {
    asBytes(packet, COMMAND_PACKET_SIZE);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (packet[0] !== COMMAND_PROTOCOL_VERSION) throw new Error('Unsupported command protocol version');
    if (view.getUint16(18, true) !== crc16(packet.subarray(0, 18))) {
      throw new Error('Command packet CRC mismatch');
    }
    return {
      requestId: view.getUint32(1, true),
      opcode: packet[5],
      nonce: packet.slice(6, 14),
    };
  }

  function buildResponsePacket({requestId, opcode, status, ledMode, nonce,
                                firmwareVersion, flags = 0}) {
    asBytes(nonce, 8);
    const packet = new Uint8Array(COMMAND_PACKET_SIZE);
    const view = new DataView(packet.buffer);
    packet[0] = COMMAND_PROTOCOL_VERSION;
    view.setUint32(1, requestId, true);
    packet[5] = opcode;
    packet[6] = status;
    packet[7] = ledMode;
    packet.set(nonce, 8);
    packet[16] = firmwareVersion;
    packet[17] = flags;
    view.setUint16(18, crc16(packet.subarray(0, 18)), true);
    return packet;
  }

  function parseCommandResponse(packet) {
    asBytes(packet, COMMAND_PACKET_SIZE);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (packet[0] !== COMMAND_PROTOCOL_VERSION) throw new Error('Unsupported response protocol version');
    if (view.getUint16(18, true) !== crc16(packet.subarray(0, 18))) {
      throw new Error('Response CRC mismatch');
    }
    return {
      requestId: view.getUint32(1, true),
      opcode: packet[5],
      command: COMMAND_NAMES[packet[5]] || `opcode 0x${packet[5].toString(16)}`,
      status: packet[6],
      statusText: RESPONSE_STATUSES[packet[6]] || `device error ${packet[6]}`,
      ledMode: packet[7],
      ledModeText: LED_MODES[packet[7]] || `unknown mode ${packet[7]}`,
      nonce: packet.slice(8, 16),
      firmwareVersion: packet[16],
      updating: Boolean(packet[17] & 0x01),
    };
  }

  function buildStartPacket(size, crc) {
    const packet = new Uint8Array(9);
    const view = new DataView(packet.buffer);
    packet[0] = 0x01;
    view.setUint32(1, size, true);
    view.setUint32(5, crc, true);
    return packet;
  }

  function validateEsp32S3Application(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 36) {
      throw new Error('File is too small to be an ESP32 application image');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint8(0) !== ESP_IMAGE_MAGIC) {
      throw new Error('Invalid ESP firmware image magic');
    }
    const chipId = view.getUint16(12, true);
    if (chipId !== ESP32_S3_CHIP_ID) {
      throw new Error(`Firmware targets ESP chip ID ${chipId}, not ESP32-S3 (chip ID 9)`);
    }
    // ESP applications put esp_app_desc_t first in the first image segment.
    if (view.getUint32(32, true) !== ESP_APP_DESC_MAGIC) {
      throw new Error('File is not an ESP application image (use firmware.bin, not bootloader.bin)');
    }
  }

  const api = Object.freeze({
    COMMANDS,
    COMMAND_NAMES,
    LED_MODES,
    RESPONSE_STATUSES,
    crc16,
    crc32,
    normalizeCommand,
    bytesToHex,
    bytesEqual,
    buildCommandPacket,
    parseCommandPacket,
    buildResponsePacket,
    parseCommandResponse,
    buildStartPacket,
    validateEsp32S3Application,
  });
  root.AtechOtaProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
