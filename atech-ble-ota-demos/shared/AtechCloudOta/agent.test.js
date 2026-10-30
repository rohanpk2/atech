'use strict';

// Structure test for the shared cloud OTA agent. C++ cannot run here, so this
// pins the contract the backend (builder/lib/cloud-auth.js, cloud-ota.js) and
// the demos rely on: canonical strings, certificate validation, one TLS
// connection, ranged downloads, rollback, and the wiring in both main.cpp files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const root = path.join(__dirname, '..', '..');
const agent = read('src/AtechCloudOta.cpp');
const header = read('src/AtechCloudOta.h');
const sink = read('src/AtechImageSink.cpp');
const sinkHeader = read('src/AtechImageSink.h');
const library = JSON.parse(read('library.json'));
const core = fs.readFileSync(path.join(root, 'shared', 'AtechCore', 'src', 'AtechCore.cpp'), 'utf8');
const coreHeader = fs.readFileSync(path.join(root, 'shared', 'AtechCore', 'src', 'AtechCore.h'), 'utf8');
const lanHeader = fs.readFileSync(path.join(root, 'shared', 'AtechWifiLan', 'src', 'AtechWifiLan.h'), 'utf8');
const lan = fs.readFileSync(path.join(root, 'shared', 'AtechWifiLan', 'src', 'AtechWifiLan.cpp'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'shared', 'AtechWifiOta', 'src', 'AtechWifiOta.cpp'), 'utf8');
const portalHeader = fs.readFileSync(path.join(root, 'shared', 'AtechWifiOta', 'src', 'AtechWifiOta.h'), 'utf8');
const mains = {
  demo1: fs.readFileSync(path.join(root, 'demo1-custom-gatt', 'src', 'main.cpp'), 'utf8'),
  demo2: fs.readFileSync(path.join(root, 'demo2-bleota-library', 'src', 'main.cpp'), 'utf8'),
};

assert.equal(library.name, 'AtechCloudOta');

// Canonical strings shared with the backend.
assert.ok(agent.includes('"atech-cloud-login/1\\n"'), 'login message prefix must match builder/lib/cloud-auth.js');
assert.ok(agent.includes('ATECH-CLOUD-AGENT:1'), 'the agent marker must be embedded so the backend can prove the agent is linked in');
for (const route of ['/api/device/challenge', '/api/device/login', '/api/device/poll', '/status']) {
  assert.ok(agent.includes(route), `agent must use ${route}`);
}
for (const field of ['boot_job', 'boot_build', 'ready=', 'transferring=', 'heap=', 'heap_min=', 'phase=', 'received=', 'total=', 'error=']) {
  assert.ok(agent.includes(field), `agent must send ${field}`);
}

// Transport security and memory discipline.
assert.ok(agent.includes('useBuiltinCACertBundle'), 'the built-in root bundle validates the server certificate');
assert.doesNotMatch(agent, /setInsecure/, 'the agent never disables certificate validation');
assert.ok(agent.includes('ATECH_CLOUD_ALLOW_HTTP'), 'plain http needs the compile-time opt-in');
assert.ok(agent.includes('"https://"'), 'https is the only scheme accepted by default');
assert.ok(agent.includes('Authorization') && agent.includes('Bearer '), 'bearer session on every authenticated request');
assert.ok(agent.includes('"Range"') && agent.includes('bytes='), 'the image is fetched in ranged chunks');
assert.ok(agent.includes('setReuse(true)'), 'one kept-alive connection is reused for every request');
assert.equal((agent.match(/NetworkClientSecure\s+\w+;/g) || []).length, 1, 'exactly one TLS client object: never two sessions at once');
assert.ok(agent.includes('xTaskCreatePinnedToCore'), 'the agent runs on its own task');
assert.ok(agent.includes('coreTryAcquireOta("cloud")') && agent.includes('coreReleaseOta("cloud")'), 'flash ownership through the core lock');
assert.ok(agent.includes('coreSuspendApp()') && agent.includes('coreResumeApp()'), 'the generated app pauses during a transfer');
assert.ok(agent.includes('esp_ota_mark_app_invalid_rollback_and_reboot'), 'a cloud image that cannot report rolls back');
assert.ok(agent.includes('confirmBoot()'), 'the boot is confirmed only after the backend acknowledges the new build');
assert.ok(agent.includes('appLoops()') && agent.includes('safeMode()'), 'confirmation waits for the app loop and refuses safe mode');
for (const key of ['"url"', '"job"', '"expect"', '"done"']) assert.ok(agent.includes(key), `NVS key ${key}`);
assert.ok(agent.includes('"atech_cloud"') || mains.demo1.includes('"atech_cloud"'), 'NVS namespace atech_cloud');

// Cross-task discipline: the portal only posts a new URL; the agent task applies it, drops the
// connection and the session; every field statusJson reads is written under the lock; and the
// confirm-timeout rollback runs even when Wi-Fi is down (that is exactly when it matters).
assert.ok(agent.includes('pendingUrl'), 'a URL change is handed to the agent task instead of mutating its state');
assert.ok(agent.includes('applyPendingConfig()'), 'the agent task applies configuration changes');
assert.ok(/void run\(\)\s*\{\s*for \(;;\)\s*\{\s*checkConfirmTimeout\(\);/.test(agent), 'the confirm timeout is checked before the enabled and Wi-Fi gates');
assert.doesNotMatch(agent.replace(/applyPendingConfig\(\)[\s\S]*?\n  \}/, ''), /\n  [^\n]*String AtechCloudOta::serverUrl[\s\S]*session = "";/, 'the loop task never clears the session itself');
assert.ok(portal.includes('cloud->isTransferring()'), 'the portal refuses a URL change during a transfer');
assert.ok(agent.includes('"nonce"'), 'a nonce rejection is reported as such, not as a bad token');
assert.ok(agent.includes('heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)'), 'heap_min is the internal heap minimum');

// Image sink: the same checks as the LAN service.
for (const needle of ['esp_ota_begin', 'esp_ota_write', 'esp_ota_end', 'esp_ota_set_boot_partition', 'esp_ota_abort', 'ESP_CHIP_ID_ESP32S3',
                       'ESP_IMAGE_FLASH_SIZE_16MB', 'ESP_APP_DESC_MAGIC_WORD', 'ATECH-TARGET:', 'ATECH-BUILD:', 'mbedtls_sha256']) {
  assert.ok(sink.includes(needle), `AtechImageSink.cpp must use ${needle}`);
}
for (const method of ['bool begin(', 'bool write(', 'bool finish(', 'void abort(', 'uint32_t received(']) {
  assert.ok(sinkHeader.includes(method), `ImageSink must declare ${method}`);
}

// Public API the demos use.
for (const method of ['begin(const AtechCloudOtaConfig &', 'void loop()', 'bool isTransferring()', 'bool holdsConfirm()', 'String serverUrl()',
                       'bool setServerUrl(', 'bool clearServerUrl()', 'String statusJson()', 'const char *stateName()']) {
  assert.ok(header.includes(method), `AtechCloudOta.h must declare ${method}`);
}
assert.ok(header.includes('String (*authToken)()') && header.includes('bool (*otherOtaBusy)()') && header.includes('bool (*wifiConnected)()'));

// Core, LAN identity and portal hooks.
assert.ok(coreHeader.includes('bool (*holdAutoConfirm)();'), 'the core must let the cloud agent hold automatic confirmation');
assert.match(core, /ATECH_CORE_VERSION\[\]\s*=\s*"1\.2\.0"/);
assert.ok(core.includes('holdAutoConfirm'), 'coreLoop must consult the hold before auto-confirming');
assert.ok(lanHeader.includes('String (*extraIdentity)();'), 'the LAN identity must be able to carry the cloud status');
assert.ok(lan.includes('extraIdentity') && lan.includes('\\"cloud\\":'), 'LAN identity appends the cloud object');
assert.ok(portalHeader.includes('AtechCloudOta *cloud;'));
for (const id of ['cloudCard', 'cloudStatus', 'cloudUrl', 'cloudSave', 'cloudClear']) assert.ok(portal.includes(`id="${id}"`), `portal must have #${id}`);
for (const route of ['/api/cloud/status', '/api/cloud/save', '/api/cloud/clear']) assert.ok(portal.includes(`"${route}"`), `portal route ${route}`);
assert.doesNotMatch(portal, /otaToken\.c_str\(\)\s*\)\s*;[^\n]*sendJson/, 'the portal never sends the pairing token to a browser');

// Both demos wire the agent identically.
for (const [name, main] of Object.entries(mains)) {
  for (const needle of ['#include <AtechCloudOta.h>', 'AtechCloudOta cloudOta;', 'cloudOta.isTransferring()', 'coreConfig.holdAutoConfirm',
                         'lanConfig.extraIdentity', 'wifiOtaConfig.cloud = &cloudOta', 'ATECH_CLOUD_URL', 'ATECH_CLOUD_ALLOW_HTTP', 'cloudOta.begin(', 'cloudOta.loop()']) {
    assert.ok(main.includes(needle), `${name} main.cpp must contain ${needle}`);
  }
}

console.log('Atech cloud OTA agent structure tests passed');
