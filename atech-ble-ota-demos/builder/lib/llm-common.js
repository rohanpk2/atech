'use strict';

// Shared between the prompt assembly and the providers so neither imports the
// other (which would be circular).
const {z} = require('zod');

const GENERATION_SCHEMA = z.object({
  name: z.string().min(1).max(40).describe('Short human-readable app name, 1 to 40 characters'),
  summary: z.string().max(400).describe('One or two sentences describing what the app does'),
  code: z.string().min(1).describe('Complete contents of src/app/user_app.cpp'),
});

const GENERATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: {type: 'string', minLength: 1, maxLength: 40, description: 'Short human-readable app name'},
    summary: {type: 'string', maxLength: 400, description: 'One or two sentences describing what the app does'},
    code: {type: 'string', minLength: 1, description: 'Complete contents of src/app/user_app.cpp'},
  },
  required: ['name', 'summary', 'code'],
  additionalProperties: false,
};

// Single-turn CLIs (claude -p) get the whole exchange as one prompt.
function flattenMessages(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      parts.push(`Your previous answer was:\n\n${message.content}`);
    } else {
      parts.push(message.content);
    }
  }
  return parts.join('\n\n---\n\n');
}

module.exports = {GENERATION_SCHEMA, GENERATION_JSON_SCHEMA, flattenMessages};
