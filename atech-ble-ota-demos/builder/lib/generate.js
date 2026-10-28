'use strict';

// Prompt assembly and provider selection for firmware generation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gpio = require('./gpio-policy');
const {GENERATION_SCHEMA, GENERATION_JSON_SCHEMA, flattenMessages} = require('./llm-common');
const {createAnthropicProvider} = require('./providers/anthropic');
const {createClaudeCliProvider} = require('./providers/claude-cli');

const SYSTEM_TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system.md'), 'utf8');

const DEMO_NOTES = {
  1: '## Demo 1 note\n\nThe dashboard can also send LED commands (blink blue, blink green, stop blinking, ' +
     'resume app). While a dashboard command owns the LED your `led.set()` calls are ignored until the ' +
     'user sends "resume app". That is expected; do not try to work around it.',
  2: '## Demo 2 note\n\nThis image uses the gb88 BLEOTA transport. Nothing about it is visible to your code.',
};

function buildSystemPrompt({demo, apiHeader}) {
  return SYSTEM_TEMPLATE
    .replace('{{GPIO_POLICY}}', gpio.describe())
    .replace('{{API_HEADER}}', apiHeader.trimEnd())
    .replace('{{DEMO_NOTES}}', DEMO_NOTES[demo] || '');
}

function formatDiagnostics(diagnostics) {
  return diagnostics.map(d => d.file
    ? `${d.file}:${d.line}:${d.col}: ${d.severity}: ${d.message}`
    : `${d.severity}: ${d.message}`).join('\n');
}

function buildMessages({prompt, demo, deviceId, attempts = []}) {
  const target = `Atech Demo ${demo} firmware on an ESP32-S3 DevKitC-1 N16R8` +
                 (deviceId ? `, device ${deviceId}` : '');
  const messages = [{
    role: 'user',
    content: `Write the application for this request.\n\nRequest: """${prompt.trim()}"""\n\n` +
             `Target: ${target}.\nReturn JSON with name, summary and the complete contents of ` +
             'src/app/user_app.cpp in code.',
  }];
  for (const attempt of attempts) {
    messages.push({role: 'assistant', content: 'Here is user_app.cpp:\n\n```cpp\n' + attempt.code + '\n```'});
    const sections = [];
    const errors = (attempt.diagnostics || []).filter(d => d.severity === 'error');
    const warnings = (attempt.diagnostics || []).filter(d => d.severity !== 'error');
    if (errors.length) sections.push('Compiler errors:\n' + formatDiagnostics(errors));
    if (warnings.length) sections.push('Compiler warnings:\n' + formatDiagnostics(warnings));
    if (attempt.violations && attempt.violations.length) {
      sections.push('Policy violations:\n' + attempt.violations
        .map(v => `- ${v.message}${v.line ? ` (line ${v.line})` : ''}`).join('\n'));
    }
    if (attempt.logTail) sections.push('Build log tail:\n' + attempt.logTail);
    messages.push({
      role: 'user',
      content: 'That file was rejected.\n\n' + sections.join('\n\n') +
               '\n\nFix every reported problem and return the full corrected file (name, summary, code).',
    });
  }
  return messages;
}

function commandOnPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function anthropicCredentialsPresent() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ||
         fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
}

async function selectProvider(config, {hasAnthropicCredentials, claudeOnPath} = {}) {
  const creds = hasAnthropicCredentials ?? anthropicCredentialsPresent();
  const cli = claudeOnPath ?? commandOnPath('claude');
  const choice = config.providerOverride || (creds ? 'anthropic' : cli ? 'claude-cli' : null);
  if (choice === 'anthropic') return createAnthropicProvider({model: config.model});
  if (choice === 'claude-cli') return createClaudeCliProvider({model: config.model});
  throw new Error('No LLM credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`), ' +
                  'or install and log in to the `claude` CLI, then restart the builder.');
}

module.exports = {GENERATION_SCHEMA, GENERATION_JSON_SCHEMA, buildSystemPrompt, buildMessages,
                  flattenMessages, selectProvider, formatDiagnostics};
