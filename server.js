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
         user_id    INT NULL,
         KEY idx_sessions_expires (expires),
         KEY idx_sessions_user (user_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    // Installs that predate user_id get it here. The migration covers the same
    // ground, but this table is created by the app rather than by schema.sql,
    // so it can exist before any migration has ever run against it.
    try {
      const col = await queryOne(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'
            AND COLUMN_NAME = 'user_id'`
      );
      if (!col) {
        await query('ALTER TABLE sessions ADD COLUMN user_id INT NULL');
        await query('ALTER TABLE sessions ADD INDEX idx_sessions_user (user_id)');
      }
    } catch (err) {
      console.error('[sessions] could not verify user_id column:', err.message);
    }
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
    // Mirrored out of the JSON blob into its own column so "end every session
    // for this user" is an exact delete. A LIKE over the JSON cannot tell
    // userId 5 from userId 50.
    const userId = sess && sess.userId ? Number(sess.userId) : null;
    this.ready
      .then(() =>
        query(
          `INSERT INTO sessions (session_id, expires, data, user_id) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data),
                                   user_id = VALUES(user_id)`,
          [sid, this.expiryOf(sess), data, userId]
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

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value === null || value === undefined ? null : String(value)]
  );
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// Secrets at rest
//
// The SMTP password is the one secret this app must be able to READ BACK, so
// it cannot be hashed - it is encrypted with AES-256-GCM under a key from the
// environment, never from the database.
//
// SECRET_KEY is the dedicated key; SESSION_SECRET is a fallback so an install
// that predates it keeps working. Set SECRET_KEY explicitly in production:
// without it, rotating SESSION_SECRET - an entirely normal thing to do - makes
// the stored SMTP password unreadable.
// ---------------------------------------------------------------------------

const SECRET_KEY_SOURCE =
  process.env.SECRET_KEY || process.env.SESSION_SECRET || 'dev-secret-change-me';
const SECRET_KEY = crypto.createHash('sha256').update(SECRET_KEY_SOURCE).digest();

function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

/**
 * Returns null when the value cannot be decrypted rather than throwing.
 *
 * Failing soft is deliberate: if the key has changed, the recoverable path is
 * "the admin retypes the SMTP password", and an exception here would instead
 * take down every page that happens to read settings.
 */
function decryptSecret(stored) {
  try {
    if (!stored || typeof stored !== 'string' || !stored.startsWith('v1:')) return null;
    const buf = Buffer.from(stored.slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email
//
// Configured in the admin UI, stored in `settings`, so it survives redeploys
// with no server file editing. nodemailer is required lazily so the app still
// boots if the dependency is somehow missing on the host.
// ---------------------------------------------------------------------------

async function getMailConfig() {
  const [host, port, secure, user, pass, from] = await Promise.all([
    getSetting('smtp_host'),
    getSetting('smtp_port'),
    getSetting('smtp_secure'),
    getSetting('smtp_user'),
    getSetting('smtp_password'),
    getSetting('smtp_from'),
  ]);

  const password = decryptSecret(pass);
  return {
    host: host || '',
    port: Number(port) || 587,
    secure: String(secure) === '1' || String(secure) === 'true',
    user: user || '',
    password,
    // A stored-but-unreadable password means the key changed under it.
    passwordUnreadable: !!pass && password === null,
    from: from || '',
    configured: !!(host && from),
  };
}

async function sendMail({ to, subject, text, html }) {
  const cfg = await getMailConfig();
  if (!cfg.configured) throw new Error('Email is not set up yet.');
  if (cfg.passwordUnreadable) {
    throw new Error('The saved SMTP password cannot be read. Retype it in Admin → Email.');
  }

  let nodemailer;
  try {
    // eslint-disable-next-line global-require
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('The email library is not installed on this server.');
  }

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password || '' } : undefined,
  });

  await transport.sendMail({ from: cfg.from, to, subject, text, html });
}

/** Base URL for links in emails. The setting wins; otherwise infer from the request. */
async function appUrl(req) {
  const configured = await getSetting('app_url');
  if (configured) return String(configured).replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
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

// ---- Password reset -------------------------------------------------------

const RESET_TTL_MS = 60 * 60 * 1000; // one hour

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a reset token for a user and returns the raw token ONCE.
 *
 * Only the hash is persisted, so this return value is the only time the real
 * token exists anywhere. Any outstanding tokens for the same user are consumed
 * first - requesting a new link must invalidate the old one, or an email
 * forwarded months ago stays live.
 */
async function issueResetToken(userId, ip) {
  await query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?)',
    [userId, hashToken(token), new Date(Date.now() + RESET_TTL_MS), String(ip || '').slice(0, 64)]
  );
  return token;
}

function resetLink(base, token) {
  return `${base}/?reset=${encodeURIComponent(token)}`;
}

app.post(
  '/api/auth/forgot',
  wrap(async (req, res) => {
    const email = normaliseEmail(req.body.email);
    const key = `forgot|${req.ip}`;

    // Throttled on IP alone, not IP+email, so it cannot be used to sweep a list
    // of addresses one request at a time.
    if (isLockedOut(key)) {
      return fail(res, 429, 'Too many requests. Wait ten minutes and try again.');
    }
    noteFailure(key);

    if (!email) return fail(res, 400, 'Enter your email address.');

    const user = await queryOne(
      'SELECT id, email, display_name, is_active FROM users WHERE email = ?',
      [email]
    );

    // ALWAYS the same response, whether or not the address exists. Anything
    // else turns this endpoint into a way of testing who has an account.
    const generic = {
      ok: true,
      message: 'If that email has an account, a reset link is on its way.',
    };

    if (!user || !user.is_active) return res.json(generic);

    const token = await issueResetToken(user.id, req.ip);
    const link = resetLink(await appUrl(req), token);

    try {
      await sendMail({
        to: user.email,
        subject: "Reset your Let's Connect password",
        text:
          `Hello ${user.display_name},\n\n` +
          `Someone asked to reset the password on your Let's Connect account.\n\n` +
          `${link}\n\n` +
          `The link works once and expires in an hour. If this was not you, you can ` +
          `ignore this email - nothing has changed.\n`,
        html:
          `<p>Hello ${user.display_name},</p>` +
          `<p>Someone asked to reset the password on your Let's Connect account.</p>` +
          `<p><a href="${link}">Choose a new password</a></p>` +
          `<p>The link works once and expires in an hour. If this was not you, you can ` +
          `ignore this email &mdash; nothing has changed.</p>`,
      });
    } catch (err) {
      // The token is already issued and valid. Log the real reason for an admin
      // to find, but never tell the browser - "email failed" would confirm the
      // account exists just as surely as "no such user" would.
      console.error(`[reset] could not email ${user.email}:`, err.message);
    }

    return res.json(generic);
  })
);

/** Lets the SPA check a token before showing the "new password" form. */
app.get(
  '/api/auth/reset/:token',
  wrap(async (req, res) => {
    const row = await queryOne(
      `SELECT u.display_name
         FROM password_resets r
         JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()
          AND u.is_active = 1`,
      [hashToken(String(req.params.token || ''))]
    );
    if (!row) return fail(res, 400, 'That reset link has expired or has already been used.');
    return res.json({ ok: true, displayName: row.display_name });
  })
);

app.post(
  '/api/auth/reset',
  wrap(async (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (password.length < 8) return fail(res, 400, 'Your password needs at least 8 characters.');

    const row = await queryOne(
      `SELECT r.id, r.user_id
         FROM password_resets r
         JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()
          AND u.is_active = 1`,
      [hashToken(token)]
    );
    if (!row) return fail(res, 400, 'That reset link has expired or has already been used.');

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [
      await bcrypt.hash(password, 10),
      row.user_id,
    ]);
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [row.id]);

    // End every existing session for this account. If the reset happened
    // because somebody else was in the account, leaving their session alive
    // would change the lock with the intruder still inside.
    await query('DELETE FROM sessions WHERE user_id = ?', [row.user_id]);

    return res.json({ ok: true });
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
       LEFT JOIN questions q ON q.level_id = l.id AND q.is_active = 1 AND q.admin_hidden = 0
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
       WHERE q.level_id = ? AND q.is_active = 1 AND q.admin_hidden = 0
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

// ---------------------------------------------------------------------------
// Admin
//
// Gated as a whole namespace rather than per route. A new admin endpoint is
// therefore closed by default and you opt in by putting it under /api/admin -
// the opposite way round from remembering to add a check to each one, which is
// how a single forgotten line leaks everything.
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!req.user) return fail(res, 401, 'Please log in.');
  if (!req.user.is_admin) return fail(res, 403, 'Admins only.');
  return next();
}

const admin = express.Router();
app.use('/api/admin', requireAuth, requireAdmin, admin);

admin.get(
  '/overview',
  wrap(async (req, res) => {
    const [counts] = await query(
      `SELECT
         (SELECT COUNT(*) FROM users)                                    AS users,
         (SELECT COUNT(*) FROM users WHERE is_active = 1)                AS activeUsers,
         (SELECT COUNT(*) FROM users WHERE is_admin = 1)                 AS admins,
         (SELECT COUNT(*) FROM couples WHERE status = 'active')          AS couples,
         (SELECT COUNT(*) FROM questions WHERE is_active = 1 AND admin_hidden = 0) AS liveQuestions,
         (SELECT COUNT(*) FROM questions WHERE source = 'admin')         AS adminQuestions,
         (SELECT COUNT(*) FROM questions WHERE admin_hidden = 1)         AS hiddenQuestions,
         (SELECT COUNT(*) FROM couple_question_status)                   AS decisions,
         (SELECT COUNT(*) FROM couple_question_status WHERE status = 'completed') AS completed,
         (SELECT COUNT(*) FROM couple_question_status WHERE status = 'skipped')   AS skipped`
    );

    const recentUsers = await query(
      `SELECT id, email, display_name, is_admin, is_active, created_at, last_login_at
         FROM users ORDER BY created_at DESC LIMIT 8`
    );

    const perLevel = await query(
      `SELECT l.name, l.accent,
              COUNT(q.id) AS questions,
              (SELECT COUNT(*) FROM couple_question_status s
                 JOIN questions q2 ON q2.id = s.question_id
                WHERE q2.level_id = l.id) AS decisions
         FROM levels l
         LEFT JOIN questions q ON q.level_id = l.id AND q.is_active = 1 AND q.admin_hidden = 0
        WHERE l.is_active = 1
        GROUP BY l.id, l.name, l.accent, l.sort_order
        ORDER BY l.sort_order`
    );

    const mail = await getMailConfig();

    res.json({
      counts,
      recentUsers: recentUsers.map(publicUser),
      perLevel: perLevel.map((r) => ({
        name: r.name,
        accent: r.accent,
        questions: Number(r.questions) || 0,
        decisions: Number(r.decisions) || 0,
      })),
      email: { configured: mail.configured, unreadable: mail.passwordUnreadable },
    });
  })
);

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isAdmin: !!u.is_admin,
    isActive: !!u.is_active,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    coupleId: u.couple_id || null,
    coupleName: u.couple_name || null,
  };
}

admin.get(
  '/users',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const rows = await query(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_active, u.created_at,
              u.last_login_at, c.id AS couple_id, c.couple_name
         FROM users u
         LEFT JOIN couple_members m ON m.user_id = u.id
         LEFT JOIN couples c ON c.id = m.couple_id AND c.status = 'active'
        ${q ? 'WHERE u.email LIKE ? OR u.display_name LIKE ?' : ''}
        ORDER BY u.created_at DESC
        LIMIT 200`,
      q ? [like, like] : []
    );
    res.json({ users: rows.map(publicUser) });
  })
);

/**
 * Update a user's name, admin flag or active state.
 *
 * Two guards, deliberately scoped so each one actually does something:
 *
 *   - You cannot DEACTIVATE YOURSELF. There is no legitimate use for it - it
 *     signs you out on the spot and locks you back out - so it is refused
 *     outright rather than confirmed.
 *
 *   - You cannot remove the LAST active admin. This is what makes stepping
 *     down safe: handing over to a colleague and demoting yourself is a real
 *     thing an admin should be able to do, so self-demotion is allowed exactly
 *     when somebody else is left holding the keys.
 *
 * An earlier version blocked ALL self-demotion, which read as safer and was
 * worse: it made the last-admin check unreachable (the caller is always an
 * active admin, so "another admin exists" was true whenever the target was
 * someone else), leaving the real lockout case guarded by nothing but a rule
 * that never fired.
 */
admin.patch(
  '/users/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const target = await queryOne(
      'SELECT id, is_admin, is_active FROM users WHERE id = ?',
      [id]
    );
    if (!target) return fail(res, 404, 'No such user.');

    const wantsAdmin = req.body.isAdmin === undefined ? !!target.is_admin : !!req.body.isAdmin;
    const wantsActive = req.body.isActive === undefined ? !!target.is_active : !!req.body.isActive;
    const losingAdmin = !!target.is_admin && (!wantsAdmin || !wantsActive);

    if (id === req.user.id && !wantsActive) {
      return fail(res, 400, 'You cannot deactivate your own account.');
    }

    if (losingAdmin) {
      const others = await queryOne(
        'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_active = 1 AND id <> ?',
        [id]
      );
      if (Number(others.n) === 0) {
        return fail(
          res,
          400,
          id === req.user.id
            ? 'You are the only admin. Make somebody else an admin before stepping down.'
            : 'This is the only admin left. Promote someone else first.'
        );
      }
    }

    const displayName =
      req.body.displayName === undefined ? null : String(req.body.displayName).trim();
    if (displayName !== null && !displayName) return fail(res, 400, 'Enter a name.');

    await query(
      `UPDATE users
          SET display_name = COALESCE(?, display_name), is_admin = ?, is_active = ?
        WHERE id = ?`,
      [displayName, wantsAdmin ? 1 : 0, wantsActive ? 1 : 0, id]
    );

    // A deactivated account must not keep working until its cookie happens to
    // expire. loadUser() already refuses an inactive user, but ending the
    // session makes it immediate and explicit.
    if (!wantsActive) await query('DELETE FROM sessions WHERE user_id = ?', [id]);

    const fresh = await queryOne(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_active, u.created_at,
              u.last_login_at, c.id AS couple_id, c.couple_name
         FROM users u
         LEFT JOIN couple_members m ON m.user_id = u.id
         LEFT JOIN couples c ON c.id = m.couple_id AND c.status = 'active'
        WHERE u.id = ?`,
      [id]
    );
    res.json({ ok: true, user: publicUser(fresh) });
  })
);

/**
 * Issue a reset link for someone else.
 *
 * Returns the link so it can be handed over directly when email is not set up
 * (or has not arrived). That does let an admin take over an account - but an
 * admin can already promote themselves and read everything, so the link adds no
 * privilege that was not already there. It is the honest, workable option, and
 * the alternative of typing a password FOR someone means the admin then knows
 * their password, which is worse.
 */
admin.post(
  '/users/:id/reset-link',
  wrap(async (req, res) => {
    const user = await queryOne(
      'SELECT id, email, display_name, is_active FROM users WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!user) return fail(res, 404, 'No such user.');
    if (!user.is_active) return fail(res, 400, 'That account is deactivated. Reactivate it first.');

    const token = await issueResetToken(user.id, req.ip);
    const link = resetLink(await appUrl(req), token);

    let emailed = false;
    let emailError = null;
    try {
      await sendMail({
        to: user.email,
        subject: "Reset your Let's Connect password",
        text:
          `Hello ${user.display_name},\n\n` +
          `An administrator has started a password reset for your account.\n\n${link}\n\n` +
          `The link works once and expires in an hour.\n`,
        html:
          `<p>Hello ${user.display_name},</p>` +
          `<p>An administrator has started a password reset for your account.</p>` +
          `<p><a href="${link}">Choose a new password</a></p>` +
          `<p>The link works once and expires in an hour.</p>`,
      });
      emailed = true;
    } catch (err) {
      emailError = err.message;
    }

    res.json({ ok: true, link, emailed, emailError, expiresInMinutes: RESET_TTL_MS / 60000 });
  })
);

admin.get(
  '/couples',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT c.id, c.couple_name, c.invite_code, c.status, c.created_at,
              COUNT(DISTINCT m.user_id) AS members,
              GROUP_CONCAT(DISTINCT u.display_name ORDER BY m.joined_at SEPARATOR ' & ') AS memberNames,
              (SELECT COUNT(*) FROM couple_question_status s
                WHERE s.couple_id = c.id AND s.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM couple_question_status s
                WHERE s.couple_id = c.id AND s.status = 'skipped') AS skipped,
              (SELECT MAX(s.decided_at) FROM couple_question_status s
                WHERE s.couple_id = c.id) AS lastActivity
         FROM couples c
         LEFT JOIN couple_members m ON m.couple_id = c.id
         LEFT JOIN users u ON u.id = m.user_id
        GROUP BY c.id, c.couple_name, c.invite_code, c.status, c.created_at
        ORDER BY c.created_at DESC
        LIMIT 200`
    );
    res.json({
      couples: rows.map((r) => ({
        id: r.id,
        name: r.couple_name,
        inviteCode: r.invite_code,
        status: r.status,
        members: Number(r.members) || 0,
        memberNames: r.memberNames || '',
        completed: Number(r.completed) || 0,
        skipped: Number(r.skipped) || 0,
        lastActivity: r.lastActivity,
        createdAt: r.created_at,
      })),
    });
  })
);

admin.get(
  '/questions',
  wrap(async (req, res) => {
    const slug = String(req.query.level || '').trim();
    const level = slug ? await queryOne('SELECT id FROM levels WHERE slug = ?', [slug]) : null;
    if (slug && !level) return fail(res, 404, 'That level does not exist.');

    const rows = await query(
      `SELECT q.id, q.ref, q.text, q.source, q.is_active, q.admin_hidden, q.sort_order,
              l.slug AS levelSlug, l.name AS levelName,
              (SELECT COUNT(*) FROM couple_question_status s WHERE s.question_id = q.id) AS timesUsed
         FROM questions q
         JOIN levels l ON l.id = q.level_id
        ${level ? 'WHERE q.level_id = ?' : ''}
        ORDER BY l.sort_order, q.source DESC, q.sort_order`,
      level ? [level.id] : []
    );

    res.json({
      questions: rows.map((r) => ({
        id: r.id,
        ref: r.ref,
        text: r.text,
        source: r.source,
        isActive: !!r.is_active,
        hidden: !!r.admin_hidden,
        levelSlug: r.levelSlug,
        levelName: r.levelName,
        timesUsed: Number(r.timesUsed) || 0,
      })),
    });
  })
);

admin.post(
  '/questions',
  wrap(async (req, res) => {
    const text = String(req.body.text || '').trim();
    const slug = String(req.body.level || '').trim();
    if (!text) return fail(res, 400, 'Enter the question.');
    if (text.length > 500) return fail(res, 400, 'That question is too long.');

    const level = await queryOne('SELECT id FROM levels WHERE slug = ? AND is_active = 1', [slug]);
    if (!level) return fail(res, 400, 'Choose a level.');

    // Admin refs are namespaced so they can never collide with a catalogue ref,
    // present or future.
    const ref = `adm-${crypto.randomBytes(6).toString('hex')}`;
    const [{ n }] = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM questions WHERE level_id = ?',
      [level.id]
    );

    const result = await query(
      `INSERT INTO questions (ref, level_id, source, text, sort_order, is_active, admin_hidden)
       VALUES (?, ?, 'admin', ?, ?, 1, 0)`,
      [ref, level.id, text, n]
    );
    res.status(201).json({ ok: true, id: result.insertId, ref });
  })
);

/**
 * Edit a question.
 *
 * The text of a CATALOGUE question is deliberately not editable here. It would
 * appear to save and then be overwritten by data/catalogue.js on the next
 * migrate - a change that silently undoes itself is worse than one that is
 * refused with a reason. Hiding it works on any question, because admin_hidden
 * is the one flag the seeder never touches.
 */
admin.patch(
  '/questions/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await queryOne('SELECT id, source FROM questions WHERE id = ?', [id]);
    if (!q) return fail(res, 404, 'No such question.');

    if (req.body.text !== undefined) {
      if (q.source === 'catalogue') {
        return fail(
          res,
          400,
          'Curated questions are edited in data/catalogue.js - a change made here would be ' +
            'overwritten on the next deploy. You can hide it instead.'
        );
      }
      const text = String(req.body.text).trim();
      if (!text) return fail(res, 400, 'Enter the question.');
      if (text.length > 500) return fail(res, 400, 'That question is too long.');
      await query('UPDATE questions SET text = ? WHERE id = ?', [text, id]);
    }

    if (req.body.hidden !== undefined) {
      await query('UPDATE questions SET admin_hidden = ? WHERE id = ?', [
        req.body.hidden ? 1 : 0,
        id,
      ]);
    }

    const fresh = await queryOne(
      `SELECT q.id, q.ref, q.text, q.source, q.is_active, q.admin_hidden,
              l.slug AS levelSlug, l.name AS levelName
         FROM questions q JOIN levels l ON l.id = q.level_id WHERE q.id = ?`,
      [id]
    );
    res.json({
      ok: true,
      question: {
        id: fresh.id,
        ref: fresh.ref,
        text: fresh.text,
        source: fresh.source,
        isActive: !!fresh.is_active,
        hidden: !!fresh.admin_hidden,
        levelSlug: fresh.levelSlug,
        levelName: fresh.levelName,
      },
    });
  })
);

const TUNABLE_SETTINGS = ['skip_cooloff_days', 'deck_size', 'app_url'];

admin.get(
  '/settings',
  wrap(async (req, res) => {
    const mail = await getMailConfig();
    const values = {};
    for (const key of TUNABLE_SETTINGS) values[key] = await getSetting(key);

    res.json({
      settings: values,
      defaults: DEFAULTS,
      email: {
        host: mail.host,
        port: mail.port,
        secure: mail.secure,
        user: mail.user,
        from: mail.from,
        configured: mail.configured,
        // The password itself is NEVER returned to the browser - only whether
        // one is stored and whether it can still be read.
        hasPassword: !!mail.password || mail.passwordUnreadable,
        passwordUnreadable: mail.passwordUnreadable,
      },
    });
  })
);

admin.put(
  '/settings',
  wrap(async (req, res) => {
    const body = req.body || {};

    if (body.skip_cooloff_days !== undefined) {
      const n = Number(body.skip_cooloff_days);
      if (!Number.isFinite(n) || n < 0 || n > 365) {
        return fail(res, 400, 'Cool-off must be between 0 and 365 days.');
      }
      await setSetting('skip_cooloff_days', Math.round(n));
    }

    if (body.deck_size !== undefined) {
      const n = Number(body.deck_size);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return fail(res, 400, 'Deck size must be between 1 and 200.');
      }
      await setSetting('deck_size', Math.round(n));
    }

    if (body.app_url !== undefined) {
      const url = String(body.app_url).trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/.+/i.test(url)) {
        return fail(res, 400, 'The app URL must start with http:// or https://');
      }
      await setSetting('app_url', url || null);
    }

    if (body.email) {
      const e = body.email;
      if (e.host !== undefined) await setSetting('smtp_host', String(e.host).trim());
      if (e.port !== undefined) await setSetting('smtp_port', Number(e.port) || 587);
      if (e.secure !== undefined) await setSetting('smtp_secure', e.secure ? '1' : '0');
      if (e.user !== undefined) await setSetting('smtp_user', String(e.user).trim());
      if (e.from !== undefined) await setSetting('smtp_from', String(e.from).trim());
      // Three-way, in priority order:
      //   a password was typed  -> store it (wins even if "forget" is ticked,
      //                            since typing one is the more specific act)
      //   "forget" ticked       -> wipe the stored one
      //   neither               -> leave it alone, so saving the host or port
      //                            does not silently wipe the password
      if (e.password) await setSetting('smtp_password', encryptSecret(String(e.password)));
      else if (e.clearPassword) await setSetting('smtp_password', null);
    }

    res.json({ ok: true });
  })
);

admin.post(
  '/email/test',
  wrap(async (req, res) => {
    const to = String(req.body.to || req.user.email).trim();
    try {
      await sendMail({
        to,
        subject: "Let's Connect - test email",
        text: 'This is a test from the Let\'s Connect admin screen. Email is working.',
        html: "<p>This is a test from the Let's Connect admin screen. Email is working.</p>",
      });
      res.json({ ok: true, to });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
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
