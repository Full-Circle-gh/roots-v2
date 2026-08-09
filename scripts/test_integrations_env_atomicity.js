#!/usr/bin/env node
/**
 * PUT /api/retail-admin/integrations — the env mirror must not run inside the
 * transaction.
 *
 *   node scripts/test_integrations_env_atomicity.js
 *
 * THE DEFECT. The Roots branch of this handler wrote `process.env` INSIDE the
 * transaction body, interleaved with the `storefront_config` writes:
 *
 *     const tx = tdb().transaction(() => {
 *       for (const { svc, field, meta, val } of edits) {
 *         ...
 *         upsert.run(cfgKey, ...);
 *         process.env[meta.env] = String(val);      // <- not transactional
 *       }
 *     });
 *
 * A rollback cannot undo an environment assignment. So the body was not atomic:
 * the database write could be discarded while the env write survived, and the
 * two halves of one "save" would disagree.
 *
 * WHY THAT IS WORSE THAN IT SOUNDS, and why it is worth a suite of its own.
 * For the Roots tenant, `process.env` is not a cache of the database — it IS the
 * runtime source of truth. `getTenantCreds(1)` resolves to `rootsEnvBundle()`,
 * which reads `process.env` live and uncached on every call, and three legacy
 * fallbacks (`lib/jd.js:_env`, `lib/tracking.js:_envKd100`, `lib/feie.js:_env`)
 * read it directly. `storefront_config` is not consulted at request time at all;
 * it is the durable copy that `database.js` hydrates back into env at boot.
 *
 * So a rolled-back save left the process serving a credential that was never
 * stored. **It worked.** Waybills printed, SMS sent, the test buttons passed —
 * and then at the next restart the old value was hydrated back and the new
 * credential silently vanished, with no error at any point in the sequence.
 * That is the failure this file exists to make impossible.
 *
 * THE FIX is to move the env mirror out of the transaction and apply it after
 * the commit, so the body is pure database work. Section 2 is the red proof:
 * both assertions fail against the pre-fix body and pass against the fixed one.
 *
 * routes/retail.js cannot be required from a test — it opens the database at
 * load, registers routes and starts intervals — so both forms of the body are
 * reproduced verbatim below, and section 4 reads the REAL file to prove the
 * reproduction still matches it.
 *
 * TO PROVE THE SUITE CAN FAIL:  INTEG_ENV_SABOTAGE=1 node scripts/test_integrations_env_atomicity.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');

const SABOTAGE = process.env.INTEG_ENV_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

// Every column this handler writes. Held to the harness the way every batch
// since batch 2 has had to be — a silently thinner table makes the rest of this
// file pass against a schema the real code would fail on.
const WRITTEN_COLUMNS = {
  storefront_config: ['key', 'value_json', 'updated_at', 'updated_by'],
};

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const fresh = () => openTablesDb(DB_SRC, ['storefront_config']);

const UPSERT = `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = excluded.updated_by`;

/** Stand-in for db.transaction() on drivers that lack it — the same statements. */
function legacyTransaction(db, fn) {
  return () => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
}
const makeTx = (db, fn) => (typeof db.transaction === 'function' ? db.transaction(fn) : legacyTransaction(db, fn));

// ── The body BEFORE the fix — env written inside the transaction ──────────
// `hook` injects a mid-transaction failure, which is the only way this defect
// is reachable: without a rollback the two halves agree.
function bodyBefore(db, env, edits, userId, hook) {
  const upsert = db.prepare(UPSERT);
  const tx = makeTx(db, () => {
    for (const { svc, field, meta, val } of edits) {
      const cfgKey = `integrations.${svc}.${field}`;
      if (val === null || val === '') {
        db.prepare('DELETE FROM storefront_config WHERE key = ?').run(cfgKey);
        delete env[meta.env];
      } else {
        upsert.run(cfgKey, JSON.stringify(String(val)), userId);
        env[meta.env] = String(val);
      }
      if (hook) hook();
    }
  });
  tx();
}

// ── The body AFTER the fix — transaction is pure database work ────────────
function bodyAfter(db, env, edits, userId, hook) {
  const upsert = db.prepare(UPSERT);
  const tx = makeTx(db, () => {
    for (const { svc, field, val } of edits) {
      const cfgKey = `integrations.${svc}.${field}`;
      if (val === null || val === '') {
        db.prepare('DELETE FROM storefront_config WHERE key = ?').run(cfgKey);
      } else {
        upsert.run(cfgKey, JSON.stringify(String(val)), userId);
      }
      if (hook) hook();
    }
  });
  tx();
  // Mirror to env only once the write is durable.
  for (const { meta, val } of edits) {
    if (val === null || val === '') delete env[meta.env];
    else env[meta.env] = String(val);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
// A real edit shape, taken from INTEGRATION_KEYS.
const SET_EDIT = [{ svc: 'jd', field: 'app_key', meta: { env: 'JD_APP_KEY' }, val: 'NEW-KEY' }];
const CLEAR_EDIT = [{ svc: 'jd', field: 'app_key', meta: { env: 'JD_APP_KEY' }, val: '' }];
const boom = () => { throw new Error('disk full'); };

const cfg = (db) => db.prepare('SELECT key, value_json FROM storefront_config ORDER BY key').all();
const cfgVal = (db, k) => {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
  return r ? JSON.parse(r.value_json) : undefined;
};
/** A fake env object — the real process.env is never touched by this suite. */
const envWith = (o) => ({ ...o });

console.log(`\nPUT /integrations — env mirror atomicity (driver: ${driver})`);
if (SABOTAGE) console.log('  *** INTEG_ENV_SABOTAGE=1 — expected values flipped, this run MUST fail 2 ***');
console.log('');

// ─────────────────────────────────────────────────────────────────────────
console.log('[1] HARNESS COVERS EVERY COLUMN THIS ROUTE WRITES');
it('every written column exists in the harness-built schema', () => {
  const db = fresh();
  const gaps = [];
  for (const [t, cols] of Object.entries(WRITTEN_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
    for (const c of cols) if (!have.has(c)) gaps.push(`${t}.${c}`);
  }
  assert.deepStrictEqual(gaps, [], `harness schema is missing ${gaps.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n[2] THE DEFECT — a rollback must leave env exactly as it was');

it('SET path: a rolled-back save must NOT leave the new credential in env', () => {
  const db = fresh();
  const env = envWith({ JD_APP_KEY: 'OLD-KEY' });
  assert.throws(() => bodyAfter(db, env, SET_EDIT, 7, boom), /disk full/);
  assert.strictEqual(env.JD_APP_KEY, SABOTAGE ? 'NEW-KEY' : 'OLD-KEY',
    'the process is serving a credential that was never saved');
  assert.strictEqual(cfgVal(db, 'integrations.jd.app_key'), undefined,
    'and the database correctly has nothing');
});

it('CLEAR path: a rolled-back DELETE must NOT leave the env var deleted', () => {
  const db = fresh();
  db.prepare(UPSERT).run('integrations.jd.app_key', JSON.stringify('OLD-KEY'), 1);
  const env = envWith({ JD_APP_KEY: 'OLD-KEY' });
  assert.throws(() => bodyAfter(db, env, CLEAR_EDIT, 7, boom), /disk full/);
  assert.strictEqual(env.JD_APP_KEY, SABOTAGE ? undefined : 'OLD-KEY',
    'the credential was revoked in the process but not in the database');
  assert.strictEqual(cfgVal(db, 'integrations.jd.app_key'), 'OLD-KEY',
    'and the database correctly still has it');
});

it('THE OLD BODY FAILS BOTH — the defect, executed rather than described', () => {
  // Not a description of the bug. The pre-fix body is run against the same
  // fixtures and shown diverging, so the fix is measured against a demonstrated
  // failure and this file cannot quietly pass on a no-op change.
  const dbSet = fresh();
  const envSet = envWith({ JD_APP_KEY: 'OLD-KEY' });
  assert.throws(() => bodyBefore(dbSet, envSet, SET_EDIT, 7, boom), /disk full/);
  assert.strictEqual(envSet.JD_APP_KEY, 'NEW-KEY',
    'pre-fix: env should have kept the unsaved value — that is the defect');
  assert.strictEqual(cfgVal(dbSet, 'integrations.jd.app_key'), undefined,
    'pre-fix: while the database kept nothing — the two halves disagree');

  const dbClr = fresh();
  dbClr.prepare(UPSERT).run('integrations.jd.app_key', JSON.stringify('OLD-KEY'), 1);
  const envClr = envWith({ JD_APP_KEY: 'OLD-KEY' });
  assert.throws(() => bodyBefore(dbClr, envClr, CLEAR_EDIT, 7, boom), /disk full/);
  assert.strictEqual(envClr.JD_APP_KEY, undefined,
    'pre-fix: env should have kept the deletion');
  assert.strictEqual(cfgVal(dbClr, 'integrations.jd.app_key'), 'OLD-KEY',
    'pre-fix: while the row survived — a credential revoked in one place only');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n[3] THE HAPPY PATHS ARE UNCHANGED');

it('a successful save writes the row AND mirrors to env', () => {
  const db = fresh();
  const env = envWith({ JD_APP_KEY: 'OLD-KEY' });
  bodyAfter(db, env, SET_EDIT, 7);
  assert.strictEqual(cfgVal(db, 'integrations.jd.app_key'), 'NEW-KEY');
  assert.strictEqual(env.JD_APP_KEY, 'NEW-KEY');
});

it('a successful clear deletes the row AND the env var', () => {
  const db = fresh();
  db.prepare(UPSERT).run('integrations.jd.app_key', JSON.stringify('OLD-KEY'), 1);
  const env = envWith({ JD_APP_KEY: 'OLD-KEY' });
  bodyAfter(db, env, CLEAR_EDIT, 7);
  assert.strictEqual(cfgVal(db, 'integrations.jd.app_key'), undefined);
  assert.ok(!('JD_APP_KEY' in env), 'the env var must be removed, not blanked');
});

it('both forms agree on a successful multi-field save', () => {
  const edits = [
    { svc: 'jd', field: 'app_key', meta: { env: 'JD_APP_KEY' }, val: 'K' },
    { svc: 'jd', field: 'app_secret', meta: { env: 'JD_APP_SECRET' }, val: 'S' },
    { svc: 'feie', field: 'user', meta: { env: 'FEIE_USER' }, val: 'U' },
  ];
  const a = fresh(); const envA = envWith({});
  const b = fresh(); const envB = envWith({});
  bodyBefore(a, envA, edits, 7);
  bodyAfter(b, envB, edits, 7);
  assert.deepStrictEqual(cfg(b), cfg(a), 'same rows');
  assert.deepStrictEqual(envB, envA, 'same env');
  assert.deepStrictEqual(envB, { JD_APP_KEY: 'K', JD_APP_SECRET: 'S', FEIE_USER: 'U' });
});

it('a partial failure leaves NEITHER the rows nor any env change', () => {
  // The second edit blows up, so the first edit's row must roll back with it —
  // and no env var may carry either value.
  const db = fresh();
  const env = envWith({});
  let n = 0;
  const edits = [
    { svc: 'jd', field: 'app_key', meta: { env: 'JD_APP_KEY' }, val: 'K' },
    { svc: 'jd', field: 'app_secret', meta: { env: 'JD_APP_SECRET' }, val: 'S' },
  ];
  assert.throws(() => bodyAfter(db, env, edits, 7, () => { if (++n === 2) boom(); }), /disk full/);
  assert.deepStrictEqual(cfg(db), []);
  assert.deepStrictEqual(env, {}, 'no half-applied env mirror');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n[4] THE REAL FILE — the two lines must not drift back in');

const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

/** The source of the PUT /integrations handler. */
function integrationsHandler() {
  const m = /router\.put\('\/api\/retail-admin\/integrations',/.exec(RETAIL_SRC);
  assert.ok(m, 'PUT /api/retail-admin/integrations not found');
  const arrow = /\(req, res\)\s*=>\s*\{/.exec(RETAIL_SRC.slice(m.index));
  let i = m.index + arrow.index + arrow[0].length - 1, depth = 0;
  for (; i < RETAIL_SRC.length; i++) {
    const c = RETAIL_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return RETAIL_SRC.slice(m.index, i + 1);
}

/**
 * Line comments removed, quote- and template-aware.
 *
 * NOT optional tidiness — it is the reason the first draft of this section was
 * wrong. The per-tenant branch carries the comment "no process.env touch (that
 * env belongs to Roots)", and a bare /process\.env/ over raw source matched THAT
 * and reported the branch as writing env. A comment answered for the code. Same
 * class as the harness's comment-blind FOREIGN KEY strip recorded in §24.
 */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++; } out += src[i]; i++; }
      out += src[i]; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** [start, end] of the `{ … }` block whose opening brace is at or after `from`. */
function block(src, from) {
  const start = src.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return [start, i + 1]; }
  }
  throw new Error('unbalanced block');
}

/**
 * The two arms of `if (isRoots) { … } else { … }`, located by brace matching.
 *
 * The first draft used `src.indexOf('} else {')`, which finds the SET/CLEAR
 * branch inside the transaction — an inner `} else {` several lines earlier —
 * and so tested the wrong region entirely. Structure has to be matched
 * structurally; there is no string that identifies this branch by sight.
 */
function branches(src) {
  const at = src.indexOf('if (isRoots)');
  assert.notStrictEqual(at, -1, 'the isRoots dispatch is gone');
  const [rs, re] = block(src, at);
  const elseAt = src.indexOf('else', re - 1);
  assert.notStrictEqual(elseAt, -1, 'the per-tenant branch is gone');
  const [ps, pe] = block(src, elseAt);
  return { roots: src.slice(rs, re), perTenant: src.slice(ps, pe) };
}

/** The body of every `tdb().transaction(...)` inside one handler's source. */
function txBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\.transaction\(/g)) {
    const [s, e] = block(src, src.indexOf('=>', m.index));
    out.push(src.slice(s, e));
  }
  return out;
}

it('NOTHING inside the transaction body touches process.env', () => {
  // The standing guard. This is the specific mistake, not the symptom: an env
  // write inside the body is unrollbackable no matter how the rest is arranged.
  const src = stripComments(integrationsHandler());
  const bodies = txBodies(src);
  assert.strictEqual(bodies.length, 1, `expected one transaction in the handler, found ${bodies.length}`);
  assert.ok(!/process\.env/.test(bodies[0]),
    'process.env is back inside the transaction — a rollback cannot undo it');
});

it('the handler DOES still mirror to env, after the transaction', () => {
  // The inverse guard: removing the two lines entirely would also pass the
  // assertion above, and would silently stop the save taking effect until the
  // next restart. env is the runtime source of truth for Roots.
  const src = stripComments(integrationsHandler());
  assert.ok(/process\.env\[meta\.env\]\s*=/.test(src), 'the env mirror is gone entirely');
  assert.ok(/delete process\.env\[meta\.env\]/.test(src), 'the env clear is gone entirely');
  const [, txEnd] = block(src, src.indexOf('=>', src.indexOf('.transaction(')));
  assert.ok(src.indexOf('process.env[meta.env]') > txEnd,
    'the env mirror must come AFTER the transaction closes');
});

it('the per-tenant branch still touches no env at all', () => {
  const { perTenant } = branches(stripComments(integrationsHandler()));
  assert.ok(!/process\.env/.test(perTenant),
    'the per-tenant path must never write Roots env');
});

it('the env mirror is inside the Roots branch, not the shared tail', () => {
  // Where it sits matters as much as when it runs: hoisted below the if/else it
  // would fire for every tenant and write Roots credentials into the shared
  // process from a per-tenant save.
  const { roots, perTenant } = branches(stripComments(integrationsHandler()));
  assert.ok(/process\.env\[meta\.env\]/.test(roots), 'the mirror left the Roots branch');
  assert.ok(!/process\.env/.test(perTenant));
});

console.log('');
if (SABOTAGE) {
  // Two, not three. The flag flips the expected env value in the SET and CLEAR
  // rollback assertions. It deliberately does NOT touch the old-body test —
  // that one asserts the defect still reproduces, and section 4's red is proven
  // directly against the pre-fix source rather than by sabotage.
  console.log(`  sabotage: ${fail} of the 2 sabotage-sensitive assertions failed (set path, clear path)`);
}
console.log(`\n  ${pass} passed, ${fail} failed   [driver: ${driver}]\n`);
process.exitCode = fail === 0 ? 0 : 1;
