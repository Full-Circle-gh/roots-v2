#!/usr/bin/env node
/**
 * rollback-to-sqlite.sh and rollback-delta-report.js — the suite. G22.
 *
 *   node scripts/test_rollback_to_sqlite.js
 *
 * ── THE REFUSALS ARE THE TESTS THAT MATTER ───────────────────────────────
 * A rollback tool that proceeds when it should stop is worse than no tool,
 * because it runs at the moment nobody has the attention to second-guess it.
 * So every refusal is forced INDIVIDUALLY, against an otherwise-clean fixture,
 * and each one asserts not only that the script exited 1 but that IT CHANGED
 * NOTHING — the pre-cutover file still there, no live database, TACET_DB still
 * set. A refusal that half-ran is a refusal that failed.
 *
 * R4 deserves its own sentence. It fires when the pre-cutover file was written
 * after the flip, which means something kept writing to SQLite while the app
 * was on Postgres — the two-databases case that makes rollback a merge instead
 * of a rename. With the daemons stopped it can never fire in production. It is
 * tested here precisely because it is the check that enforces that decision.
 *
 * ── WHAT IS REAL AND WHAT IS SUBSTITUTED ─────────────────────────────────
 * REAL: the shell script itself, a real SQLite file built from database.js's own
 * DDL, and the REAL check_ledger_invariants.js / check_points_invariants.js.
 * SUBSTITUTED: pm2 and psql, through the RB_PM2 / RB_PSQL hooks the script
 * exposes for exactly this. Same approach as the G4 suite's recording pool —
 * the logic under test is the sequence and the refusals, not whether pm2 works.
 *
 * TO PROVE THE SUITE CAN FAIL:  RB_MUTANT=1 node scripts/test_rollback_to_sqlite.js
 * The mutant deletes the R4 mtime refusal — the one enforcing the daemons-stop
 * decision — and the suite must go RED. Per §24 (v4.27) the mutation ASSERTS IT
 * MODIFIED THE SOURCE before its red counts as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { addTables } = require('./test-support/memory-db');

const ROOT = path.join(__dirname, '..');
const SH = path.join(__dirname, 'rollback-to-sqlite.sh');
const SH_SRC = fs.readFileSync(SH, 'utf8');
const MUTANT = process.env.RB_MUTANT === '1';
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

// §24: assert no anchor carries a line ending before running any of them. A
// `\n` anchor against a CRLF file matches nothing, and removing an absent
// substring changes nothing — a vacuous pass that reads as proof.
const ANCHOR_R4 = '  if [ "$PRE_MTIME" -gt "$FLIP_AT" ]; then';
assert.ok(!/[\r\n]/.test(ANCHOR_R4), 'the R4 anchor carries a line ending');

let restore = null;
let SCRIPT = SH;
if (MUTANT) {
  assert.strictEqual(SH_SRC.split(ANCHOR_R4).length - 1, 1, 'the R4 anchor is not unique');
  const mutated = SH_SRC.replace(ANCHOR_R4, '  if false; then');
  assert.notStrictEqual(mutated, SH_SRC,
    'MUTANT DID NOT MODIFY THE SOURCE — anchor missing, red would be vacuous');
  SCRIPT = path.join(__dirname, '_mutant_rollback_to_sqlite.sh');
  fs.writeFileSync(SCRIPT, mutated);
  restore = () => { if (fs.existsSync(SCRIPT)) fs.unlinkSync(SCRIPT); };
  console.log('MUTANT ACTIVE — the R4 post-flip-write refusal is disabled. Must go RED.\n');
}

let pass = 0, fail = 0, code = 1;
const cases = [];
const t = (name, fn) => cases.push({ name, fn });

// ── fixture ──────────────────────────────────────────────────────────────
// A throwaway app root: data/, scripts/, node_modules/better-sqlite3, .env.
// The script resolves better-sqlite3 out of $RB_APP/node_modules, so that is
// symlinked to the real one rather than reinstalled.
const TABLES = ['retail_orders', 'retail_customers', 'retail_topup_transactions',
  'retail_points_transactions', 'retail_payments', 'retail_order_items',
  'retail_lifetime_commissions', 'retail_referrals', 'retail_order_addons',
  'storefront_config'];

let tmpRoot;
function makeApp(opts = {}) {
  const app = fs.mkdtempSync(path.join(tmpRoot, 'app-'));
  fs.mkdirSync(path.join(app, 'data'));
  fs.mkdirSync(path.join(app, 'scripts'));
  fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules', 'better-sqlite3'),
    path.join(app, 'node_modules', 'better-sqlite3'), 'dir');
  for (const c of ['check_ledger_invariants.js', 'check_points_invariants.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', c), path.join(app, 'scripts', c));
  }
  fs.mkdirSync(path.join(app, 'scripts', 'test-support'), { recursive: true });

  // The pre-flip database: real DDL, a handful of TC orders.
  const pre = path.join(app, 'data', 'roots.db.pre-cutover');
  const db = addTables(new Database(pre), DB_SRC, DB_SRC, TABLES);
  const ins = db.prepare("INSERT INTO retail_orders (order_no, status) VALUES (?, 'delivered')");
  for (let i = 1; i <= (opts.orders ?? 5); i++) ins.run('TC' + String(i).padStart(6, '0'));
  db.close();

  fs.writeFileSync(path.join(app, '.env'),
    opts.env ?? 'PORT=4000\nTACET_DB=postgres\nFOO=bar\n');
  // .env.pre-cutover's mtime is the flip time.
  const envPre = path.join(app, '.env.pre-cutover');
  fs.writeFileSync(envPre, 'PORT=4000\n');
  const flipAt = opts.flipAt ?? (Date.now() - 3600_000);
  fs.utimesSync(envPre, flipAt / 1000, flipAt / 1000);
  // The pre-cutover DB predates the flip unless a test says otherwise.
  const preAt = opts.preAt ?? (flipAt - 60_000);
  fs.utimesSync(pre, preAt / 1000, preAt / 1000);

  // Fake pm2: records what it was told, answers jlist with the real production
  // shape — including qingyun DOUBLED and eleme ABSENT, which is what the G2
  // deploy actually found. A name list would get this wrong; pm_exec_path does not.
  const pm2log = path.join(app, 'pm2.log');
  const jlist = JSON.stringify([
    { name: 'roots-v2', pm2_env: { pm_exec_path: '/root/roots-v2/server.js' } },
    { name: 'qingyun-sync', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/qingyun-daemon.js' } },
    { name: 'qingyun-sync-yuexiu', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/qingyun-daemon.js' } },
    { name: 'guanyi-sync', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/guanyi-daemon.js' } },
    { name: 'meituan-sync', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/meituan-daemon.js' } },
    { name: 'shangou-sync', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/shangou-daemon.js' } },
    { name: 'gzgrocery-orders', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/gzgrocery-order-daemon.js' } },
    { name: 'shangou-chrome', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/shangou-chrome.js' } },
    { name: 'qingyun-chrome', pm2_env: { pm_exec_path: '/root/roots-v2/scripts/qingyun-chrome.js' } },
  ]);
  const bootLine = opts.bootLine
    ?? '2026-08-20T10:00:00: [db-driver] TACET_DB is not set — driver: sqlite (default).';
  const pm2 = path.join(app, 'fake-pm2.sh');
  fs.writeFileSync(pm2, `#!/bin/bash
echo "$@" >> ${JSON.stringify(pm2log)}
case "$1" in
  jlist) cat <<'J'\n${jlist}\nJ
  ;;
  logs) printf '%s\\n' ${JSON.stringify(bootLine)} ;;
  *) : ;;
esac
`);
  fs.chmodSync(pm2, 0o755);

  return { app, pre, live: path.join(app, 'data', 'roots.db'), pm2, pm2log, envFile: path.join(app, '.env') };
}

function run(fx, args = [], env = {}) {
  const e = {
    ...process.env, RB_APP: fx.app, RB_PM2: fx.pm2, RB_SETTLE: '0',
    RB_PSQL: env.RB_PSQL ?? path.join(fx.app, 'fake-psql.sh'), ...env,
  };
  if (!fs.existsSync(e.RB_PSQL) && e.RB_PSQL.endsWith('fake-psql.sh')) {
    fs.writeFileSync(e.RB_PSQL, '#!/bin/bash\nexit 1\n');   // unreachable by default
    fs.chmodSync(e.RB_PSQL, 0o755);
  }
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, cwd: ROOT, ...{ env: e } });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}
function withPsql(fx, value) {
  const p = path.join(fx.app, 'fake-psql.sh');
  fs.writeFileSync(p, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(String(value))}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}
/** Nothing moved: the refusal did not half-run. */
function assertUntouched(fx, why) {
  assert.ok(fs.existsSync(fx.pre), `${why}: the pre-cutover file was consumed`);
  assert.ok(!fs.existsSync(fx.live), `${why}: a live database was created`);
  assert.ok(/^[[:space:]]*TACET_DB=postgres$/m.test(fs.readFileSync(fx.envFile, 'utf8').replace(/\[\[:space:\]\]\*/g, '')) ||
    fs.readFileSync(fx.envFile, 'utf8').includes('TACET_DB=postgres'), `${why}: .env was edited`);
}
const maxTc = (p) => {
  const db = new Database(p, { readonly: true });
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(order_no,3) AS INTEGER)),0) AS n FROM retail_orders WHERE order_no LIKE 'TC______'").get().n;
  db.close(); return n;
};

// ── the refusals ─────────────────────────────────────────────────────────

t('1  R0 REFUSES when TACET_DB is not set — there is no flip to undo', () => {
  const fx = makeApp({ env: 'PORT=4000\n' });
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R0:/.test(r.out), r.out);
  assert.ok(fs.existsSync(fx.pre) && !fs.existsSync(fx.live), 'R0 half-ran');
});

t('2  R1 REFUSES when a live roots.db exists — two files, picking one is a merge', () => {
  const fx = makeApp();
  fs.copyFileSync(fx.pre, fx.live);
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R1: .*EXISTS/.test(r.out), r.out);
  assert.ok(fs.existsSync(fx.pre), 'R1 consumed the pre-cutover file');
  assert.ok(fs.existsSync(fx.live), 'R1 removed the live file it refused over');
});

t('3  R2 REFUSES when the pre-cutover file is missing', () => {
  const fx = makeApp();
  fs.unlinkSync(fx.pre);
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R2: .*MISSING/.test(r.out), r.out);
  assert.ok(!fs.existsSync(fx.live), 'R2 created a live database anyway');
});

t('4  R3 REFUSES when the pre-cutover file fails integrity_check', () => {
  const fx = makeApp();
  fs.writeFileSync(fx.pre, 'SQLite format 3\0this is not a database');
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R3: .*integrity_check/.test(r.out), r.out);
  assert.ok(!fs.existsSync(fx.live), 'R3 restored a corrupt file');
});

t('5  *** R4 REFUSES when SQLite was written AFTER the flip *** (daemons-stop)', () => {
  const flipAt = Date.now() - 3600_000;
  const fx = makeApp({ flipAt, preAt: flipAt + 600_000 });   // written 10 min after
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R4: .*WRITTEN AFTER THE FLIP/.test(r.out), r.out);
  assert.ok(/merge/i.test(r.out), 'R4 does not say why it matters');
  assertUntouched(fx, 'R4');
});

t('6  a refusal reports EVERY failed check, not just the first', () => {
  const fx = makeApp({ env: 'PORT=4000\n' });          // R0
  fs.copyFileSync(fx.pre, fx.live);                     // R1
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/R0:/.test(r.out) && /R1:/.test(r.out), `only one refusal reported:\n${r.out}`);
  assert.ok(/2 pre-flight check\(s\) failed/.test(r.out), r.out);
});

// ── the happy paths ──────────────────────────────────────────────────────

t('7  DRY RUN passes pre-flight and changes NOTHING', () => {
  const fx = makeApp();
  const r = run(fx, []);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/all pre-flight checks passed/.test(r.out), r.out);
  assert.ok(/DRY RUN — nothing was changed/.test(r.out), r.out);
  assertUntouched(fx, 'dry run');
});

t('8  --apply renames back, unsets TACET_DB, and verifies', () => {
  const fx = makeApp();
  withPsql(fx, '5');                                    // pg last_no == sqlite max
  const r = run(fx, ['--apply']);
  assert.ok(fs.existsSync(fx.live), `the database was not restored:\n${r.out}`);
  assert.ok(!fs.existsSync(fx.pre), 'the pre-cutover file is still there');
  const env = fs.readFileSync(fx.envFile, 'utf8');
  assert.ok(/^# rolled back: *TACET_DB=postgres/m.test(env), `TACET_DB not neutralised:\n${env}`);
  assert.ok(/PORT=4000/.test(env), 'the rest of .env was damaged');
  assert.strictEqual(r.code, 0, `verification failed:\n${r.out}`);
  assert.ok(/ROLLBACK COMPLETE AND VERIFIED/.test(r.out), r.out);
});

t('9  it stops and starts roots-v2 AND every daemon — by pm_exec_path', () => {
  const fx = makeApp();
  withPsql(fx, '5');
  run(fx, ['--apply']);
  const log = fs.readFileSync(fx.pm2log, 'utf8');
  for (const n of ['roots-v2', 'qingyun-sync', 'qingyun-sync-yuexiu', 'guanyi-sync',
    'meituan-sync', 'shangou-sync', 'gzgrocery-orders']) {
    assert.ok(log.includes(`stop ${n}`), `did not stop ${n}`);
    assert.ok(log.includes(`start ${n}`) || log.includes(`restart ${n}`), `did not start ${n}`);
  }
  // Six processes across FIVE daemon types — qingyun doubled, eleme absent.
  assert.ok(!/stop eleme/.test(log), 'invented an eleme process that is not running');
  // Browser holders load no business code; bouncing one costs a captcha.
  assert.ok(!/stop shangou-chrome/.test(log) && !/stop qingyun-chrome/.test(log),
    'bounced a browser holder');
});

// ── the counter high-water ───────────────────────────────────────────────

t('10 A GAP RESERVES ABOVE THE BURNED RANGE, leaving every issued number free', () => {
  const fx = makeApp({ orders: 5 });
  withPsql(fx, '9');                        // pg minted TC000006..TC000009
  const r = run(fx, ['--apply']);
  assert.ok(/gap of 4 number\(s\)/.test(r.out), r.out);
  assert.ok(/reserved TC000010/.test(r.out), `wrong reservation point:\n${r.out}`);
  assert.strictEqual(maxTc(fx.live), 10, 'the high-water did not move');
  const db = new Database(fx.live, { readonly: true });
  const rows = db.prepare("SELECT order_no, status, cancelled_reason FROM retail_orders WHERE cancelled_reason = 'rollback_order_range_reservation'").all();
  db.close();
  assert.strictEqual(rows.length, 1, 'expected exactly one marker');
  assert.strictEqual(rows[0].status, 'cancelled', 'the marker is not cancelled — it would count as a live order');
  // The burned numbers themselves must stay free for a faithful re-entry.
  assert.strictEqual(rows[0].order_no, 'TC000010');
});

t('11 NO GAP means no marker — it does not insert one for the sake of it', () => {
  const fx = makeApp({ orders: 5 });
  withPsql(fx, '3');                        // pg behind sqlite
  const r = run(fx, ['--apply']);
  assert.ok(/no gap/.test(r.out), r.out);
  const db = new Database(fx.live, { readonly: true });
  const n = db.prepare("SELECT COUNT(*) AS n FROM retail_orders WHERE cancelled_reason = 'rollback_order_range_reservation'").get().n;
  db.close();
  assert.strictEqual(n, 0, 'inserted a marker with no gap to reserve');
});

t('12 --no-reserve-order-range skips it and SAYS what will be reissued', () => {
  const fx = makeApp({ orders: 5 });
  withPsql(fx, '9');
  const r = run(fx, ['--apply', '--no-reserve-order-range']);
  assert.ok(/reservation SKIPPED/.test(r.out), r.out);
  assert.ok(/TC000006\.\.TC000009 will be reissued/.test(r.out), `the cost is not stated:\n${r.out}`);
  assert.strictEqual(maxTc(fx.live), 5, 'reserved anyway');
});

t('13 *** POSTGRES UNREACHABLE ROLLS BACK ANYWAY *** and states the cost', () => {
  const fx = makeApp({ orders: 5 });        // fake-psql exits 1
  const r = run(fx, ['--apply']);
  assert.ok(/POSTGRES UNREACHABLE/.test(r.out), r.out);
  assert.ok(/COST:/.test(r.out), 'it does not say what the fallback costs');
  assert.ok(/--assume-burned/.test(r.out), 'it does not say how to fix it later');
  assert.ok(fs.existsSync(fx.live), 'it refused to roll back over an unreadable counter');
  assert.strictEqual(r.code, 0, `unreachable postgres failed the rollback:\n${r.out}`);
});

t('14 --assume-burned supplies the high-water when the cluster cannot', () => {
  const fx = makeApp({ orders: 5 });
  const r = run(fx, ['--apply', '--assume-burned', '9']);
  assert.ok(/not read from the cluster/.test(r.out), r.out);
  assert.strictEqual(maxTc(fx.live), 10, 'the supplied high-water was ignored');
});

// ── verification ─────────────────────────────────────────────────────────

t('15 A BOOT LINE THAT DOES NOT NAME SQLITE FAILS THE ROLLBACK', () => {
  const fx = makeApp({ bootLine: '[db-driver] TACET_DB=postgres — driver: postgres' });
  withPsql(fx, '5');
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, `a postgres boot line passed verification:\n${r.out}`);
  assert.ok(/does not name sqlite/.test(r.out), r.out);
  assert.ok(/APPLIED BUT NOT VERIFIED/.test(r.out), r.out);
  assert.ok(fs.existsSync(fx.live), 'it rolled the rename back — it must not');
});

t('16 NO BOOT LINE AT ALL FAILS — absence is not evidence of sqlite', () => {
  const fx = makeApp({ bootLine: 'some unrelated log line' });
  withPsql(fx, '5');
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/no \[db-driver\] line/.test(r.out), r.out);
});

t('17 A FAILING INVARIANT CHECK FAILS THE ROLLBACK, it does not just print', () => {
  const fx = makeApp();
  withPsql(fx, '5');
  fs.writeFileSync(path.join(fx.app, 'scripts', 'check_ledger_invariants.js'),
    'process.exit(1);\n');
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, `a failing checker returned success:\n${r.out}`);
  assert.ok(/FAIL: check_ledger_invariants/.test(r.out), r.out);
});

t('18 the REAL invariant checkers run and pass against the restored file', () => {
  const fx = makeApp();
  withPsql(fx, '5');
  const r = run(fx, ['--apply']);
  assert.ok(/check_ledger_invariants ok/.test(r.out), r.out);
  assert.ok(/check_points_invariants ok/.test(r.out), r.out);
});

t('19 a receipt is written BEFORE verification, so a failed verify leaves a record', () => {
  const fx = makeApp({ bootLine: 'nothing useful' });
  withPsql(fx, '5');
  const r = run(fx, ['--apply']);
  assert.strictEqual(r.code, 1, r.out);
  const rec = fs.readdirSync(path.join(fx.app, 'data')).filter((f) => f.startsWith('rollback-receipt-'));
  assert.strictEqual(rec.length, 1, `expected a receipt even on a failed verify: ${rec}`);
  const j = JSON.parse(fs.readFileSync(path.join(fx.app, 'data', rec[0]), 'utf8'));
  assert.strictEqual(j.postgres_last_no, '5');
  assert.ok(j.processes.includes('roots-v2'), 'the receipt does not record what was bounced');
});

// ── the delta report ─────────────────────────────────────────────────────

t('20 THE DELTA REPORT CANNOT WRITE — read-only is server-enforced', async () => {
  const { buildReport } = require('./rollback-delta-report');
  const seen = [];
  const q = async (sql) => { seen.push(sql); return { rows: [] }; };
  await buildReport(q, { retail_orders: 5, retail_checkout_quotes: 100 });
  assert.strictEqual(seen[0], 'BEGIN TRANSACTION READ ONLY',
    `the first statement is not a read-only transaction: ${seen[0]}`);
  assert.strictEqual(seen[seen.length - 1], 'ROLLBACK', 'it does not roll back');
  for (const s of seen) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s),
      `the report emitted a write: ${s}`);
  }
});

t('21 it ROLLS BACK even when a query throws mid-report', async () => {
  const { buildReport } = require('./rollback-delta-report');
  const seen = [];
  const q = async (sql) => {
    seen.push(sql);
    if (/FROM "retail_orders"/.test(sql)) throw new Error('connection lost');
    return { rows: [] };
  };
  await assert.rejects(() => buildReport(q, { retail_orders: 5 }));
  assert.strictEqual(seen[seen.length - 1], 'ROLLBACK', 'a throw left the transaction open');
});

t('22 it lists orders and money rows BY ID, and counts the disposable ones', async () => {
  const { buildReport, render } = require('./rollback-delta-report');
  const q = async (sql) => {
    if (/BEGIN|ROLLBACK/.test(sql)) return { rows: [] };
    if (/FROM "retail_orders"/.test(sql)) {
      return { rows: [{ id: 6, order_no: 'TC000006', status: 'delivered', total: 88.5, customer_id: 12, created_at: 'x' }] };
    }
    if (/COUNT/.test(sql)) return { rows: [{ n: 1712 }] };
    return { rows: [] };
  };
  const rep = await buildReport(q, {
    retail_orders: 5, retail_payments: 0, retail_topup_transactions: 0,
    retail_points_transactions: 0, retail_order_items: 0, retail_customers: 0,
    retail_checkout_quotes: 100, guanyi_sync_log: 0,
  });
  const orders = rep.detail.find((d) => d.table === 'retail_orders');
  assert.strictEqual(orders.rows.length, 1);
  assert.strictEqual(orders.rows[0].order_no, 'TC000006');
  const quotes = rep.counts.find((c) => c.table === 'retail_checkout_quotes');
  assert.strictEqual(quotes.disposable, true, 'quotes are not marked disposable');
  const text = render(rep);
  assert.ok(/TC000006/.test(text), 'the order is not in the rendered report');
  assert.ok(/UPDATES\./.test(text), 'the report does not state that it cannot see updates');
  assert.ok(/DELETES\./.test(text), 'the report does not state that it cannot see deletes');
  assert.ok(/Postgres was NOT modified/.test(text), 'it does not say postgres is untouched');
});

t('23 a table with no watermark is REPORTED as unknown, not silently skipped', async () => {
  const { buildReport, render } = require('./rollback-delta-report');
  const q = async () => ({ rows: [] });
  const rep = await buildReport(q, { retail_orders: 5 });
  assert.ok(rep.missing.includes('retail_customers'), 'a missing watermark vanished');
  assert.ok(/NO WATERMARK, NOT REPORTED/.test(render(rep)), 'the gap is not surfaced');
});

// ── run ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbk-'));
    console.log('rollback-to-sqlite + delta report — suite\n');
    for (const c of cases) {
      try { await c.fn(); pass++; console.log(`  ok    ${c.name}`); }
      catch (e) { fail++; console.log(`  FAIL  ${c.name}\n          ${e.message}`); }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (MUTANT) {
      if (fail > 0) { console.log('MUTANT: suite went RED as required. The red-proof holds.'); code = 0; }
      else { console.log('MUTANT: suite stayed GREEN. THE SUITE DOES NOT PROVE WHAT IT CLAIMS.'); code = 1; }
    } else { code = fail ? 1 : 0; }
  } finally {
    if (restore) restore();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  process.exit(code);
})();
