#!/usr/bin/env node
/**
 * A restock request with no destination goes to the WAREHOUSE, not the kitchen.
 *
 * RUNS IN THE TACET REALM NOW. Raising a request is store and warehouse work,
 * and that moved to Tacet — a kitchen session is refused outright by tacetOnly,
 * so a suite driving this route as a kitchen user would be testing a door that
 * is deliberately shut. The operator here is a tenant_users row on an active
 * tenant, which is what the screens actually carry.
 *
 *   node scripts/test_restock_direction_default.js
 *
 * The defect this locks down: _inferDirection defaulted a warehouse or admin
 * user to warehouse→kitchen "for back-compat" with public/restock.html — the
 * only client that ever sent `to_role`, and the only one that asked for the
 * `purpose` the kitchen branch then demands. That page was deleted on
 * 2026-08-04 (488806ce) and its create path was not ported anywhere, so the
 * surviving client, app.html's in-SPA Restock screen, sends neither field. A
 * warehouse or admin user pressing its "Send to Warehouse" button was inferred
 * into the kitchen and rejected with 400 · "purpose required for kitchen
 * requests", on every submission, with nothing on that screen able to satisfy
 * it. Store users were unaffected, which is why it went unnoticed.
 *
 * Everything below runs against a REAL sqlite database and the REAL express
 * route, mounted and called over HTTP, so the statuses and stored rows printed
 * are observed values. Orders are created as DRAFTS: the direction and the
 * purpose gate are both decided before status matters, and a draft fires no
 * push and no SSE fan-out.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
// The control-plane tables (tenants, tenant_users) are created at module load by
// the module that owns them, not by database.js. Requiring it here means the
// fixture never has to carry a second copy of that DDL.
require(path.join(ROOT, 'routes', 'backend-auth.js'));
const router  = require(path.join(ROOT, 'routes', 'restock.js'));
const db = tdb();

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids, clear of the blocks other tests use.
const U_WAREHOUSE = 9701;
const U_ADMIN     = 9702;
const U_STORE     = 9703;
const RS_PREFIX   = '__dirtest';

let CURRENT = U_WAREHOUSE;
let TACET = true;   // the realm the screens sign in as                       // whose session the app runs as

function seedUser(id, username, role) {
  db.prepare(`INSERT OR REPLACE INTO users (id, username, password, role, is_active)
              VALUES (?, ?, 'x', ?, 1)`).run(id, username, role);
  db.prepare('INSERT OR REPLACE INTO permissions (user_id, restock) VALUES (?, 1)').run(id);
}
// A Tacet operator: tenant_users on an active tenant, which is what
// requireRetailAdmin resolves and what every screen actually signs in as.
function seedOperator(id, username, role) {
  const t = db.prepare('SELECT id FROM tenants WHERE status = ? ORDER BY id LIMIT 1').get('active');
  const tenantId = t ? t.id : 1;
  db.prepare(`INSERT OR REPLACE INTO tenant_users (id, tenant_id, username, password, role, is_active)
              VALUES (?, ?, ?, 'x', ?, 1)`).run(id, tenantId, username, role);
  return tenantId;
}
function cleanup() {
  const ids = db.prepare(`SELECT id FROM restock_orders WHERE notes = ?`).all(RS_PREFIX).map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM restock_items WHERE restock_id = ?').run(id);
    db.prepare('DELETE FROM restock_orders WHERE id = ?').run(id);
  }
  for (const id of [U_WAREHOUSE, U_ADMIN, U_STORE]) {
    db.prepare('DELETE FROM tenant_users WHERE id = ?').run(id);
    db.prepare('DELETE FROM permissions WHERE user_id = ?').run(id);
    // logActivity stamped an activity_log row per create, and it carries an FK
    // to users(id) — the user cannot go until its trail does.
    db.prepare('DELETE FROM activity_log WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}

let failures = 0;
function check(label, fn) {
  return fn().then(
    () => console.log(`  ✓ ${label}`),
    e  => { failures++; console.log(`  ✗ ${label}\n      ${e.message}`); },
  );
}

(async () => {
  // Two identities for the same three cases: the Tacet operators that raise
  // requests today, and the kitchen users the store-side door is now shut to.
  seedOperator(U_WAREHOUSE, '__dirtest_wh',    'staff');
  seedOperator(U_ADMIN,     '__dirtest_admin', 'owner');
  seedOperator(U_STORE,     '__dirtest_store', 'store_stock');
  seedUser(U_STORE, '__dirtest_kitchen', 'store');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = TACET ? { backendUserId: CURRENT } : { userId: CURRENT }; next(); });
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // POST one draft line and return { status, body, row } — row being what
  // actually landed in restock_orders, read back rather than assumed.
  async function post(body) {
    const r = await fetch(`${base}/api/restock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: RS_PREFIX, status: 'draft',
        items: [{ product_name: 'fixture', qty_requested: 1 }],
        ...body,
      }),
    });
    const d = await r.json().catch(() => ({}));
    const row = d.id
      ? db.prepare('SELECT from_role, to_role, purpose FROM restock_orders WHERE id = ?').get(d.id)
      : null;
    return { status: r.status, body: d, row };
  }

  try {
    console.log('\nNo destination named — the request goes to the warehouse');

    for (const [who, id] of [['a Tacet operator', U_WAREHOUSE], ['a Tacet owner', U_ADMIN]]) {
      await check(`${who} creating with no to_role succeeds, store→warehouse`, async () => {
        CURRENT = id;
        const { status, body, row } = await post({});
        assert.strictEqual(status, 200, `expected 200, got ${status} · ${body.error || ''}`);
        assert.deepStrictEqual(
          { from_role: row.from_role, to_role: row.to_role },
          { from_role: 'store', to_role: 'warehouse' });
      });
    }

    await check('a store-scoped operator is unaffected, store→warehouse as before', async () => {
      CURRENT = U_STORE;
      const { status, row } = await post({});
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(
        { from_role: row.from_role, to_role: row.to_role },
        { from_role: 'store', to_role: 'warehouse' });
    });

    console.log('\nAn explicit destination still decides, exactly as before');

    await check("to_role:'kitchen' with a purpose still creates a kitchen request", async () => {
      CURRENT = U_WAREHOUSE;
      const { status, row } = await post({ to_role: 'kitchen', purpose: 'shelf' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(
        { from_role: row.from_role, to_role: row.to_role, purpose: row.purpose },
        { from_role: 'warehouse', to_role: 'kitchen', purpose: 'shelf' });
    });

    await check("to_role:'kitchen' without a purpose is still refused", async () => {
      CURRENT = U_WAREHOUSE;
      const { status, body } = await post({ to_role: 'kitchen' });
      assert.strictEqual(status, 400, `expected 400, got ${status}`);
      assert.match(body.error || '', /purpose required/);
    });

    await check("to_role:'store' still pushes warehouse→store", async () => {
      CURRENT = U_WAREHOUSE;
      const { status, row } = await post({ to_role: 'store' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(
        { from_role: row.from_role, to_role: row.to_role },
        { from_role: 'warehouse', to_role: 'store' });
    });

    await check('an unrecognised to_role falls through rather than 400ing', async () => {
      CURRENT = U_WAREHOUSE;
      const { status, row } = await post({ to_role: 'moon' });
      assert.strictEqual(status, 200, `expected 200, got ${status}`);
      assert.strictEqual(row.to_role, 'warehouse');
    });
    console.log('\nThe kitchen realm is shut out of store and warehouse work');
    await check('a kitchen session cannot raise a request at all', async () => {
      TACET = false; CURRENT = U_STORE;
      const { status, body } = await post({});
      assert.strictEqual(status, 403, `expected 403, got ${status}`);
      assert.match(body.error || '', /Tacet/);
      TACET = true;
    });
  } finally {
    TACET = true;
    server.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})();
