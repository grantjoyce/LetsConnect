'use strict';

/**
 * A phone number against the couple, so a code can be sent on WhatsApp.
 *
 * WHY A SECOND CONTACT FIELD RATHER THAN REUSING buyer_email
 * ----------------------------------------------------------
 * They are not interchangeable and they fail differently. An email address is
 * the one we already had, and it is what a shop order carries. A phone number
 * is what WhatsApp needs, and a great many people will give one and not the
 * other - a couple who registered from a phone will type a number faster and
 * more accurately than an address.
 *
 * Optional on purpose. Making it required would block a registration for the
 * sake of a delivery channel that is the owner's convenience, not the couple's
 * obligation, and the email path works without it.
 *
 * STORED AS TYPED, NOT NORMALISED
 * -------------------------------
 * VARCHAR(32) holds the international form with or without spaces, brackets or
 * a leading +. Normalising on the way in would mean guessing a country for a
 * bare "082..." and guessing wrong for anyone outside South Africa. The wa.me
 * link strips it to digits at the point of use, where the guess is visible and
 * correctable, rather than destroying what the person actually typed.
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

async function run() {
  if (await hasColumn('couples', 'buyer_phone')) return 'already present';

  await query(
    'ALTER TABLE couples ADD COLUMN buyer_phone VARCHAR(32) NULL AFTER buyer_email'
  );

  return 'added couples.buyer_phone';
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((summary) => {
      console.log(`✅ ${summary}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ migrate-add-buyer-phone failed:', err.message);
      process.exit(1);
    });
}
