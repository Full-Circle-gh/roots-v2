'use strict';

// Walks one order of each fulfilment type end to end and asserts they differ in
// exactly the ways docs say they should — and in no others.
//
//   node scripts/verify-fulfilment-types.js
//
// Runs against a THROWAWAY database it creates and deletes itself. It never
// opens the real one, and it does not require ../database (which would).
//
// ⚠️ The SQL below is MIRRORED from the live queries, because those are inline
// strings inside route handlers and cannot be imported without booting the
// server. Each mirror names its source. If you change a worklist query, change
// its mirror in the same commit — a mirror that has drifted is worse than no
// test, because it passes.
//
// The JS predicates are NOT mirrored: lib/fulfilment.js is required directly, so
// those assertions test the real thing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const F = require('../lib/fulfilment');
// renderOrder() is pure — no DB, no network — so the print assertions exercise
// the real renderer instead of a mirror.
const feie = require('../lib/feie');

const dbPath = path.join(os.tmpdir(), `fulfilment-check-${process.pid}.sqlite`);
const db = new Database(dbPath);

let failures = 0;
const results = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  results.push({ ok, name, actual, expected });
}

// ── Minimal schema: only the columns these assertions read ──────────────────
db.exec(`
  CREATE TABLE retail_customers (
    id INTEGER PRIMARY KEY, openid TEXT, nickname TEXT, phone TEXT
  );
  CREATE TABLE retail_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, customer_id INTEGER,
    status TEXT, payment_method TEXT, fulfillment_type TEXT,
    recipient_name TEXT, recipient_phone TEXT,
    address_full TEXT, address_json TEXT, scheduled_for DATETIME,
    subtotal REAL,
    channel TEXT, store_id INTEGER, total REAL,
    placed_at DATETIME, paid_at DATETIME, delivered_at DATETIME, updated_at DATETIME,
    needs_invoice INTEGER DEFAULT 0, invoice_status TEXT,
    refund_status TEXT,
    reminder_ship_sent_at DATETIME, reminder_pickup_sent_at DATETIME,
    sms_delivered_sent_at DATETIME,
    wx_shipping_uploaded_at DATETIME, wx_shipping_status TEXT, wx_shipping_attempts INTEGER DEFAULT 0
  );
  CREATE TABLE retail_payments (
    id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, status TEXT,
    transaction_id TEXT, out_trade_no TEXT
  );
  CREATE TABLE retail_shipments (
    id INTEGER PRIMARY KEY, order_id INTEGER, mode TEXT,
    dispatched_at DATETIME, delivered_at DATETIME, tracking_number TEXT, tracking_status TEXT
  );
`);

// A real mini-program identity vs one minted by the admin create path. The
// difference decides the WeChat obligation — genuine openids carry no ':'.
db.prepare("INSERT INTO retail_customers (id, openid, nickname) VALUES (1, 'oABC1234567890123456789012', 'Real miniapp')").run();
db.prepare("INSERT INTO retail_customers (id, openid, nickname) VALUES (2, 'manual:deadbeefdeadbeef', 'Keyed in by staff')").run();

const NOW = '2026-07-30 04:00:00';

// ── The three orders, in the state the server leaves them ───────────────────
// delivery + pickup sit at 'paid' — money in, work outstanding.
// counter sits at 'delivered' with delivered_at == paid_at, because
// markOrderPaid flips it terminal the instant the money lands.
db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, payment_method, fulfillment_type, address_full,
   recipient_name, recipient_phone, subtotal,
   scheduled_for, channel, store_id, total, placed_at, paid_at, delivered_at)
  VALUES (1,'R-DEL',1,'paid','wechat','delivery','广州市天河区 1 号','Chen','13800000001',100, ?, 'manual', 1, 100, ?, ?, NULL)`
).run(NOW, NOW, NOW);

db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, payment_method, fulfillment_type, address_full,
   recipient_name, recipient_phone, subtotal,
   scheduled_for, channel, store_id, total, placed_at, paid_at, delivered_at)
  VALUES (2,'R-PICK',1,'paid','wechat','pickup', NULL,'Lam','13800000002',100, ?, 'manual', 1, 100, ?, ?, NULL)`
).run(NOW, NOW, NOW);

db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, payment_method, fulfillment_type, address_full,
   recipient_name, recipient_phone, subtotal,
   scheduled_for, channel, store_id, total, placed_at, paid_at, delivered_at)
  VALUES (3,'R-CNTR',2,'delivered','wechat','counter', NULL,'Walk-in','',100, NULL, 'manual', 1, 100, ?, ?, ?)`
).run(NOW, NOW, NOW);

// Payment rows as each path actually leaves them. The manual/counter path never
// writes a transaction_id — markOrderPaid only flips status to 'success'.
db.prepare("INSERT INTO retail_payments (order_id, method, status, transaction_id, out_trade_no) VALUES (1,'wechat','success','4200001234567890','R-DEL')").run();
db.prepare("INSERT INTO retail_payments (order_id, method, status, transaction_id, out_trade_no) VALUES (2,'wechat','success','4200009876543210','R-PICK')").run();
db.prepare("INSERT INTO retail_payments (order_id, method, status, transaction_id, out_trade_no) VALUES (3,'wechat','success',NULL,'R-CNTR')").run();

// Only the delivery order gets a parcel. shipsNothing() is why.
db.prepare("INSERT INTO retail_shipments (order_id, mode) VALUES (1,'local')").run();

const ROWS = db.prepare('SELECT * FROM retail_orders ORDER BY id').all();
const nos = ids => ids.map(i => ROWS.find(r => r.id === i).order_no);

// ═══ 1. The predicates themselves — the real module, not a mirror ═══════════
check('shipsNothing: delivery / pickup / counter',
  ROWS.map(F.shipsNothing), [false, true, true]);
check('isCounter: delivery / pickup / counter',
  ROWS.map(F.isCounter), [false, false, true]);
check('notifiesOnHandover: delivery / pickup / counter',
  ROWS.map(F.notifiesOnHandover), [true, true, false]);
check('isTerminalOnPaid: only counter',
  ROWS.map(F.isTerminalOnPaid), [false, false, true]);

// ═══ 2. Terminal state — counter is finished, the others are not ════════════
check('counter status is terminal',
  ROWS.find(r => r.id === 3).status, 'delivered');
check('counter delivered_at == paid_at (the moment of sale)',
  ROWS.find(r => r.id === 3).delivered_at === ROWS.find(r => r.id === 3).paid_at, true);
check('delivery + pickup are still open at paid',
  [ROWS[0].status, ROWS[1].status], ['paid', 'paid']);

// ═══ 3. Worklists and counts ════════════════════════════════════════════════
// Mirror of retail.js `oldest_unfulfilled` (Orders header status line, §1.7).
const unfulfilled = db.prepare(
  `SELECT order_no FROM retail_orders
    WHERE status IN ('paid','preparing','rider_pickup')
      AND COALESCE(channel,'') NOT IN ('meituan','gzgrocery')
    ORDER BY id`
).all().map(r => r.order_no);
check('oldest_unfulfilled excludes counter', unfulfilled, nos([1, 2]));

// Mirror of retail.js /order-status-counts open-work strip.
const openCounts = db.prepare(
  `SELECT status, COUNT(*) AS n FROM retail_orders
    WHERE status IN ('pending_payment','paid','preparing','dispatched','awaiting_restock')
      AND COALESCE(channel,'') NOT IN ('meituan','gzgrocery')
    GROUP BY status`
).all();
check('open-work chips count only the two open orders',
  openCounts, [{ status: 'paid', n: 2 }]);

// Mirror of lib/delivery-reminders.js — both sweeps, positive equality.
const shipReminder = db.prepare(
  `SELECT order_no FROM retail_orders
    WHERE fulfillment_type = 'delivery' AND status IN ('paid','preparing')
      AND scheduled_for IS NOT NULL AND reminder_ship_sent_at IS NULL`
).all().map(r => r.order_no);
check('ship reminder: delivery only', shipReminder, nos([1]));

const pickupReminder = db.prepare(
  `SELECT order_no FROM retail_orders
    WHERE fulfillment_type = 'pickup' AND status IN ('paid','preparing')
      AND scheduled_for IS NOT NULL AND reminder_pickup_sent_at IS NULL`
).all().map(r => r.order_no);
check('pickup reminder: pickup only', pickupReminder, nos([2]));

// Mirror of retail.js auto-deliver-past-ETA.
const autoDeliver = db.prepare(
  "SELECT order_no FROM retail_orders WHERE fulfillment_type = 'delivery' AND status IN ('paid','preparing','dispatched')"
).all().map(r => r.order_no);
check('auto-deliver sweep: delivery only', autoDeliver, nos([1]));

// ═══ 4. Rows produced ═══════════════════════════════════════════════════════
const shipCounts = ROWS.map(r =>
  db.prepare('SELECT COUNT(*) AS n FROM retail_shipments WHERE order_id = ?').get(r.id).n);
check('shipment rows: delivery 1, pickup 0, counter 0', shipCounts, [1, 0, 0]);

// ═══ 5. What is sent ════════════════════════════════════════════════════════
// maybeSendDeliveredSms returns early on shipsNothing(); nothing else gates it
// for these three, so the predicate IS the answer.
check('delivered-SMS candidates: delivery only',
  ROWS.filter(r => !F.shipsNothing(r)).map(r => r.order_no), nos([1]));

// WeChat virtual shipping. Mirror of the retryWeChatShippingForTenant sweep
// PLUS uploadWeChatVirtualShipping's own two extra guards (a genuine
// mini-program openid, and an inner join to a customer).
//
// This is the assertion that records WHY there is no counter branch here: the
// obligation is keyed on having a real WeChat payment record, not on fulfilment
// type. Our counter sale is excluded because the manual path never writes a
// transaction_id — NOT because it is a counter sale. A counter sale that DID
// carry a genuine JSAPI payment would owe the upload, and should get it.
const wxCandidates = db.prepare(
  `SELECT o.order_no FROM retail_orders o
     JOIN retail_customers c ON c.id = o.customer_id
    WHERE o.status = 'delivered'
      AND o.payment_method = 'wechat'
      AND o.wx_shipping_uploaded_at IS NULL
      AND c.openid NOT LIKE '%:%'
      AND EXISTS (SELECT 1 FROM retail_payments p
                   WHERE p.order_id = o.id AND p.method = 'wechat' AND p.status = 'success'
                     AND p.transaction_id IS NOT NULL AND p.transaction_id != '')`
).all().map(r => r.order_no);
check('WeChat upload candidates: none of the three', wxCandidates, []);

// Prove the exclusion is about the payment record and not the fulfilment type:
// give the counter sale a real txn id and a real openid, and it SHOULD qualify.
db.prepare("UPDATE retail_payments SET transaction_id = '4200005555555555' WHERE order_id = 3").run();
db.prepare('UPDATE retail_orders SET customer_id = 1 WHERE id = 3').run();
const wxAfter = db.prepare(
  `SELECT o.order_no FROM retail_orders o
     JOIN retail_customers c ON c.id = o.customer_id
    WHERE o.status = 'delivered' AND o.payment_method = 'wechat'
      AND o.wx_shipping_uploaded_at IS NULL
      AND c.openid NOT LIKE '%:%'
      AND EXISTS (SELECT 1 FROM retail_payments p
                   WHERE p.order_id = o.id AND p.method = 'wechat' AND p.status = 'success'
                     AND p.transaction_id IS NOT NULL AND p.transaction_id != '')`
).all().map(r => r.order_no);
check('a JSAPI-paid counter sale DOES owe the upload', wxAfter, nos([3]));
db.prepare("UPDATE retail_payments SET transaction_id = NULL WHERE order_id = 3").run();
db.prepare('UPDATE retail_orders SET customer_id = 2 WHERE id = 3').run();

// ═══ 5b. What it PRINTS ═════════════════════════════════════════════════════
// lib/feie.js renderOrder() is pure (no DB, no network), so these assertions run
// the real renderer rather than a mirror.
const ITEMS = [{ name_en: 'Oat milk', name_cn: '燕麦奶', sku: 'OAT-1', qty: 2, unit_price: 50, line_total: 100 }];
const slipFor = (id, tpl) => feie.renderOrder(tpl || 'receipt', ROWS.find(r => r.id === id), ITEMS, 'Tacet', []);

const delSlip  = slipFor(1);
const pickSlip = slipFor(2);
const cntrSlip = slipFor(3);

// A hand-over recipient is meaningless when the buyer is at the till holding it.
check('receipt To/Tel: delivery yes, pickup yes, counter no',
  [delSlip, pickSlip, cntrSlip].map(s => /^To {4}/m.test(s)), [true, true, false]);

// Nothing was promised, so no promise prints — tested against a counter row that
// DOES carry a slot. The natural fixture has no scheduled_for, so steps 2–4 of
// shipByPrintParts would print nothing anyway and the assertion would pass with
// or without the guard: decoration. This variant fails without it.
const cntrWithSlot = {
  ...ROWS.find(r => r.id === 3),
  scheduled_for: NOW,
  delivery_slot_label: 'Today 14:00–16:00',
  delivery_slot_kind: 'today',
};
check('counter slip prints no promise even when the row carries a slot',
  /Deliver 送达|Pickup 自提|Arrives 预计送达/.test(
    feie.renderOrder('receipt', cntrWithSlot, ITEMS, 'Tacet', [])), false);
check('pickup slip DOES carry its window label',
  /Pickup 自提/.test(pickSlip), true);

// It is still a real sale: order no, time, the item, and the money.
check('counter slip still carries order no + item + TOTAL',
  [cntrSlip.includes('R-CNTR'), /Oat milk|燕麦奶/.test(cntrSlip), cntrSlip.includes('TOTAL')],
  [true, true, true]);

// Nothing to pack. A store whose printer is set to 'packing' still gets a
// receipt for a walk-in — never a picking list for goods already handed over.
check('packing template on a counter sale renders a receipt, not a picking list',
  [/PACKING 配货单/.test(slipFor(3, 'packing')), /PACKING 配货单/.test(slipFor(1, 'packing'))],
  [false, true]);

// ═══ 6. Money and paperwork still move — born fulfilled, NOT born closed ════
db.prepare("UPDATE retail_orders SET needs_invoice = 1, invoice_status = 'requested' WHERE id = 3").run();
const invoiceWork = db.prepare(
  `SELECT order_no FROM retail_orders
    WHERE needs_invoice = 1 AND COALESCE(invoice_status,'requested') <> 'issued'
      AND status NOT IN ('cancelled','pending_payment')`
).all().map(r => r.order_no);
check('fapiao worklist STILL counts a counter sale', invoiceWork, nos([3]));

db.prepare("UPDATE retail_orders SET refund_status = 'pending' WHERE id = 3").run();
const refundWork = db.prepare(
  "SELECT order_no FROM retail_orders WHERE refund_status IN ('pending','reviewing','approved')"
).all().map(r => r.order_no);
check('refund pipeline STILL counts a counter sale', refundWork, nos([3]));

// ── Report ──────────────────────────────────────────────────────────────────
db.close();
try { fs.unlinkSync(dbPath); } catch (e) { /* best effort */ }

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) {
    console.log(`      expected ${JSON.stringify(r.expected)}`);
    console.log(`      actual   ${JSON.stringify(r.actual)}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
