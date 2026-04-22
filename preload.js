const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Connections
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnections: (conns) => ipcRenderer.invoke('connections:save', conns),
  importConnections: () => ipcRenderer.invoke('connections:import'),
  exportSave: (opts) => ipcRenderer.invoke('export:save', opts),

  // Snippets
  loadSnippets: () => ipcRenderer.invoke('snippets:load'),
  saveSnippets: (snippets) => ipcRenderer.invoke('snippets:save', snippets),
  getSnippetsPath: () => ipcRenderer.invoke('snippets:path'),
  openSnippetsInEditor: () => ipcRenderer.invoke('snippets:open-in-editor'),

  // PTY
  spawnPty: (id, connection) => ipcRenderer.invoke('pty:spawn', { id, connection }),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
  sendQuery: (id, query) => ipcRenderer.send('pty:send-query', { id, query }),
  executeQuery: (connection, query, queryId) => ipcRenderer.invoke('query:execute', { connection, query, queryId }),
  cancelQuery: (queryId) => ipcRenderer.send('query:cancel', { queryId }),

  onPtyData: (callback) => {
    ipcRenderer.on('pty:data', (_, payload) => callback(payload));
  },
  onPtyExit: (callback) => {
    ipcRenderer.on('pty:exit', (_, payload) => callback(payload));
  },
});
