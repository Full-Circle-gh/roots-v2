// The Eleme discount backfill writes two rows, the right two, and rolls back on
// anything it did not expect (npm run test:eleme-ingest-backfill).
//
// scripts/repair_eleme_ingest_backfill.js writes a money column on production
// rows, so what needs proving is not that it can write — it is that it REFUSES
// to. Each case below runs the REAL script, as a child process, against a
// scratch DB built from database.js's own DDL, with one fact changed:
//
//   A  the happy path              → both rows written, nothing else touched
//   B  dry run                     → prints the plan, writes nothing
//   C  a payload that disagrees    → aborts, writes nothing
//   D  fees not backfilled yet     → aborts, and names the script to run first
//   E  an id pointing at another order_no → aborts, writes nothing
//   F  both rows already correct   → exits 0 having written nothing
//   G  one row already correct     → aborts rather than writing half
//   H  a row holding a DIFFERENT discount → aborts rather than overwriting it
//   I  no sqlite3 CLI              → aborts before writing
//
// D and F are the two that distinguish this from its fee-backfill twin. D exists
// because the reconciliation is off the ROW's columns, so it cannot pass while
// packing_fee/shipping_fee are still 0 — and "run the other script first" is a
// far more useful abort than a generic arithmetic gap. F exists because the
// ingest's /update-order-status heal now fills channel_discount too, so arriving
// to find the work already done is a legitimate outcome and not a failure.
//
// The script's three dependencies are replaced through a preload: `../database`
// and `../lib/db-seam` become a better-sqlite3-shaped shim over node:sqlite
// (local better-sqlite3 isn't built for this Node), and child_process.execFileSync
// answers the four sqlite3 CLI calls the backup makes. The shim is the test
// double; every line of logic under test is the shipped file's own.
//
// Run: node scripts/test_eleme_ingest_backfill.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO    = path.join(__dirname, '..');
const SCRIPT  = path.join(REPO, 'scripts', 'repair_eleme_ingest_backfill.js');
const WORK    = fs.mkdtempSync(path.join(os.tmpdir(), 'eleme-ingest-'));
const PRELOAD = path.join(WORK, 'preload.js');

// ── Schema, from database.js itself ───────────────────────────────────────────
const dbjs = fs.readFileSync(path.join(REPO, 'database.js'), 'utf8');
function ddl(table) {
  const head = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const at = dbjs.indexOf(head);
  if (at < 0) throw new Error(`no DDL for ${table} in database.js`);
  let depth = 0, i = at + head.length - 1;
  for (; i < dbjs.length; i++) {
    if (dbjs[i] === '(') depth++;
    else if (dbjs[i] === ')' && --depth === 0) break;
  }
  return dbjs.slice(at, i + 1);
}
const TABLES = ['retail_orders', 'retail_order_items', 'eleme_order_import'];

// The shape of the two real payloads, with the money in the fields the survey
// found it in. Not a capture — a capture would carry customer data — but the
// same paths and the same figures, which is what the script reads.
const payload = ({ pack, deliver, discount, comm, income, paid, items }) => ({
  orderId: 'x', foodInfo: { packageFee: pack, deliveryFee: deliver, groups: [{ items }] },
  settlementInfo: {
    merchantActivityInfo:    { total: discount },
    platformServiceFeeInfo:  { total: comm },
    expectedIncomeInfo:      { total: income },
    customerPaidInfo:        { total: paid },
    subTotalFeeInfo:         { total: paid },   // the trap: equals customerPaid
  },
});

// id 1538 EL20260901417897 — 267 goods over three lines. Item totals carry
// per-food packaging, so they sum to 268.5, not 267.
const P1538 = payload({
  pack: 1.5, deliver: 18, discount: 17.5, comm: 16.14, income: 252.86, paid: 269,
  items: [{ total: 38.5 }, { total: 29.5 }, { total: 200.5 }],
});
// id 1502 EL20260831339491 — 135 goods.
const P1502 = payload({
  pack: 1.5, deliver: 18, discount: 13.5, comm: 14.95, income: 126.05, paid: 141,
  items: [{ total: 50.5 }, { total: 47.5 }, { total: 38.5 }],
});

// A fresh scratch DB seeded to the state the box is in AFTER the fee backfill
// and BEFORE this one: fees written, channel_discount still NULL. `mutate` is
// where each case introduces its one difference.
function seed(mutate) {
  const file = path.join(WORK, `db-${Math.random().toString(36).slice(2)}.db`);
  // FKs off: retail_orders references tables this scratch DB has no reason to
  // carry (retail_customers, retail_stores). The script neither reads nor
  // depends on them.
  const raw = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  for (const t of TABLES) raw.exec(ddl(t));
  for (const m of dbjs.matchAll(/addColumn\('(\w+)',\s*'(\w+)',\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)) {
    if (!TABLES.includes(m[1])) continue;
    try { raw.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} ${m[3] ?? m[4]}`); } catch (_) {}
  }
  const state = {
    orders: [
      { id: 1538, order_no: 'EL20260901417897', subtotal: 267, total: 269,
        packing: 1.5, shipping: 18, discount: null, lines: [38, 29, 200], raw: P1538, divisor: 1 },
      { id: 1502, order_no: 'EL20260831339491', subtotal: 135, total: 141,
        packing: 1.5, shipping: 18, discount: null, lines: [50, 47, 38], raw: P1502, divisor: 1 },
    ],
    // A third Eleme order that must never be touched, and a tombstoned import
    // row with retail_order_id NULL, exactly as the phantom repair left them.
    other: { id: 1600, order_no: 'EL20260902111111', subtotal: 40, total: 40 },
  };
  if (mutate) mutate(state);

  for (const o of state.orders) {
    raw.prepare(`INSERT INTO retail_orders (id, order_no, status, channel, subtotal, total,
                   packing_fee, shipping_fee, channel_discount)
                 VALUES (?, ?, 'paid', 'eleme', ?, ?, ?, ?, ?)`)
       .run(o.id, o.order_no, o.subtotal, o.total, o.packing, o.shipping, o.discount);
    for (const lt of o.lines) {
      raw.prepare('INSERT INTO retail_order_items (order_id, name_cn, qty, unit_price, line_total) VALUES (?, ?, 1, ?, ?)')
         .run(o.id, 'x', lt, lt);
    }
    raw.prepare(`INSERT INTO eleme_order_import (eleme_order_id, retail_order_id, store_code, status, raw_payload, detail_json)
                 VALUES (?, ?, 'yuexiu', 'imported', ?, ?)`)
       .run('E' + o.id, o.id, JSON.stringify(o.raw), JSON.stringify({ moneyDivisor: o.divisor }));
  }
  const t = state.other;
  raw.prepare(`INSERT INTO retail_orders (id, order_no, status, channel, subtotal, total, packing_fee, shipping_fee)
               VALUES (?, ?, 'paid', 'eleme', ?, ?, 0, 0)`).run(t.id, t.order_no, t.subtotal, t.total);
  raw.prepare(`INSERT INTO eleme_order_import (eleme_order_id, retail_order_id, store_code, status)
               VALUES ('2000001755518659', NULL, 'yuexiu', 'imported')`).run();
  raw.close();
  return file;
}

// ── The preload: the script's three deps, replaced ────────────────────────────
fs.writeFileSync(PRELOAD, `
'use strict';
const Module = require('module');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const REPO = ${JSON.stringify(REPO)};
const raw = new DatabaseSync(process.env.TEST_DB, { enableForeignKeyConstraints: false });
const db = {
  name: process.env.TEST_DB,
  prepare(sql) {
    const st = raw.prepare(sql);
    return {
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  },
  exec: (s) => raw.exec(s),
  pragma: (s) => raw.exec('PRAGMA ' + s),
  transaction: (fn) => (...a) => {
    raw.exec('BEGIN');
    try { const r = fn(...a); raw.exec('COMMIT'); return r; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};
const stub = (id, exports) => {
  const full = require.resolve(id, { paths: [path.join(REPO, 'scripts')] });
  const m = new Module(full); m.exports = exports; m.loaded = true;
  require.cache[full] = m;
};
stub('../database', db);
stub('../lib/db-seam', { seam: (h) => h });

// The four sqlite3 CLI calls the backup makes. NO_SQLITE3 makes the probe throw,
// which is how case I reaches the "refusing to write without a backup" branch.
const cp = require('child_process');
const realExec = cp.execFileSync;
cp.execFileSync = function (file, args, opts) {
  if (file !== 'sqlite3') return realExec.apply(this, arguments);
  const a = args || [];
  if (a[0] === '--version') {
    if (process.env.NO_SQLITE3) { const e = new Error('sqlite3: not found'); throw e; }
    return '3.45.0';
  }
  if (String(a[1] || '').startsWith('.backup')) {
    const dest = String(a[1]).replace(/^\\.backup\\s+'?|'?$/g, '');
    require('fs').copyFileSync(a[0], dest);   // stands in for the online .backup
    return '';
  }
  if (String(a[1] || '').startsWith('PRAGMA integrity_check')) {
    const d = new DatabaseSync(a[0], { readOnly: true });
    const r = d.prepare('PRAGMA integrity_check').get(); d.close();
    return String(Object.values(r)[0]) + '\\n';
  }
  const d = new DatabaseSync(a[0], { readOnly: true });
  const r = d.prepare(String(a[1]).replace(/;\\s*$/, '')).get(); d.close();
  return String(Object.values(r)[0]) + '\\n';
};
`);

// ── Runner ────────────────────────────────────────────────────────────────────
function run(file, args, env) {
  try {
    const out = execFileSync(process.execPath, ['--require', PRELOAD, SCRIPT, ...args], {
      env: { ...process.env, TEST_DB: file, ELEME_FEE_BACKUP_DIR: path.join(WORK, 'backups'), ...env },
      stdio: 'pipe', encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
const read = (file, id) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const r = d.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id); d.close(); return r;
};

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// ── A. The happy path ─────────────────────────────────────────────────────────
console.log('\nA · --apply on the state the box is in');
{
  const f = seed();
  const r = run(f, ['--apply']);
  check('exits 0', r.code === 0, r.out.slice(-700));
  check('reports 2 rows written', /wrote 2 row\(s\)/.test(r.out), r.out.slice(-500));
  const a = read(f, 1538), b = read(f, 1502), c = read(f, 1600);
  check('1538 channel_discount = 17.5', near(a.channel_discount, 17.5), `got ${a.channel_discount}`);
  check('1502 channel_discount = 13.5', near(b.channel_discount, 13.5), `got ${b.channel_discount}`);
  check('subtotal untouched on both', near(a.subtotal, 267) && near(b.subtotal, 135), `${a.subtotal} / ${b.subtotal}`);
  check('total untouched on both', near(a.total, 269) && near(b.total, 141), `${a.total} / ${b.total}`);
  check('fees untouched on both', near(a.packing_fee, 1.5) && near(b.shipping_fee, 18), `${a.packing_fee} / ${b.shipping_fee}`);
  check('the third eleme order is untouched', c.channel_discount === null, `got ${c.channel_discount}`);
  check('a backup was taken and integrity-checked', /PRAGMA integrity_check: ok/.test(r.out), r.out.slice(-500));
  check('the row now reconciles', /267 \+ 1.5 \+ 18 - 17.5 = 269/.test(r.out), r.out.slice(-900));
}

// ── B. Dry run ────────────────────────────────────────────────────────────────
console.log('\nB · no --apply');
{
  const f = seed();
  const r = run(f, []);
  check('exits 0', r.code === 0, r.out.slice(-500));
  check('says it wrote nothing', /DRY RUN — nothing was written/.test(r.out), r.out.slice(-300));
  check('1538 still NULL', read(f, 1538).channel_discount === null, 'it was written');
  check('1502 still NULL', read(f, 1502).channel_discount === null, 'it was written');
}

// ── C. The payload says something else ────────────────────────────────────────
console.log('\nC · a payload whose merchant discount has changed');
{
  const f = seed((s) => { s.orders[0].raw = payload({
    pack: 1.5, deliver: 18, discount: 20, comm: 16.14, income: 252.86, paid: 269,
    items: [{ total: 38.5 }] }); });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('names the field that disagreed',
    /merchantActivityInfo\.total reads 20, expected 17\.5/.test(r.out), r.out.slice(-700));
  check('wrote nothing to 1502 either', read(f, 1502).channel_discount === null, 'the other row was written');
}

// ── D. The fee backfill has not been run ──────────────────────────────────────
// The prerequisite case. The reconciliation is off the row's own columns, so a
// row still holding 0/0 cannot pass it — and the useful abort names the script
// to run first rather than reporting an arithmetic gap the reader has to trace.
console.log('\nD · packing_fee / shipping_fee still 0');
{
  const f = seed((s) => { for (const o of s.orders) { o.packing = 0; o.shipping = 0; } });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('names repair_eleme_order_fees.js as the thing to run first',
    /repair_eleme_order_fees\.js --apply` FIRST/.test(r.out), r.out.slice(-900));
  check('wrote nothing', read(f, 1538).channel_discount === null, 'a row was written');
}

// ── E. An id that now means a different order ─────────────────────────────────
console.log('\nE · id 1502 pointing at another order_no');
{
  const f = seed((s) => { s.orders[1].order_no = 'EL20260831000000'; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('names the order_no it expected',
    /order_no is 'EL20260831000000', expected 'EL20260831339491'/.test(r.out), r.out.slice(-700));
  check('wrote nothing', read(f, 1538).channel_discount === null, 'a row was written');
}

// ── F. Already done ───────────────────────────────────────────────────────────
// The ingest's /update-order-status heal fills this column too, so it can
// genuinely get here first. That is the state this script exists to produce —
// reaching it by another route is success, not a failure to write.
console.log('\nF · both rows already carry the right discount');
{
  const f = seed((s) => { s.orders[0].discount = 17.5; s.orders[1].discount = 13.5; });
  const r = run(f, ['--apply']);
  check('exits 0', r.code === 0, r.out.slice(-700));
  check('says there is nothing to do', /already carry the discount this would write/.test(r.out), r.out.slice(-400));
  check('took no backup', !/PRAGMA integrity_check/.test(r.out), 'it backed up for a no-op');
  check('left both figures alone',
    near(read(f, 1538).channel_discount, 17.5) && near(read(f, 1502).channel_discount, 13.5), 'a figure moved');
}

// ── G. Half done ──────────────────────────────────────────────────────────────
// "Exactly 2 rows changed" can never be satisfied from here, so it stops before
// the backup rather than writing one row and rolling back on the count.
console.log('\nG · only 1538 already carries its discount');
{
  const f = seed((s) => { s.orders[0].discount = 17.5; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('says which row is already done', /id 1538 already carries its discount/.test(r.out), r.out.slice(-600));
  check('leaves 1502 alone', read(f, 1502).channel_discount === null, 'it was written');
  check('leaves 1538 alone', near(read(f, 1538).channel_discount, 17.5), 'it was overwritten');
}

// ── H. A discount that disagrees ──────────────────────────────────────────────
// The one case that could silently overwrite a figure taken beside a different
// money scale. It must stop, not overwrite and not skip.
console.log('\nH · 1502 holds a different discount');
{
  const f = seed((s) => { s.orders[1].discount = 99; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('says the row already holds another figure',
    /channel_discount already holds 99/.test(r.out), r.out.slice(-800));
  check('the existing figure is untouched', read(f, 1502).channel_discount === 99, 'it was overwritten');
}

// ── I. No sqlite3 CLI ─────────────────────────────────────────────────────────
console.log('\nI · sqlite3 missing');
{
  const f = seed();
  const r = run(f, ['--apply'], { NO_SQLITE3: '1' });
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('refuses to write without a backup', /refusing to write without a backup/.test(r.out), r.out.slice(-400));
  check('wrote nothing', read(f, 1538).channel_discount === null, 'a row was written');
}

// ── Done ──────────────────────────────────────────────────────────────────────
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
