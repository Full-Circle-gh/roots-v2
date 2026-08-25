#!/usr/bin/env node
/**
 * verify_made_material_links.js — the zero-delta gate for §29 step 1.
 *
 * Step 1 (schema + links + writer guards + cycle guard) is DEFINED as
 * invisible: it links 27 materials to the recipes that make them and stops
 * every cost writer from clobbering them, but it must not move a single
 * cost_per_unit. This asserts that, against whichever database it is pointed
 * at — a copy for rehearsal, then production after deploy. A fixture passing
 * is not evidence about production, which is why this takes a path.
 *
 * Checks:
 *   1. every one of the 27 expected pairs is linked
 *   2. NO row outside those 27 carries a source_recipe_id
 *   3. the partial unique index exists AND actually rejects a second material
 *      pointing at the same recipe  (the only check that writes — and it
 *      writes only inside a transaction it always rolls back; skipped unless
 *      --probe-index is passed, so the default run is strictly read-only)
 *   4. cost_per_unit matches a baseline file, row for row  (--baseline=FILE,
 *      in `id|cost_per_unit` lines as sqlite3 emits them)
 *
 * Usage:
 *   node scripts/verify_made_material_links.js --db=/root/roots-v2/data/roots.db \
 *        --baseline=/tmp/baseline.txt [--probe-index]
 *
 * Exit 0 = every check passed. Exit 1 = at least one did not.
 */
'use strict';

const path = require('path');
const fs = require('fs');

function loadSqlite() {
  try { return require('better-sqlite3'); } catch (e) { /* fall through */ }
  for (const base of [path.join(__dirname, '..', '..', '..', '..'), '/root/roots-v2']) {
    try { return require(path.join(base, 'node_modules', 'better-sqlite3')); } catch (e) { /* next */ }
  }
  console.error('better-sqlite3 not found.');
  process.exit(2);
}
const Database = loadSqlite();

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const DB_PATH   = arg('db', '/root/roots-v2/data/roots.db');
const BASELINE  = arg('baseline', null);
const PROBE     = process.argv.includes('--probe-index');
const EMIT      = process.argv.includes('--emit-baseline');

// The 27, from docs/tacet-consolidation-decisions.md §29 addendum. Duplicated
// from database.js on purpose: a gate that imports the thing it is checking
// proves only that one list equals itself.
const EXPECTED = [
  [239, 57], [575, 19], [623, 37], [616, 92], [617, 40], [613, 62], [620, 45],
  [612, 11], [621, 44], [619, 38], [624, 93], [615, 21], [622, 46], [572, 15],
  [574, 16], [581, 24], [578, 25], [587, 36], [586, 50], [590, 51], [584, 53],
  [588, 54], [589, 58], [591, 61], [603, 86], [618, 94], [627, 103],
];

const db = new Database(DB_PATH, { readonly: !PROBE, fileMustExist: true });

// Emit a baseline THROUGH THIS SAME READER. The first rehearsal took the
// baseline from the sqlite3 CLI and compared it here, which reported 15 rows
// as "changed" that had not changed at all: the CLI prints a REAL at ~15
// significant digits (0.018475) while JavaScript prints the full round-trip
// form of the identical double (0.018475000000000002). Same bits, two
// spellings. A gate whose two sides format numbers differently reports
// formatting as a delta — so both sides come from here now, and any
// difference it reports is a real one.
if (EMIT) {
  const rows = db.prepare('SELECT id, cost_per_unit FROM ingredients ORDER BY id').all();
  const out = rows.map(r => `${r.id}|${r.cost_per_unit === null || r.cost_per_unit === undefined ? '' : String(Number(r.cost_per_unit))}`).join('\n');
  process.stdout.write(out + '\n');
  db.close();
  process.exit(0);
}

let failures = 0;
const ok   = (m, d) => console.log(`PASS  ${m}${d ? '\n        ' + d : ''}`);
const bad  = (m, d) => { failures++; console.log(`FAIL  ${m}${d ? '\n        ' + d : ''}`); };

console.log(`db: ${DB_PATH}`);
console.log(`mode: ${PROBE ? 'read-write (index probe, always rolled back)' : 'READ-ONLY'}\n`);

// ── 1 · all 27 linked ──────────────────────────────────────────────────────
{
  const missing = [];
  const wrong = [];
  const get = db.prepare('SELECT id, name_en, source_recipe_id FROM ingredients WHERE id = ?');
  for (const [ingId, recId] of EXPECTED) {
    const row = get.get(ingId);
    if (!row) { missing.push(`#${ingId} (row absent)`); continue; }
    if (row.source_recipe_id === null || row.source_recipe_id === undefined) missing.push(`#${ingId} ${row.name_en}`);
    else if (row.source_recipe_id !== recId) wrong.push(`#${ingId} ${row.name_en}: expected recipe ${recId}, got ${row.source_recipe_id}`);
  }
  if (missing.length || wrong.length) {
    bad(`all 27 expected materials are linked`, [...missing.map(m => 'unlinked: ' + m), ...wrong].join('\n        '));
  } else {
    ok(`all 27 expected materials are linked to the right recipe`);
  }
}

// ── 2 · no 28th row acquired one ───────────────────────────────────────────
{
  const linked = db.prepare('SELECT id, name_en, source_recipe_id FROM ingredients WHERE source_recipe_id IS NOT NULL').all();
  const expectedIds = new Set(EXPECTED.map(([i]) => i));
  const extra = linked.filter(r => !expectedIds.has(r.id));
  if (linked.length !== EXPECTED.length || extra.length) {
    bad(`exactly ${EXPECTED.length} rows are linked, no more`,
        `found ${linked.length} linked` + (extra.length ? `; unexpected: ${extra.map(r => `#${r.id} ${r.name_en} -> recipe ${r.source_recipe_id}`).join(', ')}` : ''));
  } else {
    ok(`exactly ${linked.length} rows are linked — no 28th`);
  }
}

// ── 3 · the partial unique index exists, and bites ─────────────────────────
{
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_ingredients_source_recipe'").get();
  if (!idx) bad('partial unique index idx_ingredients_source_recipe exists');
  else ok('partial unique index idx_ingredients_source_recipe exists');

  if (idx && PROBE) {
    // Point a second, unrelated material at a recipe that already backs one.
    // Wrapped in a transaction that always throws at the end, so nothing is
    // ever committed whichever way the constraint behaves.
    const [takenIng, takenRecipe] = EXPECTED[0];
    const victim = db.prepare('SELECT id FROM ingredients WHERE source_recipe_id IS NULL AND id != ? LIMIT 1').get(takenIng);
    let rejected = false, note = '';
    try {
      db.transaction(() => {
        db.prepare('UPDATE ingredients SET source_recipe_id = ? WHERE id = ?').run(takenRecipe, victim.id);
        throw new Error('__rollback__');   // never commit, whatever happened
      })();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(e.message)) { rejected = true; note = e.message; }
      else if (e.message !== '__rollback__') { note = 'unexpected: ' + e.message; }
    }
    if (rejected) ok('a second material pointing at the same recipe is REJECTED', note);
    else bad('a second material pointing at the same recipe is REJECTED',
             `the write was accepted (rolled back) — the index is not enforcing. ${note}`);
    // Belt: prove nothing stuck.
    const after = db.prepare('SELECT source_recipe_id FROM ingredients WHERE id = ?').get(victim.id);
    if (after.source_recipe_id !== null) bad('index probe left no trace', `row ${victim.id} still linked!`);
    else ok('index probe left no trace (rolled back cleanly)');
  } else if (idx) {
    console.log('SKIP  index enforcement probe (pass --probe-index to run it)');
  }
}

// ── 4 · zero delta on cost_per_unit ────────────────────────────────────────
if (BASELINE) {
  if (!fs.existsSync(BASELINE)) {
    bad('baseline file readable', `not found: ${BASELINE}`);
  } else {
    const before = new Map();
    for (const line of fs.readFileSync(BASELINE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const [id, cpu] = t.split('|');
      before.set(Number(id), cpu === undefined || cpu === '' ? '' : String(Number(cpu)));
    }
    const now = db.prepare('SELECT id, cost_per_unit FROM ingredients ORDER BY id').all();
    const moved = [];
    const appeared = [];
    for (const r of now) {
      const b = before.get(r.id);
      const n = r.cost_per_unit === null || r.cost_per_unit === undefined ? '' : String(Number(r.cost_per_unit));
      if (b === undefined) { appeared.push(`#${r.id} (not in baseline)`); continue; }
      if (b !== n) moved.push(`#${r.id}: ${b} -> ${n}`);
    }
    const vanished = [...before.keys()].filter(id => !now.find(r => r.id === id));
    if (moved.length) {
      bad(`ZERO DELTA: no cost_per_unit moved`, `${moved.length} row(s) changed:\n        ` + moved.slice(0, 40).join('\n        '));
    } else {
      ok(`ZERO DELTA: all ${now.length} cost_per_unit values identical to baseline`);
    }
    if (appeared.length || vanished.length) {
      console.log(`NOTE  row-count changed since baseline — new: ${appeared.length}, gone: ${vanished.length}` +
                  (appeared.length ? '\n        ' + appeared.slice(0, 10).join(', ') : ''));
    }
  }
} else {
  console.log('SKIP  zero-delta check (pass --baseline=FILE to run it)');
}

db.close();
console.log();
if (failures) { console.log(`${failures} check(s) FAILED.`); process.exit(1); }
console.log('All checks passed.');
