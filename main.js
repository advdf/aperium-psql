const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const ptySessions = new Map();
let mainWindow;

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
    if (connection.password) {
      env.PGPASSWORD = connection.password;
    }
    if (connection.sslmode) {
      env.PGSSLMODE = connection.sslmode;
    }
    // Disable pager so output flows freely (terminal is read-only)
    env.PSQL_PAGER = 'cat';
    env.PAGER = 'cat';

    console.log('Spawning psql with args:', args);

    const shell = pty.spawn('/opt/homebrew/bin/psql', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.HOME,
      env,
    });

  ptySessions.set(id, shell);

  shell.onData((data) => {
    mainWindow?.webContents.send('pty:data', { id, data });
  });

  shell.onExit(({ exitCode }) => {
    ptySessions.delete(id);
    mainWindow?.webContents.send('pty:exit', { id, exitCode });
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

// Execute query and return structured results (separate from interactive terminal)
ipcMain.handle('query:execute', async (_, { connection, query }) => {
  const { execFile } = require('child_process');

  return new Promise((resolve) => {
    const args = ['--csv', '--no-psqlrc', '-c', query.trim()];
    if (connection.host) args.push('-h', connection.host);
    if (connection.port) args.push('-p', String(connection.port));
    if (connection.user) args.push('-U', connection.user);
    if (connection.database) args.push('-d', connection.database);

    const env = { ...process.env };
    if (connection.password) env.PGPASSWORD = connection.password;
    if (connection.sslmode) env.PGSSLMODE = connection.sslmode;

    const startTime = Date.now();

    execFile('/opt/homebrew/bin/psql', args, { env, timeout: 30000 }, (err, stdout, stderr) => {
      const duration = Date.now() - startTime;

      if (err) {
        resolve({ error: stderr || err.message, duration });
        return;
      }

      // Parse CSV output
      try {
        const lines = stdout.trim().split('\n');
        if (lines.length === 0 || !lines[0]) {
          resolve({ message: stderr || 'Query executed successfully.', duration });
          return;
        }

        // Handle non-SELECT (INSERT, UPDATE, DELETE, etc.)
        // psql --csv with non-SELECT returns the command tag in stderr
        const columns = parseCSVLine(lines[0]);
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim()) {
            rows.push(parseCSVLine(lines[i]));
          }
        }

        resolve({ columns, rows, rowCount: rows.length, duration, notice: stderr || null });
      } catch (parseErr) {
        // Non-tabular output (e.g. INSERT 0 1)
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

// Cleanup on quit
app.on('before-quit', () => {
  for (const [, session] of ptySessions) {
    session.kill();
  }
});
