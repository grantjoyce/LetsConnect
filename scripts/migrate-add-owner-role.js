'use strict';

/**
 * Adds `users.is_owner` - the master admin who runs the whole app.
 *
 * WHY A SECOND FLAG RATHER THAN REUSING is_admin
 * ----------------------------------------------
 * `is_admin` is left in place and is NOT dropped. Dropping a column that a
 * running release still selects is how a deploy takes the app down between the
 * pull and the restart, and there is no way to get the data back if the call
 * was wrong. It costs nothing to keep.
 *
 * Every existing admin becomes an owner, so nobody loses access across this
 * release - the account that could reach the old in-app Admin area is exactly
 * the account that can now sign in at /admin/.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

async function run() {
  const dbName = process.env.DB_NAME || 'lets_connect';
  const done = [];

  const col = await queryOne(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_owner'`,
    [dbName]
  );

  if (!col) {
    await query(
      'ALTER TABLE users ADD COLUMN is_owner TINYINT(1) NOT NULL DEFAULT 0 AFTER is_admin'
    );
    const res = await query('UPDATE users SET is_owner = 1 WHERE is_admin = 1');
    done.push(`is_owner added, ${res.affectedRows || 0} existing admin(s) promoted to owner`);
  }

  // A fresh install has nobody at all. The FIRST account to register becomes
  // the owner (handled in server.js), so this only matters for databases that
  // already had users before this release.
  const owners = await queryOne('SELECT COUNT(*) AS n FROM users WHERE is_owner = 1');
  const anyUser = await queryOne('SELECT COUNT(*) AS n FROM users');
  if (Number(anyUser.n) > 0 && Number(owners.n) === 0) {
    // Users exist but none is an owner - promote the earliest account rather
    // than leaving an install with no way into /admin/ at all.
    await query('UPDATE users SET is_owner = 1, is_admin = 1 ORDER BY id LIMIT 1');
    done.push('no owner existed - promoted the oldest account');
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
