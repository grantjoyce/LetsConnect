'use strict';

/**
 * Loads data/corpus.json into the database.
 *
 *   npm run seed-corpus              seed only if there is no content yet
 *   npm run seed-corpus -- --replace DELETE all existing content and reload
 *
 * `--replace` is destructive and deliberately not the default. It deletes every
 * question, domain and chain, and every couple's record of what they have
 * discussed goes with them by cascade. That is correct when rebuilding the
 * content model, and catastrophic if run by accident on a live database, so it
 * has to be asked for and it reports exactly what it destroyed.
 *
 * Domains are derived from the corpus rather than configured here: the corpus
 * is the source of truth for what subjects exist.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const CORPUS = path.join(__dirname, '..', 'data', 'corpus.json');

/**
 * EIGHT categories. Depth is the other axis and stays at five.
 *
 * The corpus tags questions against eleven subjects, so four of them fold into
 * the eight the product ships. The mapping is not arbitrary - it follows what
 * the corpus itself says Everyday was:
 *
 *   "ordinary life has real subjects underneath it: work, home, money,
 *    friendship"
 *
 * Home, Work and Social ARE that ordinary life, so Everyday becomes their
 * container rather than the register it used to be. It now spans D1 to D4,
 * which is what the corpus requires of a real domain: a set that caps at D2 by
 * definition is a register and should be rejected.
 *
 * Meaning holds four questions about belief and purpose, which sit closest to
 * Self - the person rather than the partnership.
 *
 * Nothing is discarded: all 850 questions land somewhere. To change any of
 * this, edit the map and re-run `npm run seed-corpus -- --replace`.
 */
const DOMAIN_MAP = {
  Self: 'Self',
  Meaning: 'Self',
  Attachment: 'Attachment',
  Conflict: 'Conflict',
  Origin: 'Origin',
  Sex: 'Sex',
  Future: 'Future',
  Money: 'Money',
  Home: 'Everyday',
  Work: 'Everyday',
  Social: 'Everyday',
};

/**
 * Order runs light to heavy. A first-time user scrolling this should meet the
 * ordinary before they meet Sex and Conflict.
 */
const DOMAIN_PRESENTATION = {
  Everyday: {
    tagline: 'Home, work, and everyone else in your life',
    description:
      'The practical business of two people sharing a life. Chores, space, rest, ambition, and the friends and family around the pair of you. Unglamorous, and the source of most ordinary friction.',
    accent: '#35B7A6',
    order: 1,
  },
  Self: {
    tagline: 'Who each of you actually is right now',
    description:
      'The person rather than the partnership. What you are carrying, enjoying, avoiding and becoming, and what you believe you are for. The broadest set here, and the easiest place to start.',
    accent: '#F2A33C',
    order: 2,
  },
  Attachment: {
    tagline: 'How you reach for each other, and what happens when you miss',
    description:
      'Needing, being needed, being noticed. The small bids for attention that make up most of a relationship, and what it feels like when they land or do not.',
    accent: '#D8327C',
    order: 3,
  },
  Origin: {
    tagline: 'What you each learned before you met',
    description:
      'Childhood, family, and the lessons about love that arrived before either of you was old enough to question them.',
    accent: '#7C6CF0',
    order: 4,
  },
  Future: {
    tagline: 'Plans, ageing, and the things not yet said',
    description:
      'Where this is going, practically as well as hopefully. Useful when a decision is coming and neither of you has said out loud what you want.',
    accent: '#3D9BE9',
    order: 5,
  },
  Money: {
    tagline: 'The one most couples avoid',
    description:
      'Earning, spending, fairness, secrecy and fear. Among the most common subjects of recurring conflict, and the one people are least practised at discussing calmly.',
    accent: '#7FB069',
    order: 6,
  },
  Sex: {
    tagline: 'Wanting, being wanted, and what gets in the way',
    description:
      'Attraction, initiation, fantasy and the gap between what people want and what they say. Honest and adult throughout, never crude. Best somewhere private.',
    accent: '#8E2D63',
    order: 7,
  },
  Conflict: {
    tagline: 'How you fight, and how you come back',
    description:
      'Arguments, resentment, rupture and repair. The deepest set here by some margin, and the one to open when you both have the time to sit with the answers.',
    accent: '#E2574C',
    order: 8,
  },
};

function slugify(v) {
  return String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function run(options = {}) {
  const replace = !!options.replace;

  if (!fs.existsSync(CORPUS)) {
    throw new Error('data/corpus.json is missing. Run: npm run build-corpus');
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

  const conn = await pool.getConnection();
  try {
    const [[existing]] = await conn.query('SELECT COUNT(*) AS n FROM questions');
    if (Number(existing.n) > 0 && !replace) {
      return `skipped - ${existing.n} questions already present (use --replace to rebuild)`;
    }

    await conn.beginTransaction();
    const destroyed = {};

    if (replace) {
      // Count before destroying, so the report is a fact rather than a guess.
      const [[q]] = await conn.query('SELECT COUNT(*) AS n FROM questions');
      const [[d]] = await conn.query('SELECT COUNT(*) AS n FROM domains');
      const [[p]] = await conn.query('SELECT COUNT(*) AS n FROM couple_question_status');
      destroyed.questions = Number(q.n);
      destroyed.domains = Number(d.n);
      destroyed.progress = Number(p.n);

      // Order matters: progress and chain sessions reference questions/chains.
      await conn.query('DELETE FROM couple_question_status');
      await conn.query('DELETE FROM couple_chain_progress');
      await conn.query('DELETE FROM question_reports');
      await conn.query('DELETE FROM questions');
      await conn.query('DELETE FROM chains');
      await conn.query('DELETE FROM domains');
    }

    // ---- domains ----------------------------------------------------------
    // Every corpus subject maps to one of the eight. An unmapped subject keeps
    // its own name and gets a tile rather than being silently dropped - a new
    // subject appearing in the corpus should be visible, not swallowed.
    const targetOf = (raw) => DOMAIN_MAP[raw] || raw;

    const targets = [...new Set(corpus.questions.map((q) => targetOf(q.domain)))].sort((a, b) => {
      const pa = DOMAIN_PRESENTATION[a] ? DOMAIN_PRESENTATION[a].order : 99;
      const pb = DOMAIN_PRESENTATION[b] ? DOMAIN_PRESENTATION[b].order : 99;
      return pa - pb || a.localeCompare(b);
    });

    const domainId = new Map(); // target name -> id
    for (let i = 0; i < targets.length; i += 1) {
      const name = targets[i];
      const p = DOMAIN_PRESENTATION[name] || { tagline: null, description: null, accent: '#D8327C' };
      const [res] = await conn.query(
        `INSERT INTO domains (slug, name, tagline, description, accent, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [slugify(name), name, p.tagline, p.description, p.accent, i + 1]
      );
      domainId.set(name, res.insertId);
    }

    // ---- chains -----------------------------------------------------------
    const chainId = new Map();
    for (const c of corpus.chains) {
      const [res] = await conn.query(
        `INSERT INTO chains (name, total, min_depth, max_depth, domain_id, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [c.name, c.total, c.minDepth, c.maxDepth, domainId.get(targetOf(c.domain)) || null]
      );
      chainId.set(c.name, res.insertId);
    }

    // ---- questions --------------------------------------------------------
    let quarantined = 0;
    const perDomainOrder = new Map();

    for (const q of corpus.questions) {
      const target = targetOf(q.domain);
      const dId = domainId.get(target);
      if (!dId) continue;

      const n = (perDomainOrder.get(target) || 0) + 1;
      perDomainOrder.set(target, n);

      const fatal = (q.issues || []).filter((i) => i.level === 'fatal');
      if (fatal.length) quarantined += 1;

      await conn.query(
        `INSERT INTO questions
           (ref, domain_id, depth, lens, is_volatile, source, text, context,
            chain_id, chain_position, sort_order, is_active, admin_hidden,
            needs_review, review_note)
         VALUES (?, ?, ?, ?, ?, 'catalogue', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          q.ref,
          dId,
          q.depth,
          q.lens,
          q.volatile ? 1 : 0,
          q.question,
          q.context || null,
          q.chainName ? chainId.get(q.chainName) || null : null,
          q.chainPosition || null,
          n,
          // Quarantined questions are stored and hidden, never dropped.
          fatal.length ? 1 : 0,
          fatal.length ? 1 : 0,
          fatal.length ? fatal.map((i) => i.why).join('; ').slice(0, 255) : null,
        ]
      );
    }

    // The summary is built BEFORE the commit, deliberately.
    //
    // An earlier version built it after, and a typo in this very block threw
    // once the transaction had already committed. The catch below then called
    // rollback() on a committed transaction - a silent no-op - so the run
    // reported "Seed failed" while every question had in fact been destroyed
    // and replaced. A destructive tool claiming failure after succeeding is the
    // worst possible direction for that error to point.
    //
    // Nothing between here and commit() may throw.
    const parts = [];
    if (replace) {
      parts.push(
        `destroyed ${destroyed.questions} questions, ${destroyed.domains} categories, ` +
          `${destroyed.progress} progress rows`
      );
    }
    parts.push(`${targets.length} categories`);
    parts.push(`${corpus.questions.length} questions`);
    parts.push(`${corpus.chains.length} chains`);
    parts.push(`${quarantined} held back for review`);
    const summary = parts.join(', ');

    await conn.commit();
    return summary;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { run };

if (require.main === module) {
  const replace = process.argv.includes('--replace');
  run({ replace })
    .then((summary) => {
      console.log(`✅ ${summary}`);
      if (!replace) {
        console.log('\n   To rebuild from scratch: npm run seed-corpus -- --replace');
        console.log('   That deletes all existing content AND every couple\'s progress.');
      }
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Seed failed:', err.message);
      process.exit(1);
    });
}
