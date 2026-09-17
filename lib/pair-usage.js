// COUNTING WHAT A SHOP ACTUALLY SAYS — the machinery behind every "offered
// because you say it" pick list in the product editor.
//
// WHY THIS IS A MODULE (§159). §156 moved the spec strip's value lists out of
// the editor's source, where they were Roots' catalogue offered to every tenant
// on the platform, and into a count over that tenant's own cells. §159 does the
// same for the storage box's four lists. Both counts are the same arithmetic —
// tally bilingual pairs, keep the commonest spelling of each, drop what does not
// repeat — and writing it twice would be two rules that agree until they don't.
//
// THE THREE RULES IT ENCODES, each of them decided rather than incidental:
//
//   1. A PAIR IS TAKEN WHOLE OR NOT AT ALL. The entire point of these controls
//      (§145) is that one pick fills BOTH languages. Counting a half-written
//      cell would let the list offer a pair whose Chinese is blank — the exact
//      fault the dropdown was built to stop, re-entering through the list
//      rather than the keyboard. The caller passes both halves; a missing one
//      means the answer is not counted.
//
//   2. THE COMMONEST SPELLING REPRESENTS THE ANSWER. `Net Wt` 163 times and
//      `Net wt` once is one answer spelled two ways, not two answers. Variants
//      are tallied under one key and the most-used wording wins the row, which
//      is how the list self-corrects as a catalogue grows.
//
//   3. AN ANSWER MUST HAVE BEEN USED TWICE TO BE OFFERED BACK. §145 gave Net Wt
//      no value list by NAMING the field — 163 cells held 67 distinct weights,
//      and a dropdown nobody can find their product in is worse than a typed
//      box. A per-tenant count cannot carry a hard-code for the words "net wt",
//      so the judgement is read off the data instead. A field of one-offs
//      collapses to nothing; the three or four answers a shop genuinely repeats
//      become a list worth opening.

/**
 * A tally of bilingual answers under one heading.
 *
 * Usage:
 *   const c = makeCounter();
 *   c.bump('origin', 'Guangzhou, China', '中国广州');
 *   c.rank(8, 2);   // → [{ en, cn, n }], commonest first
 */
function makeCounter() {
  // key → { n, pairs: Map(JSON [en,cn] → count) }
  const entries = new Map();
  return {
    /**
     * Count one answer. `en` and `cn` are trimmed by the caller; a blank on
     * either side is not an answer and is ignored here too, so no caller can
     * forget rule 1.
     */
    bump(key, en, cn) {
      const e = String(en || '').trim(), c = String(cn || '').trim();
      if (!key || !e || !c) return;
      let row = entries.get(key);
      if (!row) { row = { n: 0, pairs: new Map() }; entries.set(key, row); }
      row.n++;
      // JSON, not a delimiter: an answer may contain any character at all, and
      // a separator that can appear in the data is a separator that will.
      const pk = JSON.stringify([e, c]);
      row.pairs.set(pk, (row.pairs.get(pk) || 0) + 1);
    },
    /** How many answers were counted under `key`, all spellings together. */
    total(key) { const r = entries.get(key); return r ? r.n : 0; },
    /**
     * The offered list: commonest first, capped, and filtered to answers used
     * at least `min` times (rule 3 — pass 1 to offer everything).
     */
    rank(cap, min) {
      const floor = min == null ? 1 : min;
      const out = [];
      for (const row of entries.values()) {
        let top = null, topN = -1;
        for (const [pk, n] of row.pairs) if (n > topN) { topN = n; top = pk; }
        if (row.n < floor) continue;
        let en = '', cn = '';
        try { [en, cn] = JSON.parse(top); } catch (e) { continue; }
        out.push({ en, cn, n: row.n });
      }
      out.sort((a, b) => b.n - a.n);
      return cap ? out.slice(0, cap) : out;
    },
  };
}

/**
 * The same tally for a field that is ONE value rather than a pair — the storage
 * box's icon, which is an emoji and belongs to no language. Rules 2 and 3 still
 * apply; rule 1 cannot, because there is no second half to be missing.
 */
function makeSingleCounter() {
  // key → { n, spellings: Map(exact value → count) }. The two levels matter for
  // the same reason rule 2 matters above, and §147 is the case that proves it:
  // ❄ and ❄️ LOOK IDENTICAL AND ARE NOT — the second carries U+FE0F. Counting
  // them as two answers would let the picker offer both, which is the drift the
  // icon list was built to end rather than extend. The caller supplies the key
  // it wants them folded under; the commonest exact spelling wins the row.
  const entries = new Map();
  return {
    bump(key, v) {
      const val = String(v || '').trim();
      const k = String(key == null ? val : key).trim();
      if (!val || !k) return;
      let row = entries.get(k);
      if (!row) { row = { n: 0, spellings: new Map() }; entries.set(k, row); }
      row.n++;
      row.spellings.set(val, (row.spellings.get(val) || 0) + 1);
    },
    rank(cap, min) {
      const floor = min == null ? 1 : min;
      const out = [];
      for (const row of entries.values()) {
        if (row.n < floor) continue;
        let top = null, topN = -1;
        for (const [v, n] of row.spellings) if (n > topN) { topN = n; top = v; }
        out.push({ v: top, n: row.n });
      }
      out.sort((a, b) => b.n - a.n);
      const list = cap ? out.slice(0, cap) : out;
      return list.map(o => o.v);
    },
  };
}

module.exports = { makeCounter, makeSingleCounter };
