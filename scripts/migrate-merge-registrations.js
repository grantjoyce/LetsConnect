'use strict';

/**
 * Folds `registrations` into `couples`. One table, one status.
 *
 * v1.19.0 put registration requests in their own table, on the reasoning that a
 * request is not a couple and should not appear in counts of couples. That was
 * wrong in practice, and the admin screen showed why: two tables of the same
 * shape - who, email, when - sitting side by side, one of them squeezed into a
 * horizontal scrollbar, with a conversion step between them.
 *
 * The objection also did not survive the data. `couples` ALREADY contains rows
 * with no access_code - the ones that pre-date codes entirely - so "a couple
 * row without a code" was never a new idea, and exactly one query counts
 * couples, which now excludes the two pre-code statuses.
 *
 * The lifecycle is now one column:
 *
 *   requested  they asked, no code exists yet
 *   active     a code was issued and works
 *   suspended  the code exists but is refused - what a refund looks like
 *   declined   asked, answered no. Kept so it cannot quietly come back.
 *
 * Idempotent. Copies any existing requests across BEFORE dropping the old
 * table, and refuses to drop it if the copy did not account for every row.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

async function hasTable(table) {
  return !!(await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [DB, table]
  ));
}

async function hasColumn(table, column) {
  return !!(await queryOne(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB, table, column]
  ));
}

async function run() {
  const done = [];

  // 1. The status column has to be able to hold the new states first.
  const col = await queryOne(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'couples' AND COLUMN_NAME = 'code_status'`,
    [DB]
  );
  if (col && !String(col.t).includes('requested')) {
    await query(
      `ALTER TABLE couples MODIFY code_status
         ENUM('requested','active','suspended','declined') NOT NULL DEFAULT 'active'`
    );
    done.push('code_status extended');
  }

  // 2. The note somebody types on the registration form.
  if (!(await hasColumn('couples', 'signup_note'))) {
    await query('ALTER TABLE couples ADD COLUMN signup_note VARCHAR(500) NULL AFTER order_ref');
    done.push('signup_note added');
  }

  // 3. Move any requests across, then retire the old table.
  if (await hasTable('registrations')) {
    const pending = await query(
      "SELECT * FROM registrations WHERE status IN ('new','declined')"
    );

    let moved = 0;
    for (const r of pending) {
      // A couple row needs a shuffle seed even before it has a code - the deck
      // order is derived from it the moment one is issued.
      const seed = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO couples
           (access_code, partner_a, partner_b, buyer_email, signup_note,
            code_status, shuffle_seed, status, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          r.partner_a,
          r.partner_b,
          r.email,
          r.note,
          r.status === 'declined' ? 'declined' : 'requested',
          seed,
          r.created_at,
        ]
      );
      moved += 1;
    }

    // Rows already issued are not copied: they became couples at the time, and
    // copying them would create a second couple for the same people.
    const issued = await queryOne(
      "SELECT COUNT(*) n FROM registrations WHERE status = 'issued'"
    );
    const total = await queryOne('SELECT COUNT(*) n FROM registrations');

    if (moved + Number(issued.n) !== Number(total.n)) {
      throw new Error(
        `Refusing to drop registrations: ${total.n} rows, ${moved} moved, ${issued.n} already issued.`
      );
    }

    await query('DROP TABLE registrations');
    done.push(`registrations merged (${moved} moved, ${issued.n} already issued) and dropped`);
  }

  return done.length ? done.join(', ') : 'already merged';
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
