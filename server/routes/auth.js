const express = require('express');
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { DATA_DIR } = require('../dataPath');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

const USER_COLUMNS = 'id, email, display_name, password_hash, avatar_url, role, created_at, updated_at';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registrations, please try again later' },
});

const COOKIE_OPTS = {
  path: '/',
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.COOKIE_SECURE === 'true',
};

const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    role: u.role,
  };
}

// One-shot copy of legacy root-level data/{connections,snippets,bastions}.json
// into the directory of the user whose email matches APERIUM_MIGRATE_TO_EMAIL.
// If the env var is unset, no migration ever runs — pre-existing root files
// are simply ignored. The .migrated flag prevents repeats.
async function migrateLegacyDataIfNeeded(user) {
  const target = process.env.APERIUM_MIGRATE_TO_EMAIL;
  if (!target || target.toLowerCase() !== String(user.email).toLowerCase()) return;
  const flagFile = path.join(DATA_DIR, '.migrated');
  if (fs.existsSync(flagFile)) return;
  const userDir = path.join(DATA_DIR, user.id);
  fs.mkdirSync(userDir, { recursive: true });
  for (const name of ['connections.json', 'snippets.json', 'bastions.json']) {
    const src = path.join(DATA_DIR, name);
    if (fs.existsSync(src)) {
      const dst = path.join(userDir, name);
      try { fs.copyFileSync(src, dst); } catch {}
    }
  }
  fs.writeFileSync(flagFile, `${new Date().toISOString()} ${user.email}\n`);
}

router.post('/register', registerLimiter, async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'Display name is required' });
  }

  try {
    const exists = await pool.query('SELECT 1 FROM aperium.users WHERE email = $1', [email]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'Email already registered' });

    const hash = await argon2.hash(password, ARGON_OPTS);
    const { rows } = await pool.query(
      `INSERT INTO aperium.users (email, display_name, password_hash)
       VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
      [email, displayName.trim(), hash]
    );
    const user = rows[0];

    fs.mkdirSync(path.join(DATA_DIR, user.id), { recursive: true });
    await migrateLegacyDataIfNeeded(user);

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Session error' });
        res.status(201).json(publicUser(user));
      });
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM aperium.users WHERE email = $1`,
      [email]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Late-binding migration: if the env var is set after the target user
    // already registered, migrate on first login instead.
    try { await migrateLegacyDataIfNeeded(user); } catch {}

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Session error' });
        res.json(publicUser(user));
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('aperium.sid', COOKIE_OPTS);
      res.status(204).end();
    });
  } else {
    res.status(204).end();
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM aperium.users WHERE id = $1`,
      [req.session.userId]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
    res.json(publicUser(rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
