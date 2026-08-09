#!/usr/bin/env node
/**
 * Before/after equivalence for the FIRST transaction conversion batch
 * (decisions §24, Path A step 3): saveProductOptions and fanOutBroadcast moved
 * from better-sqlite3's db.transaction() onto withTransaction.
 *
 *   node scripts/test_tx_conversion_batch1.js
 *
 * WHAT THIS PROVES, AND WHY IT IS SHAPED THIS WAY. "It still runs" is not the
 * bar. Each function is run in BOTH forms — the pre-conversion one and the
 * converted one — against the same fixtures on the same schema, and the two are
 * compared on everything observable: the return value, every row written, the
 * error object thrown and its properties, and the state left behind after a
 * failure. A conversion that changed any of those would fail here.
 *
 * THE TWO FORMS ARE COPIES OF THE REAL BODIES. routes/retail.js cannot be
 * required from a test: it opens the database at load, registers routes and
 * starts intervals. So the SQL and the control flow of each transaction body are
 * reproduced verbatim below. What the conversion did NOT touch — the option
 * sanitiser, audienceWhere, the surrounding handler logic — is not reproduced,
 * because it is byte-identical in the diff and reproducing it would only prove
 * that a copy equals itself.
 *
 * THE SCHEMA IS THE REAL ONE, rebuilt from database.js by the shared harness,
 * including the bolted-on columns these two functions actually write
 * (retail_product_option_choices.stock_product_id, retail_notifications
 * .broadcast_id). A hand-written CREATE would go stale exactly the way the
 * copies in scripts/test_address_pin.js did.
 *
 * ONE DRIVER LIMITATION, STATED RATHER THAN HIDDEN. The pre-conversion form
 * calls db.transaction(), which node:sqlite does not have. On that driver the
 * "old" form is a manual BEGIN/COMMIT reference — the same statements
 * better-sqlite3 issues — and the run says so. Only a better-sqlite3 run
 * compares against the REAL old implementation, which is why this suite is run
 * on the box as well.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_CONV_SABOTAGE=1 node scripts/test_tx_conversion_batch1.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, driver } = require('./test-support/memory-db');
const { withTransaction } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_CONV_SABOTAGE === '1';
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8');
const TABLES = ['retail_product_options', 'retail_product_option_choices',
  'retail_notifications', 'retail_broadcasts'];

// Whether the pre-conversion form can be run for real on this driver.
const REAL_OLD = (() => {
  const db = openTablesDb(DB_SRC, ['retail_broadcasts']);
  return typeof db.transaction === 'function';
})();

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// A stand-in for better-sqlite3's db.transaction() on drivers that lack it —
// the same BEGIN/COMMIT/ROLLBACK it issues, so the "old" column of the
// comparison still means something on node:sqlite.
function legacyTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
}
const makeOldTx = (db, fn) =>
  (REAL_OLD ? db.transaction(fn) : legacyTransaction(db, fn));

// ── saveProductOptions — SQL copied from routes/retail.js ─────────────────
const DEL_CHOICES = `DELETE FROM retail_product_option_choices
        WHERE option_id IN (SELECT id FROM retail_product_options WHERE product_id = ?)`;
const DEL_OPTS = 'DELETE FROM retail_product_options WHERE product_id = ?';
const INS_OPT = `INSERT INTO retail_product_options (product_id, question_en, question_cn, type, is_required, sort_order)
       VALUES (?,?,?,?,?,?)`;
const INS_CHOICE = `INSERT INTO retail_product_option_choices (option_id, label_en, label_cn, price_delta, is_default, stock_product_id, sort_order)
       VALUES (?,?,?,?,?,?,?)`;

// `hook` fires once per option, letting a test inject a mid-transaction failure
// at exactly the same point in both forms. Not part of the real function.
function saveProductOptionsOld(db, productId, clean, hook) {
  const tx = makeOldTx(db, () => {
    db.prepare(DEL_CHOICES).run(productId);
    db.prepare(DEL_OPTS).run(productId);
    const insOpt = db.prepare(INS_OPT);
    const insChoice = db.prepare(INS_CHOICE);
    clean.forEach((o, oi) => {
      if (hook) hook(oi);
      const optId = insOpt.run(productId, o.question_en, o.question_cn || null, o.type, o.is_required, oi).lastInsertRowid;
      o.choices.forEach((c, ci) => insChoice.run(optId, c.label_en, c.label_cn || null, c.price_delta, c.is_default, c.stock_product_id, ci));
    });
  });
  return tx();
}

async function saveProductOptionsNew(db, productId, clean, hook) {
  return withTransaction(db, (tx) => {
    tx.prepare(DEL_CHOICES).run(productId);
    tx.prepare(DEL_OPTS).run(productId);
    const insOpt = tx.prepare(INS_OPT);
    const insChoice = tx.prepare(INS_CHOICE);
    clean.forEach((o, oi) => {
      if (hook) hook(oi);
      const optId = insOpt.run(productId, o.question_en, o.question_cn || null, o.type, o.is_required, oi).lastInsertRowid;
      o.choices.forEach((c, ci) => insChoice.run(optId, c.label_en, c.label_cn || null, c.price_delta, c.is_default, c.stock_product_id, ci));
    });
  });
}

// ── fanOutBroadcast — SQL copied from routes/retail.js ────────────────────
const INS_NOTIF = `INSERT INTO retail_notifications
         (customer_id, category, type, title_en, title_cn, body_en, body_cn,
          ref_type, ref_id, broadcast_id)
       VALUES (?, 'broadcast', 'announcement', ?, ?, ?, ?, ?, ?, ?)`;
const MARK_SENT = `UPDATE retail_broadcasts
        SET status = 'sent', sent_at = CURRENT_TIMESTAMP, recipient_count = ?
      WHERE id = ?`;

function fanOutBroadcastOld(db_, brd, customers, hook) {
  const insert = db_.prepare(INS_NOTIF);
  const refType = brd.deeplink ? 'deeplink' : null;
  const refId = brd.deeplink || null;
  const txn = makeOldTx(db_, (rows) => {
    for (const c of rows) {
      if (hook) hook(c);
      insert.run(c.id, brd.title_en || '', brd.title_cn || '',
        brd.body_en || null, brd.body_cn || null, refType, refId, brd.id);
    }
  });
  txn(customers);
  db_.prepare(MARK_SENT).run(customers.length, brd.id);
  return customers.length;
}

async function fanOutBroadcastNew(db_, brd, customers, hook) {
  const refType = brd.deeplink ? 'deeplink' : null;
  const refId = brd.deeplink || null;
  await withTransaction(db_, (tx) => {
    const insert = tx.prepare(INS_NOTIF);
    for (const c of customers) {
      if (hook) hook(c);
      insert.run(c.id, brd.title_en || '', brd.title_cn || '',
        brd.body_en || null, brd.body_cn || null, refType, refId, brd.id);
    }
  });
  db_.prepare(MARK_SENT).run(customers.length, brd.id);
  return customers.length;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const freshDb = () => openTablesDb(DB_SRC, TABLES);
const OPTIONS = [
  { question_en: 'Spice level', question_cn: '辣度', type: 'single', is_required: 1,
    choices: [
      { label_en: 'Mild', label_cn: '微辣', price_delta: 0, is_default: 1, stock_product_id: null },
      { label_en: 'Hot', label_cn: '重辣', price_delta: 2.5, is_default: 0, stock_product_id: 77 },
    ] },
  { question_en: 'Add tofu', question_cn: '加豆腐', type: 'multi', is_required: 0,
    choices: [{ label_en: 'Yes', label_cn: '要', price_delta: 4, is_default: 0, stock_product_id: 88 }] },
];
const BRD = { id: 1, title_en: 'Store closed', title_cn: '停业', body_en: 'Back Monday',
  body_cn: '周一见', deeplink: '/pages/shop/shop' };
const CUSTOMERS = [{ id: 11 }, { id: 12 }, { id: 13 }];

// Everything observable about the two option tables, ids excluded (autoincrement
// values differ between a run that rolled back and one that did not, and they
// are not part of the behaviour under test).
const optionState = (db) => ({
  options: db.prepare(
    'SELECT product_id, question_en, question_cn, type, is_required, sort_order FROM retail_product_options ORDER BY sort_order'
  ).all(),
  choices: db.prepare(
    `SELECT c.label_en, c.label_cn, c.price_delta, c.is_default, c.stock_product_id, c.sort_order
       FROM retail_product_option_choices c
       JOIN retail_product_options o ON o.id = c.option_id
      ORDER BY o.sort_order, c.sort_order`
  ).all(),
});
const notifState = (db) => db.prepare(
  `SELECT customer_id, category, type, title_en, title_cn, body_en, body_cn, ref_type, ref_id, broadcast_id
     FROM retail_notifications ORDER BY customer_id`
).all();
const broadcastState = (db) => db.prepare(
  'SELECT id, status, recipient_count FROM retail_broadcasts ORDER BY id'
).all();
const seedBroadcast = (db) => db.prepare(
  "INSERT INTO retail_broadcasts (id, title_en, audience, status) VALUES (1, 'Store closed', 'all_active', 'scheduled')"
).run();

(async () => {

console.log(`\ntx conversion batch 1 — driver: ${driver}` +
  `   old-form: ${REAL_OLD ? 'REAL db.transaction()' : 'manual BEGIN/COMMIT reference'}` +
  `${SABOTAGE ? '   [SABOTAGE ON]' : ''}\n`);

// ─────────────────────────────────────────────────────────────────────────
console.log('saveProductOptions — before/after equivalence');

await it('same rows written', async () => {
  const a = freshDb(), b = freshDb();
  saveProductOptionsOld(a, 42, OPTIONS);
  await saveProductOptionsNew(b, 42, OPTIONS);
  const before = optionState(a), after = optionState(b);
  assert.deepStrictEqual(after, before, 'converted form wrote different rows');
  assert.strictEqual(before.options.length, 2);
  assert.strictEqual(before.choices.length, 3);
  // The bolted-on column is genuinely exercised, not silently NULL throughout.
  assert.deepStrictEqual(after.choices.map(c => c.stock_product_id), [null, 77, 88]);
});

await it('same return value (both undefined — it returns nothing)', async () => {
  const a = freshDb(), b = freshDb();
  const ra = saveProductOptionsOld(a, 42, OPTIONS);
  const rb = await saveProductOptionsNew(b, 42, OPTIONS);
  assert.strictEqual(rb, ra);
  assert.strictEqual(rb, undefined);
});

await it('replace-all is idempotent — running twice equals running once', async () => {
  const a = freshDb(), b = freshDb();
  saveProductOptionsOld(a, 42, OPTIONS);
  await saveProductOptionsNew(b, 42, OPTIONS);
  await saveProductOptionsNew(b, 42, OPTIONS);      // re-run
  assert.deepStrictEqual(optionState(b), optionState(a),
    're-running the converted form must not duplicate or drop rows');
});

await it('same error object, same properties, on a mid-transaction failure', async () => {
  const a = freshDb(), b = freshDb();
  const boom = () => { const e = new Error('option write failed'); e.code = 'OPT_WRITE'; e.product_id = 42; e.available = 7; throw e; };
  const hook = (oi) => { if (oi === 1) boom(); };
  let ea = null, eb = null;
  try { saveProductOptionsOld(a, 42, OPTIONS, hook); } catch (e) { ea = e; }
  try { await saveProductOptionsNew(b, 42, OPTIONS, hook); } catch (e) { eb = e; }
  assert.ok(ea && eb, 'both forms must throw');
  assert.strictEqual(eb.message, ea.message);
  assert.strictEqual(eb.code, ea.code, 'e.code must survive');
  assert.strictEqual(eb.product_id, ea.product_id, 'e.product_id must survive');
  assert.strictEqual(eb.available, ea.available, 'e.available must survive');
  assert.ok(eb instanceof Error);
});

await it('ROLLBACK: a failure mid-write discards EVERYTHING, both forms', async () => {
  // The dangerous shape: the DELETEs have already run when the failure hits, so
  // a transaction that did not roll back would leave the product with NO
  // options at all. This is the assertion that matters most for this function.
  const a = freshDb(), b = freshDb();
  saveProductOptionsOld(a, 42, OPTIONS);            // pre-existing saved state
  await saveProductOptionsNew(b, 42, OPTIONS);
  const preA = optionState(a), preB = optionState(b);

  const hook = (oi) => { if (oi === 1) throw new Error('half way'); };
  try { saveProductOptionsOld(a, 42, [OPTIONS[0], OPTIONS[1]], hook); } catch { /* expected */ }
  try { await saveProductOptionsNew(b, 42, [OPTIONS[0], OPTIONS[1]], hook); } catch { /* expected */ }

  assert.deepStrictEqual(optionState(a), preA, 'old form must be unchanged');
  const expected = SABOTAGE ? { options: [], choices: [] } : preB;
  assert.deepStrictEqual(optionState(b), expected,
    'converted form must leave the previously-saved options intact');
  assert.strictEqual(optionState(b).options.length, SABOTAGE ? 0 : 2);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nfanOutBroadcast — before/after equivalence');

await it('same rows written and same return value', async () => {
  const a = freshDb(), b = freshDb();
  seedBroadcast(a); seedBroadcast(b);
  const ra = fanOutBroadcastOld(a, BRD, CUSTOMERS);
  const rb = await fanOutBroadcastNew(b, BRD, CUSTOMERS);
  assert.strictEqual(rb, ra, 'recipient count must match');
  assert.strictEqual(rb, 3);
  assert.deepStrictEqual(notifState(b), notifState(a), 'notification rows must match');
  assert.strictEqual(notifState(b).length, 3);
  assert.strictEqual(notifState(b)[0].broadcast_id, 1, 'the bolted-on column must be written');
  assert.strictEqual(notifState(b)[0].ref_type, 'deeplink');
});

await it('the status UPDATE outside the transaction still runs, identically', async () => {
  const a = freshDb(), b = freshDb();
  seedBroadcast(a); seedBroadcast(b);
  fanOutBroadcastOld(a, BRD, CUSTOMERS);
  await fanOutBroadcastNew(b, BRD, CUSTOMERS);
  assert.deepStrictEqual(broadcastState(b), broadcastState(a));
  assert.strictEqual(broadcastState(b)[0].status, 'sent');
  assert.strictEqual(broadcastState(b)[0].recipient_count, 3);
});

await it('a null-deeplink broadcast produces identical NULL ref columns', async () => {
  const a = freshDb(), b = freshDb();
  seedBroadcast(a); seedBroadcast(b);
  const plain = { ...BRD, deeplink: null, body_en: null, body_cn: null };
  fanOutBroadcastOld(a, plain, CUSTOMERS);
  await fanOutBroadcastNew(b, plain, CUSTOMERS);
  assert.deepStrictEqual(notifState(b), notifState(a));
  assert.strictEqual(notifState(b)[0].ref_type, null);
  assert.strictEqual(notifState(b)[0].ref_id, null);
});

await it('ROLLBACK: a failure part-way sends NOBODY, both forms', async () => {
  // Partial fanout is the failure that matters here: some customers notified,
  // the broadcast still 'scheduled', and the next scheduler tick notifies them
  // AGAIN. Rollback is what stops that.
  const a = freshDb(), b = freshDb();
  seedBroadcast(a); seedBroadcast(b);
  const hook = (c) => { if (c.id === 13) { const e = new Error('fanout failed'); e.code = 'FANOUT'; throw e; } };
  let ea = null, eb = null;
  try { fanOutBroadcastOld(a, BRD, CUSTOMERS, hook); } catch (e) { ea = e; }
  try { await fanOutBroadcastNew(b, BRD, CUSTOMERS, hook); } catch (e) { eb = e; }
  assert.ok(ea && eb, 'both must throw');
  assert.strictEqual(eb.code, ea.code);
  assert.deepStrictEqual(notifState(b), notifState(a));
  assert.deepStrictEqual(notifState(b), [], 'no partial notifications may survive');
  // And the broadcast is still 'scheduled' — the UPDATE never ran, both forms.
  assert.deepStrictEqual(broadcastState(b), broadcastState(a));
  assert.strictEqual(broadcastState(b)[0].status, 'scheduled');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nconcurrency — the paths these conversions newly expose');

await it('two fanOutBroadcast calls on ONE handle do not interleave', async () => {
  // Newly reachable: POST /api/retail-admin/broadcasts (now async) and the 60s
  // tickBroadcastScheduler can now both be mid-transaction on the same tenant
  // handle. Without the helper's serialisation the second BEGIN would land
  // inside the first transaction and one ROLLBACK would discard both fanouts.
  const db = freshDb();
  db.prepare("INSERT INTO retail_broadcasts (id, title_en, audience, status) VALUES (1,'A','all_active','scheduled')").run();
  db.prepare("INSERT INTO retail_broadcasts (id, title_en, audience, status) VALUES (2,'B','all_active','scheduled')").run();
  const order = [];
  const slow = withTransaction(db, async (tx) => {
    order.push('scheduler:begin');
    tx.prepare(INS_NOTIF).run(11, 'A', 'A', null, null, null, null, 1);
    await new Promise(r => setTimeout(r, 20));
    order.push('scheduler:end');
  });
  const fast = withTransaction(db, async (tx) => {
    order.push('admin:begin');
    tx.prepare(INS_NOTIF).run(12, 'B', 'B', null, null, null, null, 2);
    order.push('admin:end');
  });
  await Promise.all([slow, fast]);
  assert.deepStrictEqual(order, ['scheduler:begin', 'scheduler:end', 'admin:begin', 'admin:end'],
    'the second transaction must wait for the first to finish');
  assert.strictEqual(notifState(db).length, 2, 'both fanouts must survive');
});

await it('a failing concurrent transaction does not discard the other\'s writes', async () => {
  const db = freshDb();
  const good = withTransaction(db, async (tx) => {
    tx.prepare(INS_NOTIF).run(11, 'A', 'A', null, null, null, null, 1);
    await new Promise(r => setTimeout(r, 10));
  });
  const bad = withTransaction(db, async (tx) => {
    tx.prepare(INS_NOTIF).run(12, 'B', 'B', null, null, null, null, 2);
    throw new Error('this one fails');
  }).catch(() => 'caught');
  await good;
  assert.strictEqual(await bad, 'caught');
  const rows = notifState(db);
  assert.strictEqual(rows.length, 1, 'the failing transaction must not take the good one with it');
  assert.strictEqual(rows[0].customer_id, 11);
});

console.log(`\n${pass} passed, ${fail} failed   [driver: ${driver}, old-form: ${REAL_OLD ? 'real' : 'reference'}]\n`);
process.exit(fail ? 1 : 0);

})();
