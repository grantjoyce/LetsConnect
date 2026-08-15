'use strict';

/**
 * First-run seed of the question corpus.
 *
 * Runs as part of `npm run migrate` so a fresh install comes up with content.
 * On any database that already has questions it does nothing at all - content
 * belongs to the admin area once it exists, and a deploy must never overwrite
 * edits made in the app.
 *
 * Rebuilding deliberately lives elsewhere:
 *   npm run seed-corpus -- --replace
 * because it destroys every couple's progress and should never be something a
 * deploy can do by itself.
 */

const { run: seed } = require('./seed-corpus');

async function run() {
  return seed({ replace: false });
}

module.exports = { run };

if (require.main === module) {
  const { pool } = require('../db');
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
