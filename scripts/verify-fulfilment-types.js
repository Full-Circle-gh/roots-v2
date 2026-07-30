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

// ═══ 5c. What the CLIENT decides ════════════════════════════════════════════
// public/retail-admin/04-orders.js is a browser script, not a module, so it
// cannot be required. Rather than MIRROR its predicates — a mirror that drifts
// passes, which is worse than no test — we extract the real function source out
// of the shipped file and evaluate it in isolation.
//
// The extraction is deliberately dumb: from `function NAME(` to the next line
// that starts with `}` at column 0. If anyone reformats those functions the
// extraction stops matching, and the assertion right below FAILS rather than
// silently testing nothing. A regex that stops matching has to be loud.
const CLIENT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js'), 'utf8');

function extractFn(name, src) {
  const lines = (src || CLIENT_SRC).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

// A top-level `const NAME = {` … `};` block, same dumb-but-loud rule.
function extractConst(name, src) {
  const lines = (src || CLIENT_SRC).split('\n');
  const start = lines.findIndex(l => l.startsWith(`const ${name} = {`));
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\};/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

const WANTED = ['ordIsCounter', 'ordShipsNothing', 'undoDispatchable', 'humanStatus', 'nextStatusFor'];
const WANTED_CONSTS = ['NEXT_STATUS', 'NEXT_STATUS_PICKUP_LABELS'];
const sources = {};
for (const n of WANTED) sources[n] = extractFn(n);
for (const n of WANTED_CONSTS) sources[n] = extractConst(n);
const ALL_WANTED = WANTED.concat(WANTED_CONSTS);
const missing = ALL_WANTED.filter(n => !sources[n]);
check('every client predicate was found in 04-orders.js (extraction is intact)',
  missing, []);

// Stop here on a broken extraction rather than calling methods on an empty
// object: an unhandled TypeError still fails the gate, but a stack trace is a
// worse thing to hand the next person than a named failure. Verified by
// indenting a function declaration and watching this path fire.
if (missing.length) {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`\nEXTRACTION BROKEN — could not find in 04-orders.js: ${missing.join(', ')}`);
  console.log('These are pulled from the shipped source by name, from a line starting');
  console.log('`function NAME(` to the next line starting `}`. A reformat breaks that.');
  console.log('Fix the extractor or restore the shape — do NOT mirror the logic here.');
  db.close();
  try { fs.unlinkSync(dbPath); } catch (e) { /* best effort */ }
  process.exit(1);
}

// Evaluate the extracted sources together, with cuT stubbed to the EN arm.
const client = new Function(
  `const cuT = (en) => en;
   ${ALL_WANTED.map(n => sources[n]).join('\n')}
   return { ${WANTED.join(', ')} };`
)();

const ordersFor = t => ({ fulfillment_type: t });
check('client ordIsCounter matches the server predicate',
  ['delivery', 'pickup', 'counter'].map(t => client.ordIsCounter(ordersFor(t))),
  ['delivery', 'pickup', 'counter'].map(t => F.isCounter(ordersFor(t))));
check('client ordShipsNothing matches the server predicate',
  ['delivery', 'pickup', 'counter'].map(t => client.ordShipsNothing(ordersFor(t))),
  ['delivery', 'pickup', 'counter'].map(t => F.shipsNothing(ordersFor(t))));

// THE ONE THIS PROJECT INTRODUCED. A counter sale sits at 'delivered' with no
// parcel and no waybill — exactly the shape undoDispatchable was written to spot
// as a misclick. Before counter existed nothing reached 'delivered' undispatched,
// so this defect is ours, not inherited.
const undoCase = t => ({ fulfillment_type: t, status: 'delivered', shipments: [] });
check('undoDispatchable: offered on a delivery, NEVER on a pickup or a walk-in',
  ['delivery', 'pickup', 'counter'].map(t => !!client.undoDispatchable(undoCase(t))),
  [true, false, false]);

// "Completed", not "Delivered" — and as one string, never joined to 已完成.
check('humanStatus relabels a counter delivered to Completed',
  client.humanStatus('delivered', 'counter'), 'Completed');
check('humanStatus leaves delivery and pickup alone',
  [client.humanStatus('delivered', 'delivery'), client.humanStatus('delivered', 'pickup')],
  ['Delivered', 'Picked up · 已取货']);
// §1.11 — the counter label must not be a glued EN·CN node. The pickup labels
// above ARE glued; they are pre-existing and belong to the page rebuild.
check('counter label is not a glued EN·CN string',
  /·|已完成/.test(client.humanStatus('delivered', 'counter')), false);

// BORN FULFILLED, NOT BORN CLOSED — on the client too. nextStatusFor got NO
// counter special case, and the first attempt at this work added one returning []
// before anyone read NEXT_STATUS properly. That would have stripped Refund from a
// completed walk-in and Mark paid from an unpaid one. These three assertions are
// why it cannot come back: they fail the moment the shortcut is re-added.
const nextOf = o => client.nextStatusFor(o).map(([next]) => next);
check('a completed counter sale can still be refunded',
  nextOf({ status: 'delivered', fulfillment_type: 'counter' }), ['refunded']);
check('an unpaid counter sale can still be marked paid or cancelled',
  nextOf({ status: 'pending_payment', fulfillment_type: 'counter' }), ['paid', 'cancelled']);
check('counter transitions match delivery — the list is keyed on status, not type',
  nextOf({ status: 'delivered', fulfillment_type: 'counter' }),
  nextOf({ status: 'delivered', fulfillment_type: 'delivery' }));

// ═══ 5d. What it SENDS to the WeCom group ═══════════════════════════════════
// The alert stays for a counter sale (Ash's call), but it must read as a RECORD,
// not a task. The delivery card is shaped like a job — recipient, address, slot —
// and the same group carries real delivery jobs, so a walk-in wearing that shape
// teaches staff to skim the channel.
//
// Same extraction technique as the client predicates, against routes/retail.js.
const SERVER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');

const CARD_FNS = ['buildWecomOrderCard', 'buildWecomCounterCard'];
const cardSrc = {};
for (const n of CARD_FNS) cardSrc[n] = extractFn(n, SERVER_SRC);
const cardMissing = CARD_FNS.filter(n => !cardSrc[n]);
check('both WeCom card builders were found in routes/retail.js', cardMissing, []);

if (!cardMissing.length) {
  const cards = new Function(
    `${CARD_FNS.map(n => cardSrc[n]).join('\n')}
     return { ${CARD_FNS.join(', ')} };`
  )();

  const counterOrder = {
    order_no: 'R-CNTR', total: 100, paid_at: NOW, fulfillment_type: 'counter',
    // Deliberately populated: a counter sale still has a recipient_name (the
    // endpoint requires one), which is exactly why the delivery card would leak
    // a "To:" line if the branch were removed.
    recipient_name: 'Walk-in', address_full: null, delivery_slot_label: null,
    store_name_cn: '天河', counter_items: '燕麦奶×2', counter_cashier: 'ash',
  };
  const counterCard = cards.buildWecomCounterCard(counterOrder);

  // A record, not a task.
  check('counter alert carries no recipient, address or slot',
    [/收货人|To:/.test(counterCard), /地址|Address:/.test(counterCard), /Slot:/.test(counterCard)],
    [false, false, false]);
  check('counter alert carries store, order, items, total, cashier and the method line',
    ['门店', 'R-CNTR', '燕麦奶×2', '¥100.00', 'ash', '前台 Counter'].map(t => counterCard.includes(t)),
    [true, true, true, true, true, true]);
  // Its own lead line — a completed sale, not a new order to fulfil.
  check('counter alert does NOT use the new-order lead line',
    /新订单|New order/.test(counterCard), false);
  check('counter alert says it is already handed over',
    /已交付/.test(counterCard) && /nothing to fulfil/.test(counterCard), true);
  // §1.11 — the new lead lines are one language each, not glued with a middle dot.
  check('counter lead lines are separate EN and 中文, not glued',
    [counterCard.includes('**🌿 前台销售**'), counterCard.includes('**Counter sale**'),
     /前台销售 ·|· Counter sale/.test(counterCard)],
    [true, true, false]);

  // THE PRE-FIX SHAPE, recorded permanently. Routing the SAME counter sale
  // through the delivery card is what happened before this branch existed, and
  // it produces the address-shaped message the branch exists to prevent.
  const preFix = cards.buildWecomOrderCard(counterOrder, false);
  check('the delivery card WOULD have made a counter sale look like a job',
    [/新订单|New order/.test(preFix), /收货人|To:/.test(preFix)], [true, true]);

  // Catches someone deleting the wiring rather than the card: the builders can
  // both be perfect and never be reached.
  check('sendWecomOrderAlert routes a counter sale to the counter card',
    /isCounter\(o\)\s*\?\s*buildWecomCounterCard/.test(SERVER_SRC), true);
}

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

// ═══ 7. New order page — the container (§1.7a takeover) ═════════════════════
// Static proofs against the shipped sources, same dumb-but-loud extraction as
// §5c. Each check is a composite whose new-behaviour half fails on the pre-fix
// tree — verified by running this script against origin/main's sources.
const HTML_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin.html'), 'utf8');
const CSS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin.css'), 'utf8');
const CORE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin', '01-core.js'), 'utf8');

// The text of one top-level section — from its open tag to the next top-level
// `<section id=` (two-space indent, matching the file's own layout).
function sliceSection(src, id) {
  const open = src.indexOf('<section id="' + id + '">');
  if (open === -1) return '';
  const next = src.indexOf('\n  <section id=', open + 10);
  return next === -1 ? src.slice(open) : src.slice(open, next);
}
const ordersSection = sliceSection(HTML_SRC, 'tab-orders');
const newSection    = sliceSection(HTML_SRC, 'tab-orders-new');
const srcOrdNewOpen     = extractFn('ordNewOpen')      || '';
const srcOrdNewBack     = extractFn('ordNewBack')      || '';
const srcOrdNewOnPop    = extractFn('_ordNewOnPop')    || '';
const srcOrdNewTeardown = extractFn('_ordNewTeardown') || '';

// §1.7a condition 2 — while the page is open the Orders section (and with it
// the Dusk "New order" CTA) must be display:none: out of the tab order, out of
// the accessibility tree. The chain that makes that true, every link asserted:
// the CTA sits inside #tab-orders; opening goes through goTab('orders-new'),
// which leaves #tab-orders without .active; a section without .active is
// display:none; and the revived takeover class hides sections wholesale, with
// only the id-scoped new section opted back in.
check('CTA unreachable while open: every link of the display:none chain',
  [/ord-head-cta/.test(ordersSection),
   /goTab\('orders-new'\)/.test(srcOrdNewOpen),
   /^  section \{ display: none; \}$/m.test(CSS_SRC),
   /classList\.add\('ord-viewing'\)/.test(srcOrdNewOpen),
   /body\.ord-viewing main > section \{ display: none; \}/.test(CSS_SRC),
   /body\.ord-viewing main > section#tab-orders-new\.active \{/.test(CSS_SRC)],
  [true, true, true, true, true, true]);

// The class goes on AFTER goTab — goTab closes open drawers, and
// closeDrawer('#order-drawer') strips ord-viewing as a legacy cleanup. The
// other order would open the page with no takeover on exactly the records an
// operator was just looking at.
check('ordNewOpen adds ord-viewing after goTab, never before',
  srcOrdNewOpen.indexOf("goTab('orders-new')") !== -1
    && srcOrdNewOpen.indexOf("goTab('orders-new')")
       < srcOrdNewOpen.indexOf("classList.add('ord-viewing')"),
  true);

// §1.7a condition 3 + the back trap (09-products lightbox precedent): opening
// pushes a throwaway entry; browser Back pops it and lands on Orders; every
// other exit consumes the entry via history.back().
check('Back trap: push on open, Orders on pop, entry consumed on other exits',
  [/history\.pushState\(\{ ordNew: true \}/.test(srcOrdNewOpen),
   /addEventListener\('popstate', _ordNewOnPop\)/.test(srcOrdNewOpen),
   /goTab\('orders'\)/.test(srcOrdNewOnPop),
   /goTab\('orders'\)/.test(srcOrdNewBack),
   /history\.back\(\)/.test(srcOrdNewTeardown),
   /removeEventListener\('popstate', _ordNewOnPop\)/.test(srcOrdNewTeardown)],
  [true, true, true, true, true, true]);

// A rail click while the page is open must tear the takeover down (capture
// phase), or ord-viewing's section-hiding strands the newly picked tab blank.
check('a rail click while open tears the takeover down',
  /closest\('\.tabs \[data-tab\]'\)\) _ordNewTeardown\(false\);\s*\}, true\)/.test(CLIENT_SRC),
  true);

// §1.7a header shape: back link (the eyebrow) · title · two exits — the
// non-committing one Secondary, the commit the page's ONE Dusk element. No
// second primary idiom (btn-primary / t-cta) anywhere in the section.
check('§1.7a header: back link, title, Secondary draft, exactly one Dusk',
  [(newSection.match(/onw-dusk/g) || []).length,
   /onw-sec/.test(newSection),
   /onw-ghost/.test(newSection),
   /onw-title/.test(newSection),
   /btn-primary|t-cta/.test(newSection)],
  [1, true, true, true, false]);

// The rail keeps the parent lit via RAIL_STANDIN. (The page's doors — the
// palette entry and the CTA repoint — land with the create pass; until then
// nothing reaches the page and that is deliberate: no flag, no seam.)
check('RAIL_STANDIN maps orders-new to its parent',
  /'orders-new': 'orders'/.test(extractConst('RAIL_STANDIN', CORE_SRC) || ''),
  true);

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
