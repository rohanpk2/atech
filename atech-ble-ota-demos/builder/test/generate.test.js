'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {GENERATION_SCHEMA, GENERATION_JSON_SCHEMA, buildSystemPrompt, buildMessages, flattenMessages}
  = require('../lib/generate');

const HEADER = '// fake header\nvoid appSetup();\nvoid appLoop();\n';

test('schema rejects empty names and accepts a full result', () => {
  assert.equal(GENERATION_SCHEMA.safeParse({name: '', summary: 's', code: 'x'}).success, false);
  assert.equal(GENERATION_SCHEMA.safeParse({name: 'Blink', summary: 's', code: 'x'}).success, true);
  assert.deepEqual(GENERATION_JSON_SCHEMA.required.sort(), ['code', 'name', 'summary']);
  assert.equal(GENERATION_JSON_SCHEMA.additionalProperties, false);
});

test('system prompt embeds the API header, the GPIO policy and the contract', () => {
  const prompt = buildSystemPrompt({demo: 1, apiHeader: HEADER});
  assert.ok(prompt.includes(HEADER));
  assert.match(prompt, /appSetup/);
  assert.match(prompt, /1, 2, 4/);
  assert.match(prompt, /GPIO 48/);
  assert.match(prompt, /own (FreeRTOS )?task/);
  assert.match(prompt, /delay\(\)/);
  assert.doesNotMatch(prompt, /—/);
});

test('first-round messages carry the user prompt and device context', () => {
  const messages = buildMessages({prompt: 'Blink twice', demo: 1, deviceId: 'ATECH-AABBCCDDEEFF', attempts: []});
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /Blink twice/);
  assert.match(messages[0].content, /ATECH-AABBCCDDEEFF/);
});

test('repair rounds replay the previous code and the compiler errors', () => {
  const attempts = [{
    code: '#include <AtechApp.h>\nvoid appSetup() {}\nvoid appLoop() { ledd.off() }\n',
    diagnostics: [{file: 'src/app/user_app.cpp', line: 3, col: 18, severity: 'error', message: "'ledd' was not declared in this scope"}],
    violations: [],
    logTail: 'Compiling...\nerror',
  }];
  const messages = buildMessages({prompt: 'Blink', demo: 1, deviceId: '', attempts});
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].content, /ledd\.off\(\)/);
  assert.equal(messages[2].role, 'user');
  assert.match(messages[2].content, /user_app\.cpp:3:18: error: 'ledd' was not declared/);
  assert.match(messages[2].content, /full corrected file/i);
});

test('policy violations are fed back like compiler errors', () => {
  const attempts = [{code: 'x', diagnostics: [], violations: [{rule: 'gpio', message: 'pinMode() on GPIO 45 is not permitted', line: 7}], logTail: ''}];
  const messages = buildMessages({prompt: 'Blink', demo: 2, deviceId: '', attempts});
  assert.match(messages[2].content, /GPIO 45/);
  assert.match(messages[2].content, /line 7/);
});

test('flattenMessages produces one prompt for single-turn CLIs', () => {
  const text = flattenMessages([
    {role: 'user', content: 'A'}, {role: 'assistant', content: 'B'}, {role: 'user', content: 'C'},
  ]);
  assert.match(text, /A[\s\S]*B[\s\S]*C/);
  assert.match(text, /previous (attempt|answer)/i);
});
