'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {createClaudeCliProvider} = require('../lib/providers/claude-cli');
const Anthropic = require('@anthropic-ai/sdk');
const {createAnthropicProvider, GenerationRefused, ProviderError, describeProviderError} = require('../lib/providers/anthropic');
const {selectProvider} = require('../lib/generate');
const {loadConfig} = require('../lib/config');

function fakeSpawn(output, {code = 0} = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let stdin = '';
    child.stdin.on('data', chunk => { stdin += chunk; });
    child.stdin.on('finish', () => {
      calls.push({bin, args, options, stdin});
      child.stdout.end(typeof output === 'function' ? output(stdin) : output);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return {spawn, calls};
}

test('claude-cli provider calls claude -p with a JSON schema and strips the nested-session env', async () => {
  const structured = {name: 'Blink', summary: 'Blinks', code: 'void appSetup(){}'};
  const {spawn, calls} = fakeSpawn(JSON.stringify({is_error: false, structured_output: structured, total_cost_usd: 0.01}));
  const provider = createClaudeCliProvider({model: 'claude-opus-5-5', spawn,
    env: {PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc'}});
  const result = await provider.generate({system: 'SYS', messages: [{role: 'user', content: 'Blink please'}]});
  assert.deepEqual({name: result.name, summary: result.summary, code: result.code}, structured);
  assert.equal(calls.length, 1);
  const {args, options, stdin} = calls[0];
  assert.ok(args.includes('-p') || args.includes('--print'));
  assert.ok(args.includes('--output-format') && args.includes('json'));
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('--model') && args.includes('claude-opus-5-5'));
  assert.ok(args.includes('--system-prompt') && args.includes('SYS'));
  assert.match(stdin, /Blink please/);
  assert.equal(options.env.CLAUDECODE, undefined);
  assert.equal(options.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(options.env.PATH, '/usr/bin');
});

test('claude-cli provider surfaces CLI errors', async () => {
  const {spawn} = fakeSpawn(JSON.stringify({is_error: true, result: 'Not logged in'}));
  const provider = createClaudeCliProvider({model: 'm', spawn, env: {}});
  await assert.rejects(provider.generate({system: 's', messages: [{role: 'user', content: 'x'}]}), /Not logged in/);
});

test('anthropic provider uses messages.parse with structured output and adaptive thinking', async () => {
  const calls = [];
  const client = {messages: {parse: async params => {
    calls.push(params);
    return {stop_reason: 'end_turn', parsed_output: {name: 'Blink', summary: 'S', code: 'C'}, usage: {input_tokens: 1, output_tokens: 2}};
  }}};
  const provider = createAnthropicProvider({model: 'claude-opus-5-5', client});
  const result = await provider.generate({system: 'SYS', messages: [{role: 'user', content: 'Blink'}]});
  assert.equal(result.code, 'C');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].system, 'SYS');
  assert.deepEqual(calls[0].thinking, {type: 'adaptive'});
  assert.equal(calls[0].output_config.effort, 'high');
  assert.ok(calls[0].output_config.format, 'structured output format must be set');
  assert.ok(calls[0].max_tokens >= 16000);
});

test('anthropic provider raises GenerationRefused on a refusal stop reason', async () => {
  const client = {messages: {parse: async () => ({stop_reason: 'refusal', stop_details: {category: 'cyber'}, parsed_output: null})}};
  const provider = createAnthropicProvider({model: 'm', client});
  await assert.rejects(provider.generate({system: 's', messages: [{role: 'user', content: 'x'}]}), GenerationRefused);
});

test('selectProvider honours ATECH_LLM_PROVIDER=claude-cli', async () => {
  const config = loadConfig({ATECH_LLM_PROVIDER: 'claude-cli'});
  const provider = await selectProvider(config, {claudeOnPath: true});
  assert.equal(provider.name, 'claude-cli');
  assert.equal(provider.model, config.model);
});

test('selectProvider prefers anthropic when a key is present', async () => {
  const config = loadConfig({});
  const provider = await selectProvider(config, {hasAnthropicCredentials: true, claudeOnPath: true});
  assert.equal(provider.name, 'anthropic');
});

test('selectProvider fails clearly when nothing is available', async () => {
  const config = loadConfig({});
  await assert.rejects(selectProvider(config, {hasAnthropicCredentials: false, claudeOnPath: false}),
    /ANTHROPIC_API_KEY|claude/);
});

function apiError(status, type, message, headers = {}) {
  return Anthropic.APIError.generate(status, {type: 'error', error: {type, message}}, undefined, new Headers(headers));
}

test('describeProviderError turns SDK failures into actionable messages without secrets', () => {
  const cases = [
    // [error, code, retryable, ...message patterns]
    [apiError(401, 'authentication_error', 'invalid x-api-key'), 'auth', false, /rejected the API key/, /401/, /ANTHROPIC_API_KEY/],
    [apiError(403, 'permission_error', 'not allowed'), 'permission', false, /403/, /not allowed/],
    [apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'billing', false, /insufficient credit/i, /Billing/],
    [apiError(402, 'billing_error', 'Billing problem'), 'billing', false, /insufficient credit/i, /402/],
    [apiError(429, 'rate_limit_error', 'slow down', {'retry-after': '7'}), 'rate-limit', true, /rate limit/i, /about 7 s/],
    [apiError(429, 'rate_limit_error', 'slow down'), 'rate-limit', true, /rate limit/i, /a minute/],
    [apiError(404, 'not_found_error', 'model: nope'), 'model', false, /model "claude-test"/, /ATECH_LLM_MODEL/],
    [apiError(529, 'overloaded_error', 'Overloaded'), 'overloaded', true, /overloaded/i, /529/],
    [apiError(500, 'api_error', 'Internal server error'), 'provider', true, /500/, /status\.anthropic\.com/],
    [apiError(400, 'invalid_request_error', 'max_tokens: must be positive'), 'request', false, /400/, /max_tokens/],
    [new Anthropic.APIConnectionTimeoutError(), 'network', true, /timed out/i],
    [new Anthropic.APIConnectionError({message: 'fetch failed'}), 'network', true, /reach the Anthropic API/i, /fetch failed/],
    [new Anthropic.AnthropicError('The ANTHROPIC_API_KEY environment variable is missing or empty; either provide it, ' +
       "or instantiate the Anthropic client with an apiKey option, like new Anthropic({ apiKey: 'My API Key' })."),
     'auth', false, /No Anthropic API key is configured/, /ANTHROPIC_API_KEY/],
  ];
  for (const [input, code, retryable, ...patterns] of cases) {
    const out = describeProviderError(input, {model: 'claude-test'});
    assert.ok(out instanceof ProviderError, `${code}: wraps into ProviderError`);
    assert.equal(out.code, code, out.message);
    assert.equal(out.retryable, retryable, `${code}: retryable`);
    assert.equal(out.cause, input, `${code}: keeps the original error as cause`);
    for (const pattern of patterns) assert.match(out.message, pattern, `${code}: ${out.message}`);
    assert.doesNotMatch(out.message, /sk-ant-|apiKey option/, `${code}: never echoes credentials`);
  }
  const plain = new Error('something else');
  assert.equal(describeProviderError(plain, {model: 'm'}), plain, 'non-SDK errors pass through unchanged');
  const withId = describeProviderError(apiError(500, 'api_error', 'boom', {'request-id': 'req_abc123'}), {model: 'm'});
  assert.match(withId.message, /req_abc123/, 'request ids are kept for support');
});

test('anthropic provider reports an invalid key as a ProviderError and keeps the key out of the message', async () => {
  const client = {messages: {parse: async () => { throw apiError(401, 'authentication_error', 'invalid x-api-key'); }}};
  const provider = createAnthropicProvider({model: 'm', client});
  await assert.rejects(provider.generate({system: 's', messages: [{role: 'user', content: 'x'}]}), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'auth');
    assert.match(error.message, /ANTHROPIC_API_KEY/);
    return true;
  });
});

test('anthropic provider reports a missing key when the SDK client cannot be constructed', async () => {
  const provider = createAnthropicProvider({model: 'm', createClient: () => {
    throw new Anthropic.AnthropicError('The ANTHROPIC_API_KEY environment variable is missing or empty; either provide it.');
  }});
  await assert.rejects(provider.generate({system: 's', messages: [{role: 'user', content: 'x'}]}), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'auth');
    assert.match(error.message, /No Anthropic API key is configured/);
    return true;
  });
});
