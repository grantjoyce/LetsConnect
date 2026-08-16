'use strict';

/**
 * Adds the `lenses` table - the framework each question was written against.
 *
 * The corpus groups its 850 questions into 16 blocks, each derived from one
 * authority's framework (GOT Gottman, PER Perel, NAG Nagoski, ...) or, for the
 * later blocks, from a subject with no authority behind it. `questions.lens`
 * already holds the three-letter code; this gives that code a name and a
 * description so a couple can tap it and find out what it means.
 *
 * A table rather than a lookup in corpus.json, because the descriptions are
 * couple-facing copy and the owner should be able to edit them without a
 * deploy - the same reasoning that put domains and questions in the database.
 *
 * Attribution runs to the LENS, never to a text. These describe a way of
 * looking at a relationship, not anybody's book.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

async function run() {
  const exists = await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lenses'`,
    [DB]
  );
  if (exists) return 'already present';

  await query(
    `CREATE TABLE lenses (
       id          INT AUTO_INCREMENT PRIMARY KEY,
       code        VARCHAR(3) NOT NULL,
       name        VARCHAR(100) NOT NULL,
       description TEXT NULL,
       sort_order  INT NOT NULL DEFAULT 0,
       is_active   TINYINT(1) NOT NULL DEFAULT 1,
       created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_lenses_code (code)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  // No foreign key from questions.lens on purpose. The column is a plain code
  // and a question whose lens has been renamed or removed must keep working -
  // the lens is provenance, not a dependency of being served.
  const idx = await queryOne(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'questions' AND INDEX_NAME = 'idx_questions_lens'`,
    [DB]
  );
  if (!idx) await query('ALTER TABLE questions ADD INDEX idx_questions_lens (lens)');

  return 'lenses created';
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
