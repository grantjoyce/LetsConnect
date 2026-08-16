'use strict';

/**
 * One code per couple, bought from the shop. No accounts, no pairing.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The app was built around two accounts that pair with an invite code and share
 * a progress record across two phones. That was the wrong shape: this is done
 * SITTING TOGETHER, one screen between two people, to get them talking. Two
 * logins, a pairing dance and a synchronisation story were solving a problem
 * the product does not have - and every one of them is a wall between buying it
 * and using it.
 *
 * The new shape is one field on the welcome screen: a code. Somebody buys it at
 * launchyourlife.co.za, it arrives by email, they type it in at
 * connect.launchyourlife.co.za, and the app says "Welcome Mark and Nikki"
 * because the shop recorded who bought it.
 *
 * THE COUPLE ROW IS THE LICENCE
 * -----------------------------
 * These columns go on `couples` rather than into a new `access_codes` table,
 * and that is deliberate. Every piece of progress in the database already hangs
 * off couples.id - couple_question_status, couple_chain_progress,
 * question_reports. A separate licence table would mean either a join on every
 * read or a second identity to keep in step with the first. A code IS a couple
 * here; there is no state where one exists without the other.
 *
 * NOTHING IS DROPPED
 * ------------------
 * `users`, `couple_members` and `password_resets` stay exactly as they are.
 * users is still the owner's sign-in for /admin, and password_resets still
 * serves it. couple_members is left alone rather than dropped: the app stops
 * writing to it, but a live database may hold rows describing who was paired
 * with whom, and throwing that away to tidy up a schema is not a trade worth
 * making. It can be dropped later, deliberately, once nothing has needed it.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

async function hasColumn(table, column) {
  return !!(await queryOne(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB, table, column]
  ));
}

async function hasIndex(table, name) {
  return !!(await queryOne(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [DB, table, name]
  ));
}

const COLUMNS = [
  // The code itself. Nullable because a couple created under the old pairing
  // flow has none, and because the UNIQUE index has to tolerate that.
  ['access_code', "VARCHAR(24) NULL AFTER id"],

  // Two names, separately, so the greeting can be built rather than parsed. A
  // single "Mark and Nikki" string would have to be split to say anything else
  // about either of them, and splitting names is how you end up greeting
  // somebody as "and".
  ['partner_a', 'VARCHAR(60) NULL AFTER couple_name'],
  ['partner_b', 'VARCHAR(60) NULL AFTER partner_a'],

  // Where it came from. The email is the buyer's, for resending a lost code;
  // order_ref is whatever the shop calls the sale, so a support question can be
  // answered without guessing.
  ['buyer_email', 'VARCHAR(191) NULL AFTER partner_b'],
  ['order_ref', 'VARCHAR(60) NULL AFTER buyer_email'],

  // suspended, not deleted: a refund or a chargeback needs to stop the code
  // working without erasing that it existed.
  ["code_status", "ENUM('active','suspended') NOT NULL DEFAULT 'active' AFTER order_ref"],

  ['issued_at', 'DATETIME NULL AFTER code_status'],
  // First redemption. The gap between issued and activated is the only measure
  // of "bought it and never used it" the app can have.
  ['activated_at', 'DATETIME NULL AFTER issued_at'],
  ['last_used_at', 'DATETIME NULL AFTER activated_at'],

  // Volatile questions were unlocked per person, because two accounts meant one
  // partner could otherwise open that door on the other's behalf. Sitting
  // together, that risk does not exist and the mechanism cannot work - there is
  // no second session to ask. It becomes one deliberate choice made in front of
  // both of them.
  ['volatile_unlocked', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER last_used_at'],
  ['volatile_unlocked_at', 'DATETIME NULL AFTER volatile_unlocked'],
];

async function run() {
  const added = [];

  for (const [name, ddl] of COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await hasColumn('couples', name))) {
      // eslint-disable-next-line no-await-in-loop
      await query(`ALTER TABLE couples ADD COLUMN ${name} ${ddl}`);
      added.push(name);
    }
  }

  if (!(await hasIndex('couples', 'uq_couples_access_code'))) {
    await query('ALTER TABLE couples ADD UNIQUE KEY uq_couples_access_code (access_code)');
    added.push('uq_couples_access_code');
  }

  // invite_code was NOT NULL and UNIQUE under the pairing model. Nothing issues
  // one now, so a new couple would have to invent a value to satisfy a column
  // it does not use. Made nullable rather than dropped - existing rows keep
  // their code, and dropping a column is not something a migration should do on
  // the way past.
  const invite = await queryOne(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'couples' AND COLUMN_NAME = 'invite_code'`,
    [DB]
  );
  if (invite && invite.IS_NULLABLE === 'NO') {
    await query('ALTER TABLE couples MODIFY COLUMN invite_code VARCHAR(12) NULL');
    added.push('invite_code now nullable');
  }

  return added.length ? added.join(', ') : 'already present';
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
