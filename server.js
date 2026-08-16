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
const multer = require('multer');

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

// ---------------------------------------------------------------------------
// Branding
//
// Served to the couple app and the admin app alike so the same codebase can be
// run under another name without a deploy. Falls back to the built-in values,
// so an install that never touches this looks exactly as it always did.
// ---------------------------------------------------------------------------

const BRAND_DEFAULTS = {
  app_name: "Let's Connect",
  app_tagline: 'Questions for couples, one card at a time.',
  brand_accent: '#D8327C',
  brand_mark: '❤',
};

async function getBranding() {
  const out = {};
  for (const key of Object.keys(BRAND_DEFAULTS)) {
    const v = await getSetting(key);
    out[key] = v === undefined || v === null || v === '' ? BRAND_DEFAULTS[key] : v;
  }
  return out;
}

/** Base URL for links in emails. The setting wins; otherwise infer from the request. */
async function appUrl(req) {
  const configured = await getSetting('app_url');
  if (configured) return String(configured).replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Wraps an async route so a rejection becomes a 500 instead of a hung request. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

/**
 * Records an admin action. Never throws - a failure to write the log must not
 * fail the operation the user actually asked for, or the audit trail becomes a
 * new way for the app to break.
 */
async function audit(req, action, { targetType, targetId, targetLabel, detail } = {}) {
  try {
    await query(
      `INSERT INTO audit_log
         (actor_user_id, actor_email, action, target_type, target_id, target_label, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user ? req.user.id : null,
        req.user ? req.user.email : null,
        String(action).slice(0, 60),
        targetType ? String(targetType).slice(0, 40) : null,
        targetId || null,
        targetLabel ? String(targetLabel).slice(0, 255) : null,
        detail ? String(detail) : null,
        String(req.ip || '').slice(0, 64),
      ]
    );
  } catch (err) {
    console.error('[audit] could not record', action, '-', err.message);
  }
}

async function loadUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  try {
    req.user = await queryOne(
      'SELECT id, email, display_name, is_admin, is_owner, is_active FROM users WHERE id = ?',
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
 * The couple session.
 *
 * Held on the session by id, put there by redeeming a code. There is no user
 * account behind it and no partner to look up: two people are sitting together
 * with one screen, and the code is the whole identity.
 *
 * Re-read on every request rather than trusted from the cookie, so suspending a
 * code takes effect on the next tap instead of whenever the session happens to
 * expire. That matters because "suspended" is what a refund looks like.
 */
async function loadCouple(req, res, next) {
  if (!req.session || !req.session.coupleId) return next();
  try {
    const row = await queryOne(
      `SELECT id, access_code, couple_name, partner_a, partner_b, shuffle_seed,
              status, code_status, volatile_unlocked
         FROM couples WHERE id = ?`,
      [req.session.coupleId]
    );
    if (row && row.status === 'active' && row.code_status === 'active') req.couple = row;
  } catch (err) {
    return next(err);
  }
  return next();
}

/** Deny-by-default gate for everything that touches a couple's content. */
function requireCouple(req, res, next) {
  if (!req.couple) return fail(res, 401, 'Enter your code to start.');
  return next();
}

/**
 * A code as typed, normalised.
 *
 * People retype these off a phone screen or a printed card, so O/0 and I/1 are
 * folded together and spaces and dashes are thrown away. Being strict about
 * that would generate support email for no benefit whatsoever - the code is a
 * licence, not a password, and the shop already knows who bought it.
 */
function normaliseCode(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1');
}

/**
 * A fresh code.
 *
 * Crockford-ish alphabet with the ambiguous characters already removed, so a
 * generated code cannot contain the letters normaliseCode folds away. Grouped
 * for reading aloud, which is how one of these actually gets from a laptop to
 * the other person's phone.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.replace(/[OI]/g, '');

function makeAccessCode() {
  const raw = Array.from(crypto.randomBytes(12))
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Two independent identities on the same session, deliberately. `loadUser` is
// the owner signing in at /admin with an email and a password; `loadCouple` is
// a code typed on the welcome screen. Neither implies the other - the owner
// gets no deck, and a couple gets nothing under /api/owner.
app.use('/api', loadUser);
app.use('/api', loadCouple);

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: APP_VERSION });
});

// Public: the sign-in screens need the app's name and colour before anyone has
// authenticated. Nothing here is sensitive.
app.get(
  '/api/branding',
  wrap(async (req, res) => {
    res.json({ branding: await getBranding(), version: APP_VERSION });
  })
);

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
    // The very first account owns the app, so a fresh install can reach /admin/
    // without a separate setup screen.
    const anyUser = await queryOne('SELECT id FROM users LIMIT 1');
    const isFirst = anyUser ? 0 : 1;

    const result = await query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_owner, last_login_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [email, hash, displayName, isFirst, isFirst]
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
// The code gate
//
// One field on the welcome screen. A code is bought from the shop, arrives by
// email, and is typed in by whichever of the two is holding the phone.
//
// There is no account, no password and no pairing, because the exercise is
// done SITTING TOGETHER. Two logins and a synchronisation story were solving a
// problem this product does not have, and each one was a wall between buying it
// and using it.
// ---------------------------------------------------------------------------

/**
 * Redeem a code and start a session.
 *
 * Rate-limited on the same counter as a failed password, because a code IS the
 * credential here and an unthrottled endpoint that accepts short strings is an
 * invitation to walk the keyspace.
 *
 * The failure message never distinguishes "no such code" from "suspended" -
 * that difference is only useful to somebody guessing.
 */
app.post(
  '/api/access/redeem',
  wrap(async (req, res) => {
    const code = normaliseCode(req.body.code);
    if (!code) return fail(res, 400, 'Enter your code.');

    const key = attemptKey(req, `code:${code}`);
    const locked = isLockedOut(key);
    if (locked) {
      return fail(res, 429, `Too many attempts. Try again in ${locked} minute(s).`);
    }

    // Compared against the stored code normalised the same way, so a code
    // issued before the folding rules existed still matches what is typed.
    const rows = await query(
      "SELECT id, access_code, couple_name, partner_a, partner_b, status, code_status, activated_at FROM couples WHERE access_code IS NOT NULL AND status = 'active'"
    );
    const couple = rows.find((r) => normaliseCode(r.access_code) === code);

    if (!couple || couple.code_status !== 'active') {
      noteFailure(key);
      return fail(res, 401, 'That code was not recognised. Check it and try again.');
    }

    await query(
      `UPDATE couples
          SET activated_at = COALESCE(activated_at, NOW()), last_used_at = NOW()
        WHERE id = ?`,
      [couple.id]
    );

    // Regenerate so a session fixation attempt cannot pre-seed the cookie that
    // ends up carrying a paid-for code.
    const start = () => {
      req.session.coupleId = couple.id;
      res.json({
        ok: true,
        couple: {
          id: couple.id,
          name: coupleGreeting(couple),
          partnerA: couple.partner_a,
          partnerB: couple.partner_b,
          firstTime: !couple.activated_at,
        },
      });
    };
    if (req.session && req.session.regenerate) req.session.regenerate(() => start());
    else start();
    return undefined;
  })
);

/** End the session. The code itself is untouched and can be used again. */
app.post('/api/access/leave', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.json({ ok: true });
});

/**
 * "Mark and Nikki".
 *
 * Built from the two names rather than stored as one string, so the app can
 * still address one of them individually. Falls back through what is actually
 * known rather than printing a blank or the word "and" on its own.
 */
function coupleGreeting(c) {
  const a = (c.partner_a || '').trim();
  const b = (c.partner_b || '').trim();
  if (a && b) return `${a} and ${b}`;
  if (a || b) return a || b;
  return (c.couple_name || '').trim() || 'you two';
}

// ---------------------------------------------------------------------------
// The app itself
// ---------------------------------------------------------------------------

/**
 * One bootstrap call: who is signed in, and every topic with their progress.
 *
 * Deliberately NOT behind requireCouple. The welcome screen has to render
 * before a code has been typed, and it needs the branding from the same call -
 * so an unredeemed visitor gets a valid response with couple: null rather than
 * a 401 to interpret.
 */
app.get(
  '/api/data',
  wrap(async (req, res) => {
    const couple = req.couple || null;

    let domains = [];
    let volatile = null;

    if (couple) {
      domains = await domainsWithProgress(couple.id);
      volatile = {
        unlocked: !!couple.volatile_unlocked,
        available: (
          await queryOne(
            "SELECT COUNT(*) AS n FROM questions WHERE is_volatile = 1 AND is_active = 1 AND admin_hidden = 0 AND needs_review = 0"
          )
        ).n,
      };
    }

    res.json({
      version: APP_VERSION,
      branding: await getBranding(),
      // The owner, when they happen to be signed in at /admin in the same
      // browser. The couple app shows nothing for this; it is what puts the
      // "open the admin" link on the account screen instead of a dead end.
      me: req.user
        ? {
            id: req.user.id,
            email: req.user.email,
            displayName: req.user.display_name,
            isOwner: !!req.user.is_owner,
          }
        : null,
      couple: couple
        ? {
            id: couple.id,
            name: coupleGreeting(couple),
            partnerA: couple.partner_a,
            partnerB: couple.partner_b,
          }
        : null,
      domains,
      // The ladder travels with the bootstrap call rather than in a request of
      // its own: it is small, it never changes mid-session, and the selection
      // screen cannot render without it.
      depths: await activeDepths(),
      volatile,
    });
  })
);

/**
 * Unlock, or re-lock, the volatile questions.
 *
 * This was per-person and mutual, because two accounts on two phones meant one
 * partner could otherwise open that door on the other's behalf. Sitting
 * together there is no second session to ask and no such risk: the choice is
 * made once, out loud, with both of them looking at the same screen. The UI
 * says so before it sends this.
 *
 * Re-locking is immediate and needs no agreement, which is the one part of the
 * old design worth keeping - withdrawing consent should never be negotiable.
 */
app.post(
  '/api/couple/volatile',
  requireCouple,
  wrap(async (req, res) => {
    const on = !!req.body.unlocked;
    await query(
      `UPDATE couples
          SET volatile_unlocked = ?, volatile_unlocked_at = ${on ? 'NOW()' : 'NULL'}
        WHERE id = ?`,
      [on ? 1 : 0, req.couple.id]
    );
    res.json({ ok: true, unlocked: on });
  })
);

/** Whether this couple may be served volatile questions. */
async function volatileUnlocked(coupleId) {
  const row = await queryOne('SELECT volatile_unlocked FROM couples WHERE id = ?', [coupleId]);
  return !!(row && row.volatile_unlocked);
}

/**
 * The SQL fragment that decides which questions this couple may see at all,
 * before any progress is considered.
 *
 * Kept in one place because it is applied in four different queries, and a
 * volatile question leaking through one of them because somebody forgot a
 * clause is the single worst bug this app could have.
 */
function servableWhere(allowVolatile) {
  return `q.is_active = 1 AND q.admin_hidden = 0 AND q.needs_review = 0${
    allowVolatile ? '' : ' AND q.is_volatile = 0'
  }`;
}

/**
 * Every domain with this couple's counts, broken down by depth.
 *
 * Returns a per-depth row as well as a total, because depth is now a separate
 * choice: the couple picks a subject and then how exposing they want it, and
 * the UI has to be able to grey out a depth that holds nothing. Meaning and
 * Social, for instance, exist only at D1.
 */
/**
 * The depth ladder, from the database.
 *
 * D1..D5 used to be a constant in public/app.js, which made the one piece of
 * couple-facing copy the owner could not edit without a deploy. Every read of
 * the ladder now comes through here, including the "which depth numbers are
 * even valid" check in parseSelection - otherwise adding a rung would show a
 * chip that the deck query then silently refused to honour.
 */
async function activeDepths() {
  const rows = await query(
    'SELECT n, name, blurb, description FROM depths WHERE is_active = 1 ORDER BY sort_order, n'
  );
  return rows.map((r) => ({
    n: Number(r.n),
    name: r.name,
    blurb: r.blurb,
    description: r.description,
  }));
}

async function domainsWithProgress(coupleId) {
  const cooloff = await getIntSetting('skip_cooloff_days');
  const allowVolatile = await volatileUnlocked(coupleId);

  const rows = await query(
    `SELECT d.id, d.slug, d.name, d.tagline, d.description, d.accent,
            q.depth,
            COUNT(q.id) AS total,
            SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN s.id IS NULL
                       OR (s.status = 'skipped'
                           AND s.decided_at < DATE_SUB(NOW(), INTERVAL ${cooloff} DAY))
                     THEN 1 ELSE 0 END) AS available
       FROM domains d
       LEFT JOIN questions q ON q.domain_id = d.id AND ${servableWhere(allowVolatile)}
       LEFT JOIN couple_question_status s ON s.question_id = q.id AND s.couple_id = ?
      WHERE d.is_active = 1
      GROUP BY d.id, d.slug, d.name, d.tagline, d.description, d.accent, d.sort_order, q.depth
      ORDER BY d.sort_order, q.depth`,
    [coupleId]
  );

  const byDomain = new Map();
  for (const r of rows) {
    if (!byDomain.has(r.slug)) {
      byDomain.set(r.slug, {
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        description: r.description,
        accent: r.accent,
        total: 0,
        completed: 0,
        skipped: 0,
        available: 0,
        ready: 0,
        depths: [],
      });
    }
    const d = byDomain.get(r.slug);
    // A domain with no servable questions produces one row with depth NULL.
    if (r.depth === null) continue;

    const available = Number(r.available) || 0;
    const skipped = Number(r.skipped) || 0;
    const entry = {
      depth: Number(r.depth),
      total: Number(r.total) || 0,
      completed: Number(r.completed) || 0,
      skipped,
      available,
      // What the deck would ACTUALLY serve. When the cool-off is the only thing
      // holding cards back, the deck releases them early rather than
      // dead-ending, so `available` alone understates what is waiting.
      ready: available > 0 ? available : skipped,
    };
    d.depths.push(entry);
    d.total += entry.total;
    d.completed += entry.completed;
    d.skipped += entry.skipped;
    d.available += entry.available;
    d.ready += entry.ready;
  }

  return [...byDomain.values()];
}


// ---- The deck -------------------------------------------------------------

/**
 * Parses a selection: which topics and which depths.
 *
 * Both are sets, because the couple chooses any number of each up front and
 * then plays a single shuffled deck drawn from all of it. An empty list means
 * "all", so a request with no selection still returns a usable deck rather
 * than an empty screen.
 */
function parseSelection(req, domainRows, depthRows) {
  const bySlug = new Map(domainRows.map((d) => [d.slug, d]));

  // The valid depth numbers come from the ladder, not from a hard-coded 1..5.
  // A rung the owner adds is selectable the moment it exists; a rung switched
  // off stops being accepted here as well as disappearing from the picker.
  const allDepths = (depthRows || []).map((d) => d.n).filter((n) => Number.isInteger(n));
  const valid = new Set(allDepths);

  const wantedSlugs = String(req.query.domains || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const chosen = wantedSlugs.length
    ? wantedSlugs.filter((s) => bySlug.has(s))
    : domainRows.map((d) => d.slug);

  const depths = [
    ...new Set(
      String(req.query.depths || '')
        .split(',')
        .map((d) => Number(d.trim()))
        .filter((d) => valid.has(d))
    ),
  ].sort((a, b) => a - b);

  return {
    slugs: chosen,
    ids: chosen.map((s) => bySlug.get(s).id),
    depths: depths.length ? depths : allDepths,
    unknown: wantedSlugs.filter((s) => !bySlug.has(s)),
  };
}

/**
 * Keeps a sequence together, in order, wherever the shuffle happened to drop it.
 *
 * A sequence is a run of cards that circle the same thing at rising exposure,
 * and it only means anything played in order. It used to be a separate mode -
 * a button, a list, a screen of its own - which made a good idea into a chore
 * nobody would choose mid-conversation.
 *
 * So sequences are not a mode any more. They are dealt like everything else,
 * and when one of their cards comes up the rest follow immediately behind it.
 * The couple never chooses a sequence; they just notice the card saying "2 of
 * 5" and keep going.
 *
 * The FIRST member to appear in the shuffle decides where the run lands, so
 * where a sequence turns up is still random. From that point the order is the
 * authored one, not the shuffle's.
 *
 * The card is numbered against THE RUN BEING DEALT, not against the sequence's
 * authored length. A sequence can span topics and depths, so with Attachment
 * alone selected, ASKING deals its 1st, 3rd and 5th cards - and labelling those
 * "1 of 5, 3 of 5, 5 of 5" shows the couple gaps they cannot do anything about.
 * Numbered over the run they get "1 of 3, 2 of 3, 3 of 3", which is what the
 * counter is actually promising: how many more of these are coming.
 *
 * The cost is that the total shifts between sittings - answer two tonight and
 * the rest arrive as "1 of 3" next month rather than "3 of 5". That is the
 * lesser oddity: within one sitting the numbers always run consecutively, which
 * is the only place anybody is comparing them.
 */
function clusterChains(cards) {
  const out = [];
  const placed = new Set();

  for (const card of cards) {
    if (placed.has(card.id)) continue;

    if (!card.chain_id) {
      out.push(card);
      placed.add(card.id);
      continue;
    }

    // Pull every servable sibling forward to sit behind this one, in the order
    // they were authored.
    const run = cards
      .filter((c) => c.chain_id === card.chain_id && !placed.has(c.id))
      .sort((a, b) => (a.chain_position || 0) - (b.chain_position || 0));

    run.forEach((c, i) => {
      c.run_position = i + 1;
      c.run_total = run.length;
      out.push(c);
      placed.add(c.id);
    });
  }

  return out;
}

/**
 * A shuffled deck drawn from everything the couple selected.
 *
 * ONE deck across all chosen topics, not one deck per topic. The couple picks
 * topics and depths on a single screen, presses start, and gets cards at
 * random from the whole selection - so a session can legitimately move between
 * Money and Desire card to card, which is the point.
 *
 * Ordering is a deterministic shuffle on the couple's own seed: stable across
 * sessions, identical for both partners, different for every couple.
 *
 * Volatile questions are excluded unless BOTH partners have unlocked them.
 * That check is done here rather than trusted from the client, because a
 * client-side filter would put "what would it take for you to leave" one
 * tampered request away from appearing unannounced.
 */
app.get(
  '/api/deck',
  requireCouple,
  wrap(async (req, res) => {
    const domainRows = await query(
      'SELECT id, slug, name, accent FROM domains WHERE is_active = 1 ORDER BY sort_order'
    );
    const sel = parseSelection(req, domainRows, await activeDepths());
    if (!sel.ids.length) return fail(res, 400, 'Choose at least one topic.');
    if (!sel.depths.length) return fail(res, 400, 'Choose at least one depth.');

    const cooloff = await getIntSetting('skip_cooloff_days');
    const deckSize = await getIntSetting('deck_size');
    const allowVolatile = await volatileUnlocked(req.couple.id);
    const seed = req.couple.shuffle_seed;

    const select = (withCooloff) => `
      SELECT q.id, q.ref, q.text, q.context, q.depth, q.is_volatile, q.lens,
             d.slug AS domain_slug, d.name AS domain_name, d.accent AS domain_accent,
             q.chain_id, q.chain_position, ch.name AS chain_name, ch.total AS chain_total,
             s.status AS prior_status
        FROM questions q
        JOIN domains d ON d.id = q.domain_id
        LEFT JOIN chains ch ON ch.id = q.chain_id
        LEFT JOIN couple_question_status s
          ON s.question_id = q.id AND s.couple_id = ?
       WHERE q.domain_id IN (${sel.ids.join(',')})
         AND q.depth IN (${sel.depths.join(',')})
         AND ${servableWhere(allowVolatile)}
         AND (s.id IS NULL${
           withCooloff
             ? ` OR (s.status = 'skipped' AND s.decided_at < DATE_SUB(NOW(), INTERVAL ${cooloff} DAY))`
             : " OR s.status = 'skipped'"
         })
       ORDER BY MD5(CONCAT(q.id, ':', ?))
       LIMIT ${deckSize}`;

    let cards = await query(select(true), [req.couple.id, seed]);

    // If the cool-off is the only thing standing between the couple and an
    // empty deck, release the skipped questions early. A deck must never
    // dead-end while unanswered cards sit waiting on a timer.
    let releasedEarly = false;
    if (!cards.length) {
      cards = await query(select(false), [req.couple.id, seed]);
      releasedEarly = cards.length > 0;
    }

    cards = clusterChains(cards);

    // Totals across the whole selection, so the header counts what is actually
    // in play rather than any one topic.
    const all = await domainsWithProgress(req.couple.id);
    const stats = all
      .filter((d) => sel.slugs.includes(d.slug))
      .flatMap((d) => d.depths)
      .filter((x) => sel.depths.includes(x.depth))
      .reduce(
        (acc, x) => ({
          total: acc.total + x.total,
          completed: acc.completed + x.completed,
          skipped: acc.skipped + x.skipped,
          available: acc.available + x.available,
          ready: acc.ready + x.ready,
        }),
        { total: 0, completed: 0, skipped: 0, available: 0, ready: 0 }
      );

    res.json({
      selection: {
        domains: sel.slugs,
        depths: sel.depths,
        names: domainRows.filter((d) => sel.slugs.includes(d.slug)).map((d) => d.name),
      },
      stats,
      releasedEarly,
      cards: cards.map((c) => ({
        id: c.id,
        ref: c.ref,
        text: c.text,
        // The helper line. Sent with the card but hidden until tapped - the
        // question has to carry the moment, and a card that arrives
        // pre-explained reads as a worksheet.
        context: c.context,
        depth: c.depth,
        volatile: !!c.is_volatile,
        // The three-letter framework code shown in the card's top corner.
        lens: c.lens,
        domainSlug: c.domain_slug,
        domainName: c.domain_name,
        accent: c.domain_accent,
        // position/total are the RUN's, not the authored sequence's - see
        // clusterChains. A single-card run is not labelled at all: "1 of 1"
        // announces a sequence the couple will never see the rest of.
        chain:
          c.chain_id && c.run_total > 1
            ? { id: c.chain_id, name: c.chain_name, position: c.run_position, total: c.run_total }
            : null,
        seenBefore: !!c.prior_status,
      })),
    });
  })
);

/**
 * Every lens, sent once with the app data rather than fetched per tap.
 *
 * There are sixteen of them and they are a few hundred bytes each, so a
 * round trip every time somebody taps a code on a card would be pure latency
 * for content that never changes mid-session.
 */
app.get(
  '/api/lenses',
  requireCouple,
  wrap(async (req, res) => {
    // `author` comes down, `brief` deliberately does not. The brief is written
    // for the generator and reads like a construct list; putting it in front of
    // a couple would be showing them the workings.
    const rows = await query(
      'SELECT code, name, author, description FROM lenses WHERE is_active = 1 ORDER BY sort_order'
    );
    res.json({ lenses: rows });
  })
);

// The couple-facing chain endpoints are gone.
//
// A sequence used to be a mode: a list to browse, a session to start, and a
// position on the server to resume. That made a good idea into a chore nobody
// would choose in the middle of a conversation.
//
// Sequences are now dealt inside the ordinary deck - see clusterChains above.
// Nothing needs listing, starting or resuming, because a sequence's place is
// not session state: it is simply which of its cards are still unanswered, and
// the deck query already knows that.
//
// The chains themselves stay, and are still authored in the admin area.

/**
 * Record a decision on a card. NO ANSWER IS STORED - only that the card has
 * been dealt with, which is all that is needed to stop it coming round again.
 *
 * Idempotent upsert, so both partners tapping at once cannot create a
 * duplicate, and a retry after a dropped connection is harmless.
 */
app.post(
  '/api/answer',
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

    const question = await queryOne(
      'SELECT id, domain_id, is_volatile FROM questions WHERE id = ?',
      [questionId]
    );
    if (!question) return fail(res, 404, 'That question no longer exists.');

    // Answering is a write, so the volatility gate is enforced here too rather
    // than assumed from the fact that the card was served.
    if (question.is_volatile && !(await volatileUnlocked(req.couple.id))) {
      return fail(res, 403, 'That question is locked.');
    }

    await query(
      `INSERT INTO couple_question_status
         (couple_id, question_id, status, skip_count, decided_by_user_id, decided_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         skip_count = skip_count + VALUES(skip_count),
         decided_by_user_id = VALUES(decided_by_user_id),
         decided_at = NOW()`,
      [req.couple.id, questionId, action, action === 'skipped' ? 1 : 0, null]
    );

    const domains = await domainsWithProgress(req.couple.id);
    res.json({ ok: true, domains });
  })
);

/**
 * Clear this couple's progress across the current selection.
 *
 * Scoped to the selection rather than to one topic, because that is the unit
 * the couple is actually playing. Reports what it removed rather than just
 * "ok", so the UI can confirm against a real number instead of an assumption.
 */
app.post(
  '/api/deck/reset',
  requireCouple,
  wrap(async (req, res) => {
    const domainRows = await query('SELECT id, slug FROM domains WHERE is_active = 1');
    // The selection arrives in the body here, so reuse the parser by handing it
    // a query-shaped object rather than duplicating the parsing.
    const sel = parseSelection(
      { query: { domains: (req.body.domains || []).join(','), depths: (req.body.depths || []).join(',') } },
      domainRows,
      await activeDepths()
    );
    if (!sel.ids.length) return fail(res, 400, 'Choose at least one topic.');
    if (!sel.depths.length) return fail(res, 400, 'Choose at least one depth.');

    const scope = req.body.scope === 'skipped' ? 'skipped' : 'all';
    const result = await query(
      `DELETE s FROM couple_question_status s
         JOIN questions q ON q.id = s.question_id
        WHERE s.couple_id = ?
          AND q.domain_id IN (${sel.ids.join(',')})
          AND q.depth IN (${sel.depths.join(',')})
          ${scope === 'skipped' ? "AND s.status = 'skipped'" : ''}`,
      [req.couple.id]
    );
    const domains = await domainsWithProgress(req.couple.id);

    res.json({ ok: true, cleared: result.affectedRows || 0, scope, domains });
  })
);

/**
 * Report a problem with a question, from inside the deck.
 *
 * The app stores no answers, so a skip is a number and this is the only place
 * a couple can say WHY something did not work. Upserted on
 * (question_id, couple_id) so a second report from the other partner updates
 * the first rather than being refused - the couple has one voice per question.
 */
app.post(
  '/api/report',
  requireCouple,
  wrap(async (req, res) => {
    const questionId = Number(req.body.questionId);
    const REASONS = ['unclear', 'upsetting', 'inappropriate', 'duplicate', 'other'];
    const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'other';
    const note = String(req.body.note || '').trim().slice(0, 500) || null;

    if (!Number.isInteger(questionId) || questionId <= 0) {
      return fail(res, 400, 'Missing question.');
    }
    const question = await queryOne('SELECT id FROM questions WHERE id = ?', [questionId]);
    if (!question) return fail(res, 404, 'That question no longer exists.');

    await query(
      `INSERT INTO question_reports (question_id, couple_id, user_id, reason, note)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), note = VALUES(note),
                               user_id = VALUES(user_id), status = 'open',
                               created_at = NOW()`,
      [questionId, req.couple.id, null, reason, note]
    );

    res.json({ ok: true });
  })
);

// ---- Account --------------------------------------------------------------

/**
 * Everything this account holds, as JSON. The "download my data" half of the
 * erasure/portability pair.
 *
 * Includes the question TEXT alongside each decision - an export listing bare
 * question ids would be technically complete and useless to the person reading
 * it, which is not what portability means.
 */

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
// Owner (master admin)
//
// Gated as a whole namespace rather than per route. A new owner endpoint is
// therefore closed by default and you opt in by putting it under /api/owner -
// the opposite way round from remembering to add a check to each one, which is
// how a single forgotten line leaks everything.
//
// The couple app has NO route into this. It is reached by signing in at
// /admin/, which is a separate page with its own script - a couple's browser
// never downloads the admin code at all.
// ---------------------------------------------------------------------------

function requireOwner(req, res, next) {
  if (!req.user) return fail(res, 401, 'Please log in.');
  if (!req.user.is_owner) return fail(res, 403, 'This area is for the app owner.');
  return next();
}

// ---------------------------------------------------------------------------
// Question generation
//
// The owner adds an author and the framework they work from, and the app writes
// candidate questions against it - which is the whole point: the alternative is
// drafting them somewhere else and pasting them in, and then the corpus's rules
// never touch them.
//
// THREE things this must never do, each of which has burned somebody:
//
//   1. Call the model from the browser. The key would be in the page and the
//      spend would be uncapped. Everything goes through this proxy.
//   2. Keep the key in .env. It lives in `settings`, encrypted at rest under
//      SECRET_KEY, and the API only ever tells the browser {configured, masked,
//      source, model} - never the value.
//   3. Trust the model to have followed the rules. Asking for an open,
//      standalone, non-binary question with a context line that supplies no
//      example answer produces a REQUEST for one. Every candidate is put
//      through lib/question-rules.js afterwards, and a fatal failure is
//      recorded on the draft rather than quietly dropped or quietly accepted.
//
// Nothing generated is ever served. It lands in `question_drafts` and waits.
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
const { checkQuestion } = require('./lib/question-rules');

const AI_DEFAULT_MODEL = 'claude-opus-5';

/**
 * Where the key comes from, in priority order.
 *
 * The database wins over the environment on purpose: it survives a redeploy
 * with no file editing on the server, and it is what the admin screen writes.
 * .env stays as a fallback so an install configured the old way keeps working.
 */
async function resolveAnthropicKey() {
  const stored = await getSetting('anthropic_api_key');
  if (stored) {
    const plain = decryptSecret(stored);
    // Fails SOFT. An unreadable key (SECRET_KEY rotated) must present as "type
    // it again", not as a crash on an unrelated screen.
    if (plain) return { key: plain, source: 'settings', unreadable: false };
    return { key: null, source: 'settings', unreadable: true };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'env', unreadable: false };
  }
  return { key: null, source: null, unreadable: false };
}

function maskKey(key) {
  if (!key) return null;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** The schema the model must fill. Deliberately flat - see the notes above. */
const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'context', 'depth', 'volatile'],
        properties: {
          question: { type: 'string', description: 'The card. One sentence, ending in a question mark.' },
          context: {
            type: 'string',
            description:
              'The line revealed when the couple taps Expand. Under 18 words. Opens the '
              + 'territory. Never contains an example answer.',
          },
          depth: { type: 'integer', description: 'Which rung of the ladder this sits on.' },
          volatile: {
            type: 'boolean',
            description: 'True only if an honest answer could damage the relationship.',
          },
        },
      },
    },
  },
};

/**
 * The construction rules, stated for the model.
 *
 * Written as what a good card IS rather than as a list of prohibitions, because
 * enumerating failures anchors output toward them. The code enforces the same
 * rules afterwards either way.
 */
function buildSystemPrompt(depths) {
  const ladder = depths
    .map((d) => `D${d.n} ${d.name} - ${d.blurb || ''}`.trim())
    .join('\n');

  return `You write discussion questions for couples. Each one is printed alone on a card, on a phone, with no other question visible.

HOW A CARD IS BUILT
A card is one open question that a person can answer out loud without having read anything else. It names its own subject, so a reader never has to ask "which one?". It cannot be answered yes or no - if it opens on do/does/is/are/have/can/will, it must offer a genuine either/or. It is at least five words and reads as a whole sentence, not a fragment or a follow-on.

Every card carries a context line, shown only when the couple asks for it. The context opens the territory in under eighteen words and stops. It does not ask a second question, and it never supplies an example answer - an example anchors every couple to the same reply and kills the question.

THE DEPTH LADDER
Depth is exposure, and has nothing to do with subject. Write each question at the depth you are asked for.
${ladder}

VOLATILE
Mark a question volatile only when an honest answer could genuinely damage the relationship. Both partners have to consent separately before a volatile card is ever dealt, so the flag is a real gate, not a tone marker.

ORIGINALITY
You are writing to a framework - a way of looking at a relationship - never reproducing anybody's published material. Do not quote, adapt, or paraphrase any existing question, exercise, card deck, or book. Every question you return is newly written.`;
}

/**
 * Ask for candidates. Returns raw objects; validation happens to the result.
 *
 * Streamed because thinking plus a dozen questions with context lines is enough
 * output to sit near an HTTP timeout on a non-streaming call, and a timeout
 * here would look like "generation is broken" rather than "the request was too
 * big".
 */
async function generateCandidates({ key, model, lens, domain, depths, ladder, count, note, avoid }) {
  const client = new Anthropic({ apiKey: key });

  const lines = [];
  lines.push(`Write ${count} questions.`);
  if (lens) {
    lines.push('');
    lines.push(`FRAMEWORK: ${lens.name}${lens.author ? ` (${lens.author})` : ''}`);
    if (lens.brief) lines.push(lens.brief);
    else if (lens.description) lines.push(lens.description);
    lines.push(
      'Interrogate what this framework actually cares about. A reader who knows the '
        + 'framework should recognise the concern; a reader who does not should still be '
        + 'able to answer the question.'
    );
  }
  if (domain) {
    lines.push('');
    lines.push(`SUBJECT: ${domain.name}${domain.tagline ? ` - ${domain.tagline}` : ''}`);
    if (domain.description) lines.push(domain.description);
  }
  lines.push('');
  lines.push(`DEPTHS TO COVER: ${depths.join(', ')}. Spread them across the set.`);
  if (note) {
    lines.push('');
    lines.push(`FROM THE EDITOR: ${note}`);
  }
  if (avoid && avoid.length) {
    lines.push('');
    lines.push('Questions already in the collection. Do not repeat these, or restate them:');
    avoid.forEach((t) => lines.push(`- ${t}`));
  }

  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
    system: buildSystemPrompt(ladder),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const message = await stream.finalMessage();

  // Safety classifiers can decline (HTTP 200, stop_reason "refusal"), so read
  // stop_reason BEFORE touching content - indexing content[0] on a refusal is
  // how this turns into an unhandled exception.
  if (message.stop_reason === 'refusal') {
    const why = (message.stop_details && message.stop_details.explanation) || '';
    throw new Error(`The model declined this request.${why ? ` ${why}` : ''}`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The reply was cut off before it finished. Ask for fewer questions.');
  }

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    // Structured output should not fence, but a stray fence turns a good reply
    // into a parse error, which is a silly way to lose a batch.
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('The reply was not readable as questions. Try again.');
  }
  return Array.isArray(parsed.questions) ? parsed.questions : [];
}

// ---------------------------------------------------------------------------
// Issuing a code
//
// Shared by the admin screen and the shop, because "make a code for these two
// people" is one operation and having it exist twice is how the two versions
// drift until one of them forgets to set issued_at.
// ---------------------------------------------------------------------------

async function issueCode({ partnerA, partnerB, buyerEmail, orderRef, coupleName }) {
  const a = String(partnerA || '').trim().slice(0, 60) || null;
  const b = String(partnerB || '').trim().slice(0, 60) || null;

  // Retried rather than assumed unique. The odds of a collision on 12 random
  // characters are absurd, but "absurd" is not "impossible" and the failure
  // would be handing somebody else's couple to a paying customer.
  let code = null;
  for (let i = 0; i < 8; i += 1) {
    const candidate = makeAccessCode();
    // eslint-disable-next-line no-await-in-loop
    const clash = await queryOne('SELECT id FROM couples WHERE access_code = ?', [candidate]);
    if (!clash) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error('Could not generate a unique code. Try again.');

  const result = await query(
    `INSERT INTO couples
       (access_code, couple_name, partner_a, partner_b, buyer_email, order_ref,
        code_status, issued_at, shuffle_seed, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), ?, 'active')`,
    [
      code,
      String(coupleName || '').trim().slice(0, 120) || null,
      a,
      b,
      String(buyerEmail || '').trim().slice(0, 191) || null,
      String(orderRef || '').trim().slice(0, 60) || null,
      crypto.randomBytes(16).toString('hex'),
    ]
  );

  return { id: result.insertId, code, partnerA: a, partnerB: b };
}

/**
 * The shop's endpoint.
 *
 * launchyourlife.co.za takes the money and then calls this to mint the code it
 * emails out. Authenticated with a shared secret held in `settings`, not with
 * an owner session - the shop is a server talking to a server and has no
 * business holding somebody's admin cookie.
 *
 * Returns 501 rather than 401 while no key is configured, because "this is not
 * switched on yet" and "your key is wrong" are different problems and telling
 * them apart is the difference between a five-minute fix and an afternoon.
 */
app.post(
  '/api/shop/codes',
  wrap(async (req, res) => {
    const configured = await getSetting('shop_api_key');
    if (!configured) {
      return fail(res, 501, 'Code issuing is not switched on. Set a shop key in the admin area.');
    }

    const offered = String(req.get('x-shop-key') || '');
    // Length-padded constant-time compare, so a wrong key cannot be narrowed
    // down by timing one character at a time.
    const ok =
      offered.length === configured.length &&
      crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(configured));
    if (!ok) return fail(res, 401, 'Bad shop key.');

    const issued = await issueCode({
      partnerA: req.body.partnerA,
      partnerB: req.body.partnerB,
      buyerEmail: req.body.buyerEmail,
      orderRef: req.body.orderRef,
      coupleName: req.body.coupleName,
    });

    await audit(req, 'code.issue.shop', {
      targetType: 'couple',
      targetId: issued.id,
      targetLabel: `${issued.partnerA || '?'} and ${issued.partnerB || '?'}`,
      detail: `order ${req.body.orderRef || 'none'}`,
    });

    // The code is returned once, here. The shop is responsible for emailing it;
    // this app never sees the customer again until they type it in.
    res.status(201).json({ ok: true, code: issued.code, id: issued.id });
  })
);

const owner = express.Router();
app.use('/api/owner', requireAuth, requireOwner, owner);

owner.get(
  '/overview',
  wrap(async (req, res) => {
    const [counts] = await query(
      `SELECT
         (SELECT COUNT(*) FROM users)                                    AS users,
         (SELECT COUNT(*) FROM users WHERE is_active = 1)                AS activeUsers,
         (SELECT COUNT(*) FROM users WHERE is_owner = 1)                 AS owners,
         (SELECT COUNT(*) FROM question_reports WHERE status = 'open')   AS openReports,
         (SELECT COUNT(*) FROM domains WHERE is_active = 1)               AS groups,
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
                WHERE q2.domain_id = l.id) AS decisions
         FROM domains l
         LEFT JOIN questions q ON q.domain_id = l.id AND q.is_active = 1 AND q.admin_hidden = 0
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
    isOwner: !!u.is_owner,
    isActive: !!u.is_active,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    coupleId: u.couple_id || null,
    coupleName: u.couple_name || null,
  };
}

owner.get(
  '/users',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const rows = await query(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_owner, u.is_active, u.created_at,
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
owner.patch(
  '/users/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const target = await queryOne(
      'SELECT id, email, display_name, is_owner, is_active FROM users WHERE id = ?',
      [id]
    );
    if (!target) return fail(res, 404, 'No such user.');

    const wantsOwner = req.body.isOwner === undefined ? !!target.is_owner : !!req.body.isOwner;
    const wantsActive = req.body.isActive === undefined ? !!target.is_active : !!req.body.isActive;
    const losingOwner = !!target.is_owner && (!wantsOwner || !wantsActive);

    if (id === req.user.id && !wantsActive) {
      return fail(res, 400, 'You cannot deactivate your own account.');
    }

    if (losingOwner) {
      const others = await queryOne(
        'SELECT COUNT(*) AS n FROM users WHERE is_owner = 1 AND is_active = 1 AND id <> ?',
        [id]
      );
      if (Number(others.n) === 0) {
        return fail(
          res,
          400,
          id === req.user.id
            ? 'You are the only owner. Make somebody else an owner before stepping down.'
            : 'This is the only owner left. Promote someone else first.'
        );
      }
    }

    const displayName =
      req.body.displayName === undefined ? null : String(req.body.displayName).trim();
    if (displayName !== null && !displayName) return fail(res, 400, 'Enter a name.');

    // is_admin is kept in step with is_owner rather than left to rot. Nothing
    // reads it any more, but a legacy column holding a value that contradicts
    // the live one is a trap for whoever next writes a query against it.
    await query(
      `UPDATE users
          SET display_name = COALESCE(?, display_name), is_owner = ?, is_admin = ?, is_active = ?
        WHERE id = ?`,
      [displayName, wantsOwner ? 1 : 0, wantsOwner ? 1 : 0, wantsActive ? 1 : 0, id]
    );

    if (!!target.is_owner !== wantsOwner) {
      await audit(req, wantsOwner ? 'user.promote' : 'user.demote', {
        targetType: 'user',
        targetId: id,
        targetLabel: target.email,
      });
    }
    if (!!target.is_active !== wantsActive) {
      await audit(req, wantsActive ? 'user.reactivate' : 'user.deactivate', {
        targetType: 'user',
        targetId: id,
        targetLabel: target.email,
      });
    }

    // A deactivated account must not keep working until its cookie happens to
    // expire. loadUser() already refuses an inactive user, but ending the
    // session makes it immediate and explicit.
    if (!wantsActive) await query('DELETE FROM sessions WHERE user_id = ?', [id]);

    const fresh = await queryOne(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_owner, u.is_active, u.created_at,
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
owner.post(
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

// ---- Codes ----------------------------------------------------------------
//
// A code IS a couple, so this is the old couples list with the licence on it
// rather than a second screen listing the same rows. The two questions the
// owner actually asks here are "did Mark and Nikki get their code" and "has it
// been used", and both are answered by one table.

owner.get(
  '/couples',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;

    const rows = await query(
      `SELECT c.id, c.access_code, c.couple_name, c.partner_a, c.partner_b,
              c.buyer_email, c.order_ref, c.code_status, c.status,
              c.issued_at, c.activated_at, c.last_used_at, c.created_at,
              c.volatile_unlocked,
              (SELECT COUNT(*) FROM couple_question_status s
                WHERE s.couple_id = c.id AND s.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM couple_question_status s
                WHERE s.couple_id = c.id AND s.status = 'skipped') AS skipped
         FROM couples c
        ${q ? `WHERE c.partner_a LIKE ? OR c.partner_b LIKE ? OR c.buyer_email LIKE ?
                  OR c.access_code LIKE ? OR c.order_ref LIKE ?` : ''}
        ORDER BY c.created_at DESC
        LIMIT 300`,
      q ? [like, like, like, like, like] : []
    );

    res.json({
      couples: rows.map((r) => ({
        id: r.id,
        code: r.access_code,
        name: r.couple_name,
        partnerA: r.partner_a,
        partnerB: r.partner_b,
        buyerEmail: r.buyer_email,
        orderRef: r.order_ref,
        codeStatus: r.code_status,
        status: r.status,
        issuedAt: r.issued_at,
        activatedAt: r.activated_at,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
        volatileUnlocked: !!r.volatile_unlocked,
        completed: Number(r.completed) || 0,
        skipped: Number(r.skipped) || 0,
      })),
    });
  })
);

/** Issue a code by hand - a replacement, a gift, or a sale taken off-platform. */
owner.post(
  '/couples',
  wrap(async (req, res) => {
    const a = String(req.body.partnerA || '').trim();
    const b = String(req.body.partnerB || '').trim();
    if (!a || !b) {
      return fail(res, 400, 'Both names, please — the welcome screen greets them by name.');
    }

    const issued = await issueCode({
      partnerA: a,
      partnerB: b,
      buyerEmail: req.body.buyerEmail,
      orderRef: req.body.orderRef,
      coupleName: req.body.coupleName,
    });

    await audit(req, 'code.issue', {
      targetType: 'couple',
      targetId: issued.id,
      targetLabel: `${a} and ${b}`,
      detail: issued.code,
    });
    res.status(201).json({ ok: true, ...issued });
  })
);

owner.patch(
  '/couples/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const c = await queryOne(
      'SELECT id, partner_a, partner_b, code_status FROM couples WHERE id = ?',
      [id]
    );
    if (!c) return fail(res, 404, 'No such code.');

    const sets = [];
    const args = [];
    for (const [field, column, max] of [
      ['partnerA', 'partner_a', 60],
      ['partnerB', 'partner_b', 60],
      ['buyerEmail', 'buyer_email', 191],
      ['orderRef', 'order_ref', 60],
    ]) {
      if (req.body[field] !== undefined) {
        sets.push(`${column} = ?`);
        args.push(String(req.body[field]).trim().slice(0, max) || null);
      }
    }
    if (req.body.codeStatus !== undefined) {
      const s = req.body.codeStatus === 'suspended' ? 'suspended' : 'active';
      sets.push('code_status = ?');
      args.push(s);
    }
    if (!sets.length) return res.json({ ok: true });

    args.push(id);
    await query(`UPDATE couples SET ${sets.join(', ')} WHERE id = ?`, args);

    await audit(req, 'code.update', {
      targetType: 'couple',
      targetId: id,
      targetLabel: `${c.partner_a || '?'} and ${c.partner_b || '?'}`,
      detail: req.body.codeStatus ? `status ${req.body.codeStatus}` : 'details',
    });
    res.json({ ok: true });
  })
);

/**
 * Delete a code outright.
 *
 * Takes the couple's whole history with it, which is the point when somebody
 * asks to be erased - but it is also why suspending exists and why this asks
 * for confirmation once it knows there is something to lose.
 */
owner.delete(
  '/couples/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const c = await queryOne(
      'SELECT id, access_code, partner_a, partner_b FROM couples WHERE id = ?',
      [id]
    );
    if (!c) return fail(res, 404, 'No such code.');

    const [{ n }] = await query(
      'SELECT COUNT(*) AS n FROM couple_question_status WHERE couple_id = ?',
      [id]
    );
    if (Number(n) > 0 && !req.body.confirmed) {
      return fail(
        res,
        409,
        `This code has ${n} answered question${Number(n) === 1 ? '' : 's'} behind it. Deleting `
          + 'it erases their history as well. Suspending it stops the code working and keeps the record.'
      );
    }

    await query('DELETE FROM couples WHERE id = ?', [id]);
    await audit(req, 'code.delete', {
      targetType: 'couple',
      targetId: id,
      targetLabel: `${c.partner_a || '?'} and ${c.partner_b || '?'}`,
      detail: `${n} answer record(s) removed`,
    });
    res.json({ ok: true, removed: Number(n) || 0 });
  })
);

owner.get(
  '/questions',
  wrap(async (req, res) => {
    const slug = String(req.query.level || '').trim();
    const level = slug ? await queryOne('SELECT id FROM domains WHERE slug = ?', [slug]) : null;
    if (slug && !level) return fail(res, 404, 'That level does not exist.');

    const rows = await query(
      `SELECT q.id, q.ref, q.text, q.context, q.depth, q.lens, q.is_volatile,
              q.needs_review, q.review_note, q.source, q.is_active, q.admin_hidden,
              q.sort_order, ch.name AS chainName, q.chain_position,
              l.slug AS levelSlug, l.name AS levelName,
              (SELECT COUNT(*) FROM couple_question_status s WHERE s.question_id = q.id) AS timesUsed
         FROM questions q
         JOIN domains l ON l.id = q.domain_id
         LEFT JOIN chains ch ON ch.id = q.chain_id
        ${level ? 'WHERE q.domain_id = ?' : ''}
        ORDER BY l.sort_order, q.depth, q.sort_order`,
      level ? [level.id] : []
    );

    res.json({
      questions: rows.map((r) => ({
        id: r.id,
        ref: r.ref,
        text: r.text,
        context: r.context,
        depth: Number(r.depth),
        lens: r.lens,
        volatile: !!r.is_volatile,
        needsReview: !!r.needs_review,
        reviewNote: r.review_note,
        chainName: r.chainName,
        chainPosition: r.chain_position,
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

owner.post(
  '/questions',
  wrap(async (req, res) => {
    const text = String(req.body.text || '').trim();
    const slug = String(req.body.level || '').trim();
    if (!text) return fail(res, 400, 'Enter the question.');
    if (text.length > 500) return fail(res, 400, 'That question is too long.');

    const level = await queryOne('SELECT id FROM domains WHERE slug = ? AND is_active = 1', [slug]);
    if (!level) return fail(res, 400, 'Choose a set.');

    const ladder = await activeDepths();
    const validDepths = new Set(ladder.map((d) => d.n));
    const wantedDepth = Number(req.body.depth);
    const depth = validDepths.has(wantedDepth) ? wantedDepth : ladder[0] ? ladder[0].n : 1;
    const context = String(req.body.context || '').trim().slice(0, 500) || null;
    const isVolatile = !!req.body.volatile;

    // The lens is provenance and is optional. A code that does not exist is
    // dropped rather than refused - a badge with no explanation behind it is
    // worse than no badge.
    const wantedLens = String(req.body.lens || '').trim().toUpperCase();
    const lens = wantedLens
      ? (await queryOne('SELECT code FROM lenses WHERE code = ?', [wantedLens]))?.code || null
      : null;

    // Admin refs are namespaced so they can never collide with a corpus ref,
    // present or future.
    const ref = `adm-${crypto.randomBytes(6).toString('hex')}`;
    const [{ n }] = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM questions WHERE domain_id = ?',
      [level.id]
    );

    const result = await query(
      `INSERT INTO questions
         (ref, domain_id, depth, lens, is_volatile, source, text, context, sort_order,
          is_active, admin_hidden)
       VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, 1, 0)`,
      [ref, level.id, depth, lens, isVolatile ? 1 : 0, text, context, n]
    );
    await audit(req, 'question.create', {
      targetType: 'question', targetId: result.insertId, targetLabel: text.slice(0, 120),
    });
    res.status(201).json({ ok: true, id: result.insertId, ref });
  })
);

/**
 * Edit a question.
 *
 * Every question is editable here, including corpus ones. That changed when
 * the database became authoritative: a deploy no longer rewrites content, so
 * an edit made here now survives one.
 *
 * The remaining caveat is narrower and belongs in the UI rather than in a
 * refusal: `npm run seed-corpus -- --replace` rebuilds everything from the
 * markdown and would overwrite an edit made here. That is an explicit,
 * destructive, hand-run command, not something a deploy does by itself.
 *
 * Releasing a quarantined question is deliberately part of editing it. A
 * question held back for being answerable yes/no is released by rewriting it,
 * and clearing the flag without touching the text would just put a broken card
 * back into circulation.
 */
owner.patch(
  '/questions/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await queryOne(
      'SELECT id, source, text, needs_review FROM questions WHERE id = ?',
      [id]
    );
    if (!q) return fail(res, 404, 'No such question.');

    if (req.body.text !== undefined) {
      const text = String(req.body.text).trim();
      if (!text) return fail(res, 400, 'Enter the question.');
      if (text.length > 500) return fail(res, 400, 'That question is too long.');
      await query('UPDATE questions SET text = ? WHERE id = ?', [text, id]);

      // Rewriting a held-back question is how it gets released, but only if the
      // wording actually changed.
      if (q.needs_review && text !== q.text) {
        await query(
          'UPDATE questions SET needs_review = 0, review_note = NULL, admin_hidden = 0 WHERE id = ?',
          [id]
        );
        await audit(req, 'question.release', {
          targetType: 'question', targetId: id, targetLabel: text.slice(0, 120),
        });
      }
    }

    if (req.body.context !== undefined) {
      const context = String(req.body.context).trim().slice(0, 500) || null;
      await query('UPDATE questions SET context = ? WHERE id = ?', [context, id]);
    }

    if (req.body.depth !== undefined) {
      const depth = Number(req.body.depth);
      const ladder = await activeDepths();
      if (!ladder.some((d) => d.n === depth)) {
        return fail(res, 400, 'That is not one of the depths on the ladder.');
      }
      await query('UPDATE questions SET depth = ? WHERE id = ?', [depth, id]);
    }

    if (req.body.lens !== undefined) {
      const wanted = String(req.body.lens || '').trim().toUpperCase();
      const lens = wanted
        ? (await queryOne('SELECT code FROM lenses WHERE code = ?', [wanted]))?.code || null
        : null;
      await query('UPDATE questions SET lens = ? WHERE id = ?', [lens, id]);
    }

    if (req.body.volatile !== undefined) {
      await query('UPDATE questions SET is_volatile = ? WHERE id = ?', [
        req.body.volatile ? 1 : 0,
        id,
      ]);
    }

    if (req.body.hidden !== undefined) {
      await query('UPDATE questions SET admin_hidden = ? WHERE id = ?', [
        req.body.hidden ? 1 : 0,
        id,
      ]);
    }

    const fresh = await queryOne(
      `SELECT q.id, q.ref, q.text, q.context, q.depth, q.is_volatile, q.needs_review,
              q.review_note, q.source, q.is_active, q.admin_hidden,
              l.slug AS levelSlug, l.name AS levelName
         FROM questions q JOIN domains l ON l.id = q.domain_id WHERE q.id = ?`,
      [id]
    );
    res.json({
      ok: true,
      question: {
        id: fresh.id,
        ref: fresh.ref,
        text: fresh.text,
        context: fresh.context,
        depth: Number(fresh.depth),
        volatile: !!fresh.is_volatile,
        needsReview: !!fresh.needs_review,
        reviewNote: fresh.review_note,
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

// Not in TUNABLE_SETTINGS: it is a credential, so it is reported as configured
// or not and never sent back to the browser - same rule as the SMTP password
// and the Anthropic key.
const SHOP_KEY_SETTING = 'shop_api_key';

owner.get(
  '/settings',
  wrap(async (req, res) => {
    const mail = await getMailConfig();
    const values = {};
    for (const key of TUNABLE_SETTINGS) values[key] = await getSetting(key);

    res.json({
      settings: values,
      defaults: DEFAULTS,
      shop: { configured: !!(await getSetting(SHOP_KEY_SETTING)) },
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

owner.put(
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

    // The shop's key. Generated here rather than typed, because a key somebody
    // invents is a key somebody can guess, and this one mints paid licences.
    if (body.shopKeyAction === 'generate') {
      const key = crypto.randomBytes(32).toString('base64url');
      await setSetting(SHOP_KEY_SETTING, key);
      await audit(req, 'shop.key.generate');
      // Returned exactly once, on the response that created it. After this the
      // API will only ever say whether one exists.
      return res.json({ ok: true, shopKey: key });
    }
    if (body.shopKeyAction === 'clear') {
      await setSetting(SHOP_KEY_SETTING, null);
      await audit(req, 'shop.key.clear');
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

owner.post(
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

// ---- Domains --------------------------------------------------------------
//
// Subject only. A domain has NO depth: depth is per question and is chosen
// separately by the couple. Re-adding a depth column here would rebuild the
// single-axis model the corpus exists to correct.

function slugify(v) {
  return String(v)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

owner.get(
  '/domains',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT l.id, l.slug, l.name, l.tagline, l.description, l.accent,
              l.sort_order, l.is_active,
              COUNT(q.id) AS questions,
              SUM(CASE WHEN q.admin_hidden = 1 THEN 1 ELSE 0 END) AS hidden,
              SUM(CASE WHEN q.needs_review = 1 THEN 1 ELSE 0 END) AS needsReview,
              SUM(CASE WHEN q.is_volatile = 1 THEN 1 ELSE 0 END) AS volatileCount,
              MIN(q.depth) AS minDepth, MAX(q.depth) AS maxDepth
         FROM domains l
         LEFT JOIN questions q ON q.domain_id = l.id AND q.is_active = 1
        GROUP BY l.id, l.slug, l.name, l.tagline, l.description, l.accent,
                 l.sort_order, l.is_active
        ORDER BY l.sort_order, l.id`
    );
    res.json({
      domains: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        description: r.description,
        accent: r.accent,
        sortOrder: r.sort_order,
        isActive: !!r.is_active,
        questions: Number(r.questions) || 0,
        hidden: Number(r.hidden) || 0,
        needsReview: Number(r.needsReview) || 0,
        volatileCount: Number(r.volatileCount) || 0,
        minDepth: r.minDepth === null ? null : Number(r.minDepth),
        maxDepth: r.maxDepth === null ? null : Number(r.maxDepth),
      })),
    });
  })
);

// No depth here, deliberately. A domain is a subject; depth belongs to the
// question. Accepting a depth on a domain would quietly recreate the single
// axis the corpus separates.
function readDomainBody(body) {
  const accent = /^#[0-9a-f]{6}$/i.test(String(body.accent || '')) ? body.accent : '#D8327C';
  return {
    name: String(body.name || '').trim(),
    accent,
    tagline: String(body.tagline || '').trim().slice(0, 180),
    description: String(body.description || '').trim() || null,
  };
}

owner.post(
  '/domains',
  wrap(async (req, res) => {
    const b = readDomainBody(req.body);
    if (!b.name) return fail(res, 400, 'Give the set a name.');
    if (b.name.length > 100) return fail(res, 400, 'That name is too long.');

    let slug = slugify(req.body.slug || b.name);
    if (!slug) return fail(res, 400, 'That name cannot be turned into a web address.');

    // Slugs are permanent identifiers, so a clash is resolved rather than
    // refused - the owner named the group, not the URL.
    const base = slug;
    for (let i = 2; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const clash = await queryOne('SELECT id FROM domains WHERE slug = ?', [slug]);
      if (!clash) break;
      slug = `${base}-${i}`;
    }

    const [{ n }] = await query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM domains');
    const result = await query(
      `INSERT INTO domains (slug, name, tagline, description, accent, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [slug, b.name, b.tagline, b.description, b.accent, n]
    );

    await audit(req, 'domain.create', { targetType: 'domain', targetId: result.insertId, targetLabel: b.name });
    res.status(201).json({ ok: true, id: result.insertId, slug });
  })
);

owner.patch(
  '/domains/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const level = await queryOne('SELECT id, name, is_active FROM domains WHERE id = ?', [id]);
    if (!level) return fail(res, 404, 'No such set.');

    const b = readDomainBody(req.body);
    if (req.body.name !== undefined && !b.name) return fail(res, 400, 'Give the set a name.');

    const isActive = req.body.isActive === undefined ? !!level.is_active : !!req.body.isActive;

    await query(
      `UPDATE domains
          SET name = COALESCE(?, name), tagline = COALESCE(?, tagline),
              description = COALESCE(?, description),
              accent = COALESCE(?, accent), is_active = ?
        WHERE id = ?`,
      [
        req.body.name === undefined ? null : b.name,
        req.body.tagline === undefined ? null : b.tagline,
        req.body.description === undefined ? null : b.description,
        req.body.accent === undefined ? null : b.accent,
        isActive ? 1 : 0,
        id,
      ]
    );

    await audit(req, 'group.update', { targetType: 'level', targetId: id, targetLabel: level.name });
    const fresh = await queryOne('SELECT * FROM domains WHERE id = ?', [id]);
    res.json({ ok: true, level: { id: fresh.id, slug: fresh.slug, name: fresh.name, isActive: !!fresh.is_active } });
  })
);

/** Reorder groups. Takes the full ordered list of ids in one go. */
owner.put(
  '/domains/order',
  wrap(async (req, res) => {
    const ids = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Boolean) : [];
    if (!ids.length) return fail(res, 400, 'Send the new order.');
    for (let i = 0; i < ids.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await query('UPDATE domains SET sort_order = ? WHERE id = ?', [i + 1, ids[i]]);
    }
    await audit(req, 'group.reorder', { detail: ids.join(',') });
    res.json({ ok: true });
  })
);

/**
 * Delete a group.
 *
 * Refused while it still holds questions. Deleting would cascade the questions
 * away and, with them, every couple's record of having discussed them - a far
 * bigger consequence than "remove this heading", and not one to infer from a
 * single tap. Empty it or hide it instead.
 */
owner.delete(
  '/domains/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const level = await queryOne('SELECT id, name FROM domains WHERE id = ?', [id]);
    if (!level) return fail(res, 404, 'No such group.');

    const [{ n }] = await query('SELECT COUNT(*) AS n FROM questions WHERE domain_id = ?', [id]);
    if (Number(n) > 0) {
      return fail(
        res,
        400,
        `"${level.name}" still holds ${n} question${Number(n) === 1 ? '' : 's'}. ` +
          'Move or delete them first, or hide the group instead - deleting it would take ' +
          'every couple\'s history of those questions with it.'
      );
    }

    await query('DELETE FROM domains WHERE id = ?', [id]);
    await audit(req, 'group.delete', { targetType: 'level', targetId: id, targetLabel: level.name });
    res.json({ ok: true });
  })
);

// ---- Depths ---------------------------------------------------------------
//
// The other axis. A depth is exposure and says nothing about subject, which is
// why it is a table of its own rather than a column on `domains` - collapsing
// the two is the single-axis model the corpus exists to correct.

owner.get(
  '/depths',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT dp.id, dp.n, dp.name, dp.blurb, dp.description, dp.sort_order, dp.is_active,
              (SELECT COUNT(*) FROM questions q WHERE q.depth = dp.n) AS questions,
              (SELECT COUNT(*) FROM questions q
                WHERE q.depth = dp.n AND q.is_active = 1 AND q.admin_hidden = 0
                  AND q.needs_review = 0) AS live
         FROM depths dp
        ORDER BY dp.sort_order, dp.n`
    );
    res.json({
      depths: rows.map((r) => ({
        id: r.id,
        n: Number(r.n),
        name: r.name,
        blurb: r.blurb,
        description: r.description,
        sortOrder: r.sort_order,
        isActive: !!r.is_active,
        questions: Number(r.questions) || 0,
        live: Number(r.live) || 0,
      })),
    });
  })
);

function readDepthBody(body) {
  return {
    name: String(body.name || '').trim().slice(0, 60),
    blurb: String(body.blurb || '').trim().slice(0, 200) || null,
    description: String(body.description || '').trim() || null,
  };
}

owner.post(
  '/depths',
  wrap(async (req, res) => {
    const b = readDepthBody(req.body);
    if (!b.name) return fail(res, 400, 'Give the depth a name.');

    const n = Number(req.body.n);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      return fail(res, 400, 'The depth number must be a whole number between 1 and 20.');
    }
    const clash = await queryOne('SELECT id FROM depths WHERE n = ?', [n]);
    if (clash) return fail(res, 400, `D${n} already exists.`);

    const result = await query(
      `INSERT INTO depths (n, name, blurb, description, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [n, b.name, b.blurb, b.description, n]
    );
    await audit(req, 'depth.create', {
      targetType: 'depth', targetId: result.insertId, targetLabel: `D${n} ${b.name}`,
    });
    res.status(201).json({ ok: true, id: result.insertId });
  })
);

owner.patch(
  '/depths/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne('SELECT id, n, name, is_active FROM depths WHERE id = ?', [id]);
    if (!row) return fail(res, 404, 'No such depth.');

    const b = readDepthBody(req.body);
    if (req.body.name !== undefined && !b.name) return fail(res, 400, 'Give the depth a name.');

    // `n` is deliberately NOT editable. It is what questions.depth stores, so
    // renumbering a rung would silently move every question sitting on it.
    const isActive = req.body.isActive === undefined ? !!row.is_active : !!req.body.isActive;

    if (!isActive) {
      const [{ live }] = await query(
        `SELECT COUNT(*) AS live FROM questions
          WHERE depth = ? AND is_active = 1 AND admin_hidden = 0 AND needs_review = 0`,
        [row.n]
      );
      if (Number(live) > 0 && !req.body.confirmed) {
        return fail(
          res,
          409,
          `D${row.n} still holds ${live} question${Number(live) === 1 ? '' : 's'} that couples can `
            + 'be dealt. Switching it off takes all of them out of circulation.'
        );
      }
    }

    await query(
      `UPDATE depths
          SET name = COALESCE(?, name), blurb = COALESCE(?, blurb),
              description = COALESCE(?, description), is_active = ?
        WHERE id = ?`,
      [
        req.body.name === undefined ? null : b.name,
        req.body.blurb === undefined ? null : b.blurb,
        req.body.description === undefined ? null : b.description,
        isActive ? 1 : 0,
        id,
      ]
    );
    await audit(req, 'depth.update', {
      targetType: 'depth', targetId: id, targetLabel: `D${row.n} ${row.name}`,
    });
    res.json({ ok: true });
  })
);

owner.delete(
  '/depths/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne('SELECT id, n, name FROM depths WHERE id = ?', [id]);
    if (!row) return fail(res, 404, 'No such depth.');

    // Refused while anything sits on it. There is no foreign key from
    // questions.depth to enforce this - deleting the row would leave questions
    // on a rung that no longer has a name, and they would still be dealt.
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM questions WHERE depth = ?', [row.n]);
    if (Number(n) > 0) {
      return fail(
        res,
        400,
        `${n} question${Number(n) === 1 ? ' sits' : 's sit'} at D${row.n}. Move them to another `
          + 'depth first, or switch this one off instead - deleting it would leave them on a '
          + 'rung with no name.'
      );
    }

    await query('DELETE FROM depths WHERE id = ?', [id]);
    await audit(req, 'depth.delete', {
      targetType: 'depth', targetId: id, targetLabel: `D${row.n} ${row.name}`,
    });
    res.json({ ok: true });
  })
);

// ---- Lenses (authors) -----------------------------------------------------

owner.get(
  '/lenses',
  wrap(async (req, res) => {
    // The mapping, not just the list. A lens is the THIRD axis - topics and
    // depths are the other two - and the only question worth asking about it is
    // where it actually lands: which subjects it covers and how deep it goes.
    // Answering that from the questions themselves means it cannot go stale.
    const rows = await query(
      `SELECT l.id, l.code, l.name, l.author, l.description, l.brief,
              l.sort_order, l.is_active,
              COUNT(q.id) AS questions,
              MIN(q.depth) AS minDepth,
              MAX(q.depth) AS maxDepth,
              SUM(CASE WHEN q.is_volatile = 1 THEN 1 ELSE 0 END) AS volatileCount,
              COUNT(DISTINCT q.domain_id) AS topicCount,
              GROUP_CONCAT(DISTINCT d.name ORDER BY d.sort_order SEPARATOR ', ') AS topics
         FROM lenses l
         LEFT JOIN questions q ON q.lens = l.code AND q.is_active = 1
         LEFT JOIN domains d ON d.id = q.domain_id
        GROUP BY l.id, l.code, l.name, l.author, l.description, l.brief,
                 l.sort_order, l.is_active
        ORDER BY l.sort_order, l.code`
    );
    res.json({
      lenses: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        author: r.author,
        description: r.description,
        brief: r.brief,
        sortOrder: r.sort_order,
        isActive: !!r.is_active,
        questions: Number(r.questions) || 0,
        minDepth: r.minDepth === null ? null : Number(r.minDepth),
        maxDepth: r.maxDepth === null ? null : Number(r.maxDepth),
        volatileCount: Number(r.volatileCount) || 0,
        topicCount: Number(r.topicCount) || 0,
        topics: r.topics || '',
        // The brief is what the generator reads. Without one it would be
        // writing to a name, so the UI says so rather than quietly producing
        // generic questions under a respected label.
        ready: !!(r.brief && r.brief.trim()),
      })),
    });
  })
);

function readLensBody(body) {
  return {
    name: String(body.name || '').trim().slice(0, 100),
    author: String(body.author || '').trim().slice(0, 120) || null,
    description: String(body.description || '').trim() || null,
    brief: String(body.brief || '').trim() || null,
  };
}

owner.post(
  '/lenses',
  wrap(async (req, res) => {
    const b = readLensBody(req.body);
    if (!b.name) return fail(res, 400, 'Give the framework a name.');

    const code = String(req.body.code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      return fail(res, 400, 'The code is exactly three letters, like SHE or GOT.');
    }
    const clash = await queryOne('SELECT id FROM lenses WHERE code = ?', [code]);
    if (clash) return fail(res, 400, `${code} is already taken.`);

    const [{ n }] = await query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM lenses');
    const result = await query(
      `INSERT INTO lenses (code, name, author, description, brief, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [code, b.name, b.author, b.description, b.brief, n]
    );
    await audit(req, 'lens.create', {
      targetType: 'lens', targetId: result.insertId, targetLabel: `${code} ${b.name}`,
    });
    res.status(201).json({ ok: true, id: result.insertId, code });
  })
);

owner.patch(
  '/lenses/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne('SELECT id, code, name, is_active FROM lenses WHERE id = ?', [id]);
    if (!row) return fail(res, 404, 'No such framework.');

    const b = readLensBody(req.body);
    if (req.body.name !== undefined && !b.name) return fail(res, 400, 'Give the framework a name.');

    // `code` is not editable. questions.lens stores it with no foreign key, so
    // changing it here would orphan every question that carries it.
    const isActive = req.body.isActive === undefined ? !!row.is_active : !!req.body.isActive;

    await query(
      `UPDATE lenses
          SET name = COALESCE(?, name), author = COALESCE(?, author),
              description = COALESCE(?, description), brief = COALESCE(?, brief),
              is_active = ?
        WHERE id = ?`,
      [
        req.body.name === undefined ? null : b.name,
        req.body.author === undefined ? null : b.author,
        req.body.description === undefined ? null : b.description,
        req.body.brief === undefined ? null : b.brief,
        isActive ? 1 : 0,
        id,
      ]
    );
    await audit(req, 'lens.update', {
      targetType: 'lens', targetId: id, targetLabel: `${row.code} ${row.name}`,
    });
    res.json({ ok: true });
  })
);

owner.delete(
  '/lenses/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const row = await queryOne('SELECT id, code, name FROM lenses WHERE id = ?', [id]);
    if (!row) return fail(res, 404, 'No such framework.');

    const [{ n }] = await query('SELECT COUNT(*) AS n FROM questions WHERE lens = ?', [row.code]);
    if (Number(n) > 0) {
      return fail(
        res,
        400,
        `${n} question${Number(n) === 1 ? ' carries' : 's carry'} the ${row.code} badge. Those `
          + 'cards would keep being dealt with a badge that opens an empty explanation. Switch '
          + 'it off instead.'
      );
    }

    await query('DELETE FROM lenses WHERE id = ?', [id]);
    await audit(req, 'lens.delete', {
      targetType: 'lens', targetId: id, targetLabel: `${row.code} ${row.name}`,
    });
    res.json({ ok: true });
  })
);

// ---- Chains (linked questions) --------------------------------------------
//
// A chain is a recommended running order over cards that circle the same
// construct at rising exposure. Every card in one still stands alone - that is
// the invariant the editor has to preserve, so membership is managed here and
// the questions themselves are never rewritten by it.

/**
 * Recompute a chain's cached shape from its members.
 *
 * total / min_depth / max_depth are derived, and the couple app reads them to
 * decide where the consent gate falls. Letting them drift from the membership
 * would put the gate in the wrong place, which is the one thing a chain must
 * not get wrong.
 */
async function recomputeChain(chainId) {
  const [agg] = await query(
    `SELECT COUNT(*) AS total, MIN(depth) AS lo, MAX(depth) AS hi
       FROM questions WHERE chain_id = ?`,
    [chainId]
  );
  await query(
    'UPDATE chains SET total = ?, min_depth = ?, max_depth = ? WHERE id = ?',
    [Number(agg.total) || 0, Number(agg.lo) || 1, Number(agg.hi) || 1, chainId]
  );
}

owner.get(
  '/chains',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth, ch.is_active,
              d.id AS domainId, d.name AS domainName, d.accent,
              COUNT(q.id) AS members,
              SUM(CASE WHEN q.is_volatile = 1 THEN 1 ELSE 0 END) AS volatileCount,
              SUM(CASE WHEN q.chain_position IS NULL THEN 1 ELSE 0 END) AS unpositioned
         FROM chains ch
         LEFT JOIN domains d ON d.id = ch.domain_id
         LEFT JOIN questions q ON q.chain_id = ch.id
        GROUP BY ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth, ch.is_active,
                 d.id, d.name, d.accent
        ORDER BY ch.name`
    );
    res.json({
      chains: rows.map((r) => ({
        id: r.id,
        name: r.name,
        total: Number(r.total) || 0,
        minDepth: Number(r.min_depth) || 1,
        maxDepth: Number(r.max_depth) || 1,
        isActive: !!r.is_active,
        domainId: r.domainId,
        domainName: r.domainName,
        accent: r.accent,
        members: Number(r.members) || 0,
        volatileCount: Number(r.volatileCount) || 0,
        unpositioned: Number(r.unpositioned) || 0,
      })),
    });
  })
);

owner.get(
  '/chains/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne(
      `SELECT ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth, ch.is_active,
              ch.domain_id, d.name AS domainName
         FROM chains ch LEFT JOIN domains d ON d.id = ch.domain_id
        WHERE ch.id = ?`,
      [id]
    );
    if (!chain) return fail(res, 404, 'No such sequence.');

    const members = await query(
      `SELECT q.id, q.ref, q.text, q.depth, q.lens, q.is_volatile, q.chain_position,
              q.admin_hidden, q.needs_review, d.name AS domainName
         FROM questions q LEFT JOIN domains d ON d.id = q.domain_id
        WHERE q.chain_id = ?
        ORDER BY q.chain_position, q.depth, q.id`,
      [id]
    );

    res.json({
      chain: {
        id: chain.id,
        name: chain.name,
        total: Number(chain.total) || 0,
        minDepth: Number(chain.min_depth) || 1,
        maxDepth: Number(chain.max_depth) || 1,
        isActive: !!chain.is_active,
        domainId: chain.domain_id,
        domainName: chain.domainName,
      },
      members: members.map((m) => ({
        id: m.id,
        ref: m.ref,
        text: m.text,
        depth: Number(m.depth),
        lens: m.lens,
        volatile: !!m.is_volatile,
        position: m.chain_position === null ? null : Number(m.chain_position),
        hidden: !!m.admin_hidden,
        needsReview: !!m.needs_review,
        domainName: m.domainName,
      })),
    });
  })
);

owner.post(
  '/chains',
  wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return fail(res, 400, 'Give the sequence a name.');
    const clash = await queryOne('SELECT id FROM chains WHERE name = ?', [name]);
    if (clash) return fail(res, 400, 'A sequence with that name already exists.');

    const domainId = req.body.domainId ? Number(req.body.domainId) : null;
    const result = await query(
      'INSERT INTO chains (name, total, min_depth, max_depth, domain_id, is_active) VALUES (?, 0, 1, 1, ?, 1)',
      [name, domainId || null]
    );
    await audit(req, 'chain.create', {
      targetType: 'chain', targetId: result.insertId, targetLabel: name,
    });
    res.status(201).json({ ok: true, id: result.insertId });
  })
);

owner.patch(
  '/chains/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne('SELECT id, name, is_active FROM chains WHERE id = ?', [id]);
    if (!chain) return fail(res, 404, 'No such sequence.');

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 60);
      if (!name) return fail(res, 400, 'Give the sequence a name.');
      const clash = await queryOne('SELECT id FROM chains WHERE name = ? AND id <> ?', [name, id]);
      if (clash) return fail(res, 400, 'A sequence with that name already exists.');
      await query('UPDATE chains SET name = ? WHERE id = ?', [name, id]);
    }
    if (req.body.domainId !== undefined) {
      const domainId = req.body.domainId ? Number(req.body.domainId) : null;
      await query('UPDATE chains SET domain_id = ? WHERE id = ?', [domainId || null, id]);
    }
    if (req.body.isActive !== undefined) {
      await query('UPDATE chains SET is_active = ? WHERE id = ?', [req.body.isActive ? 1 : 0, id]);
    }

    await audit(req, 'chain.update', { targetType: 'chain', targetId: id, targetLabel: chain.name });
    res.json({ ok: true });
  })
);

/**
 * Set a chain's membership and running order in one call.
 *
 * The whole ordered list, not one add at a time, because the order IS the
 * content of a chain and a half-applied reorder is a chain that plays wrong.
 * Questions dropped from the list keep existing and keep being dealt on their
 * own - leaving a chain is not leaving the collection.
 */
owner.put(
  '/chains/:id/questions',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne('SELECT id, name FROM chains WHERE id = ?', [id]);
    if (!chain) return fail(res, 404, 'No such sequence.');

    const wanted = Array.isArray(req.body.order) ? req.body.order.map(Number).filter(Boolean) : [];
    const unique = [...new Set(wanted)];

    if (unique.length) {
      const rows = await query(
        `SELECT id, chain_id FROM questions WHERE id IN (${unique.map(() => '?').join(',')})`,
        unique
      );
      const found = new Set(rows.map((r) => r.id));
      const missing = unique.filter((qid) => !found.has(qid));
      if (missing.length) return fail(res, 400, 'Some of those questions no longer exist.');

      const stolen = rows.filter((r) => r.chain_id && r.chain_id !== id);
      if (stolen.length && !req.body.confirmed) {
        return fail(
          res,
          409,
          `${stolen.length} of those question${stolen.length === 1 ? ' is' : 's are'} already in `
            + 'another sequence. A question can only be in one, so adding it here removes it '
            + 'from there.'
        );
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Clear first, then re-lay the order, so a question dropped from the list
      // is actually released rather than left pointing at a position it no
      // longer occupies.
      await conn.query(
        'UPDATE questions SET chain_id = NULL, chain_position = NULL WHERE chain_id = ?',
        [id]
      );
      for (let i = 0; i < unique.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await conn.query('UPDATE questions SET chain_id = ?, chain_position = ? WHERE id = ?', [
          id,
          i + 1,
          unique[i],
        ]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await recomputeChain(id);
    await audit(req, 'chain.members', {
      targetType: 'chain',
      targetId: id,
      targetLabel: chain.name,
      detail: `${unique.length} question(s)`,
    });

    const fresh = await queryOne('SELECT total, min_depth, max_depth FROM chains WHERE id = ?', [id]);
    res.json({
      ok: true,
      total: Number(fresh.total),
      minDepth: Number(fresh.min_depth),
      maxDepth: Number(fresh.max_depth),
    });
  })
);

owner.delete(
  '/chains/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne('SELECT id, name FROM chains WHERE id = ?', [id]);
    if (!chain) return fail(res, 404, 'No such sequence.');

    // Safe by construction: questions.chain_id is ON DELETE SET NULL, so the
    // questions survive and go back to being dealt individually. Only the
    // recommended order is thrown away - which is what "delete a sequence"
    // ought to mean.
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM questions WHERE chain_id = ?', [id]);
    await query('DELETE FROM chains WHERE id = ?', [id]);
    await audit(req, 'chain.delete', {
      targetType: 'chain', targetId: id, targetLabel: chain.name, detail: `released ${n} question(s)`,
    });
    res.json({ ok: true, released: Number(n) || 0 });
  })
);

// ---- AI configuration and generation --------------------------------------

owner.get(
  '/ai',
  wrap(async (req, res) => {
    const { key, source, unreadable } = await resolveAnthropicKey();
    const model = (await getSetting('anthropic_model')) || AI_DEFAULT_MODEL;
    res.json({
      // The key itself is NEVER in this payload. Only whether one exists, where
      // it came from, and enough of it to recognise which key it is.
      configured: !!key,
      masked: maskKey(key),
      source,
      unreadable,
      model,
      defaultModel: AI_DEFAULT_MODEL,
    });
  })
);

owner.put(
  '/ai',
  wrap(async (req, res) => {
    if (req.body.apiKey) {
      const k = String(req.body.apiKey).trim();
      if (k.length < 20) return fail(res, 400, 'That does not look like an API key.');
      await setSetting('anthropic_api_key', encryptSecret(k));
      await audit(req, 'ai.key.set', { detail: maskKey(k) });
    } else if (req.body.clearKey) {
      await setSetting('anthropic_api_key', null);
      await audit(req, 'ai.key.clear');
    }

    if (req.body.model !== undefined) {
      const m = String(req.body.model).trim().slice(0, 60);
      await setSetting('anthropic_model', m || null);
    }

    res.json({ ok: true });
  })
);

owner.post(
  '/ai/generate',
  wrap(async (req, res) => {
    const { key, unreadable } = await resolveAnthropicKey();
    if (unreadable) {
      return fail(res, 400, 'The stored API key cannot be read. Enter it again and save.');
    }
    if (!key) return fail(res, 400, 'Add an Anthropic API key first.');

    const model = (await getSetting('anthropic_model')) || AI_DEFAULT_MODEL;

    const lens = req.body.lensCode
      ? await queryOne('SELECT code, name, author, description, brief FROM lenses WHERE code = ?', [
          String(req.body.lensCode).trim().toUpperCase(),
        ])
      : null;
    if (req.body.lensCode && !lens) return fail(res, 400, 'No such framework.');

    const domain = req.body.domainId
      ? await queryOne('SELECT id, slug, name, tagline, description FROM domains WHERE id = ?', [
          Number(req.body.domainId),
        ])
      : null;
    if (req.body.domainId && !domain) return fail(res, 400, 'No such topic.');
    if (!domain) return fail(res, 400, 'Choose which topic these belong to.');

    const ladder = await activeDepths();
    const valid = new Set(ladder.map((d) => d.n));
    const depths = [
      ...new Set((Array.isArray(req.body.depths) ? req.body.depths : []).map(Number).filter((n) => valid.has(n))),
    ].sort((a, b) => a - b);
    if (!depths.length) return fail(res, 400, 'Choose at least one depth.');

    const count = Math.min(20, Math.max(1, Number(req.body.count) || 8));
    const note = String(req.body.note || '').trim().slice(0, 500) || null;

    // Show it what is already there. Without this the same twenty questions
    // come back under different framework names, which is worse than useless -
    // it looks like coverage.
    const existing = await query(
      `SELECT text FROM questions
        WHERE domain_id = ? ${lens ? 'AND lens = ?' : ''}
        ORDER BY RAND() LIMIT 40`,
      lens ? [domain.id, lens.code] : [domain.id]
    );

    let candidates;
    try {
      candidates = await generateCandidates({
        key,
        model,
        lens,
        domain,
        depths,
        ladder,
        count,
        note,
        avoid: existing.map((r) => r.text),
      });
    } catch (err) {
      // Surfaced as a 400 with the real reason rather than a 500, because every
      // realistic failure here (bad key, refusal, cut-off reply) is something
      // the owner can act on.
      return fail(res, 400, err.message);
    }

    if (!candidates.length) return fail(res, 400, 'Nothing came back. Try again.');

    const batch = crypto.randomBytes(8).toString('hex');
    let ok = 0;
    let flagged = 0;
    let rejected = 0;

    for (const c of candidates) {
      const text = String(c.question || '').trim().slice(0, 500);
      const context = String(c.context || '').trim().slice(0, 500) || null;
      const depth = valid.has(Number(c.depth)) ? Number(c.depth) : depths[0];

      // THE ENFORCEMENT. The prompt asked for these rules; this is what makes
      // them true. A model that ignored them produces a draft marked rejected,
      // not a card in the deck.
      const verdictRaw = checkQuestion(text, context);
      const verdict = verdictRaw.fatal ? 'rejected' : verdictRaw.issues.length ? 'review' : 'ok';
      if (verdict === 'ok') ok += 1;
      else if (verdict === 'review') flagged += 1;
      else rejected += 1;

      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO question_drafts
           (batch, lens, domain_id, depth, text, context, is_volatile, verdict, issues,
            status, model, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          batch,
          lens ? lens.code : null,
          domain.id,
          depth,
          text,
          context,
          c.volatile ? 1 : 0,
          verdict,
          verdictRaw.issues.map((i) => `${i.level}: ${i.why}`).join(' · ').slice(0, 500) || null,
          model,
          req.user.id,
        ]
      );
    }

    await audit(req, 'ai.generate', {
      targetType: 'domain',
      targetId: domain.id,
      targetLabel: `${lens ? `${lens.code} · ` : ''}${domain.name}`,
      detail: `${candidates.length} drafted (${ok} clean, ${flagged} flagged, ${rejected} rejected) via ${model}`,
    });

    res.json({ ok: true, batch, drafted: candidates.length, clean: ok, flagged, rejected });
  })
);

// ---- Drafts ---------------------------------------------------------------

owner.get(
  '/drafts',
  wrap(async (req, res) => {
    const status = ['pending', 'accepted', 'discarded'].includes(req.query.status)
      ? req.query.status
      : 'pending';

    const rows = await query(
      `SELECT dr.id, dr.batch, dr.lens, dr.depth, dr.text, dr.context, dr.is_volatile,
              dr.verdict, dr.issues, dr.status, dr.model, dr.created_at, dr.question_id,
              d.id AS domainId, d.name AS domainName, d.slug AS domainSlug,
              l.name AS lensName, u.display_name AS byName
         FROM question_drafts dr
         LEFT JOIN domains d ON d.id = dr.domain_id
         LEFT JOIN lenses l ON l.code = dr.lens
         LEFT JOIN users u ON u.id = dr.created_by
        WHERE dr.status = ?
        ORDER BY dr.created_at DESC, dr.id
        LIMIT 300`,
      [status]
    );

    const [counts] = await query(
      `SELECT
         SUM(status = 'pending')   AS pending,
         SUM(status = 'accepted')  AS accepted,
         SUM(status = 'discarded') AS discarded
       FROM question_drafts`
    );

    res.json({
      status,
      counts: {
        pending: Number(counts.pending) || 0,
        accepted: Number(counts.accepted) || 0,
        discarded: Number(counts.discarded) || 0,
      },
      drafts: rows.map((r) => ({
        id: r.id,
        batch: r.batch,
        lens: r.lens,
        lensName: r.lensName,
        depth: Number(r.depth),
        text: r.text,
        context: r.context,
        volatile: !!r.is_volatile,
        verdict: r.verdict,
        issues: r.issues,
        status: r.status,
        model: r.model,
        createdAt: r.created_at,
        questionId: r.question_id,
        domainId: r.domainId,
        domainName: r.domainName,
        domainSlug: r.domainSlug,
        byName: r.byName,
      })),
    });
  })
);

/**
 * Edit a draft.
 *
 * Re-checks on every save, so a rejected draft is released by REWRITING it -
 * the same rule the questions editor applies. Clearing the verdict without
 * touching the words would just move a broken card one step closer to a couple.
 */
owner.patch(
  '/drafts/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = await queryOne('SELECT * FROM question_drafts WHERE id = ?', [id]);
    if (!d) return fail(res, 404, 'No such draft.');
    if (d.status !== 'pending') return fail(res, 400, 'That draft has already been dealt with.');

    const text = req.body.text === undefined ? d.text : String(req.body.text).trim().slice(0, 500);
    const context =
      req.body.context === undefined
        ? d.context
        : String(req.body.context).trim().slice(0, 500) || null;
    if (!text) return fail(res, 400, 'Enter the question.');

    const ladder = await activeDepths();
    const valid = new Set(ladder.map((x) => x.n));
    const depth =
      req.body.depth === undefined || !valid.has(Number(req.body.depth))
        ? d.depth
        : Number(req.body.depth);
    const domainId = req.body.domainId === undefined ? d.domain_id : Number(req.body.domainId) || null;
    const isVolatile = req.body.volatile === undefined ? !!d.is_volatile : !!req.body.volatile;

    const check = checkQuestion(text, context);
    const verdict = check.fatal ? 'rejected' : check.issues.length ? 'review' : 'ok';

    await query(
      `UPDATE question_drafts
          SET text = ?, context = ?, depth = ?, domain_id = ?, is_volatile = ?,
              verdict = ?, issues = ?
        WHERE id = ?`,
      [
        text,
        context,
        depth,
        domainId,
        isVolatile ? 1 : 0,
        verdict,
        check.issues.map((i) => `${i.level}: ${i.why}`).join(' · ').slice(0, 500) || null,
        id,
      ]
    );
    res.json({ ok: true, verdict, issues: check.issues });
  })
);

/**
 * Accept a draft into the collection.
 *
 * Refuses a draft the rules reject. That is the point of the whole queue: the
 * owner can override a "review" note, which is what review means, but "this
 * card cannot be answered without having seen another one" is not a matter of
 * taste, and there is no button that says otherwise.
 */
owner.post(
  '/drafts/:id/accept',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = await queryOne('SELECT * FROM question_drafts WHERE id = ?', [id]);
    if (!d) return fail(res, 404, 'No such draft.');
    if (d.status !== 'pending') return fail(res, 400, 'That draft has already been dealt with.');
    if (!d.domain_id) return fail(res, 400, 'Give it a topic first.');

    // Re-checked at the moment of acceptance rather than trusting the stored
    // verdict, so a rule tightened since the draft was written still applies.
    const check = checkQuestion(d.text, d.context);
    if (check.fatal) {
      return fail(
        res,
        400,
        `This cannot be served as written - ${check.issues
          .filter((i) => i.level === 'fatal')
          .map((i) => i.why)
          .join('; ')}. Rewrite it first.`
      );
    }

    const ref = `gen-${crypto.randomBytes(6).toString('hex')}`;
    const [{ n }] = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM questions WHERE domain_id = ?',
      [d.domain_id]
    );

    const result = await query(
      `INSERT INTO questions
         (ref, domain_id, depth, lens, is_volatile, source, text, context, sort_order,
          needs_review, review_note, is_active, admin_hidden)
       VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?, 0, NULL, 1, 0)`,
      [ref, d.domain_id, d.depth, d.lens, d.is_volatile, d.text, d.context, n]
    );

    await query(
      "UPDATE question_drafts SET status = 'accepted', question_id = ?, reviewed_at = NOW() WHERE id = ?",
      [result.insertId, id]
    );
    await audit(req, 'draft.accept', {
      targetType: 'question',
      targetId: result.insertId,
      targetLabel: d.text.slice(0, 120),
      detail: `from draft ${id}${d.lens ? ` (${d.lens})` : ''}`,
    });
    res.json({ ok: true, questionId: result.insertId, ref });
  })
);

owner.post(
  '/drafts/:id/discard',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const d = await queryOne('SELECT id, text, status FROM question_drafts WHERE id = ?', [id]);
    if (!d) return fail(res, 404, 'No such draft.');
    if (d.status !== 'pending') return fail(res, 400, 'That draft has already been dealt with.');

    // Kept, not deleted. A discarded draft is the record of what was tried and
    // turned down, which is exactly what stops the same idea coming back next
    // month looking new.
    await query("UPDATE question_drafts SET status = 'discarded', reviewed_at = NOW() WHERE id = ?", [id]);
    await audit(req, 'draft.discard', {
      targetType: 'draft', targetId: id, targetLabel: d.text.slice(0, 120),
    });
    res.json({ ok: true });
  })
);

// ---- Questions: full control now that the database is the source of truth ---

owner.delete(
  '/questions/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const q = await queryOne('SELECT id, text FROM questions WHERE id = ?', [id]);
    if (!q) return fail(res, 404, 'No such question.');

    const [{ n }] = await query(
      'SELECT COUNT(*) AS n FROM couple_question_status WHERE question_id = ?',
      [id]
    );

    // Deleting throws away the record that couples discussed it. Hiding keeps
    // that history and has the same effect on what gets served, so the API
    // insists the caller says they meant it.
    if (Number(n) > 0 && !req.body.confirmed) {
      return fail(
        res,
        409,
        `${n} couple${Number(n) === 1 ? ' has' : 's have'} already answered this. Deleting it ` +
          'erases that from their history. Hiding it has the same effect and keeps the record.'
      );
    }

    await query('DELETE FROM questions WHERE id = ?', [id]);
    await audit(req, 'question.delete', {
      targetType: 'question',
      targetId: id,
      targetLabel: q.text.slice(0, 120),
      detail: `had ${n} answer record(s)`,
    });
    res.json({ ok: true, removedAnswerRecords: Number(n) });
  })
);

/** Move a question to a different group. */
owner.patch(
  '/questions/:id/level',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const level = await queryOne('SELECT id, name FROM domains WHERE slug = ?', [
      String(req.body.level || ''),
    ]);
    if (!level) return fail(res, 400, 'Choose a group.');
    const q = await queryOne('SELECT id, text FROM questions WHERE id = ?', [id]);
    if (!q) return fail(res, 404, 'No such question.');

    await query('UPDATE questions SET domain_id = ? WHERE id = ?', [level.id, id]);
    await audit(req, 'question.move', {
      targetType: 'question',
      targetId: id,
      targetLabel: q.text.slice(0, 120),
      detail: `moved to ${level.name}`,
    });
    res.json({ ok: true });
  })
);

// ---- Spreadsheet import / export ------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const IMPORT_COLUMNS = ['group', 'question', 'ref'];

/**
 * Turn an uploaded workbook into rows, and say what is wrong with them.
 *
 * Deliberately forgiving about the header: people export from all sorts of
 * places, so "Group"/"Level"/"Category" all mean the same thing and case and
 * spacing are ignored. Being strict here would mean rejecting a perfectly good
 * spreadsheet over a capital letter.
 */
function parseWorkbook(buffer, levelsBySlug, levelsByName) {
  // eslint-disable-next-line global-require
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('That file has no sheets in it.');

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!raw.length) throw new Error('That sheet has no rows.');

  const alias = (key) => {
    const k = String(key).toLowerCase().replace(/[^a-z]/g, '');
    if (['group', 'level', 'category', 'deck', 'section', 'domain', 'set'].includes(k)) return 'group';
    if (['question', 'text', 'questiontext', 'prompt'].includes(k)) return 'question';
    if (['ref', 'reference', 'id', 'code'].includes(k)) return 'ref';
    if (['depth', 'exposure'].includes(k)) return 'depth';
    if (['context', 'helper', 'hint', 'note'].includes(k)) return 'context';
    if (['vol', 'volatile', 'volatility'].includes(k)) return 'volatile';
    return null;
  };

  const rows = [];
  raw.forEach((r, i) => {
    const mapped = {};
    Object.keys(r).forEach((key) => {
      const a = alias(key);
      if (a) mapped[a] = String(r[key] || '').trim();
    });

    const rowNo = i + 2; // +1 for zero-index, +1 for the header row
    const text = mapped.question || '';
    const groupName = mapped.group || '';
    const ref = mapped.ref || '';

    if (!text && !groupName) return; // genuinely blank line, not an error

    let level = null;
    if (groupName) {
      level =
        levelsBySlug.get(slugify(groupName)) ||
        levelsByName.get(groupName.toLowerCase()) ||
        null;
    }

    // "D3" and "3" both mean depth 3. Anything unreadable falls back to 2
    // rather than failing the row - depth is a judgement the owner can correct
    // in the app, and it is not worth losing a question over.
    const depthRaw = String(mapped.depth || '').trim().replace(/^d/i, '');
    const depthNum = Number(depthRaw);
    const depth = Number.isInteger(depthNum) && depthNum >= 1 && depthNum <= 5 ? depthNum : 2;

    rows.push({
      rowNo,
      text,
      groupName,
      ref,
      depth,
      context: String(mapped.context || '').trim().slice(0, 500) || null,
      volatile: /^(yes|y|true|1)$/i.test(String(mapped.volatile || '').trim()),
      levelId: level ? level.id : null,
      levelName: level ? level.name : null,
      error: !text
        ? 'No question text'
        : text.length > 500
          ? 'Question is longer than 500 characters'
          : !groupName
            ? 'No group given'
            : !level
              ? `No group called "${groupName}"`
              : null,
    });
  });

  return rows;
}

/**
 * Import questions from .xlsx / .xls / .csv.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless `commit` is set, so the owner
 * always sees exactly what a file will do - how many rows are new, how many
 * update an existing ref, and every row that cannot be used and why - before
 * anything touches the database. A 300-row spreadsheet is precisely the sort of
 * thing you do not want to find out about afterwards.
 */
owner.post(
  '/questions/import',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return fail(res, 400, 'Choose a file to upload.');

    const levels = await query('SELECT id, slug, name FROM domains');
    const bySlug = new Map(levels.map((l) => [l.slug, l]));
    const byName = new Map(levels.map((l) => [l.name.toLowerCase(), l]));

    let rows;
    try {
      rows = parseWorkbook(req.file.buffer, bySlug, byName);
    } catch (err) {
      return fail(res, 400, `Could not read that file: ${err.message}`);
    }

    if (!rows.length) return fail(res, 400, 'No usable rows found in that file.');

    // Resolve what each valid row would do.
    const valid = rows.filter((r) => !r.error);
    const invalid = rows.filter((r) => r.error);

    const seenRefs = new Set();
    for (const r of valid) {
      if (r.ref) {
        if (seenRefs.has(r.ref)) {
          r.error = `Duplicate ref "${r.ref}" earlier in this file`;
          continue;
        }
        seenRefs.add(r.ref);
        // eslint-disable-next-line no-await-in-loop
        const existing = await queryOne('SELECT id, text FROM questions WHERE ref = ?', [r.ref]);
        r.action = existing ? 'update' : 'create';
        r.existingId = existing ? existing.id : null;
        r.unchanged = !!existing && existing.text === r.text;
      } else {
        // No ref given: match on exact text within the group so re-uploading
        // the same file twice does not duplicate everything.
        // eslint-disable-next-line no-await-in-loop
        const existing = await queryOne(
          'SELECT id FROM questions WHERE domain_id = ? AND text = ?',
          [r.levelId, r.text]
        );
        r.action = existing ? 'skip' : 'create';
        r.existingId = existing ? existing.id : null;
      }
    }

    const usable = valid.filter((r) => !r.error);
    const summary = {
      totalRows: rows.length,
      create: usable.filter((r) => r.action === 'create').length,
      update: usable.filter((r) => r.action === 'update' && !r.unchanged).length,
      unchanged: usable.filter((r) => r.unchanged || r.action === 'skip').length,
      problems: rows.filter((r) => r.error).length,
    };

    if (!req.body.commit || req.body.commit === 'false') {
      return res.json({
        dryRun: true,
        summary,
        problems: rows.filter((r) => r.error).slice(0, 50).map((r) => ({
          row: r.rowNo,
          text: r.text.slice(0, 90),
          error: r.error,
        })),
        sample: usable.slice(0, 10).map((r) => ({
          row: r.rowNo,
          action: r.unchanged ? 'unchanged' : r.action,
          group: r.levelName,
          text: r.text.slice(0, 90),
        })),
      });
    }

    let created = 0;
    let updated = 0;
    for (const r of usable) {
      if (r.action === 'create') {
        const ref = r.ref || `imp-${crypto.randomBytes(6).toString('hex')}`;
        // eslint-disable-next-line no-await-in-loop
        const [{ n }] = await query(
          'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM questions WHERE domain_id = ?',
          [r.levelId]
        );
        // eslint-disable-next-line no-await-in-loop
        await query(
          `INSERT INTO questions
             (ref, domain_id, depth, is_volatile, source, text, context, sort_order,
              is_active, admin_hidden)
           VALUES (?, ?, ?, ?, 'import', ?, ?, ?, 1, 0)`,
          [ref, r.levelId, r.depth, r.volatile ? 1 : 0, r.text, r.context, n]
        );
        created += 1;
      } else if (r.action === 'update' && !r.unchanged) {
        // eslint-disable-next-line no-await-in-loop
        await query(
          `UPDATE questions
              SET text = ?, domain_id = ?, depth = ?, is_volatile = ?,
                  context = COALESCE(?, context)
            WHERE id = ?`,
          [r.text, r.levelId, r.depth, r.volatile ? 1 : 0, r.context, r.existingId]
        );
        updated += 1;
      }
    }

    await audit(req, 'questions.import', {
      detail: `${created} created, ${updated} updated, ${summary.problems} skipped, from ${req.file.originalname}`,
    });

    res.json({ dryRun: false, summary: { ...summary, created, updated } });
  })
);

/** Export every question as .xlsx - the round trip, and the content backup. */
owner.get(
  '/questions/export',
  wrap(async (req, res) => {
    // eslint-disable-next-line global-require
    const XLSX = require('xlsx');
    const rows = await query(
      `SELECT l.name AS "group", q.text AS question, q.ref, q.depth, q.context,
              q.is_volatile, q.lens, ch.name AS chainName, q.chain_position,
              q.source, q.admin_hidden AS hidden, q.needs_review, q.review_note,
              (SELECT COUNT(*) FROM couple_question_status s WHERE s.question_id = q.id) AS timesAnswered
         FROM questions q
         JOIN domains l ON l.id = q.domain_id
         LEFT JOIN chains ch ON ch.id = q.chain_id
        ORDER BY l.sort_order, q.depth, q.sort_order`
    );

    // Every column the import understands is exported, so the round trip is
    // lossless. Dropping depth or context here would silently flatten the two
    // axes back into one the first time somebody edited in Excel.
    const sheet = XLSX.utils.json_to_sheet(
      rows.map((r) => ({
        group: r.group,
        depth: `D${r.depth}`,
        question: r.question,
        context: r.context || '',
        volatile: r.is_volatile ? 'yes' : '',
        ref: r.ref,
        lens: r.lens || '',
        chain: r.chainName ? `${r.chainName} ${r.chain_position}` : '',
        source: r.source,
        hidden: r.hidden ? 'yes' : '',
        heldBack: r.needs_review ? r.review_note || 'yes' : '',
        timesAnswered: Number(r.timesAnswered) || 0,
      }))
    );
    sheet['!cols'] = [
      { wch: 18 }, { wch: 7 }, { wch: 70 }, { wch: 60 }, { wch: 9 }, { wch: 12 },
      { wch: 6 }, { wch: 16 }, { wch: 10 }, { wch: 8 }, { wch: 30 }, { wch: 14 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Questions');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="lets-connect-questions.xlsx"');
    res.send(buf);
  })
);

/** A blank workbook with the right headers, so nobody has to guess the format. */
owner.get(
  '/questions/template',
  wrap(async (req, res) => {
    // eslint-disable-next-line global-require
    const XLSX = require('xlsx');
    const levels = await query('SELECT name FROM domains WHERE is_active = 1 ORDER BY sort_order');
    const example = levels.length ? levels[0].name : 'You & Me';

    const sheet = XLSX.utils.json_to_sheet([
      {
        group: example,
        depth: 'D2',
        question: 'What has been on your mind this week that I have not asked you about?',
        context: 'Not a test. Just the thing you have been turning over without mentioning.',
        volatile: '',
        ref: '',
      },
      {
        group: example,
        depth: 'D1',
        question: 'Replace these rows with your own. Leave ref blank for new questions.',
        context: 'One short line that opens the territory without supplying an answer.',
        volatile: '',
        ref: '',
      },
    ]);
    sheet['!cols'] = [{ wch: 18 }, { wch: 7 }, { wch: 70 }, { wch: 60 }, { wch: 9 }, { wch: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Questions');
    const notes = XLSX.utils.aoa_to_sheet([
      ['How this import works'],
      [''],
      ['group', 'Must match a set that already exists. Create the set first.'],
      ['depth', 'D1 to D5, or just 1 to 5. Emotional exposure ONLY, not subject.'],
      ['', 'D1 open · D2 reflective · D3 personal · D4 exposed · D5 rupture.'],
      ['', 'Blank defaults to D2.'],
      ['question', 'The question text, up to 500 characters. It must stand alone:'],
      ['', 'every card is shown on its own, so nothing may refer to a previous one.'],
      ['', 'Avoid anything answerable with a bare yes or no.'],
      ['context', 'One line under eighteen words, revealed when the reader taps the card.'],
      ['', 'Name the territory. NEVER give an example answer - that anchors every'],
      ['', 'couple to the same reply and kills the question.'],
      ['volatile', 'yes for questions that could end a relationship in the wrong week.'],
      ['', 'These stay locked until both partners separately opt in.'],
      ['ref', 'Leave blank for new questions. Paste a ref from an export and that'],
      ['', 'question is UPDATED rather than duplicated.'],
      [''],
      ['Uploading always shows a preview first. Nothing is saved until you confirm.'],
      ['Headings are flexible: Level/Category/Domain all work for group, Text for question.'],
    ]);
    notes['!cols'] = [{ wch: 14 }, { wch: 84 }];
    XLSX.utils.book_append_sheet(wb, notes, 'How to use');

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="lets-connect-import-template.xlsx"');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  })
);

// ---- Question quality -----------------------------------------------------

/**
 * Skip rate per question.
 *
 * Only questions with a meaningful number of answers are ranked: one couple
 * skipping something is not a signal, and sorting purely by percentage would
 * put every 1-of-1 skip at the top and bury the question that 40 couples have
 * quietly passed over.
 */
owner.get(
  '/insights',
  wrap(async (req, res) => {
    const minAnswers = Math.max(1, Number(req.query.min) || 3);

    const worst = await query(
      `SELECT q.id, q.text, l.name AS levelName, q.admin_hidden,
              COUNT(s.id) AS answered,
              SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM questions q
         JOIN domains l ON l.id = q.domain_id
         JOIN couple_question_status s ON s.question_id = q.id
        GROUP BY q.id, q.text, l.name, q.admin_hidden
       -- The aggregates are repeated rather than referred to by alias:
       -- MariaDB refuses an aggregate alias used inside an expression here
       -- ("Reference 'skipped' not supported (reference to group function)").
       HAVING COUNT(s.id) >= ?
        ORDER BY (SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) / COUNT(s.id)) DESC,
                 COUNT(s.id) DESC
        LIMIT 25`,
      [minAnswers]
    );

    const byLevel = await query(
      `SELECT l.name, l.accent,
              COUNT(s.id) AS answered,
              SUM(CASE WHEN s.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM domains l
         LEFT JOIN questions q ON q.domain_id = l.id
         LEFT JOIN couple_question_status s ON s.question_id = q.id
        WHERE l.is_active = 1
        GROUP BY l.id, l.name, l.accent, l.sort_order
        ORDER BY l.sort_order`
    );

    const never = await query(
      `SELECT COUNT(*) AS n FROM questions q
        WHERE q.is_active = 1 AND q.admin_hidden = 0
          AND NOT EXISTS (SELECT 1 FROM couple_question_status s WHERE s.question_id = q.id)`
    );

    res.json({
      minAnswers,
      neverAnswered: Number(never[0].n) || 0,
      worst: worst.map((r) => ({
        id: r.id,
        text: r.text,
        levelName: r.levelName,
        hidden: !!r.admin_hidden,
        answered: Number(r.answered),
        skipped: Number(r.skipped),
        skipRate: Math.round((Number(r.skipped) / Number(r.answered)) * 100),
      })),
      byLevel: byLevel.map((r) => ({
        name: r.name,
        accent: r.accent,
        answered: Number(r.answered) || 0,
        skipped: Number(r.skipped) || 0,
        skipRate: Number(r.answered) ? Math.round((Number(r.skipped) / Number(r.answered)) * 100) : 0,
      })),
    });
  })
);

owner.get(
  '/reports',
  wrap(async (req, res) => {
    const status = ['open', 'actioned', 'dismissed'].includes(String(req.query.status))
      ? req.query.status
      : 'open';
    const rows = await query(
      `SELECT r.id, r.reason, r.note, r.status, r.created_at,
              q.id AS questionId, q.text AS questionText, q.admin_hidden,
              l.name AS levelName, c.couple_name, u.display_name AS reporter
         FROM question_reports r
         JOIN questions q ON q.id = r.question_id
         JOIN domains l ON l.id = q.domain_id
         JOIN couples c ON c.id = r.couple_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = ?
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [status]
    );
    res.json({
      status,
      reports: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        note: r.note,
        status: r.status,
        createdAt: r.created_at,
        questionId: r.questionId,
        questionText: r.questionText,
        questionHidden: !!r.admin_hidden,
        levelName: r.levelName,
        coupleName: r.couple_name,
        reporter: r.reporter,
      })),
    });
  })
);

owner.patch(
  '/reports/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const status = ['open', 'actioned', 'dismissed'].includes(String(req.body.status))
      ? req.body.status
      : null;
    if (!status) return fail(res, 400, 'Status must be open, actioned or dismissed.');

    const report = await queryOne('SELECT id, question_id FROM question_reports WHERE id = ?', [id]);
    if (!report) return fail(res, 404, 'No such report.');

    // Hiding the question is the usual response to a report, so it is offered
    // in the same call rather than as a second thing to remember.
    if (req.body.hideQuestion !== undefined) {
      await query('UPDATE questions SET admin_hidden = ? WHERE id = ?', [
        req.body.hideQuestion ? 1 : 0,
        report.question_id,
      ]);
    }

    await query(
      'UPDATE question_reports SET status = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ?',
      [status, req.user.id, id]
    );
    await audit(req, `report.${status}`, { targetType: 'report', targetId: id });
    res.json({ ok: true });
  })
);

// ---- Audit log ------------------------------------------------------------

owner.get(
  '/audit',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT id, actor_email, action, target_type, target_id, target_label, detail, ip, created_at
         FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 300`
    );
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        actor: r.actor_email || 'deleted account',
        action: r.action,
        targetType: r.target_type,
        targetLabel: r.target_label,
        detail: r.detail,
        ip: r.ip,
        createdAt: r.created_at,
      })),
    });
  })
);

// ---- Branding -------------------------------------------------------------

owner.get(
  '/branding',
  wrap(async (req, res) => {
    res.json({ branding: await getBranding(), defaults: BRAND_DEFAULTS });
  })
);

owner.put(
  '/branding',
  wrap(async (req, res) => {
    const b = req.body || {};
    if (b.app_name !== undefined) {
      const v = String(b.app_name).trim().slice(0, 60);
      if (!v) return fail(res, 400, 'The app needs a name.');
      await setSetting('app_name', v);
    }
    if (b.app_tagline !== undefined) {
      await setSetting('app_tagline', String(b.app_tagline).trim().slice(0, 160));
    }
    if (b.brand_accent !== undefined) {
      const v = String(b.brand_accent).trim();
      if (!/^#[0-9a-f]{6}$/i.test(v)) return fail(res, 400, 'The accent must be a colour like #D8327C.');
      await setSetting('brand_accent', v);
    }
    if (b.brand_mark !== undefined) {
      // One or two characters: this sits in a 30px circle and anything longer
      // simply will not fit.
      await setSetting('brand_mark', [...String(b.brand_mark).trim()].slice(0, 2).join(''));
    }
    await audit(req, 'branding.update');
    res.json({ ok: true, branding: await getBranding() });
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
