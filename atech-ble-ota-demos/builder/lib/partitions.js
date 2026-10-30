'use strict';

// ESP-IDF partition table (CSV) parsing: the OTA slot size the backend
// validates images against comes from here, not from a constant.
const fs = require('node:fs');

function parseNumber(text) {
  const value = String(text).trim();
  const match = value.match(/^(0x[0-9a-f]+|\d+)([km])?$/i);
  if (!match) throw new Error(`Invalid partition number "${value}"`);
  const base = match[1].toLowerCase().startsWith('0x') ? parseInt(match[1], 16) : parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  return unit === 'k' ? base * 1024 : unit === 'm' ? base * 1024 * 1024 : base;
}

function parsePartitions(csvText) {
  const parts = [];
  for (const rawLine of String(csvText).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(',').map(f => f.trim());
    if (fields.length < 5) continue;
    parts.push({name: fields[0], type: fields[1], subtype: fields[2], offset: parseNumber(fields[3]), size: parseNumber(fields[4])});
  }
  return parts;
}

function appSlots(parts) {
  const find = subtype => parts.find(p => p.type === 'app' && p.subtype === subtype);
  const ota0 = find('ota_0');
  const ota1 = find('ota_1');
  if (!ota0) throw new Error('Partition table has no ota_0 app partition');
  if (!ota1) throw new Error('Partition table has no ota_1 app partition');
  return {ota0: ota0.size, ota1: ota1.size};
}

function slotSizeFromCsv(file) {
  const slots = appSlots(parsePartitions(fs.readFileSync(file, 'utf8')));
  return Math.min(slots.ota0, slots.ota1);
}

module.exports = {parsePartitions, appSlots, slotSizeFromCsv, parseNumber};
