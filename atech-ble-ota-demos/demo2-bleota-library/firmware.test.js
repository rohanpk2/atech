'use strict';

// Structure test for the Demo 2 firmware integration with the Atech core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, 'src', 'main.cpp'), 'utf8');
const userApp = fs.readFileSync(path.join(__dirname, 'src', 'app', 'user_app.cpp'), 'utf8');
const appBuild = fs.readFileSync(path.join(__dirname, 'src', 'app', 'app_build.h'), 'utf8');
const ini = fs.readFileSync(path.join(__dirname, 'platformio.ini'), 'utf8');

assert.match(main, /#include <AtechCore\.h>/);
assert.match(main, /#include "app\/app_build\.h"/);
assert.match(main, /atech::coreBegin\(/);
assert.match(main, /atech::coreAttachBle\(server\)/);
assert.match(main, /atech::coreLoop\(\)/);
assert.match(main, /BLEOTA\.setCallbacks\(/);
assert.match(main, /atech::coreSuspendApp\(\)/);
assert.match(main, /atech::coreResumeApp\(\)/);
assert.match(main, /BLEOTA\.setSerialNumber\(atech::deviceId\(\)\)/);
assert.match(main, /BLE_NAME_PREFIX\[\] = "Atech-Library-OTA"/);
assert.match(main, /atech::bleName\(BLE_NAME_PREFIX\)/);
assert.match(main, /"ATECH-BUILD:" ATECH_BUILD_ID/);
assert.match(main, /"demo2-" ATECH_STR\(ATECH_APP_VERSION\) "\.0\.0"/,
  'stock images must keep reporting demo2-1.0.0 and demo2-2.0.0');
assert.doesNotMatch(main, /led\.setPixelColor/, 'LED rendering moved into the app and the core');
assert.doesNotMatch(main, /Adafruit_NeoPixel led/, 'the core owns the NeoPixel');
assert.match(main, /BLEOTA\.process\(\)/, 'the gb88 protocol loop must stay untouched');
assert.match(main, /wifiOta\.isUpdating\(\)/, 'the app pauses only during an active Wi-Fi upload');
assert.match(main, /#include <AtechCloudOta\.h>/, 'the cloud OTA agent is part of every image');
assert.match(main, /cloudOta\.isTransferring\(\)/, 'gb88 BLEOTA and the cloud agent never write flash at the same time');

assert.match(main, /#include <AtechSync\.h>/, 'board-to-board sync is part of every image');
assert.match(main, /AtechSync boardSync;/);
assert.match(main, /boardSync\.begin\(/);
assert.match(main, /boardSync\.loop\(\)/);
assert.match(main, /boardSync\.emitEvent\("button\.pressed"\)/, 'a short BOOT press is published as a generic event');

assert.match(userApp, /#include <AtechApp\.h>/);
assert.match(userApp, /atech::sync::onChange\(/, 'the stock app renders the shared demo state');
assert.match(userApp, /"demo\.power"/);
assert.match(userApp, /void appSetup\(\)/);
assert.match(userApp, /void appLoop\(\)/);
assert.match(appBuild, /#define ATECH_BUILD_ID "stock"/);
assert.match(ini, /\[env:ai\]/);

console.log('Demo 2 firmware structure tests passed');
