const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { openTunnelChain, openSshShell, openSshExec } = require('./ssh-tunnel');
const { pool, initSchema } = require('./db');
const { userDataPath, DATA_DIR: USER_DATA_DIR } = require('./dataPath');
const requireAuth = require('./middleware/requireAuth');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const {
  getSecretStore,
  looksLikeRef,
  refBelongsTo,
  resolveBootSecret,
} = require('./secrets');
const {
  runUserMigration,
  sanitizeConnectionForWrite,
  sanitizeBastionForWrite,
  dedupBastionKeys,
  deleteOrphanedRefs,
} = require('./secrets/migrate');
const {
  assembleBackupPayload,
  encryptBackup,
  decryptBackup,
  applyImportPayload,
} = require('./secrets/backup');

function loadBastions(userId) {
  const file = userDataPath(userId, 'bastions.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return []; }
}

// Per-user mapping of SHA-256(key content) → display name. Lets the
// operator give a memorable label ("support@chabichou") to a key that
// is referenced by N bastions through N independent refs. Storage is a
// flat JSON object on disk; the hash is opaque to the client.
function loadKeyNames(userId) {
  const file = userDataPath(userId, 'keys.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function saveKeyNames(userId, map) {
  const file = userDataPath(userId, 'keys.json');
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

async function resolveBastionCreds(source, ctx, userId) {
  if (!source || !source.host || !source.user) {
    throw new Error(`${ctx}: host and user are required`);
  }
  const store = getSecretStore();
  if (!looksLikeRef(source.privateKeyRef)) {
    throw new Error(`${ctx} (${source.host}): privateKeyRef is required`);
  }
  if (!refBelongsTo(source.privateKeyRef, userId)) {
    throw new Error(`${ctx} (${source.host}): privateKeyRef does not belong to this user`);
  }
  let privateKey;
  try { privateKey = await store.get(source.privateKeyRef); }
  catch (err) { throw new Error(`${ctx} (${source.host}): privateKeyRef ${source.privateKeyRef.slice(0, 40)}…: ${err.message}`); }
  let passphrase;
  if (looksLikeRef(source.passphraseRef)) {
    if (!refBelongsTo(source.passphraseRef, userId)) {
      throw new Error(`${ctx} (${source.host}): passphraseRef does not belong to this user`);
    }
    try { passphrase = await store.get(source.passphraseRef); }
    catch (err) { throw new Error(`${ctx} (${source.host}): passphraseRef: ${err.message}`); }
  }
  return {
    host: source.host,
    port: source.port,
    user: source.user,
    privateKey,
    passphrase,
  };
}

async function resolveHops(hops, userId) {
  const bastions = loadBastions(userId);
  const byId = new Map(bastions.map((b) => [b.id, b]));
  const out = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const ctx = `hop ${i + 1}`;
    const source = hop && hop.bastionId ? byId.get(hop.bastionId) : hop;
    if (hop && hop.bastionId && !source) {
      throw new Error(`${ctx}: bastion ${hop.bastionId} not found`);
    }
    out.push(await resolveBastionCreds(source, ctx, userId));
  }
  return out;
}

async function maybeOpenTunnel(connection, userId) {
  const t = connection && connection.tunnel;
  if (!t || !t.enabled || !Array.isArray(t.hops) || t.hops.length === 0) return null;
  const resolved = await resolveHops(t.hops, userId);
  return openTunnelChain({
    hops: resolved,
    dbHost: connection.host,
    dbPort: Number(connection.port) || 5432,
  });
}

const DATA_DIR = process.env.APERIUM_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PSQL_CANDIDATE_PATHS = ['/usr/bin/psql', '/usr/local/bin/psql'];
function findPsqlBin() {
  return PSQL_CANDIDATE_PATHS.find((p) => fs.existsSync(p)) || 'psql';
}

const logFile = path.join(DATA_DIR, 'aperium.log');
function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ')}\n`;
  try { fs.appendFileSync(logFile, msg); } catch {}
  console.log(...args);
}
log('=== Server starting ===');
log('DATA_DIR:', DATA_DIR);
log('psql binary:', findPsqlBin());

function storeGet(file, key, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8'))[key] ?? fallback; }
  catch { return fallback; }
}
function storeSet(file, key, value) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  data[key] = value;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

function buildPsqlArgs(connection) {
  const args = [];
  if (connection.host) args.push('-h', connection.host);
  if (connection.port) args.push('-p', String(connection.port));
  if (connection.user) args.push('-U', connection.user);
  if (connection.database) args.push('-d', connection.database);
  return args;
}

// Resolves the connection's password from the KMS (via passwordRef) and
// returns an env object for spawning psql. Connections with no password
// at all are fine (e.g. peer-auth Postgres on the same host).
//
// The userId guard is defense-in-depth: sanitizeConnectionForWrite already
// refuses to persist a foreign-user ref, but the runtime check ensures a
// record that reached disk through any other path (manual edit, race,
// future code that bypasses sanitize) cannot leak another user's secret.
async function buildPsqlEnv(connection, userId) {
  const env = { ...process.env };
  if (looksLikeRef(connection.passwordRef)) {
    if (!refBelongsTo(connection.passwordRef, userId)) {
      throw new Error('passwordRef does not belong to this user');
    }
    try {
      env.PGPASSWORD = await getSecretStore().get(connection.passwordRef);
    } catch (err) {
      throw new Error(`passwordRef ${connection.passwordRef.slice(0, 40)}…: ${err.message}`);
    }
  }
  if (connection.sslmode) env.PGSSLMODE = connection.sslmode;
  return env;
}

// Peer mode: we run `psql` over SSH on a chosen hop. The command is
// concatenated into a shell string for `client.exec`, so every identifier we
// inject MUST be on a strict POSIX whitelist — no quoting saves us once a
// rogue value reaches `sh -c`.
function safePeerIdent(s, field) {
  if (typeof s !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(s)) {
    throw new Error(`peer ${field}: unsafe value ${JSON.stringify(s)} (allowed: ^[a-zA-Z_][a-zA-Z0-9_-]*$)`);
  }
  return s;
}

function buildPeerCommand({ sshUser, peerOsUser, peerSudo, pgUser, database, csv }) {
  const parts = ['psql', '-w', '--no-psqlrc'];
  if (csv) parts.push('-X', '--csv');
  if (pgUser) parts.push('-U', safePeerIdent(pgUser, 'pgUser'));
  if (database) parts.push('-d', safePeerIdent(database, 'database'));
  let cmd = parts.join(' ');
  const needSudo = peerSudo && peerOsUser && peerOsUser !== sshUser;
  if (needSudo) cmd = `sudo -niu ${safePeerIdent(peerOsUser, 'peerOsUser')} -- ${cmd}`;
  return cmd;
}

async function resolvePeerTarget(connection, userId) {
  const rawHops = connection && connection.tunnel && connection.tunnel.hops;
  if (!Array.isArray(rawHops) || rawHops.length === 0) {
    throw new Error('peer mode requires at least one SSH hop');
  }
  const hops = await resolveHops(rawHops, userId);
  const idx = Number.isInteger(connection.peerHopIndex)
    ? connection.peerHopIndex
    : hops.length - 1;
  if (idx < 0 || idx >= hops.length) {
    throw new Error(`peer hop index out of range: ${idx} (chain has ${hops.length} hop(s))`);
  }
  return { hops, targetHopIndex: idx, sshUser: hops[idx].user };
}

const runningQueries = new Map();

const app = express();
app.use(express.json({ limit: '10mb' }));

const ROOT = path.join(__dirname, '..');
app.use('/static/dist', express.static(path.join(ROOT, 'dist')));
app.use('/static/assets', express.static(path.join(ROOT, 'assets')));
app.use('/static/src', express.static(path.join(ROOT, 'src')));
app.use('/static/node_modules', express.static(path.join(ROOT, 'node_modules')));

// Session middleware can't be built at module load — the secret has to be
// resolved from the KMS first (see main()). To keep the route registration
// below in the correct order (session-before-routes), we register a tiny
// shim that delegates to `sessionMiddleware` once main() has wired it.
// Requests that arrive before startup completes get a 503.
let sessionMiddleware = null;
app.use((req, res, next) => {
  if (!sessionMiddleware) {
    return res.status(503).json({ error: 'Server is still starting, retry in a moment.' });
  }
  return sessionMiddleware(req, res, next);
});

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

// Public routes — no auth required
app.get('/', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.sendFile(path.join(ROOT, 'src', 'index.html'));
});
app.get('/login', (_req, res) => res.sendFile(path.join(ROOT, 'src', 'login.html')));

app.use('/api/auth', authRouter);
app.use('/api/profile', requireAuth, profileRouter);
app.use('/api/', requireAuth);

app.get('/api/connections', (req, res) => {
  const file = userDataPath(req.session.userId, 'connections.json');
  res.json(storeGet(file, 'connections', []));
});

app.put('/api/connections', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
  const userId = req.session.userId;
  const file = userDataPath(req.session.userId, 'connections.json');
  const store = getSecretStore();
  try {
    const oldList = storeGet(file, 'connections', []);
    const sanitized = [];
    for (const c of req.body) sanitized.push(await sanitizeConnectionForWrite(c, userId, store));
    storeSet(file, 'connections', sanitized);
    await deleteOrphanedRefs(oldList, sanitized, ['passwordRef'], store, log);
    res.json({ ok: true });
  } catch (err) {
    log('PUT /api/connections error:', err.message);
    res.status(500).json({ error: `Failed to save connections: ${err.message}` });
  }
});

app.get('/api/snippets', (req, res) => {
  const file = userDataPath(req.session.userId, 'snippets.json');
  try { res.json(JSON.parse(fs.readFileSync(file, 'utf-8'))); }
  catch { res.json(null); }
});

app.put('/api/snippets', (req, res) => {
  const file = userDataPath(req.session.userId, 'snippets.json');
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.get('/api/bastions', (req, res) => {
  res.json(loadBastions(req.session.userId));
});

// List the user's distinct private keys, deduplicated by SHA-256 of the
// raw content stored in the KMS. Used by the bastion editor to offer
// "reuse a key" instead of forcing the operator to upload the same file
// for every bastion that authenticates with the same identity. Each
// entry exposes ONE existing `privateKeyRef` (the first bastion's) so
// the new bastion can just point at it — refs are safe to share across
// the same user's bastions (cross-tenant guard only checks userId).
//
// We never return the key bytes themselves. The hash is opaque to the
// client; bastion names let the operator recognise which group of
// bastions a key belongs to.
app.get('/api/bastion-keys', async (req, res) => {
  const userId = req.session.userId;
  const bastions = loadBastions(userId);
  const names = loadKeyNames(userId);
  const store = getSecretStore();
  const byHash = new Map();
  for (const b of bastions) {
    if (typeof b.privateKeyRef !== 'string') continue;
    if (!refBelongsTo(b.privateKeyRef, userId)) continue;
    let content;
    try { content = await store.get(b.privateKeyRef); }
    catch (err) {
      log('GET /api/bastion-keys: skipping', b.privateKeyRef.slice(0, 40), err.message);
      continue;
    }
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    let entry = byHash.get(hash);
    if (!entry) {
      entry = {
        id: hash,
        name: typeof names[hash] === 'string' ? names[hash] : '',
        privateKeyRef: b.privateKeyRef,
        passphraseRef: typeof b.passphraseRef === 'string' ? b.passphraseRef : null,
        bastionIds: [],
        bastionNames: [],
      };
      byHash.set(hash, entry);
    }
    entry.bastionIds.push(b.id);
    entry.bastionNames.push(b.name || b.host || b.id);
  }
  res.json([...byHash.values()]);
});

// Rename a key (or clear its name with an empty string). The hash
// itself is the identifier — clients receive it from
// GET /api/bastion-keys. We don't verify the hash actually matches a
// resolvable key on disk: orphan entries cost nothing and may resync
// after a future upload.
app.patch('/api/bastion-keys/:hash', (req, res) => {
  const userId = req.session.userId;
  const { hash } = req.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return res.status(400).json({ error: 'hash must be a 64-char hex SHA-256' });
  }
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const names = loadKeyNames(userId);
  if (name) names[hash] = name; else delete names[hash];
  saveKeyNames(userId, names);
  res.json({ ok: true });
});

app.get('/api/psql-meta', (_req, res) => {
  res.type('application/json').sendFile(path.join(__dirname, 'psql-meta.json'));
});

app.put('/api/bastions', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
  const userId = req.session.userId;
  const file = userDataPath(userId, 'bastions.json');
  const store = getSecretStore();
  try {
    const oldList = loadBastions(userId);
    // Collapse fresh uploads and existing duplicate refs to one canonical
    // ref per distinct key content BEFORE sanitize so we don't multiply
    // KMS entries. `deleteOrphanedRefs` at the end will then prune the
    // refs that are no longer referenced by any bastion.
    await dedupBastionKeys(req.body, oldList, userId, store, log);
    const sanitized = [];
    for (const b of req.body) sanitized.push(await sanitizeBastionForWrite(b, userId, store, log));
    fs.writeFileSync(file, JSON.stringify(sanitized, null, 2));
    await deleteOrphanedRefs(oldList, sanitized, ['passphraseRef', 'privateKeyRef'], store, log);
    res.json({ ok: true });
  } catch (err) {
    log('PUT /api/bastions error:', err.message);
    res.status(500).json({ error: `Failed to save bastions: ${err.message}` });
  }
});

// Encrypted backup: resolves every *Ref to its cleartext in the KMS,
// encrypts the resulting payload with the operator's passphrase, returns
// the envelope. The client downloads it as JSON or YAML.
app.post('/api/backup/export', async (req, res) => {
  const { passphrase } = req.body || {};
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    return res.status(400).json({ error: 'passphrase must be a string of at least 8 characters' });
  }
  try {
    const payload = await assembleBackupPayload(req.session.userId);
    const envelope = encryptBackup(payload, passphrase);
    res.json(envelope);
  } catch (err) {
    log('POST /api/backup/export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Decrypts an envelope with the operator's passphrase, then re-pushes each
// secret into THIS instance's KMS and merges the resulting refs into
// connections.json / bastions.json by id.
app.post('/api/backup/import', async (req, res) => {
  const { envelope, passphrase } = req.body || {};
  if (!envelope || typeof envelope !== 'object') {
    return res.status(400).json({ error: 'envelope is required' });
  }
  if (envelope.encrypted === true && (typeof passphrase !== 'string' || passphrase.length === 0)) {
    return res.status(400).json({ error: 'passphrase is required for encrypted backups' });
  }
  try {
    let payload;
    if (envelope.encrypted === true) {
      payload = decryptBackup(envelope, passphrase);
    } else {
      // Legacy v1 envelope (`{ version: 1, connections, bastions }`) — refs
      // only, no secrets to re-push. Save as-is; the operator gets the
      // shells but will have to retype passwords. Same behavior as the old
      // client-side merge.
      payload = envelope;
    }
    const counts = await applyImportPayload(req.session.userId, payload, log);
    res.json({ ok: true, ...counts });
  } catch (err) {
    log('POST /api/backup/import error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

function buildQueryResponse({ stdout, stderr, code, cancelled, isMeta, duration }) {
  if (cancelled) return { error: 'Query cancelled', duration, cancelled: true };
  if (code !== 0) return { error: stderr.trim() || `psql exited with code ${code}`, duration };
  if (isMeta) {
    return { isMetacommand: true, raw: stdout, stderr: stderr.trim() || null, duration };
  }
  try {
    const lines = stdout.trim().split('\n');
    if (lines.length === 0 || !lines[0]) {
      return { message: stderr || 'Query executed successfully.', duration };
    }
    const columns = parseCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim()) rows.push(parseCSVLine(lines[i]));
    }
    return { columns, rows, rowCount: rows.length, duration, notice: stderr || null };
  } catch {
    return { message: stdout.trim() || stderr.trim() || 'Done.', duration };
  }
}

async function executePeerQuery({ connection, trimmedQuery, isMeta, queryId, userId, startTime, res }) {
  let target;
  try { target = await resolvePeerTarget(connection, userId); }
  catch (err) {
    log('executeQuery peer setup error:', err.message);
    return res.json({ error: err.message, duration: Date.now() - startTime });
  }

  let command;
  try {
    command = buildPeerCommand({
      sshUser: target.sshUser,
      peerOsUser: connection.peerOsUser,
      peerSudo: !!connection.peerSudo,
      pgUser: connection.user,
      database: connection.database,
      csv: !isMeta,
    });
  } catch (err) {
    log('executeQuery peer command error:', err.message);
    return res.json({ error: err.message, duration: Date.now() - startTime });
  }

  let sshExec;
  try {
    sshExec = await openSshExec({ hops: target.hops, targetHopIndex: target.targetHopIndex, command, pty: false });
  } catch (err) {
    log('executeQuery peer SSH error:', err.message);
    return res.json({ error: `SSH: ${err.message}`, duration: Date.now() - startTime });
  }

  log('executeQuery (peer) hop:', target.targetHopIndex + 1, '/', target.hops.length, 'queryId:', queryId, isMeta ? '(meta)' : '');

  let cancelled = false;
  let responded = false;
  if (queryId) runningQueries.set(queryId, { kill: () => { cancelled = true; try { sshExec.close(); } catch {} } });

  let stdout = '';
  let stderr = '';
  const respond = (body) => {
    if (responded) return;
    responded = true;
    try { sshExec.close(); } catch {}
    res.json(body);
  };

  sshExec.stream.on('data', (c) => { stdout += c.toString(); });
  sshExec.stream.stderr?.on('data', (c) => { stderr += c.toString(); });
  sshExec.stream.on('close', (code) => {
    if (queryId) runningQueries.delete(queryId);
    respond(buildQueryResponse({
      stdout, stderr, code: cancelled ? 0 : (code ?? 0), cancelled, isMeta,
      duration: Date.now() - startTime,
    }));
  });
  sshExec.stream.on('error', (err) => {
    if (queryId) runningQueries.delete(queryId);
    respond({ error: err.message, duration: Date.now() - startTime });
  });

  try { sshExec.stream.end(trimmedQuery + '\n'); } catch {}
}

app.post('/api/query', async (req, res) => {
  const { connection, query, queryId } = req.body || {};
  if (!connection || !query) return res.status(400).json({ error: 'connection and query are required' });

  const userId = req.session.userId;
  const startTime = Date.now();
  const trimmedQuery = String(query).trim();
  const isMeta = /(^|\n)\s*\\[a-zA-Z?!+]/.test(trimmedQuery);

  // psqlMode controls how queries reach PostgreSQL — independent of the
  // shell checkbox, which only affects what the PTY tab spawns.
  if (connection.psqlMode === 'peer') {
    return executePeerQuery({ connection, trimmedQuery, isMeta, queryId, userId, startTime, res });
  }

  let tunnel = null;
  let env;
  try {
    tunnel = await maybeOpenTunnel(connection, userId);
    env = await buildPsqlEnv(connection, userId);
  } catch (err) {
    if (tunnel) { try { tunnel.close(); } catch {} }
    log('executeQuery setup error:', err.message);
    return res.json({ error: `${err.message}`, duration: Date.now() - startTime });
  }

  const effectiveConn = tunnel
    ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
    : connection;

  const args = isMeta
    ? ['--no-psqlrc', '-w', '-P', 'pager=off', '-c', trimmedQuery, ...buildPsqlArgs(effectiveConn)]
    : ['--csv', '--no-psqlrc', '-w', '-c', trimmedQuery, ...buildPsqlArgs(effectiveConn)];
  log('executeQuery host:', connection.host, tunnel ? `(via tunnel -> 127.0.0.1:${tunnel.localPort})` : '', 'queryId:', queryId, isMeta ? '(meta)' : '');

  const proc = spawn(findPsqlBin(), args, { env });
  if (queryId) runningQueries.set(queryId, { kill: () => { try { proc.kill('SIGTERM'); } catch {} } });

  let stdout = '';
  let stderr = '';
  let responded = false;
  const respond = (body) => {
    if (responded) return;
    responded = true;
    if (tunnel) { try { tunnel.close(); } catch {} }
    res.json(body);
  };

  proc.stdout.on('data', (c) => { stdout += c.toString(); });
  proc.stderr.on('data', (c) => { stderr += c.toString(); });

  proc.on('error', (err) => {
    if (queryId) runningQueries.delete(queryId);
    log('executeQuery spawn error:', err.message);
    respond({ error: err.message, duration: Date.now() - startTime });
  });

  proc.on('close', (code, signal) => {
    if (queryId) runningQueries.delete(queryId);
    respond(buildQueryResponse({
      stdout, stderr, code, cancelled: signal === 'SIGTERM' || signal === 'SIGKILL', isMeta,
      duration: Date.now() - startTime,
    }));
  });
});

app.delete('/api/query/:id', (req, res) => {
  const entry = runningQueries.get(req.params.id);
  if (entry) {
    try { entry.kill(); } catch {}
    runningQueries.delete(req.params.id);
    log('Query cancelled:', req.params.id);
  }
  res.json({ ok: true });
});

app.post('/api/test-connection', async (req, res) => {
  const { connection } = req.body || {};
  if (!connection) return res.status(400).json({ ok: false, error: 'connection is required' });

  const userId = req.session.userId;
  const startTime = Date.now();
  const isPeer = connection.psqlMode === 'peer';
  // Test the more brittle path first: peer exercises SSH + sudo + psql,
  // shell only SSH. If peer is set, testing shell would hide peer breakage.
  const isShell = !isPeer && connection.terminalMode === 'shell';

  if (isShell) {
    const tunnelCfg = connection.tunnel;
    const rawHops = (tunnelCfg && tunnelCfg.enabled && Array.isArray(tunnelCfg.hops)) ? tunnelCfg.hops : [];
    if (rawHops.length === 0) {
      return res.json({ ok: false, error: 'shell mode requires an enabled SSH tunnel with at least one hop', duration: Date.now() - startTime });
    }
    let resolvedHops, sshShell;
    try { resolvedHops = await resolveHops(rawHops, userId); }
    catch (err) { return res.json({ ok: false, error: err.message, duration: Date.now() - startTime }); }

    const requested = Number.isInteger(connection.shellHopIndex)
      ? connection.shellHopIndex
      : resolvedHops.length - 1;
    if (requested < 0 || requested >= resolvedHops.length) {
      return res.json({ ok: false, error: `shell hop index out of range: ${requested}`, duration: Date.now() - startTime });
    }

    try {
      sshShell = await openSshShell({ hops: resolvedHops, targetHopIndex: requested, cols: 80, rows: 24 });
    } catch (err) {
      return res.json({ ok: false, error: `SSH: ${err.message}`, duration: Date.now() - startTime });
    }
    try { sshShell.close(); } catch {}
    return res.json({
      ok: true,
      message: `SSH shell on hop ${requested + 1}/${resolvedHops.length}`,
      duration: Date.now() - startTime,
    });
  }

  if (isPeer) {
    let target;
    try { target = await resolvePeerTarget(connection, userId); }
    catch (err) { return res.json({ ok: false, error: err.message, duration: Date.now() - startTime }); }

    let command;
    try {
      command = buildPeerCommand({
        sshUser: target.sshUser,
        peerOsUser: connection.peerOsUser,
        peerSudo: !!connection.peerSudo,
        pgUser: connection.user,
        database: connection.database,
        csv: true,
      });
    } catch (err) { return res.json({ ok: false, error: err.message, duration: Date.now() - startTime }); }

    let sshExec;
    try {
      sshExec = await openSshExec({ hops: target.hops, targetHopIndex: target.targetHopIndex, command, pty: false });
    } catch (err) {
      return res.json({ ok: false, error: `SSH: ${err.message}`, duration: Date.now() - startTime });
    }

    let stderr = '';
    let responded = false;
    const respond = (body) => {
      if (responded) return;
      responded = true;
      try { sshExec.close(); } catch {}
      res.json(body);
    };
    sshExec.stream.stderr?.on('data', (c) => { stderr += c.toString(); });
    sshExec.stream.on('close', (code) => {
      if (code === 0) {
        respond({ ok: true, message: `peer psql on hop ${target.targetHopIndex + 1}/${target.hops.length}`, duration: Date.now() - startTime });
      } else {
        respond({ ok: false, error: stderr.trim() || `psql exited with code ${code}`, duration: Date.now() - startTime });
      }
    });
    sshExec.stream.on('error', (err) => respond({ ok: false, error: err.message, duration: Date.now() - startTime }));
    try { sshExec.stream.end('select 1\n'); } catch {}
    return;
  }

  let tunnel = null;
  let env;
  try {
    tunnel = await maybeOpenTunnel(connection, userId);
    env = await buildPsqlEnv(connection, userId);
  } catch (err) {
    if (tunnel) { try { tunnel.close(); } catch {} }
    return res.json({ ok: false, error: err.message, duration: Date.now() - startTime });
  }
  const effectiveConn = tunnel
    ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
    : connection;
  const args = ['--csv', '--no-psqlrc', '-w', '-c', 'select 1', ...buildPsqlArgs(effectiveConn)];
  const proc = spawn(findPsqlBin(), args, { env });

  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); });
  proc.on('error', (err) => {
    if (tunnel) { try { tunnel.close(); } catch {} }
    res.json({ ok: false, error: err.message, duration: Date.now() - startTime });
  });
  proc.on('close', (code) => {
    if (tunnel) { try { tunnel.close(); } catch {} }
    if (code === 0) {
      res.json({
        ok: true,
        message: tunnel ? 'psql via tunnel' : 'direct psql',
        duration: Date.now() - startTime,
      });
    } else {
      res.json({
        ok: false,
        error: stderr.trim() || `psql exited with code ${code}`,
        duration: Date.now() - startTime,
      });
    }
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const noopRes = { setHeader() {}, getHeader() {}, removeHeader() {}, end() {}, writeHead() {} };
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/ws/pty')) {
    if (!sessionMiddleware) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    sessionMiddleware(req, noopRes, () => {
      if (!req.session?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const tabId = url.searchParams.get('tabId') || 'default';
  const userId = req.session.userId;
  let shell = null;
  let sshShell = null;
  let tunnel = null;

  const safeSend = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(payload); } catch {}
  };

  const closeTunnel = () => {
    if (tunnel) {
      try { tunnel.close(); } catch {}
      tunnel = null;
    }
  };

  const teardown = () => {
    if (shell) { try { shell.kill(); } catch {} shell = null; }
    if (sshShell) { try { sshShell.close(); } catch {} sshShell = null; }
    closeTunnel();
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'spawn') {
      try {
        teardown();
        const connection = msg.connection || {};

        if (connection.terminalMode === 'shell') {
          const tunnelCfg = connection.tunnel;
          const rawHops = (tunnelCfg && tunnelCfg.enabled && Array.isArray(tunnelCfg.hops)) ? tunnelCfg.hops : [];
          let resolvedHops = [];
          let targetHopIndex = 0;

          try {
            if (rawHops.length === 0) {
              throw new Error('shell mode requires an enabled SSH tunnel with at least one hop');
            }
            resolvedHops = await resolveHops(rawHops, userId);
            const requested = Number.isInteger(connection.shellHopIndex)
              ? connection.shellHopIndex
              : resolvedHops.length - 1;
            if (requested < 0 || requested >= resolvedHops.length) {
              throw new Error(`shell hop index out of range: ${requested} (chain has ${resolvedHops.length} hop(s))`);
            }
            targetHopIndex = requested;
          } catch (err) {
            log('SSH shell config error:', err.message);
            safeSend(JSON.stringify({ type: 'error', message: err.message }));
            return;
          }

          log('SSH shell spawn tabId:', tabId, 'targetHop:', targetHopIndex + 1, '/', resolvedHops.length);
          try {
            sshShell = await openSshShell({
              hops: resolvedHops,
              targetHopIndex,
              cols: msg.cols || 120,
              rows: msg.rows || 30,
            });
          } catch (err) {
            log('SSH shell error:', err.message);
            safeSend(JSON.stringify({ type: 'error', message: `SSH shell: ${err.message}` }));
            return;
          }

          sshShell.stream.on('data', (data) => safeSend(Buffer.from(data)));
          sshShell.stream.stderr?.on('data', (data) => safeSend(Buffer.from(data)));
          sshShell.stream.on('close', () => {
            safeSend(JSON.stringify({ type: 'exit', exitCode: 0 }));
            sshShell = null;
          });
          safeSend(JSON.stringify({ type: 'ready' }));
          return;
        }

        if (connection.psqlMode === 'peer') {
          let target, command;
          try {
            target = await resolvePeerTarget(connection, userId);
            command = buildPeerCommand({
              sshUser: target.sshUser,
              peerOsUser: connection.peerOsUser,
              peerSudo: !!connection.peerSudo,
              pgUser: connection.user,
              database: connection.database,
              csv: false,
            });
          } catch (err) {
            log('SSH peer config error:', err.message);
            safeSend(JSON.stringify({ type: 'error', message: err.message }));
            return;
          }

          log('SSH peer spawn tabId:', tabId, 'targetHop:', target.targetHopIndex + 1, '/', target.hops.length);
          try {
            sshShell = await openSshExec({
              hops: target.hops,
              targetHopIndex: target.targetHopIndex,
              command,
              pty: { cols: msg.cols || 120, rows: msg.rows || 30, term: 'xterm-256color' },
            });
          } catch (err) {
            log('SSH peer error:', err.message);
            safeSend(JSON.stringify({ type: 'error', message: `SSH peer: ${err.message}` }));
            return;
          }

          sshShell.stream.on('data', (data) => safeSend(Buffer.from(data)));
          sshShell.stream.stderr?.on('data', (data) => safeSend(Buffer.from(data)));
          sshShell.stream.on('close', (code) => {
            safeSend(JSON.stringify({ type: 'exit', exitCode: code ?? 0 }));
            sshShell = null;
          });
          safeSend(JSON.stringify({ type: 'ready' }));
          return;
        }

        let env;
        try {
          tunnel = await maybeOpenTunnel(connection, userId);
          env = await buildPsqlEnv(connection, userId);
        } catch (err) {
          log('PTY setup error:', err.message);
          safeSend(JSON.stringify({ type: 'error', message: err.message }));
          return;
        }

        const effectiveConn = tunnel
          ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
          : connection;

        const args = ['-w', ...buildPsqlArgs(effectiveConn)];
        env.PSQL_PAGER = 'cat';
        env.PAGER = 'cat';
        const psqlBin = findPsqlBin();
        log('PTY spawn tabId:', tabId, 'host:', connection.host, tunnel ? `(via tunnel -> 127.0.0.1:${tunnel.localPort})` : '');
        shell = pty.spawn(psqlBin, args, {
          name: 'xterm-256color',
          cols: msg.cols || 120,
          rows: msg.rows || 30,
          cwd: process.env.HOME || '/tmp',
          env,
        });
        shell.onData((data) => safeSend(Buffer.from(data)));
        shell.onExit(({ exitCode }) => {
          safeSend(JSON.stringify({ type: 'exit', exitCode }));
          shell = null;
          closeTunnel();
        });
        safeSend(JSON.stringify({ type: 'ready' }));
      } catch (err) {
        log('PTY spawn error:', err.message);
        teardown();
        safeSend(JSON.stringify({ type: 'error', message: err.message }));
      }
    } else if (msg.type === 'write') {
      try { shell?.write(msg.data); } catch {}
      try { sshShell?.stream.write(msg.data); } catch {}
    } else if (msg.type === 'resize') {
      try { shell?.resize(msg.cols, msg.rows); } catch {}
      try { sshShell?.stream.setWindow(msg.rows, msg.cols, 0, 0); } catch {}
    } else if (msg.type === 'send-query') {
      try { shell?.write(String(msg.query || '').trim() + '\r'); } catch {}
    } else if (msg.type === 'kill') {
      teardown();
    }
  });

  ws.on('close', () => {
    teardown();
  });
});

const PORT = Number(process.env.PORT) || 8080;

async function main() {
  // 1. Bring up the KMS client and check it's reachable BEFORE doing
  //    anything that needs secrets. Fatal if unreachable — no plaintext
  //    fallback.
  let store;
  try {
    store = getSecretStore();
    await store.healthcheck();
    log(`KMS: ${store.kind} reachable`);
  } catch (err) {
    log('KMS init failed:', err.message);
    process.exit(1);
  }

  // 2. Resolve the session secret. Accepts a ref env var, a literal
  //    (auto-bootstrapped to the KMS with a warning), or no env var
  //    (read from the default ref; auto-seeded with random bytes if
  //    the default ref is missing, which is the dev-mode case).
  let sessionSecret;
  try {
    sessionSecret = await resolveBootSecret('SESSION_SECRET', 'openbao:server/session-secret', {
      log,
      bootstrap: () => crypto.randomBytes(32).toString('hex'),
    });
  } catch (err) {
    log('SESSION_SECRET resolution failed:', err.message);
    process.exit(1);
  }

  // 3. Build the session middleware with the resolved secret. The shim
  //    registered at module load picks it up from this assignment.
  sessionMiddleware = session({
    store: new PgSession({ pool, schemaName: 'aperium', tableName: 'sessions' }),
    name: 'aperium.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });

  // 4. Initialize the DB schema (also triggers the lazy PG_PASSWORD
  //    resolution via the pool factory in db.js).
  try {
    await initSchema();
  } catch (err) {
    log('DB schema init failed:', err.message);
    process.exit(1);
  }

  // 5. Walk per-user data and migrate any remaining cleartext secrets
  //    into the KMS. Idempotent: rerunning is a no-op once everything
  //    is already refs.
  try {
    await runUserMigration(USER_DATA_DIR, log);
  } catch (err) {
    log('Auto-migration error (continuing):', err.message);
  }

  // 6. Listen.
  server.listen(PORT, '0.0.0.0', () => {
    log(`Aperium PSQL server listening on 0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  log('Fatal startup error:', err && err.stack || err);
  process.exit(1);
});

function shutdown(sig) {
  log(`${sig} received, shutting down`);
  for (const [, proc] of runningQueries) { try { proc.kill('SIGTERM'); } catch {} }
  wss.clients.forEach((ws) => { try { ws.close(); } catch {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
