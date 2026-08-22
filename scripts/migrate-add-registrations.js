'use strict';

/**
 * Registration requests from the public /register page.
 *
 * There is no shop and no payment yet, so "register" cannot mean "buy". What it
 * means today is: two people ask for a code, the request lands in the admin, and
 * the owner issues one and sends it. That is a lead, not an account - the couple
 * still does not exist until a code is issued, and a code IS the couple.
 *
 * WHY A SEPARATE TABLE RATHER THAN A PENDING COUPLE
 * -------------------------------------------------
 * Writing straight into `couples` would mean every count, every deck query and
 * every "how many couples do we have" answer silently including people who have
 * never paid and may never be issued anything. A request that never becomes a
 * couple should leave no trace in the couples table.
 *
 * couple_id is filled in when a request is converted, so the link survives and
 * the admin can show "issued" against the row rather than losing the history.
 *
 * Idempotent.
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

async function run() {
  if (await hasTable('registrations')) return 'already present';

  // Superseded by migrate-merge-registrations, which folds this table into
  // `couples` and drops it. Without this check the pair would fight on every
  // deploy: this one recreating an empty table, that one dropping it again.
  //
  // Kept rather than deleted because a database that ran this before the merge
  // existed still needs the merge to find its rows, and deleting a migration
  // that has already run somewhere is how histories stop being reproducible.
  const merged = await queryOne(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'couples' AND COLUMN_NAME = 'code_status'`,
    [DB]
  );
  if (merged && String(merged.t).includes('requested')) return 'superseded by the merge';

  await query(
    `CREATE TABLE registrations (
       id          INT AUTO_INCREMENT PRIMARY KEY,
       partner_a   VARCHAR(60) NOT NULL,
       partner_b   VARCHAR(60) NOT NULL,
       email       VARCHAR(191) NOT NULL,
       note        VARCHAR(500) NULL,
       -- new     : nobody has looked at it yet
       -- issued  : a code was created from it, see couple_id
       -- declined: dealt with, no code, kept so it cannot be re-processed
       status      ENUM('new','issued','declined') NOT NULL DEFAULT 'new',
       couple_id   INT NULL,
       -- Kept for rate limiting and for spotting a flood from one source.
       ip          VARCHAR(64) NULL,
       created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       handled_at  DATETIME NULL,
       KEY idx_registrations_status (status, created_at),
       KEY idx_registrations_email (email),
       KEY fk_registrations_couple (couple_id),
       -- SET NULL, not CASCADE: if a couple is later deleted, the fact that
       -- somebody registered and was issued a code is still worth keeping.
       CONSTRAINT fk_registrations_couple FOREIGN KEY (couple_id)
         REFERENCES couples (id) ON DELETE SET NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  return 'registrations created';
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
