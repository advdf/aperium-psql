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

  const clients = [];
  let prevStream = null;

  const cleanup = () => {
    for (const c of clients.slice().reverse()) {
      try { c.end(); } catch {}
    }
  };

  try {
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      if (!hop.host) throw new Error(`hop ${i + 1}: host is required`);
      if (!hop.user) throw new Error(`hop ${i + 1}: user is required`);
      if (!hop.privateKey) throw new Error(`hop ${i + 1}: privateKey is required`);

      const client = new Client();
      clients.push(client);

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

      const isLast = i === hops.length - 1;
      if (!isLast) {
        const next = hops[i + 1];
        prevStream = await new Promise((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, next.host, Number(next.port) || 22, (err, stream) => {
            if (err) reject(new Error(`hop ${i + 1} -> hop ${i + 2} (${next.host}): ${err.message}`));
            else resolve(stream);
          });
        });
      } else {
        const server = net.createServer((sock) => {
          client.forwardOut('127.0.0.1', sock.remotePort || 0, dbHost, dbPort, (err, stream) => {
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
            for (const c of clients.slice().reverse()) {
              try { c.end(); } catch {}
            }
          },
        };
      }
    }
    // unreachable
    throw new Error('tunnel chain did not resolve');
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = { openTunnelChain };
