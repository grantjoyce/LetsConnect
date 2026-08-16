# Couples Question Corpus

**850 original questions across 16 blocks.**

Every question here is newly written. None is lifted from a published card deck, book or app. The frameworks are attributed as lenses. Frameworks are not protected. Expression is. You own this text.

---

## How this was built

Read this section before using, extending or querying the corpus. It explains the constraints the content was written under. Violating them silently breaks the legal position and the product logic.

### 1. What this is

A seed question bank for a couples connection application. It is source material, not a shipped deck. It has been tagged for grouping and sequencing work, not for direct display.

### 2. Provenance, and the constraint that matters most

The corpus was compiled from a list of twenty authorities on relationships, intimacy and connection. It was **not** compiled by extracting their published questions.

That distinction is the whole legal foundation of the file. Existing commercial question banks, including the Gottman card decks, We're Not Really Strangers, the Diary of a CEO Conversation Cards, Esther Perel's card game and The Skin Deep's material, are protected works with authored content. Copying them into a commercial product invites a licensing claim and produces a product with no defensible asset.

What is not protected is the underlying framework. Attachment theory, the brakes and accelerators model of desire, family of origin wounds, harmony and repair cycles: these are ideas. Ideas can be built on freely.

So the method was: take each authority's framework, identify the constructs it operates on, and write original questions that interrogate those constructs. Attribution runs to the lens, never to a text.

**Instruction to any agent extending this file: do not source questions from published decks, books, apps or their marketing copy. Write to the framework. If you cannot write an original question for a construct, leave the gap and flag it.**

**Provenance changes at tranche two.** Blocks GOT through LEH are lens derived, each attributed to an authority's framework. Blocks OPN, MON, HOM, FUT and WRK are subject derived, written to the domain itself. That is deliberate and honest: no authority on the reference list studies money, division of household labour, or the economics of ageing. Attaching those questions to a lens would be a false attribution. Where a block is subject derived the heading says so. Expect future blocks to be subject derived too, because the remaining gaps sit outside what relationship theorists write about.

### 3. Question construction rules

Every question was written against a fixed set of rules, drawn largely from Topaz Adizes's work on question architecture. Extensions must follow them or the corpus loses consistency.

- **Not binary.** No question answerable with yes or no. "Do you feel loved" is rejected. "When do you feel most loved" is accepted.
- **Directed at the self, not the partner.** "What do you do when you feel rejected" rather than "why do you always withdraw". Questions that invite prosecution were excluded.
- **One idea per question.** No compound questions. They produce partial answers.
- **No embedded premise.** A question must not smuggle in an accusation or a diagnosis.
- **No therapeutic jargon.** No "attachment style", "raw spot", "adaptive child" or similar in the question text itself. The framework informs the question. It does not appear in it.
- **Present or specific past tense.** "When did you last feel" outperforms "have you ever felt", because it forces a concrete instance rather than a general position.
- **Answerable aloud in under two minutes.** Anything requiring an essay was cut.
- **Standalone, without exception.** Every question must be complete on its own. Each one is displayed as a single card with nothing else visible. There is no follow on mechanism, no parent and child linking, and none is planned. A question that needs a preceding question to make sense is a defect, not a design choice. This rule overrides every other consideration: if a question can only be made to work as a follow on, it is cut or rewritten, never kept as a pair. No unanchored "that", "it", "those" or "them". No "which ones", "who failed to", "where did that come from", "does that match". Nothing that assumes the reader has just seen another card.
- **Plain English.** Written to be understood by a person reading it on a phone at the end of a long day.

### 4. The Context column

One short line per question, written for the person answering, not the person asking. It exists because a question like "What have you outgrown that we are still doing?" is clear to someone fluent in this kind of conversation and opaque to someone who is not. Every question has one. 550 of 550.

**The rule that matters: context opens the territory, it never supplies an answer.**

This is the failure mode and it is easy to fall into. A helper that offers a sample answer anchors the response, and every couple then produces roughly the same reply. The value of the question dies. Compare:

- Correct, for PER-075: *A habit, a role, or an arrangement you have grown past.* Names the categories, supplies no content.
- Wrong: *For example, always spending Sunday with your in laws.* Now everybody answers about in laws.

**Construction rules for context lines:**

- Under eighteen words. It is secondary text on a card, not a paragraph.
- Addressed to the answerer, in the second person or as a bare instruction.
- Names the territory, the category, or the distinction the question turns on.
- May legitimately say what the question does *not* mean, which is often the most useful thing it can do. "Emotional age, not actual." "Interesting, not attractive." "Behaviour, not feeling."
- May normalise where a question could produce shame. "Some people feel desire first, others feel it once things begin. Both are normal." This is the one case where the helper can reduce the pressure to give a particular answer.
- Never gives an example answer, never implies a correct answer, never asks a second question.
- Never repeats the question in different words. If the line adds nothing, the question needs rewriting instead.

**Display: reveal on tap. This is decided, not an open question.**

The card shows the question alone. The context line is hidden behind a tap and is never displayed by default.

Reasons, so the decision is not relitigated later:

- The question has to carry the moment. A card that arrives pre explained reads as a worksheet rather than a prompt, and the pause before someone answers is where the work happens.
- Most couples will not need it most of the time. Permanently displaying an explanation to people who already understood the question is condescending, and it teaches them to skim.
- Reaching for the help is itself a signal. If one partner taps and the other does not, that is information about who finds this territory harder, and it is information the product can use.
- It keeps the card visually clean, which matters more on a phone than any other consideration here.
- Tap rate per question is a genuinely useful metric. A question tapped by most users is not clear enough and should be rewritten. Instrument it.

The interaction should be lightweight. A tap on the card, or a small marker, revealing the line in place. Not a modal, not a separate screen, no confirmation. The user must be able to get back to the bare question in one action.

**Do not** make the reveal a setting buried in preferences, and do not add an onboarding step explaining that context exists. If the affordance needs explaining, it is the wrong affordance.

### 5. Validation

Run this after any extension or bulk edit. It enforces the standalone rule, which is the rule most easily broken by generating questions in batches.

```python
import re, sys

ROWS = re.compile(r'\|\s*([A-Z]{3}-\d{3})\s*\|\s*(D\d)\s*\|\s*(\w+)\s*\|\s*(\w*)\s*\|\s*(.+?)\s*\|\s*$')

# Openers that can only follow another question
OPENERS  = re.compile(r'^(which ones|which of yours|who failed|does that|do those|'
                      r'and |but |so |what about|how about|where did that|why not|'
                      r'same for you|what else)', re.I)
# Two to four word stubs
FRAGMENT = re.compile(r'^(what|who|where|when|how|why|which)(\s+\w+){0,3}\?$', re.I)
# Sentence opens on a pronoun with no antecedent
DANGLING = re.compile(r'^\W*(that|those|them|it|this|these)\b', re.I)
# Demonstrative early in the sentence, excluding the expletive "it"
EARLY    = re.compile(r'^(\w+\s+){0,2}(that|those|these)\b(?!\s+'
                      r'(you|we|i|he|she|they|is|was|makes|made|feel|sounds|has|have|'
                      r'do|does|did|would|could|will|can|are|were|reminds|stayed|landed|'
                      r'hurts|works|matters|means|costs|helps|comes|goes|keeps|stops|'
                      r'shows|puts|gets|takes|needs|belongs|happened|changed|carries|'
                      r'protects|drives|sits|lives|runs))', re.I)
BINARY   = re.compile(r'^(do|does|did|is|are|was|were|have|has|had|can|could|will|'
                      r'would|should|shall|am)\b', re.I)

def check(path):
    out = []
    for line in open(path):
        m = ROWS.match(line)
        if not m:
            continue
        qid, _, _, _, q = m.groups()
        if len(q.split()) < 5:
            out.append((qid, "too short to stand alone", q))
        if BINARY.match(q):
            out.append((qid, "opens as yes or no", q))
        if OPENERS.match(q) or FRAGMENT.match(q) or DANGLING.match(q) or EARLY.match(q):
            out.append((qid, "chain dependency", q))
    return out


CTXCOL = re.compile(r'\|\s*([A-Z]{3}-\d{3})\s*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$')

def check_context(path):
    fails = []
    for line in open(path):
        m = CTXCOL.match(line)
        if not m:
            continue
        qid, q, ctx = m.groups()
        if not ctx.strip():
            fails.append((qid, "missing context line", q))
            continue
        if len(ctx.split()) > 18:
            fails.append((qid, "context too long", ctx))
        if ctx.rstrip().endswith("?"):
            fails.append((qid, "context asks a second question", ctx))
        if re.search(r'\b(for example|e\.g\.|such as|like when|perhaps you)\b', ctx, re.I):
            fails.append((qid, "context supplies an example answer", ctx))
    return fails

if __name__ == "__main__":
    results = check(sys.argv[1]) + check_context(sys.argv[1])
    for qid, reason, q in results:
        print(f"{qid}  {reason}\n    {q}")
    print(f"\n{len(results)} flagged")
    sys.exit(1 if results else 0)
```

Against the current corpus it returns zero. That is the expected state. Any hit after an extension is a question to fix or cut, not a threshold to adjust. Review every hit by hand: a false positive costs seconds, a missed dependency ships a card that reads as nonsense. It exits with status 1 when anything is flagged, so it can sit in a pre commit hook or a build step.

An earlier version of this check flagged 216 of 550. A validator that fires on two fifths of the corpus gets ignored within a day and is worse than no validator. If a rule starts producing noise at that scale, tighten the rule rather than raising the threshold.

The test to apply on review is simple. Read the question with no other question visible and no conversation preceding it. If a reasonable person would ask "which ones" or "what belief", it fails.

### 6. Escalation chains

Standalone questions cost you escalation. A card cannot say "and why do you think that is". The Chain column recovers that at deck level instead of card level.

**The two rules are not in tension.** Every card still stands alone. A chain is a recommended running order for cards that circle the same construct at increasing exposure. Pull any single card out of a chain and it still makes complete sense. The chain adds value when the cards are played in order. It is never required for comprehension.

**Column format:** `CHAINNAME position/total`. Blank means the question is a single, playable anywhere.

```
Chain: BRAKES 1/5   Chain: BRAKES 3/5   Chain: (blank)
```

Illustrative IDs are deliberately omitted here so that parsers scanning this file for table rows do not pick up the example as data.

**Current state:** 69 chains covering 297 questions. 253 questions remain singles. Chain lengths run from three to eight, with four the most common.

**Invariants, enforced by script:**

- A question belongs to at most one chain. Membership in two chains makes running order ambiguous.
- Minimum chain length is three. Two cards is a pair, not an escalation.
- Depth never decreases along a chain. Position one is the shallowest entry, the final position the most exposed. Chains are stable sorted by depth, which preserves the authored order inside a depth band while guaranteeing the escalation never steps backwards.
- Chain names are unique across the corpus and carry no lens prefix, because chains cross lenses and domains freely.

**Product behaviour this is designed for:**

- A couple who accept a chain get a deliberate arc rather than a random walk into their worst subject.
- A couple who stop after card two have still had a complete conversation, because card two was never a fragment.
- Chains give you a natural unit for a session. A four card chain is roughly twenty minutes of real conversation.
- A chain crossing into D4 or D5 lets you place the consent gate at the transition point rather than at the start, so the couple opt in with a clear view of where it is heading.

**Extending:** chains are defined in a single dictionary mapping chain name to an ordered list of IDs. Add to that structure, then re run the chain validator, which checks single membership, minimum length and depth monotonicity, and re sorts. Never hand edit the Chain column in the table: the position and total fields are generated and will drift out of sync.

**Watch for this failure:** building a chain tempts you to write dependent questions again, because the cards are adjacent in your head. PHA-321 was caught doing exactly that during chain construction and had to be rewritten. Run the standalone validator after every chain change, not just after writing new questions.

### 7. ID scheme

Format: `PFX-NNN`. Three letter lens prefix, three digit sequential number, unique across the whole corpus.

Prefixes are the first three letters of the source authority's surname. GOT Gottman, PER Perel, REA Real, SOL Solomon, MNN Menanno, PHA Pharaon, TUR Turecki, NAG Nagoski, MAR Marin, LEH Lehmiller. EFT is the single exception, drawing on the wider Emotionally Focused body of work rather than one author's books.

MNN is deliberately not MEN. Menanno's natural prefix collides with a gendered reading in a corpus that deals heavily with gender, desire and attachment. Ambiguous identifiers cost nothing to avoid at design time and cause confusion later.

**Numbers are permanent.** Never renumber. When questions are cut, retire the ID rather than reusing it. When questions are added, continue from the highest number in that lens block or open a new range. Analytics on performance will be keyed to these IDs.

### 8. Why separate axes rather than one scale

The corpus originally used a single four level scale that conflated two unrelated things: how emotionally exposing a question is, and what it is about. That collapsed a mild question about sexual timing into the same bucket as a question about whether the relationship should end. Both simply felt risky.

They are different axes and were separated.

- **Depth** measures emotional exposure and nothing else.
- **Domain** measures subject matter and nothing else.
- **Stakes** is a binary flag on the small set of questions whose honest answer forces a decision, regardless of their depth or domain.

The product consequence: a couple can select depth and domain independently. They can go deep on everything except sex, or discuss sex without touching conflict. A single scale offers only a volume knob and forces every couple through the same door.

### 9. How the tags were assigned

Depth was assigned per question by judgement against the definitions in the table below, then reviewed as a block per lens for internal consistency.

Domain was assigned by a rule set: a default domain per lens, overridden by range rules and then by explicit per question overrides where the content clearly departs from its lens. The full rule set is reproducible. Domain does not follow lens, and several lenses span four or more domains.

Stakes was assigned by hand to 27 questions. The test applied: once this is answered honestly, does something have to happen. Depth was not a factor.

The flag was renamed and re audited at tranche two. Under the previous name, Volatility, 21 of 22 flagged questions sat at D5, which meant the flag was doing almost nothing the depth scale was not already doing. Separating exposure from consequence fixed that. Four D4 questions gained the flag and several D5 questions lost it.

### 10. Known defects

These are real and should be fixed rather than worked around.

- **Chain dependency, found and fixed.** The first draft was written in sequence within each lens, which produced conversational chains. Twenty two questions relied on the preceding question for their meaning, including one broken fragment reading "How does exhaustion?". All twenty two have been rewritten as standalone. The failure mode is systematic rather than careless: writing a lens block in one pass creates chains automatically. Any agent adding questions in bulk will reproduce it. Run a fragment scan after every extension, checking for questions under six words, unanchored pronouns, and openers such as "which ones", "where did that" and "does that".
- **D1 is starved.** Twenty six questions. Onboarding is the only part of the corpus every user touches and it is the thinnest part.
- **Money is effectively absent.** Two questions. Money is among the most common subjects of recurring conflict and none of the source authorities study it, so no framework on the list generates questions about it. This gap must be filled from outside the source list.
- **Future and Everyday stop at D2.** Neither domain produces anything deep. That is a writing gap, not a property of the domains.
- **Sex is overweight at 157 questions**, an artefact of three of the eleven lenses being sex specialists. Do not treat that proportion as a product recommendation.
- **Deliberate near duplication.** Several questions recur in similar form across lenses because the lenses genuinely converge. They have been left in. Deduplication should wait for performance data, since the surviving phrasing is the product.

### 11. What this file is not

It is not a therapeutic instrument, not validated, and carries no clinical claim. It is not sequenced. It is not final copy. It is raw material with enough structure to be sorted.

---

## Tagging

Five columns beyond the question. Depth and Domain are independent axes. Stakes is a flag. Chain is an optional running order. Context is a helper line for the answerer.

### Depth. Emotional exposure only.

| Tag | Name | Meaning |
|---|---|---|
| D1 | Open | Answerable on first use. No exposure. |
| D2 | Reflective | Requires thought. Mild self disclosure. Comfortable in public. |
| D3 | Personal | Real disclosure. Assumes existing trust. |
| D4 | Exposed | Shame, fear or unmet need. Assumes a stable relationship. |
| D5 | Unspoken | Things never said to anyone, or never said to me. The most guarded material a person holds. |

### Domain. Subject matter only.

Depth does not follow domain. A Sex question can sit at D2. A Money question can sit at D5.

Eleven domains: Self, Attachment, Conflict, Origin, Sex, Money, Home, Work, Future, Meaning, Social.

**Everyday was dissolved at tranche two.** It held 32 cards, every one of them at D1 or D2, because it was never a subject. It was a register, and depth already handles register. Keeping it produced three permanently empty cells and hid the fact that ordinary life has real subjects underneath it: work, home, money, friendship. All 32 cards were reassigned individually to Self, Attachment, Work, Social, Conflict or Future. If a future domain proposal caps out at D2 by definition, it is a register too and should be rejected.

| Domain | Count |
|---|---|
| Everyday | 32 |
| Self | 108 |
| Attachment | 93 |
| Conflict | 78 |
| Origin | 68 |
| Sex | 157 |
| Future | 12 |
| Money | 2 |

### Stakes.

27 questions carry a Stakes flag. The test is not how exposing the question is. It is whether the honest answer could force a decision: something that, once said, has to be acted on. A hidden debt, a crossed line, a doubt about staying.

Stakes is independent of Depth. Most flagged questions sit at D5 because guarded material and consequential material overlap, but four sit at D4, and plenty of D5 questions carry no flag at all. Asking someone about the worst year of their childhood is maximally exposing and changes nothing about the relationship. Asking whether there is a debt in your name changes something the moment it is answered.

These require a deliberate mutual unlock, not a tap.

### Distribution

| | D1 | D2 | D3 | D4 | D5 | Total |
|---|---|---|---|---|---|---|
| Self | 28 | 58 | 36 | 15 | 4 | 141 |
| Attachment | 24 | 34 | 40 | 19 | 5 | 122 |
| Conflict | 6 | 30 | 13 | 18 | 18 | 85 |
| Origin | 10 | 28 | 25 | 10 | 3 | 76 |
| Sex | 13 | 64 | 58 | 23 | 9 | 167 |
| Money | 8 | 26 | 24 | 9 | 3 | 70 |
| Home | 10 | 32 | 17 | 1 | 0 | 60 |
| Work | 11 | 16 | 21 | 3 | 0 | 51 |
| Future | 9 | 28 | 24 | 7 | 3 | 71 |
| Meaning | 4 | 0 | 0 | 0 | 0 | 4 |
| Social | 3 | 0 | 0 | 0 | 0 | 3 |
| **Total** | 126 | 316 | 258 | 105 | 45 | 850 |


---

## GOT. Gottman lens
Love maps, fondness and admiration, turning towards bids, dreams inside conflict, rituals of connection.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| GOT-001 | D2 | Self |  | CHECKIN 2/3 | What has been on your mind this week that I have not asked you about? | Not a test. Just the thing you have been turning over without mentioning. |
| GOT-002 | D2 | Self |  |  | Which part of your day do you most look forward to at the moment? | Any part counts. The commute, the first coffee, the hour after everyone is asleep. |
| GOT-003 | D1 | Work |  |  | Who at work is currently taking up the most of your attention, and why? | Attention, not affection. Who occupies your head on the drive home. |
| GOT-004 | D1 | Attachment |  |  | What is something small I did recently that landed well with you? | Small is the point. A message, a chore done, something you noticed. |
| GOT-005 | D1 | Self |  |  | What are you quietly proud of right now? | Something you have not announced. Quiet pride counts more than public wins. |
| GOT-006 | D1 | Self |  | CHECKIN 1/3 | What is stressing you that you have decided is too minor to mention? | The things you filter out as too trivial to raise. Those accumulate. |
| GOT-007 | D1 | Social |  |  | Which friend of yours do you wish you saw more of? | Friendships slip quietly when life gets full. Name who has slipped. |
| GOT-008 | D1 | Self |  |  | What would make this coming weekend feel restorative for you? | Restorative, not productive. What would leave you actually recovered. |
| GOT-009 | D1 | Future |  | HORIZON 1/3 | What is one thing you want to do before the end of this year? | Something specific enough to diarise, not a general intention. |
| GOT-010 | D2 | Future |  | HORIZON 2/3 | When you picture us five years from now, what is the first image that arrives? | First image, not a considered plan. Where are you, and who is there. |
| GOT-011 | D2 | Attachment |  |  | What do I do that makes you feel most respected? | Respect and love are different. This one is about being taken seriously. |
| GOT-012 | D2 | Attachment |  |  | Which of my qualities did you notice first, and does it still hold? | First impressions often name something real. Say whether it survived. |
| GOT-013 | D2 | Future |  | DREAMS 1/3 | What is a hope you have not said out loud because it sounds unrealistic? | The one you have not said because it invites an argument or a raised eyebrow. |
| GOT-014 | D2 | Origin |  | RITUAL 1/3 | What tradition from your childhood do you want to keep alive? | Any repeated thing. A meal, a holiday, a phrase, a way of marking something. |
| GOT-015 | D2 | Attachment |  | RITUAL 2/3 | Which ritual do we already have that you would hate to lose? | Something you two already do. Small and unremarkable is fine. |
| GOT-016 | D2 | Self |  | RITUAL 3/3 | What does a good ordinary Tuesday look like for you? | Not a highlight. An ordinary day that leaves you feeling well. |
| GOT-017 | D2 | Attachment |  |  | When do you feel most like yourself around me? | The situations where you stop editing yourself. |
| GOT-018 | D2 | Self |  |  | What do you want to be known for by the people close to you? | By the handful of people who matter, not by a wider audience. |
| GOT-019 | D2 | Self |  |  | What is a skill you want to build in the next two years? | Any skill. Practical, professional, physical, creative. |
| GOT-020 | D2 | Origin |  |  | Which of your parents do you find yourself becoming, and how do you feel about it? | Everyone inherits something. Say which parent and whether you welcome it. |
| GOT-021 | D2 | Attachment |  |  | What does support look like when you are under pressure? | Describe the actions. Different people need presence, practical help, or space. |
| GOT-022 | D2 | Conflict |  |  | How do you prefer bad news to be delivered to you? | Timing, setting, directness. People differ more than they expect here. |
| GOT-023 | D2 | Attachment |  |  | What kind of praise actually reaches you? | Some praise lands and some bounces off. Say what gets through. |
| GOT-024 | D2 | Attachment |  |  | Which of my habits do you find endearing? | The small irritating things you have come to like. |
| GOT-025 | D2 | Self |  |  | What is something you have changed your mind about since we met? | A position you held then and do not hold now. |
| GOT-026 | D2 | Attachment |  |  | What do you want more of from me that you have never requested directly? | Something you have hinted at, hoped for, or assumed I would work out. |
| GOT-027 | D2 | Conflict |  |  | Which of our arguments keeps returning in a different costume? | Same fight, different subject. Name the shape it keeps taking. |
| GOT-028 | D2 | Future |  | HORIZON 3/3 | What are you afraid of losing as we get older together? | Ageing changes what is at stake. Name what you would not want to lose. |
| GOT-029 | D2 | Attachment |  | CHECKIN 3/3 | What do you need from me on a day when you have nothing left? | On the days you are empty. Practical answers welcome. |
| GOT-030 | D3 | Attachment |  | BIDS 2/4 | When you reach for me and I miss it, what does that feel like? | A bid is any small attempt at contact. This is about the ones I miss. |
| GOT-031 | D3 | Attachment |  | DREAMS 2/3 | What dream of yours is sitting underneath the thing we keep fighting about? | Underneath most repeated arguments is something someone wants. Name yours. |
| GOT-032 | D3 | Attachment |  | BIDS 3/4 | Where do you feel unseen by me? | Where you feel looked past rather than looked at. |
| GOT-033 | D3 | Attachment |  | BIDS 1/4 | What have I stopped noticing that you wish I still noticed? | Something I used to comment on or notice, and stopped. |
| GOT-034 | D4 | Attachment |  |  | When did you last feel lonely inside this relationship? | Lonely while together is different from lonely alone. Name a time. |
| GOT-035 | D3 | Attachment |  | BIDS 4/4 | What do you carry that you have never asked me to help with? | A worry, a responsibility, or a load you decided was yours to carry. |
| GOT-036 | D4 | Attachment |  |  | What did you give up to be with me, and do you regret any of it? | Every partnership costs something. Name yours honestly, including the regret if there is one. |
| GOT-037 | D3 | Attachment |  |  | Which of my criticisms has stayed with you longest? | Criticism sticks unevenly. Say which one stayed. |
| GOT-038 | D3 | Origin |  |  | What do you wish I understood about your family that I clearly do not? | Family dynamics are hard to see from outside. Explain what I have got wrong. |
| GOT-039 | D3 | Attachment |  |  | When do you protect me from your real opinion? | The moments you soften your real view to keep things calm. |
| GOT-040 | D4 | Attachment |  |  | What version of yourself do you hide from me? | A part of you that exists but does not show up here. |
| GOT-041 | D3 | Attachment |  |  | What is the story you tell yourself when I go quiet? | Silence gets interpreted. Say what you assume mine means. |
| GOT-042 | D4 | Attachment |  |  | Where in our life together do you feel like you are the only one trying? | Effort feels unequal in most couples. Name where it feels that way to you. |
| GOT-043 | D3 | Attachment |  | DREAMS 3/3 | What would you need to hear from me to feel genuinely on the same team? | Specific words or actions. Not a general reassurance. |
| GOT-044 | D4 | Attachment |  |  | What have you forgiven me for without ever telling me? | Something you let go of internally without ever raising it. |
| GOT-045 | D5 | Conflict |  | DAMAGE 3/4 | What resentment are you still carrying from something we never finished? | Resentment from an argument that stopped rather than finished. |
| GOT-046 | D5 | Conflict |  | DAMAGE 4/4 | What is the closest we have come to real damage, and what saved it? | The nearest miss. What you think prevented it going further. |
| GOT-047 | D4 | Conflict |  | DAMAGE 1/4 | Which of my failures do you fear will repeat? | Not what I might do. What you fear I will do again. |
| GOT-048 | D4 | Conflict |  | DAMAGE 2/4 | What would you want me to do differently if we ever reached that point again? | Practical. What would actually help if we were back there. |
| GOT-049 | D5 | Conflict |  |  | What is the one subject we both avoid, and what makes it dangerous? | The subject you both steer around. Say what makes it dangerous. |
| GOT-050 | D4 | Conflict |  |  | If you could rewrite how one specific conflict went, what would you change about your own part? | Your own part only. Not mine. |
---

## PER. Perel lens
Desire inside commitment, otherness, autonomy against security, eroticism, betrayal and repair.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| PER-051 | D1 | Attachment |  | PULL 1/4 | When do you find me most interesting? | Interesting, not attractive. When you want to know what I think. |
| PER-052 | D1 | Self |  | AUTONOMY 1/5 | What do you do that has nothing to do with me and everything to do with you? | Something entirely yours. A pursuit, a friendship, a way of spending time. |
| PER-053 | D1 | Self |  | ALIVENESS 1/4 | Where do you feel most alive lately? | Alive is not the same as happy. Where do you feel switched on. |
| PER-054 | D2 | Origin |  | EROSORIGIN 1/3 | What did desire look like in the house you grew up in? | What children absorb about desire without being told. Warmth, avoidance, tension, absence. |
| PER-055 | D2 | Sex |  | PULL 2/4 | When you watch me from across a room, what do you notice? | Watching from a distance is different from being close. Say what you see. |
| PER-056 | D2 | Sex |  | PULL 3/4 | What kind of distance between us makes you want me more? | Some separation creates wanting and some creates worry. Describe the useful kind. |
| PER-057 | D2 | Origin |  | EROSORIGIN 2/3 | What did you learn about love before you were old enough to question it? | The lessons that arrived before you could evaluate them. |
| PER-058 | D2 | Self |  | AUTONOMY 2/5 | Which part of yourself have you set aside to make this relationship work? | An interest, a habit, or a version of yourself you have parked. |
| PER-059 | D2 | Self |  | AUTONOMY 3/5 | What do you want that has nothing to do with being a good partner? | Wanting that has nothing to do with duty or being good. |
| PER-060 | D2 | Self |  | ALIVENESS 2/4 | When did you last surprise yourself? | Any recent moment where you did something out of character. |
| PER-061 | D2 | Self |  | AUTONOMY 4/5 | What would you pursue if you knew I would not feel abandoned? | Say the pursuit, and what makes you think it would cost us. |
| PER-062 | D2 | Sex |  | PULL 4/4 | How much mystery do you want between us? | Some people want full transparency and some want space unaccounted for. |
| PER-063 | D2 | Sex |  |  | What makes you feel chosen rather than merely kept? | Chosen means actively wanted. Kept means simply retained. |
| PER-064 | D2 | Sex |  |  | Where does security tip over into boredom for you? | Security is good until it becomes flat. Say where the line sits for you. |
| PER-065 | D2 | Sex |  |  | What role does risk play in what you find attractive? | Risk shows up differently for everyone. Physical, social, emotional, or none. |
| PER-066 | D2 | Self |  |  | Which of your ambitions frightens you? | An ambition big enough to frighten you. |
| PER-067 | D2 | Self |  |  | What do you need permission for that I have never actually withheld? | Something you are waiting to be allowed, when nobody is stopping you. |
| PER-068 | D2 | Self |  |  | When do you feel like a person rather than a function? | Function is the role you play. Person is who you are underneath it. |
| PER-069 | D2 | Self |  |  | What is the difference between being needed and being wanted, in your experience? | Both feel like love and they are not the same. Describe the difference for you. |
| PER-070 | D2 | Sex |  |  | Which of us initiates more, and what does that mean to you? | Say who starts things more often, and what that pattern says to you. |
| PER-071 | D4 | Self |  | LONGING 2/4 | What do you long for that you think I cannot give you? | Something you want that you have privately decided I am not capable of. |
| PER-072 | D3 | Self |  |  | Where has responsibility replaced play in our life? | Where the logistics of life crowded out the fun. |
| PER-073 | D3 | Sex |  | EROSORIGIN 3/3 | What did you imagine your love life would be, and how does the real one compare? | What you expected your intimate life to be, against what it is. |
| PER-074 | D4 | Self |  | LONGING 3/4 | When did you last feel invisible to me? | Being physically present and unnoticed. Name when. |
| PER-075 | D3 | Self |  |  | What have you outgrown that we are still doing? | A habit, a role, or an arrangement you have grown past. |
| PER-076 | D3 | Self |  |  | Which conversation between us stopped happening, and when? | Some topics simply stop coming up. Say which one and roughly when. |
| PER-077 | D4 | Self |  |  | What part of your inner life do you keep entirely to yourself? | The thoughts you never voice to anyone, not just to me. |
| PER-078 | D3 | Sex |  | LONGING 1/4 | When you feel drawn to someone else, what is it actually a signal about? | Attraction elsewhere usually points at something missing or wanted. Say what. |
| PER-079 | D3 | Self |  |  | What would you have to believe about me to be fully open? | The condition you would need met to hold nothing back. |
| PER-080 | D3 | Self |  | AUTONOMY 5/5 | Where do you feel domesticated in a way that costs you? | Domesticated meaning tamed, predictable, managed. Where does it cost you. |
| PER-081 | D3 | Self |  |  | What do you envy in other couples? | Envy is information. Say what other couples appear to have. |
| PER-082 | D3 | Sex |  |  | How has parenthood, or the absence of it, changed what you want from me? | Children, or their absence, changes what people need. Say how for you. |
| PER-083 | D4 | Self |  |  | What have you never told me because you were protecting my image of you? | Something withheld to protect how I see you, not to deceive me. |
| PER-084 | D4 | Self |  | LONGING 4/4 | Which version of us do you miss? | A previous version of us. Say which and what it had. |
| PER-085 | D3 | Self |  |  | What are you postponing until things calm down? | The things filed under later. Say what is on that list. |
| PER-086 | D3 | Self |  |  | What do you need from me in order to take a risk? | Specific. What has to be in place before you can risk something. |
| PER-087 | D5 | Conflict | yes | BETRAYAL 2/4 | What would betrayal look like to you, in your own definition rather than the standard one? | Your definition, not the conventional one. People draw this line differently. |
| PER-088 | D5 | Conflict | yes | BETRAYAL 3/4 | Where have you already crossed a line you set for yourself? | A line you set for yourself and stepped over. Not necessarily with anyone else. |
| PER-089 | D5 | Conflict | yes |  | What secret do you keep that is more about your identity than about hiding something from me? | Some secrets protect an identity rather than conceal an act. |
| PER-090 | D4 | Conflict |  |  | If we had to rebuild trust from the ground up, what would you insist on? | Rebuilding from zero. Say what your non negotiables would be. |
| PER-091 | D4 | Conflict |  | BETRAYAL 1/4 | What agreement between us was never actually agreed, only assumed? | An unspoken rule you assumed we both signed up to. |
| PER-092 | D5 | Conflict | yes | BETRAYAL 4/4 | What do you fear I would do if you told me the whole truth about your wanting? | Your fear about my reaction, not the content itself. |
| PER-093 | D5 | Sex |  | EXIT 2/4 | Which of your desires have you decided are not permitted? | Wants you have ruled out as not permitted, by yourself or by us. |
| PER-094 | D5 | Conflict | yes | EXIT 4/4 | What would it take for you to leave? | Honest. Not a threat. What conditions would make leaving the right choice. |
| PER-095 | D5 | Conflict | yes | EXIT 3/4 | What are you staying for? | The real reasons, including the unromantic ones. |
| PER-096 | D4 | Conflict |  | EXIT 1/4 | What would you want me to know if this were our last conversation? | If there were no more conversations after this one. |
| PER-097 | D3 | Self |  | ALIVENESS 3/4 | What does aliveness mean to you now, compared with ten years ago? | Aliveness changes with age. Compare then and now. |
| PER-098 | D2 | Self |  |  | When do you feel most free while still being with me? | Freedom inside commitment, not instead of it. |
| PER-099 | D2 | Future |  |  | What would you like us to build that is entirely new? | Something neither of us has done before. |
| PER-100 | D3 | Self |  | ALIVENESS 4/4 | What in you is still unclaimed? | A part of you that nobody, including you, has fully claimed. |
---

## REA. Terry Real lens
Relational stance, adaptive child against wise adult, harmony, disharmony and repair.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| REA-101 | D1 | Conflict |  |  | What does winning an argument actually get you? | Think past the moment of victory. What are you actually left holding. |
| REA-102 | D2 | Conflict |  | FIGHTSELF 1/4 | When we disagree, what are you usually protecting? | Protecting is different from proving. Name what feels at risk. |
| REA-103 | D2 | Conflict |  | FIGHTSELF 2/4 | Which version of you shows up when you feel criticised? | Everyone has a defensive version. Describe yours from the outside. |
| REA-104 | D2 | Conflict |  |  | How old do you feel in the middle of our worst arguments? | Emotional age, not actual. Many people drop to a much younger self. |
| REA-105 | D2 | Origin |  | FIGHTORIGIN 1/4 | What did conflict look like in your house growing up? | Loud, silent, avoided, or explosive. Describe the household pattern. |
| REA-106 | D2 | Origin |  | FIGHTORIGIN 2/4 | Who repaired things in your family, and how? | Somebody usually restores the peace. Say who and by what method. |
| REA-107 | D2 | Origin |  | FIGHTORIGIN 3/4 | What is your instinct when you feel attacked, and where did you learn it? | Attack, withdraw, explain, freeze. Name it and where you learned it. |
| REA-108 | D2 | Conflict |  | REPAIR 1/4 | What does a good apology contain, for you? | What an apology has to include before it counts for you. |
| REA-109 | D2 | Conflict |  | REPAIR 2/4 | How do you know when you have been forgiven? | The signal that tells you it is actually over. |
| REA-110 | D2 | Conflict |  |  | What is your first move when we go cold? | When the temperature drops between us, what do you do first. |
| REA-111 | D2 | Conflict |  | CONTEMPT 1/4 | Where does your contempt show up, even in small ways? | Contempt is subtle. Eye rolls, tone, the private verdict you hold. |
| REA-112 | D2 | Conflict |  | FIGHTSELF 3/4 | What do you do that you know escalates things? | Something you do knowing it will make things worse. |
| REA-113 | D2 | Conflict |  |  | When did you last choose the relationship over being right? | A specific time you let it go rather than winning. |
| REA-114 | D2 | Conflict |  | REPAIR 3/4 | What would repair look like if neither of us had to be the villain? | Repair without a guilty party. Describe what that looks like. |
| REA-115 | D2 | Conflict |  |  | What standard do you hold me to that you do not hold yourself to? | Everyone has one. Name the double standard. |
| REA-116 | D2 | Conflict |  | POWER 1/4 | Where are you keeping score? | Tallies of who did more, gave more, or conceded last. |
| REA-117 | D4 | Conflict |  |  | What are you punishing me for that I do not know about? | Withdrawal, coolness or delay used as a penalty. |
| REA-118 | D3 | Conflict |  |  | When you withdraw, what are you hoping I will do? | Withdrawal is usually a message. Say what you want it to produce. |
| REA-119 | D3 | Conflict |  |  | What do you need to hear before you can soften? | The specific words or gesture that let you come down. |
| REA-120 | D3 | Conflict |  |  | Which of your reactions to me is really about someone else? | Some reactions belong to an older relationship or an earlier person. |
| REA-121 | D3 | Conflict |  | REPAIR 4/4 | What does it cost you to be the one who apologises first? | Going first costs something. Name what it costs you. |
| REA-122 | D4 | Conflict |  | POWER 3/4 | Where do you feel one down in this relationship? | One down means smaller, less powerful, or having to justify yourself. |
| REA-123 | D4 | Conflict |  | POWER 4/4 | Where do you feel one up? | One up means superior, more competent, or entitled to judge. |
| REA-124 | D3 | Conflict |  | FIGHTSELF 4/4 | What part of your behaviour do you excuse because you were provoked? | The behaviour you allow yourself because you felt provoked. |
| REA-125 | D3 | Conflict |  |  | What would you have to give up to stop defending yourself? | Defending is a habit. Say what you would have to give up to stop. |
| REA-126 | D3 | Conflict |  |  | When did you last see me as an opponent rather than a partner? | A specific moment where I became the enemy. |
| REA-127 | D4 | Conflict |  | CONTEMPT 2/4 | What is the harshest thing you have thought about me and not said? | Unspoken and harsh. You do not have to say it now, only that it exists. |
| REA-128 | D3 | Conflict |  | POWER 2/4 | What do you believe you deserve that you are not getting? | Not what you want. What you believe you are owed. |
| REA-129 | D4 | Conflict |  | CONTEMPT 3/4 | Which of my wounds do you use against me when you are angry? | Everyone knows where the soft spots are. Say which ones you use. |
| REA-130 | D3 | Conflict |  |  | What would change if you assumed I was doing my best? | Assume good intent for a moment. What changes in how you respond. |
| REA-131 | D3 | Conflict |  |  | Where do you shut down rather than fight, and what does that protect? | Shutting down is a strategy. Say what it keeps you safe from. |
| REA-132 | D3 | Conflict |  |  | What does it feel like in your body when we are in a bad patch? | Physical, not emotional. Chest, jaw, stomach, sleep. |
| REA-133 | D3 | Origin |  | FIGHTORIGIN 4/4 | Who taught you that your needs were negotiable? | Where you learned that your needs come second. |
| REA-134 | D4 | Conflict |  | CONTEMPT 4/4 | What do you do to me that you would not tolerate if it were done to you? | Behaviour you would find unacceptable if the roles were reversed. |
| REA-135 | D5 | Conflict |  | ATTRITION 4/6 | What have you said in anger that you cannot take back? | Something said in temper that you cannot retract. |
| REA-136 | D5 | Conflict |  | ATTRITION 5/6 | What have I said that still wounds you when you remember it? | A line of mine that still stings when it surfaces. |
| REA-137 | D5 | Conflict |  | ATTRITION 6/6 | Where has this relationship made you smaller? | Smaller meaning less ambitious, less confident, less yourself. |
| REA-138 | D4 | Conflict |  | ATTRITION 1/6 | Where has it made you harder? | Harder meaning more guarded, more cynical, less generous. |
| REA-139 | D5 | Conflict |  | ATTRITION 3/6 | What is the pattern between us that you believe will not change? | The pattern you have privately concluded is permanent. |
| REA-140 | D4 | Conflict |  | ATTRITION 2/6 | What would you need to see from me to believe it could? | Evidence, not promises. What would you need to see. |
| REA-141 | D5 | Conflict | yes |  | What are you tolerating that you should not be? | Tolerating means accepting something you have decided not to fight about. |
| REA-142 | D5 | Conflict | yes |  | What am I tolerating that I should not be? | Turn it round. Name what you think I am putting up with. |
| REA-143 | D4 | Conflict |  |  | What do you do when you feel powerless with me? | Powerlessness produces strange behaviour. Describe yours. |
| REA-144 | D4 | Conflict |  |  | Where has your protection of yourself become an attack on me? | The point where self protection turned into offence. |
| REA-145 | D2 | Conflict |  | PROTOCOL 1/5 | What would generosity look like from you this month? | Concrete and doable within the month. |
| REA-146 | D2 | Conflict |  | PROTOCOL 2/5 | What is one thing you could stop doing that would improve us immediately? | One thing. Yours to stop, not mine. |
| REA-147 | D2 | Conflict |  | PROTOCOL 3/5 | What is one thing you want me to stop doing? | Be direct. One specific behaviour. |
| REA-148 | D2 | Conflict |  | PROTOCOL 4/5 | How do you want to be approached when I am upset with you? | How you want me to open it when I am the one with a problem. |
| REA-149 | D2 | Conflict |  | PROTOCOL 5/5 | What signal could we agree on to stop a fight before it runs? | A word, a gesture, or a phrase either of us can use to pause. |
| REA-150 | D3 | Future |  |  | If our relationship survives everything, what will have made the difference? | Looking back from the far end. What will have mattered. |
---

## EFT. Attachment and Emotionally Focused lens
Accessibility, responsiveness, engagement, raw spots, the cycles that pull couples apart.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| EFT-151 | D1 | Attachment |  | REACH 1/5 | When do you feel closest to me? | Closeness, not affection. The moments the gap disappears. |
| EFT-152 | D1 | Attachment |  |  | What is the easiest way for me to reassure you? | The fastest, simplest thing that settles you. |
| EFT-153 | D2 | Attachment |  | REACH 2/5 | How do you know I am emotionally available to you? | Available means reachable, not just present in the room. |
| EFT-154 | D2 | Attachment |  |  | What do you do when you need me and cannot say so? | Everyone has an indirect method. Describe yours. |
| EFT-155 | D2 | Attachment |  |  | What is the fear underneath your frustration with me? | Frustration usually sits on top of a fear. Name the fear. |
| EFT-156 | D2 | Attachment |  | CYCLE 1/5 | Which of my behaviours triggers the fastest reaction in you? | The behaviour that gets a reaction out of you before you can think. |
| EFT-157 | D2 | Attachment |  |  | What do you assume I am thinking when I am silent? | Silence gets filled in. Say what you fill it with. |
| EFT-158 | D2 | Attachment |  | CYCLE 2/5 | When you get louder, what are you trying to make happen? | Volume is usually pursuit. Say what you are trying to make happen. |
| EFT-159 | D2 | Attachment |  | CYCLE 3/5 | When you get quieter, what are you trying to avoid? | Going quiet is usually avoidance. Say what you are trying to prevent. |
| EFT-160 | D2 | Origin |  | EFTORIGIN 1/4 | What did you learn about asking for comfort as a child? | What happened when you asked for comfort as a child. |
| EFT-161 | D2 | Origin |  | EFTORIGIN 2/4 | Who did you go to when you were frightened, growing up? | The person you actually went to, not the person who should have been there. |
| EFT-162 | D2 | Attachment |  | ABANDON 1/4 | What happens in you when you sense I am pulling away? | The internal reaction, not the outward one. |
| EFT-163 | D2 | Attachment |  |  | How long can we be out of sync before you start to worry? | Some people can hold days of distance and some cannot hold hours. |
| EFT-164 | D2 | Attachment |  | RAWSPOT 1/4 | What does safety feel like in your body? | Physical description. Where safety sits and what it feels like. |
| EFT-165 | D4 | Attachment |  | RAWSPOT 3/4 | What is your raw spot, the thing that hurts faster than it should? | The subject or tone that hurts disproportionately fast. |
| EFT-166 | D3 | Attachment |  | RAWSPOT 2/4 | What do you most need to hear when you are at your lowest? | The specific sentence, not a general reassurance. |
| EFT-167 | D3 | Attachment |  | ABANDON 2/4 | When did you last feel abandoned by me, even briefly? | Abandoned can mean a moment, not a departure. |
| EFT-168 | D4 | Attachment |  |  | What are you most afraid I will discover about you? | Something about yourself you would rather I never learned. |
| EFT-169 | D4 | Attachment |  |  | What makes you believe I would, or would not, choose you again? | Given the same choice again, knowing everything. |
| EFT-170 | D3 | Attachment |  |  | What do you do to test whether I still want you? | Everyone tests. Say how you check whether you are still wanted. |
| EFT-171 | D4 | Attachment |  |  | Where do you feel too much for me? | Too much emotion, too much need, too much of anything. |
| EFT-172 | D4 | Attachment |  |  | Where do you feel not enough for me? | Where you fall short of what you think I need. |
| EFT-173 | D3 | Attachment |  |  | What would you have to trust to stop protecting yourself? | The belief you would need to hold before dropping your guard. |
| EFT-174 | D3 | Attachment |  |  | When you criticise me, what are you actually reaching for? | Criticism is often a clumsy request. Say what the request is. |
| EFT-175 | D3 | Attachment |  |  | When you shut down, what do you wish I would do instead of leaving you alone? | What you actually want when you have gone silent. |
| EFT-176 | D3 | Attachment |  | CYCLE 4/5 | What is the cycle we get caught in, described from your side? | Describe the pattern in sequence, from your side only. |
| EFT-177 | D3 | Attachment |  | CYCLE 5/5 | What is the moment in that cycle where it could still be stopped? | The last point where either of us could still change direction. |
| EFT-178 | D4 | Attachment |  | RAWSPOT 4/4 | Which of my reactions confirms your worst fear about yourself? | When my reaction proves the thing you already fear about yourself. |
| EFT-179 | D3 | Origin |  | EFTORIGIN 3/4 | What did you decide about love before you were ten? | Conclusions formed in childhood tend to persist. Name yours. |
| EFT-180 | D3 | Origin |  | EFTORIGIN 4/4 | Who let you down first, and how does it echo here? | The first significant let down, and how it echoes here. |
| EFT-181 | D3 | Attachment |  | REACH 3/5 | What would it mean to you if I said I need you? | Some people find being needed reassuring and some find it heavy. |
| EFT-182 | D3 | Attachment |  | REACH 4/5 | How hard is it for you to say the same thing to me? | Saying it, not hearing it. Say how difficult that is. |
| EFT-183 | D4 | Attachment |  |  | What do you want me to know about your loneliness? | Loneliness you carry that has nothing to do with being alone. |
| EFT-184 | D3 | Attachment |  |  | When have you felt most held by me? | Held meaning supported, steady, safe. Name a specific time. |
| EFT-185 | D3 | Attachment |  |  | What would you want me to do the next time you are frightened? | Practical instructions. What should I actually do. |
| EFT-186 | D3 | Attachment |  |  | What is the thing you would say if you were certain I would not react badly? | Assume no bad reaction. What would you say. |
| EFT-187 | D5 | Attachment | yes | ABANDON 3/4 | When have you doubted that I would stay? | A specific period, not a general anxiety. |
| EFT-188 | D5 | Attachment |  | ABANDON 4/4 | What is the loneliest you have been inside this relationship? | The lowest point of isolation while still together. |
| EFT-189 | D5 | Attachment |  |  | What have you needed from me and given up on? | Something you asked for repeatedly and then stopped asking for. |
| EFT-190 | D4 | Attachment |  | REACH 5/5 | What would you need in order to reach for me again? | The conditions for trying again after you stopped. |
| EFT-191 | D5 | Attachment | yes |  | What is your worst fear about how we end? | Not whether. How. The version you fear. |
| EFT-192 | D4 | Attachment |  |  | Where have I taught you not to bring me things? | Where my reaction taught you not to bring me a subject. |
| EFT-193 | D5 | Attachment |  |  | What did it cost you the last time you were fully open with me? | The price of the last time you were completely open. |
| EFT-194 | D4 | Attachment |  |  | What are you still bracing for? | Something you are still expecting to happen. |
| EFT-195 | D2 | Conflict |  | RECONNECT 1/4 | What is one signal we could use that means come closer? | Agree a shorthand. A word or gesture meaning come closer. |
| EFT-196 | D2 | Conflict |  | RECONNECT 2/4 | What is one signal that means I need a minute, not a exit? | The distinction matters. A pause is not a withdrawal. |
| EFT-197 | D2 | Attachment |  |  | How do you want to be touched when you are upset? | Physical preference when you are upset. Some people want contact and some do not. |
| EFT-198 | D2 | Conflict |  | RECONNECT 3/4 | What do you need after a fight, and how soon? | What you need afterwards, and how quickly. |
| EFT-199 | D2 | Conflict |  | RECONNECT 4/4 | What does reconnection look like for you? | The moment you consider the two of us back to normal. |
| EFT-200 | D3 | Conflict |  |  | If I could hold one thing for you this year, what should it be? | One burden. Say which one you would hand over. |
---

## SOL. Relational self awareness lens
Daily practice, self knowledge inside the pair, noticing before reacting.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| SOL-201 | D1 | Self |  | DAILY 1/4 | What did you notice about yourself today? | Anything you observed about your own mood, reaction or pattern today. |
| SOL-202 | D1 | Self |  | DAILY 2/4 | What mood did you bring home, and where did it come from? | Moods travel from work and traffic into the house. Trace yours. |
| SOL-203 | D1 | Attachment |  |  | What are you grateful for in me this week? | Specific to this week, not a general statement. |
| SOL-204 | D1 | Attachment |  | DAILY 3/4 | What went unsaid today that you want to say now? | Something you thought and did not say. |
| SOL-205 | D1 | Attachment |  |  | What did I get right today? | Name one thing. It counts even if it was small. |
| SOL-206 | D2 | Self |  | PATTERN 1/4 | What pattern in yourself are you currently working on? | A habit or reaction you are actively trying to change. |
| SOL-207 | D2 | Self |  | PATTERN 2/4 | Which of your reactions surprised you recently? | A moment where your own response surprised you. |
| SOL-208 | D2 | Self |  | PATTERN 4/4 | What are you learning about yourself through this relationship? | Relationships expose things solitude does not. Name one. |
| SOL-209 | D2 | Self |  |  | What do you know about yourself now that you did not know a year ago? | Compare yourself to a year ago. What is new knowledge. |
| SOL-210 | D2 | Self |  |  | Where are you outgrowing an old story about who you are? | An old self description you no longer believe. |
| SOL-211 | D2 | Self |  |  | What is the difference between how you see yourself and how you think I see you? | Two views of you. Say where they diverge. |
| SOL-212 | D2 | Self |  |  | What do you take personally that is not personal? | Things you read as being about you when they are not. |
| SOL-213 | D2 | Self |  | PATTERN 3/4 | What is your early warning sign that you are heading for a bad week? | The first sign that you are heading downhill. |
| SOL-214 | D2 | Self |  | CRITIC 1/4 | How do you usually treat yourself when you fail? | Your default reaction to your own failure. |
| SOL-215 | D2 | Self |  |  | What would self respect look like for you tomorrow? | One concrete action tomorrow that would count as self respect. |
| SOL-216 | D2 | Self |  |  | Which of your values are you living properly, and which are aspirational? | Values you actually live against values you claim. |
| SOL-217 | D2 | Self |  |  | What are you avoiding right now? | A task, a conversation, or a decision you are dodging. |
| SOL-218 | D2 | Self |  |  | What do you need to grieve? | Grief is not only about death. A loss, a version of yourself, a possibility. |
| SOL-219 | D2 | Self |  |  | What is your relationship with rest? | Whether you rest, how you rest, and how you feel about resting. |
| SOL-220 | D2 | Self |  | APPROVAL 1/4 | Where do you seek approval, and from whom? | Everyone seeks approval somewhere. Name the source. |
| SOL-221 | D2 | Self |  | APPROVAL 2/4 | What would change if you stopped needing that approval? | Imagine the need for that approval gone. What changes. |
| SOL-222 | D2 | Self |  |  | What is your dominant emotion this month? | One word or one phrase for the month. |
| SOL-223 | D2 | Self |  | SHRINK 1/4 | What are you tolerating in yourself? | Things in yourself you have decided to accept rather than address. |
| SOL-224 | D2 | Origin |  |  | What did you inherit that you want to put down? | Inherited traits, beliefs or reactions you want to stop carrying. |
| SOL-225 | D2 | Self |  |  | What do you want to model for the people who watch you? | Children, colleagues, friends. Anyone who takes cues from you. |
| SOL-226 | D4 | Self |  | SHRINK 3/4 | Where do you betray yourself in small ways? | Small betrayals. Skipped commitments, unsaid opinions, ignored limits. |
| SOL-227 | D3 | Self |  | SHRINK 2/4 | What do you pretend not to want? | Something you dismiss as unimportant that you actually want. |
| SOL-228 | D3 | Self |  |  | What are you performing that has become exhausting? | A role you keep performing that has become tiring. |
| SOL-229 | D4 | Self |  | SHRINK 4/4 | What part of you have you not brought into this relationship? | An interest, a side, or a history you have kept out of this relationship. |
| SOL-230 | D3 | Self |  | APPROVAL 4/4 | Where do you shrink to keep the peace? | Where you make yourself smaller to avoid friction. |
| SOL-231 | D3 | Self |  | APPROVAL 3/4 | What do you believe you have to earn? | Things you believe you must earn rather than simply receive. |
| SOL-232 | D4 | Self |  |  | What are you most ashamed of that has nothing to do with me? | Your own shame, unrelated to us. |
| SOL-233 | D4 | Self |  | CRITIC 4/4 | What is the harshest thing you say to yourself? | The exact words your internal critic uses. |
| SOL-234 | D3 | Origin |  | CRITIC 3/4 | Where did your harshest inner voice come from? | Whose voice it originally was. |
| SOL-235 | D3 | Self |  | CRITIC 2/4 | What would you do differently if you liked yourself more? | Concrete behaviour change, not a feeling. |
| SOL-236 | D3 | Self |  |  | What do you need from me to keep growing rather than settling? | Support for growth is different from support for comfort. Say what you need. |
| SOL-237 | D3 | Self |  |  | Where has comfort become an obstacle for you? | Where being comfortable is stopping you doing something. |
| SOL-238 | D3 | Self |  |  | What is the risk you keep not taking? | The risk you consider and never take. |
| SOL-239 | D3 | Self |  |  | Who are you when nobody needs anything from you? | Who you are with no demands on you at all. |
| SOL-240 | D3 | Future |  | SOLFUTURE 3/4 | What do you want your fifties or sixties to feel like? | Describe the feeling of that decade, not the achievements. |
| SOL-241 | D2 | Self |  | SOLFUTURE 1/4 | What is one thing you want to do alone this month? | Something for yourself alone, without guilt. |
| SOL-242 | D2 | Self |  | SOLFUTURE 2/4 | What is one thing you want to do together this month? | Something specific enough to put in a diary. |
| SOL-243 | D2 | Self |  | DAILY 4/4 | What did today teach you? | Any lesson, however small. |
| SOL-244 | D2 | Self |  |  | What are you carrying that is not yours? | Other people's burdens you have taken on. |
| SOL-245 | D2 | Self |  |  | Where do you need more honesty with yourself? | The area where you are least honest with yourself. |
| SOL-246 | D2 | Self |  |  | What is your body telling you that you are ignoring? | Physical signals you are overriding. Sleep, tension, appetite, energy. |
| SOL-247 | D2 | Money |  |  | What is your relationship with money doing to you? | Money shapes behaviour and mood. Say how yours affects you. |
| SOL-248 | D2 | Self |  |  | Where has your ambition served you, and where has it cost you? | Both sides. What ambition gave you and what it took. |
| SOL-249 | D3 | Future |  | SOLFUTURE 4/4 | What do you want to have resolved by this time next year? | One thing settled by this time next year. |
| SOL-250 | D3 | Self |  |  | What is the most honest sentence you could say about yourself right now? | The single most honest sentence, even if it is uncomfortable. |
---

## MNN. Attachment style and conflict cycle lens
Naming needs, protest behaviour, staying connected inside conflict.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| MNN-251 | D1 | Attachment |  | ASKING 1/5 | What is a need of yours that is easy for me to meet? | Something simple I could do more often. |
| MNN-252 | D1 | Attachment |  |  | What small gesture from me actually calms you? | The gesture that actually reduces your anxiety. |
| MNN-253 | D2 | Attachment |  | PROTEST 1/4 | How do you behave when you feel unimportant? | Behaviour, not feeling. What do you do when you feel deprioritised. |
| MNN-254 | D2 | Attachment |  | PROTEST 2/4 | What do you do when you want reassurance but do not want to ask? | The indirect route people take instead of asking outright. |
| MNN-255 | D2 | Attachment |  | PROTEST 3/4 | Which of your complaints is really a request in disguise? | Complaints often hide requests. Translate one. |
| MNN-256 | D2 | Attachment |  |  | What does your anxiety sound like when it speaks? | Anxiety has a voice and a script. Quote yours. |
| MNN-257 | D2 | Attachment |  | SPACE 1/4 | What does your withdrawal look like from the outside? | How your withdrawal appears to someone watching. |
| MNN-258 | D2 | Attachment |  | SPACE 2/4 | How much space do you need after conflict? | Minutes, hours or days. Be specific. |
| MNN-259 | D2 | Attachment |  | SPACE 3/4 | How do you want me to interpret it when you need that space? | What your need for space does not mean. |
| MNN-260 | D2 | Attachment |  | CLOSENESS 1/5 | What does closeness cost you? | Closeness has a price for most people. Name yours. |
| MNN-261 | D2 | Attachment |  | CLOSENESS 2/5 | What does distance cost you? | Distance has a price too. Name that one. |
| MNN-262 | D2 | Attachment |  | CLOSENESS 3/5 | Which do you fear more, being smothered or being left? | Both are real fears. Say which one is stronger in you. |
| MNN-263 | D2 | Origin |  | MNNORIGIN 1/3 | What did your caregivers do when you were upset? | The response you actually received when distressed as a child. |
| MNN-264 | D2 | Origin |  | MNNORIGIN 2/3 | What do you wish they had done instead? | The response you needed and did not get. |
| MNN-265 | D2 | Origin |  | MNNORIGIN 3/3 | Where do you see that pattern repeating with me? | Where the childhood pattern shows up between us. |
| MNN-266 | D4 | Attachment |  | ASKING 4/5 | What need of yours feels too much to say out loud? | A need that feels excessive or shameful to voice. |
| MNN-267 | D3 | Attachment |  |  | What do you do to make yourself easier to love? | Adjustments you make to be less demanding. |
| MNN-268 | D3 | Attachment |  | ASKING 2/5 | What would you ask for if you believed you would get it? | Assume the answer is yes. What would you ask for. |
| MNN-269 | D4 | Attachment |  |  | When do you feel like a burden? | The moments you feel you are costing me something. |
| MNN-270 | D3 | Attachment |  |  | When do you feel like a project? | A project meaning something to be fixed or managed. |
| MNN-271 | D3 | Attachment |  | REJECTION 1/4 | What behaviour of mine makes you doubt us? | The specific behaviour that shakes your confidence in us. |
| MNN-272 | D3 | Attachment |  |  | What do you tell yourself to feel better after I disappoint you? | The story you tell yourself to recover after disappointment. |
| MNN-273 | D3 | Attachment |  |  | Where do you go emotionally when we are disconnected? | Where you retreat to internally when we are disconnected. |
| MNN-274 | D3 | Attachment |  | PROTEST 4/4 | How do you know when you are protesting rather than communicating? | Protest is indirect. Communication is direct. Name the difference in you. |
| MNN-275 | D3 | Attachment |  |  | What would help you stay in the room when it gets hard? | What helps you stay present rather than leaving or shutting down. |
| MNN-276 | D3 | Attachment |  |  | What do you need me to say before you can hear my side? | The precondition for you being able to listen. |
| MNN-277 | D3 | Attachment |  |  | What is the difference between how you fight with me and how you fight with anyone else? | Compare how you argue with me to how you argue with anyone else. |
| MNN-278 | D4 | Attachment |  |  | What do you believe about your own worth when we are fighting? | What conflict makes you believe about your own value. |
| MNN-279 | D3 | Attachment |  | CLOSENESS 4/5 | Where does your independence protect you from me? | Where your self sufficiency keeps me at a distance. |
| MNN-280 | D3 | Attachment |  | CLOSENESS 5/5 | Where does your closeness cost you yourself? | Where getting close costs you a piece of yourself. |
| MNN-281 | D4 | Attachment |  | ASKING 5/5 | What is the need you have given up on having met? | A need you have quietly written off. |
| MNN-282 | D3 | Attachment |  | ASKING 3/5 | What would it take to try asking again? | What would have to be true for you to ask once more. |
| MNN-283 | D3 | Attachment |  |  | When have I met a need you did not think I could? | A time I surprised you by meeting something. |
| MNN-284 | D3 | Attachment |  |  | Which of my needs do you find hardest to meet, and why? | Be honest about which of my needs is hardest for you, and why. |
| MNN-285 | D3 | Attachment |  |  | Where do you feel I am asking too much? | Where my expectations feel excessive to you. |
| MNN-286 | D4 | Conflict |  | REJECTION 2/4 | What do you do when you feel rejected by me? | Behaviour after rejection. Withdraw, escalate, punish, or something else. |
| MNN-287 | D4 | Conflict |  | REJECTION 3/4 | Where have you punished me for a need I did not meet? | Retaliation for an unmet need, however subtle. |
| MNN-288 | D5 | Conflict |  |  | What have you stopped asking for entirely? | Requests you have abandoned entirely. |
| MNN-289 | D5 | Conflict |  |  | What is the loneliness you have accepted as normal? | Loneliness you have reclassified as normal. |
| MNN-290 | D5 | Conflict | yes | REJECTION 4/4 | If nothing about our conflict pattern changed, what would you do? | Assume the pattern is permanent. What is your answer. |
| MNN-291 | D2 | Conflict |  |  | What is one sentence I could say in a fight that would land well? | One sentence I could say mid conflict that would land. |
| MNN-292 | D2 | Conflict |  |  | What is one sentence that never lands? | One sentence that always makes it worse. |
| MNN-293 | D2 | Conflict |  | SPACE 4/4 | How would you like to be reached when you have gone quiet? | How you want to be approached after you have gone quiet. |
| MNN-294 | D2 | Conflict |  |  | What do you need in the first ten minutes after a fight ends? | The first ten minutes after a fight ends. Say what you need. |
| MNN-295 | D2 | Attachment |  |  | What does being met feel like? | Being met means understood and responded to. Describe it. |
| MNN-296 | D2 | Attachment |  |  | What would you like more of that costs nothing? | Free things. Attention, words, presence, timing. |
| MNN-297 | D2 | Attachment |  |  | How do you want to be reminded that you matter? | The form of reminder that actually registers for you. |
| MNN-298 | D2 | Attachment |  |  | What is your preferred way to be checked on during a hard day? | Message, call, visit or nothing. Say which and when. |
| MNN-299 | D3 | Attachment |  |  | What have you learned about your own needs since we met? | What this relationship has taught you about your own needs. |
| MNN-300 | D3 | Attachment |  |  | What are you willing to ask for out loud from now on? | A commitment about what you will voice from now on. |
---

## PHA. Family of origin lens
Origin wounds, inherited scripts, what got learned before there was choice.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| PHA-301 | D1 | Origin |  |  | What is a good memory from your childhood that shaped you? | One good memory, and what it shaped in you. |
| PHA-302 | D2 | Origin |  | ROLE 1/4 | What was your role in your family? | Peacemaker, achiever, invisible one, carer, difficult one. Name yours. |
| PHA-303 | D2 | Origin |  | ROLE 2/4 | Who did you have to be to be accepted at home? | The version of you that was welcomed at home. |
| PHA-304 | D2 | Origin |  | EMOTION 1/4 | What emotions were allowed in your house? | Which feelings were acceptable to show. |
| PHA-305 | D2 | Origin |  | EMOTION 2/4 | Which emotions were not allowed in your house? | Which feelings were not tolerated. |
| PHA-306 | D2 | Origin |  | PARENTS 1/4 | How did your parents handle disagreement in front of you? | What you witnessed of adult disagreement. |
| PHA-307 | D2 | Money |  |  | What did you learn about money from watching them? | Attitudes to money absorbed by watching, not by instruction. |
| PHA-308 | D2 | Origin |  |  | What did you learn about affection? | Whether affection was shown, and how. |
| PHA-309 | D2 | Origin |  |  | What did you learn about apology? | Whether adults apologised, and what that looked like. |
| PHA-310 | D2 | Origin |  |  | Who in your family were you most like, and who noticed? | The resemblance, and whether anyone commented on it. |
| PHA-311 | D2 | Origin |  | ROLE 3/4 | What was expected of you that was never stated? | Unspoken expectations carry the most weight. Name one. |
| PHA-312 | D2 | Origin |  | ROLE 4/4 | What did you have to be good at to get attention? | The competence that earned you attention. |
| PHA-313 | D2 | Origin |  |  | Who protected you when you were growing up? | Emotionally or practically. Name the person. |
| PHA-314 | D2 | Origin |  |  | Who should have protected you and did not? | The person who had the responsibility and did not meet it. |
| PHA-315 | D2 | Origin |  |  | What is a family rule you are still obeying? | A family rule you still follow without deciding to. |
| PHA-316 | D4 | Origin |  | WOUND 1/6 | Where did you first learn that you were not a priority? | The first evidence that you came second. |
| PHA-317 | D4 | Origin |  | WOUND 2/6 | Where did you first learn that you did not belong? | The first sense of being outside the group. |
| PHA-318 | D4 | Origin |  | WOUND 3/6 | Where did you first learn that you could not trust someone? | The first broken trust, in or out of the family. |
| PHA-319 | D4 | Origin |  | WOUND 4/6 | Where did you first learn that you had to be safe rather than seen? | Choosing safety over being known. Where did that start. |
| PHA-320 | D4 | Origin |  | WOUND 5/6 | What did you need as a child that nobody provided? | The unmet childhood need. Attention, safety, praise, presence. |
| PHA-321 | D4 | Origin |  | WOUND 6/6 | What do you still look for now that you did not get as a child, and from whom? | Where you go now for what you did not get then. |
| PHA-322 | D3 | Origin |  | REPEAT 1/5 | Which of my behaviours reminds you of a parent? | The behaviour of mine that triggers a parental echo. |
| PHA-323 | D3 | Origin |  | REPEAT 2/5 | Which of your own behaviours reminds you of a parent? | Your own behaviour that echoes a parent. |
| PHA-324 | D3 | Origin |  | REPEAT 3/5 | What are you determined not to repeat? | The specific pattern you swore you would not repeat. |
| PHA-325 | D3 | Origin |  | REPEAT 4/5 | Where are you repeating it anyway? | Be honest about where it is repeating anyway. |
| PHA-326 | D4 | Origin |  | PARENTS 4/4 | What do you still want from a parent that you will not get? | Something a parent will never give you, that you still want. |
| PHA-327 | D3 | Origin |  | PARENTS 3/4 | What have you forgiven them for, and what remains? | What is forgiven, and what is not. |
| PHA-328 | D3 | Origin |  | PARENTS 2/4 | What did their marriage teach you about what marriage is? | Their marriage was your first model. Say what it taught. |
| PHA-329 | D3 | Origin |  |  | What part of that did you accept without examining? | The parts of that model you absorbed without questioning. |
| PHA-330 | D3 | Origin |  |  | Who in your family are you still trying to prove something to? | The person you are still trying to satisfy. |
| PHA-331 | D3 | Origin |  |  | What did you have to grow up too early for? | Responsibility you carried before you should have. |
| PHA-332 | D3 | Origin |  |  | What childhood need still shows up in our arguments? | An old childhood need surfacing in a present day argument. |
| PHA-333 | D3 | Origin |  | REPEAT 5/5 | Where do you treat me like someone from your past? | Where I get treated as a stand in for someone from your past. |
| PHA-334 | D3 | Origin |  |  | Where do I treat you like someone from mine? | The reverse. Where I do that to you. |
| PHA-335 | D3 | Origin |  | EMOTION 3/4 | What did silence mean in your house? | Silence in a household carries meaning. Say what yours meant. |
| PHA-336 | D3 | Origin |  | EMOTION 4/4 | What did anger mean in the house you grew up in? | Anger in a household carries meaning too. Say what yours meant. |
| PHA-337 | D3 | Origin |  |  | What did love look like when it was actually present? | The times love was actually visible. Describe them. |
| PHA-338 | D4 | Origin |  |  | Who taught you to hide? | The person who taught you to conceal parts of yourself. |
| PHA-339 | D3 | Origin |  |  | What are you still hiding out of habit rather than need? | Concealment that is now habit rather than necessity. |
| PHA-340 | D5 | Origin |  | INHERIT 3/4 | What happened to you that you have never fully described to me? | Something from your past you have never described fully to me. |
| PHA-341 | D5 | Origin |  | INHERIT 4/4 | What would you want me to understand about the worst year of your childhood? | The hardest year of your childhood. What should I understand. |
| PHA-342 | D5 | Origin |  |  | What are you afraid you inherited? | The trait or pattern you fear you have inherited. |
| PHA-343 | D4 | Origin |  | INHERIT 1/4 | What would healing that actually require of you? | Practical. What would actually be involved in dealing with it. |
| PHA-344 | D4 | Origin |  | INHERIT 2/4 | Where do you need me to be different from the people who raised you? | Where you need me to behave unlike the people who raised you. |
| PHA-345 | D2 | Origin |  |  | What tradition are you glad to have left behind? | A family practice you were glad to drop. |
| PHA-346 | D2 | Future |  |  | What do you want our home to feel like that yours did not? | The atmosphere you want at home, contrasted with the one you grew up in. |
| PHA-347 | D2 | Future |  |  | What do you want to pass on deliberately? | What you want to hand on deliberately rather than by accident. |
| PHA-348 | D2 | Origin |  | BOUNDARY 1/3 | Which of your family relationships needs attention right now? | The family relationship currently needing work. |
| PHA-349 | D3 | Origin |  | BOUNDARY 2/3 | What boundary with your family have you avoided setting? | The limit you know you should set and have not. |
| PHA-350 | D3 | Origin |  | BOUNDARY 3/3 | What would you need from me to set it? | Practical support. What would help you set it. |
---

## TUR. Self responsibility lens
Ownership, self worth, honesty, the part that is yours to carry.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| TUR-351 | D1 | Self |  |  | What is one thing you are doing well as a partner? | Name one thing you do well as a partner. Resist deflecting. |
| TUR-352 | D2 | Conflict |  | OWNERSHIP 1/4 | What is your contribution to the problem we keep having? | Your share of the recurring problem, not mine. |
| TUR-353 | D2 | Self |  | OWNERSHIP 2/4 | Where are you waiting for me to change before you do? | Where you are holding back until I move first. |
| TUR-354 | D2 | Self |  |  | What excuse have you been using for too long? | A justification you have been using past its expiry. |
| TUR-355 | D2 | Self |  |  | What would you do this week if you took full responsibility for your own happiness? | Concrete actions this week if your happiness were entirely yours to manage. |
| TUR-356 | D2 | Conflict |  | OWNERSHIP 3/4 | What are you blaming me for that is actually yours? | Something attributed to me that is actually your responsibility. |
| TUR-357 | D2 | Conflict |  |  | Where has resentment become a habit? | Where resentment has become routine rather than reactive. |
| TUR-358 | D2 | Self |  |  | What are you not saying because it is easier to be disappointed? | Where disappointment is easier than confrontation. |
| TUR-359 | D2 | Self |  |  | What do you expect me to intuit that you should simply state? | Things you expect me to guess rather than being told. |
| TUR-360 | D2 | Self |  |  | Where do you confuse silence with patience? | Where staying quiet is not patience but avoidance. |
| TUR-361 | D2 | Self |  |  | What do you need to forgive yourself for? | Your own action or inaction, not mine. |
| TUR-362 | D2 | Self |  |  | How do you talk about me when I am not there? | How you describe me to other people. |
| TUR-363 | D2 | Self |  |  | Where does the way you speak about me differ from the way you speak to me? | Compare the two. Say where they diverge. |
| TUR-364 | D2 | Self |  | HONESTY 1/6 | What are you pretending is fine? | Something you have decided to describe as acceptable. |
| TUR-365 | D2 | Self |  |  | What standard do you want to hold yourself to in this relationship? | Your own standard, independent of mine. |
| TUR-366 | D4 | Self |  | WORTH 4/4 | Where do you look for evidence that you are unlovable? | The evidence you collect to confirm you are hard to love. |
| TUR-367 | D3 | Self |  | WORTH 1/4 | What do you do when you feel unworthy? | Behaviour when you feel undeserving. |
| TUR-368 | D3 | Self |  | WORTH 2/4 | How does your self worth affect how you treat me? | The link between how you value yourself and how you treat me. |
| TUR-369 | D3 | Self |  | WORTH 3/4 | What do you need from yourself before you need anything from me? | What you owe yourself before you ask anything of me. |
| TUR-370 | D3 | Self |  |  | Where are you asking me to fix something only you can fix? | Where you are asking me to solve something only you can solve. |
| TUR-371 | D4 | Self |  | HONESTY 3/6 | What lie have you told yourself about this relationship? | A comfortable untruth you tell yourself about us. |
| TUR-372 | D3 | Self |  | HONESTY 2/6 | What truth about us have you avoided? | Something true about us you have declined to look at. |
| TUR-373 | D3 | Self |  |  | What would you say to a friend in your exact situation? | Imagine a friend in your exact position. What is your advice. |
| TUR-374 | D3 | Self |  |  | Why do you not say it to yourself? | Say why that advice does not apply to you. |
| TUR-375 | D3 | Self |  | SETTLING 1/4 | Where do you settle, and what does it protect you from? | Where you accept less, and what accepting less protects you from. |
| TUR-376 | D4 | Self |  | HONESTY 4/6 | What are you afraid you would find if you were fully honest with me? | The thing you fear complete honesty would reveal. |
| TUR-377 | D3 | Self |  | COURAGE 1/4 | What conversation have you been rehearsing and never starting? | A conversation you keep rehearsing and never starting. |
| TUR-378 | D3 | Self |  | COURAGE 2/4 | What would courage look like from you this month? | One brave act this month. Be specific. |
| TUR-379 | D3 | Self |  |  | Where have you made me responsible for your mood? | Where you have handed me responsibility for how you feel. |
| TUR-380 | D4 | Self |  |  | What do you do to earn love that you should not have to do? | Effort spent earning love that should not require earning. |
| TUR-381 | D3 | Self |  |  | What are you afraid would happen if you stopped? | Your fear about what happens if you stop earning it. |
| TUR-382 | D3 | Conflict |  |  | Where has your pride cost us something? | A specific cost your pride has imposed on us. |
| TUR-383 | D3 | Self |  |  | What is the hardest thing about being in a relationship with you? | Be honest about your own difficulty as a partner. |
| TUR-384 | D3 | Self |  |  | What is the best thing about being in a relationship with you? | And the other side. What you bring. |
| TUR-385 | D5 | Self |  | HONESTY 5/6 | What do you need to admit? | Something you know you need to admit. |
| TUR-386 | D5 | Self | yes | HONESTY 6/6 | What have you been dishonest about, even by omission? | Including things left unsaid, not only things said falsely. |
| TUR-387 | D4 | Self |  | SETTLING 2/4 | What would change if you stopped waiting to feel ready? | Readiness rarely arrives. What would you do without waiting for it. |
| TUR-388 | D4 | Self |  | SETTLING 3/4 | What are you unwilling to change, and are you sure that is a good decision? | Name what you will not change, and test whether that is a good decision. |
| TUR-389 | D5 | Self | yes | SETTLING 4/4 | If this relationship stays exactly as it is, can you live with that? | Assume permanence. Can you accept it. |
| TUR-390 | D5 | Self |  | OWNERSHIP 4/4 | What are you responsible for that you have never acknowledged out loud? | Something that is yours and has never been said aloud. |
| TUR-391 | D2 | Self |  |  | What is one commitment you can make this week and actually keep? | Small, specific, achievable this week. |
| TUR-392 | D2 | Self |  |  | How do you want to be held accountable? | How you want to be held to it. |
| TUR-393 | D2 | Self |  |  | What feedback do you find hardest to receive? | The kind of feedback you struggle to take. |
| TUR-394 | D2 | Self |  |  | How can I give it so that you can use it? | The delivery that lets you use it rather than defend against it. |
| TUR-395 | D2 | Self |  |  | What are you proud of in how you have handled something recently? | A recent situation you handled well. |
| TUR-396 | D2 | Self |  |  | Where have you grown that I may not have noticed? | Growth I may have missed. Point it out. |
| TUR-397 | D2 | Future |  |  | What do you want to be different about you in a year? | One change in yourself within a year. |
| TUR-398 | D2 | Future |  |  | What support do you need to get there? | Practical support required to get there. |
| TUR-399 | D3 | Self |  | COURAGE 3/4 | What is the truest thing you could say to me right now? | The most honest sentence available to you right now. |
| TUR-400 | D3 | Self |  | COURAGE 4/4 | What would you regret not saying? | What you would regret leaving unsaid. |
---

## NAG. Desire science lens
Context, responsive desire, brakes and accelerators, pleasure over performance.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| NAG-401 | D1 | Sex |  | CONTEXT 1/6 | What kind of day makes you more open to closeness? | The shape of a day that leaves you open rather than closed. |
| NAG-402 | D1 | Sex |  | CONTEXT 2/6 | What kind of day shuts it down completely? | The shape of a day that ends any possibility. |
| NAG-403 | D2 | Sex |  |  | What usually comes first for you, the wanting or the starting? | Some people feel desire first, others feel it once things begin. Both are normal. |
| NAG-404 | D2 | Sex |  | CONTEXT 3/6 | What conditions make it easy for you to be present in your body? | Conditions, not techniques. Environment, workload, mood, privacy. |
| NAG-405 | D2 | Sex |  | CONTEXT 6/6 | What conditions make it impossible to be present in your body? | The conditions that make being in your body impossible. |
| NAG-406 | D2 | Sex |  | BRAKES 1/5 | What are your brakes, the things that quietly stop desire? | Brakes are anything that quietly suppresses interest. Stress, mess, resentment, noise. |
| NAG-407 | D2 | Sex |  | BRAKES 2/5 | What reliably increases your interest, even on an ordinary day? | Accelerators are anything that reliably raises interest. |
| NAG-408 | D2 | Sex |  | BRAKES 5/5 | Which matters more for you, removing the brakes or adding the accelerators? | For most people removing brakes matters more than adding accelerators. Say which for you. |
| NAG-409 | D2 | Sex |  | BRAKES 3/5 | How does stress show up in your desire? | Stress raises desire in some people and flattens it in others. |
| NAG-410 | D2 | Sex |  | BRAKES 4/5 | How does exhaustion change what you want physically? | Tiredness and stress are different inputs. Say how exhaustion changes things. |
| NAG-411 | D2 | Sex |  | PRESENCE 1/4 | What does your body need before your mind is interested? | Physical or practical prerequisites before interest is possible. |
| NAG-412 | D2 | Sex |  | CONTEXT 4/6 | Where in the house or the week does closeness actually work for you? | Location and timing matter more than people admit. Say what works. |
| NAG-413 | D2 | Sex |  |  | What have you assumed about how desire is supposed to work? | Beliefs about how desire is meant to operate. |
| NAG-414 | D2 | Sex |  | SEXSHAME 1/5 | Where did your assumptions about how desire should work come from? | Where those beliefs came from. Media, upbringing, earlier relationships. |
| NAG-415 | D2 | Sex |  |  | What would you want if there were no expectation of where it leads? | Remove the expectation of an outcome. What would you want then. |
| NAG-416 | D2 | Sex |  |  | How much does feeling attractive to yourself matter to your wanting? | Feeling attractive to yourself, separate from being found attractive. |
| NAG-417 | D4 | Sex |  | SEXSHAME 4/5 | What do you believe is wrong with you sexually? | A private belief about your own sexual normality. |
| NAG-418 | D3 | Origin |  | SEXSHAME 3/5 | Where did your beliefs about your own sexuality begin? | The origin of that belief. |
| NAG-419 | D3 | Origin |  | SEXSHAME 2/5 | What messages about sex did you absorb before you had any experience? | Messages absorbed before you had any experience of your own. |
| NAG-420 | D4 | Sex |  | SEXSHAME 5/5 | What shame do you still carry that has nothing to do with me? | Shame carried from before this relationship. |
| NAG-421 | D4 | Sex |  |  | When do you go through the motions? | The times you are participating rather than present. |
| NAG-422 | D3 | Sex |  | CONSENT 1/4 | What makes it hard to say no without guilt? | What makes refusing feel like a failure rather than a choice. |
| NAG-423 | D3 | Sex |  | CONSENT 2/4 | What makes it hard to say yes without pressure? | What makes agreeing feel like an obligation rather than a want. |
| NAG-424 | D3 | Sex |  |  | How has your relationship with your body changed? | How your relationship with your own body has shifted over time. |
| NAG-425 | D3 | Sex |  |  | What do you need from me when you do not feel good in your skin? | What helps on days you feel wrong in your skin. |
| NAG-426 | D3 | Sex |  |  | What does pleasure mean to you, separate from performance? | Pleasure for its own sake, separate from performing well. |
| NAG-427 | D3 | Sex |  | PRESENCE 2/4 | When did you last feel genuinely relaxed with me physically? | A specific occasion where you were genuinely relaxed. |
| NAG-428 | D3 | Sex |  | PRESENCE 3/4 | What conditions let you relax physically with me? | The conditions that produced that. |
| NAG-429 | D3 | Sex |  | PRESENCE 4/4 | What do you need to feel safe enough to be uninhibited? | What has to be true before you can stop self monitoring. |
| NAG-430 | D4 | Sex |  |  | What kills the mood that you have never told me about? | Something that ends it for you that you have never mentioned. |
| NAG-431 | D3 | Sex |  |  | Where do you compare us to something external? | Comparison to other couples, past partners, or what you have watched or read. |
| NAG-432 | D3 | Sex |  |  | What would it mean to stop measuring? | Stop measuring against a standard. What would change. |
| NAG-433 | D3 | Sex |  |  | What role does affection without expectation play for you? | Touch and affection with no expected outcome. |
| NAG-434 | D3 | Sex |  |  | How do you want to be touched when nothing is meant to follow? | Practical description. How you want to be touched when nothing follows. |
| NAG-435 | D3 | Sex |  |  | What is the difference for you between being wanted and being used? | Wanted and used can feel similar in the moment. Name the difference for you. |
| NAG-436 | D4 | Sex |  | CONSENT 3/4 | What do you want that you have never asked for? | A want never voiced. It does not have to be dramatic. |
| NAG-437 | D5 | Sex | yes | CONSENT 4/4 | What have you agreed to that you did not want? | Times you consented without wanting to. |
| NAG-438 | D2 | Sex |  |  | What would you like to try once, without commitment to repeating it? | An experiment with no obligation to repeat it. |
| NAG-439 | D4 | Sex |  | DRIFT 1/4 | What has changed in what you want since we started? | How your wants have shifted since the beginning. |
| NAG-440 | D4 | Sex |  | DRIFT 3/4 | What do you miss about our physical relationship? | Something from our physical relationship that has gone. |
| NAG-441 | D4 | Sex |  |  | What are you afraid to want? | A want you avoid acknowledging, even privately. |
| NAG-442 | D5 | Sex |  |  | Where has our sex life stopped being a conversation? | The point at which it stopped being discussed. |
| NAG-443 | D4 | Sex |  | DRIFT 2/4 | What would you want me to know about your desire that I have never asked? | What I have never asked, and should have. |
| NAG-444 | D4 | Sex |  | DRIFT 4/4 | If we could reset entirely, what would you build differently? | Full reset. What would you build differently. |
| NAG-445 | D2 | Sex |  | CONTEXT 5/6 | What is one small change to our context that would help? | One small practical change to circumstances, not to behaviour. |
| NAG-446 | D2 | Sex |  |  | What time of day works best for you, honestly? | Honest answer, not the socially expected one. |
| NAG-447 | D2 | Sex |  |  | What would help you transition from the day into being present? | What helps you move from work mode into being present. |
| NAG-448 | D2 | Sex |  |  | What do you need from the hours before, not just the moment? | The hours beforehand matter. Say what you need in them. |
| NAG-449 | D3 | Sex |  |  | What does a good experience mean to you now? | Your current definition of a good experience. |
| NAG-450 | D3 | Sex |  |  | How would you know we were doing well in this area? | The signal that would tell you we are in a good place here. |
---

## MAR. Sexual communication lens
Naming, initiating, giving feedback, mismatch, repair.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| MAR-451 | D1 | Sex |  | LANGUAGE 1/4 | How comfortable are you talking about this at all? | How easy or difficult this topic is for you in general. |
| MAR-452 | D1 | Origin |  | LANGUAGE 2/4 | What made it hard to talk about sex in your family or school? | Where the discomfort with the subject was learned. |
| MAR-453 | D2 | Sex |  | LANGUAGE 3/4 | What words do you actually want to use for things? | Vocabulary matters. Clinical, casual, or something else. |
| MAR-454 | D2 | Sex |  | LANGUAGE 4/4 | Which words about sex put you off? | Words that make you switch off. |
| MAR-455 | D2 | Sex |  | INITIATE 1/4 | How would you prefer I initiate? | Your preferred form of approach. Direct, physical, planned, spontaneous. |
| MAR-456 | D2 | Sex |  | DECLINE 1/4 | How do you prefer to be turned down? | How you want a refusal delivered so it does not sting. |
| MAR-457 | D2 | Sex |  | DECLINE 3/4 | What does it mean to you when I decline? | What you read into it when I say no. |
| MAR-458 | D2 | Sex |  | DECLINE 4/4 | What do you want me to understand about your no? | What your no does not mean. |
| MAR-459 | D2 | Sex |  | FREQUENCY 1/6 | How often would you like it, if you could set it honestly? | Honest number, not diplomatic. |
| MAR-460 | D2 | Sex |  | FREQUENCY 2/6 | What is the gap between the frequency you want and the frequency we have, and what causes it? | The gap and the reasons for it. |
| MAR-461 | D2 | Sex |  | INITIATE 2/4 | Who initiates more, and how does that feel? | Who starts things, and how that imbalance feels. |
| MAR-462 | D2 | Sex |  | INITIATE 4/4 | What would make initiating easier for you? | What would lower the barrier to you starting. |
| MAR-463 | D2 | Sex |  | FEEDBACK 1/6 | How do you feel about talking during? | Whether talking during helps or interrupts. |
| MAR-464 | D2 | Sex |  | FEEDBACK 2/6 | How do you feel about talking afterwards? | Whether you want conversation afterwards, and what kind. |
| MAR-465 | D2 | Sex |  | FEEDBACK 3/6 | What feedback do you want and never get? | Feedback you want and are not getting. |
| MAR-466 | D4 | Sex |  | FEEDBACK 6/6 | What have you wanted to correct but stayed quiet about? | Something you wanted to correct and stayed quiet about. |
| MAR-467 | D3 | Sex |  |  | What do I do that you enjoy more than I realise? | Something I do that you like more than I realise. |
| MAR-468 | D3 | Sex |  |  | What do I do that you tolerate? | Something you put up with rather than enjoy. |
| MAR-469 | D3 | Sex |  | FEEDBACK 4/6 | How would you tell me something was not working? | The method you would use to raise a problem. |
| MAR-470 | D3 | Sex |  | FEEDBACK 5/6 | What stops you from telling me? | What prevents you from raising it. |
| MAR-471 | D3 | Sex |  |  | What is a compliment about your body that would actually land? | A compliment about your body that would actually land. |
| MAR-472 | D3 | Sex |  |  | What compliment feels hollow to you? | A compliment that rings false to you. |
| MAR-473 | D3 | Sex |  | SEXTRUTH 1/4 | When did you last feel truly desired by me? | A specific occasion of feeling genuinely wanted. |
| MAR-474 | D4 | Sex |  | SEXTRUTH 2/4 | When did you last feel obligated? | A specific occasion of feeling obliged. |
| MAR-475 | D3 | Sex |  | FREQUENCY 3/6 | What is your honest view of our current frequency? | Your honest assessment of where we are. |
| MAR-476 | D3 | Sex |  | FREQUENCY 4/6 | What has caused the biggest shift in it? | The event or period that shifted it most. |
| MAR-477 | D4 | Sex |  |  | What do you think I believe about your desire that is wrong? | A wrong assumption you think I hold about your desire. |
| MAR-478 | D3 | Sex |  |  | What do you believe about mine? | Your assumption about mine. |
| MAR-479 | D3 | Sex |  | FREQUENCY 5/6 | How do you want to handle it when we want different things on a given night? | Mismatched nights are normal. Say how you want them handled. |
| MAR-480 | D3 | Sex |  | FREQUENCY 6/6 | What would a good compromise look like, rather than one person conceding? | A genuine middle ground, not one person giving way. |
| MAR-481 | D3 | Sex |  |  | What kind of non sexual touch do you want more of? | Non sexual touch. Say what kind and how much. |
| MAR-482 | D3 | Sex |  |  | What does foreplay mean to you, defined broadly? | Define it broadly. Anything that builds toward closeness. |
| MAR-483 | D3 | Sex |  |  | How much does what happens outside the bedroom affect what happens inside it? | How much the rest of the day determines what happens later. |
| MAR-484 | D3 | Sex |  |  | What would you like more of in the ordinary parts of the day? | Ordinary daytime things you want more of. |
| MAR-485 | D5 | Sex | yes | SEXTRUTH 3/4 | What have you faked, and why? | Anything performed rather than felt, and the reason. |
| MAR-486 | D5 | Sex | yes | SEXTRUTH 4/4 | What have you avoided telling me because you did not want to hurt me? | Withheld to spare my feelings. |
| MAR-487 | D4 | Sex |  |  | What would you want to do that you think I would refuse? | Something you assume I would decline. |
| MAR-488 | D4 | Sex |  |  | What is a boundary of yours I should never cross? | A firm limit. Say it plainly. |
| MAR-489 | D5 | Sex | yes |  | What is a boundary you have moved without telling me? | A limit of yours that has shifted without being discussed. |
| MAR-490 | D4 | Sex |  |  | What is the most vulnerable thing you could say about this subject? | The most exposing thing you could say on this subject. |
| MAR-491 | D2 | Sex |  | SEXPLAN 1/8 | How should we agree to raise this topic in future without either of us bracing? | An agreed way to open the topic without either of us tensing. |
| MAR-492 | D2 | Sex |  | SEXPLAN 2/8 | What is a good time to have this conversation, and when is a terrible one? | Good timing and bad timing for this conversation. |
| MAR-493 | D2 | Sex |  | INITIATE 3/4 | What signal could mean I am interested, no pressure? | A low pressure signal meaning interested. |
| MAR-494 | D2 | Sex |  | DECLINE 2/4 | What signal could mean not tonight, and it is not about you? | A signal meaning not tonight, without rejection attached. |
| MAR-495 | D2 | Sex |  | SEXPLAN 3/8 | What would you like us to plan rather than leave to chance? | What you want planned rather than left to chance. |
| MAR-496 | D2 | Sex |  | SEXPLAN 4/8 | How do you feel about scheduling it? | Scheduling divides people. Say where you sit. |
| MAR-497 | D3 | Future |  | SEXPLAN 5/8 | What do you want the next six months to look like in this area? | Your six month picture for this part of the relationship. |
| MAR-498 | D3 | Sex |  | SEXPLAN 6/8 | What is one thing we could change immediately? | One immediate change. |
| MAR-499 | D3 | Sex |  | SEXPLAN 7/8 | What is one thing that will take longer? | One change that needs longer. |
| MAR-500 | D3 | Sex |  | SEXPLAN 8/8 | What do you need from me to keep this conversation open? | What you need from me to keep this discussable. |
---

## LEH. Fantasy and novelty lens
Disclosure, curiosity, the gap between what people want and what they say.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| LEH-501 | D2 | Sex |  | DISCLOSE 1/5 | How do you feel about the idea of sharing a fantasy at all? | How you feel about the idea itself, before any content. |
| LEH-502 | D2 | Sex |  | DISCLOSE 2/5 | What makes disclosure feel risky to you? | What makes disclosure feel risky. |
| LEH-503 | D2 | Sex |  | DISCLOSE 3/5 | What would you need from me to make it safe? | The conditions that would make it safe. |
| LEH-504 | D2 | Sex |  |  | What is the difference for you between a fantasy and a wish? | A fantasy is imagined. A wish is intended. Say how you separate them. |
| LEH-505 | D2 | Sex |  |  | Which of your fantasies would you never want enacted? | Things you enjoy imagining and would not want to happen. |
| LEH-506 | D2 | Sex |  |  | What draws you to novelty, or does it not? | Whether new things appeal to you, or not. |
| LEH-507 | D2 | Sex |  |  | How important is anticipation to you? | Anticipation matters enormously to some people and little to others. |
| LEH-508 | D2 | Sex |  |  | What role does being watched or admired play for you? | Being observed or admired. Say whether it features for you. |
| LEH-509 | D2 | Sex |  |  | What role does surrender play? | Letting go of control. Say whether that appeals. |
| LEH-510 | D2 | Sex |  |  | What role does control play? | Holding control. Say whether that appeals. |
| LEH-511 | D4 | Sex |  | THEME 3/5 | What theme keeps recurring in your imagination? | A pattern in your imagination, not a specific scene. |
| LEH-512 | D3 | Sex |  | THEME 1/5 | What does a recurring fantasy give you emotionally, not just physically? | The emotional payoff underneath a recurring fantasy. Escape, power, safety, being chosen. |
| LEH-513 | D3 | Sex |  | THEME 2/5 | What do your fantasies tell you about what you need? | What your imagination indicates about an unmet need. |
| LEH-514 | D4 | Sex |  | THEME 4/5 | What fantasy have you had since you were young? | Something present since you were young. |
| LEH-515 | D4 | Sex |  | THEME 5/5 | Which of your fantasies embarrasses you? | You do not need to describe it. Only say that it exists. |
| LEH-516 | D3 | Sex |  | DISCLOSE 4/5 | What would you want me to say if you told me? | The response you would want from me. |
| LEH-517 | D3 | Sex |  | DISCLOSE 5/5 | What would you not want me to do with the information? | What you would not want me to do with it afterwards. |
| LEH-518 | D3 | Sex |  |  | How would you feel hearing one of mine? | Your anticipated reaction to hearing one of mine. |
| LEH-519 | D3 | Sex |  |  | What do you assume I fantasise about? | Your guess about my imagination. |
| LEH-520 | D3 | Sex |  | EXPERIMENT 3/4 | What are you curious about that you have never explored? | Curiosity, not commitment. |
| LEH-521 | D3 | Sex |  |  | What have you read or watched that stayed with you, and why? | Something read or watched that stayed with you, and why. |
| LEH-522 | D3 | Sex |  |  | What is the appeal of the unfamiliar for you? | The pull of the unfamiliar, if there is one. |
| LEH-523 | D3 | Sex |  |  | What is the appeal of the familiar? | The pull of the familiar. Comfort has its own appeal. |
| LEH-524 | D3 | Sex |  |  | Where do you want more adventure, and where do you want none? | Where you want adventure and where you want none. |
| LEH-525 | D3 | Sex |  | EXPERIMENT 4/4 | What would make an experiment feel like play rather than a test? | What turns an experiment into play instead of an examination. |
| LEH-526 | D3 | Sex |  | LIMITS 3/5 | How would we know to stop? | An agreed way to stop without anyone feeling rejected. |
| LEH-527 | D3 | Sex |  |  | How would we talk about it afterwards? | How we would discuss it afterwards. |
| LEH-528 | D3 | Sex |  | LIMITS 4/5 | What would help you not feel judged? | What would prevent you feeling judged. |
| LEH-529 | D2 | Sex |  | EXPERIMENT 1/4 | What is one thing you want to try in the next year? | One thing within the next year. |
| LEH-530 | D2 | Sex |  | EXPERIMENT 2/4 | What is one thing you are curious about but not ready for? | Curious but not ready. Both parts matter. |
| LEH-531 | D2 | Sex |  | LIMITS 1/5 | What is one thing that is permanently off the table? | A permanent no. State it clearly. |
| LEH-532 | D2 | Sex |  | LIMITS 2/5 | What would you want to know about my limits? | What you would want to know about my limits. |
| LEH-533 | D5 | Sex | yes | PRIVACY 3/4 | What have you explored on your own that I do not know about? | Solo exploration you have not mentioned. |
| LEH-534 | D4 | Sex |  | PRIVACY 2/4 | How do you feel about parts of your sexual life staying private? | Whether private parts of your sexual life should stay private. |
| LEH-535 | D5 | Sex |  |  | What would change between us if everything were disclosed? | The effect of total disclosure between us. |
| LEH-536 | D4 | Sex |  | PRIVACY 1/4 | What should stay private, in your view, and why? | What you believe should remain private, and why. |
| LEH-537 | D5 | Sex |  | PRIVACY 4/4 | Where is the line between privacy and secrecy for you? | Privacy is kept. Secrecy is hidden. Say where your line falls. |
| LEH-538 | D4 | Sex |  | LIMITS 5/5 | What agreement do we need about that line? | The agreement we need about that line. |
| LEH-539 | D3 | Sex |  |  | What do you want to feel that you are not currently feeling? | A feeling you want and are not currently getting. |
| LEH-540 | D3 | Sex |  |  | What is missing rather than wrong? | Missing is different from wrong. Name what is absent. |
| LEH-541 | D2 | Sex |  |  | What would you like to plan together? | Something to plan together. |
| LEH-542 | D2 | Sex |  |  | What does a night away mean to you? | What time away actually means to you. |
| LEH-543 | D2 | Sex |  | SETTING 1/4 | What environment changes how you feel? | How environment changes what you feel. |
| LEH-544 | D2 | Sex |  | SETTING 2/4 | What music, light or setting matters to you? | Sensory details. Sound, light, temperature, setting. |
| LEH-545 | D2 | Sex |  |  | What ritual would you want us to keep? | A practice worth keeping. |
| LEH-546 | D3 | Sex |  | SETTING 3/4 | What has been the best experience we have had, and what made it work? | The best experience we have had, and the reason it worked. |
| LEH-547 | D3 | Sex |  | SETTING 4/4 | What conditions would we need to recreate, rather than repeating the event itself? | Recreate conditions rather than repeat events. Say which conditions. |
| LEH-548 | D3 | Sex |  |  | What would you like me to initiate more often? | What you want me to start more often. |
| LEH-549 | D3 | Sex |  |  | What would you like to initiate yourself? | What you want to start yourself. |
| LEH-550 | D4 | Sex |  |  | What is the one thing you would most like to change, and what is the first step? | One change and its first practical step. |
---

## OPN. Openers block
Low exposure entry points spread across every domain. Written for a first session, or for a couple who are tired.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| OPN-551 | D1 | Self |  |  | What is the first thing you do when you get home? | Routine, not ritual. The automatic first move. |
| OPN-552 | D1 | Self |  |  | What did you eat today that you actually enjoyed? | Small and literal. Not a food philosophy. |
| OPN-553 | D1 | Self |  |  | What is currently playing in your head on repeat? | A song, a phrase, a scene, a worry. |
| OPN-554 | D1 | Self |  |  | What is the last thing that made you laugh properly? | Properly meaning out loud, not politely. |
| OPN-555 | D1 | Self |  |  | What is your current favourite way to waste an hour? | No justification needed. |
| OPN-556 | D1 | Self |  |  | What do you own that you would replace immediately if it broke? | Something you rely on more than you admit. |
| OPN-557 | D1 | Self |  |  | What is the best thing you have watched or read recently? | Anything counts. It does not have to be impressive. |
| OPN-558 | D1 | Self |  |  | Which day of the week suits you best, and why? | People differ more than they expect on this. |
| OPN-559 | D1 | Self |  |  | What is something you are looking forward to, however small? | Small is fine. A meal, a match, a delivery. |
| OPN-560 | D1 | Self |  |  | What is your default drink order? | And whether it has changed over the years. |
| OPN-561 | D1 | Self |  |  | What did you want to be when you were ten? | The answer you would have given then. |
| OPN-562 | D1 | Self |  |  | What is the last new thing you tried? | New to you. It does not have to be adventurous. |
| OPN-563 | D1 | Self |  |  | Where would you go tomorrow if travel were free and instant? | First place that comes to mind. |
| OPN-564 | D1 | Self |  |  | What is a small luxury you refuse to give up? | Something you would defend in a budget cut. |
| OPN-565 | D1 | Self |  |  | What do you always pack that you rarely use? | The thing you take just in case. |
| OPN-566 | D1 | Self |  |  | What time do you actually function best? | Honest answer, not the one your schedule imposes. |
| OPN-567 | D1 | Self |  |  | What is the last photograph you took, and why? | Check your phone if you cannot remember. |
| OPN-568 | D1 | Self |  |  | What smell takes you somewhere immediately? | And where it takes you. |
| OPN-569 | D1 | Self |  |  | What is your most used app, and are you happy about that? | Two parts. The fact and your view of it. |
| OPN-570 | D1 | Self |  |  | What would you do with a completely free Saturday? | Nobody else's plans in it. |
| OPN-571 | D1 | Attachment |  |  | What is your favourite thing about coming home to me? | One specific thing. |
| OPN-572 | D1 | Attachment |  |  | What is the smallest thing I do that you like? | Small. Not the big gestures. |
| OPN-573 | D1 | Attachment |  |  | When did you last think about me during the day? | And roughly what prompted it. |
| OPN-574 | D1 | Attachment |  |  | What is a nickname or private phrase only we use? | Or one you would like us to have. |
| OPN-575 | D1 | Attachment |  |  | What did we do together recently that you enjoyed more than expected? | The one that surprised you. |
| OPN-576 | D1 | Attachment |  |  | How do you prefer to be greeted after a day apart? | Practical. Contact, words, or a few minutes of quiet first. |
| OPN-577 | D1 | Attachment |  |  | What is a story about us you like telling other people? | And whether you tell it accurately. |
| OPN-578 | D1 | Attachment |  |  | What is the first thing you noticed about me? | Physical or otherwise. |
| OPN-579 | D1 | Attachment |  |  | What do we do well as a pair that we never mention? | Something functional and unremarked. |
| OPN-580 | D1 | Attachment |  |  | Which of my friends or family do you actually enjoy? | Genuine answer allowed. |
| OPN-581 | D1 | Attachment |  |  | What is a photograph of us you particularly like? | And what was happening in it. |
| OPN-582 | D1 | Attachment |  |  | What would you like us to do more of that costs nothing? | No money, no logistics. |
| OPN-583 | D1 | Attachment |  |  | What is something I said recently that stayed with you? | Positive or otherwise. Just something that stuck. |
| OPN-584 | D1 | Attachment |  |  | How do you like to spend the last hour before sleep? | Together, separately, or a mix. |
| OPN-585 | D1 | Attachment |  |  | What is a small thing I could do this week that would land well? | Specific and achievable. |
| OPN-586 | D1 | Sex |  |  | What kind of non sexual touch do you like most? | Hands, back, hair, proximity. Say which. |
| OPN-587 | D1 | Sex |  |  | Do you prefer being approached in words or in gesture? | Just a preference. No further detail needed. |
| OPN-588 | D1 | Sex |  |  | What is your favourite thing about the way I look? | One thing, said plainly. |
| OPN-589 | D1 | Sex |  |  | What makes you feel attractive, independent of me? | Clothes, exercise, sleep, work, anything. |
| OPN-590 | D1 | Sex |  |  | What time of day do you feel most at ease in your body? | Simply when, not why. |
| OPN-591 | D1 | Sex |  |  | What did you find attractive about me early on? | Then, not now. |
| OPN-592 | D1 | Sex |  |  | What kind of affection do you want more of in public? | Or less. Both are valid answers. |
| OPN-593 | D1 | Sex |  |  | What is your view on how much we talk about this generally? | Enough, too little, too much. |
| OPN-594 | D1 | Sex |  |  | What helps you unwind physically after a hard day? | Not necessarily sexual. Bath, walk, quiet, contact. |
| OPN-595 | D1 | Sex |  |  | What is something you like that is easy for me to do? | Low effort, high return. |
| OPN-596 | D1 | Money |  |  | What was the last thing you bought that you have no regrets about? | Any size. |
| OPN-597 | D1 | Money |  |  | What do you happily spend money on that others question? | Your indefensible spend. |
| OPN-598 | D1 | Money |  |  | What is your idea of a treat that costs very little? | Under the price of a coffee if possible. |
| OPN-599 | D1 | Money |  |  | Do you check your balance often or avoid it? | Habit, not judgement. |
| OPN-600 | D1 | Money |  |  | What would you buy first with an unexpected windfall? | First instinct, not the sensible answer. |
| OPN-601 | D1 | Money |  |  | What is the best value thing you own? | Cost against use. |
| OPN-602 | D1 | Money |  |  | What did money mean to you as a teenager? | Whether you had it, earned it, or worried about it. |
| OPN-603 | D1 | Money |  |  | Do you prefer to save toward something or spend as you go? | A general leaning, not a rule. |
| OPN-604 | D1 | Home |  |  | What household job do you genuinely not mind doing? | There is usually one. |
| OPN-605 | D1 | Home |  |  | What room in our home do you like most? | And what you do in it. |
| OPN-606 | D1 | Home |  |  | What is the one thing about our home you would change first? | Practical or cosmetic. |
| OPN-607 | D1 | Home |  |  | What do you need in the house to feel settled? | Tidiness, warmth, quiet, light, food in the fridge. |
| OPN-608 | D1 | Home |  |  | What is your least favourite household job? | Say it plainly. |
| OPN-609 | D1 | Home |  |  | Are you a list person or not? | How you keep track of what needs doing. |
| OPN-610 | D1 | Home |  |  | What does a well run week look like to you? | Describe the mechanics, not the mood. |
| OPN-611 | D1 | Home |  |  | What do you notice in the house that I never seem to? | Not an accusation. Just what your eye catches. |
| OPN-612 | D1 | Home |  |  | Where do you go in the house when you want to be alone? | And whether you get to. |
| OPN-613 | D1 | Home |  |  | What meal do you most enjoy making or eating at home? | Either side of it. |
| OPN-614 | D1 | Work |  |  | What part of your work do you actually enjoy? | There is usually something. |
| OPN-615 | D1 | Work |  |  | Who at work do you look forward to seeing? | And why them. |
| OPN-616 | D1 | Work |  |  | What does a good day at work look like? | Concrete. What happens in it. |
| OPN-617 | D1 | Work |  |  | What is the first job you ever had? | And what it taught you, if anything. |
| OPN-618 | D1 | Work |  |  | How do you know when you have switched off from work? | The signal, not the time. |
| OPN-619 | D1 | Work |  |  | What are you currently learning, at work or otherwise? | Formal or informal. |
| OPN-620 | D1 | Work |  |  | What is the most useful thing anyone has taught you professionally? | One thing. |
| OPN-621 | D1 | Work |  |  | What do you wish I understood about your working day? | The ordinary texture of it. |
| OPN-622 | D1 | Work |  |  | How much of your week feels like your own? | Rough proportion. |
| OPN-623 | D1 | Work |  |  | What would you do for work if money were irrelevant? | First answer, not the considered one. |
| OPN-624 | D1 | Future |  |  | What do you want to be doing this time next year? | One concrete thing. |
| OPN-625 | D1 | Future |  |  | Where would you like us to go together next? | Anywhere. Near counts. |
| OPN-626 | D1 | Future |  |  | What skill would you like us both to have? | Something learnable together. |
| OPN-627 | D1 | Future |  |  | What would you like our weekends to look like in five years? | The shape of them, not the location. |
| OPN-628 | D1 | Future |  |  | What is something you want to see or experience before you are old? | One item. |
| OPN-629 | D1 | Future |  |  | What tradition would you like us to start? | Something repeatable and small. |
| OPN-630 | D1 | Future |  |  | What would you like more of in the next twelve months? | Time, people, quiet, movement, anything. |
| OPN-631 | D1 | Future |  |  | What is a decision coming up that you want us to make together? | Something already on the horizon. |
| OPN-632 | D1 | Origin |  |  | What was your favourite place as a child? | And whether it still exists. |
| OPN-633 | D1 | Origin |  |  | What did a typical Sunday look like growing up? | The ordinary version, not the special one. |
| OPN-634 | D1 | Origin |  |  | Who made you laugh most in your family? | And how. |
| OPN-635 | D1 | Origin |  |  | What food takes you straight back to childhood? | And who made it. |
| OPN-636 | D1 | Origin |  |  | What were you good at as a child? | Anything. It does not have to have lasted. |
| OPN-637 | D1 | Origin |  |  | Who was your first proper friend? | And whether you are still in touch. |
| OPN-638 | D1 | Origin |  |  | What is a family saying you still use? | A phrase inherited without thinking. |
| OPN-639 | D1 | Origin |  |  | What did your parents do that you now understand better? | Something that makes more sense as an adult. |
| OPN-640 | D1 | Conflict |  |  | How do you prefer to be told that something is wrong? | Timing and manner. Not the content. |
| OPN-641 | D1 | Conflict |  |  | Do you need to sort things out before sleep, or not? | A simple preference. People differ strongly. |
| OPN-642 | D1 | Conflict |  |  | What is your usual sign that you are irritated? | The tell I should learn to read. |
| OPN-643 | D1 | Conflict |  |  | What helps you cool down fastest? | Practical. Walk, food, silence, distraction. |
| OPN-644 | D1 | Conflict |  |  | How did you make up with friends as a child? | The mechanism you learned young. |
| OPN-645 | D1 | Meaning |  |  | What makes you feel that a day was worthwhile? | Your own measure. |
| OPN-646 | D1 | Meaning |  |  | Where do you feel most peaceful? | A place, real or remembered. |
| OPN-647 | D1 | Meaning |  |  | What do you find beautiful that other people walk past? | Something ordinary you notice. |
| OPN-648 | D1 | Meaning |  |  | What is a value you were raised with that you still hold? | One you kept deliberately. |
| OPN-649 | D1 | Social |  |  | Which friendship of yours is in the best shape right now? | And what keeps it that way. |
| OPN-650 | D1 | Social |  |  | How much company do you want in an average week? | Honest amount, not the sociable answer. |
---

## MON. Money block
Inherited money scripts, spending style, power, provision, disclosure. No source authority on the reference list studies money, so this block is written to the subject rather than to a lens.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| MON-651 | D2 | Money |  | MONSCRIPT 1/5 | What did you learn about money by watching, rather than being told? | Attitudes absorbed from behaviour, not instruction. |
| MON-652 | D2 | Money |  | MONSCRIPT 2/5 | Was money a source of tension in your house growing up? | Describe the atmosphere, not the amounts. |
| MON-653 | D2 | Money |  | MONSCRIPT 3/5 | Who controlled the money where you grew up, and how did that show? | Control is not always the earner. |
| MON-654 | D3 | Money |  | MONSCRIPT 4/5 | What did having or not having money mean about your worth as a child? | The link between money and value, formed young. |
| MON-655 | D3 | Money |  | MONSCRIPT 5/5 | Which of those inherited attitudes are you still running? | Say which ones survived into now. |
| MON-656 | D2 | Money |  | MONSTYLE 1/5 | Are you a spender or a saver, honestly? | Your actual behaviour, not your intention. |
| MON-657 | D2 | Money |  | MONSTYLE 2/5 | What does financial security look like to you, in numbers or in feeling? | Either answer is valid. Say which one you use. |
| MON-658 | D2 | Money |  | MONSTYLE 3/5 | How much do you need in reserve before you stop worrying? | A figure or a feeling. |
| MON-659 | D3 | Money |  | MONSTYLE 4/5 | What do you spend on that you would rather I did not know about? | Not necessarily large. Just unmentioned. |
| MON-660 | D3 | Money |  | MONSTYLE 5/5 | Where do our spending instincts differ most? | The specific category, not a general verdict. |
| MON-661 | D2 | Money |  |  | How often do you actually want to talk about money? | Frequency, not willingness. |
| MON-662 | D2 | Money |  |  | Who should handle which parts of our finances? | Practical division. Bills, planning, investments, day to day. |
| MON-663 | D2 | Money |  |  | What is a purchase we should stop debating and simply decide? | Something recurring and unresolved. |
| MON-664 | D2 | Money |  |  | What is the right amount for either of us to spend without discussing it? | Name a number. |
| MON-665 | D2 | Money |  |  | Should we have entirely joint, entirely separate, or mixed accounts? | And your reasoning, briefly. |
| MON-666 | D2 | Money |  |  | What do you want us to be saving toward right now? | One priority, not a list. |
| MON-667 | D2 | Money |  |  | How much debt is acceptable to you, and for what? | Different debts carry different weight. |
| MON-668 | D2 | Money |  |  | What is your honest view of how we handle money as a pair? | Working, not working, or unexamined. |
| MON-669 | D2 | Money |  |  | Do you know what we actually spend each month? | Whether you know, not whether you should. |
| MON-670 | D2 | Money |  |  | What financial decision are we currently avoiding? | Something on the list that never gets to the top. |
| MON-671 | D2 | Money |  | MONGIVE 1/4 | How much should we give away, and to whom? | Charity, family, church, causes. |
| MON-672 | D2 | Money |  | MONGIVE 2/4 | What do you feel obliged to fund that you have never questioned? | Obligation, not choice. |
| MON-673 | D3 | Money |  | MONGIVE 3/4 | Which family member's money situation affects us most? | And how much you carry it. |
| MON-674 | D3 | Money |  | MONGIVE 4/4 | Where does generosity tip into being taken advantage of, for you? | Name where your line sits. |
| MON-675 | D2 | Money |  |  | What would you do differently with money if you were on your own? | Not a threat. Just the counterfactual. |
| MON-676 | D2 | Money |  |  | What is the biggest financial mistake you have made? | And whether you have forgiven yourself for it. |
| MON-677 | D2 | Money |  |  | What financial risk are you comfortable with that I might not be? | Investment, business, property, career. |
| MON-678 | D2 | Money |  |  | How would you want us to handle a sudden loss of income? | Practically. First moves. |
| MON-679 | D2 | Money |  |  | What does enough look like to you? | A number, a lifestyle, or a feeling. |
| MON-680 | D2 | Money |  |  | Do you compare our finances to other people's? | Honest answer. |
| MON-681 | D3 | Money |  | MONPOWER 1/6 | Does earning more entitle someone to more say? | Your genuine view, not the correct one. |
| MON-682 | D3 | Money |  | MONPOWER 2/6 | Have you ever felt you had to justify a purchase to me? | A specific instance. |
| MON-683 | D3 | Money |  | MONPOWER 3/6 | Where does money create an imbalance of power between us? | Name it plainly. |
| MON-684 | D3 | Money |  | MONPOWER 4/6 | Do you feel you have equal access to what we have? | Access, not ownership. |
| MON-685 | D4 | Money |  | MONPOWER 5/6 | Have you ever felt financially trapped in this relationship? | Trapped meaning unable to leave for money reasons. |
| MON-686 | D4 | Money |  | MONPOWER 6/6 | What would you need financially to feel genuinely independent? | A figure or a set of conditions. |
| MON-687 | D3 | Money |  |  | What do you think I get wrong about money? | Direct answer welcome. |
| MON-688 | D3 | Money |  |  | Where has money been used as an argument for something else? | Money is often the proxy, not the subject. |
| MON-689 | D3 | Money |  |  | What has money cost us in time or attention? | The trade you did not notice making. |
| MON-690 | D3 | Money |  |  | What are you working for, once the bills are paid? | The purpose behind the earning. |
| MON-691 | D3 | Money |  |  | Are we living the life our money should be buying? | Match between spend and satisfaction. |
| MON-692 | D3 | Money |  |  | What would you cut first if we had to cut? | Be specific. |
| MON-693 | D3 | Money |  |  | What would you protect last? | The thing that goes only when everything else has. |
| MON-694 | D3 | Money |  |  | How does your income affect how you value yourself? | The link between earning and worth, now. |
| MON-695 | D3 | Money |  |  | What do you feel guilty about spending on yourself? | And where that guilt started. |
| MON-696 | D3 | Money |  |  | What financial goal of mine do you privately think is unrealistic? | Say it kindly, but say it. |
| MON-697 | D3 | Money |  |  | Do you trust my judgement with money? | Honest, with reasons. |
| MON-698 | D3 | Money |  |  | What would change between us if we had significantly more? | And what would not. |
| MON-699 | D3 | Money |  |  | What would change if we had significantly less? | Test the relationship, not the budget. |
| MON-700 | D3 | Money |  |  | What conversation about money do we keep having without resolving? | Name the loop. |
| MON-701 | D4 | Money | yes | MONTRUTH 1/6 | Is there anything financial I do not currently know about? | Account, debt, loan, commitment, gift. |
| MON-702 | D4 | Money | yes | MONTRUTH 2/6 | Have you understated or overstated something financial to me? | Including by omission. |
| MON-703 | D4 | Money |  | MONTRUTH 3/6 | What have you spent that you would not want itemised? | You do not have to itemise it now. |
| MON-704 | D4 | Money | yes | MONTRUTH 4/6 | Have you lent or given money to someone without telling me? | Family, friend, or anyone else. |
| MON-705 | D5 | Money | yes | MONTRUTH 5/6 | Is there a debt in your name that I have never seen? | Straight answer. |
| MON-706 | D5 | Money | yes | MONTRUTH 6/6 | What would full financial transparency between us actually require? | Practically, and whether you want it. |
| MON-707 | D4 | Money |  |  | If one of us died tomorrow, would the other know where everything is? | Wills, accounts, policies, passwords. |
| MON-708 | D4 | Money |  |  | What financial provision have we failed to make for each other? | The gap you already know about. |
| MON-709 | D5 | Money | yes |  | Would you stay with me if the money disappeared entirely? | Uncomfortable and worth asking once. |
| MON-710 | D4 | Money |  |  | What is the single most honest thing you could say about money and us? | One sentence. |
---

## HOM. Home and household block
Division of labour, the invisible list, standards, space, the running of a shared life. Written to the subject.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| HOM-711 | D2 | Home |  | HOMLOAD 1/6 | Who actually notices when something needs doing in this house? | Noticing is work. Say who does it. |
| HOM-712 | D2 | Home |  | HOMLOAD 2/6 | Who keeps the mental list of what is running out? | The invisible inventory. |
| HOM-713 | D2 | Home |  | HOMLOAD 3/6 | Who remembers birthdays, appointments and school or family dates? | Administration, not affection. |
| HOM-714 | D3 | Home |  | HOMLOAD 4/6 | What do you do around here that goes completely unremarked? | Not fishing. Just naming it. |
| HOM-715 | D3 | Home |  | HOMLOAD 5/6 | Where do you feel like the manager rather than the partner? | Managing means delegating and following up. |
| HOM-716 | D3 | Home |  | HOMLOAD 6/6 | What would it take for you to stop being the one who tracks everything? | Practical. What would actually have to change. |
| HOM-717 | D2 | Home |  |  | What is your standard of clean, honestly? | Everyone has a different threshold. |
| HOM-718 | D2 | Home |  |  | Whose standard currently runs this house? | Say whose, without judgement. |
| HOM-719 | D2 | Home |  |  | What job do you do badly on purpose? | Everyone has one. |
| HOM-720 | D2 | Home |  |  | What household task should we simply pay someone to do? | If it is affordable, say which. |
| HOM-721 | D2 | Home |  |  | What would you like me to take over entirely? | Entirely meaning without reminders. |
| HOM-722 | D2 | Home |  |  | What would you not want to hand over, even if you could? | Something you want to keep. |
| HOM-723 | D2 | Home |  |  | How do you want the division of jobs decided, by preference or by fairness? | They are not the same thing. |
| HOM-724 | D2 | Home |  |  | What time of day does the house feel best to you? | And what makes it so. |
| HOM-725 | D2 | Home |  |  | How much mess can you tolerate before it affects your mood? | A threshold, roughly. |
| HOM-726 | D2 | Home |  |  | What does hospitality mean in this house? | How often, how formal, how much notice. |
| HOM-727 | D2 | Home |  |  | How do you feel about people arriving unannounced? | Honest answer. |
| HOM-728 | D2 | Home |  |  | What do you want our home to say about us? | To anyone who walks in. |
| HOM-729 | D2 | Home |  |  | What is the one purchase that would most improve daily life here? | Practical, not aspirational. |
| HOM-730 | D2 | Home |  |  | How much do you want to spend on where we live, as a share of what we earn? | A rough proportion. |
| HOM-731 | D2 | Home |  |  | Would you rather a smaller place in a better location, or the reverse? | And why. |
| HOM-732 | D2 | Home |  |  | What would make mornings work better? | Sequence, timing, who does what. |
| HOM-733 | D2 | Home |  |  | What would make evenings work better? | Same question, harder to answer. |
| HOM-734 | D2 | Home |  |  | How much time do we need in the same room without talking? | Companionable silence. Say how much you want. |
| HOM-735 | D2 | Home |  |  | How much time alone do you need at home each week? | A number of hours, roughly. |
| HOM-736 | D2 | Home |  |  | Do you get that time currently? | Straight yes or no, then explain. |
| HOM-737 | D3 | Home |  | HOMSPACE 1/4 | Where in the house is genuinely yours? | A room, a chair, a drawer. |
| HOM-738 | D3 | Home |  | HOMSPACE 2/4 | What do you do when you need to disappear for an hour? | And whether it works. |
| HOM-739 | D3 | Home |  | HOMSPACE 3/4 | Do you ever avoid coming home, even slightly? | Sitting in the car counts. |
| HOM-740 | D4 | Home |  | HOMSPACE 4/4 | What would have to change for home to feel like rest rather than a second job? | Be concrete. |
| HOM-741 | D2 | Home |  |  | What do we argue about most in the house? | The recurring domestic one. |
| HOM-742 | D3 | Home |  |  | Is that argument actually about the task, or about something else? | Usually it is something else. |
| HOM-743 | D3 | Home |  |  | Where do you feel taken for granted domestically? | Name the specific area. |
| HOM-744 | D3 | Home |  |  | Where do you think I feel taken for granted? | Your guess about me. |
| HOM-745 | D3 | Home |  |  | What have you stopped asking me to do? | Requests you gave up on. |
| HOM-746 | D3 | Home |  |  | What do you do instead of asking? | Do it yourself, resent it, let it slide. |
| HOM-747 | D2 | Home |  |  | What would a fair week look like in practical terms? | Hours and tasks, not principles. |
| HOM-748 | D2 | Home |  |  | Should we run a system, or keep improvising? | Rota, app, standing arrangement, or nothing. |
| HOM-749 | D2 | Home |  |  | What do you want reviewed regularly rather than argued about occasionally? | A standing conversation instead of a flashpoint. |
| HOM-750 | D2 | Home |  |  | How do you want to be asked for help? | Wording and timing. |
| HOM-751 | D2 | Home |  |  | What is the difference between helping and sharing, to you? | It matters more than it sounds. |
| HOM-752 | D3 | Home |  |  | Do you think our split is actually equal? | Your honest assessment. |
| HOM-753 | D3 | Home |  |  | If it is not, does that bother you? | Unequal is not automatically unfair. Say which it is. |
| HOM-754 | D2 | Home |  |  | What did the division of work look like in your parents' house? | And whether you have replicated it. |
| HOM-755 | D3 | Home |  |  | Which of your parents' domestic habits have you inherited? | Good or bad. |
| HOM-756 | D2 | Home |  |  | What do you want our home to feel like on a Sunday? | The atmosphere, not the activity. |
| HOM-757 | D2 | Home |  |  | What single change to the house would reduce friction most? | One change. |
| HOM-758 | D3 | Home |  |  | What are you tolerating at home that you should have raised? | Something you have absorbed. |
| HOM-759 | D3 | Home |  |  | What would you like me to notice without being told? | Be specific, so I can actually do it. |
| HOM-760 | D3 | Home |  |  | What is the most honest thing you could say about how we run this house? | One sentence. |
---

## FUT. Future and ageing block
Plans, timelines, ageing, care, mortality, what is actually being built. Written to the subject.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| FUT-761 | D2 | Future |  | FUTSHAPE 1/5 | What do you want the next five years to contain? | Contents, not achievements. |
| FUT-762 | D2 | Future |  | FUTSHAPE 2/5 | Where do you want to be living in ten years? | Country, city, type of place. |
| FUT-763 | D2 | Future |  | FUTSHAPE 3/5 | What do you want to have stopped doing by then? | Work, obligations, habits. |
| FUT-764 | D3 | Future |  | FUTSHAPE 4/5 | What are you afraid the next ten years will look like? | The version you do not want. |
| FUT-765 | D3 | Future |  | FUTSHAPE 5/5 | What would have to happen this year for that to be avoided? | One decisive thing. |
| FUT-766 | D2 | Future |  |  | What are we building, in one sentence? | If you cannot say it, that is the answer. |
| FUT-767 | D2 | Future |  |  | Do we actually want the same things, or have we assumed it? | Test the assumption. |
| FUT-768 | D2 | Future |  |  | What plan of ours has quietly expired? | Something we still say but no longer mean. |
| FUT-769 | D2 | Future |  |  | What are you postponing until a condition is met? | And what the condition is. |
| FUT-770 | D2 | Future |  |  | What would you like us to have achieved together? | Together, not individually. |
| FUT-771 | D2 | Future |  |  | What does retirement mean to you, if anything? | Stopping, slowing, or changing. |
| FUT-772 | D2 | Future |  |  | At what age would you like to be doing less? | A number. |
| FUT-773 | D2 | Future |  |  | What work would you still want to do even then? | Paid or not. |
| FUT-774 | D2 | Future |  |  | Where do you want to spend your last decades? | Place and company. |
| FUT-775 | D3 | Future |  | FUTAGE 1/5 | How do you feel about getting older? | Honestly, not gracefully. |
| FUT-776 | D3 | Future |  | FUTAGE 2/5 | What are you most afraid of losing as you age? | Capacity, looks, relevance, independence. |
| FUT-777 | D3 | Future |  | FUTAGE 3/5 | What do you assume I will find harder about ageing than you will? | Your read on me. |
| FUT-778 | D3 | Future |  | FUTAGE 4/5 | Who will look after us, and have we been honest about that? | Children, money, or nobody. |
| FUT-779 | D4 | Future |  | FUTAGE 5/5 | What would you want from me if I had to care for you? | Practical instructions. |
| FUT-780 | D2 | Future |  |  | What do you want your health to allow you to do at seventy? | Function, not numbers. |
| FUT-781 | D3 | Future |  |  | What are we not doing now that we will regret? | Regret is easier to predict than to feel. |
| FUT-782 | D3 | Future |  |  | What would you want said about our marriage in thirty years? | By us or by others. |
| FUT-783 | D3 | Future |  |  | What do you want to be true of us that is not true yet? | One thing. |
| FUT-784 | D3 | Future |  |  | What are you counting on happening that might not? | An assumption load bearing enough to matter. |
| FUT-785 | D3 | Future |  |  | What is your plan if that does not happen? | Say whether there is one. |
| FUT-786 | D2 | Future |  |  | What would you like to learn together in the next two years? | Something with a start date. |
| FUT-787 | D2 | Future |  |  | What experience do you want us to have while we still physically can? | Time limited by body, not by money. |
| FUT-788 | D2 | Future |  |  | What would you like our house to be full of in ten years? | People, quiet, work, grandchildren, projects. |
| FUT-789 | D2 | Future |  |  | What legacy, if any, matters to you? | Financial, familial, or none at all. |
| FUT-790 | D3 | Future |  |  | What do you want to have made peace with before you are old? | A relationship, a decision, a version of yourself. |
| FUT-791 | D3 | Future |  |  | What would you do differently if you knew you had ten good years left? | Not morbid. Clarifying. |
| FUT-792 | D3 | Future |  |  | What are you saving your energy for? | And whether that thing is coming. |
| FUT-793 | D3 | Future |  |  | Where are you living as though there is unlimited time? | The area you keep deferring. |
| FUT-794 | D3 | Future |  |  | What ambition of yours have I never taken seriously enough? | Say it directly. |
| FUT-795 | D3 | Future |  |  | What ambition of mine do you privately doubt? | Same courtesy in reverse. |
| FUT-796 | D2 | Future |  |  | What decision in the next year will matter most? | Identify it before it arrives. |
| FUT-797 | D2 | Future |  |  | What should we say no to this year? | Saying no is a plan. |
| FUT-798 | D2 | Future |  |  | What would you like more of, and what would you trade for it? | Every want has a cost. |
| FUT-799 | D3 | Future |  |  | What are you willing to sacrifice for the plan, and what are you not? | Be specific about the limit. |
| FUT-800 | D3 | Future |  |  | Where do our timelines conflict? | Same goal, different urgency, is still a conflict. |
| FUT-801 | D3 | Future |  |  | Whose plan currently takes priority, and is that agreed? | Often it is decided but never discussed. |
| FUT-802 | D4 | Future |  | FUTHARD 1/5 | What would you do if I could not work again? | Practically and emotionally. |
| FUT-803 | D4 | Future |  | FUTHARD 2/5 | What would you do if we had to start over financially? | Rebuild, downsize, or something else. |
| FUT-804 | D4 | Future |  | FUTHARD 3/5 | What would you want from me if you were seriously ill? | Instructions, not reassurance. |
| FUT-805 | D4 | Future |  | FUTHARD 4/5 | What do you want to happen after you die? | Arrangements and wishes. |
| FUT-806 | D5 | Future |  | FUTHARD 5/5 | Do you want me to remarry if you go first? | Ask it once, properly. |
| FUT-807 | D4 | Future |  |  | Have we made the practical arrangements a couple our age should have? | Wills, policies, powers of attorney. |
| FUT-808 | D5 | Future | yes |  | Do you see us together in twenty years? | Straight answer, then the reasoning. |
| FUT-809 | D5 | Future | yes |  | What would make you change that answer? | The condition, either way. |
| FUT-810 | D4 | Future |  |  | What is the most honest thing you can say about where we are heading? | One sentence. |
---

## WRK. Work and ambition block
Identity, hours, ambition, what the job costs and whether the trade holds. Written to the subject.

| ID | Depth | Domain | Stakes | Chain | Question | Context |
|---|---|---|---|---|---|---|
| WRK-811 | D2 | Work |  | WRKMEAN 1/5 | What does your work give you besides money? | Identity, structure, status, purpose, company. |
| WRK-812 | D2 | Work |  | WRKMEAN 2/5 | How much of your identity is your job? | A proportion, roughly. |
| WRK-813 | D3 | Work |  | WRKMEAN 3/5 | Who would you be without it? | Genuine question, not a threat. |
| WRK-814 | D3 | Work |  | WRKMEAN 4/5 | What are you proving, and to whom? | There is usually someone. |
| WRK-815 | D3 | Work |  | WRKMEAN 5/5 | What would it cost you to stop proving it? | Name the cost honestly. |
| WRK-816 | D2 | Work |  |  | How many hours a week do you actually want to work? | Your number, not the expected one. |
| WRK-817 | D2 | Work |  |  | What is the gap between that and reality? | And what causes the gap. |
| WRK-818 | D2 | Work |  |  | What part of your job would you drop tomorrow? | One thing. |
| WRK-819 | D2 | Work |  |  | What would you need to change jobs? | Money, confidence, timing, permission. |
| WRK-820 | D2 | Work |  |  | Do you want promotion, or do you want something else? | They are often confused. |
| WRK-821 | D2 | Work |  |  | What does success look like to you at work now? | Compared to ten years ago. |
| WRK-822 | D2 | Work |  |  | How much travel is acceptable in a year? | A number of nights away. |
| WRK-823 | D2 | Work |  |  | What time should work stop on a normal day? | And whether it does. |
| WRK-824 | D2 | Work |  |  | What do you want me to ask about your work, and what do you not? | Some people want interest, some want a break from it. |
| WRK-825 | D2 | Work |  |  | How can I tell when work has gone badly? | The signal, so I can read it. |
| WRK-826 | D2 | Work |  |  | What support do you want on a bad work week? | Practical, emotional, or none. |
| WRK-827 | D3 | Work |  | WRKCOST 1/6 | What has your work cost this relationship? | Time, attention, mood, presence. |
| WRK-828 | D3 | Work |  | WRKCOST 2/6 | What has it cost you personally? | Health, friendships, interests. |
| WRK-829 | D3 | Work |  | WRKCOST 3/6 | Is the trade still worth it? | Honest arithmetic. |
| WRK-830 | D3 | Work |  | WRKCOST 4/6 | When did you last consider changing something and decide not to? | And the reason you decided not to. |
| WRK-831 | D4 | Work |  | WRKCOST 5/6 | Do you resent me for anything connected to your career? | Choices made, or not made, because of us. |
| WRK-832 | D4 | Work |  | WRKCOST 6/6 | What career did you give up to be in this relationship? | Including the one you never attempted. |
| WRK-833 | D2 | Work |  |  | Whose career currently takes priority? | And whether that was agreed or assumed. |
| WRK-834 | D3 | Work |  |  | Is that arrangement still right? | Circumstances change. Say whether this one should. |
| WRK-835 | D3 | Work |  |  | What would you want if the priority switched? | Practically, what would need to happen. |
| WRK-836 | D3 | Work |  |  | Do you feel I understand what you actually do all day? | Honest answer. |
| WRK-837 | D3 | Work |  |  | Do you feel I am proud of your work? | And how you know. |
| WRK-838 | D3 | Work |  |  | Where do you feel underestimated at work? | And whether it matters to you. |
| WRK-839 | D3 | Work |  |  | What are you avoiding professionally? | A conversation, a decision, a risk. |
| WRK-840 | D3 | Work |  |  | What would you attempt if failure were survivable? | Assume you would recover. |
| WRK-841 | D2 | Work |  |  | What does your work look like in five years, realistically? | Realistic, not aspirational. |
| WRK-842 | D3 | Work |  |  | What would you do if you lost your job next month? | First moves. |
| WRK-843 | D3 | Work |  |  | How much of your stress comes home, and what does it look like here? | Your own assessment. |
| WRK-844 | D3 | Work |  |  | What do you need from me when work is taking everything? | Specific requests. |
| WRK-845 | D3 | Work |  |  | Where has ambition made you a worse partner? | Direct question, direct answer. |
| WRK-846 | D3 | Work |  |  | Where has it made you a better one? | The other side of it. |
| WRK-847 | D2 | Work |  |  | What boundary around work would you like us to hold together? | Something enforceable. |
| WRK-848 | D3 | Work |  |  | What have you missed at home that you cannot get back? | And whether it was worth it. |
| WRK-849 | D4 | Work | yes |  | If you had to choose between the career and this relationship, what happens? | Uncomfortable and clarifying. |
| WRK-850 | D3 | Work |  |  | What is the most honest thing you can say about work and us? | One sentence. |
---
## Build notes

**Where tranche two went.** 300 questions added. 100 low exposure openers spread across every domain, then four new subject blocks: Money 60, Home 50, Future 50, Work 40. Everyday was dissolved and its 32 cards reassigned. Corpus is now 850 across 11 domains, 81 chains covering 359 questions, 27 Stakes flags.

**D1 went from 26 to 126.** A couple taking four cards a session now has around thirty safe sessions before the shallow end runs out, against five before. This was the worst number in the corpus and it is now the second best.

**Money went from 2 to 70 and is playable at every depth.** It runs from what you learned by watching your parents through to whether there is a debt in your name I have never seen. Six of the Stakes flags sit here, which is correct: financial concealment ends marriages and the questions that surface it need a deliberate unlock.

**Home is the sleeper.** 60 questions on division of labour, the invisible list, standards and space. Nothing in the source literature covers it well and it is among the most common recurring grievances in modern couples. The HOMLOAD chain, on who notices what needs doing, is likely to be the highest yield sequence in the whole corpus.

**Still thin, in priority order.**

- Meaning at 4 and Social at 3. Both were opened by the openers block and neither has a body. Faith, purpose, values, friendship, community, and the phone in the room. Roughly 60 each.
- Parenting and children. Entirely absent. For couples with children this is the largest single subject of their shared life and the corpus says nothing.
- Living family and in laws. Origin covers the childhood family. It does not cover the mother in law who visits every Sunday.
- Health, body and illness. Currently scattered through Future and Sex rather than existing as a domain.
- Home D4 and D5, Work D4 and D5. Both blocks were written shallow. The deep end of both exists in real life: resentment about money and career sacrifice, the marriage that has become a household management contract.
- Conflict D3 at 13, against 18 at both D4 and D5. The middle of the conflict ladder is missing, so a couple steps from moderate disagreement straight to the unsaid.

**Sizing.** A live cell needs roughly 40 to 60 cards to survive ten sessions without repetition. On the current 11 domain grid that implies 1,400 to 1,800 for a complete version one. At 850 the corpus is a little over half built.

**Overlap is intentional.** Several questions recur in similar form across blocks because the subjects genuinely converge. Money, Work and Future overlap heavily by design. Do not deduplicate until performance data shows which phrasing survives.

**Provenance sits in the ID prefix.** Keep it when regrouping by domain. EFT is the only lens prefix that is not a surname. OPN, MON, HOM, FUT and WRK are subject blocks, not lenses.

**Numbers are permanent.** Retire IDs rather than reusing them. Analytics will key to them.
