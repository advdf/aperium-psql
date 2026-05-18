// App DB pool. PG_PASSWORD is resolved from the KMS the first time the pool
// opens a connection — pg's Pool accepts an async function for `password`.
// `initSchema()` triggers that first connection at boot, so the value is
// cached well before any HTTP request hits a route.

const { Pool } = require('pg');

let cachedPassword = null;
async function resolvePgPassword() {
  if (cachedPassword !== null) return cachedPassword;
  const { resolveBootSecret } = require('./secrets');
  cachedPassword = await resolveBootSecret('PG_PASSWORD', 'openbao:server/pg-password', {
    log: (...a) => console.log('[secrets]', ...a),
  });
  return cachedPassword;
}

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'postgres',
  password: resolvePgPassword,
  database: process.env.PG_DATABASE || 'postgres',
});

async function initSchema() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS aperium;

    CREATE TABLE IF NOT EXISTS aperium.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS aperium.sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_expire ON aperium.sessions(expire);
  `);
}

module.exports = { pool, initSchema };
