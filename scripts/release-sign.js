#!/usr/bin/env node
'use strict';

// Release signing — run by whoever publishes ARK releases, never by a
// runtime. The private key stays with that person; only its public half is
// shipped (trust/release-keys.json).
//
//   node scripts/release-sign.js keygen --id <key-id> --out <dir>
//     Writes <dir>/<key-id>.private.pem (owner-only) and prints the entry
//     to add to trust/release-keys.json. Refuses to write inside this repo.
//
//   node scripts/release-sign.js sign <release-dir> --key <private.pem> --id <key-id>
//     Checks <release-dir>/release.json and writes release.json.sig:
//     { key_id, signature } — Ed25519 over release.json's exact bytes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { manifestError } = require('../utils/release');

const REPO = path.resolve(__dirname, '..');
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function fail(msg) { console.error(msg); process.exit(1); }

function keygen() {
  const id = arg('--id');
  const out = arg('--out');
  if (!KEY_ID.test(id || '')) fail('--id must be a short lowercase name, e.g. matt-2026');
  if (!out) fail('--out <dir> is required (somewhere private, outside any repository)');
  const dir = path.resolve(out);
  if (dir === REPO || dir.startsWith(REPO + path.sep)) fail('Refusing to write a private key inside the ARK repository.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.private.pem`);
  if (fs.existsSync(file)) fail(`${file} already exists — not overwriting a key.`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const entry = { id, public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
  console.log(`Private key: ${file} (keep it private; back it up)`);
  console.log('Add this to trust/release-keys.json:');
  console.log(JSON.stringify(entry, null, 2));
}

function sign() {
  const dir = process.argv[3];
  const keyFile = arg('--key');
  const id = arg('--id');
  if (!dir || !keyFile || !KEY_ID.test(id || '')) fail('usage: sign <release-dir> --key <private.pem> --id <key-id>');
  const bytes = fs.readFileSync(path.join(dir, 'release.json'));
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('release.json is not JSON'); }
  const bad = manifestError(manifest);
  if (bad) fail(`release.json: ${bad}`);
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') fail('The key must be Ed25519.');
  const signature = crypto.sign(null, bytes, key).toString('base64');
  fs.writeFileSync(path.join(dir, 'release.json.sig'), JSON.stringify({ key_id: id, signature }));
  console.log(`Signed ${manifest.version} (${Object.keys(manifest.platforms).join(', ')}) with ${id}.`);
}

const cmd = process.argv[2];
if (cmd === 'keygen') keygen();
else if (cmd === 'sign') sign();
else fail('usage: release-sign.js keygen --id <key-id> --out <dir> | sign <release-dir> --key <private.pem> --id <key-id>');
