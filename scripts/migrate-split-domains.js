'use strict';

/**
 * Eight topics back to the corpus's eleven.
 *
 * An earlier build folded four of the corpus's subjects away: Home, Work and
 * Social into an "Everyday" bucket, and Meaning into Self. That was wrong.
 * A subject with four questions is a thin subject, not a subject that belongs
 * inside another one, and merging Meaning into Self quietly told a couple that
 * "what am I for" is the same question as "who am I".
 *
 * WHY THIS IS SAFE
 * ----------------
 * Progress is keyed on QUESTION, not on topic: couple_question_status holds
 * (couple_id, question_id). Moving a question from one topic to another does
 * not touch a single row of it. A couple who discussed a Work question under
 * "Everyday" has still discussed that exact question, and it stays retired.
 *
 * That is the whole reason this can be a migration rather than
 * `seed-corpus --replace`, which would delete every question and take every
 * couple's history with it by cascade.
 *
 * HOW A QUESTION FINDS ITS REAL TOPIC
 * -----------------------------------
 * From data/corpus.json, matched on `ref`. The ref is stable and unique, and
 * the corpus is the source of truth for what subject a question belongs to -
 * which is exactly the thing the fold discarded.
 *
 * Questions with no corpus entry - anything written in the admin area, and
 * anything the generator produced - are left exactly where they are. Their
 * topic was chosen by a person and this has no business overriding it.
 *
 * Idempotent: re-running moves nothing, because everything already sits where
 * the corpus says it should.
 */

const fs = require('fs');
const path = require('path');
const { pool, query, queryOne } = require('../db');

const CORPUS = path.join(__dirname, '..', 'data', 'corpus.json');

/** Matches DOMAIN_PRESENTATION in seed-corpus.js. */
const RESTORE = {
  Home: {
    tagline: 'The place you actually live in',
    description:
      'Space, chores, rest, and the invisible work of running a life together. Unglamorous, and the source of most ordinary friction.',
    accent: '#35B7A6',
    order: 4,
  },
  Work: {
    tagline: 'What it takes, and what it costs the two of you',
    description:
      'Ambition, identity tied to a job, and the hours that never make it home. Whose career is being deferred, and whether that was ever agreed out loud.',
    accent: '#C98A2E',
    order: 5,
  },
  Social: {
    tagline: 'Everyone else in your life',
    description:
      'Friends, family and the people you are a couple in front of. Who gets your time, who you defend, and who you have quietly stopped seeing.',
    accent: '#4FB0C6',
    order: 6,
  },
  Meaning: {
    tagline: 'What the two of you are for',
    description:
      'Purpose, mortality, and what you want this to have added up to. The smallest set here by a distance — four questions — and the one most worth adding to.',
    accent: '#A88BD4',
    order: 11,
  },
};

/** Order for the eleven, so the list reads light to heavy. */
const ORDER = ['Self', 'Attachment', 'Origin', 'Home', 'Work', 'Social', 'Money', 'Future', 'Sex', 'Conflict', 'Meaning'];

function slugify(v) {
  return String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function run() {
  if (!fs.existsSync(CORPUS)) {
    // Not a failure. A fresh install seeds from the corpus directly and has
    // nothing to split; only a database built under the fold needs this.
    return 'skipped - no data/corpus.json';
  }

  const [{ n: questionCount }] = await query('SELECT COUNT(*) AS n FROM questions');
  if (Number(questionCount) === 0) return 'skipped - no questions yet';

  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const notes = [];

  // ---- make sure all eleven exist ----------------------------------------
  for (const [name, copy] of Object.entries(RESTORE)) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await queryOne('SELECT id FROM domains WHERE name = ?', [name]);
    if (existing) continue;
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO domains (slug, name, tagline, description, accent, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [slugify(name), name, copy.tagline, copy.description, copy.accent, copy.order]
    );
    notes.push(`created ${name}`);
  }

  const domains = await query('SELECT id, name FROM domains');
  const idByName = new Map(domains.map((d) => [d.name, d.id]));

  // ---- move each question to the subject the corpus gives it -------------
  const current = await query('SELECT id, ref, domain_id FROM questions');
  const domainByRef = new Map(corpus.questions.map((q) => [q.ref, q.domain]));

  let moved = 0;
  let untouched = 0;
  const movedTo = {};

  for (const q of current) {
    const want = domainByRef.get(q.ref);
    if (!want) {
      // Written in the admin area or by the generator. Somebody chose its
      // topic deliberately; leave it alone.
      untouched += 1;
      continue;
    }
    const wantId = idByName.get(want);
    if (!wantId || wantId === q.domain_id) continue;
    // eslint-disable-next-line no-await-in-loop
    await query('UPDATE questions SET domain_id = ? WHERE id = ?', [wantId, q.id]);
    moved += 1;
    movedTo[want] = (movedTo[want] || 0) + 1;
  }

  // ---- reorder, so the eleven read light to heavy ------------------------
  for (let i = 0; i < ORDER.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await query('UPDATE domains SET sort_order = ? WHERE name = ?', [i + 1, ORDER[i]]);
  }

  // ---- retire Everyday, but only once it is genuinely empty --------------
  const everyday = await queryOne("SELECT id FROM domains WHERE name = 'Everyday'");
  if (everyday) {
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM questions WHERE domain_id = ?', [
      everyday.id,
    ]);
    if (Number(n) === 0) {
      await query('DELETE FROM domains WHERE id = ?', [everyday.id]);
      notes.push('removed the empty Everyday bucket');
    } else {
      // Deleting it would CASCADE the questions away and every couple's record
      // of them with it. Hidden instead, and reported, so a human decides.
      await query('UPDATE domains SET is_active = 0 WHERE id = ?', [everyday.id]);
      notes.push(`Everyday still holds ${n} question(s) with no corpus entry - hidden, not deleted`);
    }
  }

  if (moved) {
    notes.push(
      `moved ${moved} question(s): ` +
        Object.entries(movedTo)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
    );
  }
  if (untouched) notes.push(`${untouched} admin-written question(s) left where they were`);

  return notes.length ? notes.join('; ') : 'already split';
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
