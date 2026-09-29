// Switching a whole variant family on or off the online store — §294.
//
// THE TRAP. One size of a family can be kept off the online store on purpose
// (the per-size tick box in the Variants table writes that size's own
// is_published). The family switches — the Products list switch, bulk Turn
// on / Turn off, the page designer's Online store button, the phone admin's
// switch — used to write one value to every size, so a size hidden on purpose
// came back the next time anyone switched the family off and on again.
//
// THE RULE, in one place so the four switches cannot disagree:
//   OFF  A family that is partly on is remembered first: each size that is off
//        is marked kept_off_online = 1, each that is on is marked 0. A fully-on
//        family clears every mark. A fully-off family keeps its marks. Then
//        every size goes off.
//   ON   A family with any size already live is left exactly as it is: a size
//        off while a sibling is on is off on purpose. Otherwise the unmarked
//        sizes come on; if every size is marked, all come on and the marks
//        clear, since the operator asked for the product and there would be
//        nothing to show.
//
// A lone product (no variant_group_id) is a family of one, and the rule gives
// the plain answer for it: off is off, on is on.
'use strict';

// Every active member of the families these ids belong to, grouped by family.
function familiesOf(db, ids) {
  const clean = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!clean.length) return [];
  const ph = clean.map(() => '?').join(',');
  const seeds = db.prepare(
    `SELECT id, variant_group_id FROM store_products
      WHERE id IN (${ph}) AND COALESCE(is_active, 1) = 1`
  ).all(...clean);
  const groups = new Set();
  const lone = [];
  for (const s of seeds) {
    if (s.variant_group_id) groups.add(s.variant_group_id);
    else lone.push(s.id);
  }
  const out = [];
  const byGroup = db.prepare(
    `SELECT id, COALESCE(is_published, 0) AS is_published, COALESCE(kept_off_online, 0) AS kept_off_online
       FROM store_products
      WHERE variant_group_id = ? AND COALESCE(is_active, 1) = 1
      ORDER BY id`
  );
  for (const g of groups) out.push(byGroup.all(g));
  const one = db.prepare(
    `SELECT id, COALESCE(is_published, 0) AS is_published, COALESCE(kept_off_online, 0) AS kept_off_online
       FROM store_products WHERE id = ?`
  );
  for (const id of lone) out.push([one.get(id)]);
  return out.filter(f => f.length);
}

// What each member should become. Pure — takes a family's current rows and
// returns the target { id, is_published, kept_off_online } for every member.
function plan(members, on) {
  const live = members.filter(m => m.is_published === 1);
  if (on) {
    if (live.length) return members.map(m => ({ ...m }));
    const unmarked = members.filter(m => m.kept_off_online !== 1);
    if (!unmarked.length) return members.map(m => ({ id: m.id, is_published: 1, kept_off_online: 0 }));
    return members.map(m => ({ id: m.id, is_published: m.kept_off_online === 1 ? 0 : 1, kept_off_online: m.kept_off_online }));
  }
  if (!live.length) return members.map(m => ({ ...m }));
  const partly = live.length < members.length;
  return members.map(m => ({
    id: m.id,
    is_published: 0,
    kept_off_online: partly && m.is_published !== 1 ? 1 : 0,
  }));
}

// Apply the rule to the families of `ids`. Returns every member of every
// family touched as { id, is_published, kept_off_online } (the caller's cache
// needs the whole family), and `changed`, the ids whose row was written.
// `beforeWrite(id)`, when given, runs just before a row is written — where the
// route takes the product's pre-edit version snapshot, as the PATCH does.
function setFamiliesPublished(db, ids, on, beforeWrite) {
  const families = familiesOf(db, ids);
  const rows = [];
  const changed = [];
  const upd = db.prepare(
    `UPDATE store_products SET is_published = ?, kept_off_online = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  db.transaction(() => {
    for (const members of families) {
      const before = new Map(members.map(m => [m.id, m]));
      for (const t of plan(members, !!on)) {
        const b = before.get(t.id);
        if (b.is_published !== t.is_published || b.kept_off_online !== t.kept_off_online) {
          if (beforeWrite) beforeWrite(t.id);
          upd.run(t.is_published, t.kept_off_online, t.id);
          changed.push(t.id);
        }
        rows.push(t);
      }
    }
  })();
  return { rows, changed };
}

module.exports = { setFamiliesPublished, plan, familiesOf };
