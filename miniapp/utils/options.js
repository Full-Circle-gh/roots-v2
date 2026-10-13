// Chosen product options → one display string ("Heat up?: Yes · Cutlery?: No").
// One formatter for every screen that shows a customer's picks — cart, checkout,
// order detail, add-to-order — so the punctuation can't drift between them.
// Matches the printer (lib/feie.js optLine) and the backend order view
// (retail-admin/04-orders.js itemOptionsHtml): NAME, colon, one space, VALUE.
//
// Two option shapes reach this, and both must work:
//   • local cart lines  — { option_id, choice_id, question, label, delta }
//     with question/label ALREADY localised at add-time (product.js).
//   • server order lines — { option_id, choice_id, question_en, question_cn,
//     label, label_cn, delta } snapshotted at checkout (retail.js) and
//     backfilled by backfillOptionQuestions().
// Cart rows written to wx storage BEFORE this fix carry no name at all; those
// fall back to the bare value rather than rendering an orphan colon.

const lang = require('./lang');

// Pairs are joined with " · " on every screen. (The printer puts each pair on
// its own line instead — a thermal-paper constraint, not a screen pattern.)
const SEP = ' · ';

const txt = v => (v == null ? '' : String(v));

// The option's NAME — the question the customer answered. Prefer the
// already-localised `question` from a local cart line; otherwise pick the side
// matching the language from a server payload's question_en/question_cn.
// Empty when neither exists (pre-fix cart rows, or a since-deleted option).
function nameOf(o, L) {
  return txt(o.question).trim() || lang.pick(txt(o.question_en), txt(o.question_cn), L);
}

// The option's VALUE — the choice the customer picked. Local lines carry a
// single localised `label`; server lines carry label (EN) + label_cn. pick()
// falls back to whichever side exists, so both shapes resolve.
function valueOf(o, L) {
  return lang.pick(txt(o.label), txt(o.label_cn), L);
}

// One option → "Name: Value", or a bare "Value" when the name is unknown.
// `n` > 1 is how many times it was picked, read as "Value ×2".
// Returns '' when there's no value to show, so the caller can filter it out.
function formatOne(o, L, n) {
  if (!o) return '';
  // Legacy rows stored options as plain strings (no question, no choice id).
  if (typeof o === 'string') return o.trim();
  let value = valueOf(o, L);
  if (!value) return '';
  if (n > 1) value += ' ×' + n;
  const name = nameOf(o, L);
  return name ? name + ': ' + value : value;
}

// An options array → the display string. '' for an empty/missing array, so the
// existing `wx:if="{{item.display_options}}"` guards keep hiding the row.
// A REPEAT PICK IS THE SAME ENTRY WRITTEN TWICE (same choice_id), from a group
// that takes one answer more than once. It folds into one "Label ×2", placed
// where that choice first appears. An entry with no choice_id never folds.
function format(options, L) {
  if (!Array.isArray(options)) return '';
  const rows = [];
  const byId = {};
  options.forEach(o => {
    // The label must agree too: a ticket that read "Mango ×3" for three
    // different bites would be worse than one bite written twice.
    const id = o && typeof o === 'object' && o.choice_id != null && o.choice_id !== ''
      ? String(o.choice_id) + '|' + String(o.label != null ? o.label : (o.label_en || '')) : null;
    if (id != null && byId[id]) { byId[id].n += 1; return; }
    const row = { o, n: 1 };
    if (id != null) byId[id] = row;
    rows.push(row);
  });
  return rows.map(r => formatOne(r.o, L, r.n)).filter(Boolean).join(SEP);
}

// "Choose 2" under a pick-any question — how many of a group may be ticked, in
// words, for the two sheets that ask it (the shopper's product page and the
// counter's add-to-order). The numerals do the work, so a group that already
// says it in its own title (爽脆配菜) is confirmed rather than contradicted.
//
// Reads min_choices/max_choices off the payload, which the server has ALREADY
// clamped against the choices still pickable — so what this prints is what
// checkout will apply, even when an extra has sold out since the group was
// authored. Nothing is printed when a group has no limit, which is every group
// written before those two columns existed.
function limHint(o, L) {
  const min = Number(o && o.min_choices) || 0;
  const max = Number(o && o.max_choices) || 0;
  const cn = L === 'cn';
  if (min && max) {
    return min === max
      ? (cn ? ('选 ' + min + ' 项') : ('Choose ' + min))
      : (cn ? ('选 ' + min + '–' + max + ' 项') : ('Choose ' + min + '–' + max));
  }
  if (max) return cn ? ('最多 ' + max + ' 项') : ('Up to ' + max);
  if (min) return cn ? ('至少 ' + min + ' 项') : ('At least ' + min);
  return '';
}

module.exports = { format, formatOne, limHint, SEP };
