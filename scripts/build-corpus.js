'use strict';

/**
 * Turns the corpus markdown into data/corpus.json.
 *
 *   npm run build-corpus
 *
 * WHY A BUILD STEP RATHER THAN HAND-MAINTAINED DATA
 * -------------------------------------------------
 * `Research Data/couples-question-corpus.md` is the human source of truth and
 * is written and edited by hand. Retyping 850 questions into a JS file would
 * create a second copy that drifts from the first within a week. This parses
 * the markdown and writes a generated JSON file, so there is exactly one place
 * a question is authored.
 *
 * The corpus file carries its own validation rules in section 5. They are
 * implemented here rather than left in a Python block nobody runs, and this
 * script FAILS on a violation rather than warning: a question that cannot
 * stand alone ships a card that reads as nonsense, and the whole product is
 * one card at a time.
 *
 * Generated file. Do not edit data/corpus.json by hand.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'Research Data', 'couples-question-corpus.md');
const OUT = path.join(__dirname, '..', 'data', 'corpus.json');

// | ID | Depth | Domain | Vol | Chain | Question | Context |
const ROW =
  /^\|\s*([A-Z]{3}-\d{3})\s*\|\s*(D\d)\s*\|\s*([A-Za-z]*)\s*\|\s*([A-Za-z]*)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*$/;
const BLOCK = /^##\s+([A-Z]{3})\.\s*(.+?)\s*$/;

// ---------------------------------------------------------------------------
// Validation, from section 5 of the corpus
//
// The per-question rules now live in lib/question-rules.js, because they have a
// second caller: questions written by the generator in the admin area. Keeping
// two copies would let them drift, and the copy that drifted would be the one
// guarding the newer, less-reviewed content.
//
// What stays here is the part that is specific to a FILE of questions rather
// than to one question: duplicate refs, and the hand-reviewed standalone list
// below, which is keyed by ref and so has no meaning to a freshly written card.
// ---------------------------------------------------------------------------

const { checkQuestion } = require('../lib/question-rules');

/**
 * Hand-reviewed failures of the standalone rule.
 *
 * Every automatic demonstrative hit was read on its own, with no other card
 * visible, applying the corpus's own test: would a reasonable person ask
 * "which one?". These are the ones that failed. The rest are relative
 * pronouns or refer back within their own sentence, and are fine.
 *
 * Keep this list rather than trying to encode it as a pattern. It is the
 * output of judgement, and pretending otherwise produces a rule that is wrong
 * in both directions.
 */
const NOT_STANDALONE = {
  // Empty as of the tranche-three rewrite: all thirteen were rewritten to
  // name their own subject. Add a ref here when review finds another one -
  // the automatic demonstrative rule below cannot make this call reliably.
};

/**
 * Rules are graded, because they are not equally certain.
 *
 *   fatal   - the card cannot be served. It is either answerable with a bare
 *             yes/no, or it refers to something the reader has not seen.
 *   review  - probably wrong, but a human has to decide. Flagged, still served.
 *
 * The corpus is right that a validator firing on two fifths of the corpus gets
 * ignored within a day. The answer is a more precise rule, not a lower bar -
 * hence "or" being treated as the thing that rescues an auxiliary opener.
 */
function validate(rows) {
  const seen = new Set();

  for (const r of rows) {
    r.issues = [];

    // File-scoped: only a corpus can have a duplicate ref.
    if (seen.has(r.ref)) r.issues.push({ level: 'fatal', why: 'duplicate ID' });
    seen.add(r.ref);

    const shared = checkQuestion(r.question, r.context);

    // The hand-reviewed list is keyed by ref and REPLACES the advisory
    // demonstrative warning for that question - a ref on the list has already
    // been read by a person, so a "check this reads on its own" note under it
    // would be telling the reader to redo work that produced the entry.
    if (NOT_STANDALONE[r.ref]) {
      r.issues.push(
        ...shared.issues.filter((i) => !i.why.startsWith('check "')),
        { level: 'fatal', why: `not standalone: ${NOT_STANDALONE[r.ref]}` }
      );
    } else {
      r.issues.push(...shared.issues);
    }

    r.fatal = r.issues.some((i) => i.level === 'fatal');
  }

  return {
    fatal: rows.filter((r) => r.fatal),
    review: rows.filter((r) => !r.fatal && r.issues.length),
  };
}

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`❌ Cannot find the corpus at:\n   ${SOURCE}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/);
  const rows = [];
  const lenses = new Map();
  let current = null;

  for (const line of lines) {
    const b = line.match(BLOCK);
    if (b) {
      current = { prefix: b[1], title: b[2], note: '' };
      lenses.set(b[1], current);
      continue;
    }
    // The first prose line after a block heading is the lens description.
    if (current && !current.note && line.trim() && !line.startsWith('|') && !line.startsWith('#')) {
      current.note = line.trim();
    }

    const m = line.match(ROW);
    if (!m) continue;
    const [, ref, depth, domain, vol, chain, question, context] = m;

    let chainName = null;
    let chainPosition = null;
    let chainTotal = null;
    if (chain) {
      const c = chain.match(/^(.+?)\s+(\d+)\/(\d+)$/);
      if (!c) {
        console.error(`❌ ${ref}: unparsable chain value "${chain}"`);
        process.exit(1);
      }
      [, chainName, chainPosition, chainTotal] = c;
      chainPosition = Number(chainPosition);
      chainTotal = Number(chainTotal);
    }

    rows.push({
      ref,
      lens: ref.slice(0, 3),
      depth: Number(depth.slice(1)),
      domain,
      volatile: vol.trim().toLowerCase() === 'yes',
      chainName,
      chainPosition,
      chainTotal,
      question,
      context,
    });
  }

  if (!rows.length) {
    console.error('❌ No question rows found. Has the table format changed?');
    process.exit(1);
  }

  const { fatal, review } = validate(rows);

  // Fatal failures are still WRITTEN, but marked so the seeder holds them back
  // rather than serving them. Dropping them would silently lose authored
  // content; serving them would ship a card that reads as nonsense on its own.
  // Neither is acceptable, so they go in quarantined and get reported.
  if (fatal.length) {
    console.log(`\n⚠  ${fatal.length} question(s) cannot be served as written.`);
    console.log('   Imported but held back, so nothing is lost. Fix them in the');
    console.log('   markdown and re-run to release them.\n');
    fatal.forEach((r) => {
      console.log(`   ${r.ref}  ${r.issues.filter((i) => i.level === 'fatal').map((i) => i.why).join('; ')}`);
      console.log(`      ${r.question}`);
    });
  }
  if (review.length) {
    console.log(`\nℹ  ${review.length} question(s) worth a human look. Still served.\n`);
    review.slice(0, 15).forEach((r) => {
      console.log(`   ${r.ref}  ${r.issues.map((i) => i.why).join('; ')}`);
      console.log(`      ${r.question}`);
    });
    if (review.length > 15) console.log(`   ... and ${review.length - 15} more`);
  }
  console.log('');

  // Chains: rebuild from the rows and check the corpus invariants.
  const chains = new Map();
  for (const r of rows) {
    if (!r.chainName) continue;
    if (!chains.has(r.chainName)) chains.set(r.chainName, { name: r.chainName, declaredTotal: r.chainTotal, members: [] });
    chains.get(r.chainName).members.push(r);
  }

  const chainProblems = [];
  for (const c of chains.values()) {
    c.members.sort((a, b) => a.chainPosition - b.chainPosition);
    if (c.members.length !== c.declaredTotal) {
      chainProblems.push(`${c.name}: declares ${c.declaredTotal} cards, found ${c.members.length}`);
    }
    if (c.members.length < 3) chainProblems.push(`${c.name}: only ${c.members.length} cards, minimum is 3`);
    for (let i = 1; i < c.members.length; i += 1) {
      if (c.members[i].depth < c.members[i - 1].depth) {
        chainProblems.push(`${c.name}: depth drops at position ${c.members[i].chainPosition}`);
      }
    }
    const positions = c.members.map((m) => m.chainPosition).join(',');
    const expected = c.members.map((_, i) => i + 1).join(',');
    if (positions !== expected) chainProblems.push(`${c.name}: positions are ${positions}, expected ${expected}`);
  }

  if (chainProblems.length) {
    console.error(`\n❌ ${chainProblems.length} chain problem(s). Nothing written.\n`);
    chainProblems.forEach((p) => console.error(`   ${p}`));
    process.exit(1);
  }

  const domains = [...new Set(rows.map((r) => r.domain))].sort();
  const byDepth = [1, 2, 3, 4, 5].map((d) => rows.filter((r) => r.depth === d).length);

  const out = {
    generated: 'by scripts/build-corpus.js - do not edit by hand',
    source: 'Research Data/couples-question-corpus.md',
    counts: {
      questions: rows.length,
      domains: domains.length,
      lenses: lenses.size,
      chains: chains.size,
      chainedQuestions: rows.filter((r) => r.chainName).length,
      volatile: rows.filter((r) => r.volatile).length,
      quarantined: fatal.length,
      flaggedForReview: review.length,
      byDepth: { D1: byDepth[0], D2: byDepth[1], D3: byDepth[2], D4: byDepth[3], D5: byDepth[4] },
    },
    lenses: [...lenses.values()],
    chains: [...chains.values()].map((c) => ({
      name: c.name,
      total: c.members.length,
      refs: c.members.map((m) => m.ref),
      minDepth: Math.min(...c.members.map((m) => m.depth)),
      maxDepth: Math.max(...c.members.map((m) => m.depth)),
      domain: c.members[0].domain,
    })),
    questions: rows,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');

  console.log(`✅ ${rows.length} questions, all checks passed.\n`);
  console.log(`   Domains  ${domains.length}: ${domains.join(', ')}`);
  console.log(`   Depth    D1 ${byDepth[0]} · D2 ${byDepth[1]} · D3 ${byDepth[2]} · D4 ${byDepth[3]} · D5 ${byDepth[4]}`);
  console.log(`   Chains   ${chains.size} covering ${out.counts.chainedQuestions} questions`);
  console.log(`   Volatile ${out.counts.volatile}`);
  console.log(`   Lenses   ${lenses.size}`);
  console.log(`\n   Written to data/corpus.json`);
}

main();
