'use strict';

const assert = require('node:assert/strict');
const identity = require('./atech-identity.js');

assert.equal(identity.IDENTITY_SERVICE, 'a7ec0100-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(identity.IDENTITY_CHAR, 'a7ec0101-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(identity.CONTROL_CHAR, 'a7ec0102-2e47-4dd2-82a4-9c2cf6eaa001');
assert.equal(identity.EVENT_CHAR, 'a7ec0103-2e47-4dd2-82a4-9c2cf6eaa001');
assert.deepEqual(identity.CONTROL, {confirm: 1, rollback: 2, echo: 3, restart: 4});

const nonce = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const packet = identity.buildControlPacket(identity.CONTROL.echo, nonce);
assert.equal(packet.byteLength, 9);
assert.deepEqual([...packet], [3, 1, 2, 3, 4, 5, 6, 7, 8]);
assert.throws(() => identity.buildControlPacket(9, nonce), /opcode/);
assert.throws(() => identity.buildControlPacket(1, new Uint8Array(4)), /nonce/);

const event = identity.parseControlEvent(Uint8Array.from([3, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
assert.equal(event.opcode, 3);
assert.equal(event.status, 0);
assert.equal(event.statusText, 'ok');
assert.ok(identity.bytesEqual(event.nonce, nonce));
assert.equal(identity.parseControlEvent(Uint8Array.from([2, 2, 0, 0, 0, 0, 0, 0, 0, 0])).statusText, 'refused');
assert.throws(() => identity.parseControlEvent(new Uint8Array(3)), /10 bytes/);

const sample = JSON.stringify({
  id: 'ATECH-7CDFA1123456', suffix: '123456', demo: 1, board: 'esp32-s3-devkitc-1', variant: 'N16R8', core: '1.0.0',
  fw: 'Atech demo1 / v1 / blue default', build: 'stock', app: 'blue default', ver: 1, slot: 'ota_0',
  slotSize: 6291456, pending: false, canRollback: true, safe: false, crashes: 0, target: '', paired: true,
  appState: 'running', loops: 42, up: 1234,
});
const parsed = identity.parseIdentity(new TextEncoder().encode(sample));
assert.equal(parsed.id, 'ATECH-7CDFA1123456');
assert.equal(parsed.demo, 1);
assert.equal(parsed.loops, 42);
assert.equal(identity.parseIdentity(sample).build, 'stock');
assert.throws(() => identity.parseIdentity('{"id":"nope","demo":1,"build":"x","slotSize":1}'), /device id/i);
assert.throws(() => identity.parseIdentity('{"id":"ATECH-7CDFA1123456"}'), /demo|build|slotSize/);
assert.throws(() => identity.parseIdentity('not json'), /JSON/);

assert.equal(identity.describeIdentity(parsed), 'ATECH-7CDFA1123456 (pairing code 123456), Demo 1, build stock, app "blue default" v1, running');

console.log('Atech identity protocol tests passed');
