// Wires the rest of the server to OpenBao. All sensitive values (Postgres
// passwords, SSH passphrases, inline private keys, the session secret, and
// the app DB password) flow through this module instead of living on disk
// or in env vars.
//
// `APERIUM_KMS` must be `openbao` (a sanity check that the operator
// explicitly chose to run with a KMS — anything else is fatal at boot).
// There is no plaintext fallback.
//
// A "ref" is an opaque string of the form `openbao:<path>`. Refs are
// durable: writing the same logical value yields the same ref when an
// explicit ref is passed (putAt), and a freshly-uuid-suffixed ref when a
// scope/name is passed (put). Callers that need a stable, well-known ref
// (e.g. SESSION_SECRET) use putAt; callers persisting one secret per
// record (e.g. per-connection password) use put.
//
// All methods are async and throw on transport/auth/shape errors. `get`
// also throws on missing secrets — callers that want to tolerate 404
// should catch and inspect `err.code === 'NOT_FOUND'`.

const createOpenBao = require('./openbao');

let cached = null;

function looksLikeRef(s) {
  return typeof s === 'string' && /^openbao:.+/.test(s);
}

function getSecretStore() {
  if (cached) return cached;
  const kind = (process.env.APERIUM_KMS || '').trim().toLowerCase();
  if (kind !== 'openbao') {
    throw new Error('APERIUM_KMS must be set to "openbao" — see docs/kms.md.');
  }
  cached = createOpenBao();
  cached.kind = 'openbao';
  return cached;
}

// Helper used at boot: if the env var holds a literal cleartext value
// (not a ref), push it to the KMS at the well-known `defaultRef`, log a
// one-time warning, and return the resolved value. If the env var holds
// a ref, resolve normally. If the env var is unset, resolve from the
// well-known ref. If the well-known ref is missing AND `bootstrap` is
// provided, seed it and return the seed value.
async function resolveBootSecret(envName, defaultRef, opts = {}) {
  const store = getSecretStore();
  const value = process.env[envName];
  const log = opts.log || ((...a) => console.log('[secrets]', ...a));

  // 1. Env var contains a real ref → resolve it.
  if (value && looksLikeRef(value)) {
    try {
      return await store.get(value);
    } catch (err) {
      throw new Error(`${envName} ref ${value} could not be resolved: ${err.message}`);
    }
  }

  // 2. Env var contains a literal cleartext value → push to default ref,
  //    use the value, warn the operator.
  if (value) {
    try {
      await store.putAt(defaultRef, value);
    } catch (err) {
      throw new Error(`${envName} literal could not be pushed to KMS at ${defaultRef}: ${err.message}`);
    }
    log(`WARNING: ${envName} was provided as a cleartext env var. Pushed to KMS at ${defaultRef}; replace the env var with that ref to remove the plaintext from docker inspect.`);
    return value;
  }

  // 3. Env var unset → try the default ref.
  try {
    return await store.get(defaultRef);
  } catch (err) {
    if (err.code !== 'NOT_FOUND') {
      throw new Error(`${envName} could not be resolved from ${defaultRef}: ${err.message}`);
    }
  }

  // 4. Default ref missing AND a bootstrap value is provided → seed.
  if (opts.bootstrap) {
    const seed = typeof opts.bootstrap === 'function' ? opts.bootstrap() : String(opts.bootstrap);
    await store.putAt(defaultRef, seed);
    log(`Seeded ${defaultRef} (was missing).`);
    return seed;
  }

  throw new Error(`${envName} is unset and ${defaultRef} does not exist in the KMS. Seed it manually (see docs/kms.md) or set ${envName} to a literal value once for auto-bootstrap.`);
}

module.exports = {
  getSecretStore,
  looksLikeRef,
  resolveBootSecret,
};
