// AtechImageSink.h: streams an application image into the inactive OTA slot
// with the same checks the LAN service applies (ESP header, demo identity,
// build id, target device, SHA-256, ESP image validation) and selects the
// slot only when every check passed. Part of the protected core.
#pragma once

#include <Arduino.h>
#include <esp_app_format.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

namespace atech {

// Streaming substring search with a KMP failure table so a marker is found even
// when a partial match overlaps the real one.
struct MarkerScanner {
  uint8_t marker[80] = {};
  uint8_t failure[80] = {};
  size_t length = 0;
  size_t matched = 0;
  bool found = false;
  void reset(const uint8_t *bytes, size_t count);
  void feed(const uint8_t *data, size_t count);
};

// Finds "ATECH-TARGET:" and captures the NUL-terminated device id after it.
struct TargetScanner {
  MarkerScanner prefix;
  char captured[21] = {};
  size_t capturedLength = 0;
  bool complete = false;
  void reset();
  void feed(const uint8_t *data, size_t count);
};

class ImageSink {
public:
  ImageSink();
  ~ImageSink();
  ImageSink(const ImageSink &) = delete;
  ImageSink &operator=(const ImageSink &) = delete;

  // Erases the inactive slot (esp_ota_begin) and arms the checks. `reason` explains a false.
  bool begin(uint32_t size, const String &sha256Hex, const String &buildId, const String &imageIdentity, String &reason);
  // Hashes, scans and writes the bytes; the first 36 bytes are held back until the header is valid.
  bool write(const uint8_t *data, size_t length, String &reason);
  // Completeness, markers, digest, esp_ota_end and esp_ota_set_boot_partition. The slot is
  // selected only when this returns true.
  bool finish(String &reason);
  // Discards everything written so far; safe to call at any point, including after finish.
  void abort();

  bool active() const { return _active; }
  uint32_t received() const { return _received; }
  uint32_t expected() const { return _expected; }
  const char *partitionLabel() const { return _partition ? _partition->label : ""; }
  const String &digestHex() const { return _digest; }

private:
  bool validatePrefix(String &reason);
  void release();

  bool _active = false;
  bool _handleActive = false;
  bool _shaStarted = false;
  bool _headerOk = false;
  uint32_t _expected = 0;
  uint32_t _received = 0;
  String _expectedSha;
  String _buildId;
  String _digest;
  const esp_partition_t *_partition = nullptr;
  esp_ota_handle_t _handle = 0;
  mbedtls_sha256_context _sha;
  uint8_t _prefix[sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(uint32_t)] = {};
  size_t _prefixLength = 0;
  MarkerScanner _identity;
  MarkerScanner _build;
  TargetScanner _target;
};

}  // namespace atech
