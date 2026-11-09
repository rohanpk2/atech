'use strict';

// Structure test for the ESP32 side of AtechSync and its wiring into the core, the Wi-Fi module
// and both demos. The protocol itself is proven by sync.test.js (host-compiled C++); this file
// pins what cannot run on the host: ESP-NOW and GCM calls, queue discipline, NVS keys, UUIDs, the
// application API reaching generated code, and the hooks the demos must connect.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const root = path.join(__dirname, '..', '..');
const readRoot = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const wrapper = read('src/AtechSync.cpp');
const header = read('src/AtechSync.h');
const appApi = read('src/AtechSyncApp.h');
const library = JSON.parse(read('library.json'));
const coreHeader = readRoot('shared', 'AtechCore', 'src', 'AtechCore.h');
const core = readRoot('shared', 'AtechCore', 'src', 'AtechCore.cpp');
const appHeader = readRoot('shared', 'AtechCore', 'src', 'AtechApp.h');
const lanHeader = readRoot('shared', 'AtechWifiLan', 'src', 'AtechWifiLan.h');
const lan = readRoot('shared', 'AtechWifiLan', 'src', 'AtechWifiLan.cpp');

assert.equal(library.name, 'AtechSync');
assert.equal(library.version, '1.0.0');

// GATT status service shared with web-shared/atech-sync.js.
for (const suffix of ['0300', '0301', '0302']) {
  assert.ok(wrapper.includes(`a7ec${suffix}-2e47-4dd2-82a4-9c2cf6eaa001`), `sync service UUID a7ec${suffix} missing`);
}

// ESP-NOW, channel control, GCM sealing, hardware randomness, NVS.
for (const needle of ['esp_now_init', 'esp_now_register_recv_cb', 'esp_now_register_send_cb', 'esp_now_add_peer', 'esp_now_send',
                      'esp_now_is_peer_exist', 'esp_wifi_set_channel', 'esp_wifi_get_channel', 'mbedtls_gcm_setkey',
                      'mbedtls_gcm_auth_decrypt', 'mbedtls_gcm_crypt_and_tag', 'esp_fill_random', 'xSemaphoreCreateRecursiveMutex',
                      '"atech_sync"', '"peers"', '"state"', 'setRadioHold(true)', 'coreSetAppIdleHook(']) {
  assert.ok(wrapper.includes(needle), `AtechSync.cpp must use ${needle}`);
}
assert.doesNotMatch(wrapper, /esp_now_set_pmk|encrypt = true/, 'link-layer LMK encryption is not used; frames are sealed with AES-GCM');

// Callback discipline: the ESP-NOW callbacks only enqueue; the main loop does the crypto.
const recvCb = wrapper.match(/void AtechSync::Impl::onEspNowReceive\([\s\S]*?\n\}/);
assert.ok(recvCb, 'the receive callback must be named onEspNowReceive');
assert.match(recvCb[0], /xQueueSend\(/, 'the receive callback enqueues');
assert.doesNotMatch(recvCb[0], /mbedtls|engine\.|Serial\./, 'the receive callback does no crypto, engine work or printing');
assert.doesNotMatch(wrapper, /xQueueSendFromISR/, 'ESP-NOW callbacks run on a task, not an ISR');

// Unknown senders are dropped before decoding: the key lookup gates the unseal.
const receivePath = wrapper.match(/void handleFrame\([\s\S]*?\n  \}/);
assert.ok(receivePath, 'handleFrame must exist');
assert.ok(receivePath[0].indexOf('peerFor(') < receivePath[0].indexOf('unseal('), 'the peer (or pairing) key is chosen before unseal');
assert.ok(receivePath[0].includes('pairingOpen('), 'an unknown sender is only tried against the open pairing key');

// Timing and limits mirrored by builder/lib/fake-sync.js.
const types = read('src/SyncTypes.h');
for (const [name, value] of [['HELLO_INTERVAL_MS', 3000], ['CONNECT_TIMEOUT_MS', 8000], ['PAIR_WINDOW_MS', 600000], ['RETRY_BASE_MS', 150],
                             ['MAX_ATTEMPTS', 5], ['MAX_KEYS', 16], ['MAX_PEERS', 4], ['HOP_AFTER_MS', 15000], ['HOP_DWELL_MS', 2000],
                             ['PERSIST_DEBOUNCE_MS', 2000], ['MAX_BODY', 'MAX_FRAME - HEADER - TAG']]) {
  assert.match(types, new RegExp(`${name}\\s*=\\s*${value}\\b`), `SyncTypes.h must define ${name} = ${value}`);
}

// The pairing key is a secret: it is printed only inside the pairing code the user asked for.
for (const line of wrapper.split('\n').filter(l => /Serial\.print/.test(l))) {
  assert.doesNotMatch(line, /hexEncode\(\w*[kK]ey/, `a Serial line must not print a key: ${line.trim()}`);
}

// Public API (header) and the application API.
for (const method of ['bool begin(const AtechSyncConfig &', 'void loop()', 'AtechSyncResult command(const String &form, bool privileged)',
                      'String statusJson()', 'String compactStatusJson()', 'bool handleSerialLine(const String &line)',
                      'bool isPaired() const', 'bool isConnected() const', 'bool emitEvent(const char *name, const char *payload']) {
  assert.ok(header.includes(method), `AtechSync.h must declare ${method}`);
}
assert.ok(header.includes('bool (*otaBusy)();') && header.includes('AtechWifiLan *lan;') && header.includes('BLEServer *server;'));
for (const fn of ['setBool', 'getBool', 'setInt', 'getInt', 'setFloat', 'getFloat', 'setString', 'getString', 'setJson', 'getJson',
                  'has', 'emit', 'onChange', 'onEvent', 'wait', 'peerConnected', 'paired', 'peerId']) {
  assert.match(appApi, new RegExp(`\\b${fn}\\(`), `AtechSyncApp.h must declare atech::sync::${fn}`);
}
assert.match(appApi, /namespace sync/);
assert.doesNotMatch(appApi, /#include\s+["<](SyncEngine|AtechSync|AtechCore|WiFi|BLE)/, 'the app header exposes no core internals');
assert.match(appHeader, /#include "AtechSyncApp\.h"/, 'AtechApp.h must include the sync application API');

// Core hook: notifications reach the app task between appLoop() calls.
assert.match(coreHeader, /void coreSetAppIdleHook\(void \(\*hook\)\(\)\);/);
assert.match(core, /appLoop\(\);\s*\n\s*if \(appIdleHook\) appIdleHook\(\);/, 'the idle hook runs right after appLoop()');
assert.match(core, /ATECH_CORE_VERSION\[\]\s*=\s*"1\.3\.0"/);

// Wi-Fi: the driver stays started for ESP-NOW even without credentials.
assert.match(lanHeader, /void setRadioHold\(bool hold\);/);
assert.match(lanHeader, /bool radioHeld\(\) const;/);
assert.match(lan, /else if \(stationWanted \|\| radioHold\) mode = WIFI_STA;/, 'applyMode must keep STA while the radio is held');
assert.match(lan, /AtechWifiLan::setRadioHold/);

// Hooks in the neighbouring libraries.
const prov = readRoot('shared', 'AtechBleProv', 'src', 'AtechBleProv.cpp');
const cloudHeader = readRoot('shared', 'AtechCloudOta', 'src', 'AtechCloudOta.h');
const cloud = readRoot('shared', 'AtechCloudOta', 'src', 'AtechCloudOta.cpp');
assert.match(prov, /OP_SYNC\s*=\s*0x05\b/);
assert.ok(lanHeader.includes('String (*syncCommand)(const String &form);') && lanHeader.includes('String (*syncIdentity)();'),
          'the LAN config carries the sync hooks');
assert.ok(lan.includes('"/api/sync"') && lan.includes('atech-sync/1\\n'), 'the LAN service exposes the HMAC-authenticated sync route');
assert.ok(lan.includes('\\"sync\\":'), 'the LAN identity carries the sync status');
assert.match(lan, /max_uri_handlers = 12/);
assert.ok(cloudHeader.includes('String (*extraReport)();') && cloudHeader.includes('void (*command)(const String &form);'),
          'the cloud config carries the report and command hooks');
assert.ok(cloud.includes('&sync=') && cloud.includes('kvGet(response, "sync")'), 'the poll carries the sync status out and a command in');

// Both demos wire the module identically, and the demo app only lives in user_app.cpp.
const mains = {
  demo1: readRoot('demo1-custom-gatt', 'src', 'main.cpp'),
  demo2: readRoot('demo2-bleota-library', 'src', 'main.cpp'),
};
for (const [name, main] of Object.entries(mains)) {
  for (const needle of ['#include <AtechSync.h>', 'AtechSync boardSync;', 'boardSync.begin(', 'boardSync.loop()', 'boardSync.emitEvent("button.pressed")',
                        'lanConfig.syncCommand', 'lanConfig.syncIdentity', 'cloudConfig.extraReport', 'cloudConfig.command', 'provConfig.sync = &boardSync',
                        'syncConfig.otaBusy', 'syncConfig.serialConsole = true']) {
    assert.ok(main.includes(needle), `${name} main.cpp must contain ${needle}`);
  }
  assert.ok(main.indexOf('wifiLan.begin(') < main.indexOf('boardSync.begin('), `${name}: the Wi-Fi module starts before sync (radio hold)`);
  assert.ok(main.indexOf('boardSync.begin(') < main.indexOf('cloudOta.begin('), `${name}: sync starts before the cloud agent that reports it`);
}
for (const demo of ['demo1-custom-gatt', 'demo2-bleota-library']) {
  const app = readRoot(demo, 'src', 'app', 'user_app.cpp');
  for (const needle of ['atech::sync::onChange(', 'atech::sync::onEvent(', 'atech::sync::wait(', '"demo.power"', '"button.pressed"']) {
    assert.ok(app.includes(needle), `${demo} user_app.cpp must contain ${needle}`);
  }
  assert.doesNotMatch(app, /#include\s+["<](?!AtechApp\.h)/, `${demo} user_app.cpp includes only AtechApp.h`);
}
assert.doesNotMatch(wrapper, /demo\.power|led\./, 'the communication layer knows nothing about the demo application');
assert.doesNotMatch(read('src/SyncEngine.cpp'), /demo\.power|button/, 'the engine knows nothing about the demo application');

// The model learns the application API.
const prompt = readRoot('builder', 'prompts', 'system.md');
assert.match(prompt, /atech::sync::/, 'the system prompt describes the shared state API');

// Review fixes (2026-11-09).
// The stock app keeps the v1/v2 LED difference every OTA path uses as its visible proof.
for (const demo of ['demo1-custom-gatt', 'demo2-bleota-library']) {
  const app = readRoot(demo, 'src', 'app', 'user_app.cpp');
  assert.match(app, /#if DEMO_VERSION == 1/, `${demo} user_app.cpp must select the off pattern by DEMO_VERSION`);
  assert.ok(app.includes('led.set(0, 0, 40)') && app.includes('led.set(0, 40, 0)'), `${demo}: slow blue on v1, quick green on v2`);
}
// The Bluetooth status read stays under the GATT attribute cap (512 bytes under NimBLE).
assert.match(wrapper, /BLE_STATUS_BUDGET\s*=\s*(\d+)/, 'a byte budget for the BLE status payload');
assert.ok(Number(wrapper.match(/BLE_STATUS_BUDGET\s*=\s*(\d+)/)[1]) <= 480, 'the BLE status budget leaves headroom under 512 bytes');
assert.match(wrapper, /String bleStatusJson\(/, 'a compact status for the BLE read');
assert.match(wrapper, /characteristic->setValue\(impl->bleStatusJson\(\)\)/, 'the status characteristic serves the compact payload');
assert.match(wrapper.match(/String bleStatusJson\([\s\S]*?\n  \}/)[0], /BLE_STATUS_BUDGET/, 'the compact payload enforces the budget while adding state entries');
// Re-pairing while paired: a PAIR_REQ from a known peer is retried against the open pairing key.
const frameHandler = wrapper.match(/void handleFrame\([\s\S]*?\n  \}/)[0];
assert.ok((frameHandler.match(/engine\.pairingKey\(\)/g) || []).length >= 2, 'handleFrame tries the pairing key for a PAIR_REQ from a known peer too');
// A channel hop forces a HELLO on the new channel.
assert.match(wrapper.match(/void setChannel\([\s\S]*?\n  \}/)[0], /engine\.forceHello\(\)/, 'setChannel forces a heartbeat');
assert.match(read('src/SyncEngine.h'), /void forceHello\(\);/);
// NVS writes happen outside the engine mutex; lock-timeout fallbacks never read engine state.
assert.match(wrapper, /void flushPersistence\(/, 'persistence runs in its own step');
const servicePath = wrapper.match(/void service\(\) \{[\s\S]*?\n  \}/)[0];
assert.ok(servicePath.indexOf('flushPersistence();') > servicePath.lastIndexOf('Guard guard(*this);'), 'flushPersistence runs after the guarded section');
assert.doesNotMatch(servicePath, /savePeers\(\)|saveState\(\)/, 'service() never writes NVS under the lock');
for (const fn of ['String statusJson()', 'String compactStatusJson()', 'String bleStatusJson()']) {
  const body = wrapper.slice(wrapper.indexOf(fn));
  assert.match(body.slice(0, 400), /if \(!guard\.held\) return/, `${fn} honours a lock timeout`);
}
assert.match(wrapper, /volatile bool cachedPaired/, 'isPaired/isConnected read cached flags, never the engine without the lock');

console.log('AtechSync wiring structure tests passed');
