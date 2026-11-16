'use strict';

// Firmware signing. The backend owns one ECDSA P-256 key; every deployment carries a manifest
// signed with it, and the board (shared/AtechFwSign) verifies the signature with the public key it
// was built with or pinned over an authenticated channel. The canonical string below is rebuilt
// byte for byte by AtechFwSign.cpp; keep the two identical.
//
//   atech-fw/1\n<build>\n<demo>\n<size>\n<sha256 lowercase>\n<version>\n<downgrade 0|1>\n<target>\n
//
// The .atech package the hotspot page uploads is PACKAGE_MAGIC, a little-endian uint32 header
// length, a UTF-8 JSON header and the raw application image.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_MAGIC = 'ATECHPKG1\n';
const MAX_HEADER_BYTES = 64 * 1024;
const PUBLIC_KEY_HEX = /^04[0-9a-f]{128}$/i;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

class PackageError extends Error {
  constructor(message) { super(message); this.code = 'package'; }
}

function canonicalManifest({build, demo, size, sha256, version, downgrade, target}) {
  return `atech-fw/1\n${String(build || '')}\n${Number(demo) || 0}\n${Number(size) || 0}\n${String(sha256 || '').toLowerCase()}\n` +
         `${Number(version) || 0}\n${downgrade ? 1 : 0}\n${String(target || '')}\n`;
}

const b64url = bytes => Buffer.from(bytes).toString('base64url');

function publicKeyFromHex(pubHex) {
  const bytes = Buffer.from(String(pubHex), 'hex');
  return crypto.createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256', x: b64url(bytes.subarray(1, 33)), y: b64url(bytes.subarray(33, 65))}});
}

function publicKeyToHex(publicKey) {
  const jwk = publicKey.export({format: 'jwk'});
  return '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
}

function keyIdOf(pubHex) {
  return crypto.createHash('sha256').update(Buffer.from(String(pubHex), 'hex')).digest('hex').slice(0, 8);
}

// True only for a well-formed signature over the canonical manifest under the given public key.
function verifyManifest(manifest, sigHex, pubHex) {
  if (!SIGNATURE_HEX.test(String(sigHex || '')) || !PUBLIC_KEY_HEX.test(String(pubHex || ''))) return false;
  try {
    return crypto.verify('sha256', Buffer.from(canonicalManifest(manifest), 'utf8'),
                         {key: publicKeyFromHex(pubHex), dsaEncoding: 'ieee-p1363'}, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

// Loads the key at `file` or creates it (PKCS#8 PEM, mode 0600, directory 0700).
function createSigner({file}) {
  if (!file) throw new Error('A signing key file path is required');
  let privateKey;
  if (fs.existsSync(file)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
      throw new Error(`${file} is not a P-256 key`);
    }
  } else {
    const pair = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    privateKey = pair.privateKey;
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  const publicKey = crypto.createPublicKey(privateKey);
  const pubHex = publicKeyToHex(publicKey).toLowerCase();
  const kid = keyIdOf(pubHex);
  return {
    file,
    publicKeyHex: () => pubHex,
    keyId: () => kid,
    sign: manifest => crypto.sign('sha256', Buffer.from(canonicalManifest(manifest), 'utf8'), {key: privateKey, dsaEncoding: 'ieee-p1363'}).toString('hex'),
    verify: (manifest, sigHex, otherPubHex = pubHex) => verifyManifest(manifest, sigHex, otherPubHex),
  };
}

// The manifest a deployment signs: the build's identity, the exact image, the app version, the
// downgrade authorization and the board it is for ("" = any board of the demo).
function manifestFor({buildId, demo, size, sha256, version, deviceId = '', downgrade = false}) {
  return {build: String(buildId), demo: Number(demo), size: Number(size), sha256: String(sha256).toLowerCase(), version: Number(version) || 0,
          downgrade: Boolean(downgrade), target: String(deviceId || '').trim().toUpperCase()};
}

// The JSON header of an .atech package (the manifest, its signature, the key, and display fields).
function packageHeader({manifest, signer, appName = '', now = () => new Date()}) {
  return {v: 1, ...manifest, ver: manifest.version, sig: signer.sign(manifest), kid: signer.keyId(), pub: signer.publicKeyHex(),
          app: String(appName || ''), created: now().toISOString()};
}

function buildPackage({image, header}) {
  if (!Buffer.isBuffer(image)) throw new TypeError('image must be a Buffer');
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(headerBytes.length, 0);
  return Buffer.concat([Buffer.from(PACKAGE_MAGIC, 'latin1'), length, headerBytes, image]);
}

function parsePackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PACKAGE_MAGIC.length + 4) throw new PackageError('Not an Atech update package (too short)');
  if (buffer.subarray(0, PACKAGE_MAGIC.length).toString('latin1') !== PACKAGE_MAGIC) throw new PackageError('Not an Atech update package (bad magic)');
  const headerLength = buffer.readUInt32LE(PACKAGE_MAGIC.length);
  const headerStart = PACKAGE_MAGIC.length + 4;
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || headerStart + headerLength > buffer.length) {
    throw new PackageError('Atech update package header length is invalid');
  }
  let header;
  try { header = JSON.parse(buffer.subarray(headerStart, headerStart + headerLength).toString('utf8')); }
  catch { throw new PackageError('Atech update package header is not valid JSON'); }
  if (!header || typeof header !== 'object') throw new PackageError('Atech update package header is not an object');
  if (!Number.isInteger(header.size) || header.size <= 0) throw new PackageError('Atech update package header has no valid size');
  const image = buffer.subarray(headerStart + headerLength);
  if (image.length !== header.size) throw new PackageError(`Atech update package body is ${image.length} bytes but its header says ${header.size} (size mismatch)`);
  return {header, image};
}

module.exports = {createSigner, canonicalManifest, verifyManifest, manifestFor, packageHeader, buildPackage, parsePackage, publicKeyFromHex, keyIdOf, PACKAGE_MAGIC, PackageError};
