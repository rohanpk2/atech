'use strict';

// Vectors from the gb88/BLEOTA 1.0.6 README protocol specification.
const assert = require('node:assert/strict');
const client = require('./bleota-client.js');

assert.equal(client.BLEOTA_SERVICE, '00008018-0000-1000-8000-00805f9b34fb');
assert.equal(client.RECV_FW_CHAR, '00008020-0000-1000-8000-00805f9b34fb');
assert.equal(client.COMMAND_CHAR, '00008022-0000-1000-8000-00805f9b34fb');
assert.deepEqual(client.COMMANDS, {startFlash: 0x0001, stop: 0x0002, ack: 0x0003, startSpiffs: 0x0004});
assert.equal(client.SECTOR_SIZE, 4096);

assert.equal(client.crc16(new TextEncoder().encode('123456789')), 0x31C3, 'CRC-16/CCITT init 0');
assert.equal(client.crc16(Uint8Array.from([1, 2, 3])), client.crc16(Uint8Array.from([3]), client.crc16(Uint8Array.from([1, 2]))),
  'crc16 must be chainable with an init value');

const start = client.buildStartFrame(0x12345678);
assert.equal(start.byteLength, 20);
assert.deepEqual([...start.subarray(0, 6)], [0x01, 0x00, 0x78, 0x56, 0x34, 0x12]);
assert.deepEqual([...start.subarray(6, 18)], new Array(12).fill(0));
const startCrc = client.crc16(start.subarray(0, 18));
assert.equal(start[18], startCrc & 0xFF);
assert.equal(start[19], startCrc >> 8);
assert.deepEqual([...client.buildStopFrame().subarray(0, 2)], [0x02, 0x00]);

const ack = client.buildCommandFrame(client.COMMANDS.ack, Uint8Array.from([0x01, 0x00, 0x00, 0x00]));
assert.deepEqual(client.parseCommandAck(ack), {commandId: 1, status: 0, statusText: 'ok'});
const signatureError = client.buildCommandFrame(client.COMMANDS.ack, Uint8Array.from([0x02, 0x00, 0x03, 0x00]));
assert.equal(client.parseCommandAck(signatureError).statusText, 'signature error');
const corrupted = ack.slice();
corrupted[4] ^= 0x01;
assert.throws(() => client.parseCommandAck(corrupted), /CRC/);
assert.throws(() => client.parseCommandAck(new Uint8Array(19)), /20 bytes/);
assert.throws(() => client.parseCommandAck(client.buildStartFrame(1)), /command ack/i);

const sectorAck = new Uint8Array(20);
sectorAck[0] = 5; sectorAck[2] = 2; sectorAck[4] = 3;
const sectorAckCrc = client.crc16(sectorAck.subarray(0, 18));
sectorAck[18] = sectorAckCrc & 0xFF; sectorAck[19] = sectorAckCrc >> 8;
assert.deepEqual(client.parseSectorAck(sectorAck), {sectorIndex: 5, status: 2, statusText: 'index error', expectedIndex: 3});
assert.equal(client.STATUS[5], 'start error');

const sectors = client.splitSectors(new Uint8Array(4097));
assert.equal(sectors.length, 2);
assert.equal(sectors[0].byteLength, 4096);
assert.equal(sectors[1].byteLength, 1);

const sector = new Uint8Array(4096).map((_, i) => i & 0xFF);
for (const payloadSize of [509, 241, 117, 17]) {
  const packets = client.buildSectorPackets(sector, 7, payloadSize);
  assert.ok(packets.length >= Math.ceil(4096 / payloadSize));
  assert.deepEqual([...packets[0].subarray(0, 3)], [7, 0, 0], 'first packet carries the sector index and seq 0');
  if (packets.length > 2) assert.equal(packets[1][2], 1, 'seq increments');
  const last = packets[packets.length - 1];
  assert.equal(last[2], 0xFF, 'last packet is marked 0xFF');
  const sectorCrc = client.crc16(sector);
  assert.equal(last[last.length - 2], sectorCrc & 0xFF);
  assert.equal(last[last.length - 1], sectorCrc >> 8);
  const reassembled = [];
  packets.forEach((packet, index) => {
    const end = index === packets.length - 1 ? packet.length - 2 : packet.length;
    assert.ok(packet.length <= payloadSize + 3, `packet ${index} exceeds payload ${payloadSize}`);
    reassembled.push(...packet.subarray(3, end));
  });
  assert.deepEqual(Uint8Array.from(reassembled), sector, `payload ${payloadSize} reassembles the sector`);
}
const shortSector = Uint8Array.from([9, 8, 7]);
const shortPackets = client.buildSectorPackets(shortSector, 2, 241);
assert.equal(shortPackets.length, 1);
assert.deepEqual([...shortPackets[0].subarray(0, 6)], [2, 0, 0xFF, 9, 8, 7]);

console.log('gb88 BLEOTA client protocol tests passed');
