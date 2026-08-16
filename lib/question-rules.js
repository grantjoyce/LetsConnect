'use strict';

/**
 * The corpus's construction rules, in one place.
 *
 * These were written for scripts/build-corpus.js, which checks the markdown
 * before it is ever seeded. They now have a second caller: questions written by
 * the generator in the admin area. That is the whole reason for the extraction.
 *
 * A model asked for an open, standalone, non-binary question returns a REQUEST
 * for one. The prompt states the intent; this file is what guarantees it. Two
 * copies of these rules would drift, and the copy that drifted would be the one
 * guarding the newer, less-reviewed content - so there is one copy.
 *
 * Rules are GRADED, because they are not equally certain:
 *
 *   fatal   - the card cannot be served. It is either answerable with a bare
 *             yes/no, or it refers to something the reader has not seen.
 *   review  - probably wrong, but a human has to decide. Flagged, still served.
 *
 * The corpus is right that a validator firing on two fifths of the corpus gets
 * ignored within a day. The answer is a more precise rule, not a lower bar.
 */

const OPENERS = /^(which ones|which of yours|who failed|does that|do those|and |but |so |what about|how about|where did that|why not|same for you|what else)/i;
const FRAGMENT = /^(what|who|where|when|how|why|which)(\s+\w+){0,3}\?$/i;
const DANGLING = /^\W*(that|those|them|it|this|these)\b/i;
const AUXILIARY = /^(do|does|did|is|are|was|were|have|has|had|can|could|will|would|should|shall|am)\b/i;
const CONTEXT_EXAMPLE = /\b(for example|e\.g\.|such as|like when|perhaps you)\b/i;

/**
 * Possible dangling demonstrative. ADVISORY ONLY.
 *
 * English uses "that" as a relative pronoun ("the first image that arrives")
 * and as a pointer ("is that arrangement still right"). The first is correct
 * and extremely common; the second cannot stand alone. Telling them apart needs
 * a part-of-speech parser, and a regex approximation fires on roughly one
 * question in twenty-five - almost all of them correct English. So it advises
 * rather than blocks.
 */
const DEMONSTRATIVE = /\b(that|those|these)\s+(?!(you|we|i|he|she|they|is|was|are|were|has|have|had|do|does|did|would|could|will|can|should|makes|made|feel|feels|felt|sounds|reminds|stayed|landed|hurts|works|matters|means|costs|helps|comes|goes|keeps|stops|shows|puts|gets|takes|needs|belongs|happened|changed|carries|protects|drives|sits|lives|runs|much|many|way|kind|sort|one|thing)\b)(\w+)/i;

/**
 * Check one question and its context line.
 *
 * @param {string} question
 * @param {string|null} context
 * @returns {{issues: Array<{level: string, why: string}>, fatal: boolean}}
 */
function checkQuestion(question, context) {
  const q = String(question || '').trim();
  const c = context === null || context === undefined ? '' : String(context).trim();
  const issues = [];

  if (!q) {
    return { issues: [{ level: 'fatal', why: 'no question' }], fatal: true };
  }

  if (q.split(/\s+/).length < 5) issues.push({ level: 'fatal', why: 'too short to stand alone' });

  // An auxiliary opener is only binary if there is no either/or in it. "Are you
  // a spender or a saver?" opens with "Are" and cannot be answered yes or no,
  // so treating it as binary would be a false positive.
  if (AUXILIARY.test(q) && !/\bor\b/i.test(q)) {
    issues.push({ level: 'fatal', why: 'answerable with yes or no' });
  } else if (AUXILIARY.test(q)) {
    issues.push({
      level: 'review',
      why: 'opens on an auxiliary; either/or rescues it, but it reads closed',
    });
  }

  if (OPENERS.test(q) || FRAGMENT.test(q) || DANGLING.test(q)) {
    issues.push({ level: 'fatal', why: 'reads as a follow-on, not standalone' });
  }

  const dem = q.match(DEMONSTRATIVE);
  if (dem) {
    issues.push({
      level: 'review',
      why: `check "${dem[1]} ${dem[3]}" reads on its own (usually a relative pronoun and fine)`,
    });
  }

  if (!c) issues.push({ level: 'fatal', why: 'missing context line' });
  else {
    if (c.split(/\s+/).length > 18) issues.push({ level: 'review', why: 'context over 18 words' });
    if (c.endsWith('?')) issues.push({ level: 'review', why: 'context asks a second question' });
    if (CONTEXT_EXAMPLE.test(c)) {
      issues.push({ level: 'review', why: 'context supplies an example answer' });
    }
  }

  return { issues, fatal: issues.some((i) => i.level === 'fatal') };
}

module.exports = {
  checkQuestion,
  // Exported so build-corpus can keep applying its ref-scoped rules (duplicate
  // IDs, the hand-reviewed standalone list) around the shared ones.
  patterns: { OPENERS, FRAGMENT, DANGLING, AUXILIARY, CONTEXT_EXAMPLE, DEMONSTRATIVE },
};
