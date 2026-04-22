const { app, BrowserWindow, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const ptySessions = new Map();
let mainWindow;

// Ensure Homebrew psql is findable in packaged app
if (!process.env.PATH || !process.env.PATH.includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;
}

// File logging for packaged app debugging
const logFile = path.join(app.getPath('userData'), 'aperium.log');
function logToFile(...args) {
  const msg = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try { fs.appendFileSync(logFile, msg); } catch {}
  console.log(...args);
}
logToFile('=== App starting ===');
logToFile('PATH:', process.env.PATH);

// Simple JSON store (electron-store v8 is ESM-only)
const storeFile = path.join(app.getPath('userData'), 'connections.json');
function storeGet(key, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    return data[key] ?? fallback;
  } catch {
    return fallback;
  }
}
function storeSet(key, value) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch {}
  data[key] = value;
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('src/index.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    app.dock.setIcon(icon);
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());

// Connection management
ipcMain.handle('connections:list', () => {
  return storeGet('connections', []);
});

ipcMain.handle('connections:save', (_, connections) => {
  storeSet('connections', connections);
});

// PTY management
ipcMain.handle('pty:spawn', (event, { id, connection }) => {
  try {
    if (ptySessions.has(id)) {
      ptySessions.get(id).kill();
    }

    const args = [];
    if (connection.host) args.push('-h', connection.host);
    if (connection.port) args.push('-p', String(connection.port));
    if (connection.user) args.push('-U', connection.user);
    if (connection.database) args.push('-d', connection.database);

    const env = { ...process.env };
    // Ensure Homebrew paths are available (packaged app has minimal PATH)
    if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
      env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
    } else if (!env.PATH) {
      env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    }
    if (connection.password) {
      env.PGPASSWORD = connection.password;
    }
    if (connection.sslmode) {
      env.PGSSLMODE = connection.sslmode;
    }
    // Disable pager so output flows freely (terminal is read-only)
    env.PSQL_PAGER = 'cat';
    env.PAGER = 'cat';

    // Find psql binary
    const psqlPaths = ['/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/usr/bin/psql'];
    let psqlBin = psqlPaths.find(p => fs.existsSync(p)) || 'psql';

    logToFile('psql binary:', psqlBin, 'exists:', fs.existsSync(psqlBin));
    logToFile('zsh exists:', fs.existsSync('/bin/zsh'));
    logToFile('Spawning with args:', args);

    // Use /bin/zsh -l -c to ensure full shell environment (packaged apps have minimal env)
    const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    logToFile('Full command: /bin/zsh -l -c', `${psqlBin} ${escapedArgs}`);

    let shell;
    try {
      shell = pty.spawn('/bin/zsh', ['-l', '-c', `${psqlBin} ${escapedArgs}`], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.env.HOME,
        env,
      });
      logToFile('PTY spawn success, pid:', shell.pid);
    } catch (spawnErr) {
      logToFile('PTY spawn error:', spawnErr.message, spawnErr.stack);
      throw spawnErr;
    }

  ptySessions.set(id, shell);

  shell.onData((data) => {
    mainWindow?.webContents.send('pty:data', { id, data });
  });

  shell.onExit(({ exitCode }) => {
    // Guard against evicting a replacement session: a new shell may have been
    // stored under the same id before this one's async exit fires.
    if (ptySessions.get(id) === shell) {
      ptySessions.delete(id);
      mainWindow?.webContents.send('pty:exit', { id, exitCode });
    }
  });

  return true;
  } catch (err) {
    console.error('PTY spawn error:', err);
    return { error: err.message };
  }
});

ipcMain.on('pty:write', (_, { id, data }) => {
  ptySessions.get(id)?.write(data);
});

ipcMain.on('pty:resize', (_, { id, cols, rows }) => {
  ptySessions.get(id)?.resize(cols, rows);
});

ipcMain.on('pty:kill', (_, { id }) => {
  ptySessions.get(id)?.kill();
  ptySessions.delete(id);
});

// Send SQL from editor to psql terminal
ipcMain.on('pty:send-query', (_, { id, query }) => {
  console.log('pty:send-query received, id:', id, 'query:', query);
  const session = ptySessions.get(id);
  if (session) {
    // Send the whole query followed by a newline
    session.write(query.trim() + '\r');
  } else {
    console.log('No session found for id:', id);
  }
});

// Track running query processes so they can be cancelled
const runningQueries = new Map();

ipcMain.on('query:cancel', (_, { queryId }) => {
  const proc = runningQueries.get(queryId);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    runningQueries.delete(queryId);
    logToFile('Query cancelled:', queryId);
  }
});

// Execute query and return structured results (separate from interactive terminal)
ipcMain.handle('query:execute', async (_, { connection, query, queryId }) => {
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const args = ['--csv', '--no-psqlrc', '-c', query.trim()];
    if (connection.host) args.push('-h', connection.host);
    if (connection.port) args.push('-p', String(connection.port));
    if (connection.user) args.push('-U', connection.user);
    if (connection.database) args.push('-d', connection.database);

    const env = { ...process.env };
    if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
      env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH}`;
    } else if (!env.PATH) {
      env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    }
    if (connection.password) env.PGPASSWORD = connection.password;
    if (connection.sslmode) env.PGSSLMODE = connection.sslmode;

    // Find psql binary
    const psqlPaths = ['/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/usr/bin/psql'];
    const psqlBin = psqlPaths.find(p => fs.existsSync(p)) || 'psql';

    const startTime = Date.now();
    logToFile('executeQuery spawning:', psqlBin, 'host:', connection.host, 'queryId:', queryId);

    const proc = spawn(psqlBin, args, { env });
    if (queryId) runningQueries.set(queryId, proc);

    let stdout = '';
    let stderr = '';
    let cancelled = false;

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if (queryId) runningQueries.delete(queryId);
      logToFile('executeQuery spawn error:', err.message);
      resolve({ error: err.message, duration: Date.now() - startTime });
    });

    proc.on('close', (code, signal) => {
      if (queryId) runningQueries.delete(queryId);
      const duration = Date.now() - startTime;
      cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';

      logToFile('executeQuery close code:', code, 'signal:', signal, 'stdout len:', stdout.length, 'stderr len:', stderr.length);

      if (cancelled) {
        resolve({ error: 'Query cancelled', duration, cancelled: true });
        return;
      }

      if (code !== 0) {
        resolve({ error: stderr.trim() || `psql exited with code ${code}`, duration });
        return;
      }

      // Parse CSV output
      try {
        const lines = stdout.trim().split('\n');
        if (lines.length === 0 || !lines[0]) {
          resolve({ message: stderr || 'Query executed successfully.', duration });
          return;
        }

        const columns = parseCSVLine(lines[0]);
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim()) {
            rows.push(parseCSVLine(lines[i]));
          }
        }

        resolve({ columns, rows, rowCount: rows.length, duration, notice: stderr || null });
      } catch (parseErr) {
        resolve({ message: stdout.trim() || stderr.trim() || 'Done.', duration });
      }
    });

  });
});

// Simple CSV line parser (handles quoted fields)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// Export results to file
ipcMain.handle('export:save', async (_, { content, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Results',
    defaultPath: defaultName,
    filters,
  });
  if (result.canceled) return { canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return { filePath: result.filePath };
});

// Snippets file management
const snippetsFile = path.join(app.getPath('userData'), 'snippets.json');

ipcMain.handle('snippets:load', () => {
  try {
    return JSON.parse(fs.readFileSync(snippetsFile, 'utf-8'));
  } catch {
    return null; // fallback to built-in
  }
});

ipcMain.handle('snippets:save', (_, snippets) => {
  fs.writeFileSync(snippetsFile, JSON.stringify(snippets, null, 2));
});

ipcMain.handle('snippets:path', () => snippetsFile);

ipcMain.handle('snippets:open-in-editor', () => {
  const { shell } = require('electron');
  // Create file with built-in snippets if it doesn't exist
  if (!fs.existsSync(snippetsFile)) {
    // Will be populated by renderer on first call
    return { needsInit: true, path: snippetsFile };
  }
  shell.openPath(snippetsFile);
  return { needsInit: false, path: snippetsFile };
});

// Import connections from file
ipcMain.handle('connections:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Connections',
    filters: [
      { name: 'JSON / CSV', extensions: ['json', 'csv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf-8');

  try {
    let imported = [];

    if (ext === '.json') {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed.connections || [parsed]);
      imported = arr.map(normalizeImportedConn);
    } else {
      // CSV
      const lines = raw.trim().split('\n');
      if (lines.length < 2) return { error: 'CSV file is empty or has no data rows.' };
      const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const values = parseCSVLine(lines[i]);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
        imported.push(normalizeImportedConn(obj));
      }
    }

    return { connections: imported, count: imported.length };
  } catch (err) {
    return { error: `Failed to parse file: ${err.message}` };
  }
});

function normalizeImportedConn(obj) {
  return {
    id: obj.id || require('crypto').randomUUID(),
    name: obj.name || obj.label || `${obj.host || 'localhost'}:${obj.port || 5432}/${obj.database || 'postgres'}`,
    host: obj.host || obj.hostname || 'localhost',
    port: String(obj.port || 5432),
    user: obj.user || obj.username || '',
    password: obj.password || '',
    database: obj.database || obj.dbname || obj.db || 'postgres',
    sslmode: obj.sslmode || obj.ssl || '',
    group: obj.group || '',
  };
}

// Cleanup on quit
app.on('before-quit', () => {
  for (const [, session] of ptySessions) {
    session.kill();
  }
});
