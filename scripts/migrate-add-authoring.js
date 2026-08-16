'use strict';

/**
 * Question development: depths as data, authors on lenses, and a draft queue.
 *
 * Three related changes, one migration, because they only make sense together.
 *
 * 1. `depths`
 *    D1..D5 were hard-coded in public/app.js. That made the ladder the one
 *    piece of couple-facing copy the owner could not edit without a deploy,
 *    which is the same mistake the domains and questions already had corrected.
 *    The rungs are now rows. Seeded with exactly the five that were in the
 *    code, so nothing a couple sees changes on the day this runs.
 *
 * 2. `lenses.author` / `lenses.brief`
 *    The lens already carried couple-facing copy (`description`). Generating a
 *    question to a framework needs something different: whose framework it is,
 *    and what that framework actually interrogates - written for a model, not
 *    for someone holding a phone. Two audiences, two columns. Collapsing them
 *    would mean either the couple reads a construct list or the generator reads
 *    marketing copy.
 *
 * 3. `question_drafts`
 *    Generated questions land here, never straight into `questions`. A model
 *    asked for a standalone, open, non-binary question returns a REQUEST for
 *    one, not a guarantee - so every candidate is put through the same
 *    construction rules the corpus build applies, and then in front of a human,
 *    before it can ever be dealt to a couple.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

const DB = process.env.DB_NAME || 'lets_connect';

/** Exactly the five rungs that were hard-coded in public/app.js. */
const SEED_DEPTHS = [
  {
    n: 1,
    name: 'Open',
    blurb: 'Answerable straight away. Nothing at stake.',
    description:
      'Anyone could answer these on a first date. They cost nothing to say out loud, '
      + 'which is the point: they get you talking without either of you having to decide '
      + 'how honest to be.',
  },
  {
    n: 2,
    name: 'Reflective',
    blurb: 'Needs a moment’s thought. Mild disclosure.',
    description:
      'You have to actually think before answering, and the answer says something small '
      + 'about you. Still safe ground, but no longer small talk.',
  },
  {
    n: 3,
    name: 'Personal',
    blurb: 'Real disclosure. Assumes you already trust each other.',
    description:
      'These assume you are past proving yourselves to each other. Answering honestly '
      + 'tells your partner something they could not have worked out on their own.',
  },
  {
    n: 4,
    name: 'Exposed',
    blurb: 'Shame, fear, unmet need. Give it proper time.',
    description:
      'Shame, fear, and the things you have wanted and not asked for. Do not open these '
      + 'in the ten minutes before bed. They need room, and they need both of you willing '
      + 'to hear the answer rather than manage it.',
  },
  {
    n: 5,
    // Renamed from "Rupture". Rupture named the DAMAGE; Unspoken names the
    // thing itself - what has never been said out loud. The second is what the
    // rung actually holds, and it invites an answer where the first warned
    // against one.
    name: 'Unspoken',
    blurb: 'The things neither of you has ever said out loud.',
    description:
      'The ones that have never been said. An honest answer here cannot be unheard, and '
      + 'that is exactly why they exist - but reach for them because you have both chosen '
      + 'to, not because the app offered them.',
  },
];

async function hasColumn(table, column) {
  return !!(await queryOne(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB, table, column]
  ));
}

async function hasTable(table) {
  return !!(await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [DB, table]
  ));
}

async function run() {
  const done = [];

  // ---- depths -------------------------------------------------------------
  if (!(await hasTable('depths'))) {
    await query(
      `CREATE TABLE depths (
         id          INT AUTO_INCREMENT PRIMARY KEY,
         n           TINYINT NOT NULL,
         name        VARCHAR(60) NOT NULL,
         blurb       VARCHAR(200) NULL,
         description TEXT NULL,
         sort_order  INT NOT NULL DEFAULT 0,
         is_active   TINYINT(1) NOT NULL DEFAULT 1,
         created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         UNIQUE KEY uq_depths_n (n)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('depths created');
  }

  // Upsert rather than insert-if-empty, and never overwrite a name or blurb the
  // owner has already edited - the same reasoning as the lens seeding, which had
  // to be moved above seed-corpus's early return for exactly this.
  for (const d of SEED_DEPTHS) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await queryOne('SELECT id FROM depths WHERE n = ?', [d.n]);
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO depths (n, name, blurb, description, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [d.n, d.name, d.blurb, d.description, d.n]
      );
    }
  }

  // ---- lenses: the authoring half ----------------------------------------
  if (await hasTable('lenses')) {
    if (!(await hasColumn('lenses', 'author'))) {
      await query('ALTER TABLE lenses ADD COLUMN author VARCHAR(120) NULL AFTER name');
      done.push('lenses.author');
    }
    if (!(await hasColumn('lenses', 'brief'))) {
      await query('ALTER TABLE lenses ADD COLUMN brief TEXT NULL AFTER description');
      done.push('lenses.brief');
    }
  }

  // ---- question_drafts ----------------------------------------------------
  if (!(await hasTable('question_drafts'))) {
    await query(
      `CREATE TABLE question_drafts (
         id           INT AUTO_INCREMENT PRIMARY KEY,
         batch        VARCHAR(40) NOT NULL,
         lens         VARCHAR(3) NULL,
         domain_id    INT NULL,
         depth        TINYINT NOT NULL DEFAULT 2,
         text         TEXT NOT NULL,
         context      VARCHAR(500) NULL,
         is_volatile  TINYINT(1) NOT NULL DEFAULT 0,
         verdict      ENUM('ok','review','rejected') NOT NULL DEFAULT 'ok',
         issues       VARCHAR(500) NULL,
         status       ENUM('pending','accepted','discarded') NOT NULL DEFAULT 'pending',
         question_id  INT NULL,
         model        VARCHAR(60) NULL,
         created_by   INT NULL,
         created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         reviewed_at  DATETIME NULL,
         KEY idx_drafts_status (status, created_at),
         KEY idx_drafts_batch (batch),
         KEY fk_drafts_domain (domain_id),
         KEY fk_drafts_question (question_id),
         KEY fk_drafts_user (created_by),
         CONSTRAINT fk_drafts_domain FOREIGN KEY (domain_id)
           REFERENCES domains (id) ON DELETE SET NULL,
         -- SET NULL, not CASCADE: if an accepted question is later deleted, the
         -- record that it was generated and reviewed is still worth keeping.
         CONSTRAINT fk_drafts_question FOREIGN KEY (question_id)
           REFERENCES questions (id) ON DELETE SET NULL,
         CONSTRAINT fk_drafts_user FOREIGN KEY (created_by)
           REFERENCES users (id) ON DELETE SET NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    done.push('question_drafts created');
  }

  return done.length ? done.join(', ') : 'already present';
}

module.exports = { run, SEED_DEPTHS };

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
