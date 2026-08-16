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
 * The corpus's eleven subjects, kept as eleven.
 *
 * An earlier version of this folded them into eight - Home, Work and Social
 * into an "Everyday" bucket, and Meaning into Self - because two of them are
 * very small (Meaning has 4 questions, Social 3). That was wrong. A subject
 * with four questions is a thin subject, not a subject that belongs inside
 * another one, and merging Meaning into Self quietly told a couple that "what
 * am I for" is the same question as "who am I". The fix for thin is to write
 * more, which is what the generator is for.
 *
 * Identity map rather than no map, so the shape stays visible: this is the one
 * place the corpus's subjects turn into the app's topics, and the next person
 * to want a rename does it here rather than hunting for a string.
 */
const DOMAIN_MAP = {
  Self: 'Self',
  Meaning: 'Meaning',
  Attachment: 'Attachment',
  Conflict: 'Conflict',
  Origin: 'Origin',
  Sex: 'Sex',
  Future: 'Future',
  Money: 'Money',
  Home: 'Home',
  Work: 'Work',
  Social: 'Social',
};

/**
 * Order runs light to heavy. A first-time user scrolling this should meet the
 * ordinary before they meet Sex and Conflict.
 */
const DOMAIN_PRESENTATION = {
  Self: {
    tagline: 'Who each of you actually is right now',
    description:
      'The person rather than the partnership. What you are carrying, enjoying, avoiding and becoming. The broadest set here, and the easiest place to start.',
    accent: '#F2A33C',
    order: 1,
  },
  Attachment: {
    tagline: 'How you reach for each other, and what happens when you miss',
    description:
      'Needing, being needed, being noticed. The small bids for attention that make up most of a relationship, and what it feels like when they land or do not.',
    accent: '#D8327C',
    order: 2,
  },
  Origin: {
    tagline: 'What you each learned before you met',
    description:
      'Childhood, family, and the lessons about love that arrived before either of you was old enough to question them.',
    accent: '#7C6CF0',
    order: 3,
  },
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
  Money: {
    tagline: 'The one most couples avoid',
    description:
      'Earning, spending, fairness, secrecy and fear. Among the most common subjects of recurring conflict, and the one people are least practised at discussing calmly.',
    accent: '#7FB069',
    order: 7,
  },
  Future: {
    tagline: 'Plans, ageing, and the things not yet said',
    description:
      'Where this is going, practically as well as hopefully. Useful when a decision is coming and neither of you has said out loud what you want.',
    accent: '#3D9BE9',
    order: 8,
  },
  Sex: {
    tagline: 'Wanting, being wanted, and what gets in the way',
    description:
      'Attraction, initiation, fantasy and the gap between what people want and what they say. Honest and adult throughout, never crude. Best somewhere private.',
    accent: '#8E2D63',
    order: 9,
  },
  Conflict: {
    tagline: 'How you fight, and how you come back',
    description:
      'Arguments, resentment, rupture and repair. The deepest set here by some margin, and the one to open when you both have the time to sit with the answers.',
    accent: '#E2574C',
    order: 10,
  },
  Meaning: {
    tagline: 'What the two of you are for',
    description:
      'Purpose, mortality, and what you want this to have added up to. The smallest set here by a distance — four questions — and the one most worth adding to.',
    accent: '#A88BD4',
    order: 11,
  },
};

/**
 * Copy for each lens. FOUR fields, two audiences.
 *
 *   [0] name        - the heading on the modal
 *   [1] description - COUPLE-FACING. What someone reads when they tap the code
 *                     on a card, written for a phone.
 *   [2] author      - whose framework it is, or null where there is none
 *   [3] brief       - GENERATOR-FACING. What the framework actually
 *                     interrogates, written so a question can be composed
 *                     against it. Never shown to a couple.
 *
 * The two prose fields cannot do each other's job: a couple reading a construct
 * list learns nothing, and a generator reading marketing copy writes generic
 * questions under a respected name.
 *
 * All of it describes the WAY OF LOOKING, never a book, a deck or an author's
 * published material. That is the same line the corpus draws: frameworks are
 * ideas and can be built on freely; expression is protected. Naming the person
 * whose framework it is is attribution, not reproduction. Five blocks have no
 * authority behind them at all and say so - attaching Money to a lens would be
 * a false attribution.
 */
const LENS_COPY = {
  GOT: [
    'Everyday connection',
    'Built on the idea that relationships are made in small moments rather than grand ones: noticing each other, turning towards the little bids for attention, and keeping the rituals that hold a couple together. Named for the Gottmans, whose framework this follows.',
    'The Gottmans',
    'Relationships are built or eroded in small daily moments rather than in crises. Interrogate: bids for attention and whether they are turned towards, away from or against; the ratio of warmth to criticism in ordinary exchanges; contempt as the strongest predictor of decay; repair attempts and whether they are accepted; shared rituals of connection; how well each partner knows the other’s inner world.',
  ],
  PER: [
    'Desire and distance',
    'Looks at the tension between wanting security and wanting freedom, and at how closeness and mystery both feed attraction. Follows Esther Perel’s framework.',
    'Esther Perel',
    'Security and adventure are both real needs and they pull against each other. Interrogate: what closeness costs desire; the distance required to want someone; how each partner keeps a self that is not absorbed into the couple; the difference between being loved and being wanted; erotic imagination as separate from intimacy; what each person is unwilling to give up.',
  ],
  REA: [
    'Honesty without blame',
    'Concerns the difference between speaking plainly and attacking, and what people do with their own part in a problem. Follows Terry Real’s framework.',
    'Terry Real',
    'Directness and contempt are not the same act. Interrogate: the move from grandiosity or shame into level standing; owning a share of a problem without collapsing into fault; what each person does when they feel one-up or one-down; the difference between a complaint and a character verdict; asking for something rather than proving a point.',
  ],
  EFT: [
    'The cycle underneath',
    'Treats most repeated arguments as one cycle playing out again, driven by a need neither person has said out loud. Drawn from Emotionally Focused work generally rather than one author.',
    // A framework without a single name behind it. Left as null it was reported
    // as "written to the subject directly", which contradicted its own
    // description - there IS a body of work here, it just has no one author.
    'Emotionally Focused therapy',
    'A couple usually has one argument in many costumes, driven by attachment fear rather than the stated topic. Interrogate: the pursue-withdraw loop and each person’s move in it; the softer feeling underneath the loud one; what each partner is afraid the other will conclude about them; the moment a fight turns from an issue into a question about the bond.',
  ],
  SOL: [
    'Knowing your own patterns',
    'About seeing your own habits clearly enough to choose differently, rather than explaining your partner to themselves. Follows Alexandra Solomon’s framework.',
    'Alexandra Solomon',
    'Relational self-awareness: knowing your own patterns well enough to choose differently. Interrogate: the story each person tells about why they are like this; what gets repeated across relationships; the gap between intent and impact; noticing a reaction as it starts rather than after it lands; taking responsibility without self-punishment.',
  ],
  MNN: [
    'How you attach',
    'Concerns what each of you does when you feel disconnected — reach harder, or go quiet — and how those reactions collide. Follows Elizabeth Menanno’s framework.',
    'Elizabeth Menanno',
    'Attachment style as observable behaviour under threat, not a label. Interrogate: what each person does in the first hour of feeling disconnected — reach harder, go quiet, get busy, get sharp; what reassurance actually lands; how the two reactions collide and escalate; what each person learned to expect when they needed someone.',
  ],
  PHA: [
    'What you inherited',
    'About the family you each grew up in, and the rules about love you absorbed before you were old enough to question them. Follows Vienna Pharaon’s framework.',
    'Vienna Pharaon',
    'The rules about love absorbed in the family of origin, before anyone was old enough to question them. Interrogate: what was modelled about conflict, affection, money and repair; the unspoken family rule each person is still obeying; what each of them swore never to repeat and does anyway; what a parent needed from them that a partner is now expected to supply.',
  ],
  TUR: [
    'Your side of it',
    'Stays firmly on what is yours to own, change or admit, rather than what your partner should do differently. Follows Jerry Turecki’s framework.',
    'Jerry Turecki',
    'Everything stays on the speaker’s own side of the line. Interrogate: what is genuinely theirs to change; what they have been waiting for the other person to do first; the request they have never actually made out loud; the difference between an apology and an explanation; what they would have to give up to stop being right.',
  ],
  NAG: [
    'How desire works',
    'Based on the idea that desire has accelerators and brakes, and that taking your foot off the brake matters more than pressing harder. Follows Emily Nagoski’s framework.',
    'Emily Nagoski',
    'Desire has accelerators and brakes, and releasing a brake usually matters more than pressing the accelerator. Interrogate: what quietly stops desire — exhaustion, resentment, being watched, an unfinished argument; responsive rather than spontaneous wanting; the context required rather than the technique; what each person needs to have happened earlier in the day.',
  ],
  MAR: [
    'Saying what you want',
    'About being able to talk plainly about sex — what you like, what you do not, and what is hard to raise. Follows Vanessa Marin’s framework.',
    'Vanessa Marin',
    'Being able to say plainly what you want, and hear it without defending. Interrogate: what has never been said out loud and why; how a preference gets raised without it sounding like a complaint; what each person assumes the other wants and has never checked; how they signal yes, no and not tonight; what feedback feels like criticism.',
  ],
  LEH: [
    'Fantasy and novelty',
    'Concerns imagination, curiosity and the agreements a couple needs before exploring anything new. Follows Justin Lehmiller’s framework.',
    'Justin Lehmiller',
    'Imagination, curiosity and the agreements that make exploring anything new safe. Interrogate: the distance between a fantasy and a wish to act on it; what each person is curious about and has not raised; what would need to be agreed first; how they would say no to each other; what novelty is for in a long relationship.',
  ],
  OPN: [
    'Opening questions',
    'Light, low-risk questions written to start a conversation rather than to test one. Not drawn from any framework.',
    null,
    'No framework. Light, low-risk questions written to start a conversation rather than test one. Interrogate: preferences, small habits, everyday noticing, the ordinary texture of a life. Nothing here should require a decision about how honest to be.',
  ],
  MON: [
    'Money',
    'Written to the subject directly. No relationship framework covers money properly, and it is among the most common things couples fight about.',
    null,
    'No framework — written to the subject directly, because none covers money properly and it is among the most common things couples fight about. Interrogate: what money meant growing up; security versus enjoyment; secrecy and small concealments; who decides what; earning disparity; debt; what each person considers waste; what they are saving for and whether the other agrees.',
  ],
  HOM: [
    'Home and household',
    'Written to the subject directly: space, chores, rest, and the invisible work of running a life together.',
    null,
    'No framework — written to the subject directly. Interrogate: the invisible work of noticing what needs doing; standards that differ and are never negotiated; rest and who gets it; space, mess and territory; hosting; what home is supposed to feel like and where that expectation came from.',
  ],
  FUT: [
    'The future and ageing',
    'Written to the subject directly: plans, decisions, getting older, and the practical arrangements couples avoid making.',
    null,
    'No framework — written to the subject directly. Interrogate: plans that have been assumed rather than agreed; getting older and what each person fears about it; care, illness and the arrangements couples avoid making; where they will live; what they still want to do and whether time is being spent on it.',
  ],
  WRK: [
    'Work and ambition',
    'Written to the subject directly: what work takes, what it gives, and what it costs the two of you.',
    null,
    'No framework — written to the subject directly. Interrogate: what work gives each person that the relationship does not; ambition and whose is being deferred; what work takes from the evenings; identity tied to a job; what each would do if money were settled; what the other’s work costs them.',
  ],
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
      // COALESCE on the existing values, not on the seed: an author or brief the
      // owner has written in the admin area must survive every later seed. Only
      // a blank column is filled in. Name and description keep their previous
      // behaviour and are left alone entirely on an existing row.
      const [res] = await conn.query(
        `INSERT INTO lenses (code, name, author, description, brief, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           sort_order = VALUES(sort_order),
           is_active  = 1,
           author     = COALESCE(author, VALUES(author)),
           brief      = COALESCE(brief, VALUES(brief))`,
        [
          l.prefix,
          copy ? copy[0] : l.title,
          copy ? copy[2] : null,
          copy ? copy[1] : l.note || null,
          copy ? copy[3] : null,
          i + 1,
        ]
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
