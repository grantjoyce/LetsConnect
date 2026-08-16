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
// Everything below requires a login
// ---------------------------------------------------------------------------

/** One bootstrap call: who I am, my couple, and every domain with my progress. */
app.get(
  '/api/data',
  requireAuth,
  wrap(async (req, res) => {
    const couple = await queryOne(
      `SELECT c.id, c.invite_code, c.couple_name, c.created_at, m.member_role,
              m.volatile_unlocked
         FROM couple_members m
         JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ? AND c.status = 'active'`,
      [req.user.id]
    );

    let members = [];
    let domains = [];
    let volatile = null;

    if (couple) {
      members = await query(
        `SELECT u.id, u.display_name, m.member_role, m.joined_at, m.volatile_unlocked
           FROM couple_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.couple_id = ?
          ORDER BY m.joined_at`,
        [couple.id]
      );
      domains = await domainsWithProgress(couple.id);

      const waitingOn = members.filter((m) => !m.volatile_unlocked).length;
      volatile = {
        // Both members, separately. A one-person couple can never unlock.
        unlocked: await volatileUnlocked(couple.id),
        mine: !!couple.volatile_unlocked,
        waitingOnPartner: !!couple.volatile_unlocked && waitingOn > 0,
        available: (
          await queryOne(
            "SELECT COUNT(*) AS n FROM questions WHERE is_volatile = 1 AND is_active = 1 AND admin_hidden = 0 AND needs_review = 0"
          )
        ).n,
      };
    }

    res.json({
      version: APP_VERSION,
      me: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.display_name,
        isAdmin: !!req.user.is_admin,
        isOwner: !!req.user.is_owner,
      },
      branding: await getBranding(),
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
              volatileUnlocked: !!m.volatile_unlocked,
            })),
          }
        : null,
      domains,
      volatile,
    });
  })
);

/**
 * Unlock, or re-lock, volatile questions for MYSELF only.
 *
 * Deliberately cannot be done on a partner's behalf. Re-locking takes effect
 * immediately for the couple, because withdrawing consent should never require
 * the other person's agreement.
 */
app.post(
  '/api/couple/volatile',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const on = !!req.body.unlocked;
    await query(
      `UPDATE couple_members
          SET volatile_unlocked = ?, volatile_unlocked_at = ${on ? 'NOW()' : 'NULL'}
        WHERE couple_id = ? AND user_id = ?`,
      [on ? 1 : 0, req.couple.id, req.user.id]
    );
    res.json({ ok: true, mine: on, unlocked: await volatileUnlocked(req.couple.id) });
  })
);

/**
 * Whether this couple may be served volatile questions.
 *
 * BOTH members must have unlocked, separately. A single-member couple can
 * never unlock: there is nobody to agree with, and the whole point of the gate
 * is that it is mutual. Returns false rather than throwing on a missing row.
 */
async function volatileUnlocked(coupleId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS members, SUM(volatile_unlocked) AS unlocked
       FROM couple_members WHERE couple_id = ?`,
    [coupleId]
  );
  const members = Number(row && row.members) || 0;
  const unlocked = Number(row && row.unlocked) || 0;
  return members >= 2 && unlocked >= members;
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
 * Parses a selection: which topics and which depths.
 *
 * Both are sets, because the couple chooses any number of each up front and
 * then plays a single shuffled deck drawn from all of it. An empty list means
 * "all", so a request with no selection still returns a usable deck rather
 * than an empty screen.
 */
function parseSelection(req, domainRows) {
  const bySlug = new Map(domainRows.map((d) => [d.slug, d]));

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
        .filter((d) => Number.isInteger(d) && d >= 1 && d <= 5)
    ),
  ].sort();

  return {
    slugs: chosen,
    ids: chosen.map((s) => bySlug.get(s).id),
    depths: depths.length ? depths : [1, 2, 3, 4, 5],
    unknown: wantedSlugs.filter((s) => !bySlug.has(s)),
  };
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
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const domainRows = await query(
      'SELECT id, slug, name, accent FROM domains WHERE is_active = 1 ORDER BY sort_order'
    );
    const sel = parseSelection(req, domainRows);
    if (!sel.ids.length) return fail(res, 400, 'Choose at least one topic.');

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
        chain: c.chain_id
          ? { id: c.chain_id, name: c.chain_name, position: c.chain_position, total: c.chain_total }
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
  requireAuth,
  wrap(async (req, res) => {
    const rows = await query(
      'SELECT code, name, description FROM lenses WHERE is_active = 1 ORDER BY sort_order'
    );
    res.json({ lenses: rows });
  })
);

// ---- Chains ---------------------------------------------------------------

/**
 * Chains available to this couple, with how far through each they are.
 *
 * A chain is offered only if it still has an unanswered card, so finished
 * chains drop off the list rather than sitting there as clutter.
 */
app.get(
  '/api/chains',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const allowVolatile = await volatileUnlocked(req.couple.id);
    const rows = await query(
      `SELECT ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth,
              d.slug AS domainSlug, d.name AS domainName, d.accent,
              COUNT(q.id) AS servable,
              SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              p.position AS position, p.status AS sessionStatus
         FROM chains ch
         LEFT JOIN domains d ON d.id = ch.domain_id
         LEFT JOIN questions q ON q.chain_id = ch.id AND ${servableWhere(allowVolatile)}
         LEFT JOIN couple_question_status s ON s.question_id = q.id AND s.couple_id = ?
         LEFT JOIN couple_chain_progress p ON p.chain_id = ch.id AND p.couple_id = ?
        WHERE ch.is_active = 1
        GROUP BY ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth,
                 d.slug, d.name, d.accent, p.position, p.status
       HAVING servable > 0
        ORDER BY d.sort_order, ch.name`,
      [req.couple.id, req.couple.id]
    );

    res.json({
      chains: rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          total: Number(r.servable),
          declaredTotal: Number(r.total),
          minDepth: Number(r.min_depth),
          maxDepth: Number(r.max_depth),
          domainSlug: r.domainSlug,
          domainName: r.domainName,
          accent: r.accent || '#D8327C',
          completed: Number(r.completed) || 0,
          position: r.position === null ? 0 : Number(r.position),
          sessionStatus: r.sessionStatus,
          // The corpus puts the consent gate at the transition into D4/D5
          // rather than at the start, so a couple opts in with a clear view of
          // where the arc is heading rather than blind at card one.
          gateAt: Number(r.max_depth) >= 4 ? 4 : null,
        }))
        .filter((c) => c.completed < c.total),
    });
  })
);

/** The ordered cards of one chain, with where the couple has got to. */
app.get(
  '/api/chains/:id',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne(
      `SELECT ch.id, ch.name, ch.total, ch.min_depth, ch.max_depth,
              d.slug AS domainSlug, d.name AS domainName, d.accent
         FROM chains ch LEFT JOIN domains d ON d.id = ch.domain_id
        WHERE ch.id = ? AND ch.is_active = 1`,
      [id]
    );
    if (!chain) return fail(res, 404, 'That sequence does not exist.');

    const allowVolatile = await volatileUnlocked(req.couple.id);
    const cards = await query(
      `SELECT q.id, q.ref, q.text, q.context, q.depth, q.is_volatile, q.chain_position,
              s.status AS prior_status
         FROM questions q
         LEFT JOIN couple_question_status s ON s.question_id = q.id AND s.couple_id = ?
        WHERE q.chain_id = ? AND ${servableWhere(allowVolatile)}
        ORDER BY q.chain_position`,
      [req.couple.id, id]
    );

    const progress = await queryOne(
      'SELECT position, status FROM couple_chain_progress WHERE couple_id = ? AND chain_id = ?',
      [req.couple.id, id]
    );

    res.json({
      chain: {
        id: chain.id,
        name: chain.name,
        total: cards.length,
        minDepth: Number(chain.min_depth),
        maxDepth: Number(chain.max_depth),
        domainSlug: chain.domainSlug,
        domainName: chain.domainName,
        accent: chain.accent || '#D8327C',
      },
      position: progress ? Number(progress.position) : 0,
      status: progress ? progress.status : null,
      cards: cards.map((c) => ({
        id: c.id,
        ref: c.ref,
        text: c.text,
        context: c.context,
        depth: c.depth,
        volatile: !!c.is_volatile,
        position: c.chain_position,
        seenBefore: !!c.prior_status,
      })),
    });
  })
);

/** Start, advance, or stop a chain session. */
app.post(
  '/api/chains/:id/progress',
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const chain = await queryOne('SELECT id FROM chains WHERE id = ?', [id]);
    if (!chain) return fail(res, 404, 'That sequence does not exist.');

    const position = Math.max(0, Number(req.body.position) || 0);
    const status = ['active', 'done', 'abandoned'].includes(String(req.body.status))
      ? req.body.status
      : 'active';

    await query(
      `INSERT INTO couple_chain_progress (couple_id, chain_id, position, status)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE position = VALUES(position), status = VALUES(status)`,
      [req.couple.id, id, position, status]
    );
    res.json({ ok: true });
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
      [req.couple.id, questionId, action, action === 'skipped' ? 1 : 0, req.user.id]
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
  requireAuth,
  requireCouple,
  wrap(async (req, res) => {
    const domainRows = await query('SELECT id, slug FROM domains WHERE is_active = 1');
    // The selection arrives in the body here, so reuse the parser by handing it
    // a query-shaped object rather than duplicating the parsing.
    const sel = parseSelection(
      { query: { domains: (req.body.domains || []).join(','), depths: (req.body.depths || []).join(',') } },
      domainRows
    );
    if (!sel.ids.length) return fail(res, 400, 'Choose at least one topic.');

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
  requireAuth,
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
      [questionId, req.couple.id, req.user.id, reason, note]
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
app.get(
  '/api/me/export',
  requireAuth,
  wrap(async (req, res) => {
    const user = await queryOne(
      'SELECT id, email, display_name, created_at, last_login_at FROM users WHERE id = ?',
      [req.user.id]
    );

    const couple = await queryOne(
      `SELECT c.id, c.couple_name, c.invite_code, c.created_at, m.member_role, m.joined_at
         FROM couple_members m JOIN couples c ON c.id = m.couple_id
        WHERE m.user_id = ?`,
      [req.user.id]
    );

    let progress = [];
    let partners = [];
    if (couple) {
      progress = await query(
        `SELECT q.text, l.name AS level, s.status, s.decided_at,
                s.decided_by_user_id = ? AS decidedByMe
           FROM couple_question_status s
           JOIN questions q ON q.id = s.question_id
           JOIN domains l ON l.id = q.domain_id
          WHERE s.couple_id = ?
          ORDER BY s.decided_at`,
        [req.user.id, couple.id]
      );
      partners = await query(
        `SELECT u.display_name FROM couple_members m JOIN users u ON u.id = m.user_id
          WHERE m.couple_id = ? AND m.user_id <> ?`,
        [couple.id, req.user.id]
      );
    }

    const reports = await query(
      `SELECT q.text AS question, r.reason, r.note, r.created_at
         FROM question_reports r JOIN questions q ON q.id = r.question_id
        WHERE r.user_id = ?`,
      [req.user.id]
    );

    res.set('Content-Disposition', 'attachment; filename="lets-connect-my-data.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      note:
        'This app never records your answers - only whether a question was marked ' +
        'discussed or skipped. Progress below is shared with your partner.',
      account: user,
      couple: couple
        ? {
            name: couple.couple_name,
            inviteCode: couple.invite_code,
            yourRole: couple.member_role,
            joinedAt: couple.joined_at,
            partner: partners.map((p) => p.display_name),
          }
        : null,
      progress,
      reportsYouSent: reports,
    });
  })
);

/**
 * Delete this account outright - the right-to-erasure half.
 *
 * Requires the current password. Deletion is irreversible and an unauthenticated
 * session hijack should not be able to destroy somebody's account, so this asks
 * for the one thing an attacker holding a stolen cookie does not have.
 *
 * Shared progress belongs to the COUPLE, not the person, so it is deliberately
 * left behind: erasing it would silently delete the other partner's history
 * too, which is somebody else's data. Once the last member leaves, the couple
 * is marked dissolved and nothing identifies anyone.
 */
app.post(
  '/api/me/delete',
  requireAuth,
  wrap(async (req, res) => {
    const password = String(req.body.password || '');
    const row = await queryOne('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const ok = row && (await bcrypt.compare(password, row.password_hash));
    if (!ok) return fail(res, 401, 'That password is not right.');

    const owners = await queryOne(
      'SELECT COUNT(*) AS n FROM users WHERE is_owner = 1 AND is_active = 1 AND id <> ?',
      [req.user.id]
    );
    if (req.user.is_owner && Number(owners.n) === 0) {
      return fail(
        res,
        400,
        'You own this app and are the only owner. Make somebody else an owner before deleting your account.'
      );
    }

    const membership = await queryOne(
      'SELECT couple_id FROM couple_members WHERE user_id = ?',
      [req.user.id]
    );

    await audit(req, 'account.delete', {
      targetType: 'user',
      targetId: req.user.id,
      targetLabel: req.user.email,
      detail: 'self-service deletion',
    });

    // Sessions carry no foreign key, so they need removing by hand.
    await query('DELETE FROM sessions WHERE user_id = ?', [req.user.id]);
    await query('DELETE FROM users WHERE id = ?', [req.user.id]);

    if (membership) {
      const left = await queryOne('SELECT COUNT(*) AS n FROM couple_members WHERE couple_id = ?', [
        membership.couple_id,
      ]);
      if (Number(left.n) === 0) {
        await query("UPDATE couples SET status = 'dissolved' WHERE id = ?", [membership.couple_id]);
      }
    }

    if (req.session) req.session.destroy(() => {});
    res.json({ ok: true });
  })
);

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

owner.get(
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

    const depth = Math.min(5, Math.max(1, Number(req.body.depth) || 2));
    const context = String(req.body.context || '').trim().slice(0, 500) || null;
    const isVolatile = !!req.body.volatile;

    // Admin refs are namespaced so they can never collide with a corpus ref,
    // present or future.
    const ref = `adm-${crypto.randomBytes(6).toString('hex')}`;
    const [{ n }] = await query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM questions WHERE domain_id = ?',
      [level.id]
    );

    const result = await query(
      `INSERT INTO questions
         (ref, domain_id, depth, is_volatile, source, text, context, sort_order,
          is_active, admin_hidden)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, 1, 0)`,
      [ref, level.id, depth, isVolatile ? 1 : 0, text, context, n]
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
      if (!Number.isInteger(depth) || depth < 1 || depth > 5) {
        return fail(res, 400, 'Depth must be between 1 and 5.');
      }
      await query('UPDATE questions SET depth = ? WHERE id = ?', [depth, id]);
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

owner.get(
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
