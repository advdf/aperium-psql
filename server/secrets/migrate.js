// Boot-time auto-migration: walks ${DATA_DIR}/<userId>/{connections,bastions}.json
// and rewrites any plaintext `password` / `passphrase` / inline `privateKey`
// into `*Ref` strings backed by the SecretStore. Idempotent: records that
// already have only refs are no-ops. Files that don't exist are skipped.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getSecretStore, looksLikeRef, refBelongsTo } = require('./index');

// Reject any user-scoped `*Ref` that doesn't belong to `userId`. Used by
// the sanitize helpers below so a malicious client can't ship a forged
// ref pointing at another user's secret. The throw produces a 500 from
// the PUT handler — explicit "this is not your secret" rather than a
// silent drop, so misuses surface in the audit log.
function rejectForeignRef(field, ref, userId) {
  if (!looksLikeRef(ref)) return;
  if (refBelongsTo(ref, userId)) return;
  throw new Error(`refused ${field} scoped to a different user: ${String(ref).slice(0, 60)}…`);
}

function isUuidLikeDir(name) {
  // Per-user dirs are named after the postgres UUID PK of aperium.users.
  // Anything that doesn't look like a UUID is skipped (e.g. legacy `pg/`).
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(name);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function migrateConnectionsFile(file, userId, store, log) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return { migrated: 0, skipped: 0 };
  const list = Array.isArray(raw.connections) ? raw.connections : [];
  let migrated = 0;
  let skipped = 0;
  let strippedAnyEmpty = false;
  for (const c of list) {
    if (typeof c.password === 'string' && c.password.length > 0) {
      try {
        const ref = await store.put(`connections/${userId}`, c.id || 'unknown', c.password);
        c.passwordRef = ref;
        delete c.password;
        migrated++;
      } catch (err) {
        log(`[migrate] connections ${c.id || '?'}: ${err.message}`);
        throw err;
      }
    } else if ('password' in c) {
      delete c.password;
      strippedAnyEmpty = true;
      skipped++;
    } else {
      skipped++;
    }
  }
  if (migrated > 0 || strippedAnyEmpty) writeJson(file, raw);
  return { migrated, skipped };
}

async function migrateBastionsFile(file, userId, store, log) {
  const list = readJson(file);
  if (!Array.isArray(list)) return { migrated: 0, skipped: 0 };
  let migrated = 0;
  let skipped = 0;
  // The cleanup pass also strips empty `passphrase: ""` / `privateKey: ""`
  // strings left from the pre-KMS schema, so the file converges to the
  // ref-only shape even when bastions had no passphrase set.
  let strippedAnyEmpty = false;
  for (const b of list) {
    let touched = false;

    // passphrase → passphraseRef
    if (typeof b.passphrase === 'string' && b.passphrase.length > 0) {
      try {
        const ref = await store.put(`bastions/${userId}/${b.id || 'unknown'}`, 'passphrase', b.passphrase);
        b.passphraseRef = ref;
        delete b.passphrase;
        touched = true;
      } catch (err) {
        log(`[migrate] bastion ${b.id || '?'} passphrase: ${err.message}`);
        throw err;
      }
    } else if ('passphrase' in b) {
      delete b.passphrase;
      strippedAnyEmpty = true;
    }

    // legacy inline privateKey → privateKeyRef
    if (typeof b.privateKey === 'string' && b.privateKey.length > 0) {
      try {
        const ref = await store.put(`bastions/${userId}/${b.id || 'unknown'}`, 'privateKey', b.privateKey);
        b.privateKeyRef = ref;
        delete b.privateKey;
        touched = true;
      } catch (err) {
        log(`[migrate] bastion ${b.id || '?'} privateKey: ${err.message}`);
        throw err;
      }
    } else if ('privateKey' in b) {
      delete b.privateKey;
      strippedAnyEmpty = true;
    }

    // Stale privateKeyPath fields are stripped (disk-key support removed).
    if ('privateKeyPath' in b) {
      delete b.privateKeyPath;
      strippedAnyEmpty = true;
    }

    if (touched) migrated++; else skipped++;
  }
  if (migrated > 0 || strippedAnyEmpty) writeJson(file, list);
  return { migrated, skipped };
}

async function migrateForUser(dataDir, userId, log) {
  const store = getSecretStore();
  const connFile = path.join(dataDir, userId, 'connections.json');
  const bastFile = path.join(dataDir, userId, 'bastions.json');
  let summaryParts = [];
  if (fs.existsSync(connFile)) {
    const r = await migrateConnectionsFile(connFile, userId, store, log);
    if (r.migrated > 0 || r.skipped > 0) {
      summaryParts.push(`connections: ${r.migrated} migrated, ${r.skipped} already-clean`);
    }
  }
  if (fs.existsSync(bastFile)) {
    const r = await migrateBastionsFile(bastFile, userId, store, log);
    if (r.migrated > 0 || r.skipped > 0) {
      summaryParts.push(`bastions: ${r.migrated} migrated, ${r.skipped} already-clean`);
    }
  }
  if (summaryParts.length > 0) {
    log(`[migrate] user=${userId} ${summaryParts.join('; ')}`);
  }
}

async function runUserMigration(dataDir, log) {
  let entries = [];
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }); }
  catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!isUuidLikeDir(ent.name)) continue;
    await migrateForUser(dataDir, ent.name, log);
  }
}

// Sanitize a single record (connection or bastion) on write: if cleartext is
// present, push to KMS and replace with a ref. Used by PUT /api/connections
// and PUT /api/bastions so new entries never persist plaintext to disk.
async function sanitizeConnectionForWrite(c, userId, store) {
  const out = { ...c };
  if (typeof out.password === 'string' && out.password.length > 0 && !looksLikeRef(out.password)) {
    out.passwordRef = await store.put(`connections/${userId}`, out.id || 'unknown', out.password);
  }
  // If the client kept a stale passwordRef but no password, that's fine —
  // as long as the ref belongs to this user. A forged ref pointing at
  // another user's secret is refused outright.
  delete out.password;
  rejectForeignRef('passwordRef', out.passwordRef, userId);

  // Two orthogonal dimensions, each with its own whitelist.
  // terminalMode: 'shell' = open an SSH shell on a hop instead of psql.
  if (out.terminalMode !== 'shell') {
    delete out.terminalMode;
    delete out.shellHopIndex;
  } else if (!Number.isInteger(out.shellHopIndex) || out.shellHopIndex < 0) {
    delete out.shellHopIndex;
  }
  // psqlMode: 'peer' = run psql via Unix socket on a hop instead of TCP.
  if (out.psqlMode !== 'peer') {
    delete out.psqlMode;
    delete out.peerHopIndex;
    delete out.peerOsUser;
    delete out.peerSudo;
  } else {
    if (!Number.isInteger(out.peerHopIndex) || out.peerHopIndex < 0) delete out.peerHopIndex;
    if (typeof out.peerOsUser !== 'string' || !out.peerOsUser) delete out.peerOsUser;
    out.peerSudo = !!out.peerSudo;
  }
  return out;
}

async function sanitizeBastionForWrite(b, userId, store, log = () => {}) {
  const out = { ...b };
  if (typeof out.passphrase === 'string' && out.passphrase.length > 0 && !looksLikeRef(out.passphrase)) {
    out.passphraseRef = await store.put(`bastions/${userId}/${out.id || 'unknown'}`, 'passphrase', out.passphrase);
  }
  delete out.passphrase;
  if (typeof out.privateKey === 'string' && out.privateKey.length > 0 && !looksLikeRef(out.privateKey)) {
    out.privateKeyRef = await store.put(`bastions/${userId}/${out.id || 'unknown'}`, 'privateKey', out.privateKey);
  }
  delete out.privateKey;
  // Disk-key support has been removed: never persist privateKeyPath.
  delete out.privateKeyPath;
  // Cross-tenant guard: any *Ref still on the record at this point must
  // belong to this user (forged refs from a malicious client are refused).
  rejectForeignRef('passphraseRef', out.passphraseRef, userId);
  rejectForeignRef('privateKeyRef', out.privateKeyRef, userId);
  return out;
}

// Deduplicate private keys across the inbound bastion list and any keys
// already in the KMS for this user. Rewrites `bastions` IN PLACE so the
// subsequent sanitize pass sees only canonical refs.
//
// Rules:
//   - A fresh upload (`b.privateKey` carries raw PEM text) whose
//     SHA-256 hash matches a ref already in the KMS is REPLACED by the
//     existing canonical ref; the raw upload is dropped so sanitize
//     doesn't create a second KMS entry for the same bytes.
//   - When the hash is new, we `store.put` the bytes ourselves so the
//     freshly-created ref can serve as the canonical for any sibling
//     entry in the same payload that uploads the same key.
//   - An existing `b.privateKeyRef` whose resolved content matches a
//     canonical ref (the first ref seen for that hash, taken from the
//     OLD on-disk list to maximise stability of identifiers) is
//     rewritten to the canonical ref. `deleteOrphanedRefs` then prunes
//     the now-unused dupes at the end of the PUT flow.
//
// Best-effort: KMS resolution failures are logged and the affected ref
// is left alone. Refs scoped to other users are skipped entirely.
async function dedupBastionKeys(bastions, oldList, userId, store, log = () => {}) {
  const hashByRef = new Map();
  const canonByHash = new Map();

  for (const old of oldList) {
    const ref = old && old.privateKeyRef;
    if (typeof ref !== 'string') continue;
    if (!refBelongsTo(ref, userId)) continue;
    if (hashByRef.has(ref)) continue;
    try {
      const content = await store.get(ref);
      const h = crypto.createHash('sha256').update(content).digest('hex');
      hashByRef.set(ref, h);
      if (!canonByHash.has(h)) canonByHash.set(h, ref);
    } catch (err) {
      log(`[dedup] could not resolve ${ref.slice(0, 40)}: ${err.message}`);
    }
  }

  for (const b of bastions) {
    if (!b || typeof b !== 'object') continue;

    if (typeof b.privateKey === 'string' && b.privateKey.length > 0 && !looksLikeRef(b.privateKey)) {
      const h = crypto.createHash('sha256').update(b.privateKey).digest('hex');
      if (!canonByHash.has(h)) {
        const newRef = await store.put(`bastions/${userId}/${b.id || 'unknown'}`, 'privateKey', b.privateKey);
        canonByHash.set(h, newRef);
        hashByRef.set(newRef, h);
      }
      b.privateKeyRef = canonByHash.get(h);
      delete b.privateKey;
      continue;
    }

    if (typeof b.privateKeyRef !== 'string') continue;
    if (!refBelongsTo(b.privateKeyRef, userId)) continue;
    let h = hashByRef.get(b.privateKeyRef);
    if (!h) {
      // Ref isn't in the old list (e.g. the client supplied a ref
      // borrowed from another bastion via the reuse picker before the
      // server-side list refreshed). Resolve it now so we can still
      // canonicalize.
      try {
        const content = await store.get(b.privateKeyRef);
        h = crypto.createHash('sha256').update(content).digest('hex');
        hashByRef.set(b.privateKeyRef, h);
        if (!canonByHash.has(h)) canonByHash.set(h, b.privateKeyRef);
      } catch (err) {
        log(`[dedup] could not resolve inbound ${b.privateKeyRef.slice(0, 40)}: ${err.message}`);
        continue;
      }
    }
    const can = canonByHash.get(h);
    if (can && can !== b.privateKeyRef) b.privateKeyRef = can;
  }
}

// Best-effort cleanup of orphaned refs when a record is replaced/deleted.
async function deleteOrphanedRefs(oldList, newList, refFields, store, log) {
  const stillUsed = new Set();
  for (const item of newList) {
    for (const f of refFields) {
      if (item && typeof item[f] === 'string') stillUsed.add(item[f]);
    }
  }
  for (const old of oldList) {
    for (const f of refFields) {
      const ref = old && old[f];
      if (typeof ref !== 'string' || !looksLikeRef(ref)) continue;
      if (stillUsed.has(ref)) continue;
      try { await store.delete(ref); }
      catch (err) { log(`[secrets] failed to delete orphaned ref ${ref.slice(0, 40)}: ${err.message}`); }
    }
  }
}

module.exports = {
  runUserMigration,
  migrateForUser,
  sanitizeConnectionForWrite,
  sanitizeBastionForWrite,
  dedupBastionKeys,
  deleteOrphanedRefs,
};
