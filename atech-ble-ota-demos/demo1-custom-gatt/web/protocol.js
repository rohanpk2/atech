'use strict';

(function attachAtechOtaProtocol(root) {
  const ESP_IMAGE_MAGIC = 0xE9;
  const ESP32_S3_CHIP_ID = 9;
  const ESP_APP_DESC_MAGIC = 0xABCD5432;

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) >>> 0;
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
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
    // ESP application images put esp_app_desc_t first in the first segment.
    // This rejects bootloader.bin and most non-application ESP images.
    if (view.getUint32(32, true) !== ESP_APP_DESC_MAGIC) {
      throw new Error('File is not an ESP application image (use firmware.bin, not bootloader.bin)');
    }
  }

  const api = Object.freeze({crc32, buildStartPacket, validateEsp32S3Application});
  root.AtechOtaProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
