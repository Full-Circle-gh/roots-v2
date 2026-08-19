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
// Returns '' when there's no value to show, so the caller can filter it out.
function formatOne(o, L) {
  if (!o) return '';
  // Legacy rows stored options as plain strings (no question, no choice id).
  if (typeof o === 'string') return o.trim();
  const value = valueOf(o, L);
  if (!value) return '';
  const name = nameOf(o, L);
  return name ? name + ': ' + value : value;
}

// An options array → the display string. '' for an empty/missing array, so the
// existing `wx:if="{{item.display_options}}"` guards keep hiding the row.
function format(options, L) {
  if (!Array.isArray(options)) return '';
  return options.map(o => formatOne(o, L)).filter(Boolean).join(SEP);
}

module.exports = { format, formatOne, SEP };
