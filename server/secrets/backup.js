// Encrypted-backup helpers for the connection/bastion export + import flow.
// The dump file produced here is a real, restorable backup: every secret
// referenced by a `*Ref` in the on-disk JSON is resolved against the KMS,
// the resulting payload is encrypted with a passphrase the operator
// supplies, and the ciphertext is what lands on disk / leaves the host.
// Import does the reverse — decrypt with the same passphrase, push every
// secret back into THIS instance's KMS, write the connection / bastion
// records with the new refs.
//
// Crypto: AES-256-GCM for confidentiality + integrity, with the key
// derived from the passphrase via scrypt (N=2^15, r=8, p=1). The salt
// and IV are random per export. The format is JSON so the file is easy
// to inspect (header is plaintext; only the `ciphertext` field is opaque):
//
//   {
//     "version": 2,
//     "encrypted": true,
//     "exportedAt": "<iso>",
//     "kdf": "scrypt",
//     "kdfParams": { "N": 32768, "r": 8, "p": 1, "keyLen": 32 },
//     "cipher": "aes-256-gcm",
//     "salt": "<base64>",
//     "iv":   "<base64>",
//     "ciphertext": "<base64>",   // includes the GCM auth tag (last 16 bytes)
//     "summary": { "connections": <int>, "bastions": <int> }
//   }
//
// The legacy v1 dump (refs only, no encryption) is still understood on
// import for back-compat — it just won't restore anywhere without the
// matching KMS, same as before.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getSecretStore, looksLikeRef } = require('./index');
const { userDataPath } = require('../dataPath');

const KDF = {
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32,
  maxmem: 64 * 1024 * 1024,
};
const CIPHER = 'aes-256-gcm';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase must be a string of at least 8 characters');
  }
  return crypto.scryptSync(passphrase, salt, KDF.keyLen, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem,
  });
}

// Resolve every `*Ref` field on a connection record back to cleartext so the
// payload is self-contained. Untouched if no refs are present.
async function inlineConnectionSecrets(c, store) {
  const out = { ...c };
  if (looksLikeRef(out.passwordRef)) {
    try { out.password = await store.get(out.passwordRef); }
    catch (err) { throw new Error(`connection ${out.id || out.name || '?'}: passwordRef unresolved: ${err.message}`); }
    delete out.passwordRef;
  }
  return out;
}

async function inlineBastionSecrets(b, store) {
  const out = { ...b };
  if (looksLikeRef(out.passphraseRef)) {
    try { out.passphrase = await store.get(out.passphraseRef); }
    catch (err) { throw new Error(`bastion ${out.id || '?'}: passphraseRef unresolved: ${err.message}`); }
    delete out.passphraseRef;
  }
  if (looksLikeRef(out.privateKeyRef)) {
    try { out.privateKey = await store.get(out.privateKeyRef); }
    catch (err) { throw new Error(`bastion ${out.id || '?'}: privateKeyRef unresolved: ${err.message}`); }
    delete out.privateKeyRef;
  }
  return out;
}

// Walks the per-user data files and returns a self-contained payload
// (all secrets inlined). Used as the input to encryptBackup().
async function assembleBackupPayload(userId) {
  const store = getSecretStore();
  const connectionsFile = userDataPath(userId, 'connections.json');
  const bastionsFile = userDataPath(userId, 'bastions.json');

  let connections = [];
  try {
    const raw = JSON.parse(fs.readFileSync(connectionsFile, 'utf-8'));
    if (Array.isArray(raw.connections)) connections = raw.connections;
  } catch { /* file missing — empty list */ }

  let bastions = [];
  try {
    const raw = JSON.parse(fs.readFileSync(bastionsFile, 'utf-8'));
    if (Array.isArray(raw)) bastions = raw;
  } catch { /* file missing — empty list */ }

  const inlinedConns = [];
  for (const c of connections) inlinedConns.push(await inlineConnectionSecrets(c, store));
  const inlinedBasts = [];
  for (const b of bastions) inlinedBasts.push(await inlineBastionSecrets(b, store));

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    connections: inlinedConns,
    bastions: inlinedBasts,
  };
}

// Returns the encrypted envelope object (ready to be JSON.stringified into
// a file the operator downloads).
function encryptBackup(payload, passphrase) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Concatenate tag at the end — single base64 blob the operator can verify
  // by length (>= 16 bytes for the tag alone).
  const ctAndTag = Buffer.concat([ciphertext, tag]);
  return {
    version: 2,
    encrypted: true,
    exportedAt: payload.exportedAt,
    kdf: KDF.name,
    kdfParams: { N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen },
    cipher: CIPHER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ctAndTag.toString('base64'),
    summary: {
      connections: Array.isArray(payload.connections) ? payload.connections.length : 0,
      bastions: Array.isArray(payload.bastions) ? payload.bastions.length : 0,
    },
  };
}

function decryptBackup(envelope, passphrase) {
  if (!envelope || envelope.encrypted !== true) {
    throw new Error('backup envelope is not encrypted (version 1) — load it via the legacy import path');
  }
  if (envelope.cipher !== CIPHER) {
    throw new Error(`unsupported cipher: ${envelope.cipher}`);
  }
  if (envelope.kdf !== KDF.name) {
    throw new Error(`unsupported KDF: ${envelope.kdf}`);
  }
  let salt, iv, ctAndTag;
  try {
    salt = Buffer.from(envelope.salt, 'base64');
    iv = Buffer.from(envelope.iv, 'base64');
    ctAndTag = Buffer.from(envelope.ciphertext, 'base64');
  } catch {
    throw new Error('malformed backup envelope (salt/iv/ciphertext not base64)');
  }
  if (ctAndTag.length < TAG_BYTES + 1) {
    throw new Error('malformed backup envelope (ciphertext too short)');
  }
  const ct = ctAndTag.slice(0, ctAndTag.length - TAG_BYTES);
  const tag = ctAndTag.slice(ctAndTag.length - TAG_BYTES);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new Error('decryption failed — wrong passphrase or corrupted file');
  }
  let payload;
  try { payload = JSON.parse(plaintext.toString('utf-8')); }
  catch (err) { throw new Error(`decrypted blob is not valid JSON: ${err.message}`); }
  return payload;
}

// Merge-by-id of an imported payload into the on-disk state. For each
// incoming connection / bastion: push its inlined secrets into the local
// KMS, replace them with the new refs, and overwrite or append in the
// per-user JSON files.
async function applyImportPayload(userId, payload, log = () => {}) {
  const store = getSecretStore();
  const importedConns = Array.isArray(payload.connections) ? payload.connections : [];
  const importedBasts = Array.isArray(payload.bastions) ? payload.bastions : [];

  // Re-push every inlined secret. This is the inverse of inline*Secrets.
  const newConns = [];
  for (const c of importedConns) {
    const out = { ...c };
    if (typeof out.password === 'string' && out.password.length > 0) {
      out.passwordRef = await store.put(`connections/${userId}`, out.id || 'unknown', out.password);
    }
    delete out.password;
    newConns.push(out);
  }
  const newBasts = [];
  for (const b of importedBasts) {
    const out = { ...b };
    if (typeof out.passphrase === 'string' && out.passphrase.length > 0) {
      out.passphraseRef = await store.put(`bastions/${userId}/${out.id || 'unknown'}`, 'passphrase', out.passphrase);
    }
    delete out.passphrase;
    if (typeof out.privateKey === 'string' && out.privateKey.length > 0) {
      out.privateKeyRef = await store.put(`bastions/${userId}/${out.id || 'unknown'}`, 'privateKey', out.privateKey);
    }
    delete out.privateKey;
    // Disk-key support removed: a privateKeyPath in an old backup is dropped.
    if (typeof out.privateKeyPath === 'string' && out.privateKeyPath.length > 0 && !looksLikeRef(out.privateKeyRef)) {
      log(`[import] bastion ${out.id || '?'}: privateKeyPath ${out.privateKeyPath} dropped (disk keys no longer supported)`);
    }
    delete out.privateKeyPath;
    newBasts.push(out);
  }

  // Merge into existing files by id.
  const connectionsFile = userDataPath(userId, 'connections.json');
  const bastionsFile = userDataPath(userId, 'bastions.json');

  let existingConns = [];
  try {
    const raw = JSON.parse(fs.readFileSync(connectionsFile, 'utf-8'));
    if (Array.isArray(raw.connections)) existingConns = raw.connections;
  } catch { /* missing */ }
  let existingBasts = [];
  try {
    const raw = JSON.parse(fs.readFileSync(bastionsFile, 'utf-8'));
    if (Array.isArray(raw)) existingBasts = raw;
  } catch { /* missing */ }

  const mergedConns = mergeById(existingConns, newConns);
  const mergedBasts = mergeById(existingBasts, newBasts);

  fs.mkdirSync(path.dirname(connectionsFile), { recursive: true });
  fs.writeFileSync(connectionsFile, JSON.stringify({ connections: mergedConns }, null, 2));
  fs.writeFileSync(bastionsFile, JSON.stringify(mergedBasts, null, 2));

  return {
    importedConnections: newConns.length,
    importedBastions: newBasts.length,
    totalConnections: mergedConns.length,
    totalBastions: mergedBasts.length,
  };
}

function mergeById(current, incoming) {
  const byId = new Map(current.map((x) => [x.id, x]));
  for (const item of incoming) {
    const copy = { ...item };
    if (!copy.id) copy.id = crypto.randomUUID();
    byId.set(copy.id, copy);
  }
  return Array.from(byId.values());
}

module.exports = {
  assembleBackupPayload,
  encryptBackup,
  decryptBackup,
  applyImportPayload,
};
