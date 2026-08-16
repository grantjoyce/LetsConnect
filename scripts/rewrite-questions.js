'use strict';

/**
 * Rewrites specific questions to be concrete, keyed by ref.
 *
 *   npm run rewrite-questions            what would change, changes nothing
 *   npm run rewrite-questions -- --apply write it
 *
 * WHY THESE NEEDED REWRITING
 * --------------------------
 * "How much should we give away, and to whom?" is a fair question and a poor
 * card. Sitting alone on a phone it does not say give away what, to whom, how
 * often, or who decides - the reader has to supply all of that before they can
 * start, and two people will supply different things and answer past each
 * other.
 *
 * The specificity was not missing. It was in the CONTEXT line, which is hidden
 * behind Expand:
 *
 *     Q: How much should we give away, and to whom?
 *     C: Charity, family, church, causes.
 *
 * Everything the question needed was one tap away and therefore invisible. That
 * is the structural fault behind almost every vague card in the corpus: the
 * detail was written, then filed where nobody reads it.
 *
 * So the rewrite is mostly a MOVE, not an invention - pull the specifics up
 * into the question, and let the context go back to doing its real job, which
 * is opening the territory rather than explaining the question.
 *
 * DRY RUN BY DEFAULT
 * ------------------
 * Prints the before and after of every change and touches nothing without
 * --apply, because this edits content couples are being dealt.
 *
 * Every rewrite is put through lib/question-rules.js first. A rewrite that
 * fails a fatal rule is REFUSED and the whole run stops - making a question
 * clearer must not make it unservable.
 */

const { pool, query, queryOne } = require('../db');
const { checkQuestion } = require('../lib/question-rules');

/**
 * ref -> [question, context]
 *
 * Only the gestural ones. Most of Money was already concrete - "What is the
 * right amount for either of us to spend without discussing it?" needs nothing
 * doing to it - and rewriting a question that works is how a corpus gets worse.
 */
const REWRITES = {
  // The one that prompted this. Context was "Charity, family, church, causes."
  'MON-671': [
    'How much of our money should go to charity, family or church each year, and who decides?',
    'Naming the amount is usually easier than naming who gets to choose.',
  ],

  // "What does enough look like to you?" - enough of what, measured how.
  'MON-679': [
    'What would we need coming in each month for you to stop thinking about money?',
    'A number, a way of living, or just not checking the balance.',
  ],

  // "What is your honest view of how we handle money as a pair?" - invites a
  // verdict rather than an answer. Ask for the one change instead.
  'MON-668': [
    'What is one thing about how we handle money together that you would change tomorrow?',
    'Working, not working, or never actually examined.',
  ],

  // "What has money cost us in time or attention?"
  'MON-689': [
    'What have we given up in time together to earn what we currently earn?',
    'The trade neither of us noticed making.',
  ],

  // "What are you working for, once the bills are paid?"
  'MON-690': [
    'Once the bills are paid, what is the money you earn actually for?',
    'The purpose behind the earning, beyond keeping things running.',
  ],

  // "What would you protect last?" cannot stand alone - protect from what? It
  // was written as a follow-on to MON-692, which is exactly what the corpus
  // rules forbid on a card dealt on its own.
  'MON-693': [
    'If we had to cut our spending hard, what is the last thing you would give up?',
    'The thing that goes only when everything else already has.',
  ],

  // "significantly more" / "significantly less" - name the change.
  'MON-698': [
    'If our income doubled, what would actually change between the two of us?',
    'And what you think would stay exactly as it is.',
  ],
  'MON-699': [
    'If our income halved overnight, what would change between the two of us?',
    'This tests the relationship rather than the budget.',
  ],

  // "What would full financial transparency between us actually require?"
  'MON-706': [
    'What would each of us have to show the other for our money to be genuinely open?',
    'Accounts, debts, spending - and whether you actually want that.',
  ],

  // "What is the single most honest thing you could say about money and us?"
  'MON-710': [
    'What is the most honest thing you could say about money between us, in one sentence?',
    'The one you would say if it carried no consequences.',
  ],

  // Same fault as MON-693, found in Conflict: REA-138 is "Where has it made you
  // harder?" - written directly under REA-137, and meaningless without it. The
  // corpus's DANGLING rule only catches a pronoun at the START of a question,
  // so "it" sitting mid-sentence with nothing to refer to slipped through.
  'REA-137': [
    'Where has this relationship made you less ambitious, or less yourself?',
    'Smaller in the sense of shrinking to fit.',
  ],
  'REA-138': [
    'Where has this relationship made you more guarded than you used to be?',
    'Harder meaning cynical, quicker to defend, less generous.',
  ],

  // "What is your relationship with money doing to you?" - abstract. Ask for
  // the behaviour, which is the thing a person can actually observe.
  'SOL-247': [
    'What does worrying about money stop you doing, or push you into doing?',
    'Money shapes behaviour and mood. Say how yours affects you.',
  ],
};

async function run(options = {}) {
  const apply = !!options.apply;
  const changes = [];
  const missing = [];
  const refused = [];

  for (const [ref, [text, context]] of Object.entries(REWRITES)) {
    // eslint-disable-next-line no-await-in-loop
    const row = await queryOne('SELECT id, ref, text, context FROM questions WHERE ref = ?', [ref]);
    if (!row) {
      missing.push(ref);
      continue;
    }

    const check = checkQuestion(text, context);
    if (check.fatal) {
      refused.push({ ref, why: check.issues.filter((i) => i.level === 'fatal').map((i) => i.why) });
      continue;
    }

    if (row.text === text && row.context === context) continue;
    changes.push({ id: row.id, ref, from: row.text, to: text, fromC: row.context, toC: context, notes: check.issues });
  }

  if (refused.length) {
    refused.forEach((r) => console.error(`❌ ${r.ref} would not be servable: ${r.why.join('; ')}`));
    throw new Error('A rewrite failed the construction rules. Nothing was written.');
  }

  console.log(`\n${changes.length} question(s) to rewrite${apply ? '' : '  (dry run - nothing written)'}\n`);
  for (const c of changes) {
    console.log(`  ${c.ref}`);
    console.log(`    was: ${c.from}`);
    console.log(`         ${c.fromC || '(no context)'}`);
    console.log(`    now: ${c.to}`);
    console.log(`         ${c.toC}`);
    c.notes.forEach((n) => console.log(`    note: ${n.level} - ${n.why}`));
    console.log('');
  }
  if (missing.length) console.log(`  not in this database, skipped: ${missing.join(', ')}\n`);

  if (!apply) {
    console.log('Run again with --apply to write these.\n');
    return `${changes.length} pending`;
  }

  for (const c of changes) {
    // needs_review is cleared deliberately: a question held back for being
    // unclear has just been made clear, and that is exactly what releases it.
    // eslint-disable-next-line no-await-in-loop
    await query(
      'UPDATE questions SET text = ?, context = ?, needs_review = 0, review_note = NULL WHERE id = ?',
      [c.to, c.toC, c.id]
    );
  }

  return `${changes.length} rewritten`;
}

module.exports = { run, REWRITES };

if (require.main === module) {
  run({ apply: process.argv.includes('--apply') })
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
