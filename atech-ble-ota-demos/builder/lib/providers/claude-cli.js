'use strict';

// Fallback provider: the locally installed `claude` CLI in non-interactive
// mode. Uses whatever login the CLI already has, so it works on a developer
// machine without an API key. Single-turn, so repair rounds are flattened.
const childProcess = require('node:child_process');
const {GENERATION_SCHEMA, GENERATION_JSON_SCHEMA, flattenMessages} = require('../llm-common');

function cleanEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE') || key === 'CLAUDE_PID') continue;
    out[key] = value;
  }
  return out;
}

function createClaudeCliProvider({model, spawn = childProcess.spawn, env = process.env,
                                  bin = 'claude', timeoutMs = 900000} = {}) {
  return {
    name: 'claude-cli',
    model,
    generate({system, messages}) {
      const prompt = flattenMessages(messages);
      const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(GENERATION_JSON_SCHEMA),
                    '--model', model, '--system-prompt', system, '--no-session-persistence'];
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(bin, args, {env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe']});
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          reject(new Error(`claude CLI timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`claude CLI could not start: ${error.message}`));
        });
        child.on('close', code => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            reject(new Error(`claude CLI returned no JSON (exit ${code}): ${(stderr || stdout).slice(0, 500)}`));
            return;
          }
          if (parsed.is_error) {
            reject(new Error(`claude CLI error: ${parsed.result || 'unknown error'}`));
            return;
          }
          let output = parsed.structured_output;
          if (!output && typeof parsed.result === 'string') {
            try { output = JSON.parse(parsed.result); } catch { output = null; }
          }
          const check = GENERATION_SCHEMA.safeParse(output);
          if (!check.success) {
            reject(new Error(`claude CLI output did not match the schema: ${check.error.message}`));
            return;
          }
          resolve({...check.data, usage: parsed.usage, costUsd: parsed.total_cost_usd, model: parsed.model});
        });
        child.stdin.on('error', () => { /* child exited early; close handler reports it */ });
        child.stdin.end(prompt);
      });
    },
  };
}

module.exports = {createClaudeCliProvider, cleanEnv};
