'use strict';

/**
 * Restructures content around the corpus model: depth and domain as two
 * independent axes, plus volatility, context lines and chains.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * The old `levels` table was a single axis. Its seven rows each carried a name
 * AND a depth, so "Deep Waters" was simultaneously a subject and an exposure
 * level. The corpus is explicit that this was the mistake: it collapsed a mild
 * question about sexual timing and a question about whether the relationship
 * should end into the same bucket, because both merely felt risky.
 *
 * So:
 *   domains  - subject only (Sex, Money, Origin, ...). No depth.
 *   depth    - exposure only, 1-5, per question.
 *   volatile - a flag on the small set that can end a relationship in the
 *              wrong week, independent of both.
 *
 * A couple can now pick a subject and an exposure level separately, which is
 * the whole point: go deep on everything except sex, or discuss sex without
 * touching conflict.
 *
 * SCHEMA ONLY. This migration never touches content. Loading the corpus is
 * `npm run seed-corpus`, which is separate precisely because it is destructive
 * and should not run on every deploy.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

async function hasTable(name) {
  return !!(await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [DB, name]
  ));
}

async function hasColumn(table, column) {
  return !!(await queryOne(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB, table, column]
  ));
}

async function hasConstraint(table, name) {
  return !!(await queryOne(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [DB, table, name]
  ));
}

async function run() {
  const done = [];

  // ---- domains ------------------------------------------------------------
  if (!(await hasTable('domains'))) {
    await query(
      `CREATE TABLE domains (
         id          INT AUTO_INCREMENT PRIMARY KEY,
         slug        VARCHAR(60) NOT NULL,
         name        VARCHAR(100) NOT NULL,
         tagline     VARCHAR(180) NULL,
         description TEXT NULL,
         accent      VARCHAR(9) NOT NULL DEFAULT '#D8327C',
         sort_order  INT NOT NULL DEFAULT 0,
         is_active   TINYINT(1) NOT NULL DEFAULT 1,
         created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_domains_slug (slug)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('domains created');
  }

  // ---- chains -------------------------------------------------------------
  // A chain is a recommended running order over cards that circle the same
  // construct at increasing exposure. Every card still stands alone; the chain
  // only adds value when they are played in order.
  if (!(await hasTable('chains'))) {
    await query(
      `CREATE TABLE chains (
         id         INT AUTO_INCREMENT PRIMARY KEY,
         name       VARCHAR(60) NOT NULL,
         total      INT NOT NULL DEFAULT 0,
         min_depth  TINYINT NOT NULL DEFAULT 1,
         max_depth  TINYINT NOT NULL DEFAULT 1,
         domain_id  INT NULL,
         is_active  TINYINT(1) NOT NULL DEFAULT 1,
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         UNIQUE KEY uq_chains_name (name),
         KEY idx_chains_domain (domain_id),
         CONSTRAINT fk_chains_domain FOREIGN KEY (domain_id)
           REFERENCES domains (id) ON DELETE SET NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('chains created');
  }

  // ---- questions ----------------------------------------------------------
  const add = async (col, ddl) => {
    if (!(await hasColumn('questions', col))) {
      await query(`ALTER TABLE questions ADD COLUMN ${ddl}`);
      done.push(`questions.${col}`);
    }
  };

  await add('domain_id', 'domain_id INT NULL AFTER ref');
  await add('depth', 'depth TINYINT NOT NULL DEFAULT 1 AFTER domain_id');
  await add('lens', 'lens VARCHAR(3) NULL AFTER depth');
  await add('is_volatile', 'is_volatile TINYINT(1) NOT NULL DEFAULT 0 AFTER lens');
  // The helper line shown behind a tap. Opens the territory, never supplies an
  // answer - a helper that offers a sample answer anchors every couple to the
  // same reply and kills the question.
  await add('context', 'context VARCHAR(500) NULL AFTER text');
  await add('chain_id', 'chain_id INT NULL AFTER context');
  await add('chain_position', 'chain_position INT NULL AFTER chain_id');
  // Questions that fail the corpus's own construction rules are imported but
  // held back rather than dropped, so nothing authored is ever lost.
  await add('needs_review', 'needs_review TINYINT(1) NOT NULL DEFAULT 0');
  await add('review_note', 'review_note VARCHAR(255) NULL');

  if (!(await hasConstraint('questions', 'fk_questions_domain'))) {
    await query(
      `ALTER TABLE questions ADD CONSTRAINT fk_questions_domain
         FOREIGN KEY (domain_id) REFERENCES domains (id) ON DELETE CASCADE`
    );
    done.push('questions.domain_id FK');
  }
  if (!(await hasConstraint('questions', 'fk_questions_chain'))) {
    await query(
      `ALTER TABLE questions ADD CONSTRAINT fk_questions_chain
         FOREIGN KEY (chain_id) REFERENCES chains (id) ON DELETE SET NULL`
    );
    done.push('questions.chain_id FK');
  }

  const idx = await queryOne(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'questions' AND INDEX_NAME = 'idx_questions_axes'`,
    [DB]
  );
  if (!idx) {
    // The deck query filters on all four of these together.
    await query(
      'ALTER TABLE questions ADD INDEX idx_questions_axes (domain_id, depth, is_active, admin_hidden)'
    );
    done.push('questions axes index');
  }

  // ---- the old single-axis table -----------------------------------------
  // Retired rather than repurposed. A table called `levels` whose rows are now
  // subjects is exactly the sort of contradictory legacy naming that produces a
  // wrong query six months later.
  if (await hasTable('levels')) {
    if (await hasConstraint('questions', 'fk_questions_level')) {
      await query('ALTER TABLE questions DROP FOREIGN KEY fk_questions_level');
    }
    if (await hasColumn('questions', 'level_id')) {
      await query('ALTER TABLE questions DROP COLUMN level_id');
    }
    await query('DROP TABLE levels');
    done.push('levels retired');
  }

  // ---- volatility opt-in, per person --------------------------------------
  // Per MEMBER, not per couple: the unlock is only meaningful if both people
  // gave it separately. One partner must not be able to open the door on the
  // other's behalf.
  if (!(await hasColumn('couple_members', 'volatile_unlocked'))) {
    await query(
      'ALTER TABLE couple_members ADD COLUMN volatile_unlocked TINYINT(1) NOT NULL DEFAULT 0'
    );
    await query('ALTER TABLE couple_members ADD COLUMN volatile_unlocked_at DATETIME NULL');
    done.push('couple_members.volatile_unlocked');
  }

  // ---- chain sessions -----------------------------------------------------
  if (!(await hasTable('couple_chain_progress'))) {
    await query(
      `CREATE TABLE couple_chain_progress (
         id         INT AUTO_INCREMENT PRIMARY KEY,
         couple_id  INT NOT NULL,
         chain_id   INT NOT NULL,
         position   INT NOT NULL DEFAULT 0,
         status     ENUM('active','done','abandoned') NOT NULL DEFAULT 'active',
         started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_chain_progress (couple_id, chain_id),
         KEY idx_chain_progress_couple (couple_id, status),
         CONSTRAINT fk_chain_progress_couple FOREIGN KEY (couple_id)
           REFERENCES couples (id) ON DELETE CASCADE,
         CONSTRAINT fk_chain_progress_chain FOREIGN KEY (chain_id)
           REFERENCES chains (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('couple_chain_progress created');
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
