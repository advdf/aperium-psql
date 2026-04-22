// Client-side replacement for the Electron preload bridge. Exposes window.api
// with the same contract that src/renderer.js consumes, backed by fetch + WebSocket.
(function () {
  const ptyByTab = new Map(); // tabId -> { ws, queue }
  let ptyDataCb = null;
  let ptyExitCb = null;

  function connectPty(tabId) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws/pty?tabId=${encodeURIComponent(tabId)}`);
      ws.binaryType = 'arraybuffer';
      const state = { ws, queue: [] };
      ptyByTab.set(tabId, state);

      ws.addEventListener('open', () => {
        for (const msg of state.queue) ws.send(msg);
        state.queue = [];
        resolve(state);
      });
      ws.addEventListener('error', (e) => reject(e));
      ws.addEventListener('message', (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          ptyDataCb && ptyDataCb({ id: tabId, data: new Uint8Array(ev.data) });
          return;
        }
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'exit') ptyExitCb && ptyExitCb({ id: tabId, exitCode: msg.exitCode });
          } catch {}
        }
      });
      ws.addEventListener('close', () => {
        ptyByTab.delete(tabId);
      });
    });
  }

  function sendOrQueue(tabId, obj) {
    const state = ptyByTab.get(tabId);
    if (!state) return;
    const msg = JSON.stringify(obj);
    if (state.ws.readyState === WebSocket.OPEN) state.ws.send(msg);
    else state.queue.push(msg);
  }

  function downloadBlob(content, filename, mime) {
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

  function normalizeImportedConn(obj) {
    return {
      id: obj.id || crypto.randomUUID(),
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

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      input.addEventListener('change', () => finish(input.files[0] || null));
      input.addEventListener('cancel', () => finish(null));
      input.click();
    });
  }

  function openJSONEditorModal(initial) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px;width:80%;max-width:900px;max-height:80vh;display:flex;flex-direction:column;gap:12px;font-family:sans-serif';
      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center"><strong>Edit snippets.json</strong><span style="font-size:12px;opacity:.7">Edit the JSON and click Save</span></div>' +
        '<textarea style="flex:1;min-height:400px;background:#181825;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;padding:8px;font-family:monospace;font-size:13px"></textarea>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px"><button data-act="cancel" style="padding:6px 12px">Cancel</button><button data-act="save" style="padding:6px 12px;background:#89b4fa;color:#1e1e2e;border:0;border-radius:4px;font-weight:600">Save</button></div>';
      const ta = box.querySelector('textarea');
      ta.value = JSON.stringify(initial, null, 2);
      box.querySelector('[data-act=cancel]').onclick = () => { backdrop.remove(); resolve(null); };
      box.querySelector('[data-act=save]').onclick = () => {
        try {
          const parsed = JSON.parse(ta.value);
          backdrop.remove();
          resolve(parsed);
        } catch (err) {
          alert('Invalid JSON: ' + err.message);
        }
      };
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      ta.focus();
    });
  }

  const api = {
    listConnections: () => fetch('/api/connections').then((r) => r.json()),

    saveConnections: (conns) =>
      fetch('/api/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conns),
      }).then((r) => r.json()),

    importConnections: async () => {
      const file = await pickFile('.json,.csv');
      if (!file) return { canceled: true };
      const text = await file.text();
      try {
        let imported = [];
        if (file.name.toLowerCase().endsWith('.json')) {
          const parsed = JSON.parse(text);
          const arr = Array.isArray(parsed) ? parsed : (parsed.connections || [parsed]);
          imported = arr.map(normalizeImportedConn);
        } else {
          const lines = text.trim().split('\n');
          if (lines.length < 2) return { error: 'CSV file is empty or has no data rows.' };
          const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
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
    },

    exportSave: async ({ content, defaultName, filters }) => {
      const ext = (filters && filters[0] && filters[0].extensions && filters[0].extensions[0]) || 'txt';
      const mime = ext === 'csv' ? 'text/csv' : (ext === 'json' ? 'application/json' : 'text/plain');
      downloadBlob(content, defaultName, mime);
      return { filePath: defaultName };
    },

    loadSnippets: () => fetch('/api/snippets').then((r) => r.json()),

    saveSnippets: (snippets) =>
      fetch('/api/snippets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snippets),
      }).then((r) => r.json()),

    getSnippetsPath: () => Promise.resolve('(server) snippets.json'),

    openSnippetsInEditor: async () => {
      const current = await api.loadSnippets();
      if (!current) return { needsInit: true, path: 'snippets.json' };
      const edited = await openJSONEditorModal(current);
      if (edited) await api.saveSnippets(edited);
      return { needsInit: false, path: 'snippets.json' };
    },

    spawnPty: async (id, connection) => {
      const existing = ptyByTab.get(id);
      if (existing) {
        try { existing.ws.close(); } catch {}
        ptyByTab.delete(id);
      }
      const state = await connectPty(id);
      return new Promise((resolve) => {
        const onMsg = (ev) => {
          if (typeof ev.data !== 'string') return;
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'ready') {
              state.ws.removeEventListener('message', onMsg);
              resolve(true);
            } else if (m.type === 'error') {
              state.ws.removeEventListener('message', onMsg);
              resolve({ error: m.message });
            }
          } catch {}
        };
        state.ws.addEventListener('message', onMsg);
        state.ws.send(JSON.stringify({ type: 'spawn', connection }));
      });
    },

    writePty: (id, data) => sendOrQueue(id, { type: 'write', data }),
    resizePty: (id, cols, rows) => sendOrQueue(id, { type: 'resize', cols, rows }),
    killPty: (id) => {
      const state = ptyByTab.get(id);
      if (!state) return;
      sendOrQueue(id, { type: 'kill' });
      try { state.ws.close(); } catch {}
      ptyByTab.delete(id);
    },
    sendQuery: (id, query) => sendOrQueue(id, { type: 'send-query', query }),

    executeQuery: (connection, query, queryId) =>
      fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection, query, queryId }),
      }).then((r) => r.json()),

    cancelQuery: (queryId) => {
      fetch(`/api/query/${encodeURIComponent(queryId)}`, { method: 'DELETE' }).catch(() => {});
    },

    onPtyData: (cb) => { ptyDataCb = cb; },
    onPtyExit: (cb) => { ptyExitCb = cb; },
  };

  window.api = api;
})();
