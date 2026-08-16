'use strict';

/**
 * How a question landed, recorded against the QUESTION and nobody else.
 *
 * After a couple marks a card completed they are offered a short list - "brought
 * us closer", "not ready for this one", and so on. The answer is the only
 * feedback loop the corpus has: 850 questions were written from research and
 * judgement, and nothing until now has told anyone which of them actually work
 * in a living room.
 *
 * DELIBERATELY NOT LINKED TO THE COUPLE
 * -------------------------------------
 * There is no couple_id on `question_feedback` and there must never be one. The
 * app's whole promise is that two people can say something out loud to each
 * other and it goes no further; a table recording that Mark and Nikki said
 * "that one went badly" about a specific question breaks it completely, and it
 * would be the single most sensitive table in the database.
 *
 * The date, not a timestamp, for the same reason. Feedback rows written seconds
 * apart are obviously one sitting, and a sequence of those is a fingerprint -
 * with enough of them you could reassemble a couple's evening and re-attach it
 * to whoever redeemed a code that day. A DATE gives question development
 * everything it needs (counts, and roughly when) and takes the ordering away.
 *
 * The cost is real and worth stating: nothing can be corrected or withdrawn
 * afterwards, because nothing knows who sent it. That is the correct trade for
 * this app.
 *
 * OPTIONS AS ROWS, NOT AN ENUM
 * ----------------------------
 * Same reasoning that moved the depth ladder into a table: this is couple-facing
 * copy, and copy the owner cannot edit without a deploy is a mistake this
 * codebase has already made twice. Feedback points at the option by id, so
 * rewording "Good to talk about" keeps every historical answer attached to it.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

/**
 * The six, in the order they are shown.
 *
 * Not a satisfaction scale, and it should not be turned into one. The list
 * covers three different things a couple might report: that it went well, that
 * it went nowhere, and that it went somewhere hard. "Not ready for this one" is
 * not a bad review at all - it is a depth mismatch, and it is arguably the most
 * useful signal here, because it says the question is fine and is being dealt
 * too early.
 */
const SEED_OPTIONS = [
  { n: 1, label: 'Brought us closer' },
  { n: 2, label: 'Good to talk about' },
  { n: 3, label: 'Nothing much came of it' },
  { n: 4, label: 'Harder than we expected' },
  { n: 5, label: 'That one went badly' },
  { n: 6, label: 'Not ready for this one' },
];

async function hasTable(table) {
  return !!(await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [DB, table]
  ));
}

async function run() {
  const done = [];

  if (!(await hasTable('feedback_options'))) {
    await query(
      `CREATE TABLE feedback_options (
         id         INT AUTO_INCREMENT PRIMARY KEY,
         label      VARCHAR(120) NOT NULL,
         sort_order INT NOT NULL DEFAULT 0,
         is_active  TINYINT(1) NOT NULL DEFAULT 1,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('feedback_options created');
  }

  for (const o of SEED_OPTIONS) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await queryOne('SELECT id FROM feedback_options WHERE sort_order = ?', [o.n]);
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        'INSERT INTO feedback_options (label, sort_order, is_active) VALUES (?, ?, 1)',
        [o.label, o.n]
      );
    }
  }

  if (!(await hasTable('question_feedback'))) {
    await query(
      `CREATE TABLE question_feedback (
         id          INT AUTO_INCREMENT PRIMARY KEY,
         question_id INT NOT NULL,
         option_id   INT NOT NULL,
         -- DATE, not DATETIME. See the note at the top of this file: a
         -- timestamp would let a sitting be reassembled in order.
         recorded_on DATE NOT NULL,
         KEY idx_feedback_question (question_id),
         KEY idx_feedback_option (option_id),
         CONSTRAINT fk_feedback_question FOREIGN KEY (question_id)
           REFERENCES questions (id) ON DELETE CASCADE,
         -- RESTRICT, not CASCADE or SET NULL: deleting an option that has been
         -- answered would either destroy history or leave rows meaning nothing.
         -- Options are deactivated, never deleted.
         CONSTRAINT fk_feedback_option FOREIGN KEY (option_id)
           REFERENCES feedback_options (id) ON DELETE RESTRICT
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('question_feedback created');
  }

  return done.length ? done.join(', ') : 'already present';
}

module.exports = { run, SEED_OPTIONS };

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
