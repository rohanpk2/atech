'use strict';

// Browser client for the gb88/BLEOTA 1.0.6 wire protocol, written from the
// library's published specification (README sections 6, 7 and 14). The
// library itself is AGPL-3.0; this file is an independent Atech client.
(function attachAtechBleota(root) {
  const BLEOTA_SERVICE = '00008018-0000-1000-8000-00805f9b34fb';
  const RECV_FW_CHAR = '00008020-0000-1000-8000-00805f9b34fb';
  const COMMAND_CHAR = '00008022-0000-1000-8000-00805f9b34fb';
  const COMMANDS = Object.freeze({startFlash: 0x0001, stop: 0x0002, ack: 0x0003, startSpiffs: 0x0004});
  const STATUS = Object.freeze({
    0: 'ok', 1: 'crc error or nack', 2: 'index error', 3: 'signature error', 5: 'start error',
  });
  const SECTOR_SIZE = 4096;
  const FRAME_SIZE = 20;
  const END_OF_SECTOR = 0xFF;

  // CRC-16/CCITT, polynomial 0x1021, no reflection, no final XOR. The device
  // computes sector CRCs incrementally, so the init parameter lets a caller
  // chain partial computations and get the same result.
  function crc16(bytes, init = 0) {
    let crc = init & 0xFFFF;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc;
  }

  function le16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function uint32le(value) {
    const out = new Uint8Array(4);
    out[0] = value & 0xFF;
    out[1] = (value >>> 8) & 0xFF;
    out[2] = (value >>> 16) & 0xFF;
    out[3] = (value >>> 24) & 0xFF;
    return out;
  }

  function sealFrame(frame) {
    const crc = crc16(frame.subarray(0, 18));
    frame[18] = crc & 0xFF;
    frame[19] = crc >> 8;
    return frame;
  }

  function buildCommandFrame(commandId, payload = new Uint8Array(0)) {
    const frame = new Uint8Array(FRAME_SIZE);
    frame[0] = commandId & 0xFF;
    frame[1] = (commandId >> 8) & 0xFF;
    frame.set(payload.subarray(0, 16), 2);
    return sealFrame(frame);
  }

  function buildStartFrame(totalSize) {
    return buildCommandFrame(COMMANDS.startFlash, uint32le(totalSize));
  }

  function buildStopFrame() {
    return buildCommandFrame(COMMANDS.stop);
  }

  function checkFrame(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== FRAME_SIZE) {
      throw new Error('BLEOTA frame must be 20 bytes');
    }
    if (le16(bytes, 18) !== crc16(bytes.subarray(0, 18))) throw new Error('BLEOTA frame CRC mismatch');
  }

  function parseCommandAck(bytes) {
    checkFrame(bytes);
    if (le16(bytes, 0) !== COMMANDS.ack) throw new Error('Not a BLEOTA command ack');
    const status = le16(bytes, 4);
    return {commandId: le16(bytes, 2), status, statusText: STATUS[status] || `status ${status}`};
  }

  function parseSectorAck(bytes) {
    checkFrame(bytes);
    const status = le16(bytes, 2);
    return {sectorIndex: le16(bytes, 0), status, statusText: STATUS[status] || `status ${status}`,
            expectedIndex: le16(bytes, 4)};
  }

  function splitSectors(bytes, sectorSize = SECTOR_SIZE) {
    const sectors = [];
    for (let offset = 0; offset < bytes.length; offset += sectorSize) {
      sectors.push(bytes.subarray(offset, Math.min(bytes.length, offset + sectorSize)));
    }
    return sectors;
  }

  // Packets: [index LE16][seq][payload...]; the final packet uses seq 0xFF and
  // appends the CRC16 of the whole sector. payloadSize bounds every packet's
  // payload, including the final one together with its two CRC bytes, so a
  // packet is never longer than payloadSize + 3.
  function buildSectorPackets(sector, sectorIndex, payloadSize) {
    if (!Number.isInteger(payloadSize) || payloadSize < 4) throw new Error('payloadSize must be at least 4');
    const packets = [];
    let offset = 0;
    let seq = 0;
    while (sector.length - offset > payloadSize - 2) {
      const take = Math.min(payloadSize, sector.length - offset - 1);
      const packet = new Uint8Array(3 + take);
      packet[0] = sectorIndex & 0xFF;
      packet[1] = (sectorIndex >> 8) & 0xFF;
      packet[2] = seq++ & 0xFF;
      packet.set(sector.subarray(offset, offset + take), 3);
      packets.push(packet);
      offset += take;
    }
    const remaining = sector.length - offset;
    const last = new Uint8Array(3 + remaining + 2);
    last[0] = sectorIndex & 0xFF;
    last[1] = (sectorIndex >> 8) & 0xFF;
    last[2] = END_OF_SECTOR;
    last.set(sector.subarray(offset), 3);
    const crc = crc16(sector);
    last[last.length - 2] = crc & 0xFF;
    last[last.length - 1] = crc >> 8;
    packets.push(last);
    return packets;
  }

  const api = Object.freeze({
    BLEOTA_SERVICE, RECV_FW_CHAR, COMMAND_CHAR, COMMANDS, STATUS, SECTOR_SIZE, FRAME_SIZE,
    crc16, uint32le, buildCommandFrame, buildStartFrame, buildStopFrame, parseCommandAck, parseSectorAck,
    splitSectors, buildSectorPackets,
  });
  root.AtechBleota = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
