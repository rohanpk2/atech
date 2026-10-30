'use strict';

// Canonical strings and the device wire format shared with shared/AtechCloudOta.
// The firmware builds byte-identical login messages; keep them in sync.
const test = require('node:test');
const assert = require('node:assert/strict');
const {loginMessage, proofHex, encodeKv, parseKv, parseForm, newSessionToken, newJobId, CloudError, PROTOCOL} = require('../lib/cloud-auth');

const BOARD = 'ATECH-A1B2C3D4E5F6';

test('login message and proof match the firmware layout', () => {
  assert.equal(PROTOCOL, 1);
  assert.equal(loginMessage({deviceId: BOARD, nonce: 'ABCD'}), `atech-cloud-login/1\n${BOARD}\nabcd\n`);
  const proof = proofHex('key', {deviceId: BOARD, nonce: 'abcd'});
  assert.equal(proof.length, 64);
  assert.equal(proof, proofHex('key', {deviceId: BOARD, nonce: 'ABCD'}), 'nonce case does not change the proof');
  assert.notEqual(proof, proofHex('other', {deviceId: BOARD, nonce: 'abcd'}));
});

test('kv encoding is line based and strips newlines', () => {
  assert.equal(encodeKv({ok: true, job: '', n: 5, text: 'a\nb\r', nothing: null, gone: undefined, no: false}),
               'ok=1\njob=\nn=5\ntext=ab\nnothing=\ngone=\nno=0\n');
  assert.deepEqual(parseKv('ok=1\nsha=a=b\n\n'), {ok: '1', sha: 'a=b'});
  assert.deepEqual(parseKv('ok=1\r\nx=y\r\n'), {ok: '1', x: 'y'});
  assert.deepEqual(parseForm('id=ATECH-1&proof=ab%20cd&empty='), {id: 'ATECH-1', proof: 'ab cd', empty: ''});
});

test('tokens and job ids are random hex of the documented length', () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
  assert.match(newJobId(), /^[0-9a-f]{24}$/);
  assert.notEqual(newJobId(), newJobId());
});

test('CloudError carries an HTTP status and a code', () => {
  const error = new CloudError(403, 'unclaimed', 'Board not claimed');
  assert.ok(error instanceof Error);
  assert.equal(error.status, 403);
  assert.equal(error.code, 'unclaimed');
  assert.equal(error.message, 'Board not claimed');
});
