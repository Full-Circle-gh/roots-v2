#!/usr/bin/env node
/**
 * §101 — the night's orders raise their own kitchen request in the morning.
 *
 *   node scripts/test_kitchen_morning_request.js
 *
 * THE GAP THIS CLOSES. §84 computes what the batch owes and draws it above the
 * kitchen queue's "To make" tab. §51 and §71 built the push, the printed slip,
 * the deep link and the card that closes a line — and every one of those keys
 * on a `restock_orders` row, which a night of `awaiting_restock` pre-orders
 * never creates. So the number existed in exactly one place, behind a tap
 * nobody is prompted to make. Ash: "we need it to be push, print".
 *
 * WHAT IS ACTUALLY BEING PROTECTED, because "a request is raised" is the easy
 * half and any change would pass a suite that only asserted it:
 *
 *   • IT IS RAISED ONCE. The guard is a database read (`auto_source` + `date`),
 *     not a file latch, precisely so a restart or a second app server cannot
 *     raise a second one — and a duplicate here is a tray of food, not a
 *     duplicated advisory. A change to a file latch still passes "it is
 *     raised"; it fails the restart case below.
 *   • IT CATCHES UP AND THEN STOPS. A box down at 06:00 must still print at
 *     07:10; an order at 15:00 must not raise a surprise request for tomorrow.
 *     Both edges are cases, and so is the midnight clamp.
 *   • THE LINES ARE SHAPED LIKE EVERY OTHER KITCHEN REQUEST — SKU and names,
 *     no `product_id` — because §61 ticks a line off by matching SKU first and
 *     name second. A line carrying an id that derivation does not read looks
 *     identical on screen and silently fails to close.
 *   • THE DERIVATION RUNS ONE WAY. `lib/batch-owed.js` stays a stock question.
 *
 * Runs against the real sqlite database (data/roots.db, created by database.js
 * on require and gitignored) with seeded rows, the same arrangement as
 * test_batch_owed.js, whose fixture shape this borrows.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const morning = require(path.join(ROOT, 'lib', 'kitchen-morning-request.js'));

const db = tdb();

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const section = (t) => console.log('\n' + t);

// ── Fixtures ───────────────────────────────────────────────────────────────
// High ids so a dev database's own rows are never touched.
const STORE_A = 9421;
const STORE_B = 9422;
const P_WRAP  = 9521;   // batch-made — the kitchen cooks this
const P_BOWL  = 9522;   // batch-made
const P_OIL   = 9523;   // NOT batch-made — a debt here is the warehouse's
const ORDER   = 9621;

// A clock we own, in a zone we name, so no case depends on the hour the suite
// is run at. Far enough out that its `date` cannot collide with a real row's.
const TZ = 'Asia/Shanghai';
const DAY = '2031-03-04';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+08:00`);

// The number generator is INJECTED in production (§80's copy rule) and is
// stubbed here: this suite is about what gets raised, not about the sequence,
// and a stub keeps it from minting real PR numbers in a dev database. That
// routes/restock.js passes its own is asserted by source in section 8.
const RS = 'PR-TEST101-001';
const genRsNumber = () => RS;

function setStock(storeId, productId, qty) {
  db.prepare(
    `INSERT INTO retail_store_stock (store_id, product_id, physical_qty, safety_buffer)
     VALUES (?,?,?,0)
       ON CONFLICT(store_id, product_id) DO UPDATE SET physical_qty = excluded.physical_qty`
  ).run(storeId, productId, qty);
}

function park(orderId, storeId, lines, status = 'awaiting_restock') {
  db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(orderId);
  db.prepare('DELETE FROM retail_orders WHERE id = ?').run(orderId);
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, store_id, status, channel, subtotal, total)
     VALUES (?,?,?,?,'wechat',0,0)`
  ).run(orderId, `TM${orderId}`, storeId, status);
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,?,?,?,0,0)`
  );
  for (const l of lines) ins.run(orderId, l.product_id, 'x', 'x', l.qty);
}

function setHour(v) {
  if (v === undefined) {
    db.prepare("DELETE FROM storefront_config WHERE key = 'fresh.morningRequestHour'").run();
    return;
  }
  db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at)
     VALUES ('fresh.morningRequestHour', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify(v));
}

// Every request this suite has raised, however it was raised.
function raised() {
  return db.prepare(
    `SELECT * FROM restock_orders WHERE auto_source = ? AND date = ?`
  ).all(morning.AUTO_SOURCE, DAY);
}
function linesOf(id) {
  return db.prepare('SELECT * FROM restock_items WHERE restock_id = ? ORDER BY id').all(id);
}

function clearRaised() {
  const ids = db.prepare('SELECT id FROM restock_orders WHERE auto_source = ? AND date = ?')
    .all(morning.AUTO_SOURCE, DAY).map((r) => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM restock_items WHERE restock_id = ?').run(id);
    db.prepare('DELETE FROM restock_orders WHERE id = ?').run(id);
  }
}

function clearOwed() {
  db.prepare('DELETE FROM retail_order_items WHERE order_id IN (?,?)').run(ORDER, ORDER + 1);
  db.prepare('DELETE FROM retail_orders WHERE id IN (?,?)').run(ORDER, ORDER + 1);
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?,?)')
    .run(P_WRAP, P_BOWL, P_OIL);
}

function clearAll() { clearRaised(); clearOwed(); }

function seed() {
  clearAll();
  db.prepare('DELETE FROM store_products WHERE id IN (?,?,?)').run(P_WRAP, P_BOWL, P_OIL);
  // SKUs are UNIQUE across the catalogue and this suite shares a dev database
  // with every other one, so a half-torn-down run cannot fail the next one.
  db.prepare("DELETE FROM store_products WHERE sku IN ('9-521','9-522','9-523')").run();
  db.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE_A, STORE_B);
  const store = db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,1)`
  );
  store.run(STORE_A, 'tkm-a', 'Tianhe', '天河', '广州市', '天河区');
  store.run(STORE_B, 'tkm-b', 'Yuexiu', '越秀', '广州市', '越秀区');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made,
                                 is_published, is_active)
     VALUES (?,?,?,?,?,?,1,1)`
  );
  prod.run(P_WRAP, 'Pesto Wrap', '青酱卷', '9-521', 48, 1);
  prod.run(P_BOWL, 'Beef Bowl',  '牛肉饭', '9-522', 58, 1);
  prod.run(P_OIL,  'Olive Oil',  '橄榄油', '9-523', 88, 0);
}

seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the owed night, end to end');
{
  it('eighteen wraps parked overnight become one kitchen request', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 18 }]);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    assert.ok(res && res.id, 'a request was raised: ' + JSON.stringify(res));
    const rows = raised();
    assert.strictEqual(rows.length, 1);
    const o = rows[0];
    assert.strictEqual(o.rs_number, RS);
    assert.strictEqual(o.status, 'sent', 'sent is what makes the push and the slip fire');
    assert.strictEqual(o.to_role, 'kitchen');
    assert.strictEqual(o.from_role, 'warehouse');
    assert.strictEqual(o.date, DAY);
    assert.ok(o.sent_at, 'a queue row with no sent_at reads as undated on both tabs (§71)');
  });

  it("purpose is 'order', so the slip and the queue already have words for it", () => {
    // §65's own value. The slip prints "For an order · 用于发货" and the queue's
    // chip says the same; nothing was minted for this row.
    assert.strictEqual(raised()[0].purpose, 'order');
  });

  it('the note is §84\'s own live pair, not a composed sentence', () => {
    assert.strictEqual(raised()[0].notes, 'Customer orders waiting · 有客户订单等待');
    assert.strictEqual(morning.NOTE, 'Customer orders waiting · 有客户订单等待');
  });

  it('it carries no locations at all, like every kitchen request (§51)', () => {
    const o = raised()[0];
    assert.strictEqual(o.from_store_id, null);
    assert.strictEqual(o.to_store_id, null);
    assert.strictEqual(o.store_name, null);
  });

  it('created_by is NULL and auto_source says why', () => {
    const o = raised()[0];
    assert.strictEqual(o.created_by, null, 'no person raised it');
    assert.strictEqual(o.auto_source, 'morning_owed');
  });

  it('the line says eighteen, and carries the SKU §61 ticks it off by', () => {
    const lines = linesOf(raised()[0].id);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].qty_requested, 18);
    assert.strictEqual(lines[0].sku, '9-521');
    assert.strictEqual(lines[0].product_name, 'Pesto Wrap');
    assert.strictEqual(lines[0].product_cn, '青酱卷');
    assert.strictEqual(lines[0].unit, 'pcs', "the phone's own picker sends pcs");
  });

  it('and NO product_id — the shape every live kitchen request has (§61)', () => {
    // rqItems() in public/m.html sends product_id:null, and _attachRecorded
    // matches SKU-then-name. A line carrying an id looks identical and never
    // ticks off.
    assert.strictEqual(linesOf(raised()[0].id)[0].product_id, null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · once a day, and the guard survives a restart');
{
  it('a second call the same morning raises nothing', () => {
    const before = raised().length;
    const res = morning.raiseMorningRequest(db, { now: at('06:31'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'already_raised');
    assert.strictEqual(raised().length, before, 'still one request');
  });

  it('nor does one an hour later, still inside the window', () => {
    const res = morning.raiseMorningRequest(db, { now: at('08:00'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'already_raised');
    assert.strictEqual(raised().length, 1);
  });

  it('THE GUARD IS THE DATABASE — a fresh require raises nothing either', () => {
    // A restart, a redeploy, a second app server. lib/alert-latch's claimWindow
    // would have forgotten and raised a second tray of food; this reads the row.
    delete require.cache[require.resolve(path.join(ROOT, 'lib', 'kitchen-morning-request.js'))];
    const reloaded = require(path.join(ROOT, 'lib', 'kitchen-morning-request.js'));
    const res = reloaded.raiseMorningRequest(db, { now: at('06:45'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'already_raised');
    assert.strictEqual(raised().length, 1);
  });

  it('and it holds no file latch to forget', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/kitchen-morning-request.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/alert-latch/.test(src),
      'a per-box file latch cannot guard a row somebody cooks from');
    assert.ok(/auto_source = \? AND date = \?/.test(src), 'the guard is the row');
  });

  it('a read fault answers "already raised" rather than raising a duplicate', () => {
    // Not raising is recoverable tomorrow; a duplicate is a tray of food.
    const broken = { prepare() { throw new Error('no such table'); } };
    assert.strictEqual(morning.alreadyRaisedToday(broken, DAY), true);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · the catch-up window, both edges and the midnight clamp');
{
  it('before the hour: nothing', () => {
    assert.strictEqual(morning.inWindow(6, 5), false);
  });
  it('on the hour: yes', () => {
    assert.strictEqual(morning.inWindow(6, 6), true);
  });
  it('two hours late, a box that was down at 06:00 still prints', () => {
    assert.strictEqual(morning.inWindow(6, 8), true);
  });
  it('three hours late, the window has shut', () => {
    assert.strictEqual(morning.inWindow(6, 9), false,
      'an order at 15:00 must not raise a surprise request for tomorrow');
  });
  it('it never crosses midnight — the date the guard reads would roll with it', () => {
    assert.strictEqual(morning.inWindow(22, 22), true);
    assert.strictEqual(morning.inWindow(22, 23), true);
    assert.strictEqual(morning.inWindow(22, 0), false);
    assert.strictEqual(morning.inWindow(22, 1), false);
  });
  it('the clock is the TENANT\'s, not the host\'s', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 4 }]);
    // 23:30 UTC is 07:30 the next day in Shanghai — inside the window there,
    // outside it on a UTC host.
    const res = morning.raiseMorningRequest(
      db, { now: new Date('2031-03-03T23:30:00Z'), tz: TZ, genRsNumber });
    assert.ok(res.id, 'raised on the shop clock: ' + JSON.stringify(res));
    assert.strictEqual(raised()[0].date, DAY, 'dated the shop\'s day, not the host\'s');
  });
  it('outside the window it says so and writes nothing', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 4 }]);
    const res = morning.raiseMorningRequest(db, { now: at('15:00'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'not_due');
    assert.strictEqual(raised().length, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · the hour is the tenant\'s, and blank means off');
{
  it('a key nobody has written is 06:00, not off', () => {
    setHour(undefined);
    assert.strictEqual(morning.configuredHour(db), 6);
    assert.strictEqual(morning.DEFAULT_HOUR, 6);
  });
  it('blank is OFF, and is not the same fact as absent', () => {
    setHour('');
    assert.strictEqual(morning.configuredHour(db), null);
  });
  it('off raises nothing even on a morning that owes', () => {
    clearAll(); setHour('');
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 9 }]);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'off');
    assert.strictEqual(raised().length, 0);
  });
  it('a typed hour is honoured', () => {
    clearAll(); setHour(5);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 9 }]);
    assert.strictEqual(morning.raiseMorningRequest(
      db, { now: at('04:59'), tz: TZ, genRsNumber }).skipped, 'not_due');
    assert.ok(morning.raiseMorningRequest(db, { now: at('05:00'), tz: TZ, genRsNumber }).id);
  });
  it('an out-of-range or junk hour is OFF, never coerced to midnight', () => {
    setHour(26);  assert.strictEqual(morning.configuredHour(db), null);
    setHour(-1);  assert.strictEqual(morning.configuredHour(db), null);
    setHour('x'); assert.strictEqual(morning.configuredHour(db), null);
  });
  it('a read fault is OFF — an un-migrated account raises nothing', () => {
    const broken = { prepare() { throw new Error('no such table: storefront_config'); } };
    assert.strictEqual(morning.configuredHour(broken), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · nothing owed raises nothing');
{
  it('a healthy shelf and no parked orders: no request, and no empty one', () => {
    clearAll(); setHour(6);
    setStock(STORE_A, P_WRAP, 40);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    assert.strictEqual(res.skipped, 'nothing_owed');
    assert.strictEqual(raised().length, 0,
      'a request with no lines is a slip nobody can file');
  });
  it('a PAID order is not a debt — it took its stock at commit', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 12 }], 'paid');
    assert.strictEqual(
      morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber }).skipped,
      'nothing_owed');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · what the lines are, and what they are not');
{
  it('summed per PRODUCT across shops — a request has nowhere to put a shop', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 18 }]);
    setStock(STORE_B, P_WRAP, -7);   // oversold on a platform at the other shop
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    const lines = linesOf(res.id);
    assert.strictEqual(lines.length, 1, 'one pile of wraps, not one per shop');
    assert.strictEqual(lines[0].qty_requested, 25);
  });

  it('a product the kitchen does not make is not on it', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [
      { product_id: P_WRAP, qty: 3 },
      { product_id: P_OIL,  qty: 5 },
    ]);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    const lines = linesOf(res.id);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].sku, '9-521', 'olive oil is the warehouse\'s problem');
  });

  it('heaviest first — the biggest number decides how the morning is spent', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [
      { product_id: P_WRAP, qty: 4 },
      { product_id: P_BOWL, qty: 31 },
    ]);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    const lines = linesOf(res.id);
    assert.deepStrictEqual(lines.map((l) => l.qty_requested), [31, 4]);
  });

  it('a fractional debt rounds UP, never down onto a paid customer', () => {
    clearAll(); setHour(6);
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 2.4 }]);
    const res = morning.raiseMorningRequest(db, { now: at('06:30'), tz: TZ, genRsNumber });
    assert.strictEqual(linesOf(res.id)[0].qty_requested, 3);
  });

  it('owedLines is readable on its own and writes nothing', () => {
    clearAll();
    park(ORDER, STORE_A, [{ product_id: P_WRAP, qty: 6 }]);
    const lines = morning.owedLines(db);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].qty_requested, 6);
    assert.strictEqual(raised().length, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · the derivation runs one way — §84 is not taught anything');
{
  it('lib/batch-owed.js learns no request vocabulary', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/batch-owed.js'), 'utf8');
    assert.ok(!/restock_orders|restock_items|auto_source/.test(src),
      'owed is a stock question; §101 derives from it and never feeds back');
  });
  it('and still no cadence, per §84\'s own rule', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/batch-owed.js'), 'utf8');
    assert.ok(!/batch-cadence|nextBatchDate|cutoff_hour/.test(src));
  });
  it('§101 does not reach into a router either', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/kitchen-morning-request.js'), 'utf8');
    assert.ok(!/require\(['"]\.\.\/routes/.test(src),
      'the number generator and the side effects are injected, not required');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · the wiring: the same push, broadcast and printer, and no new ones');
{
  const rs = fs.readFileSync(path.join(ROOT, 'routes/restock.js'), 'utf8');

  it('the sweeper is started and given the file\'s OWN number generator (§80)', () => {
    assert.ok(/startMorningKitchenRequestSweeper\(\{\s*\n?\s*genRsNumber,/.test(rs),
      'a second per-prefix sequence is how two requests become PR-…-002');
  });
  it('it fires the same three side effects POST /api/restock fires', () => {
    const m = rs.match(/onRaised:[\s\S]{0,400}?\n  \},/);
    assert.ok(m, 'onRaised is wired');
    const body = m[0];
    assert.ok(/_fireRestockPush\(id, 'sent', null\)/.test(body), 'push');
    assert.ok(/_broadcastRestock\(id, 'sent', null\)/.test(body), 'broadcast');
    assert.ok(/_kprint\.autoPrintKitchenRequest\(id, 'sent'\)/.test(body), 'printer');
  });
  it('the actor is null — there is nobody to leave out of the audience', () => {
    assert.ok(!/onRaised[\s\S]{0,400}?_fireRestockPush\(id, 'sent', req/.test(rs));
  });
  it('no new push channel and no second printer were introduced', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/kitchen-morning-request.js'), 'utf8');
    assert.ok(!/sendPush|subscribeMessage|feie|printContent/i.test(src),
      '§51 owns the printer and §71 owns the audience; this raises a row');
  });
  it('the side effects run inside the tenant\'s scope, not the main handle', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/kitchen-morning-request.js'), 'utf8');
    assert.ok(/tenantAls\.run\(rawTenantDb\(id\), \(\) => sweepScope/.test(src),
      'tdb() in a bare timer answers the MAIN db — tenant 7 would print from Roots');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · the settings string is byte-identical to its declaration');
{
  // docs/tacet-delivery-vocabulary.md is the lock (CLAUDE.md, Rule 4). A pair
  // declared there and shipped a character different is the failure mode that
  // makes the document stop being one.
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  const vocab = fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');

  it('the label is declared, and identically', () => {
    const label = 'Morning request hour · 厨房制作请求时间';
    assert.ok(html.includes(label), 'shipped');
    assert.ok(vocab.includes('| the settings row\'s label | Morning request hour | 厨房制作请求时间 |'),
      'declared');
  });
  it('the description is declared, and identically', () => {
    const cn = '每天一张厨房制作请求,数量取自有客户订单等待的商品,与其他制作请求一样推送并打印。留空则关闭。';
    assert.ok(html.includes(cn), 'shipped in the settings row');
    assert.ok(vocab.includes(cn), 'declared in the vocabulary');
  });
  it('the half-width comma is the one shipped, matching the file it sits in', () => {
    assert.ok(!html.includes('每天一张厨房制作请求，'), 'full-width would be a silent divergence');
  });
  it('§101 is recorded in the decisions file before the code that depends on it', () => {
    const dec = fs.readFileSync(path.join(ROOT, 'docs/tacet-consolidation-decisions.md'), 'utf8');
    assert.ok(/## §101 — THE NIGHT'S ORDERS RAISE THEIR OWN KITCHEN REQUEST/.test(dec));
    assert.ok(/fresh\.morningRequestHour/.test(dec), 'the config key is named in the record');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('10 · the settings row loads and saves');
{
  const js = fs.readFileSync(path.join(ROOT, 'public/retail-admin/06-delivery.js'), 'utf8');

  it('an unwritten key paints 6 rather than reading as off', () => {
    assert.ok(/fresh\.morningRequestHour === undefined\)\s*\n?\s*\? 6/.test(js),
      'a card nobody has opened must not say the feature is off');
  });
  it('blank saves as blank — the off switch survives a Save', () => {
    assert.ok(/'fresh\.morningRequestHour': rawMorning === '' \? '' : parseInt\(rawMorning, 10\)/.test(js));
  });
  it('an out-of-range hour is refused, not coerced', () => {
    assert.ok(/rawMorning[\s\S]{0,300}?m < 0 \|\| m > 23[\s\S]{0,120}?toast\(/.test(js),
      'an operator who means 6 and types 26 is told, not given 2am');
  });
}

// ── Teardown ───────────────────────────────────────────────────────────────
clearAll();
setHour(undefined);
db.prepare('DELETE FROM store_products WHERE id IN (?,?,?)').run(P_WRAP, P_BOWL, P_OIL);
db.prepare('DELETE FROM retail_stores WHERE id IN (?,?)').run(STORE_A, STORE_B);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
