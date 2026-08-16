'use strict';

/**
 * The eleven topic colours, held at one luminance.
 *
 * WHAT WAS WRONG WITH THE OLD SET
 * --------------------------------
 * The colours these replace were picked one at a time and they editorialised:
 * Money was green, Sex was a deep magenta, Conflict was red. Two problems with
 * that, and the second is the serious one.
 *
 *   1. They sat at wildly different lightnesses - #F2A33C against #8E2D63 -
 *      so on the topic list some subjects shouted and others receded. The eye
 *      reads that as importance, and it was accidental.
 *
 *   2. A colour that comments on its subject tells a couple which
 *      conversations are the dangerous ones before they have had any of them.
 *      Red for Conflict is a warning label on a topic they chose. Green for
 *      Money is a judgement about what a good answer looks like.
 *
 * The replacements all sit at roughly the same lightness and saturation, so no
 * topic looks heavier than another and the colour does nothing except tell them
 * apart. Meaning is carried by DEPTH, which has its own ramp, and by the Stakes
 * flag - both of which a couple opts into.
 *
 * Matched on slug, and touches ONLY `accent`. Names, taglines, descriptions,
 * order and active state are the owner's and are not this script's business.
 *
 * Idempotent: re-running reports that everything already matches.
 */

const { pool, query } = require('../db');

/** slug -> the colour from the palette sheet. */
const DOMAIN_COLOURS = {
  self: '#8C9AAE',
  attachment: '#AF8FA0',
  conflict: '#B58C7E',
  origin: '#A99A7E',
  sex: '#B0788A',
  money: '#7FA391',
  home: '#98A47F',
  work: '#7E9CA4',
  future: '#8E96B8',
  meaning: '#9186B5',
  social: '#83A5A8',
};

async function run() {
  const rows = await query('SELECT id, slug, name, accent FROM domains');
  if (!rows.length) return 'no domains yet - nothing to recolour';

  const changed = [];
  const missing = [];

  for (const [slug, hex] of Object.entries(DOMAIN_COLOURS)) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) {
      missing.push(slug);
      continue;
    }
    if (String(row.accent).toUpperCase() === hex) continue;
    // eslint-disable-next-line no-await-in-loop
    await query('UPDATE domains SET accent = ? WHERE id = ?', [hex, row.id]);
    changed.push(`${row.name} ${row.accent} -> ${hex}`);
  }

  // Reported rather than ignored: a topic the owner added itself keeps whatever
  // colour they gave it, and a slug in this list that has no row means the
  // topic was renamed or removed and this list has drifted.
  const extra = rows.filter((r) => !DOMAIN_COLOURS[r.slug]).map((r) => r.name);

  const parts = [];
  parts.push(changed.length ? `${changed.length} recoloured (${changed.join('; ')})` : 'already the palette colours');
  if (missing.length) parts.push(`not found: ${missing.join(', ')}`);
  if (extra.length) parts.push(`left alone (not in the palette sheet): ${extra.join(', ')}`);
  return parts.join(' | ');
}

module.exports = { run, DOMAIN_COLOURS };

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
