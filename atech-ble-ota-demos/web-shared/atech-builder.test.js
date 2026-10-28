'use strict';

// Structure test for the shared builder UI module (no DOM available here).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'atech-builder.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'builder.css'), 'utf8');

const KNOWN_IDS = new Set(['aiPrompt', 'aiBuild', 'aiStatus', 'aiBadge', 'aiSummary', 'aiCode', 'aiCodeMeta',
  'aiDeploy', 'aiDownload', 'aiTarget', 'aiConfirm', 'aiRollback', 'aiAttempts', 'aiLog', 'aiBackend',
  'aiBrowserNote', 'aiReview', 'aiProgress', 'aiProgressBar', 'aiExamples']);
const referenced = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
assert.ok(referenced.length > 10, 'module must address the builder card by element id');
assert.deepEqual(referenced.filter(id => !KNOWN_IDS.has(id)), [], 'every referenced id must be documented');

assert.match(source, /AtechBuilder\s*=\s*\{|root\.AtechBuilder\s*=/, 'module must expose AtechBuilder');
assert.match(source, /function mount\(/);
assert.match(source, /job\.demo === identity\.demo/, 'deploy guard must compare the demo');
assert.match(source, /job\.firmware\.size <= identity\.slotSize/, 'deploy guard must compare the slot size');
assert.match(source, /job\.deviceId === identity\.id/, 'deploy guard must honour the bound device id');
assert.match(source, /EventSource\(/, 'progress must stream over SSE');
assert.match(source, /setInterval\(|function poll/, 'progress must fall back to polling');
assert.match(source, /identity\.build === job\.buildId/, 'verification must compare the build id');
assert.match(source, /loops/, 'verification must watch the loop counter');
assert.match(source, /CONTROL\.echo/, 'verification must request an echo');
assert.match(source, /CONTROL\.confirm/, 'verification must confirm the boot');
assert.match(source, /pairing and upload are manual/, 'Safari copy must be honest');
assert.doesNotMatch(source, /\bconfirm\(|\balert\(/, 'no blocking browser dialogs');
assert.doesNotMatch(source + css, /—/, 'copy must not contain em dashes');
assert.match(source, /\/api\/builds\/\$\{[^}]+\}\/firmware\.bin/, 'download link must point at the backend');
assert.match(css, /prefers-reduced-motion/);

console.log('Atech builder UI structure tests passed');
