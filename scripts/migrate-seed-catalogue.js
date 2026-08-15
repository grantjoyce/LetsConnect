'use strict';

/**
 * Syncs levels + questions from data/catalogue.js into the database.
 *
 * Idempotent and safe to run on every deploy. Matching is on the stable keys
 * (`levels.slug`, `questions.ref`), so:
 *
 *   - a new entry is INSERTed
 *   - an existing entry has its text/metadata UPDATEd, keeping its id, and
 *     therefore keeping every couple's progress against it
 *   - an entry removed from the catalogue is DEACTIVATED (is_active = 0), never
 *     deleted, so progress rows and history always still point at something
 *   - a previously-retired ref that reappears is reactivated
 *
 * Deactivating rather than deleting is the whole reason progress survives
 * content edits. Do not "tidy" it into a DELETE.
 *
 * SCOPE: this seeder owns `source = 'catalogue'` rows ONLY. Questions written
 * by an admin in the app carry source = 'admin' and are invisible to every
 * query here. Without that split, the retire step below would see an
 * admin-authored question, find no matching ref in the file, and switch it off
 * on the very next deploy.
 */

const { pool } = require('../db');
const { LEVELS, QUESTIONS } = require('../data/catalogue');

async function run() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ---- Levels -----------------------------------------------------------
    let levelsAdded = 0;
    const levelIdBySlug = new Map();

    for (let i = 0; i < LEVELS.length; i += 1) {
      const lv = LEVELS[i];
      const [existing] = await conn.query('SELECT id FROM levels WHERE slug = ?', [lv.slug]);

      if (existing.length) {
        await conn.query(
          `UPDATE levels
              SET name = ?, tagline = ?, description = ?, depth = ?,
                  accent = ?, sort_order = ?, is_active = 1
            WHERE id = ?`,
          [lv.name, lv.tagline, lv.description, lv.depth, lv.accent, i + 1, existing[0].id]
        );
        levelIdBySlug.set(lv.slug, existing[0].id);
      } else {
        const [res] = await conn.query(
          `INSERT INTO levels (slug, name, tagline, description, depth, accent, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [lv.slug, lv.name, lv.tagline, lv.description, lv.depth, lv.accent, i + 1]
        );
        levelIdBySlug.set(lv.slug, res.insertId);
        levelsAdded += 1;
      }
    }

    const keptSlugs = LEVELS.map((l) => l.slug);
    if (keptSlugs.length) {
      await conn.query(
        `UPDATE levels SET is_active = 0
          WHERE slug NOT IN (${keptSlugs.map(() => '?').join(',')})`,
        keptSlugs
      );
    }

    // ---- Questions --------------------------------------------------------
    let added = 0;
    let updated = 0;
    const keptRefs = [];

    for (const lv of LEVELS) {
      const levelId = levelIdBySlug.get(lv.slug);
      const rows = QUESTIONS[lv.slug] || [];

      for (let i = 0; i < rows.length; i += 1) {
        const [ref, text] = rows[i];
        keptRefs.push(ref);

        const [existing] = await conn.query(
          'SELECT id, text, level_id, sort_order, is_active FROM questions WHERE ref = ?',
          [ref]
        );

        if (existing.length) {
          const q = existing[0];
          const changed =
            q.text !== text ||
            q.level_id !== levelId ||
            q.sort_order !== i + 1 ||
            q.is_active !== 1;
          if (changed) {
            await conn.query(
              `UPDATE questions
                  SET text = ?, level_id = ?, sort_order = ?, is_active = 1,
                      source = 'catalogue'
                WHERE id = ?`,
              [text, levelId, i + 1, q.id]
            );
            updated += 1;
          }
        } else {
          await conn.query(
            `INSERT INTO questions (ref, level_id, text, sort_order, is_active, source)
             VALUES (?, ?, ?, ?, 1, 'catalogue')`,
            [ref, levelId, text, i + 1]
          );
          added += 1;
        }
      }
    }

    // Retire catalogue questions that have left the file. Scoped to
    // source = 'catalogue' so admin-authored questions are never caught by it.
    let retired = 0;
    if (keptRefs.length) {
      const [res] = await conn.query(
        `UPDATE questions SET is_active = 0
          WHERE is_active = 1 AND source = 'catalogue'
            AND ref NOT IN (${keptRefs.map(() => '?').join(',')})`,
        keptRefs
      );
      retired = res.affectedRows || 0;
    }

    await conn.commit();

    const parts = [];
    if (levelsAdded) parts.push(`${levelsAdded} new level(s)`);
    parts.push(`${keptRefs.length} questions in catalogue`);
    if (added) parts.push(`${added} added`);
    if (updated) parts.push(`${updated} reworded`);
    if (retired) parts.push(`${retired} retired`);
    return parts.join(', ');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { run };

// Allow running standalone: npm run migrate-seed-catalogue
if (require.main === module) {
  run()
    .then((summary) => {
      console.log(`✅ Catalogue synced - ${summary}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Catalogue sync failed:', err.message);
      process.exit(1);
    });
}
