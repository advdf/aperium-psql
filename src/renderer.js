import { createEditor, updateSchema } from './editor.js';
import yaml from 'js-yaml';

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

// ---- psql backslash commands (loaded once at init for the editor's autocomplete) ----
let psqlMeta = [];

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
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportJson = document.getElementById('btn-export-json');
const btnStop = document.getElementById('btn-stop');
const connSearch = document.getElementById('conn-search');
const terminalPanel = document.getElementById('terminal-panel');
const terminalLabel = document.querySelector('#terminal-panel .terminal-label');

function isShellMode(conn) {
  return conn && conn.terminalMode === 'shell';
}

// ---- Sidebar search ----
connSearch.addEventListener('input', () => {
  // When searching, expand all groups to show matches
  if (connSearch.value.trim()) {
    collapsedGroups.clear();
  }
  renderConnections();
});

// ---- Init ----
async function init() {
  connections = await window.api.listConnections();
  await loadBastionsCache();
  psqlMeta = await window.api.loadPsqlMeta();
  renderConnections();
  setupResizeHandles();

  window.api.onPtyData(({ id, data }) => {
    // Route data to the correct tab's terminal
    for (const [, tab] of tabs) {
      if (tab.ptyId === id && tab.terminal) {
        tab.terminal.write(data);
      }
    }
  });

  window.api.onPtyExit(({ id, exitCode }) => {
    for (const [, tab] of tabs) {
      if (tab.ptyId === id && tab.terminal) {
        const label = isShellMode(tab.connection) ? 'shell' : 'psql';
        tab.terminal.write(`\r\n\x1b[33m[${label} exited with code ${exitCode}]\x1b[0m\r\n`);
        updateConnectionStatus(tab.connId, false);
      }
    }
  });
}

// ---- Query history ----
const MAX_HISTORY = 100;

function addToHistory(query) {
  const tab = getActiveTab();
  if (!tab) return;
  if (!tab.history) tab.history = [];
  const trimmed = query.trim();
  if (!trimmed) return;
  // Don't add duplicates of the last entry
  if (tab.history.length > 0 && tab.history[tab.history.length - 1] === trimmed) return;
  tab.history.push(trimmed);
  if (tab.history.length > MAX_HISTORY) tab.history.shift();
  tab.historyIndex = tab.history.length;
}

function historyPrev() {
  const tab = getActiveTab();
  if (!tab?.history || tab.history.length === 0) return;
  if (tab.historyIndex === undefined) tab.historyIndex = tab.history.length;
  // Save current editor content if at the end
  if (tab.historyIndex === tab.history.length) {
    tab.historySaved = tab.editorView?.state.doc.toString() || '';
  }
  tab.historyIndex = Math.max(0, tab.historyIndex - 1);
  setEditorContent(tab.history[tab.historyIndex]);
}

function historyNext() {
  const tab = getActiveTab();
  if (!tab?.history) return;
  if (tab.historyIndex === undefined) return;
  tab.historyIndex = Math.min(tab.history.length, tab.historyIndex + 1);
  if (tab.historyIndex === tab.history.length) {
    setEditorContent(tab.historySaved || '');
  } else {
    setEditorContent(tab.history[tab.historyIndex]);
  }
}

function setEditorContent(text) {
  const tab = getActiveTab();
  if (!tab?.editorView) return;
  tab.editorView.dispatch({
    changes: { from: 0, to: tab.editorView.state.doc.length, insert: text },
  });
}

function editorCallbacks() {
  return {
    onRun: runQuery,
    onSendTerminal: sendToTerminal,
    onHistoryPrev: historyPrev,
    onHistoryNext: historyNext,
    metaCommands: psqlMeta,
  };
}

// ---- Active tab helpers ----
function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

// ---- Connections rendering ----
const collapsedGroups = new Set();
let groupsInitialized = false;

function collectGroupPaths(node, prefix) {
  for (const [name, child] of node.children) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    collapsedGroups.add(fullPath);
    collectGroupPaths(child, fullPath);
  }
}

function renderConnections() {
  connectionList.innerHTML = '';

  const searchTerm = (connSearch?.value || '').toLowerCase().trim();

  // Filter connections by search
  const filtered = searchTerm
    ? connections.filter(c =>
        (c.name || '').toLowerCase().includes(searchTerm) ||
        (c.host || '').toLowerCase().includes(searchTerm) ||
        (c.group || '').toLowerCase().includes(searchTerm) ||
        (c.database || '').toLowerCase().includes(searchTerm))
    : connections;

  // Build tree from group paths (e.g. "cnpg/dev" -> cnpg -> dev)
  const tree = { children: new Map(), conns: [] };

  filtered.forEach((conn) => {
    if (conn.group && conn.group.trim()) {
      const parts = conn.group.trim().split('/').map(p => p.trim()).filter(Boolean);
      let node = tree;
      for (const part of parts) {
        if (!node.children.has(part)) {
          node.children.set(part, { children: new Map(), conns: [] });
        }
        node = node.children.get(part);
      }
      node.conns.push(conn);
    } else {
      tree.conns.push(conn);
    }
  });

  // Collapse all groups on first render
  if (!groupsInitialized) {
    groupsInitialized = true;
    collectGroupPaths(tree, '');
  }

  // Render tree recursively
  renderGroupNode(tree, connectionList, '', 0);
  updateGroupSuggestions();
}

function countNodeConns(node) {
  let count = node.conns.length;
  for (const [, child] of node.children) {
    count += countNodeConns(child);
  }
  return count;
}

function renderGroupNode(node, container, pathPrefix, depth) {
  // Render child groups
  for (const [name, child] of node.children) {
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    const isCollapsed = collapsedGroups.has(fullPath);
    const total = countNodeConns(child);

    const groupEl = document.createElement('div');
    groupEl.className = 'conn-group';

    const header = document.createElement('div');
    header.className = 'conn-group-header' + (isCollapsed ? ' collapsed' : '');
    header.style.paddingLeft = (10 + depth * 14) + 'px';
    header.innerHTML = `
      <span class="group-chevron">&#9660;</span>
      <span class="group-name">${escapeHtml(name)}</span>
      <span class="group-count">${total}</span>
    `;
    header.addEventListener('click', () => {
      if (collapsedGroups.has(fullPath)) collapsedGroups.delete(fullPath);
      else collapsedGroups.add(fullPath);
      renderConnections();
    });

    const itemsEl = document.createElement('div');
    itemsEl.className = 'conn-group-items' + (isCollapsed ? ' collapsed' : '');

    // Recursively render sub-groups and connections
    renderGroupNode(child, itemsEl, fullPath, depth + 1);

    groupEl.appendChild(header);
    groupEl.appendChild(itemsEl);
    container.appendChild(groupEl);
  }

  // Render connections at this level
  node.conns.forEach((conn) => {
    const item = createConnItem(conn);
    item.style.paddingLeft = (10 + (depth) * 14) + 'px';
    container.appendChild(item);
  });
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
      <button class="conn-new-tab" title="Open in new tab (Cmd+click)">+</button>
      <button class="edit" title="Edit">&#9998;</button>
      <button class="duplicate" title="Duplicate">&#10697;</button>
    </div>
  `;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.edit')) openEditDialog(conn);
    else if (e.target.closest('.duplicate')) openDuplicateDialog(conn);
    else if (e.target.closest('.conn-new-tab')) openTab(conn, true);
    else openTab(conn, e.metaKey || e.ctrlKey);
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

async function openEditDialog(conn) {
  await loadBastionsCache();
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
  renderTunnelForm(conn.tunnel);
  renderShellForm(conn);
  updateGroupSuggestions();
  setDialogDeleteVisibility(true);
  dialog.showModal();
}

async function openDuplicateDialog(conn) {
  await loadBastionsCache();
  dialogTitle.textContent = 'Duplicate Connection';
  form.elements.id.value = '';
  form.elements.group.value = conn.group || '';
  form.elements.name.value = `${conn.name} (copy)`;
  form.elements.host.value = conn.host || 'localhost';
  form.elements.port.value = conn.port || 5432;
  form.elements.user.value = conn.user || '';
  form.elements.password.value = conn.password || '';
  form.elements.database.value = conn.database || 'postgres';
  form.elements.sslmode.value = conn.sslmode || '';
  renderTunnelForm(conn.tunnel);
  renderShellForm(conn);
  updateGroupSuggestions();
  setDialogDeleteVisibility(false);
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
function openTab(conn, forceNew = false) {
  // Switch to existing tab unless forceNew is true
  if (!forceNew) {
    for (const [tabId, tab] of tabs) {
      if (tab.connId === conn.id) {
        switchTab(tabId);
        return;
      }
    }
  }

  // Create new tab
  const tabId = crypto.randomUUID();
  const cleanConn = sanitizeConn(conn);

  const tab = {
    id: tabId,
    ptyId: tabId, // unique per tab so multiple tabs can share a connection
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
    collapsedPanels: { editor: false, results: false, terminal: false },
    history: [],
    historyIndex: 0,
  };

  tabs.set(tabId, tab);
  switchTab(tabId);
  spawnTabTerminal(tab);
  fetchDatabases(cleanConn, tab);
  fetchSchemaForTab(tab);
}

function switchTab(tabId) {
  stopAutoRefresh();
  // Reset stop/run button visibility based on incoming tab
  const incoming = tabs.get(tabId);
  if (incoming?.currentQueryId) {
    btnStop.classList.remove('hidden');
    btnRun.classList.add('hidden');
  } else {
    btnStop.classList.add('hidden');
    btnRun.classList.remove('hidden');
  }
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
    tab.editorView = createEditor(editorContainer, editorCallbacks());
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

  // Restore collapse state
  for (const [name, panel] of Object.entries(panelMap)) {
    const btn = panel.querySelector('.panel-collapse-btn');
    if (tab.collapsedPanels?.[name]) {
      panel.classList.add('panel-collapsed');
      btn?.classList.add('collapsed');
    } else {
      panel.classList.remove('panel-collapsed');
      btn?.classList.remove('collapsed');
    }
  }

  // Restore terminal
  terminalContainer.innerHTML = '';
  if (tab.terminal) {
    terminalContainer.appendChild(tab.terminal.element);
    requestAnimationFrame(() => { if (tab.fitAddon) tab.fitAddon.fit(); });
  }

  // Update connection info
  const c = tab.connection;
  connectionInfo.textContent = formatConnectionInfo(c);
  applyTerminalChrome(tab);

  // Restore database selector for this tab
  if (tab.databases) {
    renderDbSelector(tab.databases, c.database || 'postgres');
  } else {
    dbSelector.innerHTML = '';
  }

  // Distribute panel space
  requestAnimationFrame(() => {
    redistributePanelSpace();
    if (tab.fitAddon) tab.fitAddon.fit();
  });

  renderTabs();
  renderConnections();
  if (tab.editorView) tab.editorView.focus();
}

function closeTab(tabId) {
  stopAutoRefresh();
  const tab = tabs.get(tabId);
  if (!tab) return;

  // Cleanup
  if (tab.terminal) tab.terminal.dispose();
  if (tab.editorView) tab.editorView.destroy();
  window.api.killPty(tab.ptyId);

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

  // Count occurrences per connId to add suffixes when same conn is opened multiple times
  const counts = new Map();
  const seenIndex = new Map();
  for (const [, tab] of tabs) {
    counts.set(tab.connId, (counts.get(tab.connId) || 0) + 1);
  }

  for (const [tabId, tab] of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tabId === activeTabId ? ' active' : '');

    let label = tab.connName;
    if (counts.get(tab.connId) > 1) {
      const idx = (seenIndex.get(tab.connId) || 0) + 1;
      seenIndex.set(tab.connId, idx);
      label = `${tab.connName} (${idx})`;
    }

    el.innerHTML = `
      <span class="tab-name">${escapeHtml(label)}</span>
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

  // Forward all keystrokes to the PTY in both psql and shell mode. The user can
  // now type queries directly in the terminal in addition to using the editor.
  tab.terminal.onData((data) => window.api.writePty(tab.ptyId, data));

  tab.terminal.onResize(({ cols, rows }) => window.api.resizePty(tab.ptyId, cols, rows));

  await window.api.spawnPty(tab.ptyId, tab.connection);
  updateConnectionStatus(tab.connId, true);
}

function applyTerminalChrome(tab) {
  const shellMode = tab && isShellMode(tab.connection);
  if (terminalLabel) terminalLabel.textContent = shellMode ? 'Shell' : 'psql terminal';
  if (btnSendTerminal) btnSendTerminal.classList.toggle('hidden', !!shellMode);
}

function formatConnectionInfo(conn) {
  if (!conn) return '';
  if (isShellMode(conn)) {
    const hops = conn.tunnel?.hops || [];
    const idx = Number.isInteger(conn.shellHopIndex)
      ? conn.shellHopIndex
      : Math.max(0, hops.length - 1);
    const hop = hops[idx];
    const bastion = hop?.bastionId ? bastionsCache.find((b) => b.id === hop.bastionId) : null;
    const user = bastion?.user || hop?.user || 'ssh';
    const host = bastion?.host || hop?.host || '?';
    const port = bastion?.port || hop?.port || 22;
    return `${user}@${host}:${port} (hop ${idx + 1}/${hops.length})`;
  }
  return `${conn.user || 'postgres'}@${conn.host || 'localhost'}:${conn.port || 5432}/${conn.database || 'postgres'}`;
}

// ---- Snippets ----
let activeSnippets = null; // will be loaded from file or fallback to built-in

const BUILTIN_SNIPPETS = [
  {
    category: 'Locks & Blocking',
    queries: [
      {
        name: 'Who blocks who',
        desc: 'Show blocking and blocked queries with PIDs',
        sql: `SELECT
  blocked_locks.pid AS blocked_pid,
  blocked_activity.usename AS blocked_user,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.usename AS blocking_user,
  blocked_activity.query AS blocked_query,
  blocking_activity.query AS blocking_query,
  blocked_activity.wait_event_type,
  now() - blocked_activity.query_start AS blocked_duration
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted
ORDER BY blocked_duration DESC`
      },
      {
        name: 'Current locks',
        desc: 'All locks currently held or awaited',
        sql: `SELECT
  l.pid,
  a.usename,
  l.locktype,
  l.mode,
  l.granted,
  CASE WHEN l.relation IS NOT NULL THEN l.relation::regclass::text ELSE NULL END AS relation,
  a.query,
  now() - a.query_start AS duration
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE a.pid != pg_backend_pid()
ORDER BY l.granted, a.query_start`
      },
    ]
  },
  {
    category: 'Active Queries',
    queries: [
      {
        name: 'Running queries',
        desc: 'All currently executing queries with duration',
        sql: `SELECT
  pid,
  usename,
  datname,
  state,
  wait_event_type,
  wait_event,
  now() - query_start AS duration,
  query
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY query_start`
      },
      {
        name: 'Long running queries (> 1min)',
        desc: 'Queries running for more than 1 minute',
        sql: `SELECT
  pid,
  usename,
  datname,
  state,
  now() - query_start AS duration,
  wait_event_type,
  query
FROM pg_stat_activity
WHERE state != 'idle'
  AND now() - query_start > interval '1 minute'
  AND pid != pg_backend_pid()
ORDER BY query_start`
      },
      {
        name: 'Idle in transaction',
        desc: 'Connections stuck in "idle in transaction" state',
        sql: `SELECT
  pid,
  usename,
  datname,
  now() - state_change AS idle_duration,
  now() - xact_start AS xact_duration,
  query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start`
      },
    ]
  },
  {
    category: 'Index Health',
    queries: [
      {
        name: 'Index bloat estimation',
        desc: 'Estimate bloat ratio for all indexes',
        sql: `SELECT
  schemaname || '.' || tablename AS table,
  indexname AS index,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan AS scans,
  idx_tup_read AS tuples_read,
  idx_tup_fetch AS tuples_fetched
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 30`
      },
      {
        name: 'Unused indexes',
        desc: 'Indexes that have never been scanned',
        sql: `SELECT
  schemaname || '.' || relname AS table,
  indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
  idx_scan AS scans
FROM pg_stat_user_indexes ui
JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE idx_scan = 0
  AND NOT indisunique
  AND NOT indisprimary
ORDER BY pg_relation_size(i.indexrelid) DESC`
      },
      {
        name: 'Duplicate indexes',
        desc: 'Indexes with identical column definitions',
        sql: `SELECT
  pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS total_size,
  array_agg(idx::regclass::text) AS indexes,
  (array_agg(indrelid))[1]::regclass AS table
FROM (
  SELECT indexrelid AS idx, indrelid, indkey
  FROM pg_index
  WHERE indrelid::regclass::text NOT LIKE 'pg_%'
) sub
GROUP BY indrelid, indkey
HAVING count(*) > 1
ORDER BY sum(pg_relation_size(idx)) DESC`
      },
    ]
  },
  {
    category: 'Table Stats',
    queries: [
      {
        name: 'Table sizes',
        desc: 'All tables sorted by total size (table + indexes + toast)',
        sql: `SELECT
  schemaname || '.' || relname AS table,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS indexes_toast,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  CASE WHEN n_live_tup > 0
    THEN round(100.0 * n_dead_tup / n_live_tup, 1)
    ELSE 0
  END AS dead_ratio_pct
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 30`
      },
      {
        name: 'Table bloat (dead tuples)',
        desc: 'Tables with highest dead tuple ratio — candidates for VACUUM',
        sql: `SELECT
  schemaname || '.' || relname AS table,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  CASE WHEN n_live_tup > 0
    THEN round(100.0 * n_dead_tup / n_live_tup, 1)
    ELSE 0
  END AS dead_ratio_pct,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC
LIMIT 30`
      },
      {
        name: 'Sequential scan heavy tables',
        desc: 'Tables with most sequential scans vs index scans',
        sql: `SELECT
  schemaname || '.' || relname AS table,
  seq_scan,
  seq_tup_read,
  idx_scan,
  CASE WHEN (seq_scan + idx_scan) > 0
    THEN round(100.0 * seq_scan / (seq_scan + idx_scan), 1)
    ELSE 0
  END AS seq_pct,
  pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan + idx_scan > 0
ORDER BY seq_scan DESC
LIMIT 30`
      },
    ]
  },
  {
    category: 'Connections & Server',
    queries: [
      {
        name: 'Connection count by state',
        desc: 'Number of connections grouped by state and user',
        sql: `SELECT
  usename,
  datname,
  state,
  count(*) AS connections,
  max(now() - state_change) AS max_idle_time
FROM pg_stat_activity
GROUP BY usename, datname, state
ORDER BY connections DESC`
      },
      {
        name: 'Connection limits',
        desc: 'Current connections vs max_connections',
        sql: `SELECT
  current_setting('max_connections')::int AS max_connections,
  (SELECT count(*) FROM pg_stat_activity) AS current_connections,
  (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active,
  (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') AS idle,
  (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction') AS idle_in_transaction`
      },
      {
        name: 'Database sizes',
        desc: 'Size of each database on this server',
        sql: `SELECT
  datname,
  pg_size_pretty(pg_database_size(datname)) AS size
FROM pg_database
WHERE datistemplate = false
ORDER BY pg_database_size(datname) DESC`
      },
    ]
  },
  {
    category: 'Replication',
    queries: [
      {
        name: 'Replication status',
        desc: 'Streaming replication lag and state',
        sql: `SELECT
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  flush_lsn,
  replay_lsn,
  pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS replay_lag,
  sync_state
FROM pg_stat_replication`
      },
    ]
  },
  {
    category: 'Cache & Performance',
    queries: [
      {
        name: 'Cache hit ratio',
        desc: 'Buffer cache hit ratio — should be > 99%',
        sql: `SELECT
  datname,
  blks_hit,
  blks_read,
  CASE WHEN blks_hit + blks_read > 0
    THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
    ELSE 0
  END AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = current_database()`
      },
      {
        name: 'Table cache hit ratio',
        desc: 'Per-table cache hit ratio',
        sql: `SELECT
  schemaname || '.' || relname AS table,
  heap_blks_hit,
  heap_blks_read,
  CASE WHEN heap_blks_hit + heap_blks_read > 0
    THEN round(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2)
    ELSE 0
  END AS hit_ratio,
  pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_statio_user_tables
WHERE heap_blks_hit + heap_blks_read > 0
ORDER BY heap_blks_read DESC
LIMIT 30`
      },
    ]
  },
];

const btnSnippets = document.getElementById('btn-snippets');
const snippetsMenu = document.getElementById('snippets-menu');

async function loadSnippetsFromFile() {
  const saved = await window.api.loadSnippets();
  activeSnippets = saved || BUILTIN_SNIPPETS;
  buildSnippetsMenu();
}

function buildSnippetsMenu() {
  snippetsMenu.innerHTML = '';

  for (const cat of activeSnippets) {
    const catEl = document.createElement('div');
    catEl.className = 'snippets-category';
    catEl.textContent = cat.category;
    snippetsMenu.appendChild(catEl);

    for (const q of cat.queries) {
      const item = document.createElement('div');
      item.className = 'snippet-item';
      item.innerHTML = `<span class="snippet-name">${escapeHtml(q.name)}</span><span class="snippet-desc">${escapeHtml(q.desc)}</span>`;
      item.addEventListener('click', () => {
        loadSnippet(q.sql);
        snippetsMenu.classList.add('hidden');
      });
      snippetsMenu.appendChild(item);
    }
  }

  // Separator + edit button
  const sep = document.createElement('div');
  sep.className = 'snippets-category';
  sep.style.borderTop = '1px solid var(--border)';
  sep.innerHTML = '&nbsp;';
  snippetsMenu.appendChild(sep);

  const editItem = document.createElement('div');
  editItem.className = 'snippet-item snippet-edit-btn';
  editItem.innerHTML = `<span class="snippet-name">Edit snippets file...</span><span class="snippet-desc">Open the JSON file in your editor to add/modify snippets</span>`;
  editItem.addEventListener('click', async () => {
    snippetsMenu.classList.add('hidden');
    const result = await window.api.openSnippetsInEditor();
    if (result.needsInit) {
      await window.api.saveSnippets(BUILTIN_SNIPPETS);
      await window.api.openSnippetsInEditor();
    }
  });
  snippetsMenu.appendChild(editItem);

  const reloadItem = document.createElement('div');
  reloadItem.className = 'snippet-item';
  reloadItem.innerHTML = `<span class="snippet-name">Reload snippets</span><span class="snippet-desc">Reload after editing the file</span>`;
  reloadItem.addEventListener('click', async () => {
    snippetsMenu.classList.add('hidden');
    await loadSnippetsFromFile();
  });
  snippetsMenu.appendChild(reloadItem);
}

function loadSnippet(sql) {
  const tab = getActiveTab();
  if (!tab?.editorView) return;
  tab.editorView.dispatch({
    changes: { from: 0, to: tab.editorView.state.doc.length, insert: sql.trim() },
  });
  tab.editorView.focus();
}

btnSnippets.addEventListener('click', (e) => {
  e.stopPropagation();
  snippetsMenu.classList.toggle('hidden');
});

// Close menu on click outside
document.addEventListener('click', (e) => {
  if (!snippetsMenu.contains(e.target) && e.target !== btnSnippets) {
    snippetsMenu.classList.add('hidden');
  }
});

loadSnippetsFromFile();

// ---- ERD Schema Viewer ----
const erdOverlay = document.getElementById('erd-overlay');
const erdCanvas = document.getElementById('erd-canvas');
const erdLines = document.getElementById('erd-lines');
const erdViewport = document.getElementById('erd-viewport');
const erdStatus = document.getElementById('erd-status');
const btnSchema = document.getElementById('btn-schema');
const btnErdClose = document.getElementById('erd-close');
const btnErdZoomReset = document.getElementById('erd-zoom-reset');

let erdState = { scale: 1, tx: 0, ty: 0, tables: [], fks: [] };

btnSchema.addEventListener('click', openERD);
btnErdClose.addEventListener('click', closeERD);
btnErdZoomReset.addEventListener('click', () => fitERDToView());

const btnErdCompact = document.getElementById('erd-compact');
const btnErdSpread = document.getElementById('erd-spread-btn');

function spreadERD(factor) {
  const tables = erdCanvas.querySelectorAll('.erd-table');
  if (!tables.length) return;

  // Find center of all tables
  let cx = 0, cy = 0;
  const positions = [];
  for (const el of tables) {
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    positions.push({ el, x, y });
    cx += x;
    cy += y;
  }
  cx /= tables.length;
  cy /= tables.length;

  // Scale positions from center
  for (const p of positions) {
    p.el.style.left = (cx + (p.x - cx) * factor) + 'px';
    p.el.style.top = (cy + (p.y - cy) * factor) + 'px';
  }

  // Resize schema zones to fit
  const zones = erdCanvas.querySelectorAll('.erd-schema-zone');
  for (const zone of zones) {
    const zx = parseFloat(zone.style.left) || 0;
    const zy = parseFloat(zone.style.top) || 0;
    const zw = parseFloat(zone.style.width) || 0;
    const zh = parseFloat(zone.style.height) || 0;
    const zcx = zx + zw / 2;
    const zcy = zy + zh / 2;
    zone.style.left = (cx + (zcx - cx) * factor - zw * factor / 2) + 'px';
    zone.style.top = (cy + (zcy - cy) * factor - zh * factor / 2) + 'px';
    zone.style.width = (zw * factor) + 'px';
    zone.style.height = (zh * factor) + 'px';
  }

  updateERDLines();
}

btnErdSpread.addEventListener('click', () => { spreadERD(1.2); fitERDToView(); });
btnErdCompact.addEventListener('click', () => { spreadERD(0.8); fitERDToView(); });

function fitERDToView() {
  requestAnimationFrame(() => {
    // Measure total content bounds
    const allEls = erdCanvas.querySelectorAll('.erd-table, .erd-schema-zone');
    if (!allEls.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of allEls) {
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      const w = el.offsetWidth || parseFloat(el.style.width) || 0;
      const h = el.offsetHeight || parseFloat(el.style.height) || 0;
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + w);
      maxY = Math.max(maxY, top + h);
    }

    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const vpRect = erdViewport.getBoundingClientRect();
    const margin = 40;

    const scaleX = (vpRect.width - margin * 2) / contentW;
    const scaleY = (vpRect.height - margin * 2) / contentH;
    erdState.scale = Math.min(1, Math.min(scaleX, scaleY));

    erdState.tx = margin + (vpRect.width - margin * 2 - contentW * erdState.scale) / 2 - minX * erdState.scale;
    erdState.ty = margin + (vpRect.height - margin * 2 - contentH * erdState.scale) / 2 - minY * erdState.scale;

    applyERDTransform();
    updateERDLines();
  });
}

async function openERD() {
  const tab = getActiveTab();
  if (!tab) return;

  erdOverlay.classList.remove('hidden');
  erdCanvas.innerHTML = '';
  erdLines.innerHTML = '';
  erdStatus.textContent = 'Loading schema...';

  const sf = (alias) => `${alias} NOT IN ('information_schema') AND ${alias} NOT LIKE 'pg\\_%'`;

  const schemaQuery = `
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.ordinal_position,
      c.character_maximum_length,
      c.is_nullable
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    WHERE ${sf('c.table_schema')} AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position
  `;

  const pkQuery = `
    SELECT tc.table_schema, kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND ${sf('tc.table_schema')}
  `;

  const fkQuery = `
    SELECT
      kcu.table_schema AS from_schema,
      kcu.table_name AS from_table,
      kcu.column_name AS from_column,
      ccu.table_schema AS to_schema,
      ccu.table_name AS to_table,
      ccu.column_name AS to_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ${sf('tc.table_schema')}
  `;

  const [colResult, pkResult, fkResult] = await Promise.all([
    window.api.executeQuery(tab.connection, schemaQuery),
    window.api.executeQuery(tab.connection, pkQuery),
    window.api.executeQuery(tab.connection, fkQuery),
  ]);

  if (colResult.error) {
    erdStatus.textContent = 'Error: ' + colResult.error;
    return;
  }

  // Parse columns into tables (keyed by schema.table)
  const tables = new Map();
  const schemas = new Set();
  for (const row of (colResult.rows || [])) {
    const [schemaName, tableName, colName, dataType, , maxLen, nullable] = row;
    const key = `${schemaName}.${tableName}`;
    schemas.add(schemaName);
    if (!tables.has(key)) tables.set(key, { name: tableName, schema: schemaName, key, columns: [] });
    let typeStr = dataType;
    if (maxLen) typeStr += `(${maxLen})`;
    tables.get(key).columns.push({ name: colName, type: typeStr, pk: false, fk: false, nullable: nullable === 'YES' });
  }

  // Show schema prefix only if there are multiple schemas
  const multiSchema = schemas.size > 1;

  // Mark PKs
  for (const row of (pkResult.rows || [])) {
    const [schemaName, tableName, colName] = row;
    const t = tables.get(`${schemaName}.${tableName}`);
    if (t) {
      const col = t.columns.find(c => c.name === colName);
      if (col) col.pk = true;
    }
  }

  // Parse FKs
  const fks = [];
  for (const row of (fkResult.rows || [])) {
    const [fromSchema, fromTable, fromCol, toSchema, toTable, toCol] = row;
    const fromKey = `${fromSchema}.${fromTable}`;
    const toKey = `${toSchema}.${toTable}`;
    fks.push({ fromTable: fromKey, fromCol, toTable: toKey, toCol });
    const t = tables.get(fromKey);
    if (t) {
      const col = t.columns.find(c => c.name === fromCol);
      if (col) { col.fk = true; col.fkRef = `${toTable}.${toCol}`; }
    }
  }

  erdState.tables = [...tables.values()];
  erdState.fks = fks;
  erdState.multiSchema = multiSchema;
  erdState.scale = 1;
  erdState.tx = 20;
  erdState.ty = 20;

  const schemaInfo = multiSchema ? ` across ${schemas.size} schemas` : '';
  erdStatus.textContent = `${tables.size} tables, ${fks.length} foreign keys${schemaInfo}`;
  renderERD();
  fitERDToView();
}

function closeERD() {
  erdOverlay.classList.add('hidden');
  closeERDDetail();
}

function estimateTableHeight(table, colsPerTable) {
  const shown = Math.min(table.columns.length, colsPerTable);
  return 30 + shown * 22 + (table.columns.length > colsPerTable ? 22 : 0);
}

function forceDirectedLayout(tables, fks, tableWidth, colsPerTable) {
  // Initialize positions in a circle
  const nodes = tables.map((t, i) => {
    const angle = (2 * Math.PI * i) / tables.length;
    const radius = Math.max(200, tables.length * 25);
    return {
      key: t.key,
      table: t,
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      w: tableWidth,
      h: estimateTableHeight(t, colsPerTable),
      vx: 0,
      vy: 0,
    };
  });

  if (nodes.length <= 1) {
    if (nodes.length === 1) { nodes[0].x = 0; nodes[0].y = 0; }
    return nodes;
  }

  const nodeMap = new Map(nodes.map(n => [n.key, n]));

  // Build edge list (within this group)
  const edges = [];
  for (const fk of fks) {
    const from = nodeMap.get(fk.fromTable);
    const to = nodeMap.get(fk.toTable);
    if (from && to && from !== to) edges.push({ from, to });
  }

  const iterations = 300;
  const idealDist = 190;
  const repulsion = 40000;
  const attraction = 0.006;
  const damping = 0.85;
  const minDist = 20;

  // Identify which nodes have edges
  const hasEdge = new Set();
  for (const edge of edges) { hasEdge.add(edge.from.key); hasEdge.add(edge.to.key); }

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations; // cooling

    // Gravity toward center (stronger for orphan nodes)
    let cx = 0, cy = 0;
    for (const n of nodes) { cx += n.x; cy += n.y; }
    cx /= nodes.length;
    cy /= nodes.length;
    for (const n of nodes) {
      const gravity = hasEdge.has(n.key) ? 0.002 : 0.01;
      n.vx += (cx - n.x) * gravity * temp;
      n.vy += (cy - n.y) * gravity * temp;
    }

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) { dist = minDist; dx = minDist; dy = 0; }

        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force * temp;
        const fy = (dy / dist) * force * temp;

        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const dx = edge.to.x - edge.from.x;
      const dy = edge.to.y - edge.from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const force = attraction * (dist - idealDist) * temp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      edge.from.vx += fx;
      edge.from.vy += fy;
      edge.to.vx -= fx;
      edge.to.vy -= fy;
    }

    // Overlap repulsion (rectangle-aware)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const overlapX = (a.w / 2 + b.w / 2 + 20) - Math.abs(b.x - a.x);
        const overlapY = (a.h / 2 + b.h / 2 + 20) - Math.abs(b.y - a.y);
        if (overlapX > 0 && overlapY > 0) {
          const pushX = overlapX * 0.5 * temp;
          const pushY = overlapY * 0.5 * temp;
          if (overlapX < overlapY) {
            const sign = b.x >= a.x ? 1 : -1;
            a.vx -= sign * pushX;
            b.vx += sign * pushX;
          } else {
            const sign = b.y >= a.y ? 1 : -1;
            a.vy -= sign * pushY;
            b.vy += sign * pushY;
          }
        }
      }
    }

    // Apply velocities
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // Normalize: shift so min x/y is 0
  let minX = Infinity, minY = Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); }
  for (const n of nodes) { n.x -= minX; n.y -= minY; }

  return nodes;
}

function renderERD() {
  erdCanvas.innerHTML = '';
  erdLines.innerHTML = '';
  erdState.schemaZones = [];

  const tableEls = new Map();
  const colsPerTable = 20;
  const tableWidth = 220;
  const schemaPadding = 20;
  const schemaPaddingTop = 36;
  const schemaGap = 40;

  // Group tables by schema
  const schemaGroups = new Map();
  for (const table of erdState.tables) {
    if (!schemaGroups.has(table.schema)) schemaGroups.set(table.schema, []);
    schemaGroups.get(table.schema).push(table);
  }

  let globalY = 0;

  for (const [schemaName, tables] of schemaGroups) {
    // Run force-directed layout for this schema group
    const schemaFks = erdState.fks.filter(fk =>
      tables.some(t => t.key === fk.fromTable) || tables.some(t => t.key === fk.toTable)
    );
    const nodes = forceDirectedLayout(tables, schemaFks, tableWidth, colsPerTable);

    // Render tables at computed positions
    let maxX = 0, maxY = 0;

    for (const node of nodes) {
      const table = node.table;
      const posX = schemaPadding + node.x;
      const posY = globalY + schemaPaddingTop + node.y;

      const el = document.createElement('div');
      el.className = 'erd-table';
      el.style.left = posX + 'px';
      el.style.top = posY + 'px';
      el.style.width = tableWidth + 'px';

      const header = document.createElement('div');
      header.className = 'erd-table-header';
      header.textContent = table.name;
      el.appendChild(header);

      const shownCols = table.columns.slice(0, colsPerTable);
      for (const c of shownCols) {
        const colEl = document.createElement('div');
        colEl.className = 'erd-column';
        if (c.pk) colEl.classList.add('is-pk');
        if (c.fk) colEl.classList.add('is-fk');
        colEl.setAttribute('data-table', table.key);
        colEl.setAttribute('data-column', c.name);

        let badges = '';
        if (c.pk) badges += '<span class="col-badge pk">PK</span>';
        if (c.fk) badges += '<span class="col-badge fk">FK</span>';

        colEl.innerHTML = `${badges}<span class="col-name">${escapeHtml(c.name)}</span><span class="col-type">${escapeHtml(c.type)}</span>`;
        if (c.fkRef) colEl.title = `\u2192 ${c.fkRef}`;
        el.appendChild(colEl);
      }

      if (table.columns.length > colsPerTable) {
        const more = document.createElement('div');
        more.className = 'erd-column';
        more.innerHTML = `<span class="col-name" style="color:var(--text-dim)">... ${table.columns.length - colsPerTable} more</span>`;
        el.appendChild(more);
      }

      erdCanvas.appendChild(el);
      tableEls.set(table.key, el);
      makeERDDraggable(el, header, table);

      maxX = Math.max(maxX, node.x + tableWidth);
      maxY = Math.max(maxY, node.y + node.h);
    }

    // Schema background zone
    const zone = document.createElement('div');
    zone.className = 'erd-schema-zone';
    zone.style.left = '0px';
    zone.style.top = globalY + 'px';
    zone.style.width = (maxX + schemaPadding * 2) + 'px';
    zone.style.height = (maxY + schemaPaddingTop + schemaPadding) + 'px';

    const label = document.createElement('div');
    label.className = 'erd-schema-label';
    label.textContent = schemaName;
    zone.appendChild(label);

    erdCanvas.insertBefore(zone, erdCanvas.firstChild);

    // Store zone bounds for nav
    if (!erdState.schemaZones) erdState.schemaZones = [];
    erdState.schemaZones.push({
      name: schemaName,
      x: 0,
      y: globalY,
      w: maxX + schemaPadding * 2,
      h: maxY + schemaPaddingTop + schemaPadding,
      tableCount: tables.length,
    });

    globalY += maxY + schemaPaddingTop + schemaPadding + schemaGap;
  }

  erdState.tableEls = tableEls;
  applyERDTransform();
  buildSchemaNav();
  requestAnimationFrame(() => updateERDLines());
}

const erdSchemaNav = document.getElementById('erd-schema-nav');

function buildSchemaNav() {
  erdSchemaNav.innerHTML = '';
  if (!erdState.schemaZones || erdState.schemaZones.length <= 1) return;

  for (const zone of erdState.schemaZones) {
    const btn = document.createElement('button');
    btn.className = 'erd-nav-item';
    btn.innerHTML = `${escapeHtml(zone.name)}<span class="nav-count">(${zone.tableCount})</span>`;
    btn.addEventListener('click', () => focusSchema(zone));
    erdSchemaNav.appendChild(btn);
  }
}

function focusSchema(zone) {
  const vpRect = erdViewport.getBoundingClientRect();
  const margin = 30;

  const scaleX = (vpRect.width - margin * 2) / zone.w;
  const scaleY = (vpRect.height - margin * 2) / zone.h;
  erdState.scale = Math.min(1, Math.min(scaleX, scaleY));

  erdState.tx = margin + (vpRect.width - margin * 2 - zone.w * erdState.scale) / 2 - zone.x * erdState.scale;
  erdState.ty = margin + (vpRect.height - margin * 2 - zone.h * erdState.scale) / 2 - zone.y * erdState.scale;

  applyERDTransform();
  updateERDLines();
}

// ---- ERD table detail panel ----
const erdDetail = document.getElementById('erd-detail');

function closeERDDetail() {
  erdDetail.classList.add('hidden');
}

async function showTableDetail(table) {
  const tab = getActiveTab();
  if (!tab) return;

  erdDetail.classList.remove('hidden');
  erdDetail.innerHTML = `
    <div class="erd-detail-header">
      <h3>${escapeHtml(table.schema)}.${escapeHtml(table.name)}</h3>
      <button class="erd-detail-close" title="Close">&times;</button>
    </div>
    <div class="erd-detail-body">
      <div class="erd-detail-section">
        <div class="erd-detail-section-title">Indexes</div>
        <div class="erd-detail-empty">Loading...</div>
      </div>
    </div>
  `;

  erdDetail.querySelector('.erd-detail-close').addEventListener('click', closeERDDetail);

  const schemaLit = `'${table.schema.replace(/'/g, "''")}'`;
  const tableLit = `'${table.name.replace(/'/g, "''")}'`;

  const indexQuery = `
    SELECT
      i.relname AS index_name,
      am.amname AS index_type,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,
      pg_get_indexdef(ix.indexrelid) AS index_def,
      pg_size_pretty(pg_relation_size(ix.indexrelid)) AS index_size
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${schemaLit}
      AND t.relname = ${tableLit}
    ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname
  `;

  const ownerQuery = `
    SELECT tableowner FROM pg_tables
    WHERE schemaname = ${schemaLit} AND tablename = ${tableLit}
  `;

  const [result, ownerResult] = await Promise.all([
    window.api.executeQuery(tab.connection, indexQuery),
    window.api.executeQuery(tab.connection, ownerQuery),
  ]);

  const body = erdDetail.querySelector('.erd-detail-body');
  if (!body) return;

  const owner = ownerResult.rows?.[0]?.[0];
  const ownerHtml = owner
    ? `<div class="erd-detail-meta">Owner: <span class="erd-detail-meta-value">${escapeHtml(owner)}</span></div>`
    : '';

  let indexHtml = '<div class="erd-detail-section"><div class="erd-detail-section-title">Indexes</div>';

  if (result.error) {
    indexHtml += `<div class="erd-detail-empty">Error: ${escapeHtml(result.error)}</div>`;
  } else if (!result.rows || result.rows.length === 0) {
    indexHtml += '<div class="erd-detail-empty">No indexes</div>';
  } else {
    for (const row of result.rows) {
      const [name, type, isUnique, isPrimary, def, size] = row;
      let badges = '';
      if (isPrimary === 't' || isPrimary === true) badges += '<span class="erd-detail-index-badge primary">PK</span>';
      else if (isUnique === 't' || isUnique === true) badges += '<span class="erd-detail-index-badge unique">Unique</span>';
      badges += `<span class="erd-detail-index-badge ${type}">${escapeHtml(type)}</span>`;

      // Extract columns from the def (between parentheses)
      const colMatch = def.match(/\(([^)]+)\)/);
      const cols = colMatch ? colMatch[1] : '';

      indexHtml += `
        <div class="erd-detail-index">
          <div class="erd-detail-index-name">${escapeHtml(name)}</div>
          <div class="erd-detail-index-info">${badges} <span style="font-size:10px;color:var(--text-dim)">${escapeHtml(size)}</span></div>
          <div class="erd-detail-index-def">${escapeHtml(cols)}</div>
        </div>
      `;
    }
  }
  indexHtml += '</div>';

  // Also show columns summary
  let colsHtml = '<div class="erd-detail-section"><div class="erd-detail-section-title">Columns</div>';
  for (const col of table.columns) {
    let badges = '';
    if (col.pk) badges += '<span class="col-badge pk" style="font-size:9px">PK</span> ';
    if (col.fk) badges += '<span class="col-badge fk" style="font-size:9px">FK</span> ';
    const nullable = col.nullable ? '<span style="color:var(--text-dim);font-size:10px"> null</span>' : '';
    colsHtml += `<div style="font-size:11px;font-family:var(--font-mono);padding:2px 0;display:flex;gap:4px;align-items:center">${badges}<span style="color:var(--text)">${escapeHtml(col.name)}</span> <span style="color:var(--text-dim);font-size:10px">${escapeHtml(col.type)}</span>${nullable}</div>`;
  }
  colsHtml += '</div>';

  body.innerHTML = ownerHtml + indexHtml + colsHtml;
}

function makeERDDraggable(el, handle, table) {
  let startX, startY, origLeft, origTop, hasMoved;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseInt(el.style.left) || 0;
    origTop = parseInt(el.style.top) || 0;
    hasMoved = false;
    handle.setPointerCapture(e.pointerId);

    const onMove = (e) => {
      const dx = (e.clientX - startX) / erdState.scale;
      const dy = (e.clientY - startY) / erdState.scale;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      el.style.left = (origLeft + dx) + 'px';
      el.style.top = (origTop + dy) + 'px';
      updateERDLines();
    };

    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      if (!hasMoved && table) showTableDetail(table);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function updateERDLines() {
  erdLines.innerHTML = '';
  const vpRect = erdViewport.getBoundingClientRect();

  for (const fk of erdState.fks) {
    const fromEl = erdCanvas.querySelector(`[data-table="${fk.fromTable}"][data-column="${fk.fromCol}"]`);
    const toEl = erdCanvas.querySelector(`[data-table="${fk.toTable}"][data-column="${fk.toCol}"]`);
    if (!fromEl || !toEl) continue;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const x1 = fromRect.right - vpRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - vpRect.top;
    const x2 = toRect.left - vpRect.left;
    const y2 = toRect.top + toRect.height / 2 - vpRect.top;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);

    const fromTableName = fk.fromTable;
    const toTableName = fk.toTable;
    line.addEventListener('mouseenter', () => {
      line.classList.add('fk-line-hover');
      erdState.tableEls?.get(fromTableName)?.style.setProperty('border-color', 'var(--accent)');
      erdState.tableEls?.get(toTableName)?.style.setProperty('border-color', 'var(--accent)');
    });
    line.addEventListener('mouseleave', () => {
      line.classList.remove('fk-line-hover');
      erdState.tableEls?.get(fromTableName)?.style.removeProperty('border-color');
      erdState.tableEls?.get(toTableName)?.style.removeProperty('border-color');
    });
    line.style.pointerEvents = 'stroke';
    line.style.cursor = 'pointer';

    erdLines.appendChild(line);
  }
}

function applyERDTransform() {
  erdCanvas.style.transform = `translate(${erdState.tx}px, ${erdState.ty}px) scale(${erdState.scale})`;
}

// Pan
let isPanning = false, panStartX, panStartY, panStartTx, panStartTy;

erdViewport.addEventListener('pointerdown', (e) => {
  if (e.target !== erdViewport && e.target !== erdCanvas) return;
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartTx = erdState.tx;
  panStartTy = erdState.ty;
  erdViewport.classList.add('grabbing');
  erdViewport.setPointerCapture(e.pointerId);
});

erdViewport.addEventListener('pointermove', (e) => {
  if (!isPanning) return;
  erdState.tx = panStartTx + (e.clientX - panStartX);
  erdState.ty = panStartTy + (e.clientY - panStartY);
  applyERDTransform();
  updateERDLines();
});

erdViewport.addEventListener('pointerup', () => {
  isPanning = false;
  erdViewport.classList.remove('grabbing');
});

// Zoom
erdViewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.15, Math.min(3, erdState.scale * delta));

  const rect = erdViewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  erdState.tx = mx - (mx - erdState.tx) * (newScale / erdState.scale);
  erdState.ty = my - (my - erdState.ty) * (newScale / erdState.scale);
  erdState.scale = newScale;

  applyERDTransform();
  updateERDLines();
}, { passive: false });

// ---- Import connections ----
const btnImport = document.getElementById('btn-import');
btnImport.addEventListener('click', async () => {
  const result = await window.api.importConnections();
  if (result.canceled) return;
  if (result.error) {
    alert(result.error);
    return;
  }
  // Deduplicate by checking host+port+user+database
  const existing = new Set(connections.map(c => `${c.host}:${c.port}/${c.database}@${c.user}`));
  let added = 0;
  for (const conn of result.connections) {
    const key = `${conn.host}:${conn.port}/${conn.database}@${conn.user}`;
    if (!existing.has(key)) {
      connections.push(conn);
      existing.add(key);
      added++;
    }
  }
  if (added > 0) {
    await window.api.saveConnections(connections.map(sanitizeConn));
    renderConnections();
  }
  alert(`${added} connection(s) imported (${result.count - added} duplicates skipped).`);
});

// ---- SSH bastions store (in-memory copy of /api/bastions) ----
let bastionsCache = [];
let keysCache = { dir: '/keys', files: [], error: null };

async function loadBastionsCache() {
  try {
    const list = await window.api.listBastions();
    bastionsCache = Array.isArray(list) ? list : [];
  } catch {
    bastionsCache = [];
  }
  return bastionsCache;
}

async function loadKeysCache() {
  try {
    const res = await window.api.listKeys();
    keysCache = { dir: res.dir || '/keys', files: Array.isArray(res.files) ? res.files : [], error: res.error || null };
  } catch (err) {
    keysCache = { dir: '/keys', files: [], error: err.message };
  }
  return keysCache;
}

function bastionSummary(b) {
  const host = b.host || '?';
  const user = b.user || '?';
  const port = b.port ? `:${b.port}` : '';
  return `${b.name || host} (${user}@${host}${port})`;
}

// ---- SSH tunnel form helpers (connection dialog) ----
const tunnelEnabled = document.getElementById('tunnel-enabled');
const tunnelHopsFieldset = document.getElementById('tunnel-hops');
const tunnelHopsList = document.getElementById('tunnel-hops-list');
const btnAddHop = document.getElementById('btn-add-hop');
const btnManageBastions = document.getElementById('btn-manage-bastions');

function renderHopPickerOptions(selectEl, selectedId) {
  selectEl.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = bastionsCache.length ? '— pick a bastion —' : '— no saved bastions —';
  selectEl.appendChild(empty);
  for (const b of bastionsCache) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = bastionSummary(b);
    if (b.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function renderHopElement(hop = {}, idx = 1) {
  const el = document.createElement('div');
  el.className = 'tunnel-hop';
  el.innerHTML = `
    <div class="tunnel-hop-header">
      <span class="tunnel-hop-title">Hop <span class="tunnel-hop-num">${idx}</span></span>
      <button type="button" class="tunnel-remove-hop" title="Remove hop">&times;</button>
    </div>
    <select class="tunnel-hop-picker" data-hop-field="bastionId"></select>
    <div class="tunnel-hop-legacy hidden">
      <span class="tunnel-hop-legacy-label">Legacy inline bastion — migrate to library:</span>
      <button type="button" class="tunnel-migrate-btn">Save to library</button>
    </div>
  `;
  const select = el.querySelector('.tunnel-hop-picker');
  renderHopPickerOptions(select, hop.bastionId);

  const legacy = el.querySelector('.tunnel-hop-legacy');
  const hasInline = !hop.bastionId && (hop.host || hop.user || hop.privateKey);
  if (hasInline) {
    legacy.classList.remove('hidden');
    legacy.querySelector('.tunnel-hop-legacy-label').textContent =
      `Legacy inline bastion (${hop.user || '?'}@${hop.host || '?'}) — migrate to library:`;
    // Stash inline data on the element so we can promote it on click
    el._inlineHop = hop;
  }

  el.querySelector('.tunnel-migrate-btn')?.addEventListener('click', async () => {
    const inline = el._inlineHop;
    if (!inline) return;
    const name = prompt('Name this bastion:', `${inline.user || 'hop'}@${inline.host || 'host'}`);
    if (!name) return;
    const newBastion = {
      id: crypto.randomUUID(),
      name: name.trim(),
      host: inline.host || '',
      port: inline.port || '22',
      user: inline.user || '',
      privateKey: inline.privateKey || '',
      passphrase: inline.passphrase || '',
    };
    bastionsCache.push(newBastion);
    await window.api.saveBastions(bastionsCache);
    // Refresh all hop pickers and select the new bastion here
    tunnelHopsList.querySelectorAll('.tunnel-hop-picker').forEach((sel) => {
      const cur = sel.value;
      renderHopPickerOptions(sel, cur);
    });
    select.value = newBastion.id;
    legacy.classList.add('hidden');
    el._inlineHop = null;
  });

  el.querySelector('.tunnel-remove-hop').addEventListener('click', () => {
    el.remove();
    renumberHops();
    syncShellHopOptions();
  });

  return el;
}

function renumberHops() {
  tunnelHopsList.querySelectorAll('.tunnel-hop').forEach((el, i) => {
    el.querySelector('.tunnel-hop-num').textContent = String(i + 1);
  });
}

function renderTunnelForm(tunnel) {
  tunnelHopsList.innerHTML = '';
  const enabled = !!(tunnel && tunnel.enabled);
  tunnelEnabled.checked = enabled;
  tunnelHopsFieldset.classList.toggle('hidden', !enabled);
  const hops = (tunnel && Array.isArray(tunnel.hops) && tunnel.hops.length) ? tunnel.hops : [{}];
  hops.forEach((hop, i) => tunnelHopsList.appendChild(renderHopElement(hop, i + 1)));
}

function readTunnelFromForm() {
  const hops = Array.from(tunnelHopsList.querySelectorAll('.tunnel-hop')).map((el) => {
    const select = el.querySelector('.tunnel-hop-picker');
    const id = select.value;
    if (id) return { bastionId: id };
    // preserve legacy inline data if not yet migrated
    if (el._inlineHop) return el._inlineHop;
    return { bastionId: '' }; // empty — will be filtered on submit
  });
  return { enabled: tunnelEnabled.checked, hops };
}

tunnelEnabled.addEventListener('change', () => {
  tunnelHopsFieldset.classList.toggle('hidden', !tunnelEnabled.checked);
  if (tunnelEnabled.checked && tunnelHopsList.children.length === 0) {
    tunnelHopsList.appendChild(renderHopElement({}, 1));
  }
  syncShellHopOptions();
});

btnAddHop.addEventListener('click', () => {
  tunnelHopsList.appendChild(renderHopElement({}, tunnelHopsList.children.length + 1));
  syncShellHopOptions();
});

btnManageBastions.addEventListener('click', () => openBastionsManager());

// ---- Shell mode form helpers (connection dialog) ----
const terminalShellEl = document.getElementById('terminal-shell');
const shellOptionsFieldset = document.getElementById('shell-options');
const shellHopIndexEl = document.getElementById('shell-hop-index');

function currentHopBastionIds() {
  if (!tunnelEnabled.checked) return [];
  return Array.from(tunnelHopsList.querySelectorAll('.tunnel-hop-picker')).map((sel) => sel.value);
}

function bastionLabel(id) {
  const b = bastionsCache.find((x) => x.id === id);
  return b ? bastionSummary(b) : '— pick a bastion —';
}

function syncShellHopOptions() {
  const ids = currentHopBastionIds();
  const previous = shellHopIndexEl.value;
  shellHopIndexEl.innerHTML = '';
  if (ids.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— add an SSH hop first —';
    shellHopIndexEl.appendChild(opt);
    shellHopIndexEl.disabled = true;
    return;
  }
  shellHopIndexEl.disabled = false;
  ids.forEach((id, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `Hop ${i + 1} — ${bastionLabel(id)}`;
    shellHopIndexEl.appendChild(opt);
  });
  // Preserve previous selection if still in range, else default to last hop.
  const prevIdx = Number(previous);
  if (Number.isInteger(prevIdx) && prevIdx >= 0 && prevIdx < ids.length) {
    shellHopIndexEl.value = String(prevIdx);
  } else {
    shellHopIndexEl.value = String(ids.length - 1);
  }
}

function renderShellForm(conn) {
  const enabled = isShellMode(conn);
  terminalShellEl.checked = enabled;
  shellOptionsFieldset.classList.toggle('hidden', !enabled);
  syncShellHopOptions();
  // Apply the saved hop index if valid; otherwise default to last hop (already set by sync).
  if (Number.isInteger(conn?.shellHopIndex)) {
    const max = shellHopIndexEl.options.length - 1;
    if (conn.shellHopIndex >= 0 && conn.shellHopIndex <= max) {
      shellHopIndexEl.value = String(conn.shellHopIndex);
    }
  }
}

function readShellFromForm() {
  if (!terminalShellEl.checked) return { terminalMode: undefined, shellHopIndex: undefined };
  const idx = Number.parseInt(shellHopIndexEl.value, 10);
  return {
    terminalMode: 'shell',
    shellHopIndex: Number.isInteger(idx) && idx >= 0 ? idx : null,
  };
}

terminalShellEl.addEventListener('change', () => {
  shellOptionsFieldset.classList.toggle('hidden', !terminalShellEl.checked);
  if (terminalShellEl.checked) syncShellHopOptions();
});

// Refresh available hops whenever the chain changes (add/remove hop, picker change, toggle).
tunnelHopsList.addEventListener('change', () => syncShellHopOptions());
tunnelEnabled.addEventListener('change', () => syncShellHopOptions());

// ---- Bastions manager dialog (master-detail) ----
const bastionsDialog = document.getElementById('bastions-dialog');
const bastionsListView = document.getElementById('bastions-list-view');
const bastionDetailForm = document.getElementById('bastion-detail-form');
const bastionDetailTitle = document.getElementById('bastion-detail-title');
const btnNewBastion = document.getElementById('btn-new-bastion');
const btnBastionsClose = document.getElementById('btn-bastions-close');
const btnBastionBack = document.getElementById('btn-bastion-back');
const btnBastionCancel = document.getElementById('btn-bastion-cancel');
const btnBastionSave = document.getElementById('btn-bastion-save');
const btnBastionDelete = document.getElementById('btn-bastion-delete');

// Which bastion is being edited in the detail view (id string), or the special
// sentinel '__new__' for an unsaved new entry. null when list view is active.
let editingBastionId = null;

function showBastionsView(view) {
  bastionsDialog.querySelectorAll('.bastions-view').forEach((s) => {
    s.classList.toggle('hidden', s.dataset.view !== view);
  });
}

function bastionSummaryLine(b) {
  const host = b.host || '?';
  const user = b.user || '?';
  const port = b.port && String(b.port) !== '22' ? `:${b.port}` : '';
  return `${user}@${host}${port}`;
}

function renderBastionsListView() {
  bastionsListView.innerHTML = '';
  if (bastionsCache.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'bastions-empty';
    empty.textContent = 'No bastions yet. Click + New bastion below.';
    bastionsListView.appendChild(empty);
    return;
  }
  for (const b of bastionsCache) {
    const row = document.createElement('div');
    row.className = 'bastion-list-row';
    row.dataset.id = b.id;
    row.innerHTML = `
      <div class="bastion-list-row-text">
        <div class="bastion-list-row-name"></div>
        <div class="bastion-list-row-sub"></div>
      </div>
      <span class="bastion-list-row-chevron">&rsaquo;</span>
    `;
    row.querySelector('.bastion-list-row-name').textContent = b.name || '(unnamed)';
    row.querySelector('.bastion-list-row-sub').textContent = bastionSummaryLine(b);
    row.addEventListener('click', () => openBastionDetail(b.id));
    bastionsListView.appendChild(row);
  }
}

function buildKeySelect(currentPath) {
  const select = document.createElement('select');
  select.dataset.field = 'privateKeyPath';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = keysCache.files.length ? '— pick a key file —' : `— no files in ${keysCache.dir} —`;
  select.appendChild(empty);
  for (const p of keysCache.files) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === currentPath) opt.selected = true;
    select.appendChild(opt);
  }
  if (currentPath && !keysCache.files.includes(currentPath)) {
    const missing = document.createElement('option');
    missing.value = currentPath;
    missing.textContent = `${currentPath} (missing)`;
    missing.selected = true;
    select.appendChild(missing);
  }
  return select;
}

function renderBastionDetailForm(b) {
  const hasLegacyInlineKey = !b.privateKeyPath && !!b.privateKey;
  bastionDetailForm.innerHTML = `
    <div class="bastion-detail-fields">
      <label>Name <input type="text" data-field="name" placeholder="e.g. Prod bastion"></label>
      <label>Host <input type="text" data-field="host" placeholder="bastion.example.com"></label>
      <label>Port <input type="number" data-field="port" value="22"></label>
      <label>User <input type="text" data-field="user" placeholder="jump"></label>
      <label class="bastion-key-label">Private key file</label>
      <p class="bastion-key-hint">Files in <code class="keys-dir"></code> on the server. Drop your SSH key into the mounted volume, then pick it from the list (public-key files and hidden files are excluded).</p>
      ${hasLegacyInlineKey ? '<p class="bastion-key-legacy">⚠ This bastion still stores the private key inline (legacy). Save its content to a mounted file and pick it above; leaving the selection empty keeps the legacy inline key working.</p>' : ''}
      <label>Passphrase (optional)
        <input type="password" data-field="passphrase" autocomplete="new-password">
      </label>
    </div>
  `;
  bastionDetailForm.querySelector('[data-field=name]').value = b.name || '';
  bastionDetailForm.querySelector('[data-field=host]').value = b.host || '';
  bastionDetailForm.querySelector('[data-field=port]').value = b.port != null ? String(b.port) : '22';
  bastionDetailForm.querySelector('[data-field=user]').value = b.user || '';
  bastionDetailForm.querySelector('[data-field=passphrase]').value = b.passphrase || '';
  bastionDetailForm.querySelector('.keys-dir').textContent = keysCache.dir;
  const label = bastionDetailForm.querySelector('.bastion-key-label');
  label.appendChild(buildKeySelect(b.privateKeyPath || ''));
  bastionDetailForm.dataset.legacyKey = b.privateKey || '';
  bastionDetailForm.dataset.id = b.id;
  bastionDetailForm.querySelector('[data-field=name]').focus();
}

function readBastionDetailForm() {
  const b = {
    id: bastionDetailForm.dataset.id,
    name: bastionDetailForm.querySelector('[data-field=name]').value.trim(),
    host: bastionDetailForm.querySelector('[data-field=host]').value.trim(),
    port: bastionDetailForm.querySelector('[data-field=port]').value.trim() || '22',
    user: bastionDetailForm.querySelector('[data-field=user]').value.trim(),
    privateKeyPath: bastionDetailForm.querySelector('[data-field=privateKeyPath]').value.trim(),
    passphrase: bastionDetailForm.querySelector('[data-field=passphrase]').value,
  };
  const legacy = bastionDetailForm.dataset.legacyKey;
  if (!b.privateKeyPath && legacy) b.privateKey = legacy;
  return b;
}

function openBastionDetail(id) {
  let b, isNew = false;
  if (id === '__new__') {
    b = { id: crypto.randomUUID(), name: '', host: '', port: '22', user: '', privateKeyPath: '', passphrase: '' };
    isNew = true;
  } else {
    b = bastionsCache.find((x) => x.id === id);
    if (!b) return;
  }
  editingBastionId = isNew ? '__new__' : id;
  bastionDetailForm.dataset.isNew = String(isNew);
  bastionDetailTitle.textContent = isNew ? 'New bastion' : 'Edit bastion';
  btnBastionDelete.style.display = isNew ? 'none' : '';
  renderBastionDetailForm(b);
  showBastionsView('detail');
}

function backToList() {
  editingBastionId = null;
  renderBastionsListView();
  showBastionsView('list');
}

async function persistBastions() {
  await window.api.saveBastions(bastionsCache);
  // Refresh hop pickers in the (still-open) connection dialog
  tunnelHopsList.querySelectorAll('.tunnel-hop-picker').forEach((sel) => {
    const cur = sel.value;
    renderHopPickerOptions(sel, cur);
  });
}

async function openBastionsManager() {
  await Promise.all([loadBastionsCache(), loadKeysCache()]);
  backToList();
  bastionsDialog.showModal();
}

btnNewBastion.addEventListener('click', () => openBastionDetail('__new__'));

btnBastionBack.addEventListener('click', backToList);
btnBastionCancel.addEventListener('click', backToList);

btnBastionsClose.addEventListener('click', () => bastionsDialog.close());

btnBastionSave.addEventListener('click', async () => {
  const b = readBastionDetailForm();
  if (!b.name) { alert('Name is required.'); return; }
  if (!b.host || !b.user) { alert('Host and user are required.'); return; }
  if (!b.privateKeyPath && !b.privateKey) {
    alert('Pick a private key file from the list. Drop the file into the mounted keys directory if it isn\u2019t there yet.');
    return;
  }
  const isNew = bastionDetailForm.dataset.isNew === 'true';
  if (isNew) {
    bastionsCache.push(b);
  } else {
    const idx = bastionsCache.findIndex((x) => x.id === b.id);
    if (idx >= 0) bastionsCache[idx] = b; else bastionsCache.push(b);
  }
  await persistBastions();
  backToList();
});

btnBastionDelete.addEventListener('click', async () => {
  const isNew = bastionDetailForm.dataset.isNew === 'true';
  if (isNew) { backToList(); return; }
  const id = bastionDetailForm.dataset.id;
  const b = bastionsCache.find((x) => x.id === id);
  if (!b) { backToList(); return; }
  if (!confirm(`Delete bastion "${b.name}"? Connections referencing it will break until the hop is repointed.`)) return;
  bastionsCache = bastionsCache.filter((x) => x.id !== id);
  await persistBastions();
  backToList();
});

// ---- Backup / restore (connections + bastions, JSON or YAML) ----
const backupDialog = document.getElementById('backup-dialog');
const btnBackup = document.getElementById('btn-backup');
const btnBackupExportJson = document.getElementById('btn-backup-export-json');
const btnBackupExportYaml = document.getElementById('btn-backup-export-yaml');
const btnImportBackup = document.getElementById('btn-import-backup');
const btnBackupClose = document.getElementById('btn-backup-close');
const backupImportStatus = document.getElementById('backup-import-status');

async function gatherBackupPayload() {
  const [conns, basts] = await Promise.all([
    window.api.listConnections(),
    window.api.listBastions(),
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: conns,
    bastions: basts,
  };
}

function triggerDownload(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mergeById(current, incoming) {
  const byId = new Map(current.map((x) => [x.id, x]));
  for (const item of incoming) {
    const copy = { ...item };
    if (!copy.id) copy.id = crypto.randomUUID();
    byId.set(copy.id, copy);
  }
  return Array.from(byId.values());
}

btnBackup.addEventListener('click', () => {
  backupImportStatus.textContent = '';
  backupDialog.showModal();
});

btnBackupClose.addEventListener('click', () => backupDialog.close());

btnBackupExportJson.addEventListener('click', async () => {
  const payload = await gatherBackupPayload();
  const name = `aperium-backup-${new Date().toISOString().slice(0, 10)}.json`;
  triggerDownload(JSON.stringify(payload, null, 2), name, 'application/json');
});

btnBackupExportYaml.addEventListener('click', async () => {
  const payload = await gatherBackupPayload();
  const name = `aperium-backup-${new Date().toISOString().slice(0, 10)}.yaml`;
  const text = yaml.dump(payload, { lineWidth: -1, noRefs: true, quotingType: '"' });
  triggerDownload(text, name, 'application/x-yaml');
});

btnImportBackup.addEventListener('click', async () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.yaml,.yml,application/json,application/x-yaml,text/yaml';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed;
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'yaml' || ext === 'yml') {
        parsed = yaml.load(text);
      } else {
        try { parsed = JSON.parse(text); }
        catch { parsed = yaml.load(text); }
      }
      if (!parsed || typeof parsed !== 'object') throw new Error('Backup file has no usable root object.');
      const importedConns = Array.isArray(parsed.connections) ? parsed.connections : [];
      const importedBasts = Array.isArray(parsed.bastions) ? parsed.bastions : [];
      if (importedConns.length === 0 && importedBasts.length === 0) {
        throw new Error('No connections or bastions found in the file.');
      }
      const [currConns, currBasts] = await Promise.all([
        window.api.listConnections(),
        window.api.listBastions(),
      ]);
      const mergedConns = mergeById(currConns, importedConns);
      const mergedBasts = mergeById(currBasts, importedBasts);
      await Promise.all([
        window.api.saveConnections(mergedConns),
        window.api.saveBastions(mergedBasts),
      ]);
      connections = mergedConns;
      bastionsCache = mergedBasts;
      renderConnections();
      backupImportStatus.textContent = `Imported ${importedConns.length} connection(s) and ${importedBasts.length} bastion(s).`;
      backupImportStatus.style.color = 'var(--green)';
    } catch (err) {
      backupImportStatus.textContent = `Import failed: ${err.message}`;
      backupImportStatus.style.color = 'var(--red)';
    }
  });
  input.click();
});

// ---- New connection dialog ----
btnNewConn.addEventListener('click', async () => {
  await loadBastionsCache();
  dialogTitle.textContent = 'New Connection';
  form.reset();
  form.elements.id.value = '';
  form.elements.group.value = '';
  form.elements.host.value = 'localhost';
  form.elements.port.value = '5432';
  form.elements.database.value = 'postgres';
  renderTunnelForm(null);
  renderShellForm(null);
  updateGroupSuggestions();
  setDialogDeleteVisibility(false);
  dialog.showModal();
});

btnCancel.addEventListener('click', () => dialog.close());

// ---- Generic styled confirm dialog ----
const confirmDialog = document.getElementById('confirm-dialog');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
const btnConfirmOk = document.getElementById('btn-confirm-ok');

function showConfirm({ title, message, okLabel = 'Delete', okVariant = 'danger' }) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    btnConfirmOk.textContent = okLabel;
    btnConfirmOk.classList.toggle('confirm-ok-danger', okVariant === 'danger');

    const cleanup = () => {
      btnConfirmOk.removeEventListener('click', onOk);
      btnConfirmCancel.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('close', onClose);
      confirmDialog.removeEventListener('cancel', onCancelEvt);
    };
    const onOk = () => { cleanup(); confirmDialog.close('ok'); resolve(true); };
    const onCancel = () => { cleanup(); confirmDialog.close('cancel'); resolve(false); };
    const onClose = () => { cleanup(); resolve(false); };
    const onCancelEvt = (e) => { e.preventDefault(); onCancel(); };

    btnConfirmOk.addEventListener('click', onOk);
    btnConfirmCancel.addEventListener('click', onCancel);
    confirmDialog.addEventListener('close', onClose, { once: true });
    confirmDialog.addEventListener('cancel', onCancelEvt);

    confirmDialog.showModal();
    requestAnimationFrame(() => btnConfirmCancel.focus());
  });
}

// ---- Edit-dialog delete button (with confirmation) ----
const btnDeleteConn = document.getElementById('btn-delete-conn');

function setDialogDeleteVisibility(visible) {
  btnDeleteConn.classList.toggle('hidden', !visible);
}

btnDeleteConn.addEventListener('click', async () => {
  const id = form.elements.id.value;
  if (!id) return;
  const conn = connections.find((c) => c.id === id);
  const name = conn?.name || 'this connection';
  const confirmed = await showConfirm({
    title: 'Delete connection?',
    message: `“${name}” will be removed permanently. This action cannot be undone.`,
    okLabel: 'Delete',
    okVariant: 'danger',
  });
  if (!confirmed) return;
  await deleteConnection(id);
  dialog.close();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const editId = data.id;
  delete data.id;
  delete data['tunnel-enabled'];
  delete data['terminal-shell'];
  delete data['shell-target'];
  const tunnel = readTunnelFromForm();
  // Drop empty hops: neither a ref nor inline data
  tunnel.hops = tunnel.hops.filter((h) => h.bastionId || h.host || h.user || h.privateKey);
  if (tunnel.enabled && tunnel.hops.length === 0) {
    alert('SSH tunnel is enabled but no hops are selected. Pick at least one bastion or disable the tunnel.');
    return;
  }
  data.tunnel = tunnel;

  const shellCfg = readShellFromForm();
  if (shellCfg.terminalMode === 'shell') {
    if (!tunnel.enabled || tunnel.hops.length === 0) {
      alert('Shell mode requires an enabled SSH tunnel with at least one bastion.');
      return;
    }
    if (shellCfg.shellHopIndex == null || shellCfg.shellHopIndex < 0 || shellCfg.shellHopIndex >= tunnel.hops.length) {
      alert('Pick a valid hop on which to open the shell.');
      return;
    }
    data.terminalMode = 'shell';
    data.shellHopIndex = shellCfg.shellHopIndex;
  } else {
    delete data.terminalMode;
    delete data.shellHopIndex;
  }

  if (editId) {
    const idx = connections.findIndex((c) => c.id === editId);
    if (idx >= 0) {
      const merged = { ...connections[idx], ...data };
      // Strip shell-mode fields when not in shell mode (so deletes propagate)
      if (data.terminalMode !== 'shell') {
        delete merged.terminalMode;
        delete merged.shellHopIndex;
      }
      // Drop legacy shell fields that are no longer used.
      delete merged.shellTarget;
      delete merged.dbHostSsh;
      connections[idx] = merged;
    }
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
  // psql metacommands must be at the start of a line (optionally preceded by whitespace)
  // This avoids matching escape sequences like \t \n inside string literals
  return /(^|\n)\s*\\[a-zA-Z+]/.test(q);
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

  addToHistory(getRawEditorContent());

  // Meta-commands and regular queries both go through /api/query — the server
  // detects the leading backslash and switches psql args (drops --csv, keeps
  // aligned output). The result is rendered in the Results panel either way.

  resultsContainer.innerHTML = '<div class="results-loading"><div class="spinner"></div>Running...</div>';
  resultsStatus.textContent = '';
  resultsStatus.className = '';

  const queryId = crypto.randomUUID();
  tab.currentQueryId = queryId;
  const startDisplay = Date.now();
  btnStop.classList.remove('hidden');
  btnRun.classList.add('hidden');

  const result = await window.api.executeQuery(tab.connection, query, queryId);

  if (tab.currentQueryId === queryId) {
    tab.currentQueryId = null;
    // Keep stop button visible for at least 150ms so it's noticeable
    const elapsed = Date.now() - startDisplay;
    const remaining = Math.max(0, 150 - elapsed);
    setTimeout(() => {
      if (!tab.currentQueryId) {
        btnStop.classList.add('hidden');
        btnRun.classList.remove('hidden');
      }
    }, remaining);
  }

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

  if (result.isMetacommand) {
    tab.lastResults = null;
    hideCopyButtons();
    resultsContainer.innerHTML = '';
    const raw = result.raw || '';
    const blocks = parsePsqlAligned(raw);

    let totalRows = 0;
    let tableCount = 0;
    for (const blk of blocks) {
      if (blk.kind === 'title') {
        const el = document.createElement('div');
        el.className = 'results-meta-title';
        el.textContent = blk.text;
        resultsContainer.appendChild(el);
      } else if (blk.kind === 'table') {
        resultsContainer.appendChild(buildTableEl(blk.columns, blk.rows));
        totalRows += blk.rows.length;
        tableCount++;
      } else if (blk.kind === 'text' && blk.text.trim()) {
        const el = document.createElement('pre');
        el.className = 'results-meta';
        el.textContent = blk.text;
        resultsContainer.appendChild(el);
      }
    }
    if (result.stderr) {
      const el = document.createElement('pre');
      el.className = 'results-meta-stderr';
      el.textContent = result.stderr;
      resultsContainer.appendChild(el);
    }
    if (resultsContainer.childElementCount === 0) {
      resultsContainer.innerHTML =
        `<div class="results-message">Meta-command produced no output.</div>`;
    }

    // Enable Copy/Export when the meta-cmd produced exactly one table and nothing else
    // (e.g. \dt, \dn). For multi-block output (\d users) we leave them off.
    if (tableCount === 1 && blocks.every((b) => b.kind !== 'text')) {
      const tableBlock = blocks.find((b) => b.kind === 'table');
      tab.lastResults = { columns: tableBlock.columns, rows: tableBlock.rows };
      showCopyButtons();
    }

    resultsStatus.textContent = tableCount
      ? `${totalRows} row${totalRows !== 1 ? 's' : ''} • meta-command (${result.duration}ms)`
      : `meta-command (${result.duration}ms)`;
    resultsStatus.className = 'success';
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
  btnExportCsv.classList.remove('hidden');
  btnExportJson.classList.remove('hidden');
}

function hideCopyButtons() {
  btnCopyCsv.classList.add('hidden');
  btnCopyJson.classList.add('hidden');
  btnExportCsv.classList.add('hidden');
  btnExportJson.classList.add('hidden');
}

function buildTableEl(columns, rows) {
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
  return table;
}

function renderTable(columns, rows) {
  resultsContainer.innerHTML = '';
  resultsContainer.appendChild(buildTableEl(columns, rows));
}

// Parse psql's aligned output (the default format used for meta-commands like
// \dt, \d users, \df) into a sequence of blocks. Each block is either a table
// (with columns + rows), a title line, or free-form text. \d users for example
// returns: [title, table, text(indexes…), text(foreign keys…)].
function parsePsqlAligned(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const isSeparator = (s) =>
    /^[-+]+$/.test(s.replace(/ /g, '')) && s.includes('+') && s.includes('-');

  while (i < lines.length) {
    // Find the next separator line (column-divider made of dashes + plusses).
    let sep = -1;
    for (let j = i; j < lines.length; j++) {
      if (isSeparator(lines[j])) { sep = j; break; }
    }
    if (sep < 0) {
      const tail = lines.slice(i).join('\n');
      if (tail.trim()) blocks.push({ kind: 'text', text: tail });
      break;
    }

    // Header line is the immediately preceding non-empty line (must contain `|`).
    let headerIdx = sep - 1;
    while (headerIdx >= i && lines[headerIdx].trim() === '') headerIdx--;
    if (headerIdx < i || !lines[headerIdx].includes('|')) {
      blocks.push({ kind: 'text', text: lines.slice(i, sep + 1).join('\n') });
      i = sep + 1;
      continue;
    }

    // Title = consecutive non-`|` non-empty lines above the header (e.g. "List of relations").
    let titleStart = headerIdx - 1;
    while (titleStart >= i && lines[titleStart].trim() && !lines[titleStart].includes('|')) {
      titleStart--;
    }
    titleStart++;
    // Anything before the title goes out as free text.
    if (titleStart > i) {
      const pre = lines.slice(i, titleStart).join('\n');
      if (pre.trim()) blocks.push({ kind: 'text', text: pre });
    }
    if (titleStart < headerIdx) {
      const title = lines.slice(titleStart, headerIdx)
        .map((l) => l.trim()).filter(Boolean).join(' ');
      if (title) blocks.push({ kind: 'title', text: title });
    }

    // Slice columns by the separator's `+` positions.
    const sepLine = lines[sep];
    const boundaries = [];
    for (let k = 0; k < sepLine.length; k++) if (sepLine[k] === '+') boundaries.push(k);

    const sliceByBoundaries = (line) => {
      const out = [];
      let prev = 0;
      for (const b of boundaries) {
        out.push((line.slice(prev, b) || '').trim());
        prev = b + 1;
      }
      out.push((line.slice(prev) || '').trim());
      return out;
    };

    const columns = sliceByBoundaries(lines[headerIdx]);

    // Data rows until a blank line or "(N rows)" footer or a line without `|`.
    const rows = [];
    let r = sep + 1;
    while (r < lines.length) {
      const ln = lines[r];
      if (!ln.trim()) { r++; break; }
      if (/^\(\d+ rows?\)\s*$/.test(ln.trim())) { r++; break; }
      if (!ln.includes('|')) break;
      rows.push(sliceByBoundaries(ln));
      r++;
    }

    blocks.push({ kind: 'table', columns, rows });
    i = r;
  }

  return blocks;
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

// ---- Export to file ----
function buildCsvContent(tab) {
  if (!tab?.lastResults) return '';
  const lines = [tab.lastResults.columns.join(',')];
  for (const row of tab.lastResults.rows) {
    lines.push(row.map(cell => {
      if (cell === null || cell === undefined || cell === '') return '';
      const s = String(cell);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  return lines.join('\n');
}

function buildJsonContent(tab) {
  if (!tab?.lastResults) return '';
  const data = tab.lastResults.rows.map(row => {
    const obj = {};
    tab.lastResults.columns.forEach((col, i) => {
      obj[col] = (row[i] === '' || row[i] === undefined) ? null : row[i];
    });
    return obj;
  });
  return JSON.stringify(data, null, 2);
}

btnExportCsv.addEventListener('click', async () => {
  const tab = getActiveTab();
  if (!tab?.lastResults) return;
  const content = buildCsvContent(tab);
  const result = await window.api.exportSave({
    content,
    defaultName: 'results.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!result.canceled) copyWithFeedback(btnExportCsv, 'Saved!');
});

btnExportJson.addEventListener('click', async () => {
  const tab = getActiveTab();
  if (!tab?.lastResults) return;
  const content = buildJsonContent(tab);
  const result = await window.api.exportSave({
    content,
    defaultName: 'results.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!result.canceled) copyWithFeedback(btnExportJson, 'Saved!');
});

// ---- Send to terminal ----
function sendToTerminal() {
  const tab = getActiveTab();
  if (!tab?.terminal) return;
  if (isShellMode(tab.connection)) return; // No psql to feed in shell mode.
  const query = getEditorContent();
  if (!query) return;
  addToHistory(getRawEditorContent());
  window.api.sendQuery(tab.ptyId, query);
}

btnRun.addEventListener('click', runQuery);
btnStop.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab?.currentQueryId) {
    window.api.cancelQuery(tab.currentQueryId);
  }
});
btnSendTerminal.addEventListener('click', sendToTerminal);
btnClear.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab?.editorView) {
    tab.editorView.dispatch({ changes: { from: 0, to: tab.editorView.state.doc.length, insert: '' } });
    tab.editorView.focus();
  }
});

// ---- Auto-refresh ----
const btnAutoRefresh = document.getElementById('btn-auto-refresh');
const autoRefreshInterval = document.getElementById('auto-refresh-interval');
let autoRefreshTimer = null;

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  btnAutoRefresh.classList.remove('active');
  btnAutoRefresh.textContent = 'Auto';
}

function startAutoRefresh() {
  const seconds = parseInt(autoRefreshInterval.value) || 5;
  stopAutoRefresh();
  btnAutoRefresh.classList.add('active');

  let countdown = seconds;
  btnAutoRefresh.textContent = `${countdown}s`;

  autoRefreshTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      runQuery();
      countdown = seconds;
    }
    btnAutoRefresh.textContent = `${countdown}s`;
  }, 1000);
}

btnAutoRefresh.addEventListener('click', () => {
  if (autoRefreshTimer) {
    stopAutoRefresh();
  } else {
    runQuery();
    startAutoRefresh();
  }
});

autoRefreshInterval.addEventListener('change', () => {
  if (autoRefreshTimer) {
    runQuery();
    startAutoRefresh();
  }
});

// ---- Database selector ----
async function fetchDatabases(conn, tab) {
  try {
    const result = await window.api.executeQuery(conn,
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    if (result.columns && result.rows) {
      const dbs = result.rows.map(r => r[0]);
      if (tab) tab.databases = dbs;
      // Only update selector if this tab is still active
      if (!tab || getActiveTab()?.id === tab.id) {
        renderDbSelector(dbs, conn.database || 'postgres');
      }
    }
  } catch (e) {
    console.log('Database list fetch failed:', e);
  }
}

function renderDbSelector(dbs, selected) {
  dbSelector.innerHTML = '';
  for (const db of dbs) {
    const opt = document.createElement('option');
    opt.value = db;
    opt.textContent = db;
    if (db === selected) opt.selected = true;
    dbSelector.appendChild(opt);
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

  window.api.killPty(tab.ptyId);
  await window.api.spawnPty(tab.ptyId, tab.connection);
  connectionInfo.textContent = formatConnectionInfo(tab.connection);

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
          tab.editorView = createEditor(editorContainer, editorCallbacks());
        } else {
          const tmp = document.createElement('div');
          tab.editorView = createEditor(tmp, editorCallbacks());
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

// ---- Panel collapse/expand ----
const panelMap = {
  editor: editorPanel,
  results: resultsPanel,
  terminal: terminalPanel,
};

// Heights saved before collapsing so we can restore
const savedHeights = { editor: null, results: null, terminal: null };

function togglePanel(panelName) {
  const panel = panelMap[panelName];
  const btn = panel.querySelector('.panel-collapse-btn');
  const isCollapsed = panel.classList.contains('panel-collapsed');

  if (isCollapsed) {
    // Expand
    panel.classList.remove('panel-collapsed');
    btn.classList.remove('collapsed');
    if (savedHeights[panelName]) {
      panel.style.height = savedHeights[panelName];
    }
    panel.style.flex = '';
  } else {
    // Collapse — save current height first
    savedHeights[panelName] = panel.getBoundingClientRect().height + 'px';
    panel.classList.add('panel-collapsed');
    btn.classList.add('collapsed');
    panel.style.flex = '';
  }

  redistributePanelSpace();

  // Refit terminal
  const tab = getActiveTab();
  if (tab?.fitAddon) requestAnimationFrame(() => tab.fitAddon.fit());

  // Save collapse state to active tab
  if (tab) {
    if (!tab.collapsedPanels) tab.collapsedPanels = {};
    tab.collapsedPanels[panelName] = !isCollapsed;
  }
}

function redistributePanelSpace() {
  if (!session || session.classList.contains('hidden')) return;

  const panels = ['editor', 'results', 'terminal'];
  const expanded = panels.filter(p => !panelMap[p].classList.contains('panel-collapsed'));

  // Reset flex on all
  for (const p of panels) {
    panelMap[p].style.flex = '';
  }

  if (expanded.length === 0) return;

  // The last expanded panel takes remaining space
  const lastExpanded = expanded[expanded.length - 1];
  panelMap[lastExpanded].style.flex = '1';
  // Remove fixed height so flex works
  panelMap[lastExpanded].style.height = '';
}

document.querySelectorAll('.panel-collapse-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel(btn.dataset.panel);
  });
});

// Window resize
window.addEventListener('resize', () => {
  redistributePanelSpace();
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
