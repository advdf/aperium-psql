// OpenBao (Vault KV v2-compatible) client. Talks to OpenBao over HTTP
// using Node 20 native `fetch` — no SDK dependency.
//
// Config:
//   OPENBAO_ADDR     base URL, e.g. http://openbao:8200
//   OPENBAO_TOKEN    auth token (X-Vault-Token header)
//   OPENBAO_MOUNT    KV v2 mount path (default "secret")
//
// Storage layout: every aperium secret lives under `<mount>/aperium/...`,
// so a single shared mount can be used alongside other tenants.
//
// Ref shape: `openbao:<relpath>` where <relpath> is the path UNDER the
// `aperium/` prefix. Examples:
//   openbao:server/session-secret
//   openbao:server/pg-password
//   openbao:connections/<userId>/<uuid>
//   openbao:bastions/<userId>/<uuid>/passphrase

const { randomUUID } = require('crypto');

function trimSlashes(s) { return String(s || '').replace(/^\/+|\/+$/g, ''); }

class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; }
}

function createOpenBao() {
  const addr = trimSlashes(process.env.OPENBAO_ADDR || '');
  const token = process.env.OPENBAO_TOKEN || '';
  const mount = trimSlashes(process.env.OPENBAO_MOUNT || 'secret');
  if (!addr) throw new Error('OPENBAO_ADDR is required when APERIUM_KMS=openbao.');
  if (!token) throw new Error('OPENBAO_TOKEN is required when APERIUM_KMS=openbao.');
  const prefix = 'aperium';

  const refToRelpath = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('openbao:')) {
      throw new Error(`not an openbao ref: ${String(ref).slice(0, 40)}`);
    }
    return trimSlashes(ref.slice('openbao:'.length));
  };

  const apiUrl = (relpath, kind) => {
    // kind: 'data' for read/write of the secret body, 'metadata' for delete.
    const rel = trimSlashes(relpath);
    return `${addr}/v1/${mount}/${kind}/${prefix}/${rel}`;
  };

  const headers = () => ({
    'X-Vault-Token': token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });

  async function get(ref) {
    const rel = refToRelpath(ref);
    const url = apiUrl(rel, 'data');
    let res;
    try { res = await fetch(url, { headers: headers(), method: 'GET' }); }
    catch (err) { throw new Error(`OpenBao GET ${rel} network error: ${err.message}`); }
    if (res.status === 404) throw new NotFoundError(`OpenBao secret not found: ${rel}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenBao GET ${rel} → ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const value = json && json.data && json.data.data && json.data.data.value;
    if (typeof value !== 'string') {
      throw new Error(`OpenBao secret ${rel} has no string "value" field`);
    }
    return value;
  }

  async function putAt(ref, value) {
    if (typeof value !== 'string') throw new Error('secret value must be a string');
    const rel = refToRelpath(ref);
    const url = apiUrl(rel, 'data');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ data: { value } }),
      });
    } catch (err) { throw new Error(`OpenBao POST ${rel} network error: ${err.message}`); }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenBao POST ${rel} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return ref;
  }

  async function put(scope, name, value) {
    if (!scope) throw new Error('put: scope is required');
    if (!name) throw new Error('put: name is required');
    const safeScope = trimSlashes(String(scope));
    const safeName = trimSlashes(String(name));
    const ref = `openbao:${safeScope}/${safeName}/${randomUUID()}`;
    await putAt(ref, value);
    return ref;
  }

  async function del(ref) {
    const rel = refToRelpath(ref);
    const url = apiUrl(rel, 'metadata');
    let res;
    try { res = await fetch(url, { method: 'DELETE', headers: headers() }); }
    catch (err) { throw new Error(`OpenBao DELETE ${rel} network error: ${err.message}`); }
    if (res.status === 404) return; // already gone
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenBao DELETE ${rel} → ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async function healthcheck() {
    let res;
    try { res = await fetch(`${addr}/v1/sys/health`, { method: 'GET' }); }
    catch (err) { throw new Error(`OpenBao unreachable at ${addr}: ${err.message}`); }
    // health returns 200 (active), 429 (standby), 472 (DR mode replication
    // secondary), 473 (perf standby). 501 = not initialized, 503 = sealed.
    if (res.status === 501) throw new Error('OpenBao is not initialized (HTTP 501).');
    if (res.status === 503) throw new Error('OpenBao is sealed (HTTP 503). Unseal it before starting Aperium.');
    if (!(res.status === 200 || res.status === 429 || res.status === 472 || res.status === 473)) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenBao health → ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  return { get, put, putAt, delete: del, healthcheck };
}

module.exports = createOpenBao;
module.exports.NotFoundError = NotFoundError;
