// Read-only: which products carry a hide_qr flag, and does it look deliberate?
//
// WHY. Between deploy #2067 and the fix in §142, opening a product in the page
// editor and saving it wrote `hide_qr: true` onto whichever block was SELECTED
// — which is the FIRST one unless the office clicked another. The flag was
// never chosen by anybody; it came from an inverted checkbox being read by the
// editor's generic form sync. See §142 for the mechanism.
//
// THIS SCRIPT REPAIRS NOTHING, ON PURPOSE. A blanket "clear every hide_qr"
// would undo the real ones somebody set deliberately in the same window, and
// the two are indistinguishable from the flag alone. What it can do is sort
// them by how the accident looked: the accident always landed on the FIRST
// block and always alone. A product whose only flagged block is #1 is the
// shape of the bug; a product with a flag further down, or with several, was
// almost certainly a person. Read the list, then clear the accidents from the
// editor by clicking the eye — which is now one click and visibly correct.
//
//   node scripts/diagnose_hide_qr_flags.js
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'database.js'));

const rows = db.prepare(`
  SELECT id, name_en, name_cn, description_blocks, updated_at
    FROM store_products
   WHERE description_blocks IS NOT NULL
     AND description_blocks LIKE '%hide_qr%'
   ORDER BY updated_at DESC
`).all();

if (!rows.length) {
  console.log('\nNo product carries a hide_qr flag. Nothing to look at.\n');
  process.exit(0);
}

const looksAccidental = [];
const looksDeliberate = [];

for (const r of rows) {
  let blocks;
  try { blocks = JSON.parse(r.description_blocks); } catch { continue; }
  if (!Array.isArray(blocks)) continue;
  const flagged = blocks
    .map((b, i) => (b && b.hide_qr ? { i: i + 1, type: b.type } : null))
    .filter(Boolean);
  if (!flagged.length) continue;
  const rec = { id: r.id, name: r.name_en || r.name_cn || ('#' + r.id),
                when: r.updated_at, flagged, total: blocks.length };
  // The accident's fingerprint: exactly one flag, on block 1.
  (flagged.length === 1 && flagged[0].i === 1 ? looksAccidental : looksDeliberate).push(rec);
}

const show = (title, list, note) => {
  console.log('\n' + title + '  (' + list.length + ')');
  console.log(note);
  if (!list.length) { console.log('  — none —'); return; }
  for (const r of list) {
    const which = r.flagged.map(f => '#' + f.i + ' ' + f.type).join(', ');
    console.log(`  ${String(r.id).padStart(5)}  ${(r.name || '').slice(0, 34).padEnd(34)}  ` +
                `${r.flagged.length}/${r.total} hidden: ${which}   last saved ${r.when || 'unknown'}`);
  }
};

console.log('\nProducts carrying a hide_qr flag — ' + rows.length + ' found.');
show('LOOKS LIKE THE BUG', looksAccidental,
  '  Exactly one flag, on the FIRST block. That is where the fault always landed.\n' +
  '  Check each against what the office meant to do before clearing it.');
show('LOOKS DELIBERATE', looksDeliberate,
  '  A flag further down the stack, or more than one. A person almost certainly did this.\n' +
  '  Leave these alone unless the office says otherwise.');
console.log('\nNothing was changed. Clear an accident from the product editor:\n' +
            '  open the product, click the amber eye on that section, Save.\n');
