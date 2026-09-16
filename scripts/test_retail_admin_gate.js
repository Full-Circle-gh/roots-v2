#!/usr/bin/env node
/**
 * A locked database is not a signed-out operator — §151.
 *
 *   node scripts/test_retail_admin_gate.js
 *
 * THE BUG THIS SUITE EXISTS FOR. `requireRetailAdmin` wrapped its operator
 * lookup in a try/catch written for a first boot — "tables not ready" — and
 * that catch swallowed EVERY error, `SQLITE_BUSY: database is locked`
 * included. The gate then answered `401 Not authenticated`, and
 * public/retail-admin/01-core.js sends a 401 straight to /backend/login. A
 * moment of write contention logged an operator out mid-task, and nothing in
 * the answer mentioned the database.
 *
 * It was found the way these things are: a suite's 200 came back 401 in one
 * parallel run of `npm run test:fast`, and passed alone.
 *
 * The gate is exercised over HTTP with the REAL router and the REAL database.
 * The failures are injected by replacing `prepare` on the shared database
 * module — the same object `routes/retail.js` holds — so the error arrives
 * from where a real one would, rather than from a stub standing in for the
 * gate.
 *
 * Five things are held here that a reading of the code cannot prove:
 *   1. A locked database answers 503, not 401 — nobody is sent to the login
 *      page for it.
 *   2. A database with no tables yet still falls through to 401, which is the
 *      case the original guard was written for and is correct.
 *   3. Every ordinary refusal — no such operator, an inactive one, a suspended
 *      tenant — is still exactly 401. The fix must not have widened the gate.
 *   4. A handler that throws AFTER the gate has passed is express's 500 and
 *      never the gate's 401. NOT proof that next() sits outside the try — the
 *      first draft of this suite claimed that and the claim was wrong: express
 *      catches a handler's throw at the layer boundary, so it never reaches
 *      this gate either way, and moving next() back inside changes no status
 *      here. It is held because the invariant is worth holding, not because it
 *      distinguishes the two shapes.
 *   5. The operator reads a sentence about the system rather than the code
 *      `service_busy`, in either language.
 */
'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const rawDb = require(path.join(ROOT, 'database.js'));
const { requireRetailAdmin } = require(path.join(ROOT, 'routes', 'retail.js'));
const { schemaNotReady } = require(path.join(ROOT, 'lib', 'sqlite-errors.js'));

let failures = 0;
// AWAITS, and it has to. Half the checks below are async: a synchronous runner
// would let their assertion failures escape as unhandled rejections and print a
// tick for every one of them. A suite that cannot fail is worse than none.
async function check(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the blocks the other suites use.
const OP_OK       = 9871;   // an active operator on an active tenant
const OP_INACTIVE = 9872;   // the row is there and switched off

const tenantRow = rawDb.prepare("SELECT id FROM tenants WHERE status = 'active' ORDER BY id LIMIT 1").get();
const TENANT = tenantRow ? tenantRow.id : 1;

function cleanup() {
  rawDb.prepare('DELETE FROM tenant_users WHERE id IN (?, ?)').run(OP_OK, OP_INACTIVE);
}
cleanup();
const insOperator = rawDb.prepare(`
  INSERT INTO tenant_users (id, tenant_id, username, password, role, is_active)
  VALUES (?, ?, ?, 'x', 'owner', ?)`);
insOperator.run(OP_OK,       TENANT, '__gate_ok',       1);
insOperator.run(OP_INACTIVE, TENANT, '__gate_inactive', 0);

// ── Injecting the failure ──────────────────────────────────────────────────
// `prepare` is replaced on the database module itself, which is the object
// routes/retail.js closed over at require time. Restored by deleting the own
// property, putting the prototype's method back rather than a copy of it.
const realPrepare = rawDb.prepare.bind(rawDb);
function throwFrom(sql, err) {
  rawDb.prepare = function (text) {
    if (String(text).includes(sql)) throw err;
    return realPrepare(text);
  };
}
function stopThrowing() { delete rawDb.prepare; }

function busyError() {
  const e = new Error('database is locked');
  e.code = 'SQLITE_BUSY';
  return e;
}
function missingTableError() {
  const e = new Error('no such table: tenant_users');
  e.code = 'SQLITE_ERROR';
  return e;
}

// ── Harness ────────────────────────────────────────────────────────────────
let SESSION_USER = OP_OK;
const app = express();
app.use((req, _res, next) => { req.session = { backendUserId: SESSION_USER }; next(); });
app.get('/__probe', requireRetailAdmin, (_req, res) => res.json({ success: true }));
// The handler that throws AFTER the gate has let the request through. Its
// error must not be reported as a login problem.
app.get('/__throws', requireRetailAdmin, () => { throw new Error('handler exploded'); });
// Express's default error handler prints the stack; silence it so a deliberate
// throw does not read as a broken suite.
app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: 'handler_failed' }); });

let server, PORT;
function call(url) {
  return fetch(`http://127.0.0.1:${PORT}${url}`)
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); }); });
  try {
    console.log('\nThe fixture, and the refusals that must not change');
    await check('an active operator passes the gate', async () => {
      SESSION_USER = OP_OK;
      const r = await call('/__probe');
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    });
    await check('an operator who does not exist is 401', async () => {
      SESSION_USER = 99999871;
      assert.strictEqual((await call('/__probe')).status, 401);
    });
    await check('an operator switched off is 401', async () => {
      SESSION_USER = OP_INACTIVE;
      assert.strictEqual((await call('/__probe')).status, 401);
    });

    console.log('\nA database that cannot answer (§151)');
    await check('a locked database is 503, not 401', async () => {
      SESSION_USER = OP_OK;
      throwFrom('FROM tenant_users', busyError());
      try {
        const r = await call('/__probe');
        assert.notStrictEqual(r.status, 401, 'a locked database still reports a login problem');
        assert.strictEqual(r.status, 503);
      } finally { stopThrowing(); }
    });
    await check('and it names itself, so the page can say which sentence to show', async () => {
      SESSION_USER = OP_OK;
      throwFrom('FROM tenant_users', busyError());
      try {
        const r = await call('/__probe');
        assert.strictEqual(r.json && r.json.error, 'service_busy');
        assert.strictEqual(r.json && r.json.success, false);
      } finally { stopThrowing(); }
    });
    await check('a failure on the TENANT read is 503 too, not 401', async () => {
      // The second query in the gate. It sits inside the same try and had the
      // same fate.
      SESSION_USER = OP_OK;
      throwFrom('FROM tenants WHERE id', busyError());
      try {
        assert.strictEqual((await call('/__probe')).status, 503);
      } finally { stopThrowing(); }
    });
    await check('a database with no tables yet still falls through to 401', async () => {
      // The case the original guard was written for, and the half of it that
      // was right: there is nobody to be signed in as.
      SESSION_USER = OP_OK;
      throwFrom('FROM tenant_users', missingTableError());
      try {
        assert.strictEqual((await call('/__probe')).status, 401);
      } finally { stopThrowing(); }
    });
    await check('the gate recovers — a 503 is not a latch', async () => {
      SESSION_USER = OP_OK;
      assert.strictEqual((await call('/__probe')).status, 200);
    });

    console.log('\nA handler that fails is not a login problem');
    await check('a handler that throws is a 500, never the gate\'s 401', async () => {
      SESSION_USER = OP_OK;
      const r = await call('/__throws');
      assert.notStrictEqual(r.status, 401, 'a handler error is being reported as a login problem');
      assert.strictEqual(r.status, 500);
    });

    console.log('\nTelling the two failures apart');
    await check('schemaNotReady knows a missing table and a missing column', () => {
      assert.strictEqual(schemaNotReady(new Error('no such table: tenant_users')), true);
      assert.strictEqual(schemaNotReady(new Error('no such column: roles_version')), true);
    });
    await check('and treats everything else as a real failure', () => {
      assert.strictEqual(schemaNotReady(busyError()), false);
      assert.strictEqual(schemaNotReady(new Error('UNIQUE constraint failed: tenant_users.id')), false);
      assert.strictEqual(schemaNotReady(new Error('disk I/O error')), false);
      assert.strictEqual(schemaNotReady(null), false);
      assert.strictEqual(schemaNotReady(undefined), false);
    });

    console.log('\nWhat the operator reads');
    const core = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
    await check('401 is still the only status that sends anyone to the login page', () => {
      assert.match(core, /if \(r\.status === 401\) \{ location\.href = '\/backend\/login'/);
      assert.doesNotMatch(core, /r\.status === 503[^\n]*login/);
    });
    await check('service_busy has a sentence in both languages', () => {
      const m = /service_busy:\s*\[([^\]]+)\]/.exec(core);
      assert.ok(m, 'TD_ERR has no service_busy entry, so the operator would read the bare code');
      assert.match(m[1], /[一-鿿]/, 'no Chinese half');
      assert.match(m[1], /'The system is busy/, 'no English half');
    });

    console.log('\nThe same swallow, narrowed where it also sat');
    const cap = fs.readFileSync(path.join(ROOT, 'lib', 'require-cap.js'), 'utf8');
    await check('loadCaller no longer resolves capabilities off a swallowed error', () => {
      // A null tenant there means resolveOperator falls back to the shipped
      // preset instead of this tenant's own edited role — a permission decision
      // made on capabilities nobody granted.
      assert.match(cap, /if \(!schemaNotReady\(e\)\) throw e;/);
      assert.match(cap, /catch \(e2\) \{ if \(!schemaNotReady\(e2\)\) throw e2; \}/);
    });
  } finally {
    stopThrowing();
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); stopThrowing(); cleanup(); process.exit(1); });
