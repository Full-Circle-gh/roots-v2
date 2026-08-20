#!/usr/bin/env node
/**
 * The driver selector (G2) and the alien Postgres handle.
 *
 *   node scripts/test_db_driver.js
 *
 * EVERY CASE IS A REAL BOOT IN A REAL CHILD PROCESS. TACET_DB is read once at
 * module load, so a suite that re-required modules in-process would be testing
 * the module cache rather than the decision. Each test spawns `node` with the
 * environment it is about, exactly as pm2 does.
 *
 * ── THE ONE THAT MATTERS IS TEST 8 ────────────────────────────────────────
 * An unconverted call site under Postgres must THROW, not return undefined —
 * and it is proved by EXECUTING A REAL UNCONVERTED PATH, not by asserting a
 * method is absent. `lib/inventory.js` getAvailable() is untouched production
 * code: it calls `tdb().prepare(...)`, which resolves through lib/tenant-db.js
 * to lib/db-seam.js to whatever database.js exported. The whole chain runs.
 *
 * Asserting `typeof handle.prepare === 'undefined'` would pass against a handle
 * that still broke every call site in some other way. Running the real function
 * and catching a real TypeError is the claim this work actually makes.
 *
 * ── WHY ABSENCE OF `exec` IS ASSERTED BY NAME ─────────────────────────────
 * lib/db-transaction.js control() tests `typeof handle.exec === 'function'`
 * BEFORE `.query`. A handle carrying both takes the SQLite branch and issues
 * BEGIN down a driver that cannot execute it synchronously. Of all the forbidden
 * names that one has its own test.
 *
 * TO PROVE THE SUITE CAN FAIL:  DBD_MUTANT=1 node scripts/test_db_driver.js
 * The mutant adds `exec` to the handle — the exact shape of somebody "improving"
 * it into an adapter — and the suite must go RED. Per §24 (v4.27) the mutation
 * ASSERTS IT MODIFIED THE SOURCE before its red counts as evidence.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG_HANDLE = path.join(ROOT, 'lib', 'pg-handle.js');
const PG_HANDLE_SRC = fs.readFileSync(PG_HANDLE, 'utf8');
const MUTANT = process.env.DBD_MUTANT === '1';

// ── source anchors ───────────────────────────────────────────────────────
// §24: a suite must ASSERT that no anchor matches /[\r\n]/ before running any of
// them. A `\n` anchor against a CRLF file matches nothing, and a mutation that
// removes an absent substring changes nothing — a VACUOUS PASS that reads as
// proof. Fourth sighting is why this is a mechanism and not a note.
const ANCHORS = {
  handleField: '    checkout,',
  assertCall: '  assertAlien(handle, label);',
};
for (const [name, a] of Object.entries(ANCHORS)) {
  assert.ok(!/[\r\n]/.test(a), `anchor ${name} carries a line ending — it would match nothing`);
}

let pass = 0, fail = 0;
let code = 1;               // fail-closed: only an explicit pass sets this to 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
};

// ── the module under test, possibly mutated ──────────────────────────────
let restore = null;
if (MUTANT) {
  assert.strictEqual(
    PG_HANDLE_SRC.split(ANCHORS.handleField).length - 1, 1,
    'the mutant anchor is not unique in lib/pg-handle.js — the mutation would be ambiguous'
  );
  const mutated = PG_HANDLE_SRC.replace(
    ANCHORS.handleField,
    ANCHORS.handleField + '\n    exec: () => {},'
  );
  assert.notStrictEqual(mutated, PG_HANDLE_SRC,
    'MUTANT DID NOT MODIFY THE SOURCE — anchor missing, red would be vacuous');
  fs.writeFileSync(PG_HANDLE, mutated);
  restore = () => fs.writeFileSync(PG_HANDLE, PG_HANDLE_SRC);
  console.log('MUTANT ACTIVE — `exec` added to the handle. The suite MUST go red.\n');
}

/** Boot `node -e <src>` with TACET_DB set (or deliberately absent). */
function boot(tacetDb, src) {
  const env = { ...process.env };
  if (tacetDb === undefined) delete env.TACET_DB; else env.TACET_DB = tacetDb;
  try {
    const out = execFileSync(process.execPath, ['-e', src], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const DRIVER_LINE = "const d = require('./lib/db-driver'); console.log('DRIVER=' + d.DRIVER);";

try {
  console.log('db-driver + pg-handle — suite\n');

  t('1  MISSING selects sqlite and says so — absence is not an error', () => {
    const r = boot(undefined, DRIVER_LINE);
    assert.ok(r.ok, `refused to boot with TACET_DB unset:\n${r.err}`);
    assert.ok(/DRIVER=sqlite/.test(r.out), `expected sqlite, got:\n${r.out}`);
    assert.ok(/TACET_DB is not set/.test(r.out), 'the default was not announced');
    assert.ok(/is not a warning/.test(r.out), 'the default reads as a warning; it is the pre-flip state');
  });

  t('2  TACET_DB=sqlite selects sqlite explicitly', () => {
    const r = boot('sqlite', DRIVER_LINE);
    assert.ok(r.ok, r.err);
    assert.ok(/DRIVER=sqlite/.test(r.out), r.out);
  });

  t('3  TACET_DB=postgres selects postgres AND names it in the boot log', () => {
    const r = boot('postgres', DRIVER_LINE);
    assert.ok(r.ok, r.err);
    assert.ok(/DRIVER=postgres/.test(r.out), r.out);
    // The flip step ASSERTS this line rather than assuming --update-env worked.
    assert.ok(/\[db-driver\] TACET_DB=postgres — driver: postgres/.test(r.out),
      `the assertable boot line is missing or reworded:\n${r.out}`);
  });

  t('4  A NEAR-MISS REFUSES TO BOOT — postgresql, pg, postgre, sqlite3', () => {
    for (const bad of ['postgresql', 'pg', 'postgre', 'sqlite3', 'true', '1']) {
      const r = boot(bad, DRIVER_LINE);
      assert.ok(!r.ok, `TACET_DB=${bad} booted; it must refuse`);
      assert.ok(/not a driver this application knows/.test(r.err),
        `TACET_DB=${bad} failed for the wrong reason:\n${r.err}`);
      assert.ok(!/DRIVER=/.test(r.out), `TACET_DB=${bad} selected a driver before refusing`);
    }
  });

  t('5  whitespace and case are tolerated — same token, not a near-miss', () => {
    for (const good of [' postgres ', 'POSTGRES', 'Postgres', '\tpostgres\n']) {
      const r = boot(good, DRIVER_LINE);
      assert.ok(r.ok, `TACET_DB=${JSON.stringify(good)} refused: ${r.err}`);
      assert.ok(/DRIVER=postgres/.test(r.out), `${JSON.stringify(good)} -> ${r.out}`);
    }
  });

  t('6  an empty value is MISSING, not unrecognised', () => {
    const r = boot('', DRIVER_LINE);
    assert.ok(r.ok, `empty TACET_DB refused to boot:\n${r.err}`);
    assert.ok(/DRIVER=sqlite/.test(r.out), r.out);
  });

  t('7  the refusal happens at LOAD, before any handle is built', () => {
    const r = boot('postgresql', "require('./database'); console.log('BUILT');");
    assert.ok(!r.ok, 'database.js loaded under a bad TACET_DB');
    assert.ok(!/BUILT/.test(r.out), 'a handle was built before the value was validated');
  });

  t('8  *** A REAL UNCONVERTED PATH THROWS, IT DOES NOT RETURN undefined ***', () => {
    // lib/inventory.js getAvailable() — untouched production code, calling
    // tdb().prepare(...) through the real seam. Executed, not inspected.
    const r = boot('postgres', `
      const inv = require('./lib/inventory');
      try { const v = inv.getAvailable(1, 1); console.log('RETURNED=' + JSON.stringify(v)); }
      catch (e) { console.log('THREW=' + e.constructor.name + '|' + e.message); }
    `);
    assert.ok(r.ok, `the probe process died: ${r.err}`);
    assert.ok(!/RETURNED=/.test(r.out),
      `A REAL CALL SITE RETURNED A VALUE UNDER POSTGRES INSTEAD OF THROWING:\n${r.out}`);
    assert.ok(/THREW=TypeError\|/.test(r.out), `expected a TypeError, got:\n${r.out}`);
    assert.ok(/prepare is not a function/.test(r.out),
      `it threw, but not at the call-site boundary:\n${r.out}`);
  });

  t('9  the handle exposes NO better-sqlite3 name', () => {
    const r = boot('postgres', `
      const h = require('./database');
      const { FORBIDDEN_NAMES } = require('./lib/pg-handle');
      console.log('PRESENT=' + FORBIDDEN_NAMES.filter((n) => n in h).join(','));
      console.log('KEYS=' + Object.keys(h).join(','));
    `);
    assert.ok(r.ok, r.err);
    assert.ok(/PRESENT=\s*$/m.test(r.out), `forbidden names present: ${(/PRESENT=(.*)/.exec(r.out) || [])[1]}`);
  });

  t('10 `exec` in particular is absent — control() would take the SQLite branch', () => {
    const r = boot('postgres', "const h=require('./database'); console.log('EXEC=' + typeof h.exec);");
    assert.ok(r.ok, r.err);
    assert.ok(/EXEC=undefined/.test(r.out),
      `the handle carries exec; lib/db-transaction.js control() tests it FIRST:\n${r.out}`);
  });

  t('11 the alien guard is NOT VACUOUS — it refuses an adapter-shaped object', () => {
    // Aimed at assertAlien directly. makePgHandle builds an explicit literal and
    // ignores unknown keys, so an adapter cannot arrive through its arguments —
    // it can only arrive by someone EDITING that literal, which is exactly what
    // the DBD_MUTANT run does. These two together are the guard's proof: this
    // test shows it fires, the mutant shows it is wired to the real path.
    const r = boot('postgres', `
      const { assertAlien } = require('./lib/pg-handle');
      for (const bad of [{ exec: () => {} }, { prepare: () => {} },
                         Object.create({ transaction: () => {} })]) {
        try { assertAlien(bad, 'test object'); console.log('ACCEPTED=' + Object.keys(bad)); }
        catch (e) { console.log('REFUSED=' + /name\\(s\\): ([a-z, ]+)\\./.exec(e.message)[1]); }
      }
    `);
    assert.ok(r.ok, r.err);
    assert.ok(!/ACCEPTED/.test(r.out), `an adapter-shaped object was accepted:\n${r.out}`);
    assert.ok(/REFUSED=exec/.test(r.out), `exec was not refused:\n${r.out}`);
    assert.ok(/REFUSED=prepare/.test(r.out), `prepare was not refused:\n${r.out}`);
    // The prototype case: `in` rather than hasOwnProperty is what catches an
    // adapter bolted on through a prototype or a Proxy.
    assert.ok(/REFUSED=transaction/.test(r.out),
      `a PROTOTYPE-borne adapter slipped through — the check is using own-properties:\n${r.out}`);
  });

  t('12 the handle is FROZEN — .prepare cannot be bolted on at runtime', () => {
    const r = boot('postgres', `
      'use strict';
      const h = require('./database');
      try { h.prepare = () => {}; console.log('MUTATED'); }
      catch (e) { console.log('FROZEN=' + e.constructor.name); }
      console.log('AFTER=' + typeof h.prepare);
    `);
    assert.ok(r.ok, r.err);
    assert.ok(/AFTER=undefined/.test(r.out), `prepare was successfully bolted on:\n${r.out}`);
  });

  t('13 every use of the unwired handle names the gap', () => {
    const r = boot('postgres', `
      const h = require('./database');
      try { h.query('SELECT 1'); console.log('RAN'); }
      catch (e) { console.log('THREW=' + e.message); }
    `);
    assert.ok(r.ok, r.err);
    assert.ok(!/RAN/.test(r.out), 'the unwired handle executed a query');
    assert.ok(/G3/.test(r.out), `the error does not name the gap:\n${r.out}`);
  });

  t('14 THE SQLITE PATH IS UNCHANGED — real handle, real query, real shape', () => {
    const r = boot(undefined, `
      const db = require('./database');
      console.log('SHAPE=' + ['prepare','exec','transaction','pragma']
        .map((n) => typeof db[n]).join(','));
      console.log('QUERY=' + db.prepare('SELECT 1 AS n').get().n);
      console.log('WAL=' + db.pragma('journal_mode', { simple: true }));
    `);
    assert.ok(r.ok, `the sqlite path broke:\n${r.err}`);
    assert.ok(/SHAPE=function,function,function,function/.test(r.out), r.out);
    assert.ok(/QUERY=1/.test(r.out), `a real query did not run:\n${r.out}`);
    assert.ok(/WAL=wal/.test(r.out), `journal_mode is not WAL — a pragma was lost:\n${r.out}`);
  });

  t('15 database.js carries an INSERT-ONLY diff — the byte-identity proof', () => {
    // Source-level, and labelled as such per §24 v4.34 rather than left to read
    // as behavioural. The claim "the SQLite path is unchanged" rests on there
    // being no modified line for a change to hide in; test 14 proves it runs,
    // this proves nothing below the branch moved.
    const stat = execFileSync('git', ['diff', '--numstat', 'origin/main', '--', 'database.js'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!stat) return;                      // already committed and merged; nothing to compare
    const [, deletions] = stat.split(/\s+/);
    assert.strictEqual(deletions, '0',
      `database.js has ${deletions} deleted line(s); the branch must insert only`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (MUTANT) {
    if (fail > 0) { console.log('MUTANT: suite went RED as required. The red-proof holds.'); code = 0; }
    else { console.log('MUTANT: suite stayed GREEN. THE SUITE DOES NOT PROVE WHAT IT CLAIMS.'); code = 1; }
  } else {
    code = fail ? 1 : 0;
  }
} finally {
  if (restore) restore();
}
process.exit(code);
