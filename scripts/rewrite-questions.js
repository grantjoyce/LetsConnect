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


  // ---- Sex ----------------------------------------------------------------
  //
  // Almost every one of these is the same fault: a pronoun standing in for the
  // subject. "How do you feel about talking during?" - during WHAT. Read in the
  // markdown, under a heading that says Sex, with the question above it still on
  // screen, they are perfectly clear. Dealt one at a time on a phone with
  // nothing else visible, half of them are unanswerable.
  //
  // The word being avoided is "sex". Naming it is not crudeness - it is the
  // difference between a card that can be answered and one that cannot.

  'MAR-451': ['How comfortable are you talking about sex with me at all?', 'How easy or hard you find this subject in general.'],
  'MAR-459': ['How often would you like to have sex, if you could set the number honestly?', 'The honest number, not the diplomatic one.'],
  'MAR-463': ['How do you feel about talking to each other during sex?', 'Whether talking helps you or interrupts you.'],
  'MAR-464': ['How do you feel about talking afterwards, once sex is over?', 'Whether you want conversation then, and what kind.'],
  'MAR-469': ['How would you tell me that something in bed was not working for you?', 'The method you would actually use, not the ideal one.'],
  'MAR-470': ['What stops you telling me when something in bed is not working?', 'What gets in the way of raising it.'],
  'MAR-475': ['What is your honest view of how often we have sex?', 'Your assessment of where we are, not where we should be.'],
  'MAR-476': ['What has caused the biggest shift in how often we have sex?', 'The event or the period that moved it most.'],
  'MAR-478': ['What do you believe about how much I want sex?', 'Your assumption about my side of it.'],
  'MAR-491': ['How should we agree to raise sex in future without either of us bracing?', 'An opening that does not make either of us tense.'],
  'MAR-492': ['When is a good time to talk about sex, and when is a terrible one?', 'Good timing and bad timing, said plainly.'],
  'MAR-496': ['How do you feel about putting sex in the diary rather than waiting for the mood?', 'Scheduling divides people. Say where you sit.'],
  'MAR-498': ['What is one thing about our sex life we could change immediately?', 'One change available this week.'],
  'MAR-499': ['What is one thing about our sex life that will take longer to change?', 'One change that needs time rather than willingness.'],
  'MAR-500': ['What do you need from me to keep sex something we can talk about?', 'What keeps the subject open rather than closed.'],
  'MAR-490': ['What is the most exposing thing you could say to me about sex?', 'The thing that costs the most to say out loud.'],

  'NAG-402': ['What kind of day shuts down any interest in sex completely?', 'The shape of a day that ends the possibility.'],
  'NAG-421': ['When do you find yourself going through the motions during sex?', 'The times you are participating rather than present.'],
  'NAG-422': ['What makes it hard to turn down sex without feeling guilty?', 'What makes refusing feel like a failure rather than a choice.'],
  'NAG-423': ['What makes it hard to say yes to sex without feeling obliged?', 'What makes agreeing feel like a duty rather than a want.'],
  'NAG-432': ['What would change if you stopped measuring our sex life against any standard?', 'Whose standard it is matters as much as what it is.'],
  'NAG-445': ['What one small change to our circumstances would make closeness easier?', 'A change to conditions, not to either of us.'],
  'NAG-449': ['What does good sex mean to you now, compared with earlier in your life?', 'Your current definition, which may have moved.'],
  'NAG-450': ['What would tell you our sex life was in a good place?', 'The signal you would actually go by.'],

  'OPN-593': ['How much do you think we should be talking about sex generally?', 'Enough, too little, or too much.'],

  'LEH-502': ['What makes telling me one of your fantasies feel risky?', 'What the risk actually is, before any content.'],
  'LEH-503': ['What would you need from me to make sharing a fantasy feel safe?', 'The conditions, said as plainly as you can.'],
  'LEH-506': ['What draws you to trying something new, or does novelty not appeal at all?', 'Both answers are ordinary.'],
  'LEH-509': ['What part does giving up control play in what you enjoy?', 'Letting go. Say whether it appeals or does not.'],
  'LEH-510': ['What part does holding control play in what you enjoy?', 'Being the one in charge. Say whether it appeals or does not.'],
  'LEH-516': ['If you told me a fantasy, what would you want me to say back?', 'The response that would make it survivable.'],
  'LEH-517': ['If you told me a fantasy, what would you not want me to do with it afterwards?', 'What you would not want done with it later.'],
  'LEH-518': ['How would you feel hearing one of my fantasies?', 'Your honest anticipated reaction, not the generous one.'],
  'LEH-526': ['If we tried something new, how would we know it was time to stop?', 'A way to stop that leaves nobody feeling rejected.'],
  'LEH-527': ['If we tried something new, how would we talk about it afterwards?', 'The conversation after, which is usually the harder one.'],
  'LEH-528': ['What would help you talk about sex without feeling judged?', 'What removes the sense of being marked.'],
  'LEH-539': ['What do you want to feel during sex that you are not currently feeling?', 'A feeling that is absent rather than a thing that is wrong.'],
  'LEH-540': ['What is missing from our sex life, rather than actively wrong with it?', 'Missing and wrong are different complaints.'],
  'LEH-541': ['What would you like us to plan together, rather than leave to the mood?', 'Something arranged rather than hoped for.'],
  'LEH-543': ['What surroundings change how you feel physically, for better or worse?', 'Light, noise, tidiness, privacy, temperature.'],
  'LEH-545': ['What small ritual around closeness would you want us to keep?', 'A practice worth protecting.'],


  // ---- Attachment ---------------------------------------------------------
  //
  // Only four, out of 122. This set was written far more carefully than Sex was
  // - almost every card already names its own subject, and several are the best
  // in the corpus ("When did you last feel lonely inside this relationship?").
  //
  // All four here are the same follow-on fault: a question written directly
  // beneath another one and leaning on it.

  // Leans on MNN-258, "How much space do you need after conflict?"
  'MNN-259': ['When you need space after a fight, how do you want me to read it?', 'What your need for space does not mean.'],

  // Leans on MNN-281, "What is the need you have given up on having met?"
  'MNN-282': ['What would have to change for you to ask again for something you gave up on?', 'What would have to be true before you tried once more.'],

  // Leans on MNN-296's neighbours - "more of" what, from whom.
  'MNN-296': ['What would you like more of from me that costs nothing?', 'Attention, words, presence, timing.'],

  // Leans on EFT-181, "What would it mean to you if I said I need you?"
  'EFT-182': ['How hard is it for you to tell me that you need me?', 'Saying it, rather than hearing it.'],


  // ---- Self ---------------------------------------------------------------
  //
  // Five out of 141. Self holds up because its questions are about the person
  // rather than about a shared subject that can be elided - there is no "it"
  // to lean on when the topic is you.

  // Leans on TUR-373, "What would you say to a friend in your exact situation?"
  'TUR-374': ['What stops you giving yourself the advice you would give a friend?', 'Say why that advice does not apply to you.'],

  // Leans on TUR-380, "What do you do to earn love that you should not have to?"
  'TUR-381': ['What are you afraid would happen if you stopped trying to earn love?', 'Your fear about what happens if you stop earning it.'],

  // Leans on TUR-393, "What feedback do you find hardest to receive?"
  'TUR-394': ['How should I give you hard feedback so that you can actually use it?', 'The delivery that lets you use it rather than defend against it.'],

  // Leans on TUR-391, "What is one commitment you can make this week?"
  'TUR-392': ['When you make a commitment to me, how do you want me to hold you to it?', 'The form of accountability you would actually accept.'],

  // D5 and three words. "Admit" what, to whom.
  'TUR-385': ['What do you need to admit to me that you have never said out loud?', 'Something you already know you need to say.'],

  // ---- Conflict -----------------------------------------------------------
  //
  // Four, plus a typo that has been in the corpus since it was written.

  // "not a exit" - an article that has survived every pass over this file.
  'EFT-196': ['What is one signal that means I need a minute, not an exit?', 'A way to pause without it reading as walking out.'],

  // Leans on GOT-047, "Which of my failures do you fear will repeat?"
  'GOT-048': ['If we ever reached our lowest point again, what would you want me to do differently?', 'What you would want from me the second time.'],

  // Leans on REA-122, "Where do you feel one down in this relationship?"
  'REA-123': ['Where do you feel you have the upper hand in this relationship?', 'The other side of it. Power is rarely evenly held.'],

  // Leans on REA-139, "the pattern between us you believe will not change".
  // "believe it could" - could WHAT.
  'REA-140': ['What would you need to see from me to believe our worst pattern could change?', 'The evidence you would need, not the promise.'],

  // Leans on MNN-291, "one sentence I could say in a fight that would land well".
  'MNN-292': ['What is one sentence I could say in a fight that never lands well?', 'The one that makes it worse every time.'],


  // ---- Origin -------------------------------------------------------------
  //
  // Six of 76. All follow-ons: "they", "them", "it", "mine" pointing at the
  // question printed above.

  'MNN-264': ['What do you wish your caregivers had done instead when you were upset?', 'The response you needed and did not get.'],
  'PHA-325': ['Where do you catch yourself repeating what you swore you would not?', 'The pattern you promised yourself you would break.'],
  'PHA-327': ['What have you forgiven your parents for, and what still remains?', 'Forgiveness is rarely total. Say which part is not done.'],
  'PHA-329': ['What did you accept about marriage from your parents without ever examining it?', 'Taken on whole, before you were old enough to question it.'],
  'PHA-334': ['Where do I treat you like someone from my own past?', 'The other half of it. Say where I get you wrong.'],
  'PHA-350': ['What would you need from me to set a boundary with your family?', 'What has to be in place before you could hold it.'],

  // ---- Future -------------------------------------------------------------

  // Leans on FUT-762, "Where do you want to be living in ten years?"
  'FUT-763': ['What do you want to have stopped doing ten years from now?', 'Something you are doing today that you do not want to still be doing.'],

  // Leans on FUT-784, "What are you counting on happening that might not?"
  'FUT-785': ['If the thing you are counting on does not happen, what is your plan?', 'The fallback, if there is one.'],

  // Leans on TUR-397, "What do you want to be different about you in a year?"
  'TUR-398': ['What support would you need from me to be different in a year?', 'Practical support, not encouragement.'],

  // A Sex question filed under Future. "this area" is doing all the work.
  'MAR-497': ['What do you want the next six months to look like for our sex life?', 'Six months is long enough to change something and short enough to picture.'],

  // ---- Work ---------------------------------------------------------------

  // Leans on WRK-812, "How much of your identity is your job?"
  'WRK-813': ['Who would you be without your job?', 'Strip the work out. What is left.'],

  // Leans on WRK-814, "What are you proving, and to whom?"
  'WRK-815': ['What would it cost you to stop trying to prove yourself at work?', 'The price of putting it down.'],

  // Leans on WRK-827, "What has your work cost this relationship?"
  'WRK-828': ['What has your work cost you personally, separately from what it cost us?', 'Your own bill, not the shared one.'],

  // Leans on WRK-833, "Whose career currently takes priority?"
  'WRK-835': ['If my career took priority for a while instead of yours, what would you want?', 'Assume the order swapped. Say what you would need.'],

  // Leans on WRK-845, "Where has ambition made you a worse partner?"
  'WRK-846': ['Where has your ambition made you a better partner?', 'The other side of it, which is usually true as well.'],

  // ---- Home ---------------------------------------------------------------

  // Leans on HOM-745, "What have you stopped asking me to do?"
  'HOM-746': ['When you need something doing at home, what do you do instead of asking me?', 'Doing it yourself, hinting, or letting it sit.'],

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
