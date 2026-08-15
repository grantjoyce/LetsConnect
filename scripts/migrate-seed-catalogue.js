'use strict';

/**
 * Seeds levels + questions from data/catalogue.js - ONCE, on an empty database.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING IT. THE BEHAVIOUR REVERSED IN v1.2.0.
 * ---------------------------------------------------------------------------
 * Until v1.2.0 this file was the source of truth: it upserted every question on
 * every deploy and retired anything whose ref had left the file. The admin area
 * now owns content - groups and questions are edited in the UI and imported
 * from spreadsheets - so that behaviour became actively destructive. A deploy
 * would have rewritten every question the owner had edited and switched off
 * every one they had added.
 *
 * So this is now a FIRST-RUN SEED and nothing more:
 *
 *   levels table empty  -> seed the seven levels
 *   questions empty     -> seed the 245 questions
 *   either has rows     -> do nothing at all, and say so
 *
 * It never updates, never retires, and never deletes. `npm run migrate` is safe
 * to run against a live database as many times as you like, and the only thing
 * it will do to content is nothing.
 *
 * CONSEQUENCE WORTH KNOWING: content now lives only in the database, which is
 * not in git. The Excel export in the admin area is the backup. Editing
 * data/catalogue.js after first run has no effect on an existing install - use
 * the import instead.
 * ---------------------------------------------------------------------------
 */

const { pool } = require('../db');
const { LEVELS, QUESTIONS } = require('../data/catalogue');

async function run() {
  const conn = await pool.getConnection();
  try {
    const [[levelCount]] = await conn.query('SELECT COUNT(*) AS n FROM levels');
    const [[questionCount]] = await conn.query('SELECT COUNT(*) AS n FROM questions');

    const hasLevels = Number(levelCount.n) > 0;
    const hasQuestions = Number(questionCount.n) > 0;

    if (hasLevels && hasQuestions) {
      return `skipped - content is owned by the admin area (${levelCount.n} groups, ${questionCount.n} questions)`;
    }

    await conn.beginTransaction();
    const done = [];
    const levelIdBySlug = new Map();

    if (!hasLevels) {
      for (let i = 0; i < LEVELS.length; i += 1) {
        const lv = LEVELS[i];
        const [res] = await conn.query(
          `INSERT INTO levels (slug, name, tagline, description, depth, accent, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [lv.slug, lv.name, lv.tagline, lv.description, lv.depth, lv.accent, i + 1]
        );
        levelIdBySlug.set(lv.slug, res.insertId);
      }
      done.push(`${LEVELS.length} groups seeded`);
    } else {
      const [rows] = await conn.query('SELECT id, slug FROM levels');
      rows.forEach((r) => levelIdBySlug.set(r.slug, r.id));
    }

    if (!hasQuestions) {
      let n = 0;
      for (const lv of LEVELS) {
        const levelId = levelIdBySlug.get(lv.slug);
        // A level the catalogue names but the database does not have. Only
        // reachable if someone seeded levels by hand; skip rather than crash.
        if (!levelId) continue;

        const rows = QUESTIONS[lv.slug] || [];
        for (let i = 0; i < rows.length; i += 1) {
          const [ref, text] = rows[i];
          await conn.query(
            `INSERT INTO questions (ref, level_id, source, text, sort_order, is_active, admin_hidden)
             VALUES (?, ?, 'catalogue', ?, ?, 1, 0)`,
            [ref, levelId, text, i + 1]
          );
          n += 1;
        }
      }
      done.push(`${n} questions seeded`);
    }

    await conn.commit();
    return done.join(', ');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((summary) => {
      console.log(`✅ ${summary}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Seed failed:', err.message);
      process.exit(1);
    });
}
