// Encrypted export + re-import test into a throwaway user.
// Writes the export to <data>/exports/, then decrypts it, imports it into a
// temporary user, compares every field and secret with the original and
// cleans the temporary user up. The real user's data is never modified.
// Usage (inside the aperium container):
//   BACKUP_PASSPHRASE=... node - <user-id> < backup-roundtrip.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assembleBackupPayload, encryptBackup, decryptBackup, applyImportPayload } = require('/app/server/secrets/backup');
const { getSecretStore } = require('/app/server/secrets');
const { DATA_DIR } = require('/app/server/dataPath');

const SECRET_FIELDS = { bastion: ['privateKey', 'passphrase'], connection: ['password'] };
const REF_OF = { privateKey: 'privateKeyRef', passphrase: 'passphraseRef', password: 'passwordRef' };

function strip(o, fields) {
  const out = { ...o };
  for (const f of fields) { delete out[f]; delete out[REF_OF[f]]; }
  return JSON.stringify(out, Object.keys(out).sort());
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

(async () => {
  const userId = process.argv[2];
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!userId) throw new Error('missing user id');
  if (!pass || pass.length < 8) throw new Error('BACKUP_PASSPHRASE must be at least 8 characters');
  const store = getSecretStore();

  // 1. Export
  const payload = await assembleBackupPayload(userId);
  const envelope = encryptBackup(payload, pass);
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `aperium-export-${payload.exportedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  console.log(`export: ${file} (${envelope.summary.bastions} bastions, ${envelope.summary.connections} connections)`);

  // 2. Read back from disk + decrypt
  const reread = decryptBackup(JSON.parse(fs.readFileSync(file, 'utf-8')), pass);
  try { decryptBackup(JSON.parse(fs.readFileSync(file, 'utf-8')), pass + 'x'); throw new Error('wrong passphrase was accepted'); }
  catch (e) { if (!/decryption failed/.test(e.message)) throw e; }
  console.log('decrypt: ok (and a wrong passphrase is rejected)');

  // 3. Re-import into a throwaway user
  const testUser = `roundtrip-test-${crypto.randomUUID()}`;
  const created = [];
  let errors = 0;
  try {
    const counts = await applyImportPayload(testUser, reread);
    console.log(`re-import (test user): ${counts.importedBastions} bastions, ${counts.importedConnections} connections`);
    const tb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, testUser, 'bastions.json'), 'utf-8'));
    const tc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, testUser, 'connections.json'), 'utf-8')).connections;
    for (const x of tb) for (const f of ['privateKeyRef', 'passphraseRef']) if (x[f]) created.push(x[f]);
    for (const x of tc) if (x.passwordRef) created.push(x.passwordRef);

    // 4. Compare with the original
    const check = async (kind, orig, imported) => {
      const byId = new Map(imported.map((x) => [x.id, x]));
      if (imported.length !== orig.length) { errors++; console.log(`ERROR ${kind}: expected ${orig.length}, re-imported ${imported.length}`); }
      let secrets = 0;
      for (const o of orig) {
        const n = byId.get(o.id);
        if (!n) { errors++; console.log(`ERROR ${kind} ${o.name}: missing`); continue; }
        if (strip(o, SECRET_FIELDS[kind]) !== strip(n, SECRET_FIELDS[kind])) { errors++; console.log(`ERROR ${kind} ${o.name}: fields differ`); }
        for (const f of SECRET_FIELDS[kind]) {
          if (!o[f]) { if (n[REF_OF[f]]) { errors++; console.log(`ERROR ${kind} ${o.name}: unexpected ${f}`); } continue; }
          const v = n[REF_OF[f]] ? await store.get(n[REF_OF[f]]) : null;
          if (v !== o[f]) { errors++; console.log(`ERROR ${kind} ${o.name}: ${f} differs`); } else secrets++;
        }
      }
      console.log(`${kind}: ${orig.length} compared, ${secrets} secrets identical`);
    };
    await check('bastion', payload.bastions, tb);
    await check('connection', payload.connections, tc);
    const keys = new Set(payload.bastions.map((b) => b.privateKey && sha(b.privateKey)).filter(Boolean));
    const pps = payload.bastions.filter((b) => b.passphrase).length;
    console.log(`content: ${keys.size} distinct SSH keys, ${pps} bastions with a passphrase`);
  } finally {
    // 5. Clean the throwaway user up
    for (const r of created) { try { await store.delete(r); } catch (e) { console.log(`cleanup: ${e.message}`); } }
    fs.rmSync(path.join(DATA_DIR, testUser), { recursive: true, force: true });
    console.log(`cleanup: ${created.length} test secrets deleted, ${testUser} directory removed`);
  }
  console.log(errors ? `FAILED: ${errors} error(s)` : 'RESULT: export and re-import OK');
  process.exit(errors ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
