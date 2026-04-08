import { createEditor, updateSchema } from './editor.js';

// xterm loaded via <script> tags before this bundle
const XTerminal = window._Terminal;
const XFitAddon = window._FitAddon.FitAddon;
const XWebLinksAddon = window._WebLinksAddon.WebLinksAddon;

// State
let connections = [];
let activeSessionId = null;
let activeConnection = null;
let terminal = null;
let fitAddon = null;
let editorView = null;

// DOM
const connectionList = document.getElementById('connection-list');
const welcome = document.getElementById('welcome');
const session = document.getElementById('session');
const editorContainer = document.getElementById('editor-container');
const terminalContainer = document.getElementById('terminal-container');
const connectionInfo = document.getElementById('connection-info');
const dialog = document.getElementById('connection-dialog');
const form = document.getElementById('connection-form');
const dialogTitle = document.getElementById('dialog-title');
const btnNewConn = document.getElementById('btn-new-connection');
const btnCancel = document.getElementById('btn-cancel');
const btnRun = document.getElementById('btn-run');
const btnSendTerminal = document.getElementById('btn-send-terminal');
const btnClear = document.getElementById('btn-clear-editor');
const editorPanel = document.getElementById('editor-panel');
const resultsPanel = document.getElementById('results-panel');
const resultsContainer = document.getElementById('results-container');
const resultsStatus = document.getElementById('results-status');
const dbSelector = document.getElementById('db-selector');
const btnCopyCsv = document.getElementById('btn-copy-csv');
const btnCopyJson = document.getElementById('btn-copy-json');

// Last query results for copy
let lastResults = null;

// Init
async function init() {
  connections = await window.api.listConnections();
  renderConnections();
  setupResizeHandles();

  window.api.onPtyData(({ id, data }) => {
    if (id === activeSessionId && terminal) {
      terminal.write(data);
    }
  });

  window.api.onPtyExit(({ id, exitCode }) => {
    if (id === activeSessionId && terminal) {
      terminal.write(`\r\n\x1b[33m[psql exited with code ${exitCode}]\x1b[0m\r\n`);
      updateConnectionStatus(id, false);
    }
  });
}

// Connections
function renderConnections() {
  connectionList.innerHTML = '';
  connections.forEach((conn) => {
    const el = document.createElement('div');
    el.className = 'conn-item' + (conn.id === activeSessionId ? ' active' : '');
    el.innerHTML = `
      <div class="conn-status ${conn._connected ? 'connected' : ''}"></div>
      <span class="conn-name">${escapeHtml(conn.name)}</span>
      <div class="conn-item-actions">
        <button class="edit" title="Edit">&#9998;</button>
        <button class="delete" title="Delete">&times;</button>
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.edit')) openEditDialog(conn);
      else if (e.target.closest('.delete')) deleteConnection(conn.id);
      else connectTo(conn);
    });
    connectionList.appendChild(el);
  });
}

function updateConnectionStatus(id, connected) {
  const conn = connections.find((c) => c.id === id);
  if (conn) {
    conn._connected = connected;
    renderConnections();
  }
}

function openEditDialog(conn) {
  dialogTitle.textContent = 'Edit Connection';
  form.elements.id.value = conn.id;
  form.elements.name.value = conn.name;
  form.elements.host.value = conn.host || 'localhost';
  form.elements.port.value = conn.port || 5432;
  form.elements.user.value = conn.user || '';
  form.elements.password.value = conn.password || '';
  form.elements.database.value = conn.database || 'postgres';
  form.elements.sslmode.value = conn.sslmode || '';
  dialog.showModal();
}

async function deleteConnection(id) {
  connections = connections.filter((c) => c.id !== id);
  await window.api.saveConnections(connections.map(sanitizeConn));
  if (activeSessionId === id) {
    window.api.killPty(id);
    activeSessionId = null;
    activeConnection = null;
    showWelcome();
  }
  renderConnections();
}

function sanitizeConn(c) {
  const { _connected, ...rest } = c;
  return rest;
}

// Connect
async function connectTo(conn) {
  if (activeSessionId && activeSessionId !== conn.id) {
    window.api.killPty(activeSessionId);
    updateConnectionStatus(activeSessionId, false);
  }

  activeSessionId = conn.id;
  activeConnection = sanitizeConn(conn);

  welcome.style.display = 'none';
  session.classList.remove('hidden');

  // Setup terminal
  if (terminal) terminal.dispose();

  terminal = new XTerminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b7066',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#cba6f7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
  });

  fitAddon = new XFitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new XWebLinksAddon());

  terminalContainer.innerHTML = '';
  terminal.open(terminalContainer);

  // Small delay to let the DOM settle before fitting
  requestAnimationFrame(() => {
    fitAddon.fit();
  });

  // Terminal is read-only — all input goes through the SQL editor
  // Only allow Ctrl+C to cancel running queries
  terminal.onData((data) => {
    if (data === '\x03') { // Ctrl+C
      window.api.writePty(conn.id, data);
    }
  });
  terminal.onResize(({ cols, rows }) => window.api.resizePty(conn.id, cols, rows));

  await window.api.spawnPty(conn.id, conn);
  updateConnectionStatus(conn.id, true);
  connectionInfo.textContent = `${conn.user || 'postgres'}@${conn.host || 'localhost'}:${conn.port || 5432}/${conn.database || 'postgres'}`;

  // Init CodeMirror editor (once)
  if (!editorView) {
    editorView = createEditor(editorContainer, {
      onRun: runQuery,
      onSendTerminal: sendToTerminal,
    });
  }

  renderConnections();
  editorView.focus();

  // Fetch databases list and schema (async, non-blocking)
  const cleanConn = sanitizeConn(conn);
  fetchDatabases(cleanConn);
  fetchSchema(cleanConn);
}

function showWelcome() {
  welcome.style.display = 'flex';
  session.classList.add('hidden');
  if (terminal) { terminal.dispose(); terminal = null; }
}

// New connection dialog
btnNewConn.addEventListener('click', () => {
  dialogTitle.textContent = 'New Connection';
  form.reset();
  form.elements.id.value = '';
  form.elements.host.value = 'localhost';
  form.elements.port.value = '5432';
  form.elements.database.value = 'postgres';
  dialog.showModal();
});

btnCancel.addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const editId = data.id;
  delete data.id;

  if (editId) {
    const idx = connections.findIndex((c) => c.id === editId);
    if (idx >= 0) connections[idx] = { ...connections[idx], ...data };
  } else {
    data.id = crypto.randomUUID();
    connections.push(data);
  }

  await window.api.saveConnections(connections.map(sanitizeConn));
  renderConnections();
  dialog.close();
});

function getEditorContent() {
  return editorView ? editorView.state.doc.toString().trim() : '';
}

// ---- Run query (structured results) ----
async function runQuery() {
  if (!activeConnection) return;
  const query = getEditorContent();
  if (!query) return;

  // Metacommands (\dt, \dn, etc.) only work in interactive psql — route to terminal
  if (query.match(/^\s*\\/m)) {
    sendToTerminal();
    return;
  }

  // Show loading
  resultsContainer.innerHTML = '<div class="results-loading"><div class="spinner"></div>Running...</div>';
  resultsStatus.textContent = '';
  resultsStatus.className = '';

  const result = await window.api.executeQuery(activeConnection, query);

  if (result.error) {
    lastResults = null;
    hideCopyButtons();
    resultsContainer.innerHTML = `<div class="results-message error">${escapeHtml(result.error)}</div>`;
    resultsStatus.textContent = `Error (${result.duration}ms)`;
    resultsStatus.className = 'error';
    return;
  }

  if (result.message) {
    lastResults = null;
    hideCopyButtons();
    resultsContainer.innerHTML = `<div class="results-message">${escapeHtml(result.message)}</div>`;
    resultsStatus.textContent = `Done (${result.duration}ms)`;
    resultsStatus.className = 'success';
    return;
  }

  if (result.columns) {
    lastResults = { columns: result.columns, rows: result.rows };
    showCopyButtons();
    renderTable(result.columns, result.rows);
    resultsStatus.textContent = `${result.rowCount} row${result.rowCount !== 1 ? 's' : ''} (${result.duration}ms)`;
    resultsStatus.className = 'success';
  }
}

function showCopyButtons() {
  btnCopyCsv.classList.remove('hidden');
  btnCopyJson.classList.remove('hidden');
}

function hideCopyButtons() {
  btnCopyCsv.classList.add('hidden');
  btnCopyJson.classList.add('hidden');
}

function renderTable(columns, rows) {
  const table = document.createElement('table');

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const td = document.createElement('td');
      if (cell === '' || cell === null || cell === undefined) {
        td.textContent = 'NULL';
        td.className = 'null-value';
      } else {
        td.textContent = cell;
        td.title = cell; // tooltip for truncated content
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  resultsContainer.innerHTML = '';
  resultsContainer.appendChild(table);
}

// ---- Copy results ----
function copyWithFeedback(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  });
}

btnCopyCsv.addEventListener('click', () => {
  if (!lastResults) return;
  const lines = [lastResults.columns.join(',')];
  for (const row of lastResults.rows) {
    lines.push(row.map(cell => {
      if (cell === null || cell === undefined || cell === '') return '';
      const s = String(cell);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(','));
  }
  copyWithFeedback(btnCopyCsv, lines.join('\n'));
});

btnCopyJson.addEventListener('click', () => {
  if (!lastResults) return;
  const data = lastResults.rows.map(row => {
    const obj = {};
    lastResults.columns.forEach((col, i) => {
      obj[col] = (row[i] === '' || row[i] === undefined) ? null : row[i];
    });
    return obj;
  });
  copyWithFeedback(btnCopyJson, JSON.stringify(data, null, 2));
});

// ---- Send to terminal ----
function sendToTerminal() {
  if (!activeSessionId || !terminal) return;
  const query = getEditorContent();
  if (!query) return;
  window.api.sendQuery(activeSessionId, query);
}

btnRun.addEventListener('click', runQuery);
btnSendTerminal.addEventListener('click', sendToTerminal);
btnClear.addEventListener('click', () => {
  if (editorView) {
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } });
    editorView.focus();
  }
});

// ---- Database selector ----
async function fetchDatabases(conn) {
  try {
    const result = await window.api.executeQuery(conn,
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    if (result.columns && result.rows) {
      dbSelector.innerHTML = '';
      for (const row of result.rows) {
        const opt = document.createElement('option');
        opt.value = row[0];
        opt.textContent = row[0];
        if (row[0] === (conn.database || 'postgres')) opt.selected = true;
        dbSelector.appendChild(opt);
      }
    }
  } catch (e) {
    console.log('Database list fetch failed:', e);
  }
}

dbSelector.addEventListener('change', async () => {
  if (!activeConnection) return;
  const newDb = dbSelector.value;

  // Update connection with new database
  activeConnection = { ...activeConnection, database: newDb };

  // Also update in saved connections list
  const idx = connections.findIndex((c) => c.id === activeSessionId);
  if (idx >= 0) {
    connections[idx] = { ...connections[idx], database: newDb };
    await window.api.saveConnections(connections.map(sanitizeConn));
  }

  // Reconnect PTY
  window.api.killPty(activeSessionId);
  await window.api.spawnPty(activeSessionId, activeConnection);
  connectionInfo.textContent = `${activeConnection.user || 'postgres'}@${activeConnection.host || 'localhost'}:${activeConnection.port || 5432}/${newDb}`;

  // Clear terminal and write a notice
  terminal.clear();
  terminal.write(`\x1b[33m[Switched to database: ${newDb}]\x1b[0m\r\n`);

  // Refresh schema
  fetchSchema(activeConnection);
});

// ---- Fetch schema for autocompletion ----
async function fetchSchema(conn) {
  try {
    const result = await window.api.executeQuery(conn,
      `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
       ORDER BY table_schema, table_name, ordinal_position`
    );
    if (result.columns && result.rows) {
      const schema = {};
      for (const row of result.rows) {
        const [schemaName, table, column] = row;
        // Register with full qualified name (schema.table)
        const fullName = `${schemaName}.${table}`;
        if (!schema[fullName]) schema[fullName] = [];
        schema[fullName].push(column);
        // Also register without prefix so you can type the table name directly
        if (!schema[table]) schema[table] = [];
        if (!schema[table].includes(column)) schema[table].push(column);
      }
      updateSchema(schema);
      // Recreate editor with updated schema
      const content = getEditorContent();
      editorContainer.innerHTML = '';
      editorView = createEditor(editorContainer, {
        onRun: runQuery,
        onSendTerminal: sendToTerminal,
      });
      if (content) {
        editorView.dispatch({ changes: { from: 0, insert: content } });
      }
    }
  } catch (e) {
    console.log('Schema fetch failed (non-critical):', e);
  }
}

// ---- Resize handles ----
function setupResizeHandles() {
  const handles = document.querySelectorAll('.resize-handle');

  handles.forEach((handle) => {
    let isResizing = false;
    const target = handle.dataset.target;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();

      const onMouseMove = (e) => {
        if (!isResizing) return;
        const mainRect = document.getElementById('main').getBoundingClientRect();

        if (target === 'editor') {
          const newHeight = e.clientY - mainRect.top;
          editorPanel.style.height = Math.max(60, Math.min(newHeight, mainRect.height - 200)) + 'px';
        } else if (target === 'results') {
          const editorBottom = editorPanel.getBoundingClientRect().bottom + 4; // handle height
          const newHeight = e.clientY - editorBottom;
          resultsPanel.style.height = Math.max(60, Math.min(newHeight, mainRect.height - 200)) + 'px';
        }

        if (fitAddon) fitAddon.fit();
      };

      const onMouseUp = () => {
        isResizing = false;
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

// Window resize
window.addEventListener('resize', () => {
  if (fitAddon) fitAddon.fit();
});

// Escape closes dialog
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dialog.open) dialog.close();
});

// Helper
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Start
init();
