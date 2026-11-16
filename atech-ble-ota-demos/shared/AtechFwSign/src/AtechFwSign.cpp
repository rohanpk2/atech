// AtechFwSign.cpp: see AtechFwSign.h. Mirrors builder/lib/signing.js.
#include "AtechFwSign.h"

#include <Preferences.h>
#include <mbedtls/bignum.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <mbedtls/sha256.h>

#include <cstring>

namespace atech {
namespace fwsign {

namespace {

// Embedded so the backend can prove every image carries the verifier (jobs.js SIGN_MARKER).
const char SIGN_MARKER[] = "ATECH-FWSIGN:1";
const char CANONICAL_PREFIX[] = "atech-fw/1\n";
constexpr size_t PUBKEY_HEX_LENGTH = 130;
constexpr size_t PUBKEY_BYTES = 65;
constexpr size_t SIGNATURE_HEX_LENGTH = 128;
constexpr size_t SIGNATURE_BYTES = 64;
constexpr size_t KEY_ID_HEX = 8;
const char HEX_DIGITS[] = "0123456789abcdef";

String compiledKey;
String nvsKey;
String preferencesNamespace = "atech_fw";
bool initialized = false;
bool allowUnsignedFlag = false;
uint32_t maxVer = 0;

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool parseHex(const String &text, uint8_t *out, size_t count) {
  if (text.length() != count * 2) return false;
  for (size_t i = 0; i < count; ++i) {
    const int hi = hexValue(text[2 * i]);
    const int lo = hexValue(text[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>(hi * 16 + lo);
  }
  return true;
}

String hexEncode(const uint8_t *bytes, size_t length) {
  String out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; ++i) { out += HEX_DIGITS[bytes[i] >> 4]; out += HEX_DIGITS[bytes[i] & 0x0f]; }
  return out;
}

String normalizeKey(const String &hex) {
  String key = hex;
  key.trim();
  key.toLowerCase();
  uint8_t scratch[PUBKEY_BYTES];
  if (key.length() != PUBKEY_HEX_LENGTH || !key.startsWith("04") || !parseHex(key, scratch, PUBKEY_BYTES)) return String();
  return key;
}

String effectiveKey() { return nvsKey.isEmpty() ? compiledKey : nvsKey; }

String keyIdOf(const String &hex) {
  uint8_t bytes[PUBKEY_BYTES];
  if (!parseHex(hex, bytes, PUBKEY_BYTES)) return String();
  uint8_t digest[32];
  if (mbedtls_sha256(bytes, PUBKEY_BYTES, digest, 0) != 0) return String();
  return hexEncode(digest, sizeof(digest)).substring(0, KEY_ID_HEX);
}

bool putKey(const String &hex) {
  Preferences preferences;
  if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
  bool ok;
  if (hex.isEmpty()) { preferences.remove("pubkey"); ok = true; }
  else ok = preferences.putString("pubkey", hex) == hex.length();
  preferences.end();
  return ok;
}

bool putVersion(uint32_t version) {
  Preferences preferences;
  if (!preferences.begin(preferencesNamespace.c_str(), false)) return false;
  const bool ok = preferences.putUInt("ver", version) == sizeof(uint32_t);
  preferences.end();
  return ok;
}

bool ecdsaVerify(const uint8_t pub[PUBKEY_BYTES], const uint8_t hash[32], const uint8_t sig[SIGNATURE_BYTES]) {
  mbedtls_ecp_group group;
  mbedtls_ecp_point point;
  mbedtls_mpi r, s;
  mbedtls_ecp_group_init(&group);
  mbedtls_ecp_point_init(&point);
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  bool ok = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1) == 0;
  if (ok) ok = mbedtls_ecp_point_read_binary(&group, &point, pub, PUBKEY_BYTES) == 0;
  if (ok) ok = mbedtls_ecp_check_pubkey(&group, &point) == 0;
  if (ok) ok = mbedtls_mpi_read_binary(&r, sig, 32) == 0 && mbedtls_mpi_read_binary(&s, sig + 32, 32) == 0;
  if (ok) ok = mbedtls_ecdsa_verify(&group, hash, 32, &point, &r, &s) == 0;
  mbedtls_mpi_free(&s);
  mbedtls_mpi_free(&r);
  mbedtls_ecp_point_free(&point);
  mbedtls_ecp_group_free(&group);
  return ok;
}

}  // namespace

bool begin(const char *compiledPubKeyHex, bool allowUnsigned, const char *ns) {
  if (initialized) return true;
  preferencesNamespace = ns && *ns ? ns : "atech_fw";
  allowUnsignedFlag = allowUnsigned;
  compiledKey = normalizeKey(compiledPubKeyHex ? compiledPubKeyHex : "");
  if (compiledPubKeyHex && *compiledPubKeyHex && compiledKey.isEmpty()) Serial.println(F("[fwsign] compiled-in signing key rejected (expected 130 hex of an uncompressed P-256 point)"));
  Preferences preferences;
  if (preferences.begin(preferencesNamespace.c_str(), true) || preferences.begin(preferencesNamespace.c_str(), false)) {
    nvsKey = normalizeKey(preferences.getString("pubkey", ""));
    maxVer = preferences.getUInt("ver", 0);
    preferences.end();
  }
  initialized = true;
  const String key = effectiveKey();
  if (key.isEmpty()) Serial.printf("[fwsign] %s: no signing key yet; it is pinned at the first authenticated contact with the build service\n", SIGN_MARKER);
  else Serial.printf("[fwsign] %s: signing key %s (%s), highest confirmed app version %lu\n", SIGN_MARKER, keyIdOf(key).c_str(), keySource(), static_cast<unsigned long>(maxVer));
  if (allowUnsignedFlag) Serial.println(F("[fwsign] WARNING: ATECH_ALLOW_UNSIGNED is set; unsigned images are accepted (lab builds only)"));
  return true;
}

bool hasKey() { return !effectiveKey().isEmpty(); }
String keyHex() { return effectiveKey(); }
String keyIdHex() { const String key = effectiveKey(); return key.isEmpty() ? String() : keyIdOf(key); }
const char *keySource() { return !nvsKey.isEmpty() ? "nvs" : !compiledKey.isEmpty() ? "compiled" : "none"; }

bool keyMatches(const String &hex) {
  const String key = normalizeKey(hex);
  return !key.isEmpty() && key == effectiveKey();
}

bool pinKey(const String &hex, const char *source) {
  const String key = normalizeKey(hex);
  if (key.isEmpty()) return false;
  const String current = effectiveKey();
  if (!current.isEmpty()) {
    if (current == key) return true;
    Serial.printf("[fwsign] refused a different signing key from %s (have %s, offered %s)\n", source ? source : "?", keyIdOf(current).c_str(), keyIdOf(key).c_str());
    return false;
  }
  if (!putKey(key)) return false;
  nvsKey = key;
  Serial.printf("[fwsign] signing key %s pinned from %s\n", keyIdOf(key).c_str(), source ? source : "?");
  return true;
}

bool replaceKey(const String &hex, const char *source) {
  const String key = normalizeKey(hex);
  if (key.isEmpty()) return false;
  if (key == effectiveKey()) return true;
  if (!putKey(key)) return false;
  nvsKey = key;
  Serial.printf("[fwsign] signing key replaced by %s from %s\n", keyIdOf(key).c_str(), source ? source : "?");
  return true;
}

String canonical(const Manifest &m) {
  String digest = m.sha256;
  digest.toLowerCase();
  String text = CANONICAL_PREFIX;
  text += m.build; text += '\n';
  text += String(m.demo); text += '\n';
  text += String(m.size); text += '\n';
  text += digest; text += '\n';
  text += String(m.version); text += '\n';
  text += m.downgrade ? '1' : '0'; text += '\n';
  text += m.target; text += '\n';
  return text;
}

bool verify(const Manifest &m, String &reason) {
  String key = effectiveKey();
  if (key.isEmpty() && !m.candidateKey.isEmpty()) key = m.candidateKey;   // trust on first authenticated use, pinned by the caller after success
  if (m.signature.isEmpty()) {
    if (allowUnsignedFlag) { Serial.println(F("[fwsign] WARNING: unsigned image accepted (lab build)")); return true; }
    reason = F("This image carries no Atech signature; download the signed update package from the dashboard");
    return false;
  }
  if (key.isEmpty()) {
    if (allowUnsignedFlag) { Serial.println(F("[fwsign] WARNING: signature not checked, no key (lab build)")); return true; }
    reason = F("No firmware signing key is provisioned on this board; connect it to the build service once, or set the key on its hotspot page");
    return false;
  }
  uint8_t pub[PUBKEY_BYTES];
  uint8_t sig[SIGNATURE_BYTES];
  if (m.signature.length() != SIGNATURE_HEX_LENGTH || !parseHex(m.signature, sig, SIGNATURE_BYTES)) { reason = F("Malformed firmware signature"); return false; }
  if (!parseHex(key, pub, PUBKEY_BYTES)) { reason = F("The board's signing key is corrupt"); return false; }
  const String text = canonical(m);
  uint8_t hash[32];
  if (mbedtls_sha256(reinterpret_cast<const uint8_t *>(text.c_str()), text.length(), hash, 0) != 0) { reason = F("SHA-256 of the manifest failed"); return false; }
  if (!ecdsaVerify(pub, hash, sig)) {
    reason = String(F("Firmware signature does not verify with this board's signing key ")) + keyIdOf(key);
    return false;
  }
  if (m.version < maxVer && !m.downgrade) {
    reason = String(F("Downgrade refused: this board has run app version ")) + String(maxVer) + F(" and this build is version ") + String(m.version) +
             F("; allow the downgrade in the dashboard to install it");
    return false;
  }
  return true;
}

uint32_t maxVersion() { return maxVer; }

void recordRunningVersion(uint32_t version) {
  if (version <= maxVer) return;
  if (putVersion(version)) maxVer = version;
}

bool allowUnsigned() { return allowUnsignedFlag; }

String statusJson() {
  String json;
  json.reserve(120);
  json += F("{\"key\":"); json += hasKey() ? F("true") : F("false");
  json += F(",\"kid\":\""); json += keyIdHex();
  json += F("\",\"source\":\""); json += keySource();
  json += F("\",\"max_ver\":"); json += String(maxVer);
  json += F(",\"unsigned_ok\":"); json += allowUnsignedFlag ? F("true") : F("false");
  json += '}';
  return json;
}

}  // namespace fwsign
}  // namespace atech
