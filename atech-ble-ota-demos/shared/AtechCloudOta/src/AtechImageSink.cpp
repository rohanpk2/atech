// AtechImageSink.cpp: see AtechImageSink.h. Mirrors the LAN service's upload
// session so an image accepted by one path is exactly the image accepted by
// the other.
#include "AtechImageSink.h"

#include <AtechCore.h>
#include <esp_app_desc.h>

#include <algorithm>
#include <cstring>

namespace atech {

namespace {

constexpr char TARGET_PREFIX[] = "ATECH-TARGET:";
constexpr char BUILD_PREFIX[] = "ATECH-BUILD:";
constexpr size_t MIN_IMAGE_BYTES = 1024;
const char HEX_DIGITS[] = "0123456789abcdef";

String hexEncode(const uint8_t *bytes, size_t length) {
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out += HEX_DIGITS[bytes[i] >> 4];
    out += HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

bool constantTimeEquals(const String &left, const String &right) {
  if (left.length() != right.length()) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < left.length(); ++i) difference |= uint8_t(left[i] ^ right[i]);
  return difference == 0;
}

}  // namespace

void MarkerScanner::reset(const uint8_t *bytes, size_t count) {
  length = std::min(count, sizeof(marker));
  memcpy(marker, bytes, length);
  matched = 0;
  found = false;
  failure[0] = 0;
  size_t k = 0;
  for (size_t i = 1; i < length; ++i) {
    while (k > 0 && marker[i] != marker[k]) k = failure[k - 1];
    if (marker[i] == marker[k]) ++k;
    failure[i] = static_cast<uint8_t>(k);
  }
}

void MarkerScanner::feed(const uint8_t *data, size_t count) {
  if (found || length == 0) return;
  for (size_t i = 0; i < count; ++i) {
    while (matched > 0 && data[i] != marker[matched]) matched = failure[matched - 1];
    if (data[i] == marker[matched]) {
      ++matched;
      if (matched == length) { found = true; return; }
    }
  }
}

void TargetScanner::reset() {
  prefix.reset(reinterpret_cast<const uint8_t *>(TARGET_PREFIX), sizeof(TARGET_PREFIX) - 1);
  capturedLength = 0;
  complete = false;
  captured[0] = '\0';
}

void TargetScanner::feed(const uint8_t *data, size_t count) {
  if (complete) return;
  size_t i = 0;
  if (!prefix.found) {
    for (; i < count && !prefix.found; ++i) prefix.feed(data + i, 1);
    if (!prefix.found) return;
  }
  for (; i < count; ++i) {
    if (data[i] == 0 || capturedLength >= sizeof(captured) - 1) {
      captured[capturedLength] = '\0';
      complete = true;
      return;
    }
    captured[capturedLength++] = static_cast<char>(data[i]);
  }
}

ImageSink::ImageSink() {}
ImageSink::~ImageSink() { release(); }

void ImageSink::release() {
  if (_handleActive) {
    esp_ota_abort(_handle);
    _handleActive = false;
    _handle = 0;
  }
  if (_shaStarted) {
    mbedtls_sha256_free(&_sha);
    _shaStarted = false;
  }
  _active = false;
}

void ImageSink::abort() { release(); }

bool ImageSink::begin(uint32_t size, const String &sha256Hex, const String &buildId, const String &imageIdentity, String &reason) {
  release();
  if (size < MIN_IMAGE_BYTES) { reason = F("Declared image size is too small for an application"); return false; }
  if (sha256Hex.length() != 64) { reason = F("Declared SHA-256 is not 64 hex characters"); return false; }
  if (buildId.isEmpty() || buildId.length() > 40) { reason = F("Missing or invalid build id"); return false; }
  const esp_partition_t *running = esp_ota_get_running_partition();
  _partition = esp_ota_get_next_update_partition(nullptr);
  if (!_partition || _partition == running) { reason = F("No inactive OTA application partition is available"); return false; }
  if (size > _partition->size) {
    reason = String(F("Firmware is larger than the inactive OTA slot (")) + String(_partition->size) + F(" bytes)");
    return false;
  }
  const esp_err_t result = esp_ota_begin(_partition, size, &_handle);
  if (result != ESP_OK) { reason = String(F("Could not begin inactive-partition update: ")) + esp_err_to_name(result); return false; }
  _handleActive = true;
  _expected = size;
  _received = 0;
  _expectedSha = sha256Hex;
  _expectedSha.toLowerCase();
  _buildId = buildId;
  _digest = "";
  _prefixLength = 0;
  _headerOk = false;
  mbedtls_sha256_init(&_sha);
  mbedtls_sha256_starts(&_sha, 0);
  _shaStarted = true;
  _identity.reset(reinterpret_cast<const uint8_t *>(imageIdentity.c_str()), imageIdentity.length());
  const String buildMarker = String(BUILD_PREFIX) + buildId;
  _build.reset(reinterpret_cast<const uint8_t *>(buildMarker.c_str()), buildMarker.length() + 1);  // include the NUL
  _target.reset();
  _active = true;
  return true;
}

bool ImageSink::validatePrefix(String &reason) {
  esp_image_header_t imageHeader = {};
  memcpy(&imageHeader, _prefix, sizeof(imageHeader));
  if (imageHeader.magic != ESP_IMAGE_HEADER_MAGIC) { reason = F("Not an ESP application image (bad magic byte)"); return false; }
  if (imageHeader.segment_count == 0 || imageHeader.segment_count > ESP_IMAGE_MAX_SEGMENTS) { reason = F("Invalid ESP application segment count"); return false; }
  if (imageHeader.chip_id != ESP_CHIP_ID_ESP32S3) { reason = F("Firmware target is not ESP32-S3"); return false; }
  if (imageHeader.spi_size != ESP_IMAGE_FLASH_SIZE_16MB) { reason = F("Firmware flash target is not the configured 16MB board"); return false; }
  uint32_t descriptorMagic = 0;
  memcpy(&descriptorMagic, _prefix + sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t), sizeof(descriptorMagic));
  if (descriptorMagic != ESP_APP_DESC_MAGIC_WORD) { reason = F("Image is not an application firmware.bin (bootloader/merged images are rejected)"); return false; }
  return true;
}

bool ImageSink::write(const uint8_t *data, size_t length, String &reason) {
  if (!_active) { reason = F("No image transfer is active"); return false; }
  if (length > _expected - _received) { reason = F("Received more bytes than declared"); return false; }
  if (mbedtls_sha256_update(&_sha, data, length) != 0) { reason = F("SHA-256 update failed"); return false; }
  _identity.feed(data, length);
  _build.feed(data, length);
  _target.feed(data, length);
  _received += length;
  if (!_headerOk) {
    const size_t toCopy = std::min(length, sizeof(_prefix) - _prefixLength);
    memcpy(_prefix + _prefixLength, data, toCopy);
    _prefixLength += toCopy;
    if (_prefixLength < sizeof(_prefix)) return true;   // still accumulating the header; nothing written yet
    if (!validatePrefix(reason)) return false;
    _headerOk = true;
    const esp_err_t prefixResult = esp_ota_write(_handle, _prefix, sizeof(_prefix));
    if (prefixResult != ESP_OK) { reason = String(F("Flash write failed: ")) + esp_err_to_name(prefixResult); return false; }
    data += toCopy;
    length -= toCopy;
    if (length == 0) return true;
  }
  const esp_err_t result = esp_ota_write(_handle, data, length);
  if (result != ESP_OK) { reason = String(F("Flash write failed: ")) + esp_err_to_name(result); return false; }
  return true;
}

bool ImageSink::finish(String &reason) {
  if (!_active) { reason = F("No image transfer is active"); return false; }
  if (_received != _expected) {
    reason = String(F("Download incomplete: ")) + String(_received) + F(" of ") + String(_expected) + F(" bytes");
    return false;
  }
  if (!_headerOk) { reason = F("Application header was never validated"); return false; }
  if (!_identity.found) { reason = F("Firmware belongs to a different Atech demo/target"); return false; }
  if (!_build.found) { reason = String(F("Image does not carry build id ")) + _buildId; return false; }
  if (_target.complete && _target.capturedLength > 0 && strcmp(_target.captured, atech::deviceId()) != 0) {
    reason = String(F("Image was built for ")) + _target.captured + F(", not this board");
    return false;
  }
  uint8_t digest[32] = {};
  if (mbedtls_sha256_finish(&_sha, digest) != 0) { reason = F("SHA-256 finalization failed"); return false; }
  mbedtls_sha256_free(&_sha);
  _shaStarted = false;
  _digest = hexEncode(digest, sizeof(digest));
  if (!constantTimeEquals(_digest, _expectedSha)) { reason = F("Image SHA-256 does not match the declared digest; inactive partition not selected"); return false; }
  // esp_ota_end validates the ESP image (checksum, appended hash, and when enabled secure boot
  // and anti-rollback). It never selects the image.
  const esp_err_t validation = esp_ota_end(_handle);
  _handleActive = false;
  _handle = 0;
  if (validation != ESP_OK) { reason = String(F("ESP image verification failed: ")) + esp_err_to_name(validation); _active = false; return false; }
  const esp_err_t activation = esp_ota_set_boot_partition(_partition);
  if (activation != ESP_OK) { reason = String(F("Verified image could not be selected: ")) + esp_err_to_name(activation); _active = false; return false; }
  _active = false;
  return true;
}

}  // namespace atech
