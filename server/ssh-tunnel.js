const net = require('net');
const { Client } = require('ssh2');

/**
 * Open a chain of SSH connections `hop1 -> hop2 -> ... -> hopN` and expose
 * a local TCP server that transparently forwards to `dbHost:dbPort` through
 * the chain. psql can then connect to `127.0.0.1:<localPort>`.
 *
 * @param {Object} opts
 * @param {Array<{host:string,port?:number|string,user:string,privateKey:string,passphrase?:string}>} opts.hops
 * @param {string} opts.dbHost
 * @param {number} opts.dbPort
 * @returns {Promise<{ localHost: string, localPort: number, close: () => void }>}
 */
async function openTunnelChain({ hops, dbHost, dbPort }) {
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new Error('at least one SSH hop is required');
  }

  const { leafClient, cleanup } = await walkChain({ hops, targetHopIndex: hops.length - 1 });

  try {
    const server = net.createServer((sock) => {
      leafClient.forwardOut('127.0.0.1', sock.remotePort || 0, dbHost, dbPort, (err, stream) => {
        if (err) {
          sock.destroy();
          return;
        }
        sock.on('error', () => {});
        stream.on('error', () => {});
        sock.pipe(stream).pipe(sock);
      });
    });
    server.on('error', () => {});
    const localPort = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' ? addr.port : 0);
      });
    });

    let closed = false;
    return {
      localHost: '127.0.0.1',
      localPort,
      close() {
        if (closed) return;
        closed = true;
        try { server.close(); } catch {}
        cleanup();
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Open an interactive SSH shell on a chosen hop of a chain. The chain is walked
 * up to and including `targetHopIndex`; the shell is opened on that hop's SSH
 * client (using TCP forwardOut for every preceding hop).
 *
 * @param {Object} opts
 * @param {Array<{host:string,port?:number|string,user:string,privateKey:string,passphrase?:string}>} opts.hops
 * @param {number} [opts.targetHopIndex]  0-based index of the hop on which to open the shell. Defaults to the last hop.
 * @param {number} [opts.cols=120]
 * @param {number} [opts.rows=30]
 * @param {string} [opts.term='xterm-256color']
 * @returns {Promise<{ stream: import('ssh2').ClientChannel, close: () => void }>}
 */
async function openSshShell({ hops, targetHopIndex, cols = 120, rows = 30, term = 'xterm-256color' }) {
  const { leafClient, cleanup } = await walkChain({ hops, targetHopIndex, label: 'shell' });
  try {
    const stream = await new Promise((resolve, reject) => {
      leafClient.shell({ rows, cols, term }, (err, s) => {
        if (err) reject(err);
        else resolve(s);
      });
    });
    return wrapStream(stream, cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Execute a command on a chosen hop of a chain over SSH. Walks the chain up to
 * and including `targetHopIndex`, then runs `command` via `client.exec`. The
 * returned stream behaves like `openSshShell`'s — `stream` is bidirectional
 * (write to stdin, read from data/stderr), and `close()` tears down the chain.
 *
 * @param {Object} opts
 * @param {Array<{host:string,port?:number|string,user:string,privateKey:string,passphrase?:string}>} opts.hops
 * @param {number} [opts.targetHopIndex]
 * @param {string} opts.command
 * @param {false | { cols?: number, rows?: number, term?: string }} [opts.pty=false]
 * @returns {Promise<{ stream: import('ssh2').ClientChannel, close: () => void }>}
 */
async function openSshExec({ hops, targetHopIndex, command, pty = false }) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('exec command is required');
  }
  const { leafClient, cleanup } = await walkChain({ hops, targetHopIndex, label: 'exec' });
  try {
    const execOpts = pty
      ? { pty: { rows: pty.rows || 30, cols: pty.cols || 120, term: pty.term || 'xterm-256color' } }
      : {};
    const stream = await new Promise((resolve, reject) => {
      leafClient.exec(command, execOpts, (err, s) => {
        if (err) reject(err);
        else resolve(s);
      });
    });
    return wrapStream(stream, cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Walk an SSH hop chain up to `targetHopIndex` (inclusive). Returns the SSH
 * Client for the target hop and a `cleanup` function that closes every client
 * established along the way (in reverse order).
 *
 * @returns {Promise<{ leafClient: import('ssh2').Client, cleanup: () => void }>}
 */
async function walkChain({ hops, targetHopIndex, label = 'tunnel' }) {
  const hopList = Array.isArray(hops) ? hops : [];
  if (hopList.length === 0) throw new Error(`${label}: at least one SSH hop is required`);
  const lastIdx = hopList.length - 1;
  const targetIdx = Number.isInteger(targetHopIndex) ? targetHopIndex : lastIdx;
  if (targetIdx < 0 || targetIdx > lastIdx) {
    throw new Error(`${label} hop index out of range: ${targetIdx} (chain has ${hopList.length} hop(s))`);
  }

  const clients = [];
  const cleanup = () => {
    for (const c of clients.slice().reverse()) {
      try { c.end(); } catch {}
    }
  };

  let prevStream = null;
  try {
    for (let i = 0; i <= targetIdx; i++) {
      const hop = hopList[i];
      if (!hop.host) throw new Error(`hop ${i + 1}: host is required`);
      if (!hop.user) throw new Error(`hop ${i + 1}: user is required`);
      if (!hop.privateKey) throw new Error(`hop ${i + 1}: privateKey is required`);

      const client = new Client();
      clients.push(client);
      // Persistent listener so post-connect errors (keepalive timeout, peer
      // close, etc.) don't crash the process with an unhandled 'error' event.
      client.on('error', (err) => {
        console.log(`[ssh2 ${label} hop${i + 1}] post-connect error: ${err.message}`);
      });

      await new Promise((resolve, reject) => {
        const onError = (err) => {
          client.removeListener('ready', onReady);
          reject(new Error(`hop ${i + 1} (${hop.host}): ${err.message}`));
        };
        const onReady = () => {
          client.removeListener('error', onError);
          resolve();
        };
        client.once('ready', onReady);
        client.once('error', onError);
        client.connect({
          host: hop.host,
          port: Number(hop.port) || 22,
          username: hop.user,
          privateKey: hop.privateKey,
          passphrase: hop.passphrase || undefined,
          sock: prevStream || undefined,
          readyTimeout: 15_000,
          keepaliveInterval: 10_000,
        });
      });

      if (i < targetIdx) {
        const next = hopList[i + 1];
        prevStream = await new Promise((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, next.host, Number(next.port) || 22, (err, stream) => {
            if (err) reject(new Error(`hop ${i + 1} -> hop ${i + 2} (${next.host}): ${err.message}`));
            else resolve(stream);
          });
        });
      } else {
        return { leafClient: client, cleanup };
      }
    }
    // Loop body always returns when i === targetIdx, so this is unreachable.
    throw new Error(`${label} chain did not resolve`);
  } catch (err) {
    cleanup();
    throw err;
  }
}

function wrapStream(stream, cleanup) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { stream.end(); } catch {}
    try { stream.close(); } catch {}
    cleanup();
  };
  stream.on('close', () => {
    if (closed) return;
    closed = true;
    cleanup();
  });
  return { stream, close };
}

module.exports = { openTunnelChain, openSshShell, openSshExec };
