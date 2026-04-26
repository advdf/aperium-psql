const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { openTunnelChain, openSshShell } = require('./ssh-tunnel');

function loadBastions() {
  try { return JSON.parse(fs.readFileSync(bastionsFile, 'utf-8')); }
  catch { return []; }
}

function readPrivateKey(p, ctx) {
  if (!p) throw new Error(`${ctx}: no private key path`);
  let content;
  try {
    content = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${ctx}: private key file not found: ${p}`);
    if (err.code === 'EACCES') throw new Error(`${ctx}: cannot read private key (permission denied): ${p}`);
    throw new Error(`${ctx}: cannot read private key ${p}: ${err.message}`);
  }
  if (!content.trim()) throw new Error(`${ctx}: private key file is empty: ${p}`);
  return content;
}

function resolveBastionCreds(source, ctx) {
  if (!source || !source.host || !source.user) {
    throw new Error(`${ctx}: host and user are required`);
  }
  const keyPath = source.privateKeyPath;
  // Legacy fallback: inline privateKey content stored directly in the bastion
  // (pre-volume-mount layout). Kept working so old configs don't break, but
  // new bastions must use privateKeyPath so the key never ends up in
  // bastions.json / backups.
  let privateKey;
  if (keyPath) {
    privateKey = readPrivateKey(keyPath, `${ctx} (${source.host})`);
  } else if (source.privateKey) {
    privateKey = source.privateKey;
  } else {
    throw new Error(`${ctx} (${source.host}): privateKeyPath is required`);
  }
  return {
    host: source.host,
    port: source.port,
    user: source.user,
    privateKey,
    passphrase: source.passphrase,
  };
}

function resolveHops(hops) {
  const bastions = loadBastions();
  const byId = new Map(bastions.map((b) => [b.id, b]));
  return hops.map((hop, i) => {
    const ctx = `hop ${i + 1}`;
    const source = hop && hop.bastionId ? byId.get(hop.bastionId) : hop;
    if (hop && hop.bastionId && !source) {
      throw new Error(`${ctx}: bastion ${hop.bastionId} not found`);
    }
    return resolveBastionCreds(source, ctx);
  });
}

async function maybeOpenTunnel(connection) {
  const t = connection && connection.tunnel;
  if (!t || !t.enabled || !Array.isArray(t.hops) || t.hops.length === 0) return null;
  const resolved = resolveHops(t.hops);
  return openTunnelChain({
    hops: resolved,
    dbHost: connection.host,
    dbPort: Number(connection.port) || 5432,
  });
}

const DATA_DIR = process.env.APERIUM_DATA_DIR || path.join(__dirname, '..', 'data');
const KEYS_DIR = process.env.APERIUM_KEYS_DIR || '/keys';
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

const connectionsFile = path.join(DATA_DIR, 'connections.json');
const snippetsFile = path.join(DATA_DIR, 'snippets.json');
const bastionsFile = path.join(DATA_DIR, 'bastions.json');

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

function buildPsqlEnv(connection) {
  const env = { ...process.env };
  if (connection.password) env.PGPASSWORD = connection.password;
  if (connection.sslmode) env.PGSSLMODE = connection.sslmode;
  return env;
}

const runningQueries = new Map();

const app = express();
app.use(express.json({ limit: '10mb' }));

const ROOT = path.join(__dirname, '..');
app.use('/static/dist', express.static(path.join(ROOT, 'dist')));
app.use('/static/assets', express.static(path.join(ROOT, 'assets')));
app.use('/static/src', express.static(path.join(ROOT, 'src')));
app.use('/static/node_modules', express.static(path.join(ROOT, 'node_modules')));

app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'src', 'index.html')));

app.get('/api/connections', (_req, res) => {
  res.json(storeGet(connectionsFile, 'connections', []));
});

app.put('/api/connections', (req, res) => {
  storeSet(connectionsFile, 'connections', req.body);
  res.json({ ok: true });
});

app.get('/api/snippets', (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(snippetsFile, 'utf-8'))); }
  catch { res.json(null); }
});

app.put('/api/snippets', (req, res) => {
  fs.writeFileSync(snippetsFile, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.get('/api/bastions', (_req, res) => {
  res.json(loadBastions());
});

app.get('/api/psql-meta', (_req, res) => {
  // Bundled list of psql backslash commands (extracted from `psql 18 -c '\?'`).
  // Lives under server/ so it ships with the Docker image (data/ is a user volume).
  res.type('application/json').sendFile(path.join(__dirname, 'psql-meta.json'));
});

app.get('/api/keys', (_req, res) => {
  try {
    const entries = fs.readdirSync(KEYS_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      // Exclude public keys and hidden files — they're never what we want.
      .filter((n) => !n.endsWith('.pub') && !n.startsWith('.'))
      .sort()
      .map((n) => path.posix.join(KEYS_DIR.replace(/\\/g, '/'), n));
    res.json({ dir: KEYS_DIR, files });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ dir: KEYS_DIR, files: [], error: `keys dir not found: ${KEYS_DIR}` });
    res.status(500).json({ dir: KEYS_DIR, files: [], error: err.message });
  }
});

app.put('/api/bastions', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected an array' });
  fs.writeFileSync(bastionsFile, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.post('/api/query', async (req, res) => {
  const { connection, query, queryId } = req.body || {};
  if (!connection || !query) return res.status(400).json({ error: 'connection and query are required' });

  const startTime = Date.now();
  let tunnel = null;
  try {
    tunnel = await maybeOpenTunnel(connection);
  } catch (err) {
    log('executeQuery tunnel error:', err.message);
    return res.json({ error: `SSH tunnel: ${err.message}`, duration: Date.now() - startTime });
  }

  const effectiveConn = tunnel
    ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
    : connection;

  const trimmedQuery = String(query).trim();
  const isMeta = /(^|\n)\s*\\[a-zA-Z?!+]/.test(trimmedQuery);

  // Meta-commands can't run under `--csv` (psql refuses). Use plain aligned output and
  // disable the pager so output stays on stdout. Otherwise keep the existing CSV path.
  const args = isMeta
    ? ['--no-psqlrc', '-w', '-P', 'pager=off', '-c', trimmedQuery, ...buildPsqlArgs(effectiveConn)]
    : ['--csv', '--no-psqlrc', '-w', '-c', trimmedQuery, ...buildPsqlArgs(effectiveConn)];
  const env = buildPsqlEnv(connection);
  log('executeQuery host:', connection.host, tunnel ? `(via tunnel -> 127.0.0.1:${tunnel.localPort})` : '', 'queryId:', queryId, isMeta ? '(meta)' : '');

  const proc = spawn(findPsqlBin(), args, { env });
  if (queryId) runningQueries.set(queryId, proc);

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
    const duration = Date.now() - startTime;
    const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';

    if (cancelled) return respond({ error: 'Query cancelled', duration, cancelled: true });
    if (code !== 0) return respond({ error: stderr.trim() || `psql exited with code ${code}`, duration });

    if (isMeta) {
      return respond({
        isMetacommand: true,
        raw: stdout,
        stderr: stderr.trim() || null,
        duration,
      });
    }

    try {
      const lines = stdout.trim().split('\n');
      if (lines.length === 0 || !lines[0]) {
        return respond({ message: stderr || 'Query executed successfully.', duration });
      }
      const columns = parseCSVLine(lines[0]);
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) rows.push(parseCSVLine(lines[i]));
      }
      respond({ columns, rows, rowCount: rows.length, duration, notice: stderr || null });
    } catch {
      respond({ message: stdout.trim() || stderr.trim() || 'Done.', duration });
    }
  });
});

app.delete('/api/query/:id', (req, res) => {
  const proc = runningQueries.get(req.params.id);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    runningQueries.delete(req.params.id);
    log('Query cancelled:', req.params.id);
  }
  res.json({ ok: true });
});

// Probe a connection without persisting it. For shell-mode connections we walk
// the SSH chain up to the selected hop and tear it down — that proves the chain
// and credentials work. For psql-mode we additionally run `select 1` through
// the tunnel to validate Postgres-side auth/network.
app.post('/api/test-connection', async (req, res) => {
  const { connection } = req.body || {};
  if (!connection) return res.status(400).json({ ok: false, error: 'connection is required' });

  const startTime = Date.now();
  const isShell = connection.terminalMode === 'shell';

  if (isShell) {
    const tunnelCfg = connection.tunnel;
    const rawHops = (tunnelCfg && tunnelCfg.enabled && Array.isArray(tunnelCfg.hops)) ? tunnelCfg.hops : [];
    if (rawHops.length === 0) {
      return res.json({ ok: false, error: 'shell mode requires an enabled SSH tunnel with at least one hop', duration: Date.now() - startTime });
    }
    let resolvedHops, sshShell;
    try { resolvedHops = resolveHops(rawHops); }
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

  // psql mode: open tunnel (if any) + run `select 1`.
  let tunnel = null;
  try {
    tunnel = await maybeOpenTunnel(connection);
  } catch (err) {
    return res.json({ ok: false, error: `SSH tunnel: ${err.message}`, duration: Date.now() - startTime });
  }
  const effectiveConn = tunnel
    ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
    : connection;
  const args = ['--csv', '--no-psqlrc', '-w', '-c', 'select 1', ...buildPsqlArgs(effectiveConn)];
  const env = buildPsqlEnv(connection);
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
const wss = new WebSocketServer({ server, path: '/ws/pty' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const tabId = url.searchParams.get('tabId') || 'default';
  let shell = null;          // node-pty PTY (psql mode)
  let sshShell = null;       // { stream, close } from openSshShell (shell mode)
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
            resolvedHops = resolveHops(rawHops);
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

        // psql mode (default, backwards compatible)
        try {
          tunnel = await maybeOpenTunnel(connection);
        } catch (err) {
          log('PTY tunnel error:', err.message);
          safeSend(JSON.stringify({ type: 'error', message: `SSH tunnel: ${err.message}` }));
          return;
        }

        const effectiveConn = tunnel
          ? { ...connection, host: tunnel.localHost, port: String(tunnel.localPort) }
          : connection;

        const args = ['-w', ...buildPsqlArgs(effectiveConn)];
        const env = buildPsqlEnv(connection);
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
      // No-op in shell mode (the client hides the button, but defend in depth).
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
server.listen(PORT, '0.0.0.0', () => {
  log(`Aperium PSQL server listening on 0.0.0.0:${PORT}`);
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
