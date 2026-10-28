'use strict';

// Structure test for the shared Atech firmware core. C++ cannot run here, so
// this pins the contract the backend, the dashboards and the demos rely on.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const app = read('src/AtechApp.h');
const api = read('src/AtechAppApi.h');
const core = read('src/AtechCore.h');
const impl = read('src/AtechCore.cpp');
const wifi = fs.readFileSync(path.join(__dirname, '..', 'AtechWifiOta', 'src', 'AtechWifiOta.cpp'), 'utf8');

for (const call of ['pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite',
                     'ledcAttach', 'ledcWrite', 'attachInterrupt']) {
  assert.match(app, new RegExp(`#define ${call}\\(`), `AtechApp.h must route ${call} through a guarded wrapper`);
}
assert.match(app, /void appSetup\(\);/);
assert.match(app, /void appLoop\(\);/);
assert.match(app, /#include "AtechAppApi\.h"/);
assert.match(api, /class Led/);
assert.doesNotMatch(impl, /#include\s+["<]AtechApp\.h[">]/, 'the core must not include the macro header');

assert.match(core, /struct AtechCoreConfig/);
for (const symbol of ['coreBegin', 'coreAttachBle', 'coreLoop', 'coreSuspendApp', 'coreResumeApp',
                       'identityJson', 'confirmBoot', 'rollbackToPrevious', 'canRollback', 'safeMode']) {
  assert.match(core, new RegExp(`\\b${symbol}\\(`), `AtechCore.h must declare ${symbol}`);
}
assert.match(core, /enum class LedOwner : uint8_t \{ Off = 0, BlinkBlue = 1, BlinkGreen = 2, App = 3 \}/);

for (const needle of ['esp_efuse_mac_get_default', 'verifyRollbackLater', 'esp_ota_mark_app_valid_cancel_rollback',
                       'ESP_OTA_IMG_PENDING_VERIFY', 'RTC_NOINIT_ATTR', 'xTaskCreatePinnedToCore', 'vTaskSuspend',
                       'vTaskResume', 'esp_reset_reason', 'canRollBack', 'rollBack']) {
  assert.ok(impl.includes(needle), `AtechCore.cpp must use ${needle}`);
}
for (const suffix of ['0100', '0101', '0102', '0103']) {
  assert.ok(impl.includes(`a7ec${suffix}-2e47-4dd2-82a4-9c2cf6eaa001`), `identity service UUID a7ec${suffix} missing`);
}

const table = impl.match(/ALLOWED_PINS\[\]\s*=\s*\{([^}]*)\}/);
assert.ok(table, 'AtechCore.cpp must define ALLOWED_PINS[]');
const pins = table[1].split(',').map(value => Number(value.trim())).filter(Number.isFinite);
assert.deepEqual(pins, [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47]);

assert.match(impl, /ATECH_CORE_VERSION\[\]\s*=\s*"1\.0\.0"/);
for (const key of ['id', 'suffix', 'demo', 'build', 'app', 'ver', 'slot', 'slotSize', 'pending',
                   'canRollback', 'safe', 'crashes', 'target', 'paired', 'appState', 'loops', 'up']) {
  assert.ok(impl.includes(`\\"${key}\\":`), `identity JSON must contain the ${key} key`);
}

assert.doesNotMatch(wifi, /mac & 0xFFFFFFULL/, 'Wi-Fi SSID suffix must not use the OUI bytes');
assert.match(wifi, /mac\[3\], mac\[4\], mac\[5\]/, 'Wi-Fi SSID suffix must use the device-unique MAC bytes');

console.log('Atech core structure tests passed');
