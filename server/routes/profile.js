const express = require('express');
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const multer = require('multer');
const { pool } = require('../db');
const { DATA_DIR } = require('../dataPath');

const router = express.Router();

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

const avatarStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(DATA_DIR, req.session.userId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `avatar${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported image type'));
  },
});

router.put('/', (req, res) => {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    avatarUpload.single('avatar')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        const avatarUrl = req.file ? '/api/profile/avatar?v=' + Date.now() : null;
        if (avatarUrl) {
          await pool.query(
            'UPDATE aperium.users SET avatar_url = $1, updated_at = now() WHERE id = $2',
            [avatarUrl, req.session.userId]
          );
        }
        const { rows } = await pool.query('SELECT * FROM aperium.users WHERE id = $1', [req.session.userId]);
        res.json(publicUser(rows[0]));
      } catch (e) {
        res.status(500).json({ error: 'Internal error' });
      }
    });
    return;
  }

  (async () => {
    const { displayName, email, currentPassword, newPassword } = req.body || {};
    try {
      const { rows: existingRows } = await pool.query(
        'SELECT * FROM aperium.users WHERE id = $1',
        [req.session.userId]
      );
      if (existingRows.length === 0) return res.status(401).json({ error: 'User not found' });
      const existing = existingRows[0];

      const updates = [];
      const params = [];
      let i = 1;

      if (typeof displayName === 'string' && displayName.trim()) {
        updates.push(`display_name = $${i++}`);
        params.push(displayName.trim());
      }
      if (typeof email === 'string' && email !== existing.email) {
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
        const dup = await pool.query(
          'SELECT 1 FROM aperium.users WHERE email = $1 AND id <> $2',
          [email, req.session.userId]
        );
        if (dup.rowCount > 0) return res.status(409).json({ error: 'Email already used' });
        updates.push(`email = $${i++}`);
        params.push(email);
      }
      if (newPassword) {
        if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
        const ok = await argon2.verify(existing.password_hash, currentPassword);
        if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
          return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }
        const hash = await argon2.hash(newPassword, ARGON_OPTS);
        updates.push(`password_hash = $${i++}`);
        params.push(hash);
      }

      if (updates.length === 0) return res.json(publicUser(existing));

      updates.push(`updated_at = now()`);
      params.push(req.session.userId);
      const sql = `UPDATE aperium.users SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`;
      const { rows } = await pool.query(sql, params);
      res.json(publicUser(rows[0]));
    } catch (err) {
      console.error('Profile update error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  })();
});

router.get('/avatar', (req, res) => {
  const dir = path.join(DATA_DIR, req.session.userId);
  for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
    const f = path.join(dir, `avatar${ext}`);
    if (fs.existsSync(f)) return res.sendFile(f);
  }
  res.status(404).end();
});

module.exports = router;
