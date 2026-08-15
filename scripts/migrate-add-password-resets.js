'use strict';

/**
 * Adds the password_resets table, and a user_id column on sessions.
 *
 * PASSWORD RESETS
 * ---------------
 * Only a SHA-256 HASH of the token is stored, never the token itself. A
 * database dump therefore does not hand anybody a working reset link, which is
 * the same reasoning as hashing passwords - the difference being that a reset
 * token is a password for the next hour.
 *
 * Tokens are single-use (`used_at`) and time-limited (`expires_at`).
 *
 * SESSIONS.USER_ID
 * ----------------
 * The session store keeps its data as JSON, so "log this user out everywhere"
 * would otherwise mean a LIKE over that blob - which cannot distinguish
 * userId 5 from userId 50. A real column makes the delete exact.
 *
 * That matters specifically for password reset: if someone resets their
 * password because an attacker has their account, the reset MUST end the
 * attacker's existing session. Otherwise the reset changes the lock while the
 * intruder is still inside.
 *
 * Idempotent throughout.
 */

const { pool, query, queryOne } = require('../db');

async function run() {
  const dbName = process.env.DB_NAME || 'lets_connect';
  const done = [];

  const table = await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'password_resets'`,
    [dbName]
  );

  if (!table) {
    await query(
      `CREATE TABLE password_resets (
         id           INT AUTO_INCREMENT PRIMARY KEY,
         user_id      INT NOT NULL,
         token_hash   CHAR(64) NOT NULL,
         expires_at   DATETIME NOT NULL,
         used_at      DATETIME NULL,
         requested_ip VARCHAR(64) NULL,
         created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_password_resets_token (token_hash),
         KEY idx_password_resets_user (user_id, used_at),
         KEY idx_password_resets_expiry (expires_at),
         CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id)
           REFERENCES users (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('password_resets created');
  }

  // The sessions table is created by the app at boot, so on a database that has
  // never run the server it will not exist yet. That is fine - the store's own
  // init() creates it with the column already present.
  const sessionsTable = await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sessions'`,
    [dbName]
  );

  if (sessionsTable) {
    const col = await queryOne(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'user_id'`,
      [dbName]
    );
    if (!col) {
      await query('ALTER TABLE sessions ADD COLUMN user_id INT NULL');
      await query('ALTER TABLE sessions ADD INDEX idx_sessions_user (user_id)');
      done.push('sessions.user_id added');
    }
  }

  return done.length ? done.join(', ') : 'already present';
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((s) => {
      console.log(`✅ ${s}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
