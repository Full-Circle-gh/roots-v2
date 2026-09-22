// The free-of repair writes what it says it writes, and only that.
//
// WHY THIS FILE EXISTS. scripts/oneoff_free_of_from_sheet.js is run once,
// against production, through oneoff.yml, and it rewrites a column on ~250
// rows across two tables. A free-of flag is a promise to a shopper with an
// allergy, so "it looked right in the dry run" is not enough: the dry run and
// the apply share one code path, and what that path does needs pinning down
// where a change to it goes red.
//
// Four properties, and the last two are the ones that would hurt:
//
//   1. A row the sheet ANSWERS takes that answer whole.
//   2. A row the sheet does not name — or names with an EMPTY cell, which is
//      not an answer — keeps only nuts/soy/gluten/5 spice, and loses the three
//      retired flags and any free-text stray.
//   3. NOTHING IS INVENTED. A flag the row did not already claim is never
//      added to a row outside the sheet — that would be the system telling a
//      shopper a product is nut-free on no evidence at all.
//   4. IT IS IDEMPOTENT. Run twice and the second run writes nothing. A repair
//      that keeps finding work is a repair nobody can tell has finished.
//
// HOW IT RUNS WITHOUT A DATABASE. The script builds its own better-sqlite3
// handle from `${ROOTS_HOME}/node_modules/better-sqlite3`, so the test writes a
// stand-in for that module into a temp directory and points ROOTS_HOME there.
// The stub holds the fixture rows and records every write.
//
// THE STUB IS WRITTEN AT RUN TIME RATHER THAN CHECKED IN, and that is not
// tidiness: the path it has to live at ends in `node_modules/`, which
// .gitignore line 10 excludes. A checked-in copy would need `git add -f` and
// would then be invisible to `git status` forever after — a test fixture
// nobody can see is one that rots without anyone noticing.
//
// The rule under test is pure — it reads sku and free_of and writes free_of —
// so a real database file would add an install to the fast shard and prove
// nothing more about the rule. What the stub cannot prove is that the SQL is
// valid, so the statements are asserted literally below.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/oneoff_free_of_from_sheet.js');

// ── The stand-in for better-sqlite3 ────────────────────────────────────────
// Just wide enough to run the repair and record what it would write.
const STUB_SRC = `'use strict';
const state = { tables: {}, writes: [], prepared: [], transactions: 0 };
class Stmt {
  constructor(sql) { this.sql = sql; }
  _table() { const m = /\\b(?:FROM|UPDATE)\\s+(\\w+)/i.exec(this.sql); return m && m[1]; }
  get(...args) {
    if (/FROM sqlite_master/i.test(this.sql)) {
      return Object.prototype.hasOwnProperty.call(state.tables, args[0]) ? { 1: 1 } : undefined;
    }
    return undefined;
  }
  all() {
    const t = this._table();
    return (state.tables[t] || []).map(r => ({ id: r.id, sku: r.sku, name: r.name_en, free_of: r.free_of }));
  }
  run(...args) {
    state.writes.push({ sql: this.sql, args });
    if (/^UPDATE (\\w+) SET free_of = \\? WHERE id = \\?$/i.test(this.sql)) {
      const row = (state.tables[this._table()] || []).find(r => r.id === args[1]);
      if (row) row.free_of = args[0];
    }
    return { changes: 1 };
  }
}
class Database {
  prepare(sql) { state.prepared.push(sql); return new Stmt(sql); }
  pragma(q) {
    const m = /table_info\\((\\w+)\\)/.exec(q);
    if (!m) return [];
    const rows = state.tables[m[1]] || [];
    const names = rows.length ? Object.keys(rows[0]) : ['id', 'sku', 'name_en', 'free_of'];
    return names.map(name => ({ name }));
  }
  exec() {}
  transaction(fn) { return (...a) => { state.transactions++; return fn(...a); }; }
  close() {}
}
Database.__state = state;
module.exports = Database;
`;

const STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'freeof-stub-'));
const STUB_DIR = path.join(STUB, 'node_modules', 'better-sqlite3');
fs.mkdirSync(STUB_DIR, { recursive: true });
fs.writeFileSync(path.join(STUB_DIR, 'index.js'), STUB_SRC);
fs.writeFileSync(path.join(STUB_DIR, 'package.json'),
  JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-stub', main: 'index.js' }));
process.on('exit', () => { try { fs.rmSync(STUB, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

// Rows chosen from what the 2026-09-22 read-only run actually found on the
// live box, so the fixture is the real shapes rather than invented ones.
const FIXTURE = () => [
  // Named by the sheet. Sheet says nuts,soy,5 spice — gluten goes, and so does
  // the retired flag. This exact row is why "the sheet wins whole" matters:
  // MERGE would have kept the gluten claim the sheet dropped.
  { id: 1, sku: '2-140', name_en: 'Masala Chai Latte', free_of: 'nuts,soy,gluten,5 spice,animal products' },
  // Named by the sheet, and already right.
  { id: 2, sku: '1-50', name_en: 'Chickpea Salad', free_of: 'gluten' },
  // Named by the sheet with FULL-WIDTH brackets in the printed SKU.
  { id: 3, sku: 'S(1-30)', name_en: 'Tzatziki', free_of: 'gluten,animal products' },
  // NOT named by the sheet: keeps its four, loses the retired ones, and folds
  // the second spelling of 5-spice onto the first.
  { id: 4, sku: '4-640', name_en: 'Whole Sesame Tahini', free_of: 'nuts,soy,gluten,5spice,animal products' },
  // NOT named, and everything it claims is retired: it ends up blank.
  { id: 5, sku: '3-40', name_en: 'Baked Falafel', free_of: 'animal products' },
  // NOT named, nothing to do.
  { id: 6, sku: '3-999', name_en: 'Something Else', free_of: 'gluten' },
  // No SKU at all — reached only by the not-named rule. Six of these were on
  // the live box under one name.
  { id: 7, sku: null, name_en: '81% Hazel Chocolate Spread', free_of: 'gluten,soy,dairy,egg,5spice' },
  // NULL free_of must not churn to ''.
  { id: 8, sku: '3-998', name_en: 'Never Filled In', free_of: null },
  // A free-text stray the details panel parked here. It is not one of the four,
  // so it goes the same way the retired flags do.
  { id: 9, sku: '3-997', name_en: 'Hand-Typed', free_of: 'gluten,palm oil' },
  // ALREADY IN THE EDITOR'S OWN STYLE, canonical order, only the four. The
  // whole live catalogue looks like this — 287 values with the space after the
  // comma and not one without. It must be a no-op, or the repair rewrites a
  // third of the catalogue to change nothing a reader can see, and the next
  // person to press Save puts the space back.
  { id: 10, sku: '3-996', name_en: 'Already Right', free_of: 'nuts, soy, gluten, 5 spice' },
  // NAMED BY THE SHEET WITH AN EMPTY CELL (1-320 Thai Buckwheat Noodle Salad).
  // Ash: "ill fix them later ignore them" — so the blank is not an answer and
  // the not-named rule applies. It must NOT be read as "free of nothing"
  // (which would be indistinguishable here) and it must NOT be skipped
  // outright either: the retired flag still has to go, or "nothing else,
  // everywhere" has three exceptions nobody can see.
  { id: 11, sku: '1-320', name_en: 'Thai Buckwheat Noodle Salad', free_of: 'gluten, animal products' },
];

function run(rows, argv) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const Database = require(path.join(STUB, 'node_modules/better-sqlite3'));
  const st = Database.__state;
  st.tables = { store_products: rows };
  st.writes = []; st.prepared = []; st.transactions = 0;

  const oldHome = process.env.ROOTS_HOME, oldDb = process.env.ROOTS_DB, oldArgv = process.argv;
  const oldLog = console.log;
  process.env.ROOTS_HOME = STUB;
  process.env.ROOTS_DB = '/nonexistent/not-opened-by-the-stub.db';
  process.argv = ['node', SCRIPT, ...argv];
  console.log = () => {};                       // the script is chatty by design
  try { require(SCRIPT); }
  finally {
    console.log = oldLog;
    process.argv = oldArgv;
    if (oldHome === undefined) delete process.env.ROOTS_HOME; else process.env.ROOTS_HOME = oldHome;
    if (oldDb === undefined) delete process.env.ROOTS_DB; else process.env.ROOTS_DB = oldDb;
  }
  const wrote = new Map();
  for (const w of st.writes) if (/^UPDATE/i.test(w.sql)) wrote.set(w.args[1], w.args[0]);
  return { wrote, state: st, rows };
}

section('A dry run writes nothing');

check('no UPDATE is issued without --apply', () => {
  const { state } = run(FIXTURE(), []);
  const updates = state.writes.filter(w => /^UPDATE/i.test(w.sql));
  assert.strictEqual(updates.length, 0, `${updates.length} UPDATE(s) on a dry run`);
  assert.strictEqual(state.transactions, 0, 'a transaction was opened on a dry run');
});

section('What --apply writes');

const { wrote, state } = run(FIXTURE(), ['--apply']);

check('a row the sheet names takes the sheet\'s answer WHOLE', () => {
  // The sheet drops gluten from 2-140. Keeping it would be the merge rule Ash
  // was offered and did not take.
  assert.strictEqual(wrote.get(1), 'nuts, soy, 5 spice');
});

check('a full-width bracketed SKU still matches its sheet row', () => {
  assert.strictEqual(wrote.get(3), 'gluten', 'S(1-30) did not match — the bracket fold is broken');
});

check('a row already equal to the sheet is not touched', () => {
  assert.ok(!wrote.has(2), 'rewrote a row that was already correct');
});

check('a row outside the sheet keeps its four and loses the rest', () => {
  assert.strictEqual(wrote.get(4), 'nuts, soy, gluten, 5 spice');  // 5spice folded
  assert.strictEqual(wrote.get(5), '');                            // all it had was retired
  assert.strictEqual(wrote.get(7), 'soy, gluten, 5 spice');        // no sku, dairy+egg gone
  assert.strictEqual(wrote.get(9), 'gluten');                      // free-text stray gone
});

check('a row outside the sheet with nothing to lose is not touched', () => {
  assert.ok(!wrote.has(6), 'rewrote a row that was already only-the-four');
});

check('an EMPTY sheet cell is not an answer — the not-named rule applies', () => {
  /* Read as "free of nothing" this row would be cleared; skipped outright it
     would keep `animal products` forever. Neither is right: it keeps the
     gluten it already claims and loses the retired flag. */
  assert.strictEqual(wrote.get(11), 'gluten');
});

check('it writes the separator the EDITOR writes, ", " and not ","', () => {
  /* pdFreeOfGet() joins on ", ", and the live catalogue is written that way
     throughout. Joining on a bare comma made 143 of 402 rows in the 2026-09-22
     dry run a pure spacing rewrite — 109 of them on products the sheet never
     names — which every reader would have ignored and the next Save would have
     undone. */
  for (const v of wrote.values()) {
    if (!v.includes(',')) continue;
    assert.ok(!/,(?! )/.test(v), `"${v}" uses a bare comma; the editor writes ", "`);
  }
  assert.ok(!wrote.has(10),
    'rewrote a row that was ALREADY in the editor\'s style — this is the churn, exactly');
});

check('NULL is not churned into an empty string', () => {
  assert.ok(!wrote.has(8), 'rewrote a NULL row to "" — a change that changes nothing');
});

check('NOTHING IS INVENTED: no row gains a flag it did not already claim', () => {
  // Only the rows the sheet ANSWERS may gain a flag. 1-320 is named but its
  // cell is empty, so it is NOT in this set — nothing may be added to it.
  const sheetSkus = new Set(['2-140', '1-50', 's(1-30)']);
  for (const r of FIXTURE()) {
    if (!wrote.has(r.id)) continue;
    if (r.sku && sheetSkus.has(String(r.sku).toLowerCase())) continue;   // the sheet may add
    const before = new Set(String(r.free_of || '').split(',')
      .map(s => s.trim().toLowerCase()).map(s => /^5[\s-]*spice$/.test(s) ? '5 spice' : s));
    for (const t of wrote.get(r.id).split(',').map(x => x.trim()).filter(Boolean)) {
      assert.ok(before.has(t),
        `row ${r.id} (${r.name_en}) gained "${t}" it never claimed — that is the system ` +
        `telling a shopper something nobody checked`);
    }
  }
});

check('the write is one transaction, one column, by id', () => {
  assert.strictEqual(state.transactions, 1, 'the writes are not in a single transaction');
  for (const w of state.writes.filter(w => /^UPDATE/i.test(w.sql))) {
    assert.match(w.sql, /^UPDATE store_products SET free_of = \? WHERE id = \?$/,
      `unexpected statement: ${w.sql}`);
  }
});

section('It is idempotent');

check('a second --apply over the result writes nothing', () => {
  const first = run(FIXTURE(), ['--apply']);
  // The stub mutated its own rows, so hand them straight back.
  const second = run(first.rows, ['--apply']);
  const updates = second.state.writes.filter(w => /^UPDATE/i.test(w.sql));
  assert.strictEqual(updates.length, 0,
    `the second run still wants to write ${updates.length} row(s): ` +
    updates.map(u => `${u.args[1]}→"${u.args[0]}"`).join(', '));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
