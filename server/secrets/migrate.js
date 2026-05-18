// Boot-time auto-migration: walks ${DATA_DIR}/<userId>/{connections,bastions}.json
// and rewrites any plaintext `password` / `passphrase` / inline `privateKey`
// into `*Ref` strings backed by the SecretStore. Idempotent: records that
// already have only refs are no-ops. Files that don't exist are skipped.

const fs = require('fs');
const path = require('path');

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

// Reads a private-key file from the local FS for migration into the KMS.
// Returns `null` if the file is missing / unreadable — callers treat that
// as "leave the existing privateKeyPath alone, log a warning". This is the
// same shape as server/index.js#readPrivateKey but non-throwing so a single
// bad bastion entry doesn't abort the whole boot migration.
function tryReadKeyFile(p, log) {
  if (!p) return null;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    if (!content.trim()) {
      log(`[migrate] key file ${p}: empty, skipping`);
      return null;
    }
    return content;
  } catch (err) {
    log(`[migrate] key file ${p}: ${err.code || err.message}, skipping`);
    return null;
  }
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

    // privateKeyPath → privateKeyRef (reads the file content into the KMS,
    // then drops the path field). The file on the host stays put — the
    // operator deletes it manually once they've confirmed the migration.
    if (typeof b.privateKeyPath === 'string' && b.privateKeyPath.length > 0 && !looksLikeRef(b.privateKeyRef)) {
      const content = tryReadKeyFile(b.privateKeyPath, log);
      if (content) {
        try {
          const ref = await store.put(`bastions/${userId}/${b.id || 'unknown'}`, 'privateKey', content);
          b.privateKeyRef = ref;
          log(`[migrate] bastion ${b.id || '?'} privateKeyPath ${b.privateKeyPath} → KMS`);
          delete b.privateKeyPath;
          touched = true;
        } catch (err) {
          log(`[migrate] bastion ${b.id || '?'} privateKeyPath upload: ${err.message}`);
          throw err;
        }
      }
      // else: file unreadable — leave privateKeyPath untouched so the
      // bastion still works against the legacy file-on-disk code path
      // and the operator gets a chance to fix the mount.
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
  // privateKeyPath → privateKeyRef: read the file content on save and
  // push it to the KMS, then drop the path field so the bastion record
  // ends up ref-only.
  if (typeof out.privateKeyPath === 'string' && out.privateKeyPath.length > 0 && !looksLikeRef(out.privateKeyRef)) {
    const content = tryReadKeyFile(out.privateKeyPath, log);
    if (content) {
      out.privateKeyRef = await store.put(`bastions/${userId}/${out.id || 'unknown'}`, 'privateKey', content);
      log(`[secrets] bastion ${out.id || '?'} privateKeyPath ${out.privateKeyPath} → KMS`);
      delete out.privateKeyPath;
    }
    // else: leave the path so the request still resolves at tunnel-open
    // time; operator can fix the mount and re-save.
  }
  // Cross-tenant guard: any *Ref still on the record at this point must
  // belong to this user (forged refs from a malicious client are refused).
  rejectForeignRef('passphraseRef', out.passphraseRef, userId);
  rejectForeignRef('privateKeyRef', out.privateKeyRef, userId);
  return out;
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
  deleteOrphanedRefs,
};
