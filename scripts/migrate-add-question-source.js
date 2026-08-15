'use strict';

/**
 * Adds `questions.source` and `questions.admin_hidden` - the two columns that
 * let an admin manage questions in the app without fighting the seeder.
 *
 * WHY `source` EXISTS
 * -------------------
 * data/catalogue.js is the source of truth for the 245 curated questions, and
 * the seed migration enforces that by deactivating anything in the database
 * that is not in the file. Without this column, the first question an admin
 * wrote in the UI would be silently switched off by the very next deploy -
 * the seeder would see a row with no matching ref and retire it.
 *
 * So each question declares who owns it:
 *   'catalogue' - the seeder manages it; edits belong in data/catalogue.js
 *   'admin'     - written in the app; the seeder must never touch it
 *
 * WHY `admin_hidden` EXISTS SEPARATELY FROM `is_active`
 * -----------------------------------------------------
 * `is_active` belongs to the seeder: it sets it back to 1 on any catalogue
 * question it finds switched off, because that is how a question retired in
 * the file and later restored comes back. So an admin who used `is_active` to
 * hide a curated question would find it quietly returning on the next deploy -
 * a change that appears to work, then silently undoes itself.
 *
 * `admin_hidden` is the admin's own switch. The seeder never reads or writes
 * it, so hiding a curated question survives every migrate. Both flags are
 * checked wherever questions are served.
 *
 * Idempotent: checks INFORMATION_SCHEMA before altering.
 */

const { pool, query, queryOne } = require('../db');

async function run() {
  const dbName = process.env.DB_NAME || 'lets_connect';

  const has = async (column) =>
    !!(await queryOne(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'questions' AND COLUMN_NAME = ?`,
      [dbName, column]
    ));

  const done = [];

  if (!(await has('source'))) {
    await query(
      `ALTER TABLE questions
         ADD COLUMN source ENUM('catalogue','admin') NOT NULL DEFAULT 'catalogue' AFTER level_id`
    );
    await query('ALTER TABLE questions ADD INDEX idx_questions_source (source)');

    // Everything that exists at this point came from the catalogue file, so the
    // DEFAULT is already right for every current row. Stated explicitly because
    // it is the assumption that makes this migration safe to run on live data.
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM questions WHERE source = 'catalogue'");
    done.push(`source added (${n} existing marked as catalogue)`);
  }

  if (!(await has('admin_hidden'))) {
    await query(
      'ALTER TABLE questions ADD COLUMN admin_hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active'
    );
    done.push('admin_hidden added');
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
