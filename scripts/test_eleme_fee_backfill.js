// The Eleme fee backfill writes two rows, the right two, and rolls back on
// anything it did not expect (npm run test:eleme-fee-backfill).
//
// scripts/repair_eleme_order_fees.js writes money columns on production rows, so
// what needs proving is not that it can write — it is that it REFUSES to. Each
// case below runs the REAL script, as a child process, against a scratch DB
// built from database.js's own DDL, with one fact changed:
//
//   A  the happy path            → both rows written, nothing else touched
//   B  dry run                   → prints the plan, writes nothing
//   C  a payload that disagrees  → aborts, writes nothing
//   D  a row that does not reconcile → aborts, writes nothing
//   E  an id pointing at another order_no → aborts, writes nothing
//   F  commission already present → aborts rather than overwriting it
//   G  no sqlite3 CLI            → aborts before writing
//
// The script's three dependencies are replaced through a preload: `../database`
// and `../lib/db-seam` become a better-sqlite3-shaped shim over node:sqlite
// (local better-sqlite3 isn't built for this Node), and child_process.execFileSync
// answers the four sqlite3 CLI calls the backup makes. The shim is the test
// double; every line of logic under test is the shipped file's own.
//
// Run: node scripts/test_eleme_fee_backfill.js

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO    = path.join(__dirname, '..');
const SCRIPT  = path.join(REPO, 'scripts', 'repair_eleme_order_fees.js');
const WORK    = fs.mkdtempSync(path.join(os.tmpdir(), 'eleme-fee-'));
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

// id 1538 EL20260901417897 — 267 goods over three lines, commission already on
// the row. Item totals carry per-food packaging, so they sum to 268.5, not 267.
const P1538 = payload({
  pack: 1.5, deliver: 18, discount: 17.5, comm: 16.14, income: 252.86, paid: 269,
  items: [{ total: 38.5 }, { total: 29.5 }, { total: 200.5 }],
});
// id 1502 EL20260831339491 — 135 goods, commission and income NULL on the row.
const P1502 = payload({
  pack: 1.5, deliver: 18, discount: 13.5, comm: 14.95, income: 126.05, paid: 141,
  items: [{ total: 50.5 }, { total: 47.5 }, { total: 38.5 }],
});

// A fresh scratch DB seeded to the state the box is in before the backfill.
// `mutate` is where each case introduces its one difference.
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
      { id: 1538, order_no: 'EL20260901417897', subtotal: 267, total: 269, commission: 16.14, settle: 252.86,
        lines: [38, 29, 200], raw: P1538, divisor: 1 },
      { id: 1502, order_no: 'EL20260831339491', subtotal: 135, total: 141, commission: null, settle: null,
        lines: [50, 47, 38], raw: P1502, divisor: 1 },
    ],
    // A third Eleme order that must never be touched, and a tombstoned import
    // row with retail_order_id NULL, exactly as the phantom repair left them.
    other: { id: 1600, order_no: 'EL20260902111111', subtotal: 40, total: 40 },
  };
  if (mutate) mutate(state);

  for (const o of state.orders) {
    raw.prepare(`INSERT INTO retail_orders (id, order_no, status, channel, subtotal, total,
                   packing_fee, shipping_fee, channel_commission, channel_settle_amount)
                 VALUES (?, ?, 'paid', 'eleme', ?, ?, 0, 0, ?, ?)`)
       .run(o.id, o.order_no, o.subtotal, o.total, o.commission, o.settle);
    for (const lt of o.lines) {
      raw.prepare('INSERT INTO retail_order_items (order_id, name_cn, qty, unit_price, line_total) VALUES (?, ?, 1, ?, ?)')
         .run(o.id, 'x', lt, lt);
    }
    raw.prepare(`INSERT INTO eleme_order_import (eleme_order_id, retail_order_id, store_code, status, raw_payload, detail_json)
                 VALUES (?, ?, 'yuexiu', 'imported', ?, ?)`)
       .run('E' + o.id, o.id, JSON.stringify(o.raw), JSON.stringify({ moneyDivisor: o.divisor, packagingFee: null, deliveryFee: null }));
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
// which is how case G reaches the "refusing to write without a backup" branch.
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
  check('1538 packing_fee = 1.5', near(a.packing_fee, 1.5), `got ${a.packing_fee}`);
  check('1538 shipping_fee = 18', near(a.shipping_fee, 18), `got ${a.shipping_fee}`);
  check('1538 commission untouched (16.14)', near(a.channel_commission, 16.14), `got ${a.channel_commission}`);
  check('1502 packing_fee = 1.5', near(b.packing_fee, 1.5), `got ${b.packing_fee}`);
  check('1502 shipping_fee = 18', near(b.shipping_fee, 18), `got ${b.shipping_fee}`);
  check('1502 commission filled (14.95)', near(b.channel_commission, 14.95), `got ${b.channel_commission}`);
  check('1502 settle filled (126.05)', near(b.channel_settle_amount, 126.05), `got ${b.channel_settle_amount}`);
  check('subtotal untouched on both', near(a.subtotal, 267) && near(b.subtotal, 135), `${a.subtotal} / ${b.subtotal}`);
  check('total untouched on both', near(a.total, 269) && near(b.total, 141), `${a.total} / ${b.total}`);
  check('the third eleme order is untouched', c.packing_fee === 0 && c.shipping_fee === 0, `got ${c.packing_fee}/${c.shipping_fee}`);
  check('a backup was taken and integrity-checked', /PRAGMA integrity_check: ok/.test(r.out), r.out.slice(-500));
  check('goods come from line_total (267), not item totals (268.5)',
    /267 \+ 1.5 \+ 18 - 17.5 = 269/.test(r.out), r.out.slice(-800));
}

// ── B. Dry run ────────────────────────────────────────────────────────────────
console.log('\nB · no --apply');
{
  const f = seed();
  const r = run(f, []);
  check('exits 0', r.code === 0, r.out.slice(-500));
  check('says it wrote nothing', /DRY RUN — nothing was written/.test(r.out), r.out.slice(-300));
  const a = read(f, 1538), b = read(f, 1502);
  check('1538 still 0/0', a.packing_fee === 0 && a.shipping_fee === 0, `got ${a.packing_fee}/${a.shipping_fee}`);
  check('1502 still 0/0 and NULL economics',
    b.packing_fee === 0 && b.channel_commission === null, `got ${b.packing_fee}/${b.channel_commission}`);
}

// ── C. The payload says something else ────────────────────────────────────────
console.log('\nC · a payload whose delivery fee has changed');
{
  const f = seed((s) => { s.orders[0].raw = payload({
    pack: 1.5, deliver: 20, discount: 17.5, comm: 16.14, income: 252.86, paid: 269,
    items: [{ total: 38.5 }] }); });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('names the field that disagreed', /foodInfo\.deliveryFee reads 20, expected 18/.test(r.out), r.out.slice(-600));
  check('wrote nothing to 1502 either', read(f, 1502).packing_fee === 0, 'the other row was written');
}

// ── D. A row that does not reconcile ──────────────────────────────────────────
console.log('\nD · a total that the fees cannot explain');
{
  const f = seed((s) => { s.orders[1].total = 150; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('reports the row total mismatch', /row total is 150, expected 141/.test(r.out), r.out.slice(-600));
  check('wrote nothing', read(f, 1538).packing_fee === 0, 'a row was written');
}

// ── E. An id that now means a different order ─────────────────────────────────
console.log('\nE · id 1502 pointing at another order_no');
{
  const f = seed((s) => { s.orders[1].order_no = 'EL20260831000000'; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('names the order_no it expected', /order_no is 'EL20260831000000', expected 'EL20260831339491'/.test(r.out), r.out.slice(-600));
  check('wrote nothing', read(f, 1538).packing_fee === 0, 'a row was written');
}

// ── F. An economics column that is already filled ─────────────────────────────
// The one case that could silently overwrite a figure taken beside a different
// money scale. It must stop, not skip the column and carry on.
console.log('\nF · 1502 already holds a commission');
{
  const f = seed((s) => { s.orders[1].commission = 99; s.orders[1].settle = 42; });
  const r = run(f, ['--apply']);
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('says the row already holds one', /commission: row holds 99/.test(r.out), r.out.slice(-700));
  check('the existing commission is untouched', read(f, 1502).channel_commission === 99, 'it was overwritten');
}

// ── G. No sqlite3 CLI ─────────────────────────────────────────────────────────
console.log('\nG · sqlite3 missing');
{
  const f = seed();
  const r = run(f, ['--apply'], { NO_SQLITE3: '1' });
  check('aborts', r.code !== 0, `exit ${r.code}`);
  check('refuses to write without a backup', /refusing to write without a backup/.test(r.out), r.out.slice(-400));
  check('wrote nothing', read(f, 1538).packing_fee === 0, 'a row was written');
}

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'All checks passed.'}`);
process.exit(failures ? 1 : 0);
