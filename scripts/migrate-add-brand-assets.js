'use strict';

/**
 * Room in `settings` for a logo and a favicon.
 *
 * WHY THE DATABASE AND NOT THE DISK
 * ----------------------------------
 * The obvious home for an uploaded image is `uploads/` on disk. Here that is
 * the wrong call, for the same reason the Anthropic key lives in `settings`
 * rather than `.env`:
 *
 *   - `uploads/` is gitignored, so it is not in the repo and not in any deploy.
 *     Moving the app to another host silently loses the branding.
 *   - Plesk serves `public/` as the document root. Writing images into the
 *     served tree means the app's own upload path and nginx's static path have
 *     to agree, and they are configured in different places.
 *   - A favicon and a logo are small and change about once a year. They are
 *     configuration, and this app already has a place for configuration that
 *     survives every redeploy.
 *
 * So they are stored base64 in `settings` and served by a route that sets the
 * content type. The cost is that `setting_value` is TEXT, which tops out at
 * 65,535 BYTES - about a 48KB image once base64 expands it by a third. That is
 * too small for a logo, and the failure mode is silent truncation into a
 * corrupt image rather than an error.
 *
 * MEDIUMTEXT gives 16MB. The route limits are far below that (512KB logo,
 * 128KB favicon), so the column is never the thing that says no.
 *
 * Idempotent: checks the current type first and does nothing if it is already
 * MEDIUMTEXT or larger.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

async function run() {
  const col = await queryOne(
    `SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'setting_value'`,
    [DB]
  );

  if (!col) {
    // The table is created by schema.sql / init-db. If it is not here, this
    // migration has nothing to widen and should not invent the table.
    return 'settings table not present - nothing to do';
  }

  const type = String(col.DATA_TYPE).toLowerCase();
  if (type === 'mediumtext' || type === 'longtext') return 'already wide enough';

  await query('ALTER TABLE settings MODIFY setting_value MEDIUMTEXT NULL');
  return 'settings.setting_value widened to MEDIUMTEXT';
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
