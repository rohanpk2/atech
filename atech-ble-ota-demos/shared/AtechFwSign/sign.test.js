'use strict';

// Structure test for the firmware signature verifier. C++ cannot run here, so this pins the
// contract the backend (builder/lib/signing.js) relies on: the canonical string, ECDSA P-256 with
// mbedtls, the NVS keys, the downgrade rule, the unsigned-image policy, and that every install
// path verifies through atech::ImageSink before a slot is selected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const root = path.join(__dirname, '..', '..');
const header = read('src/AtechFwSign.h');
const impl = read('src/AtechFwSign.cpp');
const library = JSON.parse(read('library.json'));
const sink = fs.readFileSync(path.join(root, 'shared', 'AtechCloudOta', 'src', 'AtechImageSink.cpp'), 'utf8');
const sinkHeader = fs.readFileSync(path.join(root, 'shared', 'AtechCloudOta', 'src', 'AtechImageSink.h'), 'utf8');
const cloudLibrary = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'AtechCloudOta', 'library.json'), 'utf8'));
const jobs = fs.readFileSync(path.join(root, 'builder', 'lib', 'jobs.js'), 'utf8');
const lan = fs.readFileSync(path.join(root, 'shared', 'AtechWifiLan', 'src', 'AtechWifiLan.cpp'), 'utf8');
const lanLibrary = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'AtechWifiLan', 'library.json'), 'utf8'));

assert.equal(library.name, 'AtechFwSign');
assert.equal(library.version, '1.0.0');
assert.equal(cloudLibrary.version, '1.2.0', 'AtechCloudOta carries the manifest-aware sink');

// Canonical string and marker shared with builder/lib/signing.js and jobs.js.
assert.ok(impl.includes('"atech-fw/1\\n"'), 'canonical prefix must match builder/lib/signing.js');
assert.ok(impl.includes('ATECH-FWSIGN:1'), 'the verifier marker must be embedded so the backend can prove it is linked in');
assert.ok(jobs.includes("SIGN_MARKER = 'ATECH-FWSIGN:'"), 'the backend requires the verifier marker in every image');

// Crypto: ECDSA P-256 over SHA-256 of the canonical string, raw r||s, public key as an uncompressed point.
for (const needle of ['mbedtls_ecdsa_verify', 'MBEDTLS_ECP_DP_SECP256R1', 'mbedtls_ecp_point_read_binary', 'mbedtls_ecp_check_pubkey',
                       'mbedtls_mpi_read_binary', 'mbedtls_sha256']) {
  assert.ok(impl.includes(needle), `AtechFwSign.cpp must use ${needle}`);
}
assert.match(impl, /PUBKEY_HEX_LENGTH\s*=\s*130\b/, 'public key is 65 bytes, 130 hex');
assert.match(impl, /SIGNATURE_HEX_LENGTH\s*=\s*128\b/, 'signature is r||s, 128 hex');

// Persistence and policy.
for (const key of ['"atech_fw"', '"pubkey"', '"ver"']) assert.ok(impl.includes(key), `NVS key ${key}`);
assert.ok(impl.includes('Downgrade refused'), 'a lower version without the downgrade flag is refused with a clear reason');
assert.ok(impl.includes('carries no Atech signature'), 'unsigned images are refused by default');
assert.ok(impl.includes('unsigned images are accepted'), 'the lab opt-in prints a warning');
assert.ok(impl.includes('firmware signing key is provisioned'), 'a board without a key says so');

// Public API.
for (const method of ['bool begin(const char *compiledPubKeyHex, bool allowUnsigned', 'bool hasKey()', 'String keyIdHex()', 'const char *keySource()',
                       'bool pinKey(const String &hex, const char *source)', 'bool replaceKey(const String &hex, const char *source)', 'bool keyMatches(const String &hex)',
                       'String canonical(const Manifest &', 'bool verify(const Manifest &', 'uint32_t maxVersion()', 'void recordRunningVersion(uint32_t',
                       'bool allowUnsigned()', 'String statusJson()']) {
  assert.ok(header.includes(method), `AtechFwSign.h must declare ${method}`);
}
assert.match(header, /struct Manifest \{[\s\S]*String build;[\s\S]*uint8_t demo[\s\S]*uint32_t size[\s\S]*String sha256;[\s\S]*uint32_t version[\s\S]*bool downgrade[\s\S]*String target;[\s\S]*String signature;[\s\S]*\}/);

// The sink is the one place that verifies, after the digest and before the slot is selected.
assert.ok(sinkHeader.includes('void setManifest(const atech::fwsign::Manifest &') || sinkHeader.includes('void setManifest(const fwsign::Manifest &'), 'ImageSink::setManifest');
assert.ok(sinkHeader.includes('bool hasManifest() const'), 'ImageSink::hasManifest');
const digestAt = sink.indexOf('constantTimeEquals(_digest');
const verifyAt = sink.indexOf('fwsign::verify(');
const activateAt = sink.indexOf('esp_ota_set_boot_partition(_partition)');
assert.ok(digestAt > 0 && verifyAt > digestAt && activateAt > verifyAt, 'digest check, then signature verification, then slot selection');
assert.ok(sink.includes('does not match the signed manifest'), 'the manifest digest must equal the streamed digest');

// The LAN service installs through the same sink: one flash writer for cloud, LAN and hotspot.
assert.equal(lanLibrary.version, '1.3.0');
assert.ok(lan.includes('#include <AtechImageSink.h>') && lan.includes('atech::ImageSink sink'), 'AtechWifiLan installs through atech::ImageSink');
assert.doesNotMatch(lan, /esp_ota_set_boot_partition|esp_ota_begin\(|esp_ota_write\(|esp_ota_end\(|mbedtls_sha256_update/, 'no second flash writer in the LAN service');
for (const name of ['X-Atech-Sig', 'X-Atech-Version', 'X-Atech-Downgrade', 'X-Atech-Target', 'X-Atech-Key']) {
  assert.ok(lan.includes(`"${name}"`), `the LAN begin reads ${name}`);
}
assert.ok(lan.includes('sink.setManifest(') && lan.includes('fwsign::pinKey(') && lan.includes('"lan"'), 'an HMAC-authenticated begin carries the manifest and may pin the first key');


// Firmware never arrives over Bluetooth: the demos' original BLE OTA writers compile only when a lab
// build asks for them (-DATECH_BLE_OTA_DEMO=1). The default image has no Bluetooth firmware path, so
// the signed sink is the only way an image reaches flash.
const mains = {
  demo1: fs.readFileSync(path.join(root, 'demo1-custom-gatt', 'src', 'main.cpp'), 'utf8'),
  demo2: fs.readFileSync(path.join(root, 'demo2-bleota-library', 'src', 'main.cpp'), 'utf8'),
};
function outsideBleOtaDemo(source) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = source.indexOf('#if ATECH_BLE_OTA_DEMO', i);
    if (start < 0) return out + source.slice(i);
    out += source.slice(i, start);
    const end = source.indexOf('#endif', start);
    assert.ok(end > start, 'every ATECH_BLE_OTA_DEMO block is closed');
    const block = source.slice(start + '#if ATECH_BLE_OTA_DEMO'.length, end);
    assert.ok(!block.includes('#if'), 'ATECH_BLE_OTA_DEMO blocks do not nest');
    const elseAt = block.indexOf('#else');
    if (elseAt >= 0) out += block.slice(elseAt + '#else'.length);
    i = end + '#endif'.length;
  }
}
for (const [name, main] of Object.entries(mains)) {
  assert.ok(main.includes('#ifndef ATECH_BLE_OTA_DEMO') && main.includes('#define ATECH_BLE_OTA_DEMO 0'),
            `${name}: the Bluetooth OTA demo is compiled out unless the build asks for it`);
  const rest = outsideBleOtaDemo(main);
  const writers = name === 'demo1' ? ['Update.begin(', 'Update.write(', 'Update.end(', 'Update.abort('] : ['BLEOTA.begin(', 'BLEOTA.init(', 'BLEOTA.process(', 'getBLEOTAuuid'];
  for (const writer of writers) assert.ok(!rest.includes(writer), `${name}: ${writer} must only exist inside an ATECH_BLE_OTA_DEMO block`);
}

console.log('Atech firmware signing structure tests passed');
