// Reading a nutrition column into rows a page can draw.
//
// WHY THIS IS IN lib/ RATHER THAN IN THE PAGE THAT NEEDED IT. The column holds
// { basis_en, basis_cn, rows: [{ label_en, label_cn, value }] } and nothing in
// it says that Saturated belongs UNDER Fat. That structure comes from two lists
// of label names, and until now those lists existed once, inside
// miniapp/pages/shop/../product/product.js, where only the mini app could reach
// them. The counter menu is the second reader; a second copy of the lists would
// be two answers to one question, and the kind that goes wrong quietly — a
// label falling out of the parent list indents nothing and looks merely plain.
//
// THE MINI APP STILL CARRIES ITS OWN COPY and cannot require this file: it is a
// WeChat bundle with no module resolution into the repo. So the duplication is
// not removed, it is made VISIBLE — scripts/test_nutrition_rows.js reads the
// mini app's source and fails if the two lists disagree. That is the same
// arrangement the counter menu already has with public/shop.html's card sizes:
// one source of truth, and a test that goes red when a copy drifts.
//
// A ROW IS NEVER INVENTED AND NEVER DROPPED FOR BEING UNRECOGNISED. A label
// this file has not heard of renders as an ordinary row, because the office
// types these by hand and a new line — Fibre, Calcium — must appear on the
// customer's screen the day it is typed, not the day somebody remembers to add
// it here.

'use strict';

// Rows that carry a bold label and stand on their own.
const PARENT = ['energy', 'total fat', 'fat', 'carbohydrate', 'carbohydrates',
                '能量', '脂肪', '总脂肪', '碳水化合物'];
// Rows that indent under the one above, em-dashed and muted.
const CHILD  = ['saturated', 'saturated fat', 'unsaturated', 'unsaturated fat',
                'sugars', '饱和脂肪', '不饱和脂肪', '糖'];

function classify(label) {
  const k = String(label == null ? '' : label).trim().toLowerCase();
  if (PARENT.includes(k)) return 'parent';
  if (CHILD.includes(k)) return 'child';
  return 'normal';
}

// The column as stored -> { basis_en, basis_cn, rows } ready to draw, or null.
//
// Returns null rather than an empty shell when there is nothing to show, so a
// caller writes `if (n)` and never draws a heading over no rows. Accepts the
// column as a JSON string or as an already-parsed object, because the two
// readers get it differently and neither should have to know.
function nutritionRows(raw) {
  let n = raw;
  if (typeof n === 'string') {
    if (!n.trim()) return null;
    try { n = JSON.parse(n); } catch { return null; }
  }
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;

  const rows = (Array.isArray(n.rows) ? n.rows : [])
    .map(r => {
      const en = String((r && r.label_en) || '').trim();
      const cn = String((r && r.label_cn) || '').trim();
      const value = String((r && r.value) || '').trim();
      return {
        label_en: en, label_cn: cn, value,
        // CLASSIFIED OFF WHICHEVER LABEL THE OFFICE FILLED, English first —
        // the same rule the mini app applies. A row typed in Chinese alone
        // still indents correctly, because both vocabularies are in the lists.
        kind: classify(en || cn),
      };
    })
    // A row with no label AND no value is an empty line in the editor, not a
    // nutrient. One with a label and no value is kept: "Salt —" is a statement.
    .filter(r => r.label_en || r.label_cn || r.value);

  if (!rows.length) return null;
  return {
    basis_en: String(n.basis_en || '').trim(),
    basis_cn: String(n.basis_cn || '').trim(),
    rows,
  };
}

module.exports = { nutritionRows, classify, PARENT, CHILD };
