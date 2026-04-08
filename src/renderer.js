import { createEditor, updateSchema } from './editor.js';

// xterm loaded via <script> tags before this bundle
const XTerminal = window._Terminal;
const XFitAddon = window._FitAddon.FitAddon;
const XWebLinksAddon = window._WebLinksAddon.WebLinksAddon;

// ---- Tab state ----
const tabs = new Map(); // tabId -> tab state
let activeTabId = null;

// Each tab: { id, connId, connection, terminal, fitAddon, editorView, editorContent, resultsHtml, resultsStatus, lastResults, terminalEl }

// ---- Connections ----
let connections = [];

// DOM
const connectionList = document.getElementById('connection-list');
const welcome = document.getElementById('welcome');
const session = document.getElementById('session');
const tabBar = document.getElementById('tab-bar');
const tabList = document.getElementById('tab-list');
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

// ---- Init ----
async function init() {
  connections = await window.api.listConnections();
  renderConnections();
  setupResizeHandles();

  window.api.onPtyData(({ id, data }) => {
    // Route data to the correct tab's terminal
    for (const [, tab] of tabs) {
      if (tab.connId === id && tab.terminal) {
        tab.terminal.write(data);
      }
    }
  });

  window.api.onPtyExit(({ id, exitCode }) => {
    for (const [, tab] of tabs) {
      if (tab.connId === id && tab.terminal) {
        tab.terminal.write(`\r\n\x1b[33m[psql exited with code ${exitCode}]\x1b[0m\r\n`);
        updateConnectionStatus(id, false);
      }
    }
  });
}

// ---- Active tab helpers ----
function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

// ---- Connections rendering ----
const collapsedGroups = new Set();

function renderConnections() {
  connectionList.innerHTML = '';
  const groups = new Map();
  const ungrouped = [];

  connections.forEach((conn) => {
    if (conn.group && conn.group.trim()) {
      const g = conn.group.trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(conn);
    } else {
      ungrouped.push(conn);
    }
  });

  for (const [groupName, conns] of groups) {
    const isCollapsed = collapsedGroups.has(groupName);
    const groupEl = document.createElement('div');
    groupEl.className = 'conn-group';

    const header = document.createElement('div');
    header.className = 'conn-group-header' + (isCollapsed ? ' collapsed' : '');
    header.innerHTML = `
      <span class="group-chevron">&#9660;</span>
      <span class="group-name">${escapeHtml(groupName)}</span>
      <span class="group-count">${conns.length}</span>
    `;
    header.addEventListener('click', () => {
      if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
      else collapsedGroups.add(groupName);
      renderConnections();
    });

    const itemsEl = document.createElement('div');
    itemsEl.className = 'conn-group-items' + (isCollapsed ? ' collapsed' : '');
    conns.forEach((conn) => itemsEl.appendChild(createConnItem(conn)));

    groupEl.appendChild(header);
    groupEl.appendChild(itemsEl);
    connectionList.appendChild(groupEl);
  }

  ungrouped.forEach((conn) => connectionList.appendChild(createConnItem(conn)));
  updateGroupSuggestions();
}

function createConnItem(conn) {
  // Check if any tab is connected to this connection
  let isConnected = false;
  for (const [, tab] of tabs) {
    if (tab.connId === conn.id) { isConnected = true; break; }
  }

  const el = document.createElement('div');
  const isActiveConn = getActiveTab()?.connId === conn.id;
  el.className = 'conn-item' + (isActiveConn ? ' active' : '');
  el.innerHTML = `
    <div class="conn-status ${isConnected ? 'connected' : ''}"></div>
    <span class="conn-name">${escapeHtml(conn.name)}</span>
    <div class="conn-item-actions">
      <button class="edit" title="Edit">&#9998;</button>
      <button class="delete" title="Delete">&times;</button>
    </div>
  `;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.edit')) openEditDialog(conn);
    else if (e.target.closest('.delete')) deleteConnection(conn.id);
    else openTab(conn);
  });
  return el;
}

function updateGroupSuggestions() {
  const datalist = document.getElementById('group-suggestions');
  datalist.innerHTML = '';
  const groupNames = new Set(connections.map(c => c.group).filter(Boolean));
  for (const name of groupNames) {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  }
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
  form.elements.group.value = conn.group || '';
  form.elements.name.value = conn.name;
  form.elements.host.value = conn.host || 'localhost';
  form.elements.port.value = conn.port || 5432;
  form.elements.user.value = conn.user || '';
  form.elements.password.value = conn.password || '';
  form.elements.database.value = conn.database || 'postgres';
  form.elements.sslmode.value = conn.sslmode || '';
  updateGroupSuggestions();
  dialog.showModal();
}

async function deleteConnection(id) {
  connections = connections.filter((c) => c.id !== id);
  await window.api.saveConnections(connections.map(sanitizeConn));
  // Close all tabs for this connection
  for (const [tabId, tab] of tabs) {
    if (tab.connId === id) closeTab(tabId);
  }
  renderConnections();
}

function sanitizeConn(c) {
  const { _connected, ...rest } = c;
  return rest;
}

// ---- Tab management ----
function openTab(conn) {
  // Check if a tab already exists for this connection
  for (const [tabId, tab] of tabs) {
    if (tab.connId === conn.id) {
      switchTab(tabId);
      return;
    }
  }

  // Create new tab
  const tabId = crypto.randomUUID();
  const cleanConn = sanitizeConn(conn);

  const tab = {
    id: tabId,
    connId: conn.id,
    connName: conn.name,
    connection: cleanConn,
    terminal: null,
    fitAddon: null,
    editorView: null,
    editorContent: '',
    resultsHtml: '<div id="results-placeholder">Run a query to see results here.</div>',
    resultsStatusText: '',
    resultsStatusClass: '',
    lastResults: null,
  };

  tabs.set(tabId, tab);
  switchTab(tabId);
  spawnTabTerminal(tab);
  fetchDatabases(cleanConn);
  fetchSchemaForTab(tab);
}

function switchTab(tabId) {
  const prevTab = getActiveTab();

  // Save current tab state
  if (prevTab) {
    // Save editor content
    if (prevTab.editorView) {
      prevTab.editorContent = prevTab.editorView.state.doc.toString();
    }
    // Save results
    prevTab.resultsHtml = resultsContainer.innerHTML;
    prevTab.resultsStatusText = resultsStatus.textContent;
    prevTab.resultsStatusClass = resultsStatus.className;
    // Detach terminal from DOM (don't dispose)
    if (prevTab.terminal && prevTab.terminal.element) {
      prevTab.terminalParent = prevTab.terminal.element.parentElement;
    }
    // Detach editor
    if (prevTab.editorView) {
      prevTab.editorView.dom.remove();
    }
  }

  activeTabId = tabId;
  const tab = tabs.get(tabId);

  // Show session
  welcome.style.display = 'none';
  session.classList.remove('hidden');
  tabBar.classList.remove('hidden');

  // Restore editor
  editorContainer.innerHTML = '';
  if (tab.editorView) {
    editorContainer.appendChild(tab.editorView.dom);
  } else {
    tab.editorView = createEditor(editorContainer, {
      onRun: runQuery,
      onSendTerminal: sendToTerminal,
    });
    if (tab.editorContent) {
      tab.editorView.dispatch({ changes: { from: 0, insert: tab.editorContent } });
    }
  }

  // Restore results
  resultsContainer.innerHTML = tab.resultsHtml;
  resultsStatus.textContent = tab.resultsStatusText;
  resultsStatus.className = tab.resultsStatusClass;
  if (tab.lastResults) {
    showCopyButtons();
  } else {
    hideCopyButtons();
  }

  // Restore terminal
  terminalContainer.innerHTML = '';
  if (tab.terminal) {
    terminalContainer.appendChild(tab.terminal.element);
    requestAnimationFrame(() => { if (tab.fitAddon) tab.fitAddon.fit(); });
  }

  // Update connection info
  const c = tab.connection;
  connectionInfo.textContent = `${c.user || 'postgres'}@${c.host || 'localhost'}:${c.port || 5432}/${c.database || 'postgres'}`;

  // Set terminal height
  requestAnimationFrame(() => {
    const termPanel = document.getElementById('terminal-panel');
    const mainH = document.getElementById('main').getBoundingClientRect().height;
    const tabBarH = tabBar.getBoundingClientRect().height;
    const editorH = editorPanel.getBoundingClientRect().height;
    const resultsH = resultsPanel.getBoundingClientRect().height;
    const handles = 8;
    const remaining = mainH - tabBarH - editorH - resultsH - handles;
    termPanel.style.height = Math.max(80, remaining) + 'px';
    if (tab.fitAddon) tab.fitAddon.fit();
  });

  renderTabs();
  renderConnections();
  if (tab.editorView) tab.editorView.focus();
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Cleanup
  if (tab.terminal) tab.terminal.dispose();
  if (tab.editorView) tab.editorView.destroy();
  window.api.killPty(tab.connId);

  tabs.delete(tabId);

  if (activeTabId === tabId) {
    // Switch to another tab or show welcome
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      switchTab(remaining[remaining.length - 1]);
    } else {
      activeTabId = null;
      welcome.style.display = 'flex';
      session.classList.add('hidden');
      tabBar.classList.add('hidden');
    }
  }

  renderTabs();
  renderConnections();
}

function renderTabs() {
  tabList.innerHTML = '';
  for (const [tabId, tab] of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tabId === activeTabId ? ' active' : '');
    el.innerHTML = `
      <span class="tab-name">${escapeHtml(tab.connName)}</span>
      <span class="tab-close" title="Close tab">&times;</span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        closeTab(tabId);
      } else {
        switchTab(tabId);
      }
    });
    tabList.appendChild(el);
  }
}

// ---- Terminal ----
const XTERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b7066',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
  brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

async function spawnTabTerminal(tab) {
  tab.terminal = new XTerminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    theme: XTERM_THEME,
  });

  tab.fitAddon = new XFitAddon();
  tab.terminal.loadAddon(tab.fitAddon);
  tab.terminal.loadAddon(new XWebLinksAddon());

  // Only show in terminal container if this is the active tab
  if (activeTabId === tab.id) {
    terminalContainer.innerHTML = '';
    tab.terminal.open(terminalContainer);
    requestAnimationFrame(() => tab.fitAddon.fit());
  } else {
    // Open in a detached div so xterm initializes
    const tmp = document.createElement('div');
    tmp.style.position = 'absolute';
    tmp.style.visibility = 'hidden';
    document.body.appendChild(tmp);
    tab.terminal.open(tmp);
    requestAnimationFrame(() => {
      tab.fitAddon.fit();
      tmp.remove();
    });
  }

  // Read-only terminal — only Ctrl+C passes through
  tab.terminal.onData((data) => {
    if (data === '\x03') window.api.writePty(tab.connId, data);
  });

  tab.terminal.onResize(({ cols, rows }) => window.api.resizePty(tab.connId, cols, rows));

  await window.api.spawnPty(tab.connId, tab.connection);
  updateConnectionStatus(tab.connId, true);
}

// ---- New connection dialog ----
btnNewConn.addEventListener('click', () => {
  dialogTitle.textContent = 'New Connection';
  form.reset();
  form.elements.id.value = '';
  form.elements.group.value = '';
  form.elements.host.value = 'localhost';
  form.elements.port.value = '5432';
  form.elements.database.value = 'postgres';
  updateGroupSuggestions();
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

// ---- Query helpers ----
function getRawEditorContent() {
  const tab = getActiveTab();
  return tab?.editorView ? tab.editorView.state.doc.toString().trim() : '';
}

function hasMetacommand(q) {
  return /\\[a-zA-Z+]/.test(q);
}

function getEditorContent() {
  let q = getRawEditorContent();
  if (q && !hasMetacommand(q) && !q.endsWith(';')) q += ';';
  return q;
}

// ---- Run query ----
async function runQuery() {
  const tab = getActiveTab();
  if (!tab) return;
  const query = getEditorContent();
  if (!query) return;

  if (hasMetacommand(query)) {
    sendToTerminal();
    return;
  }

  resultsContainer.innerHTML = '<div class="results-loading"><div class="spinner"></div>Running...</div>';
  resultsStatus.textContent = '';
  resultsStatus.className = '';

  const result = await window.api.executeQuery(tab.connection, query);

  // Only update if still on the same tab
  if (getActiveTab()?.id !== tab.id) return;

  if (result.error) {
    tab.lastResults = null;
    hideCopyButtons();
    resultsContainer.innerHTML = `<div class="results-message error">${escapeHtml(result.error)}</div>`;
    resultsStatus.textContent = `Error (${result.duration}ms)`;
    resultsStatus.className = 'error';
    return;
  }

  if (result.message) {
    tab.lastResults = null;
    hideCopyButtons();
    resultsContainer.innerHTML = `<div class="results-message">${escapeHtml(result.message)}</div>`;
    resultsStatus.textContent = `Done (${result.duration}ms)`;
    resultsStatus.className = 'success';
    return;
  }

  if (result.columns) {
    tab.lastResults = { columns: result.columns, rows: result.rows };
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
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

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
        td.title = cell;
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
  const tab = getActiveTab();
  if (!tab?.lastResults) return;
  const lines = [tab.lastResults.columns.join(',')];
  for (const row of tab.lastResults.rows) {
    lines.push(row.map(cell => {
      if (cell === null || cell === undefined || cell === '') return '';
      const s = String(cell);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  copyWithFeedback(btnCopyCsv, lines.join('\n'));
});

btnCopyJson.addEventListener('click', () => {
  const tab = getActiveTab();
  if (!tab?.lastResults) return;
  const data = tab.lastResults.rows.map(row => {
    const obj = {};
    tab.lastResults.columns.forEach((col, i) => {
      obj[col] = (row[i] === '' || row[i] === undefined) ? null : row[i];
    });
    return obj;
  });
  copyWithFeedback(btnCopyJson, JSON.stringify(data, null, 2));
});

// ---- Send to terminal ----
function sendToTerminal() {
  const tab = getActiveTab();
  if (!tab?.terminal) return;
  const query = getEditorContent();
  if (!query) return;
  window.api.sendQuery(tab.connId, query);
}

btnRun.addEventListener('click', runQuery);
btnSendTerminal.addEventListener('click', sendToTerminal);
btnClear.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab?.editorView) {
    tab.editorView.dispatch({ changes: { from: 0, to: tab.editorView.state.doc.length, insert: '' } });
    tab.editorView.focus();
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
  const tab = getActiveTab();
  if (!tab) return;
  const newDb = dbSelector.value;

  tab.connection = { ...tab.connection, database: newDb };

  const idx = connections.findIndex((c) => c.id === tab.connId);
  if (idx >= 0) {
    connections[idx] = { ...connections[idx], database: newDb };
    await window.api.saveConnections(connections.map(sanitizeConn));
  }

  window.api.killPty(tab.connId);
  await window.api.spawnPty(tab.connId, tab.connection);
  connectionInfo.textContent = `${tab.connection.user || 'postgres'}@${tab.connection.host || 'localhost'}:${tab.connection.port || 5432}/${newDb}`;

  if (tab.terminal) {
    tab.terminal.clear();
    tab.terminal.write(`\x1b[33m[Switched to database: ${newDb}]\x1b[0m\r\n`);
  }

  fetchSchemaForTab(tab);
});

// ---- Schema ----
async function fetchSchemaForTab(tab) {
  try {
    const result = await window.api.executeQuery(tab.connection,
      `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
       ORDER BY table_schema, table_name, ordinal_position`
    );
    if (result.columns && result.rows) {
      const schema = {};
      for (const row of result.rows) {
        const [schemaName, table, column] = row;
        const fullName = `${schemaName}.${table}`;
        if (!schema[fullName]) schema[fullName] = [];
        schema[fullName].push(column);
        if (!schema[table]) schema[table] = [];
        if (!schema[table].includes(column)) schema[table].push(column);
      }
      updateSchema(schema);
      // Recreate editor with updated schema
      if (tab.editorView) {
        const content = tab.editorView.state.doc.toString();
        tab.editorView.destroy();
        if (activeTabId === tab.id) {
          editorContainer.innerHTML = '';
          tab.editorView = createEditor(editorContainer, {
            onRun: runQuery,
            onSendTerminal: sendToTerminal,
          });
        } else {
          const tmp = document.createElement('div');
          tab.editorView = createEditor(tmp, {
            onRun: runQuery,
            onSendTerminal: sendToTerminal,
          });
        }
        if (content) {
          tab.editorView.dispatch({ changes: { from: 0, insert: content } });
        }
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

      const startY = e.clientY;
      const startEditorH = editorPanel.getBoundingClientRect().height;
      const startResultsH = resultsPanel.getBoundingClientRect().height;
      const terminalPanel = document.getElementById('terminal-panel');
      const startTerminalH = terminalPanel.getBoundingClientRect().height;

      const onMouseMove = (e) => {
        if (!isResizing) return;
        const delta = e.clientY - startY;

        if (target === 'editor') {
          const newEditorH = Math.max(60, startEditorH + delta);
          const newResultsH = startResultsH - (newEditorH - startEditorH);
          if (newResultsH < 60) return;
          editorPanel.style.height = newEditorH + 'px';
          resultsPanel.style.height = newResultsH + 'px';
        } else if (target === 'results') {
          const newResultsH = Math.max(60, startResultsH + delta);
          const newTerminalH = startTerminalH - (newResultsH - startResultsH);
          if (newTerminalH < 80) return;
          resultsPanel.style.height = newResultsH + 'px';
          terminalPanel.style.height = newTerminalH + 'px';
        }

        const tab = getActiveTab();
        if (tab?.fitAddon) tab.fitAddon.fit();
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
  const termPanel = document.getElementById('terminal-panel');
  if (termPanel && session && !session.classList.contains('hidden')) {
    const mainH = document.getElementById('main').getBoundingClientRect().height;
    const tabBarH = tabBar.classList.contains('hidden') ? 0 : tabBar.getBoundingClientRect().height;
    const editorH = editorPanel.getBoundingClientRect().height;
    const resultsH = resultsPanel.getBoundingClientRect().height;
    const handles = 8;
    const remaining = mainH - tabBarH - editorH - resultsH - handles;
    termPanel.style.height = Math.max(80, remaining) + 'px';
  }
  const tab = getActiveTab();
  if (tab?.fitAddon) tab.fitAddon.fit();
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
