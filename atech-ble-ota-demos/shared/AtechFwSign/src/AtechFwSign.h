// AtechFwSign.h: firmware signature verification shared by every install path (cloud pull, LAN
// service, hotspot upload) through atech::ImageSink. The build service signs a manifest with its
// ECDSA P-256 key; the board verifies it with the public key it was compiled with
// (ATECH_FW_PUBKEY) or the key pinned in NVS over an authenticated channel, and refuses a lower app
// version unless the signed manifest allows the downgrade. Part of the protected core; generated
// application code never sees this header. The canonical string is shared with
// builder/lib/signing.js; keep the two identical.
#pragma once

#include <Arduino.h>

namespace atech {
namespace fwsign {

struct Manifest {
  String build;         // backend build id ("ATECH-BUILD:<id>" marker)
  uint8_t demo = 0;     // 1 or 2
  uint32_t size = 0;    // image bytes
  String sha256;        // lowercase hex of the image
  uint32_t version = 0; // app version (monotonic per demo on the backend)
  bool downgrade = false;
  String target;        // device id the deployment is for, or empty
  String signature;     // 128 hex: ECDSA P-256 r||s over SHA-256 of canonical()
  // The key an authenticated upload carries (X-Atech-Key) while this board has none pinned yet: the
  // manifest is verified against it first, and the caller pins it only once the image was accepted.
  String candidateKey;
};

// Loads the pinned key and the highest confirmed version. compiledPubKeyHex may be empty.
bool begin(const char *compiledPubKeyHex, bool allowUnsigned, const char *preferencesNamespace = "atech_fw");
bool hasKey();
String keyHex();                 // the effective public key (NVS wins over the compiled one), or ""
String keyIdHex();               // first 8 hex of SHA-256(key bytes), or ""
const char *keySource();         // "compiled", "nvs" or "none"
// Pins a key when none is known; a different key already known is refused (false).
bool pinKey(const String &hex, const char *source);
// Replaces the pinned key (authorized rotation through the hotspot page or Bluetooth setup).
bool replaceKey(const String &hex, const char *source);
bool keyMatches(const String &hex);
String canonical(const Manifest &manifest);
// Signature, then version policy. `reason` explains a false.
bool verify(const Manifest &manifest, String &reason);
uint32_t maxVersion();
void recordRunningVersion(uint32_t version);   // called once the running image is confirmed
bool allowUnsigned();
String statusJson();             // {"key":bool,"kid":"..","source":"..","max_ver":N,"unsigned_ok":bool}

}  // namespace fwsign
}  // namespace atech
