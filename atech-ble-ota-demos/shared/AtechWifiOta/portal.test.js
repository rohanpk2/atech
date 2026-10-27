'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'src', 'AtechWifiOta.cpp'), 'utf8');
const htmlMatch = source.match(/R"ATECHHTML\(([\s\S]*?)\)ATECHHTML"/);
assert.ok(htmlMatch, 'embedded portal HTML must be present');
const html = htmlMatch[1];

const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
assert.ok(scriptMatch, 'embedded portal JavaScript must be present');
assert.doesNotThrow(() => new Function(scriptMatch[1]),
  'embedded portal JavaScript must parse in a browser');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'embedded portal IDs must be unique');
const referencedIds = [...scriptMatch[1].matchAll(/\$\('([^']+)'\)/g)]
  .map(match => match[1]);
assert.deepEqual(referencedIds.filter(id => !ids.includes(id)), [],
  'every portal JavaScript ID must exist in the HTML');

assert.match(html, /type="file"[^>]+accept="\.bin,application\/octet-stream"/);
assert.match(html, /Deploy Firmware/);
assert.match(html, /role="progressbar"/);
assert.match(html, /Browser upload complete; waiting for device receipt and flash verification/,
  'browser upload completion must not be labeled as flash success');
assert.match(html, /Flash verified/,
  'success must be shown only after the device response');
assert.match(html, /post_update_boot/,
  'portal must verify the running version after reboot');
assert.match(html, /file\.slice\(p,p\+step\)\.arrayBuffer\(\)/,
  'browser CRC should read bounded slices rather than one whole-file buffer');
assert.doesNotMatch(html, /crypto\.subtle/,
  'the HTTP portal must not depend on secure-context-only Web Crypto');
assert.match(html, /xhr\.timeout=600000/);
assert.match(html, /X-Atech-OTA-Key/);
assert.match(html, /partition_capacity/,
  'browser should reject an oversized file before uploading when status is available');

const beginIndex = source.indexOf('esp_ota_begin(targetPartition');
const endIndex = source.indexOf('esp_ota_end(otaHandle)');
const markerIndex = source.indexOf('if (!persistRebootMarker())', endIndex);
const activateIndex = source.indexOf('esp_ota_set_boot_partition(targetPartition)');
assert.ok(beginIndex >= 0 && endIndex > beginIndex && markerIndex > endIndex &&
  activateIndex > markerIndex,
  'image validation and reboot-status persistence must finish before activation');
assert.match(source, /esp_ota_abort\(otaHandle\)/,
  'incomplete transfers must abort the IDF OTA handle');
assert.match(source, /ESP_APP_DESC_MAGIC_WORD/,
  'bootloader and merged images must fail the application descriptor check');
assert.match(source, /ESP_CHIP_ID_ESP32S3/);
assert.match(source, /ESP_IMAGE_FLASH_SIZE_16MB/);
assert.match(source, /Firmware belongs to a different Atech demo\/target/);
assert.match(source, /WIFI_AUTH_WPA2_PSK, WIFI_CIPHER_TYPE_CCMP/);
assert.match(source, /constantTimeEquals\(server->header\("X-Atech-OTA-Key"\), otaToken\)/);
assert.match(source, /if \(rebootAtMs != 0\) \{\n\s+sendJson\(409/,
  'the exit endpoint must not cancel a verified update reboot');
assert.match(source, /Cannot exit while a verified update is rebooting/);
assert.match(html, /exitButton\.disabled=true/,
  'the portal must disable Exit after deployment starts');
assert.match(html, /fileGeneration/,
  'stale asynchronous file checks must not authorize a newer selection');

const statusRoute = source.match(/server->on\("\/api\/status"[\s\S]*?\n    \}\);/);
assert.ok(statusRoute);
assert.doesNotMatch(statusRoute[0], /lastActivityMs/,
  'automatic status polling must not defeat the inactivity timeout');

console.log('Shared Wi-Fi OTA portal structure and safety-order tests passed');
