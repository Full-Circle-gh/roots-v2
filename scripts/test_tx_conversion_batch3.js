#!/usr/bin/env node
/**
 * Before/after equivalence for the THIRD transaction conversion batch
 * (decisions §24, Path A step 3): five inline route transactions moved from
 * better-sqlite3's db.transaction() onto withTransaction.
 *
 *   node scripts/test_tx_conversion_batch3.js
 *
 * THE FIVE, and what each is here to prove:
 *   PUT  /fapiao-settings                  a conditional storefront_config upsert set
 *   PUT  /printer                          the same shape with a nested object value
 *   POST /customers/:id/reset-test         a body whose RETURN value the response reports
 *   POST /customers/:id/addresses          returns lastInsertRowid; clears is_default first
 *   PUT  /customers/:id/addresses/:addrId  COALESCE partial update + a pin-clearing branch
 *
 * WHY IT IS SHAPED THIS WAY. "It still runs" is not the bar. Each body is run in
 * BOTH forms — the pre-conversion one and the converted one — against the same
 * fixtures on the same schema, and compared on everything observable: rows
 * written, the value the body returned, and the state left behind after a
 * mid-transaction failure.
 *
 * routes/retail.js cannot be required from a test — it opens the database at
 * load, registers routes and starts intervals — so the SQL and control flow of
 * each body are reproduced verbatim below. What the conversion did NOT touch
 * (normalizeChinaAddress, the pin decision, the surrounding handler) is not
 * reproduced: it is byte-identical in the diff, and copying it would only prove
 * that a copy equals itself.
 *
 * *** TEST 1 IS THE ONE THAT MATTERS MOST, AND IT IS NOT ABOUT TRANSACTIONS ***
 * Batch 2 was nearly GREEN AND WRONG because the shared harness silently dropped
 * columns whose addColumn() type it could not parse — the suite passed against a
 * table that was missing fields the code under test writes. Test 1 asserts that
 * every column these five routes write actually EXISTS in the harness-built
 * schema. Without it, a future harness regression makes this whole file
 * meaningless while still reporting success. Add to WRITTEN_COLUMNS whenever a
 * converted route starts writing a new column.
 *
 * ONE DRIVER LIMITATION, STATED RATHER THAN HIDDEN. The pre-conversion form
 * calls db.transaction(), which node:sqlite does not have. On that driver the
 * "old" form is a manual BEGIN/COMMIT reference — the same statements
 * better-sqlite3 issues — and the footer says so. Only a better-sqlite3 run
 * compares against the REAL old implementation, which is why this is also run on
 * the box.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_CONV3_SABOTAGE=1 node scripts/test_tx_conversion_batch3.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_CONV3_SABOTAGE === '1';
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const TABLES = ['storefront_config', 'retail_customers', 'retail_auth_tokens',
  'retail_customer_addresses'];

// Every column the five converted bodies write. Test 1 holds the harness to it.
const WRITTEN_COLUMNS = {
  storefront_config: ['key', 'value_json', 'updated_at', 'updated_by'],
  retail_customers: ['id', 'openid'],
  retail_auth_tokens: ['customer_id'],
  retail_customer_addresses: ['customer_id', 'recipient_name', 'phone', 'province',
    'city', 'district', 'address', 'detail', 'postal_code', 'is_default',
    'updated_at', 'lat', 'lng', 'geo_source', 'geo_precision', 'geocoded_at'],
};

const REAL_OLD = (() => {
  const db = openTablesDb(DB_SRC, ['storefront_config']);
  return typeof db.transaction === 'function';
})();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

/** Stand-in for db.transaction() on drivers that lack it — the same statements. */
function legacyTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
}
const makeOldTx = (db, fn) => (REAL_OLD ? db.transaction(fn) : legacyTransaction(db, fn));

const fresh = () => openTablesDb(DB_SRC, TABLES);

// ── SQL copied verbatim from routes/retail.js ─────────────────────────────
const UPSERT_CFG = `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`;

const INS_ADDR = `INSERT INTO retail_customer_addresses
         (customer_id, recipient_name, phone, province, city, district,
          address, detail, postal_code, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?)`;

const UPD_ADDR = `UPDATE retail_customer_addresses
          SET recipient_name = COALESCE(?, recipient_name),
              phone          = COALESCE(?, phone),
              province       = COALESCE(?, province),
              city           = COALESCE(?, city),
              district       = COALESCE(?, district),
              address        = COALESCE(?, address),
              detail         = COALESCE(?, detail),
              postal_code    = COALESCE(?, postal_code),
              is_default     = COALESCE(?, is_default),
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?`;

const CLEAR_PIN = `UPDATE retail_customer_addresses
            SET lat = NULL, lng = NULL, geo_source = NULL, geo_precision = NULL, geocoded_at = NULL
          WHERE id = ?`;

// ── fapiao-settings ───────────────────────────────────────────────────────
// `hook` injects a mid-transaction failure at the same point in both forms.
function fapiaoBody(h, b, userId, hook) {
  const upsert = h.prepare(UPSERT_CFG);
  const set = (key, val) => upsert.run(key, JSON.stringify(val), userId);
  if ('autoIssue' in b) set('fapiao.autoIssue', !!b.autoIssue);
  if ('invoiceLine' in b) set('fapiao.invoiceLine', String(b.invoiceLine || 'pc'));
  if (hook) hook();
  if ('taxRate' in b) set('fapiao.taxRate', String(b.taxRate || '0.06'));
  if ('saler' in b && b.saler && typeof b.saler === 'object') {
    set('fapiao.saler', { name: String(b.saler.name || ''), tel: String(b.saler.tel || '') });
  }
}
const fapiaoOld = (db, b, u, hook) => makeOldTx(db, () => fapiaoBody(db, b, u, hook))();
const fapiaoNew = (db, b, u, hook) => withTransaction(db, (tx) => fapiaoBody(tx, b, u, hook));

// ── reset-test ────────────────────────────────────────────────────────────
function resetBody(h, archived, id) {
  h.prepare('UPDATE retail_customers SET openid = ? WHERE id = ?').run(archived, id);
  const r = h.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(id);
  return r.changes;
}
const resetOld = (db, a, id) => makeOldTx(db, () => resetBody(db, a, id))();
const resetNew = (db, a, id) => withTransaction(db, (tx) => resetBody(tx, a, id));

// ── admin address create ──────────────────────────────────────────────────
function addrCreateBody(h, id, a, hook) {
  if (a.is_default) {
    h.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
  }
  if (hook) hook();
  const info = h.prepare(INS_ADDR).run(
    id, a.recipient_name, a.phone, a.province || null, a.city || null, a.district || null,
    a.address, a.detail || null, a.postal_code || null, a.is_default ? 1 : 0
  );
  return info.lastInsertRowid;
}
const addrCreateOld = (db, id, a, hook) => makeOldTx(db, () => addrCreateBody(db, id, a, hook))();
const addrCreateNew = (db, id, a, hook) => withTransaction(db, (tx) => addrCreateBody(tx, id, a, hook));

// ── admin address update ──────────────────────────────────────────────────
function addrUpdateBody(h, id, addrId, a, clearPin) {
  if (a.is_default) {
    h.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
  }
  h.prepare(UPD_ADDR).run(
    a.recipient_name == null ? null : String(a.recipient_name).slice(0, 60),
    a.phone == null ? null : String(a.phone).slice(0, 20),
    a.province === undefined ? null : (a.province ? String(a.province) : ''),
    a.city === undefined ? null : (a.city ? String(a.city) : ''),
    a.district === undefined ? null : (a.district ? String(a.district) : ''),
    a.address == null ? null : String(a.address).slice(0, 200),
    a.detail === undefined ? null : (a.detail ? String(a.detail) : ''),
    a.postal_code === undefined ? null : (a.postal_code ? String(a.postal_code) : ''),
    a.is_default == null ? null : (a.is_default ? 1 : 0),
    addrId
  );
  if (clearPin) h.prepare(CLEAR_PIN).run(addrId);
}
const addrUpdateOld = (db, id, ai, a, c) => makeOldTx(db, () => addrUpdateBody(db, id, ai, a, c))();
const addrUpdateNew = (db, id, ai, a, c) => withTransaction(db, (tx) => addrUpdateBody(tx, id, ai, a, c));

// ── Fixtures ──────────────────────────────────────────────────────────────
// expires_at is NOT NULL in the real retail_auth_tokens — the first draft of
// this fixture omitted it and the suite failed on the constraint, which is the
// harness doing its job: it builds the REAL table, not a convenient one.
function seedCustomer(db, id, openid) {
  db.prepare('INSERT INTO retail_customers (id, openid) VALUES (?,?)').run(id, openid);
  const ins = db.prepare(
    'INSERT INTO retail_auth_tokens (customer_id, token, expires_at) VALUES (?,?,?)'
  );
  ins.run(id, 't1-' + id, '2099-01-01 00:00:00');
  ins.run(id, 't2-' + id, '2099-01-01 00:00:00');
}
const cfgRows = (db) => db.prepare('SELECT key, value_json FROM storefront_config ORDER BY key').all();
const addrRows = (db) => db.prepare(
  'SELECT id, customer_id, recipient_name, phone, city, detail, is_default, lat, geo_source FROM retail_customer_addresses ORDER BY id'
).all();

async function main() {
  console.log(`\nTRANSACTION CONVERSION — BATCH 3 (driver: ${driver})`);
  if (SABOTAGE) console.log('  *** TX_CONV3_SABOTAGE=1 — expected values flipped, this run MUST fail ***');
  console.log('');

  console.log('[1] HARNESS COVERS EVERY COLUMN THESE ROUTES WRITE');
  console.log('    The batch 2 defect: a silently thinner table makes the rest of');
  console.log('    this file pass against a schema the real code would fail on.');
  await it('every written column exists in the harness-built schema', () => {
    const db = fresh();
    for (const [t, cols] of Object.entries(WRITTEN_COLUMNS)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
      const missing = cols.filter(c => !have.has(c));
      assert.deepStrictEqual(missing, [], `${t} is missing ${missing.join(', ')}`);
    }
  });

  console.log('\n[2] fapiao-settings — same rows, both forms');
  await it('both forms write identical config rows', () => {
    const body = { autoIssue: true, invoiceLine: 'ele', taxRate: '0.13', saler: { name: 'N', tel: 'T' } };
    const a = fresh(); fapiaoOld(a, body, 7);
    const b = fresh(); return fapiaoNew(b, body, 7).then(() => {
      const expect = SABOTAGE ? [] : cfgRows(a);
      assert.deepStrictEqual(cfgRows(b), expect);
      assert.strictEqual(cfgRows(b).length, 4);
    });
  });
  await it('a partial body writes only the keys it carries', async () => {
    const b = fresh(); await fapiaoNew(b, { taxRate: '0.06' }, 1);
    assert.deepStrictEqual(cfgRows(b).map(r => r.key), ['fapiao.taxRate']);
  });
  await it('rollback leaves NO partial config behind, both forms', async () => {
    const boom = () => { throw new Error('mid'); };
    const a = fresh();
    assert.throws(() => fapiaoOld(a, { autoIssue: true, taxRate: '1' }, 1, boom), /mid/);
    const b = fresh();
    await assert.rejects(() => fapiaoNew(b, { autoIssue: true, taxRate: '1' }, 1, boom), /mid/);
    assert.deepStrictEqual(cfgRows(a), []);
    assert.deepStrictEqual(cfgRows(b), []);
  });

  console.log('\n[3] reset-test — the RETURN value the response reports');
  await it('both forms return the same revoked-token count', async () => {
    const a = fresh(); seedCustomer(a, 5, 'wx-5');
    const b = fresh(); seedCustomer(b, 5, 'wx-5');
    const oldVal = resetOld(a, '_reset_1_wx-5', 5);
    const newVal = await resetNew(b, '_reset_1_wx-5', 5);
    assert.strictEqual(newVal, SABOTAGE ? 999 : oldVal);
    assert.strictEqual(newVal, 2);
  });
  await it('the archived openid lands and the tokens are gone', async () => {
    const b = fresh(); seedCustomer(b, 5, 'wx-5');
    await resetNew(b, '_reset_9_wx-5', 5);
    assert.strictEqual(b.prepare('SELECT openid FROM retail_customers WHERE id=5').get().openid, '_reset_9_wx-5');
    assert.strictEqual(b.prepare('SELECT COUNT(*) n FROM retail_auth_tokens WHERE customer_id=5').get().n, 0);
  });

  console.log('\n[4] admin address create — lastInsertRowid out of the body');
  const addr = { recipient_name: 'R', phone: '13800000000', province: 'P', city: 'C',
    district: 'D', address: 'A', detail: 'det', postal_code: '510000', is_default: 1 };
  await it('both forms return the same new id and write the same row', async () => {
    const a = fresh(); const b = fresh();
    const oldId = addrCreateOld(a, 3, addr);
    const newId = await addrCreateNew(b, 3, addr);
    assert.strictEqual(Number(newId), Number(oldId));
    assert.deepStrictEqual(addrRows(b), addrRows(a));
  });
  await it('is_default is cleared on the customer\'s other rows first', async () => {
    const b = fresh();
    await addrCreateNew(b, 3, addr);
    await addrCreateNew(b, 3, { ...addr, recipient_name: 'R2' });
    const rows = addrRows(b);
    assert.deepStrictEqual(rows.map(r => r.is_default), [0, 1]);
  });
  await it('a failure mid-body leaves neither the clear nor the insert', async () => {
    const b = fresh();
    await addrCreateNew(b, 3, addr);
    const before = addrRows(b);
    await assert.rejects(() => addrCreateNew(b, 3, addr, () => { throw new Error('mid'); }), /mid/);
    assert.deepStrictEqual(addrRows(b), before, 'the is_default clear must have rolled back too');
  });

  console.log('\n[5] admin address update — COALESCE partial + pin clearing');
  await it('a phone-only edit leaves every other field untouched', async () => {
    const b = fresh();
    const id = await addrCreateNew(b, 3, addr);
    await addrUpdateNew(b, 3, id, { phone: '13911111111' }, false);
    const r = addrRows(b)[0];
    assert.strictEqual(r.phone, '13911111111');
    assert.strictEqual(r.recipient_name, 'R');
    assert.strictEqual(r.city, 'C');
  });
  await it('the pin-clearing branch nulls the coordinates, both forms', async () => {
    const a = fresh(); const b = fresh();
    const ia = addrCreateOld(a, 3, addr); const ib = await addrCreateNew(b, 3, addr);
    a.prepare('UPDATE retail_customer_addresses SET lat=1.5, geo_source=? WHERE id=?').run('customer_pin', ia);
    b.prepare('UPDATE retail_customer_addresses SET lat=1.5, geo_source=? WHERE id=?').run('customer_pin', ib);
    addrUpdateOld(a, 3, ia, { address: 'NEW' }, true);
    await addrUpdateNew(b, 3, ib, { address: 'NEW' }, true);
    assert.deepStrictEqual(addrRows(b), addrRows(a));
    assert.strictEqual(addrRows(b)[0].lat, null);
    assert.strictEqual(addrRows(b)[0].geo_source, null);
  });

  console.log('\n[6] CONCURRENCY — the helper serialises these on the shared handle');
  await it('two overlapping converted transactions do not interleave', async () => {
    const db = fresh();
    const order = [];
    const one = withTransaction(db, async () => { order.push('a1'); await null; order.push('a2'); });
    const two = withTransaction(db, async () => { order.push('b1'); await null; order.push('b2'); });
    await Promise.all([one, two]);
    assert.deepStrictEqual(order, ['a1', 'a2', 'b1', 'b2']);
  });
  await it('a failing transaction does not discard a concurrent one\'s writes', async () => {
    const db = fresh();
    const bad = withTransaction(db, async (tx) => {
      tx.prepare(UPSERT_CFG).run('doomed', '1', 1); await null; throw new Error('nope');
    }).catch(() => 'caught');
    const good = withTransaction(db, async (tx) => {
      tx.prepare(UPSERT_CFG).run('kept', '1', 1);
    });
    await Promise.all([bad, good]);
    assert.deepStrictEqual(cfgRows(db).map(r => r.key), ['kept']);
  });

  console.log('');
  console.log(`  driver: ${driver}${REAL_OLD ? '' : '  (old form = manual BEGIN/COMMIT reference — this driver has no .transaction())'}`);
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
