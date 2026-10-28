'use strict';

// Primary provider: the official Anthropic SDK with structured output.
// Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
// `ant auth login` profile; nothing is hardcoded here.
const Anthropic = require('@anthropic-ai/sdk');
const {zodOutputFormat} = require('@anthropic-ai/sdk/helpers/zod');
const {GENERATION_SCHEMA} = require('../llm-common');

// A provider failure described for the person running the builder: what went
// wrong, which setting to check, and whether retrying can help. The message
// never includes the credential; the original SDK error stays on `cause`.
class ProviderError extends Error {
  constructor(message, {code, status = null, retryable = false, cause} = {}) {
    super(message, {cause});
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function apiDetail(error) {
  const body = error && error.error;
  return (body && body.error && body.error.message) || (body && body.message) || '';
}

function describeProviderError(error, {model} = {}) {
  if (!(error instanceof Anthropic.AnthropicError)) return error;
  const wrap = (code, message, retryable = false) =>
    new ProviderError(message, {code, retryable, status: error.status ?? null, cause: error});
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return wrap('network', 'Timed out waiting for the Anthropic API; retry the build.', true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return wrap('network', `Could not reach the Anthropic API (${error.message}). Check this machine's network ` +
                           'connection and proxy settings, then retry.', true);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const type = error.type || 'error';
    const detail = apiDetail(error);
    const ref = error.requestID ? ` [request ${error.requestID}]` : '';
    if (status === 401) {
      return wrap('auth', `Anthropic rejected the API key (401 ${type}). Check ANTHROPIC_API_KEY in builder/.env ` +
                          `or the shell, then restart the builder.${ref}`);
    }
    if (status === 402 || /credit balance|billing|purchase credits/i.test(detail)) {
      return wrap('billing', `The Anthropic account has insufficient credit (${status} ${type}): ${detail} ` +
                             `Add credit under Plans & Billing in the Anthropic Console, then retry.${ref}`);
    }
    if (status === 403) {
      return wrap('permission', `The Anthropic API key is not permitted to do this (403 ${type}): ${detail}. ` +
                                `Check the key's workspace and model access in the Anthropic Console.${ref}`);
    }
    if (status === 404) {
      return wrap('model', `Anthropic reports the model "${model}" does not exist or is not available to this key ` +
                           `(404 ${type}): ${detail}. Check ATECH_LLM_MODEL.${ref}`);
    }
    if (status === 429) {
      const retryAfter = Number(error.headers && error.headers.get && error.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `about ${retryAfter} s` : 'a minute';
      return wrap('rate-limit', `Anthropic rate limit reached (429 ${type}) and the SDK's automatic retries were ` +
                                `exhausted; wait ${wait} and retry the build.${ref}`, true);
    }
    if (status === 529 || type === 'overloaded_error') {
      return wrap('overloaded', `Anthropic is temporarily overloaded (${status} ${type}); retry in a few minutes.${ref}`, true);
    }
    if (status >= 500) {
      return wrap('provider', `The Anthropic API failed (${status} ${type}): ${detail}. Retry; check ` +
                              `https://status.anthropic.com if it persists.${ref}`, true);
    }
    return wrap('request', `Anthropic rejected the request (${status} ${type}): ${detail}${ref}`);
  }
  if (/ANTHROPIC_API_KEY|apiKey/.test(error.message)) {
    return wrap('auth', 'No Anthropic API key is configured. Set ANTHROPIC_API_KEY in builder/.env (or export it) ' +
                        'and restart the builder.');
  }
  return wrap('provider', `Anthropic SDK error: ${error.message}`);
}

class GenerationRefused extends Error {
  constructor(details) {
    super(`The model declined this request${details?.category ? ` (${details.category})` : ''}` +
          (details?.explanation ? `: ${details.explanation}` : ''));
    this.name = 'GenerationRefused';
    this.details = details || null;
  }
}

function createAnthropicProvider({model, client, createClient = () => new Anthropic()} = {}) {
  let api = client || null;
  const getClient = () => {
    if (!api) api = createClient();
    return api;
  };
  return {
    name: 'anthropic',
    model,
    async generate({system, messages}) {
      let current;
      try { current = getClient(); } catch (error) { throw describeProviderError(error, {model}); }
      // Server-side refusal fallbacks are a beta on the beta messages surface;
      // an injected test client only needs messages.parse.
      const surface = current.beta && current.beta.messages ? current.beta.messages : current.messages;
      const params = {
        model,
        max_tokens: 16000,
        system,
        messages,
        thinking: {type: 'adaptive'},
        output_config: {effort: 'high', format: zodOutputFormat(GENERATION_SCHEMA)},
      };
      if (surface === current.beta?.messages) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      let response;
      try { response = await surface.parse(params); } catch (error) { throw describeProviderError(error, {model}); }
      if (response.stop_reason === 'refusal') throw new GenerationRefused(response.stop_details);
      if (!response.parsed_output) {
        const reason = response.stop_reason === 'max_tokens' ? ' (max_tokens reached)' : '';
        throw new Error(`The model returned no parsable output${reason}`);
      }
      return {...GENERATION_SCHEMA.parse(response.parsed_output), usage: response.usage, model: response.model};
    },
  };
}

module.exports = {createAnthropicProvider, GenerationRefused, ProviderError, describeProviderError};
