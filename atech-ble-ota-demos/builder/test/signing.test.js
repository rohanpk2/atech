'use strict';

// Firmware signing: the ECDSA P-256 key the backend owns, the canonical manifest string the
// firmware (shared/AtechFwSign) rebuilds byte for byte, and the .atech package the hotspot page
// uploads. The same values appear in shared/AtechFwSign/sign.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createSigner, canonicalManifest, verifyManifest, buildPackage, parsePackage, PACKAGE_MAGIC, keyIdOf} = require('../lib/signing');

const BOARD = 'ATECH-A1B2C3D4E5F6';
const SHA = 'ab'.repeat(32);
const manifest = (overrides = {}) => ({build: 'deadbeef', demo: 1, size: 1000, sha256: SHA, version: 3, downgrade: false, target: BOARD, ...overrides});
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atech-sign-')), 'signing', 'firmware-signing.pem');

test('canonical string is exact', () => {
  assert.equal(canonicalManifest(manifest()), `atech-fw/1\ndeadbeef\n1\n1000\n${SHA}\n3\n0\n${BOARD}\n`);
  assert.equal(canonicalManifest(manifest({downgrade: true, target: '', sha256: SHA.toUpperCase()})), `atech-fw/1\ndeadbeef\n1\n1000\n${SHA}\n3\n1\n\n`);
});

test('key is created once and reloaded', () => {
  const file = tempFile();
  const first = createSigner({file});
  const second = createSigner({file});
  assert.equal(first.publicKeyHex(), second.publicKeyHex());
  assert.match(first.publicKeyHex(), /^04[0-9a-f]{128}$/, 'uncompressed P-256 point, 130 hex');
  assert.match(first.keyId(), /^[0-9a-f]{8}$/);
  assert.equal(first.keyId(), keyIdOf(first.publicKeyHex()));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(first.file, file);
});

test('sign and verify round trip; a changed field fails', () => {
  const signer = createSigner({file: tempFile()});
  const sig = signer.sign(manifest());
  assert.match(sig, /^[0-9a-f]{128}$/, 'raw r||s, 64 bytes');
  assert.equal(signer.verify(manifest(), sig), true);
  assert.equal(verifyManifest(manifest(), sig, signer.publicKeyHex()), true);
  assert.equal(signer.verify(manifest({downgrade: true}), sig), false);
  assert.equal(signer.verify(manifest({version: 4}), sig), false);
  assert.equal(signer.verify(manifest({sha256: 'ac' + SHA.slice(2)}), sig), false);
  assert.equal(signer.verify(manifest(), sig.slice(0, -2) + (sig.endsWith('00') ? '01' : '00')), false);
  assert.equal(signer.verify(manifest(), 'zz'), false, 'malformed signatures are false, never thrown');
  const other = createSigner({file: tempFile()});
  assert.equal(verifyManifest(manifest(), sig, other.publicKeyHex()), false, 'another key does not verify');
  assert.equal(verifyManifest(manifest(), sig, 'not-a-key'), false);
});

test('verifyManifest fails when the target differs', () => {
  const signer = createSigner({file: tempFile()});
  const sig = signer.sign(manifest());
  assert.equal(verifyManifest(manifest({target: 'ATECH-000000000002'}), sig, signer.publicKeyHex()), false);
  assert.equal(verifyManifest(manifest({target: ''}), sig, signer.publicKeyHex()), false);
});

test('package round trip and refusals', () => {
  const signer = createSigner({file: tempFile()});
  const image = Buffer.alloc(3000, 7);
  const header = {v: 1, ...manifest({size: image.length}), ver: 3, sig: signer.sign(manifest({size: image.length})), kid: signer.keyId(), pub: signer.publicKeyHex(), app: 'Blink', created: '2026-11-15T00:00:00.000Z'};
  const pkg = buildPackage({image, header});
  assert.equal(pkg.subarray(0, PACKAGE_MAGIC.length).toString('latin1'), PACKAGE_MAGIC);
  assert.equal(PACKAGE_MAGIC, 'ATECHPKG1\n');
  const headerLength = pkg.readUInt32LE(PACKAGE_MAGIC.length);
  assert.equal(pkg.length, PACKAGE_MAGIC.length + 4 + headerLength + image.length);
  const parsed = parsePackage(pkg);
  assert.deepEqual(parsed.header, header);
  assert.ok(parsed.image.equals(image));
  assert.throws(() => parsePackage(Buffer.from('NOTAPKG\n' + 'x'.repeat(40))), error => error.code === 'package');
  assert.throws(() => parsePackage(pkg.subarray(0, PACKAGE_MAGIC.length + 4 + 10)), error => error.code === 'package');
  const liar = Buffer.from(pkg);
  liar.writeUInt32LE(0x7fffffff, PACKAGE_MAGIC.length);
  assert.throws(() => parsePackage(liar), error => error.code === 'package');
  assert.throws(() => parsePackage(Buffer.concat([pkg.subarray(0, PACKAGE_MAGIC.length), Buffer.from([2, 0, 0, 0]), Buffer.from('{}')])), error => error.code === 'package' && /size/.test(error.message),
                'a header whose size does not match the body is refused');
});

test('the default signing key location is gitignored so the private key never reaches a commit', () => {
  const {execFileSync} = require('node:child_process');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: __dirname, encoding: 'utf8'}).trim();
  const keyFile = path.join(repoRoot, 'atech-ble-ota-demos', '.ai-builds', 'signing', 'firmware-signing.pem');
  let ignored = false;
  try { execFileSync('git', ['check-ignore', '-q', keyFile], {cwd: repoRoot, stdio: 'ignore'}); ignored = true; } catch (_) { ignored = false; }
  assert.equal(ignored, true, `${path.relative(repoRoot, keyFile)} must be ignored by the repository .gitignore`);
});
