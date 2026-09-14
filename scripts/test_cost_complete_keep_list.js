#!/usr/bin/env node
//
// test_cost_complete_keep_list.js — the forty products Ash excluded from the
// 2026-09-14 "this cost is not complete" sweep, and the one-off that marks
// everything else.
//
// WHAT THIS IS FOR
// ----------------
// The sweep's whole correctness is a string-matching question. Forty SKUs were
// typed by hand off a page that folds variants, and the database does not fold:
// the pack is `3-251` and the single is `S(3-251)`, two rows. Between those two
// facts sit three ways to mark a product Ash asked to spare, and none of them
// would announce itself afterwards — a wrongly marked row looks exactly like a
// rightly marked one.
//
//   1. `1-30` matching inside `1-300`. Both are real SKUs; the first is a
//      keeper (Tzatziki) and the second is not (Quinoa Salad). An unbounded
//      substring match spares the wrong product.
//   2. `S(3-250)` reading as the keeper `3-251`, or as a keeper at all. It
//      names 3-250, which nobody excluded.
//   3. `1-310 D` matching no row at all. Its product IS spared, by `1-310` —
//      but a keeper that matches nothing is normally a typo, and the one-off
//      must tell the two apart rather than treating every miss as harmless.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * The predicates are lib/cost-complete-keep-list.js itself, required.
//   * The sweep is scripts/oneoff_mark_cost_incomplete.js, spawned as a child
//     process against a temporary SQLite file, exactly as
//     .github/workflows/oneoff.yml spawns it — including the --apply flag and
//     the ROOTS_DB/ROOTS_HOME environment it is given there. A rewritten
//     predicate fails here; a copy of the predicate in this file would not.
//
// The temporary database is created under os.tmpdir() and removed at the end.
// No production path is opened and nothing here reaches the network.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const keep = require(path.join(ROOT, 'lib', 'cost-complete-keep-list.js'));
const ONEOFF = path.join(ROOT, 'scripts', 'oneoff_mark_cost_incomplete.js');

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push('  ok   ' + name); }
  catch (e) { failures++; results.push('  FAIL ' + name + '\n         ' + e.message); }
}

// ── 1 · the list itself ──────────────────────────────────────────────────────
check('the forty are forty, with no duplicate once normalised', () => {
  assert.strictEqual(keep.KEEP_SKUS.length, 40);
  assert.strictEqual(keep.KEEP_KEYS.size, 40);
});

check('matching ignores case and spacing, so a stored 1-310D is the keeper 1-310 D', () => {
  for (const spelling of ['1-310 D', '1-310D', '1-310d', ' 1-310  D ']) {
    assert.ok(keep.isKeeper(spelling), spelling + ' should be a keeper');
  }
});

check('1-30 does NOT match inside 1-300 — both are real products, one is not a keeper', () => {
  assert.ok(keep.isKeeper('1-30'), '1-30 is a keeper');
  assert.ok(!keep.isKeeper('1-300'), '1-300 must not be');
  assert.ok(!keep.namesKeeper('1-300'), '1-300 must not name one either');
});

check('a null or empty sku is never a keeper', () => {
  for (const v of [null, undefined, '']) assert.ok(!keep.isKeeper(v));
});

// ── 2 · the other-pack rule ──────────────────────────────────────────────────
check("a row naming a keeper's code is recognised, in every bracket style used", () => {
  assert.ok(keep.namesKeeper('S(3-251)'), 'single unit');
  assert.ok(keep.namesKeeper('(3-210) X5'), 'multipack');
  assert.ok(keep.namesKeeper('(3-210) X 3'), 'multipack, spaced');
  assert.ok(keep.namesKeeper('S(1-30）'), 'half-width open, full-width close — a real row');
  assert.ok(keep.namesKeeper('（4-680）+（4-690）'), 'bundle of two keepers');
});

check('a row naming a NON-keeper is not spared by the rule', () => {
  assert.ok(!keep.namesKeeper('S(3-250)'), '3-250 was not excluded');
  assert.ok(!keep.namesKeeper('S3-252'), '3-252 was not excluded');
});

check('a keeper does not "name" itself — that would be its own rule, not this one', () => {
  assert.ok(!keep.namesKeeper('3-251'));
});

// ── 3 · the sweep, spawned the way the workflow spawns it ────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-sweep-'));
const dbFile = path.join(tmp, 'roots.db');

function build(extraRows) {
  try { fs.unlinkSync(dbFile); } catch (e) { /* first build */ }
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE store_products(
    id INTEGER PRIMARY KEY, sku TEXT, name_en TEXT, is_active INTEGER,
    unit_cost REAL, cost_incomplete INTEGER, variant_group_id TEXT)`);
  const ins = db.prepare('INSERT INTO store_products VALUES (?,?,?,?,?,?,?)');
  let id = 1;
  for (const s of keep.KEEP_SKUS) {
    // The two " D" spellings name no row of their own — the live catalogue
    // holds 1-310 and 1-320 and nothing else, which is the case section 3
    // exists to pin.
    if (/ D$/.test(s)) continue;
    ins.run(id, s, 'Keeper ' + s, 1, 5,
      (s === '1-90' || s === '1-370') ? 1 : null,
      s === '3-251' ? 'g1' : s === '3-210' ? 'g2' : null);
    id++;
  }
  ins.run(200, 'S(3-251)', 'Pita single', 1, 1, null, 'g1');
  ins.run(201, '(3-210) X5', 'Sorbet 5pk', 1, null, null, 'g2');
  ins.run(202, '（4-680）+（4-690）', 'PB Duo', 1, null, null, null);
  ins.run(203, 'S(3-250)', 'Rye single', 1, null, null, null);
  ins.run(204, '1-300', 'Quinoa Salad', 1, 7, null, null);
  ins.run(205, '9-01', 'Plain target', 1, 2, null, null);
  ins.run(206, null, 'No sku', 1, null, null, null);
  ins.run(207, null, 'Deleted product', 0, null, null, null);
  if (extraRows) extraRows(ins);
  db.close();
}

function runSweep(apply) {
  const args = [ONEOFF].concat(apply ? ['--apply'] : []);
  try {
    return { code: 0, out: execFileSync(process.execPath, args, {
      env: Object.assign({}, process.env, { ROOTS_HOME: ROOT, ROOTS_DB: dbFile }),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const tagOf = (sku) => {
  const db = new Database(dbFile, { readonly: true });
  const r = db.prepare('SELECT cost_incomplete AS c FROM store_products WHERE sku IS ?').get(sku);
  db.close();
  return r ? r.c : undefined;
};

build();
const dry = runSweep(false);
check('a dry run writes nothing and says so', () => {
  assert.strictEqual(dry.code, 0, dry.out);
  assert.ok(/DRY RUN — nothing was written/.test(dry.out), dry.out);
  assert.strictEqual(tagOf('9-01'), null, 'a target must still be untagged after a dry run');
});

check('the two " D" keepers are reported as explained rather than aborting the run', () => {
  assert.ok(/1-310 D\s+explained/.test(dry.out), dry.out);
  assert.ok(/1-320 D\s+explained/.test(dry.out), dry.out);
});

const applied = runSweep(true);
check('applying writes only the targets', () => {
  assert.strictEqual(applied.code, 0, applied.out);
  assert.strictEqual(tagOf('9-01'), 1, 'plain target marked');
  assert.strictEqual(tagOf('1-300'), 1, 'Quinoa Salad is not the keeper 1-30');
  assert.strictEqual(tagOf('S(3-250)'), 1, '3-250 was never excluded');
  assert.strictEqual(tagOf(null), 1, 'the active row with no sku');
});

check('a keeper, and the same goods in another pack, are left alone', () => {
  assert.strictEqual(tagOf('3-251'), null, 'keeper');
  assert.strictEqual(tagOf('S(3-251)'), null, 'single unit, same variant family');
  assert.strictEqual(tagOf('(3-210) X5'), null, 'multipack, same variant family');
  assert.strictEqual(tagOf('（4-680）+（4-690）'), null, 'bundle naming two keepers');
});

check('a keeper that already carried the tag keeps it — the sweep clears nothing', () => {
  assert.strictEqual(tagOf('1-90'), 1);
  assert.strictEqual(tagOf('1-370'), 1);
});

check('a deleted product is not touched', () => {
  const db = new Database(dbFile, { readonly: true });
  const r = db.prepare('SELECT cost_incomplete AS c FROM store_products WHERE id = 207').get();
  db.close();
  assert.strictEqual(r.c, null);
});

const again = runSweep(true);
check('running it twice is a no-op the second time', () => {
  assert.strictEqual(again.code, 0, again.out);
  assert.ok(/Nothing to do/.test(again.out), again.out);
});

// ── 4 · the guard ────────────────────────────────────────────────────────────
build((ins) => { ins.run(300, '1-20', 'Duplicate of a keeper sku', 1, null, null, null); });
const dup = runSweep(true);
check('a keeper matching two rows aborts before writing anything', () => {
  assert.strictEqual(dup.code, 1, dup.out);
  assert.ok(/ABORTED/.test(dup.out), dup.out);
  assert.strictEqual(tagOf('9-01'), null, 'nothing written');
});

// A keeper whose product is genuinely absent — the typo case. Removing 1-460
// leaves it explained by nothing, unlike the " D" spellings.
build();
{
  const db = new Database(dbFile);
  db.prepare("DELETE FROM store_products WHERE sku = '1-460'").run();
  db.close();
}
const typo = runSweep(true);
check('a keeper explained by nothing aborts — the typo case the " D" rows are not', () => {
  assert.strictEqual(typo.code, 1, typo.out);
  assert.ok(/1-460\s+UNEXPLAINED/.test(typo.out), typo.out);
  assert.strictEqual(tagOf('9-01'), null, 'nothing written');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('test_cost_complete_keep_list.js');
for (const line of results) console.log(line);
console.log(failures ? `\n${failures} FAILED` : `\n${results.length} passed`);
process.exit(failures ? 1 : 0);
