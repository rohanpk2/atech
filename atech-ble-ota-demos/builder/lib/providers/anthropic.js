'use strict';

// Primary provider: the official Anthropic SDK with structured output.
// Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
// `ant auth login` profile; nothing is hardcoded here.
const Anthropic = require('@anthropic-ai/sdk');
const {zodOutputFormat} = require('@anthropic-ai/sdk/helpers/zod');
const {GENERATION_SCHEMA} = require('../llm-common');

class GenerationRefused extends Error {
  constructor(details) {
    super(`The model declined this request${details?.category ? ` (${details.category})` : ''}` +
          (details?.explanation ? `: ${details.explanation}` : ''));
    this.name = 'GenerationRefused';
    this.details = details || null;
  }
}

function createAnthropicProvider({model, client} = {}) {
  let api = client || null;
  const getClient = () => {
    if (!api) api = new Anthropic();
    return api;
  };
  return {
    name: 'anthropic',
    model,
    async generate({system, messages}) {
      const current = getClient();
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
      const response = await surface.parse(params);
      if (response.stop_reason === 'refusal') throw new GenerationRefused(response.stop_details);
      if (!response.parsed_output) {
        const reason = response.stop_reason === 'max_tokens' ? ' (max_tokens reached)' : '';
        throw new Error(`The model returned no parsable output${reason}`);
      }
      return {...GENERATION_SCHEMA.parse(response.parsed_output), usage: response.usage, model: response.model};
    },
  };
}

module.exports = {createAnthropicProvider, GenerationRefused};
