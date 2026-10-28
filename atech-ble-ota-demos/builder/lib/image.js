'use strict';

// ESP application image checks shared by the backend validator and tests.
// Mirrors the browser-side protocol.validateEsp32S3Application() and the
// device-side Wi-Fi portal checks so every path rejects the same images.
const ESP_IMAGE_MAGIC = 0xE9;
const ESP32_S3_CHIP_ID = 9;
const ESP_APP_DESC_MAGIC = 0xABCD5432;
const FLASH_16MB_CODE = 4;
const MIN_IMAGE_BYTES = 1024;

function parseImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 36) {
    return {magic: 0, segmentCount: 0, chipId: -1, flashSizeCode: -1, appDescMagic: 0};
  }
  return {
    magic: buf[0],
    segmentCount: buf[1],
    chipId: buf.readUInt16LE(12),
    flashSizeCode: buf[3] >> 4,
    appDescMagic: buf.readUInt32LE(32),
  };
}

function validateImage(buf, {slotSize, sizeMargin = 0, markers = []}) {
  const errors = [];
  const size = Buffer.isBuffer(buf) ? buf.length : 0;
  const info = parseImage(buf);
  if (size < MIN_IMAGE_BYTES) errors.push(`Image is only ${size} bytes; not an ESP application image`);
  if (info.magic !== ESP_IMAGE_MAGIC) errors.push('Not an ESP firmware image (bad magic byte)');
  if (info.chipId !== ESP32_S3_CHIP_ID) {
    errors.push(`Firmware targets chip id ${info.chipId}, not ESP32-S3 (chip id 9)`);
  }
  if (info.flashSizeCode !== FLASH_16MB_CODE) {
    errors.push('Firmware flash-size header is not the configured 16MB board');
  }
  if (info.appDescMagic !== ESP_APP_DESC_MAGIC) {
    errors.push('Not an application image (no app descriptor; bootloader/partition/merged images are rejected)');
  }
  const limit = slotSize - sizeMargin;
  if (size > limit) {
    errors.push(`Image is ${size} bytes but the OTA slot allows ${limit} (${slotSize} minus a ${sizeMargin}-byte margin)`);
  }
  for (const marker of markers) {
    if (!Buffer.isBuffer(buf) || buf.indexOf(marker, 0, 'latin1') < 0) {
      errors.push(`Expected marker "${marker}" was not found in the image`);
    }
  }
  return {ok: errors.length === 0, errors, size, chipId: info.chipId};
}

module.exports = {parseImage, validateImage, ESP_IMAGE_MAGIC, ESP32_S3_CHIP_ID, ESP_APP_DESC_MAGIC};
