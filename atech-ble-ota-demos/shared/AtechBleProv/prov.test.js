'use strict';

// Structure test for the Bluetooth provisioning service. C++ cannot run here, so this pins the
// contract the dashboard (web-shared/atech-provision.js), the backend (builder/lib/cloud-auth.js,
// builder/lib/fake-prov-board.js) and both demos rely on: UUIDs, canonical strings, the crypto
// primitives, the frame limits, the lock, and that the password is never printed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const root = path.join(__dirname, '..', '..');
const header = read('src/AtechBleProv.h');
const impl = read('src/AtechBleProv.cpp');
const library = JSON.parse(read('library.json'));
const cloudHeader = fs.readFileSync(path.join(root, 'shared', 'AtechCloudOta', 'src', 'AtechCloudOta.h'), 'utf8');
const portalHeader = fs.readFileSync(path.join(root, 'shared', 'AtechWifiOta', 'src', 'AtechWifiOta.h'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'shared', 'AtechWifiOta', 'src', 'AtechWifiOta.cpp'), 'utf8');
const mains = {
  demo1: fs.readFileSync(path.join(root, 'demo1-custom-gatt', 'src', 'main.cpp'), 'utf8'),
  demo2: fs.readFileSync(path.join(root, 'demo2-bleota-library', 'src', 'main.cpp'), 'utf8'),
};

assert.equal(library.name, 'AtechBleProv');

// UUIDs shared with web-shared/atech-provision.js.
for (const suffix of ['0200', '0201', '0202', '0203']) {
  assert.ok(impl.includes(`a7ec${suffix}-2e47-4dd2-82a4-9c2cf6eaa001`), `provisioning UUID a7ec${suffix} missing`);
}

// Canonical strings shared with the backend and the browser.
assert.ok(impl.includes('"atech-prov/1"'), 'HKDF info must match the browser module');
assert.ok(impl.includes('"atech-prov-grant/1\\n"'), 'grant prefix must match builder/lib/cloud-auth.js');
assert.ok(impl.includes('ATECH-PROV:1'), 'the provisioning marker must be embedded so the backend can prove the service is linked in');

// Crypto: ephemeral ECDH P-256, HKDF-SHA256, AES-256-GCM, hardware randomness.
for (const needle of ['mbedtls_ecdh_setup', 'MBEDTLS_ECP_DP_SECP256R1', 'mbedtls_ecdh_make_public', 'mbedtls_ecdh_read_public',
                       'mbedtls_ecdh_calc_secret', 'mbedtls_hkdf', 'mbedtls_gcm_setkey', 'mbedtls_gcm_auth_decrypt',
                       'mbedtls_gcm_crypt_and_tag', 'esp_fill_random', 'mbedtls_md_hmac', 'mbedtls_sha256']) {
  assert.ok(impl.includes(needle), `AtechBleProv.cpp must use ${needle}`);
}

// Frame limits and the fragment timeout.
assert.match(impl, /MAX_FRAGMENT\s*=\s*240\b/, 'fragments carry at most 240 bytes');
assert.match(impl, /MAX_MESSAGE\s*=\s*1024\b/, 'messages are at most 1024 bytes');
assert.match(impl, /FRAGMENT_TIMEOUT_MS\s*=\s*5000\b/, 'an unfinished request is dropped after 5 s');
assert.match(impl, /PROV_NONCE_BYTES\s*=\s*16\b/);
assert.match(impl, /PROV_IV_BYTES\s*=\s*12\b/);
assert.match(impl, /PROV_TAG_BYTES\s*=\s*16\b/);

// Behaviour: credentials and URL go through the existing libraries; the lock persists; the
// BOOT press opens the physical-presence window; busy transports refuse changes.
assert.ok(impl.includes('saveCredentials(') && impl.includes('forgetCredentials('), 'Wi-Fi credentials go through AtechWifiLan');
assert.ok(impl.includes('setServerUrl(') && impl.includes('clearServerUrl('), 'the server URL goes through AtechCloudOta');
assert.ok(impl.includes('"locked"') && impl.includes('"atech_prov"'), 'the lock is persisted in NVS namespace atech_prov');
assert.ok(impl.includes('hasSession()'), 'the first cloud login locks the board');
assert.ok(impl.includes('noteButtonPress'), 'a BOOT press opens the unlock window');
assert.ok(impl.includes('xQueueSend') && impl.includes('xQueueReceive'), 'writes are queued from the BLE host task to the main loop');
assert.ok(impl.includes('config.busy') , 'provisioning is refused while a transport owns flash');

// The password never reaches the serial console. Every Serial line is checked for the words that
// would carry it.
for (const line of impl.split('\n').filter(l => /Serial\.print/.test(l))) {
  assert.doesNotMatch(line, /\bpass(word)?\b|\.pass\b|"pass"/i, `a Serial line must not print the password: ${line.trim()}`);
  assert.doesNotMatch(line, /token\.c_str|authToken\(\)/, `a Serial line must not print the token: ${line.trim()}`);
}

// Board-to-board sync commands ride the same sealed session: pairing ops are grant-gated.
assert.match(impl, /OP_SYNC\s*=\s*0x05\b/, 'the sync opcode is 0x05');
assert.ok(impl.includes('config.sync->command('), 'sync commands are delegated to AtechSync');
assert.ok(header.includes('AtechSync *sync;'), 'the provisioning config carries the sync module');
const syncHandler = impl.match(/void sync\(const uint8_t \*body, size_t length\) \{[\s\S]*?\n  \}/);
assert.ok(syncHandler, 'a sync() request handler exists');
assert.match(syncHandler[0], /authorized\(grant\)/, 'pairing ops need the owner grant or a BOOT press');
assert.match(syncHandler[0], /"code"[\s\S]*"pair"[\s\S]*"unpair"/, 'code, pair and unpair are the privileged ops');

// Public API and the two small additions in neighbouring libraries.
for (const method of ['bool begin(const AtechBleProvConfig &', 'void loop()', 'void noteButtonPress()', 'bool isLocked() const', 'String statusJson()']) {
  assert.ok(header.includes(method), `AtechBleProv.h must declare ${method}`);
}
assert.ok(cloudHeader.includes('bool hasSession() const'), 'AtechCloudOta must expose hasSession()');
assert.ok(portalHeader.includes('void (*shortPress)()'), 'the hotspot portal must report a short BOOT press');
assert.ok(portal.includes('config.shortPress'), 'the portal must call the short press callback');

// Wiring in both demos.
for (const [name, main] of Object.entries(mains)) {
  assert.ok(main.includes('#include <AtechBleProv.h>'), `${name} must include AtechBleProv.h`);
  assert.ok(main.includes('AtechBleProv bleProv;'), `${name} must own a provisioning service`);
  assert.ok(main.includes('bleProv.begin('), `${name} must start the provisioning service`);
  assert.ok(main.includes('bleProv.loop()'), `${name} must service the provisioning queue`);
  assert.ok(main.includes('bleProv.noteButtonPress'), `${name} must route the BOOT short press to the service`);
  assert.ok(main.indexOf('coreAttachBle(') < main.indexOf('bleProv.begin('), `${name} must attach the identity service before provisioning`);
  assert.ok(main.indexOf('bleProv.begin(') < main.indexOf('BLEDevice::getAdvertising()'), `${name} must create the service before advertising`);
}

console.log('Atech Bluetooth provisioning structure tests passed');
