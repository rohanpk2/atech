'use strict';

// Structure and safety-order test for the board's own hotspot update page (shared/AtechWifiOta).
// C++ cannot run here, so this pins what the dashboard, the backend and the owner rely on: the
// ATECH-<suffix> hotspot, the signed .atech package upload, the OTA authorization code gate, the
// shared install engine (atech::ImageSink) with its signature check, and the post-reboot proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'src', 'AtechWifiOta.cpp'), 'utf8');
const header = fs.readFileSync(path.join(__dirname, 'src', 'AtechWifiOta.h'), 'utf8');
const library = JSON.parse(fs.readFileSync(path.join(__dirname, 'library.json'), 'utf8'));
const lan = fs.readFileSync(path.join(__dirname, '..', 'AtechWifiLan', 'src', 'AtechWifiLan.cpp'), 'utf8');
const lanHeader = fs.readFileSync(path.join(__dirname, '..', 'AtechWifiLan', 'src', 'AtechWifiLan.h'), 'utf8');
const htmlMatch = source.match(/R"ATECHHTML\(([\s\S]*?)\)ATECHHTML"/);
assert.ok(htmlMatch, 'embedded portal HTML must be present');
const html = htmlMatch[1];

assert.equal(library.version, '2.0.0');

const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
assert.ok(scriptMatch, 'embedded portal JavaScript must be present');
assert.doesNotThrow(() => new Function(scriptMatch[1]), 'embedded portal JavaScript must parse in a browser');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'embedded portal IDs must be unique');
const referencedIds = [...scriptMatch[1].matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
assert.deepEqual(referencedIds.filter(id => !ids.includes(id)), [], 'every portal JavaScript ID must exist in the HTML');
assert.doesNotMatch(html + source, /—/, 'copy must not contain em dashes');

// The update form: one signed package (or a raw image), progress distinct from verification.
assert.match(html, /type="file"[^>]+accept="\.atech,\.bin,application\/octet-stream"/);
assert.match(html, /Deploy Firmware/);
assert.match(html, /role="progressbar"/);
assert.match(html, /ATECHPKG1/, 'the page reads the .atech package header in the browser');
assert.match(html, /file\.slice\(0,\s*\d+\)/, 'the header is read from a bounded slice, never the whole file');
assert.match(html, /Browser upload complete; waiting for device receipt and flash verification/,
  'browser upload completion must not be labeled as flash success');
assert.match(html, /Flash verified/, 'success must be shown only after the device response');
assert.match(html, /post_update_boot/, 'portal must verify the running version after reboot');
assert.doesNotMatch(html, /crypto\.subtle/, 'the HTTP portal must not depend on secure-context-only Web Crypto');
assert.match(html, /xhr\.timeout=600000/);
for (const name of ['X-Atech-OTA-Key', 'X-Atech-Firmware-Size', 'X-Atech-SHA256', 'X-Atech-Build', 'X-Atech-Version', 'X-Atech-Downgrade',
                    'X-Atech-Target', 'X-Atech-Sig', 'X-Atech-Key', 'X-Atech-Demo']) {
  assert.ok(html.includes(name), `the page must send ${name}`);
  assert.ok(source.includes(`"${name}"`), `the portal must collect ${name}`);
}
assert.match(html, /partition_capacity/, 'browser should reject an oversized file before uploading when status is available');
assert.match(html, /exitButton\.disabled=true/, 'the portal must disable Exit after deployment starts');
assert.match(html, /fileGeneration/, 'stale asynchronous file checks must not authorize a newer selection');
assert.match(html, /signed update package/i, 'the page tells the user where the package comes from');

// Install engine: the shared sink owns the flash; the portal never selects a slot itself.
assert.ok(source.includes('#include <AtechImageSink.h>') && source.includes('atech::ImageSink sink'), 'the portal installs through atech::ImageSink');
assert.doesNotMatch(source, /esp_ota_set_boot_partition|esp_ota_begin\(|esp_ota_write\(|esp_ota_end\(/, 'no second flash writer in the portal');
assert.ok(source.includes('sink.abort()'), 'incomplete transfers discard the sink');
assert.ok(source.includes('coreTryAcquireOta("hotspot")') && source.includes('coreReleaseOta("hotspot")'), 'flash ownership through the core lock');
assert.ok(source.includes('sink.setManifest('), 'the manifest from the headers reaches the sink');
assert.ok(source.includes('fwsign::pinKey(') && source.includes('"hotspot"'), 'a token-authenticated upload may pin the first signing key');
assert.ok(source.includes('upload.totalSize != expectedBytes'), 'a body whose length differs from the declared size is refused');
const markerAt = source.indexOf('if (!persistRebootMarker())');
const finishAt = source.indexOf('sink.finish(');
assert.ok(markerAt > 0 && finishAt > markerAt, 'the post-reboot marker is persisted before the sink selects the slot');
assert.ok(source.slice(finishAt).includes('clearRebootMarker()'), 'a refused image clears the marker again');

// Authorization: the OTA code gates uploads, settings and the signing key.
assert.match(source, /constantTimeEquals\(server->header\("X-Atech-OTA-Key"\), otaToken\)/);
assert.match(source, /if \(rebootAtMs != 0\) \{\n\s+sendJson\(409/, 'the exit endpoint must not cancel a verified update reboot');
assert.match(source, /Cannot exit while a verified update is rebooting/);
for (const route of ['/api/sign/status', '/api/sign/save']) assert.ok(source.includes(`"${route}"`), `portal route ${route}`);
const signSave = source.slice(source.indexOf('"/api/sign/save"'), source.indexOf('"/api/sign/save"') + 400);
assert.match(signSave, /authorize\(\)/, 'the signing key can only be set with the OTA authorization code');
assert.doesNotMatch(source, /otaToken\.c_str\(\)\s*\)\s*;[^\n]*sendJson/, 'the portal never sends the pairing token to a browser');
const statusRoute = source.match(/server->on\("\/api\/status"[\s\S]*?\n    \}\);/);
assert.ok(statusRoute);
assert.doesNotMatch(statusRoute[0], /lastActivityMs/, 'automatic status polling must not defeat the inactivity timeout');

// Network card: personal and enterprise (PEAP, TTLS, EAP-TLS) with a CA or the built-in bundle.
for (const id of ['wifiAuth', 'wifiEnterprise', 'wifiUser', 'wifiIdentity', 'wifiPhase2', 'wifiDomain', 'wifiCaBundle', 'wifiCa', 'wifiCert', 'wifiKey']) {
  assert.ok(ids.includes(id), `Network card must have #${id}`);
}
assert.ok(source.includes('lan->saveProfile(') && source.includes('AtechWifiLan::parseAuth(') && source.includes('AtechWifiLan::parsePhase2('), 'the save route builds a profile');
for (const field of ['"ident"', '"user"', '"ca"', '"crt"', '"key"', '"domain"', '"ca_bundle"', '"auth"', '"ph2"']) assert.ok(source.includes(`server->arg(${field})`), `save reads ${field}`);
assert.match(html, /certificate checking is never disabled/);
assert.doesNotMatch(source, /saveCredentials\(/, 'every path goes through the validated profile');

// Captive portals: the station probes the internet, the hotspot can route the user's browser through
// the board (NAT) so the network's sign-in page authorizes the board, and the station MAC is shown.
assert.ok(lan.includes('connectivitycheck.gstatic.com/generate_204') && lan.includes('captive.apple.com/hotspot-detect.html'), 'two connectivity probes');
assert.ok(lanHeader.includes('const char *internetState() const') && lanHeader.includes('String captiveUrl() const') && lanHeader.includes('void recheckInternet()'), 'network state API');
assert.ok(lan.includes('xTaskCreatePinnedToCore') && lan.includes('atech_net'), 'the probe runs on its own task, never on the main loop');
assert.ok(source.includes('enableNAPT(') || source.includes('esp_netif_napt_enable('), 'the sign-in helper enables NAT on the hotspot');
for (const route of ['/api/net/helper', '/api/net/recheck']) assert.ok(source.includes(`"${route}"`), `portal route ${route}`);
const helperRoute = source.slice(source.indexOf('"/api/net/helper"'), source.indexOf('"/api/net/helper"') + 400);
assert.match(helperRoute, /authorize\(\)/, 'the helper is behind the OTA authorization code');
for (const id of ['netCard', 'netStatus', 'netHelper', 'netRecheck', 'netMac', 'netSignIn']) assert.ok(ids.includes(id), `network card must have #${id}`);
assert.ok(source.includes('\\"internet\\"') && source.includes('\\"captive_url\\"') && source.includes('\\"helper\\"') && source.includes('\\"mac\\"'), 'status reports the network state');
assert.match(html, /register|IT/i, 'the page offers the MAC for IT registration as the explicit fallback');

// Transport controller: the hotspot comes up by itself when the cloud is out of reach and goes away
// when it is back, never during an upload or while someone is using the page.
assert.ok(header.includes('bool autoStart;') && header.includes('uint32_t offlineGraceMs;') && header.includes('uint32_t onlineGraceMs;'), 'controller config');
assert.match(source, /offlineGraceMs == 0\) _impl->config\.offlineGraceMs = 90000/, 'offline grace defaults to 90 s');
assert.match(source, /onlineGraceMs == 0\) _impl->config\.onlineGraceMs = 60000/, 'online grace defaults to 60 s');
assert.match(source, /CLIENT_RECENT_MS\s*=\s*120000/, 'a client seen in the last two minutes keeps the hotspot');
assert.ok(source.includes('void evaluatePolicy('), 'one policy function');
const policy = source.slice(source.indexOf('void evaluatePolicy('), source.indexOf('void evaluatePolicy(') + 3000);
for (const reason of ['"online"', '"no_wifi"', '"no_cloud_url"', '"captive"', '"offline"', '"manual"']) assert.ok(policy.includes(reason), `policy names ${reason}`);
assert.match(policy, /!wifiConfigured \|\| \(cloudEnabled && !cloudOnline && now - cloudLostMs >= config\.offlineGraceMs\)/, 'captive, offline and no-Wi-Fi start the hotspot after the grace');
assert.match(policy, /!uploading && !helperActive/, 'never stops during an upload or the sign-in helper');
assert.ok(header.includes('const char *transport() const') && header.includes('String transportJson() const') && header.includes('String transportReport() const'), 'transport state API');
assert.ok(source.includes('transport=') && source.includes('&reason=') && source.includes('&hotspot='), 'the poll report fields');
assert.ok(source.includes('autoStarted && !manualStart'), 'a hotspot the user started by hand is never stopped by the policy');

// Hotspot identity: ATECH-<suffix>, WPA2, discoverable hostname.
assert.match(source, /WIFI_AUTH_WPA2_PSK, WIFI_CIPHER_TYPE_CCMP/);
assert.match(source, /ssidPrefix \? config\.ssidPrefix : "ATECH"/, 'the default SSID prefix is ATECH');
assert.match(source, /mac\[3\], mac\[4\], mac\[5\]/, 'the SSID suffix uses the device-unique MAC bytes');
assert.ok(source.includes('ensureMdns()'), 'the hotspot answers atech-<suffix>.local');
assert.ok(lanHeader.includes('bool ensureMdns()') && lan.includes('bool AtechWifiLan::ensureMdns()'), 'AtechWifiLan starts mDNS on demand');
assert.ok(lanHeader.includes('String stationMac() const'), 'the station MAC is available for IT registration');
assert.ok(header.includes('const String &apPassword() const') && header.includes('String hotspotReport() const'), 'the owner learns the hotspot password through the cloud login');
assert.ok(header.includes('const char *hostnamePrefix;') && header.includes('uint8_t demo;'), 'config carries the hostname prefix and the demo');
assert.ok(source.includes('\\"hostname\\"') && source.includes('\\"sign\\"') && source.includes('\\"device_id\\"'), 'status reports the hostname, the device id and the signing key state');


// A key travelling with an upload is pinned only once the sink accepted the image: a refused package
// from the wrong backend must not lock the board to that backend's key.
const startBody = source.slice(source.indexOf('bool startUpload('), source.indexOf('void finishUpload('));
const finishBody = source.slice(source.indexOf('void finishUpload('), source.indexOf('void finishUpload(') + 3000);
assert.ok(startBody.length > 100 && finishBody.length > 100, 'upload handlers found');
assert.ok(!startBody.includes('pinKey('), 'the upload start never pins a key');
assert.ok(finishBody.indexOf('pinKey(') > finishBody.indexOf('sink.finish(reason)'), 'the key is pinned after sink.finish succeeded');
// "Cloud online" means a recent successful exchange, not a bearer token that is never aged.
assert.match(source, /CLOUD_CONTACT_MAX_MS\s*=\s*60000\b/, 'a session older than a minute without contact counts as offline');
assert.ok(policy.includes('lastContactAgeMs()'), 'the policy uses the age of the last successful exchange');

console.log('Shared Wi-Fi OTA portal structure and safety-order tests passed');
