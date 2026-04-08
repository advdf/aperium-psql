const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Connections
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnections: (conns) => ipcRenderer.invoke('connections:save', conns),

  // PTY
  spawnPty: (id, connection) => ipcRenderer.invoke('pty:spawn', { id, connection }),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
  sendQuery: (id, query) => ipcRenderer.send('pty:send-query', { id, query }),
  executeQuery: (connection, query) => ipcRenderer.invoke('query:execute', { connection, query }),

  onPtyData: (callback) => {
    ipcRenderer.on('pty:data', (_, payload) => callback(payload));
  },
  onPtyExit: (callback) => {
    ipcRenderer.on('pty:exit', (_, payload) => callback(payload));
  },
});
