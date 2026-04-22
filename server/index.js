const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

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

const connectionsFile = path.join(DATA_DIR, 'connections.json');
const snippetsFile = path.join(DATA_DIR, 'snippets.json');

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

app.post('/api/query', (req, res) => {
  const { connection, query, queryId } = req.body || {};
  if (!connection || !query) return res.status(400).json({ error: 'connection and query are required' });

  const args = ['--csv', '--no-psqlrc', '-c', String(query).trim(), ...buildPsqlArgs(connection)];
  const env = buildPsqlEnv(connection);
  const startTime = Date.now();
  log('executeQuery host:', connection.host, 'queryId:', queryId);

  const proc = spawn(findPsqlBin(), args, { env });
  if (queryId) runningQueries.set(queryId, proc);

  let stdout = '';
  let stderr = '';
  let responded = false;
  const respond = (body) => {
    if (responded) return;
    responded = true;
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/pty' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const tabId = url.searchParams.get('tabId') || 'default';
  let shell = null;

  const safeSend = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(payload); } catch {}
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'spawn') {
      try {
        if (shell) { try { shell.kill(); } catch {} shell = null; }
        const connection = msg.connection || {};
        const args = buildPsqlArgs(connection);
        const env = buildPsqlEnv(connection);
        env.PSQL_PAGER = 'cat';
        env.PAGER = 'cat';
        const psqlBin = findPsqlBin();
        log('PTY spawn tabId:', tabId, 'host:', connection.host);
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
        });
        safeSend(JSON.stringify({ type: 'ready' }));
      } catch (err) {
        log('PTY spawn error:', err.message);
        safeSend(JSON.stringify({ type: 'error', message: err.message }));
      }
    } else if (msg.type === 'write') {
      try { shell?.write(msg.data); } catch {}
    } else if (msg.type === 'resize') {
      try { shell?.resize(msg.cols, msg.rows); } catch {}
    } else if (msg.type === 'send-query') {
      try { shell?.write(String(msg.query || '').trim() + '\r'); } catch {}
    } else if (msg.type === 'kill') {
      try { shell?.kill(); } catch {}
      shell = null;
    }
  });

  ws.on('close', () => {
    if (shell) { try { shell.kill(); } catch {} shell = null; }
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
