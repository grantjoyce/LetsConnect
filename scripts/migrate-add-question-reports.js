'use strict';

/**
 * Adds question_reports, and extends questions.source to allow 'import'.
 *
 * REPORTS ARE THE ONLY QUALITY SIGNAL THAT CARRIES WORDS
 * -----------------------------------------------------
 * The app deliberately stores no answers, so the only things it can learn from
 * are the skip rate (a number) and a report (a reason). That makes the note
 * field the single most valuable content-quality input the owner will ever get,
 * which is why a report carries a free-text note as well as a category.
 *
 * A report is tied to the couple, not just the person, so the same couple
 * cannot lodge the same complaint twice from two phones - UNIQUE(question_id,
 * couple_id).
 *
 * user_id is ON DELETE SET NULL so a report survives its author deleting their
 * account: the content problem is still real once the reporter has gone.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

async function run() {
  const dbName = process.env.DB_NAME || 'lets_connect';
  const done = [];

  const table = await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'question_reports'`,
    [dbName]
  );

  if (!table) {
    await query(
      `CREATE TABLE question_reports (
         id           INT AUTO_INCREMENT PRIMARY KEY,
         question_id  INT NOT NULL,
         couple_id    INT NOT NULL,
         user_id      INT NULL,
         reason       ENUM('unclear','upsetting','inappropriate','duplicate','other')
                        NOT NULL DEFAULT 'other',
         note         VARCHAR(500) NULL,
         status       ENUM('open','actioned','dismissed') NOT NULL DEFAULT 'open',
         created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         reviewed_at  DATETIME NULL,
         reviewed_by  INT NULL,
         UNIQUE KEY uq_report_question_couple (question_id, couple_id),
         KEY idx_reports_status (status, created_at),
         CONSTRAINT fk_reports_question FOREIGN KEY (question_id)
           REFERENCES questions (id) ON DELETE CASCADE,
         CONSTRAINT fk_reports_couple FOREIGN KEY (couple_id)
           REFERENCES couples (id) ON DELETE CASCADE,
         CONSTRAINT fk_reports_user FOREIGN KEY (user_id)
           REFERENCES users (id) ON DELETE SET NULL,
         CONSTRAINT fk_reports_reviewer FOREIGN KEY (reviewed_by)
           REFERENCES users (id) ON DELETE SET NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('question_reports created');
  }

  // Spreadsheet-imported questions are worth telling apart from ones typed in
  // the admin screen - it is the difference between "I wrote this" and "this
  // arrived in a batch of 300" when you are trying to work out where a bad
  // question came from.
  const col = await queryOne(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'source'`,
    [dbName]
  );
  if (col && !String(col.COLUMN_TYPE).includes("'import'")) {
    await query(
      `ALTER TABLE questions
         MODIFY COLUMN source ENUM('catalogue','admin','import')
         NOT NULL DEFAULT 'catalogue'`
    );
    done.push("source extended with 'import'");
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
