'use strict';

/**
 * Runs every migration, in order, stopping at the first failure.
 *
 * Safe to run after every deploy - each migration is idempotent and only acts
 * where something is missing.
 *
 * ---------------------------------------------------------------------------
 * EVERY schema change is registered in THREE places:
 *   1. the MIGRATIONS array below, in dependency order
 *   2. a "migrate-<name>" entry in package.json scripts
 *   3. the column mirrored by hand into schema.sql (the fresh-install DDL,
 *      which this script does NOT apply)
 *
 * Two guards exist because they catch different failures:
 *   - the REGISTRY GUARD (below) catches a migration that exists on disk but
 *     was never registered, so it silently never runs on production. It FAILS,
 *     before touching the database.
 *   - the DRIFT CHECKER (run at the end) catches step 3, which nothing else
 *     enforces. It only WARNS - a migration that did not run makes the app
 *     wrong now; schema.sql lagging only makes the next fresh install wrong.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIGRATIONS = [
  // Separates file-managed catalogue questions from admin-authored ones. MUST
  // run before the seeder, which reads `source` to decide what it may retire.
  'migrate-add-question-source',

  // Reset tokens, plus sessions.user_id so a reset can end existing sessions.
  'migrate-add-password-resets',

  // The master admin who runs the app, and signs in at /admin/.
  'migrate-add-owner-role',

  // Who did what in the admin area.
  'migrate-add-audit-log',

  // Couple-reported problems with a question. Also extends questions.source
  // with 'import', so it MUST run before anything that writes that value.
  'migrate-add-question-reports',

  // Depth and domain as independent axes, plus volatility, context and chains.
  // Retires the old single-axis `levels` table, so it MUST run before the seed.
  'migrate-corpus-model',

  // The framework each question was written against, so a card can show it.
  'migrate-add-lenses',

  // FIRST-RUN SEED ONLY. Does nothing at all on a database that already has
  // questions - content belongs to the admin area once it exists.
  'migrate-seed-corpus',
];

const SCRIPTS_DIR = __dirname;

/**
 * Registry guard. Fails loudly BEFORE connecting to the database.
 *
 * This exists because drift of exactly this kind has wiped a live view before:
 * a migration sat in scripts/ and in schema.sql but was never in the array, so
 * it never ran on production, and code that read the new columns errored.
 */
function assertRegistryIsHonest() {
  const onDisk = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith('migrate-') && f.endsWith('.js'))
    .filter((f) => f !== 'migrate-all.js')
    .map((f) => f.replace(/\.js$/, ''));

  const unregistered = onDisk.filter((n) => !MIGRATIONS.includes(n));
  const missing = MIGRATIONS.filter((n) => !onDisk.includes(n));

  if (unregistered.length || missing.length) {
    console.error('\n❌ Migration registry is out of step. Nothing has been run.\n');
    if (unregistered.length) {
      console.error('   On disk but NOT registered in MIGRATIONS:');
      unregistered.forEach((n) => console.error(`     - ${n}.js`));
      console.error('   These would silently never run on production.\n');
    }
    if (missing.length) {
      console.error('   Registered in MIGRATIONS but NOT on disk:');
      missing.forEach((n) => console.error(`     - ${n}.js`));
      console.error('');
    }
    console.error('   Fix scripts/migrate-all.js, then run again.\n');
    process.exit(1);
  }
}

/**
 * schema.sql drift check. Wrapped so a fault in the checker can never take a
 * deploy down, and never fails the run either way.
 */
function checkSchemaDrift() {
  try {
    const out = execFileSync(process.execPath, [path.join(SCRIPTS_DIR, 'check-schema.js')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.trim());
  } catch (err) {
    // A non-zero exit from the checker means it found drift, not that the
    // deploy failed. Its stdout still carries the report.
    const out = (err.stdout || '').trim();
    if (out) console.log(out);
    else console.log('ℹ Skipped the schema.sql check - it could not run. Nothing more.');
  }
}

async function main() {
  assertRegistryIsHonest();

  console.log(`Running ${MIGRATIONS.length} migration(s)...\n`);

  for (const name of MIGRATIONS) {
    process.stdout.write(`→ ${name} ... `);
    try {
      const mod = require(path.join(SCRIPTS_DIR, `${name}.js`));
      const summary = typeof mod.run === 'function' ? await mod.run() : null;
      console.log(summary ? `ok (${summary})` : 'ok');
    } catch (err) {
      console.log('FAILED');
      console.error(`\n❌ "${name}" failed - stopping.\n   ${err.message}\n`);
      process.exit(1);
    }
  }

  console.log('\n✅ All migrations complete - the database schema is up to date.\n');
  checkSchemaDrift();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ migrate failed:', err.message);
    process.exit(1);
  });
