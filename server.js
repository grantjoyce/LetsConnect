'use strict';

/**
 * Let's Connect - server.
 *
 * One file on purpose. Express + a vanilla-JS SPA in public/, MariaDB behind
 * a single shared pool. No build step.
 */

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { pool, query, queryOne } = require('./db');
const APP_VERSION = require('./package.json').version;

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';

// Behind Plesk's HTTPS reverse proxy. Without this AND a secure cookie, the
// login POST succeeds and then every subsequent request is unauthenticated.
if (IS_PROD) app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Session store - MySQL, not memory
//
// Written against the existing pool rather than pulling in a dependency. Two
// production-specific reasons it cannot be the default in-memory store:
//   1. every deploy restarts the app, which would log everyone out
//   2. Passenger runs multiple workers, so a request landing on a worker that
//      does not hold your session wrongly returns "please log in"
// ---------------------------------------------------------------------------

class MySQLSessionStore extends session.Store {
  constructor() {
    super();
    this.ready = this.init();
    // Sweep expired rows hourly. unref() so it never holds the process open.
    this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  async init() {
    await query(
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id VARCHAR(128) NOT NULL PRIMARY KEY,
         expires    DATETIME NOT NULL,
         data       MEDIUMTEXT NOT NULL,
         KEY idx_sessions_expires (expires)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
  }

  async sweep() {
    try {
      await query('DELETE FROM sessions WHERE expires < NOW()');
    } catch (err) {
      console.error('[sessions] sweep failed:', err.message);
    }
  }

  expiryOf(sess) {
    const ms = (sess && sess.cookie && sess.cookie.maxAge) || SESSION_MAX_AGE;
    return new Date(Date.now() + ms);
  }

  get(sid, cb) {
    this.ready
      .then(() => queryOne('SELECT data FROM sessions WHERE session_id = ? AND expires > NOW()', [sid]))
      .then((row) => cb(null, row ? JSON.parse(row.data) : null))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    const data = JSON.stringify(sess);
    this.ready
      .then(() =>
        query(
          `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
          [sid, this.expiryOf(sess), data]
        )
      )
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  destroy(sid, cb) {
    this.ready
      .then(() => query('DELETE FROM sessions WHERE session_id = ?', [sid]))
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb) {
    this.ready
      .then(() => query('UPDATE sessions SET expires = ? WHERE session_id = ?', [this.expiryOf(sess), sid]))
      .then(() => cb(null))
      .catch((err) => cb(err));
  }
}

// 30 days. This is a personal app people open occasionally - being logged out
// between sessions would be the single most annoying thing about it.
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

app.use(
  session({
    name: 'lc.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    store: new MySQLSessionStore(),
    resave: false,
    saveUninitialized: false,
    // Re-issue the cookie on every response so the 30 days is a sliding window
    // of inactivity rather than a hard deadline stamped once at login.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: SESSION_MAX_AGE,
    },
  })
);

// Never cache an API response.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // How long a skipped question is held back before it can come round again.
  // "Skip" means "not tonight", not "never" - see the deck query.
  skip_cooloff_days: 14,
  // How many cards the client pre-loads per deck.
  deck_size: 30,
};

async function getSetting(key) {
  try {
    const row = await queryOne('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
    if (row && row.setting_value !== null && row.setting_value !== '') return row.setting_value;
  } catch (err) {
    console.error('[settings] read failed:', err.message);
  }
  return DEFAULTS[key];
}

/** An integer setting, validated - it gets inlined into SQL, so it must be one. */
async function getIntSetting(key) {
  const raw = await getSetting(key);
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : DEFAULTS[key];
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/** Wraps an async route so a rejection becomes a 500 instead of a hung request. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Invite codes avoid 0/O/1/I/5/S so they survive being read aloud or texted.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY2346789';

function makeInviteCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function normaliseEmail(v) {
  return String(v || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Login throttling
//
// In-memory and therefore PER WORKER - Passenger runs several, so this slows a
// brute-force attempt down rather than stopping it dead. That is the right
// trade here: it costs nothing, needs no table, and the accounts are protected
// by bcrypt regardless.
// ---------------------------------------------------------------------------

const loginAttempts = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 10 * 60 * 1000;

function attemptKey(req, email) {
  return `${req.ip}|${email}`;
}

function isLockedOut(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > LOCK_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return rec.count >= LOCK_AFTER;
}

function noteFailure(key) {
  const rec = loginAttempts.get(key);
  if (!rec || Date.now() - rec.first > LOCK_MS) loginAttempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function loadUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  try {
    req.user = await queryOne(
      'SELECT id, email, display_name, is_admin, is_active FROM users WHERE id = ?',
      [req.session.userId]
    );
    if (req.user && !req.user.is_active) req.user = null;
  } catch (err) {
    return next(err);
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.user) return fail(res, 401, 'Please log in.');
  return next();
}

/**
 * Deny-by-default gate for everything that touches a couple's content.
 * Attaches req.couple. A couple with a single member is valid - you can start
 * before your partner has joined.
 */
async function requireCouple(req, res, next) {
  try {
    const row = await queryOne(
      `SELECT c.id, c.invite_code, c.couple_name, c.shuffle_seed, c.status, m.member_role
         FROM couple_members m
         JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ? AND c.status = 'active'`,
      [req.user.id]
    );
    if (!row) return fail(res, 403, 'You are not part of a couple yet.');
    req.couple = row;
    return next();
  } catch (err) {
    return next(err);
  }
}

app.use('/api', loadUser);

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: APP_VERSION });
});

app.post(
  '/api/auth/register',
  wrap(async (req, res) => {
    const email = normaliseEmail(req.body.email);
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail(res, 400, 'Enter a valid email address.');
    }
    if (!displayName) return fail(res, 400, 'Enter your first name.');
    if (displayName.length > 100) return fail(res, 400, 'That name is too long.');
    if (password.length < 8) return fail(res, 400, 'Your password needs at least 8 characters.');

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return fail(res, 409, 'There is already an account with that email.');

    const hash = await bcrypt.hash(password, 10);
    // The very first account is the admin, so a fresh install has one without
    // needing a setup screen.
    const anyUser = await queryOne('SELECT id FROM users LIMIT 1');
    const isAdmin = anyUser ? 0 : 1;

    const result = await query(
      'INSERT INTO users (email, password_hash, display_name, is_admin, last_login_at) VALUES (?, ?, ?, ?, NOW())',
      [email, hash, displayName, isAdmin]
    );

    req.session.regenerate((err) => {
      if (err) return fail(res, 500, 'Could not start your session.');
      req.session.userId = result.insertId;
      return res.status(201).json({ ok: true });
    });
    return undefined;
  })
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const email = normaliseEmail(req.body.email);
    const password = String(req.body.password || '');
    const key = attemptKey(req, email);

    if (isLockedOut(key)) {
      return fail(res, 429, 'Too many attempts. Wait ten minutes and try again.');
    }
    if (!email || !password) return fail(res, 400, 'Enter your email and password.');

    const user = await queryOne(
      'SELECT id, password_hash, is_active FROM users WHERE email = ?',
      [email]
    );

    // Same message either way - never reveal whether the email exists.
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      noteFailure(key);
      return fail(res, 401, 'That email and password do not match.');
    }

    loginAttempts.delete(key);
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    req.session.regenerate((err) => {
      if (err) return fail(res, 500, 'Could not start your session.');
      req.session.userId = user.id;
      return res.json({ ok: true });
    });
    return undefined;
  })
);

app.post('/api/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  return req.session.destroy(() => {
    res.clearCookie('lc.sid');
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Everything below requires a login
// ---------------------------------------------------------------------------

/** One bootstrap call: who I am, my couple, and every level with my progress. */
app.get(
  '/api/data',
  requireAuth,
  wrap(async (req, res) => {
    const couple = await queryOne(
      `SELECT c.id, c.invite_code, c.couple_name, c.created_at, m.member_role
         FROM couple_members m
         JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ? AND c.status = 'active'`,
      [req.user.id]
    );

    let members = [];
    let levels = [];

    if (couple) {
      members = await query(
        `SELECT u.id, u.display_name, m.member_role, m.joined_at
           FROM couple_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.couple_id = ?
          ORDER BY m.joined_at`,
        [couple.id]
      );
      levels = await levelsWithProgress(couple.id);
    }

    res.json({
      version: APP_VERSION,
      me: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.display_name,
        isAdmin: !!req.user.is_admin,
      },
      couple: couple
        ? {
            id: couple.id,
            inviteCode: couple.invite_code,
            name: couple.couple_name,
            role: couple.member_role,
            createdAt: couple.created_at,
            members: members.map((m) => ({
              id: m.id,
              displayName: m.display_name,
              role: m.member_role,
            })),
          }
        : null,
      levels,
    });
  })
);

/**
 * Every active level with this couple's counts.
 *
 * `available` is what could be served right now: never-seen questions, plus
 * skipped ones whose cool-off has passed.
 */
async function levelsWithProgress(coupleId) {
  const cooloff = await getIntSetting('skip_cooloff_days');
  const rows = await query(
    `SELECT l.id, l.slug, l.name, l.tagline, l.description, l.depth, l.accent,
            COUNT(q.id) AS total,
            SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN s.id IS NULL
                       OR (s.status = 'skipped'
                           AND s.decided_at < DATE_SUB(NOW(), INTERVAL ${cooloff} DAY))
                     THEN 1 ELSE 0 END) AS available
       FROM levels l
       LEFT JOIN questions q ON q.level_id = l.id AND q.is_active = 1
       LEFT JOIN couple_question_status s ON s.question_id = q.id AND s.couple_id = ?
      WHERE l.is_active = 1
      GROUP BY l.id, l.slug, l.name, l.tagline, l.description, l.depth, l.accent, l.sort_order
      ORDER BY l.sort_order`,
    [coupleId]
  );

  return rows.map((r) => {
    const available = Number(r.available) || 0;
    const skipped = Number(r.skipped) || 0;
    return {
      slug: r.slug,
      name: r.name,
      tagline: r.tagline,
      description: r.description,
      depth: r.depth,
      accent: r.accent,
      total: Number(r.total) || 0,
      completed: Number(r.completed) || 0,
      skipped,
      // Never served while something else remains.
      available,
      // What the deck would ACTUALLY hand over if opened right now. When the
      // cool-off is the only thing holding cards back, the deck releases them
      // early rather than dead-ending - so `available` alone understates what
      // is waiting, and the UI must count this instead or it will show
      // "0 ready" for a deck that is about to serve cards.
      ready: available > 0 ? available : skipped,
    };
  });
}

// ---- Couple management ----------------------------------------------------

app.post(
  '/api/couple',
  requireAuth,
  wrap(async (req, res) => {
    const already = await queryOne(
      `SELECT c.id FROM couple_members m JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ? AND c.status = 'active'`,
      [req.user.id]
    );
    if (already) return fail(res, 409, 'You are already part of a couple.');

    const name = String(req.body.name || '').trim().slice(0, 120) || null;

    // Retry on the (very unlikely) collision rather than trusting one draw.
    let code = null;
    for (let i = 0; i < 12 && !code; i += 1) {
      const candidate = makeInviteCode();
      const clash = await queryOne('SELECT id FROM couples WHERE invite_code = ?', [candidate]);
      if (!clash) code = candidate;
    }
    if (!code) return fail(res, 500, 'Could not generate an invite code. Try again.');

    const seed = crypto.randomBytes(8).toString('hex');
    const result = await query(
      'INSERT INTO couples (invite_code, couple_name, shuffle_seed, created_by_user_id) VALUES (?, ?, ?, ?)',
      [code, name, seed, req.user.id]
    );
    await query(
      "INSERT INTO couple_members (couple_id, user_id, member_role) VALUES (?, ?, 'creator')",
      [result.insertId, req.user.id]
    );

    res.status(201).json({ ok: true, inviteCode: code });
  })
);

app.post(
  '/api/couple/join',
  requireAuth,
  wrap(async (req, res) => {
    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!code) return fail(res, 400, 'Enter the invite code your partner gave you.');

    const already = await queryOne(
      `SELECT c.id FROM couple_members m JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ? AND c.status = 'active'`,
      [req.user.id]
    );
    if (already) return fail(res, 409, 'You are already part of a couple.');

    const couple = await queryOne(
      "SELECT id FROM couples WHERE invite_code = ? AND status = 'active'",
      [code]
    );
    if (!couple) return fail(res, 404, 'That code does not match any couple.');

    const count = await queryOne(
      'SELECT COUNT(*) AS n FROM couple_members WHERE couple_id = ?',
      [couple.id]
    );
    if (Number(count.n) >= 2) return fail(res, 409, 'That couple already has two people in it.');

    await query(
      "INSERT INTO couple_members (couple_id, user_id, member_role) VALUES (?, ?, 'partner')",
      [couple.id, req.user.id]
    );

    res.json({ ok: true });
  })
);

app.patch(
  '/api/couple',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120) || null;
    await query('UPDATE couples SET couple_name = ? WHERE id = ?', [name, req.couple.id]);
    res.json({ ok: true, name });
  })
);

/**
 * Leave the couple. Without this a mis-typed invite code is a permanent
 * dead-end, since a user can only belong to one couple.
 *
 * Progress stays with the couple, not the person - so if the last member
 * leaves, the couple is marked dissolved rather than deleted and its history
 * is preserved.
 */
app.post(
  '/api/couple/leave',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    await query('DELETE FROM couple_members WHERE couple_id = ? AND user_id = ?', [
      req.couple.id,
      req.user.id,
    ]);
    const left = await queryOne('SELECT COUNT(*) AS n FROM couple_members WHERE couple_id = ?', [
      req.couple.id,
    ]);
    if (Number(left.n) === 0) {
      await query("UPDATE couples SET status = 'dissolved' WHERE id = ?", [req.couple.id]);
    }
    res.json({ ok: true });
  })
);

// ---- The deck -------------------------------------------------------------

/**
 * The next batch of cards for a level.
 *
 * Ordering is a deterministic shuffle on the couple's own seed: stable across
 * sessions, identical for both partners, but different for every couple.
 */
app.get(
  '/api/deck/:slug',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const level = await queryOne(
      'SELECT id, slug, name, tagline, description, depth, accent FROM levels WHERE slug = ? AND is_active = 1',
      [req.params.slug]
    );
    if (!level) return fail(res, 404, 'That level does not exist.');

    const cooloff = await getIntSetting('skip_cooloff_days');
    const deckSize = await getIntSetting('deck_size');
    const seed = req.couple.shuffle_seed;

    const select = (withCooloff) => `
      SELECT q.id, q.ref, q.text,
             s.status AS prior_status, s.skip_count
        FROM questions q
        LEFT JOIN couple_question_status s
          ON s.question_id = q.id AND s.couple_id = ?
       WHERE q.level_id = ? AND q.is_active = 1
         AND (s.id IS NULL${
           withCooloff
             ? ` OR (s.status = 'skipped' AND s.decided_at < DATE_SUB(NOW(), INTERVAL ${cooloff} DAY))`
             : " OR s.status = 'skipped'"
         })
       ORDER BY MD5(CONCAT(q.id, ':', ?))
       LIMIT ${deckSize}`;

    let cards = await query(select(true), [req.couple.id, level.id, seed]);

    // If the cool-off is the only thing standing between the couple and an
    // empty deck, release the skipped questions early. A deck must never
    // dead-end while unanswered cards sit waiting on a timer.
    let releasedEarly = false;
    if (!cards.length) {
      cards = await query(select(false), [req.couple.id, level.id, seed]);
      releasedEarly = cards.length > 0;
    }

    const stats = (await levelsWithProgress(req.couple.id)).find((l) => l.slug === level.slug);

    res.json({
      level: {
        slug: level.slug,
        name: level.name,
        tagline: level.tagline,
        description: level.description,
        depth: level.depth,
        accent: level.accent,
      },
      stats,
      releasedEarly,
      cards: cards.map((c) => ({
        id: c.id,
        ref: c.ref,
        text: c.text,
        seenBefore: !!c.prior_status,
      })),
    });
  })
);

/**
 * Record a decision on a card. NO ANSWER IS STORED - only that the card has
 * been dealt with, which is all that is needed to stop it coming round again.
 *
 * Idempotent upsert, so both partners tapping at once cannot create a
 * duplicate, and a retry after a dropped connection is harmless.
 */
app.post(
  '/api/answer',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const questionId = Number(req.body.questionId);
    const action = String(req.body.action || '');

    if (!Number.isInteger(questionId) || questionId <= 0) {
      return fail(res, 400, 'Missing question.');
    }
    if (action !== 'completed' && action !== 'skipped') {
      return fail(res, 400, 'Action must be "completed" or "skipped".');
    }

    const question = await queryOne('SELECT id, level_id FROM questions WHERE id = ?', [questionId]);
    if (!question) return fail(res, 404, 'That question no longer exists.');

    await query(
      `INSERT INTO couple_question_status
         (couple_id, question_id, status, skip_count, decided_by_user_id, decided_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         skip_count = skip_count + VALUES(skip_count),
         decided_by_user_id = VALUES(decided_by_user_id),
         decided_at = NOW()`,
      [req.couple.id, questionId, action, action === 'skipped' ? 1 : 0, req.user.id]
    );

    const levels = await levelsWithProgress(req.couple.id);
    res.json({ ok: true, levels });
  })
);

/**
 * Clear this couple's progress for one level.
 *
 * Reports what it removed rather than just "ok", so the UI can confirm against
 * a real number instead of an assumption.
 */
app.post(
  '/api/deck/:slug/reset',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const level = await queryOne('SELECT id, slug FROM levels WHERE slug = ?', [req.params.slug]);
    if (!level) return fail(res, 404, 'That level does not exist.');

    const scope = req.body.scope === 'skipped' ? 'skipped' : 'all';
    const sql =
      scope === 'skipped'
        ? `DELETE s FROM couple_question_status s
             JOIN questions q ON q.id = s.question_id
            WHERE s.couple_id = ? AND q.level_id = ? AND s.status = 'skipped'`
        : `DELETE s FROM couple_question_status s
             JOIN questions q ON q.id = s.question_id
            WHERE s.couple_id = ? AND q.level_id = ?`;

    const result = await query(sql, [req.couple.id, level.id]);
    const levels = await levelsWithProgress(req.couple.id);

    res.json({ ok: true, cleared: result.affectedRows || 0, scope, levels });
  })
);

// ---- Account --------------------------------------------------------------

app.patch(
  '/api/me',
  requireAuth,
  wrap(async (req, res) => {
    const displayName = String(req.body.displayName || '').trim();
    if (!displayName) return fail(res, 400, 'Enter your name.');
    if (displayName.length > 100) return fail(res, 400, 'That name is too long.');
    await query('UPDATE users SET display_name = ? WHERE id = ?', [displayName, req.user.id]);
    res.json({ ok: true, displayName });
  })
);

app.post(
  '/api/me/password',
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    if (next.length < 8) return fail(res, 400, 'Your new password needs at least 8 characters.');

    const row = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const ok = row && (await bcrypt.compare(current, row.password_hash));
    if (!ok) return fail(res, 401, 'Your current password is not right.');

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [
      await bcrypt.hash(next, 10),
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

// Any unmatched /api route is a 404 as JSON, never the SPA's HTML.
app.use('/api', (req, res) => fail(res, 404, 'Not found.'));

// ---------------------------------------------------------------------------
// Static
//
// In production Plesk's Document Root points at public/, so nginx serves these
// directly and only /api reaches Node. This block is what makes local dev work
// without that.
// ---------------------------------------------------------------------------

app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    // The service worker must never be served from cache, or a bad one is
    // impossible to replace.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
    },
  })
);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Let's Connect v${APP_VERSION} listening on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});

module.exports = app;
