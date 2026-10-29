import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBasicAuthorization, timingSafeEqualStrings, authorize} from '../lib/basic-auth.js';

const b64 = text => Buffer.from(text, 'utf8').toString('base64');

test('parseBasicAuthorization decodes user and password, splitting at the first colon only', () => {
  assert.deepEqual(parseBasicAuthorization(`Basic ${b64('user:pa:ss')}`), {user: 'user', password: 'pa:ss'});
  assert.deepEqual(parseBasicAuthorization(`basic ${b64('u:p')}`), {user: 'u', password: 'p'}, 'scheme is case-insensitive');
  assert.deepEqual(parseBasicAuthorization(`Basic ${b64('anna:pässword')}`), {user: 'anna', password: 'pässword'}, 'UTF-8 survives');
});

test('parseBasicAuthorization returns null for anything that is not a well-formed Basic header', () => {
  for (const header of [null, undefined, '', 'Bearer abc', 'Basic', 'Basic !!!', `Basic ${b64('nocolon')}`, `Digest ${b64('u:p')}`]) {
    assert.equal(parseBasicAuthorization(header), null, String(header));
  }
});

test('timingSafeEqualStrings compares whole strings', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('a', 'abc'), false);
  assert.equal(timingSafeEqualStrings('', ''), true);
  assert.equal(timingSafeEqualStrings('pässword', 'pässword'), true);
});

test('authorize fails closed when credentials are not configured', () => {
  assert.deepEqual(authorize(`Basic ${b64('a:b')}`, {user: 'a', password: ''}), {status: 'unconfigured'});
  assert.deepEqual(authorize(`Basic ${b64('a:b')}`, {user: undefined, password: 'b'}), {status: 'unconfigured'});
  assert.deepEqual(authorize(null, {}), {status: 'unconfigured'});
});

test('authorize denies a missing header, a wrong user and a wrong password, and accepts the right pair', () => {
  const creds = {user: 'atech', password: 'pa:ss'};
  assert.deepEqual(authorize(null, creds), {status: 'denied'});
  assert.deepEqual(authorize(`Basic ${b64('atech:wrong')}`, creds), {status: 'denied'});
  assert.deepEqual(authorize(`Basic ${b64('other:pa:ss')}`, creds), {status: 'denied'});
  assert.deepEqual(authorize(`Basic ${b64('atech:pa:ss')}`, creds), {status: 'ok'});
});
