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

/**
 * Couple-facing copy for each lens, shown when someone taps the code on a card.
 *
 * Written to describe the WAY OF LOOKING, never a book, a deck or an author's
 * published material. That is the same line the corpus draws: frameworks are
 * ideas and can be built on freely; expression is protected. Naming the person
 * whose framework it is is attribution, not reproduction.
 *
 * The corpus supplies a one-line note per block; these are longer and written
 * for someone holding a phone, not for a content editor.
 */
const LENS_COPY = {
  GOT: ['Everyday connection', 'Built on the idea that relationships are made in small moments rather than grand ones: noticing each other, turning towards the little bids for attention, and keeping the rituals that hold a couple together. Named for the Gottmans, whose framework this follows.'],
  PER: ['Desire and distance', 'Looks at the tension between wanting security and wanting freedom, and at how closeness and mystery both feed attraction. Follows Esther Perel’s framework.'],
  REA: ['Honesty without blame', 'Concerns the difference between speaking plainly and attacking, and what people do with their own part in a problem. Follows Terry Real’s framework.'],
  EFT: ['The cycle underneath', 'Treats most repeated arguments as one cycle playing out again, driven by a need neither person has said out loud. Drawn from Emotionally Focused work generally rather than one author.'],
  SOL: ['Knowing your own patterns', 'About seeing your own habits clearly enough to choose differently, rather than explaining your partner to themselves. Follows Alexandra Solomon’s framework.'],
  MNN: ['How you attach', 'Concerns what each of you does when you feel disconnected — reach harder, or go quiet — and how those reactions collide. Follows Elizabeth Menanno’s framework.'],
  PHA: ['What you inherited', 'About the family you each grew up in, and the rules about love you absorbed before you were old enough to question them. Follows Vienna Pharaon’s framework.'],
  TUR: ['Your side of it', 'Stays firmly on what is yours to own, change or admit, rather than what your partner should do differently. Follows Jerry Turecki’s framework.'],
  NAG: ['How desire works', 'Based on the idea that desire has accelerators and brakes, and that taking your foot off the brake matters more than pressing harder. Follows Emily Nagoski’s framework.'],
  MAR: ['Saying what you want', 'About being able to talk plainly about sex — what you like, what you do not, and what is hard to raise. Follows Vanessa Marin’s framework.'],
  LEH: ['Fantasy and novelty', 'Concerns imagination, curiosity and the agreements a couple needs before exploring anything new. Follows Justin Lehmiller’s framework.'],
  OPN: ['Opening questions', 'Light, low-risk questions written to start a conversation rather than to test one. Not drawn from any framework.'],
  MON: ['Money', 'Written to the subject directly. No relationship framework covers money properly, and it is among the most common things couples fight about.'],
  HOM: ['Home and household', 'Written to the subject directly: space, chores, rest, and the invisible work of running a life together.'],
  FUT: ['The future and ageing', 'Written to the subject directly: plans, decisions, getting older, and the practical arrangements couples avoid making.'],
  WRK: ['Work and ambition', 'Written to the subject directly: what work takes, what it gives, and what it costs the two of you.'],
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
    // ---- lenses -----------------------------------------------------------
    // Seeded BEFORE the content check and on every run, because lenses are a
    // lookup table: no user content hangs off them, so there is nothing to
    // destroy. Putting them after the early return meant a new lens could only
    // arrive via --replace, which would have made adding one cost every
    // couple's progress.
    let lensesAdded = 0;
    for (let i = 0; i < (corpus.lenses || []).length; i += 1) {
      const l = corpus.lenses[i];
      const copy = LENS_COPY[l.prefix];
      const [res] = await conn.query(
        `INSERT INTO lenses (code, name, description, sort_order, is_active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_active = 1`,
        [l.prefix, copy ? copy[0] : l.title, copy ? copy[1] : l.note || null, i + 1]
      );
      if (res.affectedRows === 1) lensesAdded += 1;
    }

    const [[existing]] = await conn.query('SELECT COUNT(*) AS n FROM questions');
    if (Number(existing.n) > 0 && !replace) {
      return (
        `${lensesAdded} lens description(s) added; ` +
        `skipped content - ${existing.n} questions already present (use --replace to rebuild)`
      );
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
      // Lenses are deliberately NOT deleted here. They carry no couple data,
      // they are seeded above on every run, and wiping them would throw away
      // any description the owner had reworded.
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
