// Infisical adapter for the SecretStore abstraction.
// Uses Node 20 native `fetch` against the Infisical REST API.
//
// Config:
//   INFISICAL_ADDR             base URL (e.g. https://app.infisical.com or
//                              the self-hosted host)
//   INFISICAL_CLIENT_ID        machine-identity universal-auth client id
//   INFISICAL_CLIENT_SECRET    machine-identity universal-auth secret
//   INFISICAL_PROJECT_ID       (a.k.a. workspaceId) the project to use
//   INFISICAL_ENV              environment slug (default "prod")
//
// Ref shape: `infisical:<env>:<secretName>`. Infisical does not allow `/`
// in secret names, so user secrets are stored under names of the shape
// `aperium__<scope>__<name>__<uuid>` (double-underscore separators).

const { randomUUID } = require('crypto');

function trimSlashes(s) { return String(s || '').replace(/^\/+|\/+$/g, ''); }
function flatName(parts) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/[^A-Za-z0-9_.-]/g, '_'))
    .join('__');
}

class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; }
}

function createInfisical() {
  const addr = trimSlashes(process.env.INFISICAL_ADDR || '');
  const clientId = process.env.INFISICAL_CLIENT_ID || '';
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET || '';
  const projectId = process.env.INFISICAL_PROJECT_ID || '';
  const defaultEnv = process.env.INFISICAL_ENV || 'prod';

  if (!addr) throw new Error('INFISICAL_ADDR is required when APERIUM_KMS=infisical.');
  if (!clientId) throw new Error('INFISICAL_CLIENT_ID is required when APERIUM_KMS=infisical.');
  if (!clientSecret) throw new Error('INFISICAL_CLIENT_SECRET is required when APERIUM_KMS=infisical.');
  if (!projectId) throw new Error('INFISICAL_PROJECT_ID is required when APERIUM_KMS=infisical.');

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function authToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt - 30_000) return cachedToken;
    let res;
    try {
      res = await fetch(`${addr}/api/v1/auth/universal-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });
    } catch (err) { throw new Error(`Infisical auth network error: ${err.message}`); }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Infisical auth → ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const token = json && (json.accessToken || json.access_token || json.token);
    if (!token) throw new Error('Infisical auth: no accessToken in response');
    const lifetimeSec = Number(json.accessTokenMaxTTL || json.expiresIn || 600);
    cachedToken = token;
    tokenExpiresAt = now + lifetimeSec * 1000;
    return token;
  }

  function parseRef(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('infisical:')) {
      throw new Error(`not an infisical ref: ${String(ref).slice(0, 40)}`);
    }
    const rest = ref.slice('infisical:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) throw new Error(`malformed infisical ref: ${ref.slice(0, 60)}`);
    return { env: rest.slice(0, colon), name: rest.slice(colon + 1) };
  }

  async function authHeaders() {
    return {
      Authorization: `Bearer ${await authToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  // The /v3/secrets/raw/{name} endpoints expect workspaceId + environment as
  // query params and the secret name in the URL.
  function urlFor(name, env) {
    const u = new URL(`${addr}/api/v3/secrets/raw/${encodeURIComponent(name)}`);
    u.searchParams.set('workspaceId', projectId);
    u.searchParams.set('environment', env);
    u.searchParams.set('secretPath', '/');
    return u.toString();
  }

  async function get(ref) {
    const { env, name } = parseRef(ref);
    const h = await authHeaders();
    let res;
    try { res = await fetch(urlFor(name, env), { method: 'GET', headers: h }); }
    catch (err) { throw new Error(`Infisical GET ${name} network error: ${err.message}`); }
    if (res.status === 404) throw new NotFoundError(`Infisical secret not found: ${name}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Infisical GET ${name} → ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const value = json && json.secret && json.secret.secretValue;
    if (typeof value !== 'string') throw new Error(`Infisical secret ${name} has no secretValue`);
    return value;
  }

  async function upsert(name, env, value) {
    // Try POST first (create). If it 409s (already exists), fall back to
    // PATCH (update). This makes putAt idempotent.
    const h = await authHeaders();
    const url = urlFor(name, env);
    const body = JSON.stringify({
      workspaceId: projectId,
      environment: env,
      secretValue: value,
      secretPath: '/',
      type: 'shared',
    });
    let res;
    try { res = await fetch(url, { method: 'POST', headers: h, body }); }
    catch (err) { throw new Error(`Infisical POST ${name} network error: ${err.message}`); }
    if (res.ok) return;
    if (res.status !== 409 && res.status !== 400 && res.status !== 422) {
      const t = await res.text().catch(() => '');
      throw new Error(`Infisical POST ${name} → ${res.status}: ${t.slice(0, 200)}`);
    }
    // Fall through to PATCH (existing secret).
    let res2;
    try { res2 = await fetch(url, { method: 'PATCH', headers: h, body }); }
    catch (err) { throw new Error(`Infisical PATCH ${name} network error: ${err.message}`); }
    if (!res2.ok) {
      const t = await res2.text().catch(() => '');
      throw new Error(`Infisical PATCH ${name} → ${res2.status}: ${t.slice(0, 200)}`);
    }
  }

  async function putAt(ref, value) {
    if (typeof value !== 'string') throw new Error('secret value must be a string');
    const { env, name } = parseRef(ref);
    await upsert(name, env, value);
    return ref;
  }

  async function put(scope, name, value) {
    if (!scope) throw new Error('put: scope is required');
    if (!name) throw new Error('put: name is required');
    const secretName = flatName(['aperium', scope, name, randomUUID()]);
    const ref = `infisical:${defaultEnv}:${secretName}`;
    await putAt(ref, value);
    return ref;
  }

  async function del(ref) {
    const { env, name } = parseRef(ref);
    const h = await authHeaders();
    let res;
    try {
      res = await fetch(urlFor(name, env), {
        method: 'DELETE',
        headers: h,
        body: JSON.stringify({ workspaceId: projectId, environment: env, secretPath: '/' }),
      });
    } catch (err) { throw new Error(`Infisical DELETE ${name} network error: ${err.message}`); }
    if (res.status === 404) return;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Infisical DELETE ${name} → ${res.status}: ${t.slice(0, 200)}`);
    }
  }

  async function healthcheck() {
    // Verifying we can mint a token is the most reliable end-to-end check:
    // it exercises the address, the machine identity, and the network path.
    await authToken();
  }

  return { get, put, putAt, delete: del, healthcheck };
}

module.exports = createInfisical;
module.exports.NotFoundError = NotFoundError;
