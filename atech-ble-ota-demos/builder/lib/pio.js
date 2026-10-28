'use strict';

// PlatformIO runner. Every invocation goes through one queue so AI builds,
// stock rebuilds and installer builds never compete for CPU or the package
// cache at the same time.
const {spawn} = require('node:child_process');
const {loadConfig} = require('./config');

const DIAGNOSTIC = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.*)$/;
const LINKER = /undefined reference to|multiple definition of/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

let queue = Promise.resolve();

function stripAnsi(text) {
  return text.replace(ANSI, '');
}

function runPio(args, {cwd, env = {}, timeoutMs = 600000, onLine, pioBin} = {}) {
  const bin = pioBin || loadConfig().pio;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: {...process.env, PLATFORMIO_DISABLE_PROGRESSBAR: 'true', PLATFORMIO_NO_ANSI: 'true', ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let remainder = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const handle = chunk => {
      const text = stripAnsi(chunk.toString());
      log += text;
      if (!onLine) return;
      remainder += text;
      const lines = remainder.split('\n');
      remainder = lines.pop();
      for (const line of lines) onLine(line);
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (onLine && remainder) onLine(remainder);
      resolve({code: timedOut ? -1 : code, log, timedOut});
    });
  });
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function parseDiagnostics(log) {
  const diagnostics = [];
  const seen = new Set();
  for (const raw of String(log).split('\n')) {
    const line = raw.trimEnd();
    const match = line.match(DIAGNOSTIC);
    let entry = null;
    if (match) {
      entry = {
        file: match[1].trim(), line: Number(match[2]), col: Number(match[3]),
        severity: match[4] === 'warning' ? 'warning' : 'error', message: match[5].trim(),
      };
    } else if (LINKER.test(line)) {
      entry = {file: null, line: null, col: null, severity: 'error', message: line.trim()};
    }
    if (!entry) continue;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(entry);
  }
  return diagnostics;
}

module.exports = {runPio, parseDiagnostics, stripAnsi};
