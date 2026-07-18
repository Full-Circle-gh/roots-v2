#!/usr/bin/env node
/* Headless tiling test for the retail-admin dashboard bento solver.
 *
 * The dashboard (public/retail-admin/03-dashboard.js) packs each visible
 * .td-block into a 6-column grid with a small solver (dashGenBands ->
 * dashSolve). The solver's correctness invariant, for EVERY subset of visible
 * blocks and EVERY order the operator might drag them into, is:
 *
 *   1. dashSolve returns a non-null solution (so the render never falls back
 *      to the ugly full-width stack at 03-dashboard.js line ~1156), and
 *   2. the chosen bands place every block exactly once (no block dropped,
 *      none placed twice), and
 *   3. no band exceeds 6 columns.
 *
 * The DASH_SHAPES / DASH_PRI / DASH_COLS and the three solver functions below
 * are copied VERBATIM from 03-dashboard.js — if you change them there, change
 * them here and re-run:  node scripts/dash-solver-test.js
 *
 * Kept in step with the 2026-07 dashboard simplification: movers / week /
 * channels / moves left the dashboard, "unhandled" (Unhandled orders, status
 * =paid) joined. `unhandled` shares the exact list-block shape menu of
 * incoming / drafts / onroad / ready, so it introduces no new tiling pattern.
 */
'use strict';

// ── copied verbatim from 03-dashboard.js ────────────────────────────────────
const DASH_COLS = 6;
const DASH_SHAPES = {
  recap:     [[3,2],[6,2],[4,2],[6,1],[4,1],[3,1],[2,1]],
  needs:     [[3,2],[6,2],[4,2],[6,1],[4,1],[3,1],[2,1]],
  orders:    [[3,2],[4,2],[6,2],[2,2],[4,1],[3,1],[2,1]],
  customers: [[3,1],[4,1],[2,1],[3,2],[2,2],[6,1]],
  inventory: [[2,2],[3,2],[4,2],[3,1],[2,1],[4,1],[6,1]],
  // incoming = warehouse-only "On the way / Drafts" (in-transit POs + drafted-
  // not-placed, merged into one card). List block.
  incoming:  [[3,2],[4,2],[2,2],[3,1],[4,1],[2,1],[6,1]],
  // onroad/ready = dispatch/CS list blocks.
  onroad:    [[3,2],[4,2],[2,2],[3,1],[4,1],[2,1],[6,1]],
  ready:     [[3,2],[4,2],[2,2],[3,1],[4,1],[2,1],[6,1]],
  // unhandled = "Unhandled orders" (status=paid), warehouse + dispatch/CS.
  unhandled: [[3,2],[4,2],[2,2],[3,1],[4,1],[2,1],[6,1]],
  delivery:  [[2,1],[3,1],[4,1],[2,2],[6,1]],
};
const DASH_PRI = { recap: 2, needs: 2, orders: 3, customers: 1, inventory: 2, incoming: 2, onroad: 2, ready: 2, unhandled: 2, delivery: 1 };

function dashPrefScore(id, w, h) {
  const S = DASH_SHAPES[id]; if (!S) return null;
  const i = S.findIndex(s => s[0] === w && s[1] === h);
  if (i < 0) return null;
  return (S.length - i) * 20 + (DASH_PRI[id] || 1) * (w * h);
}
function dashGenBands(ids, i, emit) {
  (function rec1(k, cells, sum, score) {
    if (k >= ids.length) return;
    for (const [w, h] of DASH_SHAPES[ids[k]]) {
      if (h !== 1) continue;
      const s2 = sum + w; if (s2 > DASH_COLS) continue;
      const sc = score + dashPrefScore(ids[k], w, 1);
      const cl = cells.concat([{ idx: k, w }]);
      if (s2 >= 2) emit({ h: 1, cells: cl, sum: s2, score: sc - (DASH_COLS - s2) * 70, next: k + 1 });
      rec1(k + 1, cl, s2, sc);
    }
  })(i, [], 0, 0);
  (function rec2(k, slots, sum, score) {
    if (slots.length && sum >= 4) emit({ h: 2, slots, sum, score: score - (DASH_COLS - sum) * 70, next: k });
    if (k >= ids.length || sum >= DASH_COLS) return;
    const a = ids[k];
    for (const [w, h] of DASH_SHAPES[a]) {
      if (h !== 2 || sum + w > DASH_COLS) continue;
      rec2(k + 1, slots.concat([{ type: 'one', idx: k, w }]), sum + w, score + dashPrefScore(a, w, 2));
    }
    if (k + 1 < ids.length) {
      const b = ids[k + 1];
      const aw = new Set(DASH_SHAPES[a].filter(s => s[1] === 1).map(s => s[0]));
      for (const [w, h] of DASH_SHAPES[b]) {
        if (h !== 1 || !aw.has(w) || sum + w > DASH_COLS) continue;
        rec2(k + 2, slots.concat([{ type: 'pair', a: k, b: k + 1, w }]), sum + w,
          score + dashPrefScore(a, w, 1) + dashPrefScore(b, w, 1) + 6);
      }
    }
  })(i, [], 0, 0);
}
function dashSolve(ids) {
  const N = ids.length, memo = new Array(N + 1);
  function best(i) {
    if (i === N) return { score: 0, bands: [] };
    if (memo[i] !== undefined) return memo[i];
    let bs = null; const opts = [];
    dashGenBands(ids, i, b => opts.push(b));
    for (const b of opts) {
      const r = best(b.next); if (!r) continue;
      const sc = b.score + r.score;
      if (!bs || sc > bs.score) bs = { score: sc, bands: [b].concat(r.bands) };
    }
    return (memo[i] = bs);
  }
  return best(0);
}

// ── verification ────────────────────────────────────────────────────────────
// Assert a solution tiles `ids` cleanly: every index 0..n-1 placed once, and no
// band wider than 6 columns.
function checkSolution(ids, sol) {
  if (!sol || !sol.bands) return 'null solution (would fall back to full-width stack)';
  const seen = new Array(ids.length).fill(0);
  for (const band of sol.bands) {
    let sum = 0;
    if (band.h === 1) {
      for (const c of band.cells) { seen[c.idx]++; sum += c.w; }
    } else {
      for (const s of band.slots) {
        sum += s.w;
        if (s.type === 'one') seen[s.idx]++;
        else { seen[s.a]++; seen[s.b]++; }
      }
    }
    if (sum > DASH_COLS) return `band sum ${sum} > ${DASH_COLS} cols`;
  }
  for (let i = 0; i < ids.length; i++) {
    if (seen[i] !== 1) return `block "${ids[i]}" placed ${seen[i]}x (expected once)`;
  }
  return null;   // ok
}

function subsets(arr) {
  const out = [];
  for (let m = 1; m < (1 << arr.length); m++) {
    const s = [];
    for (let i = 0; i < arr.length; i++) if (m & (1 << i)) s.push(arr[i]);
    out.push(s);
  }
  return out;
}
function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i]].concat(p);
  }
}

function run(label, blocks, opts) {
  opts = opts || {};
  let pass = 0, fail = 0; const fails = [];
  // (a) every subset, in default order
  for (const s of subsets(blocks)) {
    const err = checkSolution(s, dashSolve(s));
    if (err) { fail++; if (fails.length < 8) fails.push(`[${s.join(',')}] ${err}`); } else pass++;
  }
  // (b) every ordering of the FULL set — stresses drag-reorder
  if (opts.permuteFull) {
    for (const p of permutations(blocks)) {
      const err = checkSolution(p, dashSolve(p));
      if (err) { fail++; if (fails.length < 8) fails.push(`[${p.join(',')}] ${err}`); } else pass++;
    }
  }
  const ok = fail === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${pass} ok, ${fail} bad)`);
  for (const f of fails) console.log(`        ↳ ${f}`);
  return ok;
}

// Owner is the only role that can Arrange (drag-reorder), and the owner view is
// now the 4-card glance — recap · needs · orders(Today) · customers. That is the
// whole set owner can reorder, so permuting all of it is trivial. FULL is every
// block any role can reach (owner's 4 + the warehouse/dispatch cards + the
// unhandled card), checked all-subsets — restricted roles can't reorder, so
// all-subsets is enough for them. WAREHOUSE is the shipped warehouse view
// (recap · needs · unhandled · inventory · on-the-way/drafts), checked as its
// own set so the exact combination that goes live is proven to tile.
const OWNER = ['recap', 'needs', 'orders', 'customers'];
const FULL  = ['recap', 'needs', 'orders', 'customers', 'unhandled', 'inventory', 'incoming', 'onroad', 'ready', 'delivery'];
const WAREHOUSE = ['recap', 'needs', 'unhandled', 'inventory', 'incoming'];

console.log('Dashboard bento solver — tiling invariant\n');
let ok = true;
ok = run('owner 4-card view — all subsets + all orderings', OWNER, { permuteFull: true }) && ok;
ok = run('full 10 blocks (all owner + warehouse + dispatch) — all subsets', FULL) && ok;
ok = run('warehouse 5-card view — all subsets', WAREHOUSE) && ok;

console.log('');
if (!ok) { console.log('RESULT: FAIL — a block set does not tile; do NOT ship the shapes as-is.'); process.exit(1); }
console.log('RESULT: PASS — every subset and ordering tiles cleanly.');
