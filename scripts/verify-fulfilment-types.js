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

// `async function NAME(` counts too — the write handlers are async, and a
// matcher that only knew the plain form returned null for them, which read as
// six broken assertions rather than one blind extractor.
function extractFn(name, src) {
  const lines = (src || CLIENT_SRC).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`)
                                  || l.startsWith(`async function ${name}(`));
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
  check('counter alert carries store, order, total, cashier and the method line',
    ['门店', 'R-CNTR', '¥100.00', 'ash', '前台 Counter'].map(t => counterCard.includes(t)),
    [true, true, true, true, true]);
  // NO ITEM LIST — decided 2026-08-21, after the card was read on a phone in a
  // channel that also carries real delivery jobs. The goods have already left
  // with the customer, so a list of them is not something anyone acts on, and
  // it was the longest row in a card whose whole job is to be skimmed past.
  //
  // THE FIXTURE STILL SUPPLIES counter_items, deliberately: the builder has to
  // IGNORE it, not merely be starved of it. Asserted the other way round this
  // would pass on any card that happened to receive no items.
  check('counter alert does NOT list the goods, even when handed them',
    counterCard.includes('燕麦奶×2'), false);
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

// ═══ 8. New order page — the form ═══════════════════════════════════════════
// The CSS text belonging to the new page: the contiguous block between its own
// banner comment and the next section's. Sliced, NOT grep-filtered by line — a
// line filter keeps only the lines naming the id and silently drops the body of
// every multi-line rule, which made four band assertions pass vacuously on a
// stylesheet that did contain them. Loud when the anchors move: the slice comes
// back empty and every assertion below fails.
const ONW_CSS_START = CSS_SRC.indexOf('/* ── Orders · New order — page chrome');
const ONW_CSS_END   = CSS_SRC.indexOf('/* The Orders drawer hosts the existing');
const ONW_CSS = (ONW_CSS_START !== -1 && ONW_CSS_END > ONW_CSS_START)
  ? CSS_SRC.slice(ONW_CSS_START, ONW_CSS_END) : '';
check('the new page\'s CSS block was found (the slice anchors still match)',
  ONW_CSS.length > 4000, true);
const ONW_WANTED = ['ordNewFulChange', 'ordNewChannelChange', 'ordNewPhoneBlur',
                    'ordNewPaintPhoneNote', 'ordNewPaintCustResults', 'ordNewRenderLines',
                    'ordNewSubtotal', 'ordNewRecalc'];
const onwSrc = {};
for (const n of ONW_WANTED) onwSrc[n] = extractFn(n);
const onwMissing = ONW_WANTED.filter(n => !onwSrc[n]);
check('every new-order function was found in 04-orders.js (extraction is intact)',
  onwMissing, []);
// Same reason as §5c's guard: three of the assertions below EVALUATE these
// sources, so a broken extraction throws a stack trace instead of naming what
// went wrong. A failure has to be legible.
if (onwMissing.length) {
  console.log(`\nEXTRACTION BROKEN — could not find in 04-orders.js: ${onwMissing.join(', ')}`);
  console.log('Pulled by name from a line starting `function NAME(` to the next line');
  console.log('starting `}`. A reformat breaks that. Fix the extractor or restore the');
  console.log('shape — do NOT mirror the logic here.');
  report();
}
const srcFulChange   = onwSrc.ordNewFulChange;
const srcPhoneBlur   = onwSrc.ordNewPhoneBlur;
const srcPhoneNote   = onwSrc.ordNewPaintPhoneNote;
const srcCustResults = onwSrc.ordNewPaintCustResults;
const srcRenderLines = onwSrc.ordNewRenderLines;
const srcSubtotal    = onwSrc.ordNewSubtotal;

// ADDRESS ABSENT ON COUNTER AND PICKUP (frame E). `hidden` on the block is
// display:none — out of layout, out of the tab order, out of the accessibility
// tree. Not disabled, not shown empty. Asserted as the real predicate: run the
// extracted function against a stub DOM for all three types and read the flag.
// ordNewFees is a stub here, not the real thing: switching fulfilment re-quotes
// the delivery and packing fees (a different fulfilment is a different fee), and
// that call reaches the network. This harness is about ONE question — does the
// address block disappear — so the quote is stubbed to nothing. Fee behaviour is
// proven in scripts/test_manual_order_fees.js against a real database.
const addrHarness = new Function(`
  ${srcFulChange}
  function ordNewFees() {}
  return function (ft, prevFul) {
    const nodes = {
      'onw-ful':      { value: ft },
      'onw-addr-blk': { hidden: false },
      'onw-status':   { value: 'pending_payment' },
      'onw-pay':      { value: 'wechat' },
    };
    globalThis.document = { getElementById: (id) => nodes[id] || null };
    globalThis.ONW = { ful: prevFul || 'delivery' };
    ordNewFulChange();
    return { hidden: nodes['onw-addr-blk'].hidden,
             status: nodes['onw-status'].value, pay: nodes['onw-pay'].value };
  };
`)();
check('address block: present on delivery, ABSENT on pickup and counter',
  ['delivery', 'pickup', 'counter'].map(t => addrHarness(t).hidden),
  [false, true, true]);
// "hidden", never a disabled-but-present block: a disabled field still reads as
// a blank the operator failed to fill, and readonly reads as one they cannot.
// The markup half only — the behavioural half is the assertion above, running
// the real function. (A source-regex restating what that already proves adds a
// line and no coverage.)
const addrMarkup = newSection.slice(newSection.indexOf('onw-addr-blk'),
                                   newSection.indexOf('onw-notes'));
check('the address block carries no disabled or readonly idiom',
  /disabled|readonly/.test(addrMarkup), false);
// Born fulfilled, not born closed: a counter sale opens Paid + Cash, and
// leaving counter restores the pending defaults rather than stranding them.
check('counter opens Paid and Cash; leaving counter restores pending',
  [addrHarness('counter').status, addrHarness('counter').pay,
   addrHarness('delivery', 'counter').status, addrHarness('delivery', 'counter').pay],
  ['paid', 'offline', 'pending_payment', 'wechat']);

// "PICK UP" AS THE ORIGIN IS A COLLECTION. The form opens on Delivery, so an
// operator who answered "Pick up" and went on to the products was quoted the
// delivery zone's shipping on a walk-in collection. Picking that origin now
// moves fulfilment to Pickup — the same path that zeroes shipping and drops the
// address block — and ONLY the operator's own pick does it: the open/reset and
// draft-restore callers pass nothing and must leave a restored fulfilment alone.
// A mis-click corrected to another origin falls back to Delivery; a fulfilment
// the operator set by hand is never overridden by the origin.
const originHarness = new Function(`
  ${srcFulChange}
  ${onwSrc.ordNewChannelChange}
  function ordNewFees() {}
  return function (steps) {
    const nodes = {
      'onw-channel':          { value: '' },
      'onw-channel-note-wrap':{ hidden: true },
      'onw-channel-note':     { value: '' },
      'onw-ful':              { value: 'delivery' },
      'onw-ship':             { value: '15' },
      'onw-addr-blk':         { hidden: false },
      'onw-status':           { value: 'pending_payment' },
      'onw-pay':              { value: 'wechat' },
    };
    globalThis.document = { getElementById: (id) => nodes[id] || null };
    globalThis.ONW = { ful: 'delivery', feeTouched: { ship: true, pack: false }, fulFromOrigin: false };
    for (const [kind, v, userPick] of steps) {
      if (kind === 'origin') { nodes['onw-channel'].value = v; ordNewChannelChange(userPick); }
      else                   { nodes['onw-ful'].value = v;     ordNewFulChange(); }
    }
    return { ful: nodes['onw-ful'].value, ship: nodes['onw-ship'].value,
             addrHidden: nodes['onw-addr-blk'].hidden, shipTouched: globalThis.ONW.feeTouched.ship };
  };
`)();
check('origin "Pick up" (operator pick) → fulfilment Pickup, shipping 0, address absent',
  originHarness([['origin', 'pickup', true]]),
  { ful: 'pickup', ship: '0', addrHidden: true, shipTouched: false });
check('origin set programmatically (open / draft restore) leaves fulfilment alone',
  [originHarness([['origin', 'pickup']]).ful, originHarness([['origin', 'pickup', false]]).ship],
  ['delivery', '15']);
check('a mis-click on "Pick up" corrected to another origin falls back to Delivery',
  originHarness([['origin', 'pickup', true], ['origin', 'wechat_chat', true]]).ful,
  'delivery');
check('a fulfilment the operator chose by hand is never overridden by the origin',
  [originHarness([['ful', 'counter'], ['origin', 'pickup', true]]).ful,
   originHarness([['origin', 'pickup', true], ['ful', 'pickup'], ['origin', 'wholesale', true]]).ful],
  ['counter', 'pickup']);

// THE BY-PHONE WARNING ON A BLOCKED MATCH (frame C). It must use the by-phone
// endpoint — the identical equality the create path's reuse runs — never the
// roster search, and it must never filter is_blocked out.
check('the warning queries by-phone, not the roster search',
  [/customers\/by-phone\?phone=/.test(srcPhoneBlur),
   /customers\?pageSize/.test(srcPhoneBlur)],
  [true, false]);
// The classifier: blocked is its own outcome, shared wins over both, no match
// renders nothing. Run the real branch, not a mirror.
const noteHarness = new Function(`
  ${srcPhoneBlur}
  return function (resp) {
    globalThis.ONW = { phoneNote: null };
    globalThis.document = { getElementById: () => ({ value: '13800000001' }) };
    globalThis.api = () => Promise.resolve(resp);
    // Read the value the real function wrote, out of the same ONW it wrote to —
    // captured here, at paint time, so a later case cannot overwrite it.
    let out;
    globalThis.ordNewPaintPhoneNote = () => { out = globalThis.ONW.phoneNote; };
    ordNewPhoneBlur();
    return new Promise(r => setTimeout(() => r(out === undefined ? null : out), 0));
  };
`)();
const NOTE_CASES = [
  [{ success: true, match: null, share_count: 0 }, null],
  [{ success: true, match: { id: 1, nickname: 'Chen Jing', is_blocked: 0 }, share_count: 1 }, 'match'],
  [{ success: true, match: { id: 1, nickname: 'Chen Jing', is_blocked: 1 }, share_count: 1 }, 'blocked'],
  [{ success: true, match: { id: 1, nickname: 'Chen Jing', is_blocked: 0 }, share_count: 3 }, 'shared'],
];
// SEQUENTIALLY, one case at a time. Run concurrently, all four share the single
// globalThis.ONW the stub DOM hangs off, every callback writes to whichever
// object the LAST case installed, and three of the four read back null — which
// is exactly what happened, and read as three broken outcomes rather than one
// broken harness. A harness with shared mutable state does not test four cases.
(async () => {
  const got = [];
  for (const [resp] of NOTE_CASES) got.push(await noteHarness(resp));
  return got;
})().then(got => {
  check('by-phone outcomes: silence, match, BLOCKED, shared',
    got.map(n => (n ? n.kind : null)), NOTE_CASES.map(([, want]) => want));
  // A blocked owner is named on screen. Hiding them tells the operator "no
  // match" while the save attaches to that very record.
  check('the blocked note names the person and says blocked, in Brick',
    [/is_blocked \?/.test(srcPhoneBlur),
     /'brick'/.test(srcPhoneNote),
     /whose account is blocked/.test(srcPhoneNote),
     /已被拉黑/.test(srcPhoneNote)],
    [true, true, true, true]);
  report();
}, (e) => { console.log('by-phone harness threw:', e && e.message); failures++; report(); });

// §1.12's two most conflated states, kept apart: no-match reads differently
// from an empty catalogue, and the page branches on the server's count.
check('no-match and no-customers-at-all are different copy',
  [/customersOnFile === 0/.test(srcCustResults),
   /No customers on this account yet/.test(srcCustResults),
   /No customer matches/.test(srcCustResults)],
  [true, true, true]);

// §1.13a rule 1 — the band pins, and the card clips with clip-path rather than
// overflow (overflow makes the card the scrollport and parks the band on row
// one). Band values are the product-wide table, Orders being the anchor.
check('line-table band pins on a clip-path card, with the §1.13a values',
  [/\.onw-tw \{[^}]*clip-path: inset\(0 round 12px\)/.test(ONW_CSS),
   /\.onw-tw \{[^}]*overflow/.test(ONW_CSS),
   /\.onw-tscroll \{ max-height: 344px; overflow: hidden auto; \}/.test(ONW_CSS),
   /\.onw-tbl th \{[\s\S]*?position: sticky; top: 0; z-index: 5;/.test(ONW_CSS),
   /background: var\(--td-header\)/.test(ONW_CSS),
   /font-size: 13px; font-weight: 500; text-align: left;\s*\n\s*padding: 10px 12px;/.test(ONW_CSS)],
  [true, false, true, true, true, true]);

// 🔴 EVERY ICON HAS A BASE SIZE. An inline <svg> with no width/height falls
// back to the replaced-element default — 300×150 — so an unsized icon does not
// render slightly wrong, it renders as a glyph the height of the form. That
// shipped live on 2026-07-31: the mockup's `.no-ico` base rule was dropped in
// the rename to onw-*, every other .onw-ico rule set only position or colour,
// and 31 assertions about structure and behaviour had nothing to say about it.
// A screenshot found it in seconds. This is that screenshot, in the gate.
//
// The class list is read out of the markup AND the JS icon helper, so a new
// icon class arriving without a base rule fails here rather than on screen.
// Scoped to the new-order region of 04-orders.js, not the whole file: the rest
// of Orders draws its own icons (rf-ic, eta-clock) which are sized by their own
// sections and must not be demanded of this page's stylesheet.
const ONW_JS = CLIENT_SRC.slice(CLIENT_SRC.indexOf('// ═══ Orders · New order'));
check('the new-order JS region was found (the icon scan is correctly scoped)',
  ONW_JS.length > 2000 && !/eta-clock/.test(ONW_JS), true);
const iconClasses = [...new Set(
  [newSection, ONW_JS]
    .flatMap(src => src.match(/<svg class="([a-z0-9 -]+)"/g) || [])
    .flatMap(m => m.slice(12, -1).split(/\s+/))
    .filter(Boolean)
)];
check('the icon-class scan found the page\'s icons (not vacuously empty)',
  iconClasses.length >= 1 && iconClasses.includes('onw-ico'), true);
// A rule counts only when the icon class is its WHOLE subject at base scope.
// `.onw-cb i .onw-ico { width: 12px }` sizes one nested instance and says
// nothing about the six unscoped ones — a looser check passes on the broken
// stylesheet, which is exactly the trap that let this ship.
const cssRules = ONW_CSS.split('}').map(chunk => {
  const i = chunk.indexOf('{');
  return i === -1 ? null : { sel: chunk.slice(0, i).trim().replace(/^[\s\S]*?\*\//, '').trim(),
                             body: chunk.slice(i + 1) };
}).filter(Boolean);
const hasBaseSize = cls => cssRules.some(r =>
  r.sel === '#tab-orders-new .' + cls && /width:/.test(r.body) && /height:/.test(r.body));
check('every icon class has a base width and height, not only a scoped one',
  iconClasses.filter(c => !hasBaseSize(c)), []);
// The header's back chevron carries no class of its own and is sized by an
// element rule instead — the other half of the same guarantee.
check('the header button SVGs are sized too',
  /#tab-orders-new \.onw-btn svg \{[^}]*width:[^}]*height:/.test(ONW_CSS), true);

// A line with a bad qty shows an em dash rather than a false ¥0.00 (frame G).
//
// NOT asserted: "the failing line is excluded from the subtotal." A failing line
// is one whose qty is ≤ 0, and Math.max(0, …) on the stepper means it is always
// exactly 0 — so its contribution is 0 × price either way and the skip is
// arithmetically invisible. The first version of this check compared two
// fixtures that summed identically and passed with the skip removed. An
// assertion that cannot fail is worse than no assertion, so it is gone rather
// than dressed up; what makes the page honest here is the em dash, below.
check('a failing line total renders an em dash, never a false zero',
  [/bad \? '—'/.test(srcRenderLines), /Enter 1 or more/.test(srcRenderLines)],
  [true, true]);

// The grand-total override wins over subtotal plus shipping, and an UNSET
// override falls back to the sum rather than to zero — the em-dash placeholder
// must not read as a typed 0.
const totalHarness = new Function(`
  ${onwSrc.ordNewSubtotal}
  ${onwSrc.ordNewRecalc}
  return function (lines, ship, override) {
    const out = {};
    const nodes = { 'onw-ship': { value: String(ship) }, 'onw-override': { value: override } };
    globalThis.ONW = { lines };
    globalThis.document = { getElementById: (id) => nodes[id] || { set textContent(v) { out[id] = v; } } };
    globalThis.onwMoney = (n) => Number(n).toFixed(2);
    ordNewRecalc();
    return out['onw-sum-total'];
  };
`)();
check('the override wins when set, and an empty override falls back to the sum',
  [totalHarness([{ qty: 2, unit_price: 62 }], 15, ''),
   totalHarness([{ qty: 2, unit_price: 62 }], 15, '2400')],
  ['139.00', '2400.00']);

// The summary carries four rows and no explanatory prose — frame F's caption
// is annotation, not content.
// Exactly four rows. Matched with a boundary: a bare /onw-sr/ also counts
// every onw-srch search row on the page and came back 5.
//
// PACKING IS THE FOURTH, AND IT IS BORN `hidden`. It was added when manual
// orders started pricing packing at all (they used to charge none, ever, on any
// order); the rule this check has always enforced — three rows on screen, no
// prose — is unchanged, because a packing row only appears when there is a fee
// to explain. `hidden` in the markup is what makes that true on first paint,
// before ordNewRecalc has run; the toggle itself is ordNewRecalc's.
check('summary is Items, Shipping, Packing, Total and nothing else',
  [(newSection.match(/class="onw-sr[ "]/g) || []).length,
   /onw-sum-items/.test(newSection) && /onw-sum-ship/.test(newSection)
     && /onw-sum-pack/.test(newSection) && /onw-sum-total/.test(newSection),
   /id="onw-sum-pack-row" hidden/.test(newSection),
   /onw-cap/.test(newSection.slice(newSection.indexOf('onw-sum')))],
  [4, true, true, false]);

// The two notes sit in visibly DIFFERENT containers — not the same field twice
// with the word "staff" between them.
check('the two notes are different containers, one dashed and recessed',
  [/onw-cnote/.test(newSection), /onw-snote/.test(newSection),
   /\.onw-cnote \{ background: var\(--td-paper\); \}/.test(ONW_CSS),
   /\.onw-snote \{ background: var\(--td-raised\); border-style: dashed; \}/.test(ONW_CSS)],
  [true, true, true, true]);

// §1.6 — no uppercase anywhere on the new page, and none inherited: the page
// uses none of the classes the two live uppercase rules select (label.stacked,
// .om-sec-lbl), so there is nothing to override. The rule's job is stopping NEW
// ones; this assertion is what stops one arriving here later.
// (The third arm — "no .om-sec-lbl" — went with the modal on 2026-07-31. The
// class no longer exists anywhere, so asking the page not to use it stopped
// being a check and became a tautology.)
check('§1.6 — the new page ships no uppercase, and inherits none',
  [/text-transform:\s*uppercase/.test(ONW_CSS),
   /class="[^"]*\bstacked\b/.test(newSection)],
  [false, false]);

// §1.11 — every static label is an "EN · 中文" source pair the walker can split,
// and NEITHER half may itself contain " · " (it splits on the first one). The
// walker's own two gates decide what counts: left half Chinese-free, right half
// containing Chinese.
// Comments are stripped first: a comment is node type 8 and the walker's
// TreeWalker is SHOW_TEXT, so prose in a comment is never split — but it is
// prose written in " · " shorthand, and scanning it reported a false glue.
const newSectionText = newSection.replace(/<!--[\s\S]*?-->/g, '');
const onwPairs = (newSectionText.match(/[^<>\n]+ · [^<>\n]+/g) || [])
  .map(s => s.trim()).filter(s => s && !s.startsWith('data-'));
const badPairs = onwPairs.filter(s => {
  const i = s.indexOf(' · ');
  const en = s.slice(0, i), cn = s.slice(i + 3);
  // Fails if: the walker would reject the pair, or either half is itself glued.
  return !/[一-鿿]/.test(cn) || /[一-鿿]/.test(en) || cn.includes(' · ');
});
check('every new-order label is a splittable pair, neither half glued', badPairs, []);
check('the page carries pairs at all (the scan is not vacuously empty)',
  onwPairs.length > 30, true);

// Regions holding outside-system text — customer names, phones, SKUs — carry
// data-no-i18n, or the walker splits a name containing " · " and blanks half of
// it in the other language.
// ═══ 9. Create — the seam, the orphan, and the doors ════════════════════════
const OPS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin', '02-settings-ops.js'), 'utf8');
const ordersPost = SERVER_SRC.slice(
  SERVER_SRC.indexOf("router.post('/api/retail-admin/orders'"),
  SERVER_SRC.indexOf('// ── Unfinished New-order forms'));
check('the order-create handler was found (the §9 slice still matches)',
  ordersPost.length > 3000, true);
// Comments stripped for the "is it gone" checks below. The comments left behind
// deliberately NAME what was removed and why not to bring it back, so a raw
// search for the word finds the tombstone and calls it the body.
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVER_CODE = stripComments(SERVER_SRC);

// THE ADDRESS SEAM IS CLOSED. declaredFt is gone from the file entirely — not
// renamed, not left unreferenced — and the address rule binds on every request
// rather than only on ones that declared a type.
// The GUARD, not the string: a first version grepped for
// `error: 'fulfillment_type_required'` and passed happily with the `if` around
// it neutered, because the string still sat in the dead branch. Match the
// condition and its answer together.
check('declaredFt is deleted and fulfillment_type is required',
  [/declaredFt/.test(SERVER_CODE),
   /if \(b\.fulfillment_type == null \|\| b\.fulfillment_type === ''\) \{[\s\S]{0,160}fulfillment_type_required/.test(ordersPost),
   /if \(declaredFt\)/.test(ordersPost),
   /if \(fulfillmentType === 'delivery' && !hasAddress\) \{[\s\S]{0,160}address_required_for_delivery/.test(ordersPost)],
  [false, true, false, true]);

// THE ORPHAN CUSTOMER. The customer is created INSIDE the order's transaction,
// through the same helper the Customers endpoint uses, and the money-touching
// hooks run only after it commits.
const helperSrc = extractFn('createOrReuseManualCustomer', SERVER_SRC) || '';
check('customer create happens inside the order transaction, via the shared helper',
  [/createOrReuseManualCustomer/.test(helperSrc.slice(0, 80)),
   // called from inside the tx callback, before the order INSERT
   ordersPost.indexOf('createOrReuseManualCustomer(') > ordersPost.indexOf('tdb().transaction(()'),
   ordersPost.indexOf('createOrReuseManualCustomer(') < ordersPost.indexOf('INSERT INTO retail_orders'),
   // and the Customers endpoint runs the SAME helper, so there is one implementation
   (SERVER_SRC.match(/createOrReuseManualCustomer\(\{/g) || []).length >= 2],
  [true, true, true, true]);
// The hooks that move money are outside the transaction, after commit.
check('migration credit and signup vouchers run AFTER the commit, never inside',
  [ordersPost.indexOf('claimMigrationCredit') > ordersPost.indexOf('tx();'),
   /claimMigrationCredit/.test(helperSrc)],
  [true, false]);
// A rejected customer rolls the order back and answers 400 — never a 500, and
// never an order that exists without the customer the operator asked for.
check('a rejected customer rolls the order back and returns its own 400',
  [/custError = made\.error; throw new Error/.test(ordersPost),
   /if \(custError\) return res\.status\(400\)/.test(ordersPost)],
  [true, true]);
// Creating a customer through the order route needs the customers cap, gated on
// the same three conditions the middleware uses so nothing changes while dark.
check('the order route checks customers:edit before minting a customer',
  /wantsCustomer && req\.tenant && req\.tenant\.rbac_enforce[\s\S]{0,120}customers:edit/.test(ordersPost),
  true);
// Reuse-by-phone must not filter blocked: the form promised, in Brick, that the
// order files under that record.
check('the helper reuses a blocked owner rather than skipping past them',
  [/WHERE phone = \? ORDER BY id LIMIT 1/.test(helperSrc),
   /is_blocked/.test(stripComments(helperSrc))],
  [true, false]);

// THE DOORS, both in this commit. The header CTA opens the page; the old modal
// keeps its handler but nothing reaches it.
check('the Orders CTA opens the page, and no live control still calls omOpen',
  [/ord-head-cta[^>]*onclick="ordNewOpen\(\)"/.test(HTML_SRC),
   /onclick="omOpen\(\)"/.test(HTML_SRC),
   /ordNew: true/.test(OPS_SRC) && /it\.ordNew/.test(OPS_SRC)],
  [true, false, true]);

// ═══ 11. One way to create an order ═════════════════════════════════════════
// The modal is GONE — markup, styles and every om* function. Comments are
// stripped first, or the tombstone explaining the deletion reads as the thing
// still being there.
const HTML_CODE = HTML_SRC.replace(/<!--[\s\S]*?-->/g, '');
const CLIENT_CODE = stripComments(CLIENT_SRC);
check('the New-order modal is deleted: markup, styles and functions',
  [/id="om-bg"/.test(HTML_CODE),
   /id="om-done-bg"/.test(HTML_CODE),
   /om-sec-lbl|om-dropdown/.test(HTML_CODE),
   /function om[A-Z]/.test(CLIENT_CODE),
   /OM_LINES|OM_CUSTOMER|OM_DONE/.test(CLIENT_CODE)],
  [false, false, false, false, false]);
// Nothing anywhere still calls into it — a dead onclick is a button that throws.
check('no surviving caller references the deleted modal',
  (HTML_CODE.match(/\bom(Open|Close|Submit|Done|ShowPayResult|CopyPayLink|OpenQr)\s*\(/g) || [])
    .concat(CLIENT_CODE.match(/\bom(Open|Close|Submit|Done|ShowPayResult|CopyPayLink|OpenQr)\s*\(/g) || []),
  []);

// THE CAPABILITY THAT NEARLY WENT WITH IT. The deleted dialog was the only
// place a guest pay link could be read, and only for the seconds it was on
// screen — an operator who closed it, or who took the payment call an hour
// later, had no way back to it. It is a drawer tile now, so it outlives the
// moment of creation. Deleting a surface must not delete what it could do.
const payTileSrc = extractFn('orderPayLinkTile') || '';
check('the guest pay link survived the deletion, in the order drawer',
  [payTileSrc.length > 100,
   /orderPayLinkTile\(o\)/.test(extractFn('renderOpenOrder') || ''),
   /pay_token/.test(payTileSrc)],
  [true, true, true]);
// The same two conditions the server applies when it mints the link: unpaid,
// and something to pay. Run the real function.
const payTileHarness = new Function(`
  ${payTileSrc}
  return function (o) {
    globalThis.cuT = (en) => en;
    globalThis.copyChip = () => '';
    globalThis.escapeAttr = (s) => String(s);
    globalThis.location = { origin: 'https://store.example' };
    return orderPayLinkTile(o);
  };
`)();
check('the pay link shows only while unpaid, with a total and a token',
  [!!payTileHarness({ status: 'pending_payment', pay_token: 't', total: 100 }),
   !!payTileHarness({ status: 'paid', pay_token: 't', total: 100 }),
   !!payTileHarness({ status: 'pending_payment', pay_token: 't', total: 0 }),
   !!payTileHarness({ status: 'pending_payment', pay_token: null, total: 100 })],
  [true, false, false, false]);

// The client sends fulfillment_type on every write and never POSTs the customer
// separately — the two halves of the seam and the orphan, from the client side.
const srcCollect = extractFn('ordNewCollect') || '';
check('the page always sends fulfillment_type, and address only on delivery',
  [/fulfillment_type: ft/.test(srcCollect),
   /if \(ft === 'delivery'\) \{/.test(srcCollect),
   /save_customer = true/.test(srcCollect)],
  [true, true, true]);
const srcCreate = extractFn('ordNewCreate') || '';
// Named by endpoint, not counted: the handler legitimately makes a second call
// once the order exists — it deletes the draft that became it. A bare count of
// fetch( calls said "2" and could not tell that from the two-POST sequence this
// assertion exists to forbid.
const createFetches = (stripComments(srcCreate).match(/fetch\('([^']+)'/g) || [])
  .map(m => m.slice(7, -1));
check('the create path posts orders ONCE, clears its draft, and never posts a customer',
  [createFetches.filter(u => u === '/api/retail-admin/orders').length,
   createFetches.some(u => u.includes('/customers')),
   createFetches.filter(u => u.includes('/order-drafts')).length],
  [1, false, 1]);

// §1.12 in-flight, failure shape C: btn is captured synchronously, BEFORE the
// first await, because event.currentTarget is null once dispatch ends.
// Comments stripped: the comment explaining WHY sits above the line and says
// "awaits", so an ordering check against the raw text found the explanation
// before the code and called the capture late.
const createCode = stripComments(srcCreate);
check('the write captures its button before awaiting anything',
  [/const btn = \(ev && ev\.currentTarget\)/.test(createCode),
   createCode.indexOf('const btn =') < createCode.indexOf('await ')],
  [true, true]);
// Both exits disable together, then keep their names.
const srcBusy = extractFn('ordNewSetBusy') || '';
check('both exits disable while a write is in flight, then keep their names',
  [/\.onw-acts \.onw-btn/.test(srcBusy),
   /'Created'/.test(srcCreate),
   /'Saved'/.test(extractFn('ordNewSaveDraft') || '')],
  [true, true, true]);

// Errors are inline and persist. No toast is reachable from either exit — a
// toast confirms, and a failure the operator can miss is not an error state.
check('failures render inline, and neither exit can toast',
  [/ordNewShowError/.test(srcCreate),
   /toast\(/.test(srcCreate),
   /toast\(/.test(extractFn('ordNewSaveDraft') || '')],
  [true, false, false]);
// Every error code this endpoint can return needs BOTH a slot (which control it
// lands beside) and a sentence (what to do about it). A code with neither shows
// the operator a generic failure next to a field that may not be the wrong one.
// Read off the handler itself, so a new error added to the server without a home
// on the page fails here rather than in front of an operator.
const errWhere = CLIENT_SRC.slice(CLIENT_SRC.indexOf('const ONW_ERR_WHERE = {'),
                                  CLIENT_SRC.indexOf('function ordNewClearErrors'));
const errText = extractFn('ordNewErrText') || '';
// Two codes are BUILT, not written: `'address_not_allowed_for_' + fulfillmentType`
// and `'shipping_fee_not_allowed_for_' + fulfillmentType`. The scrape sees only
// the prefix; expand each to the two codes that can actually reach a client
// (fulfillmentType is 'pickup' or 'counter' by the time either check runs — the
// address rule already narrowed it to non-delivery, same as the fee rule below
// it), or the check asks the page for a slot no server ever sends.
const BUILT_PREFIXES = {
  'address_not_allowed_for_':      ['address_not_allowed_for_pickup', 'address_not_allowed_for_counter'],
  'shipping_fee_not_allowed_for_': ['shipping_fee_not_allowed_for_pickup', 'shipping_fee_not_allowed_for_counter'],
};
const SERVER_CODES = [...new Set(
  (ordersPost.match(/error: '([a-z_]+)'/g) || []).map(m => m.slice(8, -1))
)].flatMap(c => BUILT_PREFIXES[c] || [c]);
check('the error-code scrape found the handler\'s codes (not vacuously empty)',
  SERVER_CODES.length >= 10, true);
check('every error the order endpoint returns has a slot on the page',
  SERVER_CODES.filter(c => !errWhere.includes(c + ':')), []);
check('every error the order endpoint returns has a sentence',
  SERVER_CODES.filter(c => !errText.includes(c + ':')), []);

check('dynamic regions are shielded from the walker',
  ['onw-cust-results', 'onw-cust-chiprow', 'onw-phone-note', 'onw-prod-results', 'onw-lines-wrap']
    .map(id => new RegExp('id="' + id + '"[^>]*data-no-i18n').test(newSection)),
  [true, true, true, true, true]);


// ═══ 10. Drafts — a draft is not an order ═══════════════════════════════════
// THE ASSERTION THIS SECTION EXISTS FOR: a draft is absent from the order list
// and from every count. Proved against the real mirror queries — the same ones
// §3 uses for the worklist, the open-work chips and the status line — by
// running them before and after drafts exist.
db.exec(`
  CREATE TABLE retail_order_drafts (
    id INTEGER PRIMARY KEY, created_by INTEGER, owner_realm TEXT, payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
const orderListQ = `SELECT order_no FROM retail_orders ORDER BY id`;
const openWorkQ = `SELECT COUNT(*) AS n FROM retail_orders
                    WHERE status IN ('pending_payment','paid','preparing','dispatched','awaiting_restock')
                      AND COALESCE(channel,'') NOT IN ('meituan','gzgrocery')`;
const kpiTodayQ = `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev FROM retail_orders
                    WHERE status NOT IN ('cancelled')`;
const before = {
  list: db.prepare(orderListQ).all().map(r => r.order_no),
  open: db.prepare(openWorkQ).get().n,
  kpi:  db.prepare(kpiTodayQ).get(),
};
const DRAFT_PAYLOAD = JSON.stringify({
  form: { recipient_name: 'Half-typed', items: [{ product_id: 1, qty: 2, unit_price: 62 }], shipping_fee: 15 },
  lines: [{ product_id: 1, name_en: 'Osmanthus oolong', name_cn: '桂花乌龙', qty: 2, unit_price: 62 }],
  cust: 'guest', customer: null, saveCust: true,
});
db.prepare("INSERT INTO retail_order_drafts (id, created_by, owner_realm, payload) VALUES (1, 7, 'backend', ?)").run(DRAFT_PAYLOAD);
db.prepare("INSERT INTO retail_order_drafts (id, created_by, owner_realm, payload) VALUES (2, 7, 'backend', '{}')").run();
check('the draft fixture actually landed (the comparison is not vacuous)',
  db.prepare('SELECT COUNT(*) AS n FROM retail_order_drafts').get().n, 2);
const after = {
  list: db.prepare(orderListQ).all().map(r => r.order_no),
  open: db.prepare(openWorkQ).get().n,
  kpi:  db.prepare(kpiTodayQ).get(),
};
check('two drafts exist and the order list is unchanged', after.list, before.list);
check('two drafts exist and the open-work count is unchanged', after.open, before.open);
check('two drafts exist and the KPI count and revenue are unchanged', after.kpi, before.kpi);
// Those three are DESIGN guards: drafts live in their own table, so no order
// query can reach one, and no edit to retail.js can make them fail. What CAN
// fail — and what would break the guarantee — is an order query learning to
// read the drafts table. That claim is checked against the source, below, and
// it is the mutable half of this pair.
// A bounded region, not "everything after the banner": the order LIST handler
// sits below the draft endpoints in this file, so an open-ended region counted a
// drafts read inside the order list as legitimately placed. The region ends
// where that handler begins.
const DRAFTS_REGION_START = SERVER_SRC.indexOf('// ── Unfinished New-order forms');
const DRAFTS_REGION_END = SERVER_SRC.indexOf("router.get('/api/retail-admin/orders'", DRAFTS_REGION_START);
check('the drafts region anchors were found and are in order',
  DRAFTS_REGION_START !== -1 && DRAFTS_REGION_END > DRAFTS_REGION_START, true);
const draftTableHits = [];
for (let i = SERVER_SRC.indexOf('retail_order_drafts'); i !== -1;
     i = SERVER_SRC.indexOf('retail_order_drafts', i + 1)) draftTableHits.push(i);
check('the drafts table is read only by the draft endpoints, never by an order query',
  [draftTableHits.length > 0,
   draftTableHits.every(i => i > DRAFTS_REGION_START && i < DRAFTS_REGION_END)],
  [true, true]);
// Prove those three queries are not simply blind: an extra ORDER moves all of
// them. Without this the section above passes on a broken query just as happily
// as on a correct one.
db.prepare(`INSERT INTO retail_orders (id, order_no, status, channel, total, fulfillment_type)
            VALUES (99,'R-EXTRA','paid','manual',50,'delivery')`).run();
const withOrder = {
  list: db.prepare(orderListQ).all().map(r => r.order_no),
  open: db.prepare(openWorkQ).get().n,
  kpi:  db.prepare(kpiTodayQ).get(),
};
check('the same queries DO move for a real order — they are not blind',
  [withOrder.list.length === before.list.length + 1,
   withOrder.open === before.open + 1,
   withOrder.kpi.n === before.kpi.n + 1],
  [true, true, true]);
db.prepare('DELETE FROM retail_orders WHERE id = 99').run();

// The chip cannot become an order filter. It carries no data-status, so
// setOrderStatus can never select it and no query is asked for status='drafts'.
const chipMarkup = (ordersSection.match(/<div class="status-chip st-drafts"[^>]*>/) || [''])[0];
check('the Drafts chip is a view switch, never a status filter',
  [/id="ord-chip-drafts"/.test(chipMarkup),
   /onclick="ordShowDrafts\(\)"/.test(chipMarkup),
   /data-status/.test(chipMarkup)],
  [true, true, false]);
// And any status chip leaves the view, so there is one way back.
check('a status chip returns from the drafts view',
  /ordHideDrafts\(\)/.test(extractFn('setOrderStatus') || ''), true);

// Its own row shape — NOT the order table's columns. Four empty cells would
// read as a broken order.
const draftsView = HTML_SRC.slice(HTML_SRC.indexOf('id="ord-drafts-view"') - 400,
                                  HTML_SRC.indexOf('id="ord-drafts-view"') + 200);
const srcRenderDrafts = extractFn('ordRenderDrafts') || '';
check('drafts render their own rows, never the order table',
  [/odr-row/.test(srcRenderDrafts),
   /orders-table|order-row|oc-c-ord/.test(srcRenderDrafts),
   /<td|<th/.test(srcRenderDrafts)],
  [true, false, false]);
check('the drafts view is shielded from the walker (it carries names)',
  /id="ord-drafts-view"[^>]*data-no-i18n/.test(draftsView), true);

// The label ladder, run through the real function: customer, else guest, else
// first product plus how many more, else "Empty draft".
const labelHarness = new Function(`
  ${extractFn('ordDraftLabel')}
  return function (preview) {
    globalThis.cuT = (en) => en;
    return ordDraftLabel(preview);
  };
`)();
check('draft labels fall back in order: customer, guest, products, empty',
  [labelHarness({ kind: 'customer', label: 'Chen Jing' }).text,
   labelHarness({ kind: 'guest', label: 'Walk-in' }).text,
   labelHarness({ kind: 'products', label: 'Osmanthus oolong', extra: 2 }).text,
   labelHarness({ kind: 'products', label: 'Osmanthus oolong', extra: 0 }).text,
   labelHarness({ kind: 'empty' }).text,
   labelHarness(null).text],
  ['Chen Jing', 'Walk-in', 'Osmanthus oolong +2 more', 'Osmanthus oolong',
   'Empty draft', 'Empty draft']);
// An unlabelled draft is DESCRIBED, not named — the copy is set apart so it
// cannot be mistaken for a customer actually called "Empty draft".
check('the empty label is marked as a description, not a name',
  [labelHarness({ kind: 'empty' }).none, labelHarness({ kind: 'guest', label: 'Walk-in' }).none],
  [true, false]);

// The server preview: derived from whatever the payload happens to be, and
// never a sentence — it returns a KIND and raw names, because "Empty draft" and
// "+2 more" have to render in the operator's language.
const previewSrc = extractFn('draftPreview', SERVER_SRC) || '';
check('draftPreview was found in retail.js', previewSrc.length > 200, true);
const previewFn = new Function(`${previewSrc}; return draftPreview;`)();
check('the preview reads a real payload: kind, label, extra and total',
  (() => { const p = previewFn(DRAFT_PAYLOAD);
           return [p.kind, p.label, p.total]; })(),
  ['guest', 'Half-typed', 139]);
check('the preview survives an empty, a corrupt and a null payload',
  ['{}', 'not json at all', null].map(s => previewFn(s).kind),
  ['empty', 'empty', 'empty']);
check('the preview names the first product and counts the rest when nobody is named',
  (() => { const p = previewFn(JSON.stringify({
             form: { items: [{ qty: 1, unit_price: 10 }] },
             lines: [{ name_en: 'Osmanthus oolong', name_cn: '桂花乌龙' }, {}, {}],
           }));
           return [p.kind, p.label, p.label_cn, p.extra]; })(),
  ['products', 'Osmanthus oolong', '桂花乌龙', 2]);
// §1.11 — no English UI copy crosses the wire. The page builds the sentences.
check('the preview returns no UI sentences for the page to display',
  /Empty draft|more'|no drafts/i.test(previewSrc), false);


// ═══ 11. Stock — a counter sale takes the goods off the shelf, and a refund
//        puts them back ═════════════════════════════════════════════════════
// THE ASSERTION THIS SECTION EXISTS FOR: until 2026-08-20 a counter sale was
// booked, printed and counted as revenue while physical_qty never moved. It fell
// between two rules — a manual order never reserves, so the commit path was a
// no-op for it, and the only other decrement was gated on a Guangzhou ADDRESS,
// which a counter sale is forbidden to carry. Nothing errored. The shelf simply
// drifted by one sale at a time.
//
// The SECOND half is older and larger: commitUnreservedOrder's ledger reason
// 'order_prepare' was written in one place and read in none, so every
// out-of-Guangzhou and scheduled-ahead order decremented and never got its stock
// back on refund — the reversers looked for reservation rows those orders never
// had, found none, and returned zero. The scheduled-ahead case below is that
// bug; it needs a test or it comes back.
//
// RUN AGAINST THE REAL FUNCTIONS. commitUnreservedOrder and
// reverseCommittedLedger are extracted from lib/inventory.js and executed
// against this throwaway database, so drift is caught here rather than in a
// shop. Extraction rather than require() because lib/inventory.js opens the real
// database at load — the one thing this file must never do.
db.exec(`
  CREATE TABLE retail_store_stock (
    store_id INTEGER, product_id INTEGER, physical_qty INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME, UNIQUE(store_id, product_id)
  );
  CREATE TABLE retail_stock_ledger (
    id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER, delta INTEGER,
    reason TEXT, ref_table TEXT, ref_id INTEGER, balance_after INTEGER,
    actor_user_id INTEGER, actor_label TEXT, channel TEXT, note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE retail_stock_reservations (
    id INTEGER PRIMARY KEY, store_id INTEGER, product_id INTEGER, order_id INTEGER,
    qty INTEGER, channel TEXT, status TEXT, expires_at DATETIME,
    created_at DATETIME, committed_at DATETIME, released_at DATETIME
  );
`);

const INVENTORY_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'inventory.js'), 'utf8');
const STOCK_FNS = ['commitUnreservedOrder', 'reverseCommittedLedger'];
const stockSrc = {};
for (const n of STOCK_FNS) stockSrc[n] = extractFn(n, INVENTORY_SRC);
const stockMissing = STOCK_FNS.filter(n => !stockSrc[n]);
check('both stock functions were found in lib/inventory.js (extraction is intact)',
  stockMissing, []);

if (!stockMissing.length) {
  // The three things the extracted functions reach for that this harness has to
  // supply. `syncCalls` is not a stub to be ignored: the channel-sync enqueue is
  // WHY the decrement goes through this helper rather than adjustStock, so the
  // fact that it fires is asserted below, not assumed.
  const syncCalls = [];
  const stock = new Function('db', 'syncCalls', `
    const tdb = () => db;
    const enqueueChannelSync = (storeId, productId) => syncCalls.push(storeId + ':' + productId);
    const _bumpStockLive = () => {};
    ${STOCK_FNS.map((n) => stockSrc[n]).join('\n')}
    return { ${STOCK_FNS.join(', ')} };
  `)(db, syncCalls);

  const OAT = 910, MATCHA = 911;
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(1, OAT, 50);
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(1, MATCHA, 30);
  const qty = (pid) => db.prepare('SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = 1 AND product_id = ?').get(pid).q;
  const mkOrder = (id, ft) => db.prepare(
    "INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel) VALUES (?,?,?,?,1,'manual')"
  ).run(id, 'R-STK' + id, 'delivered', ft);

  // ── A counter sale decrements ──────────────────────────────────────────────
  mkOrder(9001, 'counter');
  const c1 = stock.commitUnreservedOrder(9001, [{ product_id: OAT, qty: 3 }],
    { actorLabel: 'Auto · counter sale (paid)' });
  check('a counter sale takes its units off the shelf',
    [c1.committed, qty(OAT)], [1, 47]);
  // The ledger row is ORDER-LINKED. That is the property adjustStock would have
  // destroyed (it writes ref_table='retail_store_stock', ref_id=NULL), and it is
  // what every "already decremented?" guard and the refund cap read.
  check('the decrement is recorded against the order, not against a bare stock row',
    db.prepare(`SELECT reason, ref_table, ref_id, delta FROM retail_stock_ledger
                 WHERE ref_id = 9001 AND product_id = ?`).all(OAT),
    [{ reason: 'order_prepare', ref_table: 'retail_orders', ref_id: 9001, delta: -3 }]);
  // Meituan/Eleme/Guanyi hear about it. A decrement they never see is an oversell
  // on a marketplace that still believes the unit is there.
  check('the decrement enqueues the channel sync', syncCalls.includes('1:' + OAT), true);

  // Re-firing must not double-count — markOrderPaid can run twice on a gateway
  // retry, and the admin Mark-paid path calls the same helper.
  const c2 = stock.commitUnreservedOrder(9001, [{ product_id: OAT, qty: 3 }], {});
  check('decrementing the same counter sale twice takes the units once',
    [c2.skipped, qty(OAT)], ['already_committed', 47]);

  // ── A refund gives them back ───────────────────────────────────────────────
  const r1 = stock.reverseCommittedLedger(9001, [{ product_id: OAT, qty: 3 }], { note: 'refund (full)' });
  check('refunding a counter sale returns its units',
    [r1.reversed, qty(OAT)], [3, 50]);
  check('the reversal enqueues the channel sync too',
    syncCalls.filter((s) => s === '1:' + OAT).length >= 2, true);

  // ── A second refund cannot return them again ──────────────────────────────
  // The cap is arithmetic, not a flag: still_out is the sum of the order's own
  // decrements minus the sum of its reversals, so there is nothing left to give.
  const r2 = stock.reverseCommittedLedger(9001, [{ product_id: OAT, qty: 3 }], { note: 'refund again' });
  check('refunding the same counter sale twice does NOT return the units twice',
    [r2.reversed, qty(OAT)], [0, 50]);

  // ── The older half of the bug: a scheduled-ahead order ────────────────────
  // Out-of-Guangzhou and scheduled-ahead orders skip the reserve gate and
  // decrement through this very same helper, so they were never reversed either.
  // This is not a counter-sale test; it is the regression guard for the larger
  // population the fix covers.
  mkOrder(9002, 'delivery');
  stock.commitUnreservedOrder(9002, [{ product_id: MATCHA, qty: 5 }], {});
  check('a scheduled-ahead delivery decrements the same way', qty(MATCHA), 25);
  const r3 = stock.reverseCommittedLedger(9002, [{ product_id: MATCHA, qty: 5 }], { note: 'refund' });
  check('refunding a scheduled-ahead order returns its stock (the pre-existing bug)',
    [r3.reversed, qty(MATCHA)], [5, 30]);

  // ── Partial refunds accumulate, and the last one is capped ────────────────
  // Two partials on one order are legitimate and must BOTH settle — which is why
  // the cap is computed rather than borrowed from reverseCommittedOrder's
  // single-'order_reverse'-row guard, which would have blocked the second.
  mkOrder(9003, 'counter');
  stock.commitUnreservedOrder(9003, [{ product_id: OAT, qty: 10 }], {});
  const p1 = stock.reverseCommittedLedger(9003, [{ product_id: OAT, qty: 4 }], { note: 'partial 1' });
  const p2 = stock.reverseCommittedLedger(9003, [{ product_id: OAT, qty: 4 }], { note: 'partial 2' });
  const p3 = stock.reverseCommittedLedger(9003, [{ product_id: OAT, qty: 4 }], { note: 'partial 3 — over-asks' });
  check('two partial refunds both settle, and a third is capped at what is left',
    [p1.reversed, p2.reversed, p3.reversed, qty(OAT)], [4, 4, 2, 50]);

  // ── A sale with no till is refused, by name rather than by silence ────────
  // The create route now refuses a counter sale with no store_id; the helper is
  // the second line of defence, and returns a NAMED skip rather than a zero that
  // reads like "nothing to do".
  db.prepare("INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id) VALUES (9004,'R-STK9004','delivered','counter',NULL)").run();
  check('a counter sale with no store is skipped by name, not silently',
    [stock.commitUnreservedOrder(9004, [{ product_id: OAT, qty: 1 }], {}).skipped,
     stock.reverseCommittedLedger(9004, [{ product_id: OAT, qty: 1 }], {}).skipped],
    ['no_store', 'no_store']);
}

// The two server-side rules that make the above coherent, asserted against the
// real source rather than re-implemented here: a counter sale must name its
// till, and the decrement must NOT be an adjustStock call.
check('the create route refuses a counter sale with no store',
  /fulfillmentType === 'counter' && !storeId/.test(SERVER_SRC)
  && /store_required_for_counter/.test(SERVER_SRC), true);
check('the counter decrement goes through prepareCommitUnreservedOrder, not adjustStock',
  /prepareCommitUnreservedOrder\(orderId, \{ actorLabel: 'Auto · counter sale \(paid\)' \}\)/.test(SERVER_SRC), true);

// ── PAID IS THE MOMENT, FOR EVERY ORDER ────────────────────────────────────
// The counter sale above fell between two rules. The larger half of the second
// rule was still standing until 2026-08-31: the paid-order decrement was gated
// on `isGuangzhouAddress(addr)`, so an out-of-city order — or one whose saved
// address simply did not parse as Guangzhou, a district with no city on it —
// kept its units on the shelf until a person clicked Start preparing.
//
// That is not a quiet delay. The hard out-of-stock gate in POST /orders reads
// physical_qty, so a shelf that only moves by hand answers "5 left" to the next
// shopper, and the next, for as many orders as arrive between the payment and
// the click. A shop that sets a count expects the count to answer for it.
//
// Both settle routes are pinned, because an order settled off-app through the
// drawer is the same sale as one settled by the gateway and must not move the
// shelf differently. The admin route's decrement used to fire for counter sales
// alone (an isTerminalOnPaid test stood in front of it) — hence the second half
// of that check.
const MARK_PAID_SRC = extractFn('markOrderPaid', SERVER_SRC) || '';
check('markOrderPaid was found in routes/retail.js (extraction is intact)',
  MARK_PAID_SRC !== '', true);
check('markOrderPaid decrements every paid order, with no address test in front of it',
  /prepareCommitUnreservedOrder\(orderId, \{ actorLabel: 'Auto · paid' \}\)/.test(MARK_PAID_SRC)
  && !/isGuangzhouAddress/.test(MARK_PAID_SRC), true);
check('the admin Mark paid route decrements every order, not counter sales alone',
  /\[inventory\.commit \(admin paid\)\]/.test(SERVER_SRC)
  && (SERVER_SRC.match(/isTerminalOnPaid\(/g) || []).length === 1, true);


// ═══ 12. The counter till's manual settle ═══════════════════════════════════
// THE ASSERTION THIS SECTION EXISTS FOR: a walk-in settles by HAND. The cashier
// reads the total off the tablet, keys it into a separate payment terminal, and
// records which wallet took it. That wallet is the ONLY link between the sale
// and the terminal's daily statement — there is no gateway callback to fall
// back on, because there is no gateway. If it is absent, or silently defaulted,
// the day does not reconcile and nothing on any screen says so.
//
// Three things are pinned here: the tender the till sends is stored, the shelf
// moves, and a counter sale cannot be created without naming a wallet.
//
// Production has no Alipay credentials, so the QR settle a one-code design
// would need cannot work at all — and WeChat and Alipay payment codes are
// mutually unreadable, so one code could never have served both. Manual is not
// a stopgap here; it is the permanent floor a scan mode would sit beside.

const TILL_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const ORDERS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js'), 'utf8');

// ── The three vocabularies must be ONE ────────────────────────────────────
// The server's create allowlist, the server's Mark-paid set, and the till's
// wallet picker are three lists of the same thing in three files. They were two
// different sets before the till existed (create knew 'offline', Mark-paid knew
// 'wechat_offline'), which is exactly how a walk-in used to record as a tender
// nobody could reconcile. Drift between them is silent — a value the till can
// send but the route rejects is a 400 at the counter, in front of a customer.
function listFrom(src, re) {
  const m = re.exec(src);
  if (!m) return null;
  return (m[1].match(/'([a-z_]+)'/g) || []).map(s => s.replace(/'/g, '')).sort();
}
const allowedPay = listFrom(SERVER_SRC, /const ALLOWED_PAY = \[([\s\S]*?)\];/);
const offlineSet = listFrom(SERVER_SRC, /const OFFLINE_PAY_METHODS = new Set\(\[([\s\S]*?)\]\)/);
const tillWallets = (TILL_SRC.match(/\{ v: '([a-z_]+)'/g) || [])
  .map(s => s.replace(/.*'([a-z_]+)'.*/, '$1')).sort();
const adminChoices = listFrom(ORDERS_SRC, /const PAY_METHOD_CHOICES = \[([\s\S]*?)\];/);

check('the create route accepts every off-app tender the Mark-paid set knows',
  offlineSet && allowedPay ? offlineSet.filter(m => !allowedPay.includes(m)) : 'EXTRACTION FAILED',
  []);
check('the till offers exactly the admin\'s own tender list — no private vocabulary',
  tillWallets, adminChoices);
check('the till\'s tenders are all values the create route will accept',
  allowedPay && tillWallets ? tillWallets.filter(w => !allowedPay.includes(w)) : 'EXTRACTION FAILED',
  []);

// ── The wallet is NOT nullable on a counter sale ──────────────────────────
// The rule has to read what ARRIVED, not the resolved value: `paymentMethod`
// has already collapsed an absent or unknown tender to 'offline' by the time
// the guard runs, so a check on it would pass on exactly the input it exists to
// refuse. This asserts the guard reads `b.payment_method`.
const counterPayRule = /if \(fulfillmentType === 'counter'\) \{[\s\S]{0,320}?payment_method_required_for_counter/;
check('a counter sale is refused when no wallet is named',
  counterPayRule.test(SERVER_SRC), true);
check('the wallet guard reads what ARRIVED, not the defaulted value',
  /const sentPay = b\.payment_method == null \? '' : String\(b\.payment_method\);/.test(SERVER_SRC), true);
// Only counter. A delivery legitimately has no tender at create — nobody has
// paid yet — and requiring one there would refuse every phone order.
check('the wallet rule binds to counter alone, not to every manual order',
  (SERVER_SRC.match(/payment_method_required_for_counter/g) || []).length, 1);

// Behavioural mirror of the two lines above, so the RULE is tested and not just
// its spelling. Mirrored from routes/retail.js (the ALLOWED_PAY fallback and
// the counter guard); if either moves, the assertions above fail first and name
// which.
function createGuardMirror(body) {
  const allowed = allowedPay || [];
  const sentPay = body.payment_method == null ? '' : String(body.payment_method);
  if (body.fulfillment_type === 'counter' && !body.store_id) return 'store_required_for_counter';
  if (body.fulfillment_type === 'counter' && !allowed.includes(sentPay)) return 'payment_method_required_for_counter';
  return allowed.includes(sentPay) ? sentPay : 'offline';
}
check('a counter sale with no wallet, an unknown wallet, or no store is refused',
  [createGuardMirror({ fulfillment_type: 'counter', store_id: 1 }),
   createGuardMirror({ fulfillment_type: 'counter', store_id: 1, payment_method: '' }),
   createGuardMirror({ fulfillment_type: 'counter', store_id: 1, payment_method: 'venmo' }),
   createGuardMirror({ fulfillment_type: 'counter', payment_method: 'cash' })],
  ['payment_method_required_for_counter', 'payment_method_required_for_counter',
   'payment_method_required_for_counter', 'store_required_for_counter']);
check('a named wallet is stored as sent, and a delivery still needs no tender',
  [createGuardMirror({ fulfillment_type: 'counter', store_id: 1, payment_method: 'wechat_offline' }),
   createGuardMirror({ fulfillment_type: 'counter', store_id: 1, payment_method: 'alipay_offline' }),
   createGuardMirror({ fulfillment_type: 'delivery' })],
  ['wechat_offline', 'alipay_offline', 'offline']);

// ── Marked paid: the wallet is recorded AND the shelf moves ───────────────
// One sale, end to end, against the real decrement. The order row carries the
// tender the till chose; retail_payments carries the same value; physical_qty
// drops by what was rung up. All three or the day does not reconcile.
if (!stockMissing) {
  const syncCalls2 = [];
  const stock2 = new Function('db', 'syncCalls', `
    const tdb = () => db;
    const enqueueChannelSync = (storeId, productId) => syncCalls.push(storeId + ':' + productId);
    const _bumpStockLive = () => {};
    ${STOCK_FNS.map((n) => stockSrc[n]).join('\n')}
    return { ${STOCK_FNS.join(', ')} };
  `)(db, syncCalls2);

  db.exec(`CREATE TABLE retail_payments_t12 (
    id INTEGER PRIMARY KEY, order_id INTEGER, method TEXT, amount REAL, status TEXT
  );`);
  const TEA = 912;
  db.prepare('INSERT INTO retail_store_stock (store_id, product_id, physical_qty) VALUES (?,?,?)').run(1, TEA, 20);

  // What POST /orders writes for a till sale: the order with the chosen wallet,
  // a payment row with the same method, then markOrderPaid's decrement.
  db.prepare(
    "INSERT INTO retail_orders (id, order_no, status, fulfillment_type, store_id, channel, payment_method) VALUES (9101,'TC-9101','delivered','counter',1,'manual','wechat_offline')"
  ).run();
  db.prepare(
    "INSERT INTO retail_payments_t12 (order_id, method, amount, status) VALUES (9101,'wechat_offline',96,'success')"
  ).run();
  stock2.commitUnreservedOrder(9101, [{ product_id: TEA, qty: 4 }], { actorLabel: 'Auto · counter sale (paid)' });

  const row = db.prepare('SELECT payment_method FROM retail_orders WHERE id = 9101').get();
  const payRow = db.prepare('SELECT method FROM retail_payments_t12 WHERE order_id = 9101').get();
  const left = db.prepare('SELECT physical_qty AS q FROM retail_store_stock WHERE store_id = 1 AND product_id = ?').get(TEA).q;
  check('a settled counter sale records the chosen wallet on the order AND the payment',
    [row.payment_method, payRow.method], ['wechat_offline', 'wechat_offline']);
  check('a settled counter sale takes its units off the shelf', left, 16);
  check('the settle enqueues the channel sync, so the marketplaces hear about it',
    syncCalls2.includes('1:' + TEA), true);
  // The wallet is not merely present — it is a value the reconciliation can use.
  check('the recorded wallet is one the daily statement can be matched against',
    (allowedPay || []).includes(row.payment_method) && row.payment_method !== 'offline', true);
}

// ── The till sends the counter path, and only that path ──────────────────
check('the till creates a counter sale, already paid, at a named store',
  [/fulfillment_type: 'counter'/.test(TILL_SRC),
   /status: 'paid'/.test(TILL_SRC),
   /store_id: S\.storeId/.test(TILL_SRC)],
  [true, true, true]);
check('the till posts to the ordinary manual-order endpoint, not a private one',
  (TILL_SRC.match(/api\('\/api\/retail-admin\/orders'/g) || []).length, 1);
// The wallet reaches the body through the settle MODE, which is the seam a scan
// mode would slot into. If someone inlines the tender instead, the seam is gone
// and the next payment method is a rewrite rather than an entry.
check('the wallet reaches the request through the settle-mode seam',
  /payload: function \(st\) \{ return \{ payment_method: st\.wallet \}; \}/.test(TILL_SRC), true);
check('the manual mode refuses to confirm without a wallet',
  /ready: function \(st\) \{ return !!st\.wallet; \}/.test(TILL_SRC), true);
// Receipt printing is automatic on settle (markOrderPaid → autoPrintOrder). The
// till's own print control is therefore a SECOND copy, and must not present
// itself as the primary action.
check('the till offers reprint as a secondary control, not a primary one',
  [/data-print="1"[^>]*>' \+ esc\(printLabel\)/.test(TILL_SRC) || /class="dsec" type="button" data-print/.test(TILL_SRC),
   /class="dprim" type="button" data-go="reset"/.test(TILL_SRC)],
  [true, true]);

// ── Every Chinese string on the till is copied, never composed ────────────
// The locked-vocabulary rule (docs/tacet-delivery-vocabulary.md rule 4) says CN
// strings are copied from a locked source. The till declares its sources in a
// STRINGS table; this asserts the table is the ONLY place Chinese enters the
// page, so a stray composed label cannot slip in beside it.
const tillCn = (TILL_SRC.match(/[一-鿿]+/g) || []);
const stringsBlock = (/var STRINGS = \{[\s\S]*?\n  \};/.exec(TILL_SRC) || [''])[0];
const walletsBlock = (/var WALLETS = \[[\s\S]*?\n  \];/.exec(TILL_SRC) || [''])[0];
const authCn = (/请先在后台登录[^']*/g);
const declared = new Set(
  ((stringsBlock + walletsBlock).match(/[一-鿿]+/g) || [])
);
// The one CN string outside those two blocks is the signed-out line, which is
// reused verbatim in two places; it is listed here rather than left unexplained.
((TILL_SRC.match(authCn) || []).join('').match(/[一-鿿]+/g) || []).forEach(x => declared.add(x));
// Two more that are not translatable copy and are declared rather than ignored:
//   微软雅黑  — a CJK fallback FACE in the font stack, a font name.
//   中文      — the language toggle's own label. It always renders in the
//             language it switches TO, so it is never translated. The
//             expression is byte-identical to the live admin's
//             (retail-admin.html:11878, 10-extras.js:903).
['微软雅黑', '中文'].forEach(x => declared.add(x));
const stray = [...new Set(tillCn)].filter(x => !declared.has(x));
check('no Chinese on the till outside its declared string table', stray, []);
check('the till declares a locked source for every string it renders',
  /admin: |vocab: |admin$/m.test(stringsBlock) && stringsBlock.split('\n').filter(l => /\/\/ admin|\/\/ vocab/.test(l)).length >= 10,
  true);


// ═══ 13. The drawer renders a counter sale ═════════════════════════════════
// THE ASSERTION THIS SECTION EXISTS FOR: opening a counter sale in the order
// drawer must not throw. It did, for every counter sale ever made, and the
// operator saw "Failed" with no message because a second bug ate the text
// (§12's banner fix is what finally let the drawer say what was wrong:
// "Cannot read properties of null (reading 'urgencyDate')").
//
// THE SHAPE OF IT, because the fix is not where the crash was. shipByPlan()
// returns null for a counter sale ON PURPOSE — paid and handed over in one
// moment, so there is no deadline, no window and no requested timing. That
// null is correct and documented at its return. What was missing was any
// caller honouring it: the ORDERS LIST guards counter upstream and never calls
// its renderer, but the DRAWER called renderShipByTile() unconditionally, so
// shipByUrgency() dereferenced a null plan.
//
// So the rule under test is not "counter has a plan" — it is "a null plan is a
// legal answer and every consumer survives it". The fix omits the tile rather
// than defaulting a date, because any date available to fall back on
// (placed_at, paid_at) would render as a promise the shop never made.
//
// RUN AGAINST THE REAL FUNCTIONS, whole-file. Every top-level function and
// const in 04-orders.js is loaded into one sandbox, so no helper is missing and
// nothing is stubbed except the browser globals the file closes over. That
// matters more here than in §11: the bug was an INTERACTION between two
// functions that each looked correct alone.

const ORDERS_JS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'retail-admin', '04-orders.js'), 'utf8');

function orderBlocks(src) {
  const L = src.split('\n');
  const out = { code: [], names: [] };
  for (let i = 0; i < L.length; i++) {
    const fn = /^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/.exec(L[i]);
    const cn = /^const ([A-Z_][A-Z0-9_]*) = [{[]/.exec(L[i]);
    if (fn) {
      for (let j = i + 1; j < L.length; j++) {
        if (/^\}/.test(L[j])) { out.code.push(L.slice(i, j + 1).join('\n')); out.names.push(fn[1]); i = j; break; }
      }
    } else if (cn) {
      for (let j = i + 1; j < L.length; j++) {
        if (/^\};|^\];/.test(L[j])) { out.code.push(L.slice(i, j + 1).join('\n')); i = j; break; }
      }
    }
  }
  return out;
}

const OB = orderBlocks(ORDERS_JS);
check('the drawer sandbox loaded a real slice of 04-orders.js (not vacuously empty)',
  OB.code.length > 150, true);

// The browser globals the file closes over. Deliberately dumb: if a helper
// needs more than this it will throw a ReferenceError naming what it wants,
// which is a legible failure rather than a silent pass.
const DRAWER_SANDBOX = `
  var cuT = (en) => en, CN = () => false, can = () => true, canAny = () => true;
  var TRACKING_CARRIERS = [], _OPEN_ORDER = null, _ODM_OPEN = false, ORDERS = [];
  var _ITEMS_SORT_MODE = 'sku', _ORD_PAGE_MODE = false, _ORDER_BACK_CUSTOMER = null;
  var document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(){}, removeEventListener(){},
    createElement: () => ({ style:{}, classList:{ add(){}, remove(){}, toggle(){} }, setAttribute(){},
                            appendChild(){}, querySelector: () => null, querySelectorAll: () => [] }),
    body: { classList: { add(){}, remove(){}, toggle(){}, contains: () => false } } };
  var window = { addEventListener(){}, removeEventListener(){},
                 matchMedia: () => ({ matches: false, addEventListener(){} }) };
  var localStorage = { getItem: () => null, setItem(){} };
  function escapeHtml(s){ return String(s == null ? '' : s); }
  function escapeAttr(s){ return escapeHtml(s); }
  // The tenant's currency helpers, from 01-core.js. The drawer's money used to
  // be a hardcoded ¥ and now goes through these (audit D-03 / I-01), so without
  // them renderOrderTotalBanner and renderSortableItems throw a ReferenceError
  // — which this suite correctly reported as "the helper does not survive".
  // Stubbed to the default currency, the one these assertions are written for.
  function acCurrencySymbol(){ return '¥'; }
  function acWrap(formatted){ return '¥' + String(formatted); }
  function acMoney(n, dp){
    var places = Number.isInteger(dp) ? dp : 2;
    return '¥' + Number(n || 0).toLocaleString('en-US',
      { minimumFractionDigits: places, maximumFractionDigits: places });
  }
  function acMoneyCompact(n){ return acMoney(n, 0); }
  function fmt(n){ return Number(n || 0).toFixed(2); }
  function thumbUrl(){ return ''; }
  function paymentBrandHTML(){ return ''; }
  function toast(){}
  function api(){ return Promise.resolve({ data: [] }); }
  function $(){ return null; }
  function $$(){ return []; }
  function tdWhen(){ return 'Aug 21'; }
  function tdRange(){ return ''; }
  function tdDate(){ return 'Aug 21'; }
  ${OB.code.join('\n')}
  return { shipByPlan, shipByUrgency, renderShipByTile, renderShipByCell, renderDeliveryCell, ordIsCounter };
`;

let DRAWER = null;
try { DRAWER = new Function(DRAWER_SANDBOX)(); }
catch (e) { console.log('    drawer sandbox failed: ' + e.message); }
check('the drawer sandbox evaluates', !!DRAWER, true);

if (DRAWER) {
  const baseOrder = {
    id: 1248, order_no: 'TC000331', status: 'delivered', channel: 'manual',
    payment_method: 'wechat_offline', recipient_name: 'Guest', recipient_phone: null,
    subtotal: 44, total: 44, shipping_fee: 0, packing_fee: 0,
    placed_at: '2026-08-20 09:38:19', paid_at: '2026-08-20 09:38:19',
    delivered_at: '2026-08-20 09:38:19', updated_at: '2026-08-20 09:38:19',
    store_id: 1, seen_at: 'x', print_status: 'printed', printed_at: '2026-08-20 09:38:19',
    source: 'manual', created_by: 1, pay_token: 'abc', customer_id: null, nickname: null,
    scheduled_for: null, delivery_slot_label: null, delivery_slot_kind: null,
    promised_ship_date: null, promised_delivery_date: null, ship_by_mode: null,
    address_json: null, address: null, address_full: null,
    items: [{ id: 1, product_id: 64, name_en: 'Wraps', name_cn: '卷饼', sku: '3-270',
              qty: 1, unit_price: 44, line_total: 44, ship_modes: 'air' }],
    payments: [{ id: 1, method: 'wechat_offline', amount: 44, status: 'success', out_trade_no: 'TC000331' }],
    shipments: [], reservations: [], addons: [], stock_pending: false,
  };
  const shape = (over) => Object.assign({}, baseOrder, over);
  // Every renderer call below goes through this. A regression must print a
  // NAMED failing assertion, not crash the gate with a stack trace — the whole
  // point of the section is to say WHICH shape broke.
  const safe = (fn) => { try { return fn(); } catch (e) { return 'THREW: ' + e.message; } };

  // ── The reported bug, at every status a counter sale can hold ────────────
  // Three, not one: the crash was in shipByUrgency, whose behaviour branches on
  // `actionable` (paid/preparing). A fix that only covered the delivered case
  // would leave the till's own pending→paid window broken.
  const COUNTER_STATES = ['delivered', 'paid', 'pending_payment', 'preparing', 'refunded', 'cancelled'];
  const counterThrows = COUNTER_STATES.filter((st) => {
    try { DRAWER.renderShipByTile(shape({ fulfillment_type: 'counter', status: st })); return false; }
    catch (e) { return true; }
  });
  check('the drawer tile renders a counter sale at every status it can hold',
    counterThrows, []);

  // The null is the CORRECT answer, not an accident to be defaulted away.
  check('a counter sale has no ship-by plan at all',
    DRAWER.shipByPlan(shape({ fulfillment_type: 'counter' })), null);
  // …and the tile is OMITTED rather than filled with a borrowed date. Asserting
  // the empty string is the point: a tile showing placed_at would render as a
  // deadline the shop never promised, and would still pass a does-not-throw test.
  check('no plan means no tile — never a tile with a substituted date',
    safe(() => DRAWER.renderShipByTile(shape({ fulfillment_type: 'counter' }))), '');
  // The list cell and the drawer tile must agree about the same null.
  check('the orders-list cell agrees, and shows a dash rather than crashing',
    safe(() => /—/.test(DRAWER.renderShipByCell(shape({ fulfillment_type: 'counter' })))), true);
  // shipByUrgency takes the plan directly, so it is a caller away from the same
  // crash. It tolerates the documented null on its own.
  check('urgency tolerates a null plan without being handed one by a guard',
    (() => { try { DRAWER.shipByUrgency(null, true); DRAWER.shipByUrgency(null, false); return 'ok'; }
             catch (e) { return e.message; } })(), 'ok');

  // ── Every other shape with no delivery, so the fix is not counter-shaped ──
  // The question that mattered was whether this reached wider than counter —
  // a pickup with no slot, a manual delivery with no address, an order whose
  // fulfilment type never got written. It does not: shipByPlan returns a plan
  // object for all of them and only null for counter. These rows are here to
  // keep that true, because the next person to add a `return null` will not
  // remember that two callers dereference it.
  const SHAPES = [
    ['pickup, no slot',          { fulfillment_type: 'pickup' }],
    ['pickup, with slot',        { fulfillment_type: 'pickup', scheduled_for: '2026-08-21 14:30:00', delivery_slot_label: '14:30-15:30' }],
    ['delivery, no address',     { fulfillment_type: 'delivery' }],
    ['delivery, asap',           { fulfillment_type: 'delivery', ship_by_mode: 'asap' }],
    ['delivery, fresh batch',    { fulfillment_type: 'delivery', promised_ship_date: '2026-08-22' }],
    ['delivery, scheduled',      { fulfillment_type: 'delivery', scheduled_for: '2026-08-23 10:00:00' }],
    ['fulfilment type missing',  { fulfillment_type: null }],
    ['read-only mirror channel', { fulfillment_type: 'delivery', channel: 'meituan' }],
  ];
  const shapeThrows = SHAPES.filter(([, over]) => {
    try { DRAWER.renderShipByTile(shape(over)); DRAWER.renderShipByCell(shape(over)); return false; }
    catch (e) { return true; }
  }).map(([label]) => label);
  check('every other order shape still renders, delivery or not', shapeThrows, []);

  // ── The whole drawer payload, not just the tile that broke ───────────────
  // §12 covers the till; this covers what the operator opens afterwards. Every
  // helper renderOpenOrder calls on the order object, run against a real
  // counter sale. Named individually so a failure says WHICH one, rather than
  // "the drawer".
  const DRAWER_HELPERS = ['renderShipByTile', 'fulfillmentShortStrip', 'hoistedTracking',
    'routingNote', 'rerouteShortNote', 'orderHeadPrint', 'orderHeadMarks', 'orderHeadMore',
    'orderStatusPill', 'orderItemNames', 'orderPayLinkTile', 'renderAddonTimeline',
    'renderAlipayProof', 'renderOrderTotalBanner', 'drawerRefundBanner', 'addressChangedNote',
    'splitSuggestionBanner', 'shipmentMergeControls', 'renderSortableItems', 'renderRefundPanel',
    'undoDispatchable', 'undoPreparable', 'nextStatusFor', 'renderTrackingCell'];
  const available = DRAWER_HELPERS.filter((n) => OB.names.includes(n));
  check('the drawer-helper list still matches what 04-orders.js exports',
    available.length >= 20, true);

  const wide = new Function(DRAWER_SANDBOX.replace(
    'return { shipByPlan, shipByUrgency, renderShipByTile, renderShipByCell, renderDeliveryCell, ordIsCounter };',
    'return { ' + available.join(', ') + ' };'))();
  const counter = shape({ fulfillment_type: 'counter' });
  const helperThrows = available.filter((n) => {
    try { wide[n](counter); return false; } catch (e) { return true; }
  });
  check('every drawer helper survives an order with no delivery, no parcel and no customer',
    helperThrows, []);
}

// ═══ 14. The settled-refund slip ═══════════════════════════════════════════
// A completed refund prints paper. Three routes can complete one, so the guard
// that keeps the customer from being handed two slips is asserted here as well
// as the slip itself.
//
// THE ASSERTION THIS SECTION EXISTS FOR is (c) below: no Chinese string on this
// slip may be composed for it. Every CJK run the template emits has to already
// exist somewhere else in the tree — that is the rule stated as code rather than
// as a habit, and it is the one that will still be enforced when nobody
// remembers the conversation. Two labels were cut from this template by exactly
// this check (退回 Back to, 单号 Ref) and replaced with the English-only form the
// receipt's own `Paid by` row already uses.

const _feieMod = require(path.join(__dirname, '..', 'lib', 'feie.js'));
check('lib/feie.js exports a settled-refund template',
  typeof _feieMod.renderRefundReceipt, 'function');

const RF_BASE = {
  order_no: 'TC000331', total: 44, refund_amount_paid: 44,
  recipient_name: 'Guest', recipient_phone: '13800000000',
  paid_at: '2026-08-20 09:38:19', refund_paid_at: '2026-08-20 09:40:00',
  refund_payout_method: 'wechat_offline', refund_payout_ref: 'R-9931',
};
const RF_SHAPES = [
  ['counter, full',    { fulfillment_type: 'counter' }, []],
  ['counter, partial', { fulfillment_type: 'counter' },
    [{ sku: '3-270', name_en: 'Wraps', name_cn: '卷饼', qty: 1, amount: 44 }]],
  ['delivery, full',   { fulfillment_type: 'delivery' }, []],
  ['pickup, partial',  { fulfillment_type: 'pickup' },
    [{ sku: '9-001', name_en: 'A very long product name that will wrap', name_cn: '一个非常长的产品名称', qty: 12, amount: 480.5 }]],
  ['a very large amount', { refund_amount_paid: 99999999.99 }, []],
  ['nothing set at all', {}, null],
];
const rfRender = (over, lines) =>
  _feieMod.renderRefundReceipt(Object.assign({}, RF_BASE, over), lines, 'Roots');

const rfThrows = RF_SHAPES.filter(([, over, lines]) => {
  try { rfRender(over, lines); return false; } catch (e) { return true; }
}).map(([label]) => label);
check('the refund slip renders for every order shape, including an empty one', rfThrows, []);

// The template source, read once — (a) and (c) both measure it.
const RF_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'feie.js'), 'utf8');
const rfBody = RF_SRC.slice(RF_SRC.indexOf('function renderRefundReceipt'));
// TOP-LEVEL FUNCTION BODY, WHATEVER THE LINE ENDINGS ARE.
//
// These slices used to end at the literal '\n}\n' — a closing brace alone on a
// line. That never matches a CRLF file, where the sequence is '}\r\n', so
// indexOf returned -1, slice() ran to the end of the file, and assertions that
// were meant to read ONE function silently read everything after it. Three of
// them broke the moment a co-session's merge brought routes/retail.js back as
// CRLF; on an LF checkout they had been passing by luck.
//
// A no-match returns '' rather than the rest of the file, so a bad slice fails
// its check instead of quietly passing a wider one.
function fnBodyFrom(src, at) {
  if (at === -1) return '';
  const m = /\r?\n\}\r?\n/.exec(src.slice(at));
  return m ? src.slice(at, at + m.index + m[0].length) : '';
}
const rfTemplate = fnBodyFrom(rfBody, 0);
check('the refund template was located in lib/feie.js', rfTemplate.length > 400, true);

const cjkWidth = (t) => [...t].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︰-﹏＀-￯]/.test(c) ? 2 : 1), 0);

// (a) §1.20 — ONLY the enlarged lines get a hard budget. `<B>` and `<CB>` are
// double-WIDTH, so they hold 16 columns and drop the overflow SILENTLY off the
// END; `<BOLD>` is normal width and WRAPS instead — confirmed on paper at
// docs/tacet-desktop-patterns.md:1179 ("`<B>` and `<CB>` double; `<BOLD>` does
// not"). So a long `<BOLD>` product name is not a defect, it is two lines, and
// asserting 31 on it would fail the shipping request slip too, which emits item
// names exactly the same way. What must never overflow is a line that would
// silently lose its own amount, and nothing about that failure is visible until
// it is on paper in a shop.
const overWide = [];
for (const [label, over, lines] of RF_SHAPES) {
  for (const ln of rfRender(over, lines).split('\n')) {
    const big = /^<(CB|B)>(.*)<\/\1>$/.exec(ln);
    if (big && cjkWidth(big[2]) > 16) overWide.push(`${label}: ${big[2]} (${cjkWidth(big[2])}/16)`);
  }
}
check('no enlarged line on the refund slip overflows its 16-column budget', overWide, []);

// The AUTHORED normal-width strings do have to fit without wrapping — unlike an
// item name, nobody passes these in, so a wrap here is a design slip rather than
// data being long. Literals only: anything with an interpolation is data.
const fixedNorm = [...rfTemplate.matchAll(/<(BOLD|C)>([^`$<]*)<\/\1>/g)]
  .map((m) => m[2]).filter((t) => /\S/.test(t));
check('the refund slip has authored normal-width lines to measure', fixedNorm.length > 0, true);
check('every authored normal-width line fits 31 columns without wrapping',
  fixedNorm.filter((t) => cjkWidth(t) > 31), []);

// (b) A counter buyer is standing at the till. The name typed only to satisfy a
// required field must not print back at them, exactly as the receipt suppresses
// it. Asserted as a PAIR against a shape that HAS a name and phone, so a
// template that simply never emitted them would fail the second row rather than
// passing the first vacuously.
check('a counter refund slip prints no recipient name or phone',
  /^(To|Tel) /m.test(rfRender({ fulfillment_type: 'counter' }, [])), false);
check('a delivery refund slip still prints them',
  /^To /m.test(rfRender({ fulfillment_type: 'delivery' }, [])), true);

// (c) THE LOCKED-SOURCE RULE, MECHANISED. Chinese on a slip is either a string
// that already ships somewhere in this tree or it is invented, and invented is
// not allowed. Search the whole tree minus the template itself: a run that
// appears ONLY inside renderRefundReceipt has no source.
const treeFiles = [];
(function walk(dir, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/\.(js|html|md|json)$/.test(e.name)) treeFiles.push(full);
  }
})(path.join(__dirname, '..'), 0);
const HAYSTACK = treeFiles.map((f) => {
  try {
    const t = fs.readFileSync(f, 'utf8');
    return f.endsWith('feie.js') ? t.split(rfTemplate).join('') : t;
  } catch (e) { return ''; }
}).join('\n');
// Only STRING literals — the comments in this template discuss 退回 precisely to
// explain why it is NOT used, and a comment prints nothing.
const rfLiterals = rfTemplate.replace(/^\s*\/\/.*$/gm, '');
const cjkRuns = [...new Set((rfLiterals.match(/[一-鿿]+/g) || []))];
check('the refund slip emits Chinese at all (so this check is not vacuous)',
  cjkRuns.length > 0, true);
const unsourced = cjkRuns.filter((run) => !HAYSTACK.includes(run));
check('every Chinese string on the refund slip already exists elsewhere in the tree — none composed for it',
  unsourced, []);

// (d) The once-only guard, read from the route file. A fourth refund-completion
// route is the thing that breaks this, and it will be written by someone who
// never saw this slip.
const RET_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');
const missingCall = ['refund/payout', 'refund/direct'].filter((r) => {
  const at = RET_SRC.indexOf(`'/api/retail-admin/orders/:id/${r}'`);
  if (at === -1) return true;
  const nextRoute = RET_SRC.indexOf('\nrouter.', at + 10);
  return !RET_SRC.slice(at, nextRoute === -1 ? undefined : nextRoute).includes('autoPrintRefundReceipt(');
});
check('every operator refund-completion route prints the settled slip', missingCall, []);
check('the PATCH /status refunded shortcut prints it too',
  /if \(status === 'refunded'\)[\s\S]{0,4000}?autoPrintRefundReceipt\(/.test(RET_SRC), true);
// The guard is the WRITE, not a read-then-write: two routes racing on one order
// must not both see a null and both print.
check('the print claim is a conditional UPDATE, so it cannot double-print under a race',
  /UPDATE retail_orders SET refund_printed_at = CURRENT_TIMESTAMP WHERE id = \? AND refund_printed_at IS NULL/.test(RET_SRC), true);
check('a failed send releases the stamp so the refund can print later',
  /releaseRefundPrintStamp/.test(RET_SRC), true);
// The refund slip must not disturb the ORIGINAL order slip's bookkeeping —
// printed_at describes what was BOUGHT and stays valid paper after a refund.
const rcpBody = RET_SRC.slice(RET_SRC.indexOf('function autoPrintRefundReceipt'));
check('printing a refund slip never touches print_status or printed_at',
  /\bprint_status\b|[^_]\bprinted_at\b/.test(fnBodyFrom(rcpBody, 0)), false);
// And the column it DOES use has to exist, or every print silently no-ops.
check('refund_printed_at is a real column',
  /addColumn\('retail_orders', 'refund_printed_at'/.test(
    fs.readFileSync(path.join(__dirname, '..', 'database.js'), 'utf8')), true);

// ═══ 15. The till installs on both platforms ═══════════════════════════════
// A till that installs on one hardware family dictates the shop's hardware,
// which for a product sold to any business is the same as not shipping it.
//
// THE RULE THIS SECTION EXISTS FOR: the two install paths are SEPARATE and
// neither substitutes for the other. Android Chrome installs from the manifest;
// iOS Safari ignores nearly all of it and reads the apple-* meta tags instead
// (and Safari is the only iOS browser that can install a PWA at all, so there
// is no second chance there). Every assertion below is paired for that reason —
// deleting either half must fail, not quietly halve the supported devices.

const TILL = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const POS_TILL_SRC = TILL;
const TILL_HEAD = TILL.slice(0, TILL.indexOf('</head>'));
check('till.html has a head to read', TILL_HEAD.length > 200, true);

// ── Android / Chrome half ────────────────────────────────────────────────
check('the till links a manifest (Android Chrome installs from this)',
  /<link[^>]+rel="manifest"[^>]+href="\/till-manifest\.webmanifest"/.test(TILL_HEAD), true);
const MANI_PATH = path.join(__dirname, '..', 'public', 'till-manifest.webmanifest');
check('the manifest file exists', fs.existsSync(MANI_PATH), true);
let MANI = null;
try { MANI = JSON.parse(fs.readFileSync(MANI_PATH, 'utf8')); } catch (e) { MANI = null; }
check('the manifest is valid JSON', !!MANI, true);
if (MANI) {
  check('the manifest installs standalone rather than as a tab', MANI.display, 'standalone');
  check('the manifest scope and start_url point at the till',
    [MANI.start_url, MANI.scope], ['/till', '/till']);
  // Android needs a maskable icon or it puts the square artwork in a circle
  // and crops the corners off.
  check('the manifest ships both an "any" and a "maskable" icon purpose',
    ['any', 'maskable'].filter((p) => (MANI.icons || []).some((i) => i.purpose === p)),
    ['any', 'maskable']);
  // RASTER ONLY. stock-manifest.webmanifest ships SVG, which Android tolerates
  // and iOS ignores outright — sharing raster icons across both paths is what
  // lets one set of files serve both.
  const svgIcons = (MANI.icons || []).filter((i) => /svg/i.test(i.type || '') || /\.svg$/i.test(i.src));
  check('no manifest icon is an SVG (iOS will not use one)', svgIcons, []);
  // Every icon has to be on disk at the size it claims, or the install silently
  // falls back to a letter tile.
  const badIcons = [];
  for (const ic of MANI.icons || []) {
    const f = path.join(__dirname, '..', 'public', ic.src.replace(/^\//, ''));
    if (!fs.existsSync(f)) { badIcons.push(ic.src + ' missing'); continue; }
    const b = fs.readFileSync(f);
    if (b.slice(1, 4).toString() !== 'PNG') { badIcons.push(ic.src + ' not a PNG'); continue; }
    const dim = b.readUInt32BE(16) + 'x' + b.readUInt32BE(20);
    if (dim !== ic.sizes) badIcons.push(ic.src + ' is ' + dim + ', manifest claims ' + ic.sizes);
  }
  check('every manifest icon exists at the size it declares', badIcons, []);
}
// The manifest is useless if nothing serves it.
const SRV = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('server.js serves the till manifest',
  /app\.get\('\/till-manifest\.webmanifest'/.test(SRV), true);

// ── iOS / Safari half ────────────────────────────────────────────────────
check('the till declares apple-mobile-web-app-capable (iOS standalone)',
  /<meta[^>]+name="apple-mobile-web-app-capable"[^>]+content="yes"/.test(TILL_HEAD), true);
check('the till names itself for the iOS home screen',
  /<meta[^>]+name="apple-mobile-web-app-title"/.test(TILL_HEAD), true);
// WITHOUT THIS iOS PUTS A SCREENSHOT OF THE PAGE ON THE HOME SCREEN.
const appleIcon = /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/.exec(TILL_HEAD);
check('the till declares an apple-touch-icon', !!appleIcon, true);
if (appleIcon) {
  const f = path.join(__dirname, '..', 'public', appleIcon[1].replace(/^\//, ''));
  check('the apple-touch-icon file exists', fs.existsSync(f), true);
  if (fs.existsSync(f)) {
    const b = fs.readFileSync(f);
    check('the apple-touch-icon is a PNG (iOS ignores SVG here)', b.slice(1, 4).toString(), 'PNG');
    // iPadOS asks for 152 (iPad) and 167 (iPad Pro) and downsamples the largest
    // declared icon. 180 is the largest iOS requests, so one 180 covers every
    // iPad size — but anything SMALLER than 180 gets upscaled and looks it.
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    check('the apple-touch-icon is at least 180x180, so iPadOS downsamples rather than upscales',
      [w >= 180, h >= 180], [true, true]);
    check('the apple-touch-icon is square', w, h);
  }
}

// ── The escape from the payment takeover ─────────────────────────────────
// iOS standalone has NO swipe-back gesture, so the Back control is the only way
// out of the settle screen. It sits in .stop, a flex:none sibling — but that
// alone did not protect it: with the middle unable to scroll, a tall wallet list
// drew straight over the top of it (measured at 1024x480: Back on screen and
// untappable). The scroll is what makes the guarantee hold at any height.
const smain = /\.smain\{[^}]*\}/.exec(TILL.replace(/\s+/g, ' ').replace(/\/\*.*?\*\//g, ''));
check('the settle body is scrollable, so nothing can overlay the way out',
  !!(smain && /overflow-y:\s*auto/.test(smain[0])), true);
check('the settle body centres safely, so tall content is not centred out of reach',
  !!(smain && /align-items:\s*safe center/.test(smain[0])), true);
check('the settle screen still has a Back control at all',
  /class="back"/.test(TILL), true);

// ── Both aspect ratios ───────────────────────────────────────────────────
// iPad is 4:3, most Android tablets are 16:10, and the rail is flex:none — so
// the entry side absorbs every pixel of the difference and the column count is
// the thing that has to give. Without these the grid stays at 4 columns and
// .tile's overflow:hidden clips product names with no visible sign it did.
check('the product grid adapts its column count for narrow tablets',
  (TILL.match(/@media \(max-width:\d+px\)\{ ?\.grid\{grid-template-columns/g) || []).length >= 2, true);

// ── The phone ────────────────────────────────────────────────────────────
// The till shipped as a two-column layout with a 380px flex:none rail, so on a
// 375px phone the rail claimed 380 of them: the running total and Mark paid sat
// off the right edge, reachable only by horizontal scroll, with nothing on
// screen to say half the till was over there. Below the two-column floor the
// rail stops being a column and becomes a section under the products.
const phoneBlock = (() => {
  const i = POS_TILL_SRC.indexOf('@media (max-width:700px){\n  .t-body{flex-direction:column}');
  const j = POS_TILL_SRC.indexOf('@media (max-width:700px){\r\n  .t-body{flex-direction:column}');
  const k = i === -1 ? j : i;
  if (k === -1) return '';
  return POS_TILL_SRC.slice(k, POS_TILL_SRC.indexOf('\n}', k) + 2);
})();
check('the till stacks its rail under the products on a phone', phoneBlock.length > 100, true);
// OUT OF FLOW. The rail became a bottom SHEET rather than a stacked strip: in
// flow it competed with the product grid for the same column and lost, ending
// as a two-line list nobody could read. Absolute positioning is what lets the
// grid keep the whole screen while the order keeps a full-height home.
check('the sheet is out of flow, so the product grid keeps the screen',
  // [^}]* — bounded to .t-order's OWN body. With [\s\S]*? this reached
  // .sheet-scrim's position:absolute further down and passed while .t-order had
  // none, which is a green light for the exact bug it exists to catch.
  /\.t-order\{[^}]*position:absolute/.test(phoneBlock), true);
// A DEFINITE height, not a cap on content: .lines flexes and scrolls inside it,
// which is what keeps the total and the pay button pinned at every basket size.
check('the sheet has a definite height, so its list can scroll inside it',
  /\.t-order\{[^}]*height:86%/.test(phoneBlock), true);
// Closed by default and translated away — the products are the working surface.
check('the sheet is closed until it is asked for',
  /\.t-order\{[^}]*transform:translateY\(101%\)/.test(phoneBlock), true);
check('and opens on a class the render pass owns',
  /\.till\.sheet-open \.t-order\{transform:translateY\(0\)\}/.test(phoneBlock), true);
// THE OVERRIDE BLOCK MUST COME LAST. .t-order, .lines, .smain, .samt, .spick and
// .sconf are all declared further up at the SAME specificity; written any
// earlier the base rules win and the whole media query silently does nothing.
// It WAS written earlier the first time, and the rail kept computing to 380px
// inside a 375px viewport with no error anywhere.
const phoneAt = POS_TILL_SRC.indexOf('.t-body{flex-direction:column}');
const railAt = POS_TILL_SRC.indexOf('.t-order{');
const smainAt = POS_TILL_SRC.indexOf('.smain{');
check('the phone override block is the LAST word in the stylesheet, after every rule it overrides',
  [phoneAt > railAt, phoneAt > smainAt], [true, true]);

// ── The store control ────────────────────────────────────────────────────
// Boot READ localStorage 'tacet-till-store' to reopen on the last store used.
// Nothing ever WROTE it, so the lookup always missed, the pick fell through to
// the first store, and a second location was unreachable — the store name was a
// <span>, not a control.
check('the store name is a control, not a caption',
  /<button class="t-store" id="hd-store" type="button" data-store>/.test(POS_TILL_SRC), true);
check('choosing a store WRITES the preference boot reads back',
  /localStorage\.setItem\('tacet-till-store'/.test(POS_TILL_SRC), true);
check('the preference is still read at boot, so the write has a reader',
  /localStorage\.getItem\('tacet-till-store'\)/.test(POS_TILL_SRC), true);
// Switching shelf means switching stock; the catalogue must be re-read rather
// than left showing the previous store's.
check('switching store re-reads the catalogue', /function switchStore[\s\S]{0,600}loadCatalogue\(\)/.test(POS_TILL_SRC), true);
check('switching store drops the previous shelf', /function switchStore[\s\S]{0,900}S\.stock = \{\}/.test(POS_TILL_SRC), true);
// A basket is priced and stock-checked against ONE store.
check('the store cannot change under a basket', /canSwitch = S\.stores\.length > 1 && !S\.lines\.length/.test(POS_TILL_SRC), true);
// The picker's id must not sit one character from the settle screen's .spick
// wallet list — this file already carries a note about that class of collision.
check('the store picker does not collide with the settle wallet list',
  [/id="storepick"/.test(POS_TILL_SRC), /id="spick"/.test(POS_TILL_SRC)], [true, false]);

// ── The order sheet ──────────────────────────────────────────────────────
// The first phone layout stacked the rail under the products and capped it, so
// the order list was a two-line strip and the customer control owned a full row
// of the most valuable space on the screen. The order is now a BAR that opens a
// full-height sheet; the rail element itself becomes that sheet, so there is one
// order list in the DOM rather than two that can disagree.
check('the phone bar exists, carrying the count and the total',
  [/id="tbar"/.test(POS_TILL_SRC), /id="bar-ct"/.test(POS_TILL_SRC),
   /id="bar-amt"/.test(POS_TILL_SRC), /id="bar-pay"/.test(POS_TILL_SRC)],
  [true, true, true, true]);
// THE BUG THIS ROW EXISTS FOR: the handler was written and the control was
// drawn, but [data-sheet] was never added to the delegated selector, so the bar
// did nothing at all. Handler and selector have to move together.
// The selector list is UNORDERED: what matters is that [data-sheet] is IN it,
// not that it is last. Pinning it to the end made this fail the moment d7a71ee
// added [data-back],[data-leave] after it — a red gate over a till that works,
// which blocks every unrelated deploy behind it and teaches people to wave the
// gate through. The guarantee is unchanged; only the position is no longer part
// of it.
check('the order sheet is reachable — data-sheet is in the click delegation',
  /closest\('\[data-add\][^']*\[data-sheet\][^']*'\)/.test(POS_TILL_SRC), true);
check('opening and closing the sheet are both wired',
  [/data-sheet="open"/.test(POS_TILL_SRC), /data-sheet="close"/.test(POS_TILL_SRC)], [true, true]);
// The sheet must not survive into the settle takeover, whose whole point is
// that nothing of the till stays readable behind it.
check('the sheet is forced shut when the till leaves its own view',
  /if \(S\.view !== 'till'\) S\.sheetOpen = false;/.test(POS_TILL_SRC), true);
// Every phone-only element must be inert on a tablet, and — the trap that has
// now caught this file twice — those defaults must be declared ABOVE the
// override block or they win and the phone layout silently does nothing.
// COMMENTS STRIPPED FIRST. The comment above these defaults quotes the very
// rule it is describing, so a plain indexOf found the prose — the real rule
// could then be moved below the override block and this still passed.
const tillNoComments = POS_TILL_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
const defaultsAt = tillNoComments.indexOf('.t-bar{display:none}');
const overrideAt = tillNoComments.indexOf('.smain{flex-direction:column');
check('the phone-only furniture is inert on a tablet',
  [defaultsAt !== -1, /\.sheet-grab\{display:none\}/.test(tillNoComments),
   /\.tile \.incart\{display:none\}/.test(tillNoComments)], [true, true, true]);
check('those defaults are declared ABOVE the override block, or they would win',
  defaultsAt !== -1 && overrideAt !== -1 && defaultsAt < overrideAt, true);
// The tablet's stepper behaviour is unchanged: the strip is emitted for every
// line now, and CSS shows it only for the selected one.
check('the tablet still reveals a stepper only on the selected line',
  /\.ln\.sel \+ \.lctl\{display:flex\}/.test(POS_TILL_SRC), true);
// A stepper on every row cannot key off S.sel — it would bump whichever line
// happened to be selected, or none.
check('quantity changes name the line they act on',
  /function bumpQty\(d, idx\)/.test(POS_TILL_SRC), true);
check('removing a line clears the selection, because indexes shift under it',
  /S\.lines\.splice\(i, 1\);[\s\S]{0,300}S\.sel = null;/.test(POS_TILL_SRC), true);
// With the sheet closed by default the tile badge is the ONLY confirmation a
// tap landed, which makes it load-bearing rather than decorative.
check('a product tile shows how many of it are in the basket',
  /inc > 0 \? '<span class="incart">' \+ inc/.test(POS_TILL_SRC), true);

// ── The quantity control ─────────────────────────────────────────────────
// Each of -, the count and + carried its own border with 10px of air between
// them, so one quantity read as three floating chips and the number they change
// looked like it belonged to neither button. They share a border now, divided
// by hairlines.
check('the quantity control is one unit, not three chips',
  /<span class="qgrp">/.test(POS_TILL_SRC) && /\.qgrp\{[^}]*border:1px solid/.test(POS_TILL_SRC), true);
check('the buttons inside it drop their own borders',
  /\.step\{[^}]*border:0/.test(POS_TILL_SRC), true);
// Grouping must not shrink the targets — this is a counter, operated by thumb.
check('the targets stay 52px inside the group',
  /\.step\{[^}]*width:52px;height:52px/.test(POS_TILL_SRC), true);
check('the count is divided from the buttons by hairlines, not gaps',
  /\.stepn\{[^}]*border-left:1px solid/.test(POS_TILL_SRC), true);
// THE INK EDGE BELONGS TO THE SELECTED STATE, not to the strip. Every line
// carries a strip on a phone, so a bar on the strip itself painted one on all
// of them and claimed a selection the screen did not have.
check('the selected-line edge is a state, not a property of every strip',
  /\.lctl\{[^}]*border-left:3px solid transparent/.test(POS_TILL_SRC)
  && /\.lctl\.sel\{border-left-color:var\(--td-text\)\}/.test(POS_TILL_SRC), true);
// …and on a phone it marks nothing at all, because every strip is already open.
check('a phone shows no selected-line edge',
  /\.lctl\.sel\{border-left-color:transparent\}/.test(POS_TILL_SRC), true);

// The strip had padding-top:0 against 12px at the bottom, so the group's top
// border landed exactly on the line's bottom border — measured at a 0px gap —
// and the two hairlines read as one thick seam through the row.
check('the stepper does not sit on the line above it',
  /\.lctl\{[^}]*padding:12px 16px 12px 13px/.test(POS_TILL_SRC), true);

// ── The tile footer ──────────────────────────────────────────────────────
// A tile is 140px at four columns, leaving ~116px of content. "Out of stock"
// is ~88px of that and the price another ~45: they never both fitted, and
// adding the product code only made the overflow show sooner — the label broke
// across two lines and rendered as "Ou"/"stc".
//
// So a sold-out tile shows the REASON instead of the price. The price of
// something that cannot be sold is not a number anyone acts on, and the slot
// itself is unchanged, which is the rule that actually matters: the tile stays
// where the thumb expects it, dimmed, dashed and not tappable.
check('a sold-out tile shows the reason instead of a price it would crowd',
  /\? '<span class="lo">' \+ esc\(T\('outOfStock'\)\)/.test(POS_TILL_SRC), true);
check('and carries no product code, which identifies something unsellable',
  /: \(p\.sku \? '<span class="sku">'/.test(POS_TILL_SRC), true);
// A pill that wraps is not a pill.
check('the stock pill holds its shape rather than breaking in half',
  /\.tile \.lo\{[^}]*white-space:nowrap/.test(POS_TILL_SRC), true);
// An in-stock tile still shows all three when the shelf is low — there the
// pill is a single digit and fits.
check('an in-stock tile still shows code, price and a low-stock count',
  /left != null && left <= 5 \? '<span class="lo">' \+ left/.test(POS_TILL_SRC), true);
// The strikethrough had one job and nothing left to strike.
check('no dead strikethrough rule survives the price it styled',
  /\.tile\.out \.pr\{text-decoration:line-through\}/.test(POS_TILL_SRC), false);

// ── Attaching a customer ─────────────────────────────────────────────────
// It was window.prompt(): an unstyleable box captioned with the origin
// ("store.rootskitchenchina.com says"), which could not show what it found and
// took the FIRST match of pageSize=1 — so two customers sharing a given name
// were a coin toss nobody saw. It is a Tacet sheet now, and it shows its work.
//
// COMMENTS STRIPPED before the search: the replacement's own comment names
// window.prompt to explain what it replaced, and a rule that a comment can
// satisfy is a rule that stops holding.
const tillCode = POS_TILL_SRC.replace(/^\s*\/\/.*$/gm, '');
check('the till opens no browser dialogs',
  (tillCode.match(/window\.(prompt|alert|confirm)\s*\(/g) || []), []);
check('the customer picker is a Tacet sheet, sharing the store picker\'s idiom',
  /id="custpick"/.test(POS_TILL_SRC) && /<div class="ssheet cust-sheet">/.test(POS_TILL_SRC), true);
// A row has to carry enough to tell two people apart AND the two numbers a
// cashier is asked for at the counter.
// SCOPED TO THE ROW RENDERER. Checked against the whole file these pass from
// the attached-customer chip, which shows points and wallet too — so the row
// could lose them and the assertion would still be green. It was.
const custRowSrc = (() => {
  const i = POS_TILL_SRC.indexOf('function renderCustResults');
  return i === -1 ? '' : POS_TILL_SRC.slice(i, POS_TILL_SRC.indexOf('\n  }', i));
})();
check('the row renderer was located', custRowSrc.length > 200, true);
check('a result row shows who they are and what they hold',
  [/class="cwho"/.test(custRowSrc), /c\.phone/.test(custRowSrc),
   /T\('points'\)/.test(custRowSrc), /T\('wallet'\)/.test(custRowSrc)],
  [true, true, true, true]);
// THE CARET TRAP: rebuilding the shell on every keystroke replaces the <input>
// being typed into. The shell is built once and only the rows redraw.
check('the search shell is built once, so typing does not lose the caret',
  /data-built/.test(POS_TILL_SRC) && /function renderCustResults/.test(POS_TILL_SRC), true);
// A slow reply for "Li" must not land after a fast one for "Li Wei".
check('a stale search reply cannot overwrite a newer one',
  /mine !== _custToken/.test(POS_TILL_SRC), true);
check('the search is debounced rather than one query per keystroke',
  /clearTimeout\(_custTimer\)/.test(POS_TILL_SRC), true);
// Nothing typed yet is not the same as nothing found and must not say so.
check('an untouched search shows no empty-state',
  /S\.custRows === null.*?innerHTML = ''/.test(POS_TILL_SRC), true);
// 'pick' OPENS the picker and is the + Customer button's long-standing value;
// the row action is 'use'. Merging them broke the button on the first pass.
check('the row action does not collide with the button that opens the picker',
  [/data-cust="use"/.test(POS_TILL_SRC), /act === 'use'/.test(POS_TILL_SRC)], [true, true]);
// SEARCH-ONLY, by decision: a customer who does not exist yet is created in the
// backend. No create path is wired here, and none should appear by accident.
check('the till does not create customers',
  /POST[\s\S]{0,40}retail-admin\/customers/.test(tillCode), false);

// A bare number is one a cashier reads off this very screen — '#43' is how a
// nameless account renders — so it has to find that customer, not only orders.
// Read locally rather than leaning on SERVER_SRC from an earlier section: a
// section that cannot run standalone is a section nobody checks before a push,
// which is exactly how the last gate failure reached CI.
const custSearchSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');
check('a numeric search finds the customer id itself',
  /ors\.push\('id = \?'\)/.test(custSearchSrc), true);

// ── The product code ─────────────────────────────────────────────────────
// Search already matches on SKU — typing a code filters the grid — so the code
// that produced a match was the one thing the screen would not show back. It
// appears on the tile and on the order line, and the LINE has to carry it:
// S.lines held only id/name/price/qty, so there was nothing to render from.
check('a basket line carries the product code, not just its name',
  /S\.lines\.push\(\{ id: id, name: pname\(p\), sku: p\.sku/.test(POS_TILL_SRC), true);
check('the code shows on the order line and on the tile',
  [/<div class="sb">' \+ \(l\.sku/.test(POS_TILL_SRC),
   /\(p\.sku \? '<span class="sku">'/.test(POS_TILL_SRC)], [true, true]);
// On a tile the PRICE must never be what a long code squeezes out.
check('the tile price is protected against a long code',
  /\.tile \.pr\{flex:none\}/.test(POS_TILL_SRC)
  && /\.tile \.sku\{[^}]*text-overflow:ellipsis/.test(POS_TILL_SRC), true);
// No monospace exists in Tacet; Inter's tabular figures give the alignment that
// would otherwise be the reason to reach for one.
check('the code is set in tabular figures, not a monospace face',
  /\.sku\{[^}]*font-variant-numeric:tabular-nums/.test(POS_TILL_SRC)
  && !/\.sku\{[^}]*monospace/.test(POS_TILL_SRC), true);

// ── A closed counter is shown, not hidden ────────────────────────────────
// Filtering closed stores out of the picker was the first shape of this, and it
// read as a broken button: a store that vanishes and a control that does
// nothing are indistinguishable from behind a counter.
check('every active store reaches the picker, closed counters included',
  /S\.stores = list;/.test(POS_TILL_SRC) && !/list = openList;/.test(POS_TILL_SRC), true);
check('only the OPENING pick is restricted to a counter that is open',
  /var pick = openList\.filter/.test(POS_TILL_SRC), true);
check('a closed counter is labelled in the picker rather than dropped',
  /shutlb[\s\S]{0,80}T\('closed'\)/.test(POS_TILL_SRC), true);
check('a closed counter cannot be selected',
  /if \(st && !storeOpen\(st\)\) return render\(\);/.test(POS_TILL_SRC), true);
// Unknown status counts as OPEN, matching the server's own fail-open rule.
check('an unread channel status leaves every counter open',
  /function storeOpen\(st\) \{ return !S\.posOpen \|\| S\.posOpen\[st\.code\] !== false; \}/.test(POS_TILL_SRC), true);

// ═══ 16. POS is a sales channel, and closing it closes something ═══════════
// THE ASSERTION THIS SECTION EXISTS FOR: a channel toggle that changes nothing
// is worse than no toggle. An operator who closes POS at a store believes the
// counter is shut; if the till kept selling, it would also keep taking stock off
// that store's shelf, and the belief would be discovered wrong by a stock count
// rather than by a screen. So "the card exists" is not what is checked here —
// what is checked is that the switch reaches the sale.

const POS_MA = fs.readFileSync(path.join(__dirname, '..', 'routes', 'meituan-admin.js'), 'utf8');
const POS_RT = fs.readFileSync(path.join(__dirname, '..', 'routes', 'retail.js'), 'utf8');
const POS_CORE = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin', '01-core.js'), 'utf8');
const POS_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin.html'), 'utf8');
const POS_CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'retail-admin.css'), 'utf8');
const POS_TILL = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');

// ── It is a channel in the grid, on the same terms as the rest ───────────
const posGridLine = /const GRID_CHANNELS = \[([^\]]+)\]/.exec(POS_MA);
check('the sales grid declares its channels', !!posGridLine, true);
if (posGridLine) {
  const list = posGridLine[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  check('pos is one of them', list.includes('pos'), true);
  // Everything downstream in that file is generic over GRID_CHANNELS: the cell
  // read/write, the "close all" for a channel, and the location master. pos must
  // NOT be special-cased the way gzgrocery is (tianhe-only), or a two-store shop
  // gets one row.
  check('pos is not restricted to a single store the way gzgrocery is',
    /channel === 'gzgrocery' \? all\.filter/.test(POS_MA) && !/'pos'\s*\?/.test(POS_MA), true);
  // The location master closes every applicable channel; pos riding in
  // GRID_CHANNELS is what makes "close this location" also shut its till.
  check('closing a whole location covers pos, because it iterates GRID_CHANNELS',
    /const applies = GRID_CHANNELS\.filter/.test(POS_MA), true);
}

// ── Closing it actually refuses the sale ─────────────────────────────────
const posOrdersStart = POS_RT.indexOf("router.post('/api/retail-admin/orders', requireRetailAdmin");
const posOrdersEnd = POS_RT.indexOf('\nrouter.', posOrdersStart + 10);
const posOrdersSrc = POS_RT.slice(posOrdersStart, posOrdersEnd === -1 ? undefined : posOrdersEnd);
check('the create-order handler was located', posOrdersSrc.length > 2000, true);
check('a counter sale is refused when the counter is closed',
  // ANCHORED ON THE `if (` so the guard's real form is pinned. Without that
  // anchor a short-circuit prefix — `false && fulfillmentType === ...` — still
  // satisfies the match while disabling the check entirely, and that exact
  // mutation escaped the first version of this assertion.
  /if \(fulfillmentType === 'counter' && posClosedForStore\(storeId\)\) \{/.test(posOrdersSrc), true);
// 409, not 400: the request is well-formed and would succeed once reopened.
check('the refusal is a conflict, not a validation error',
  /status\(409\)[\s\S]{0,120}pos_closed_for_store/.test(posOrdersSrc), true);
// COUNTER ONLY — closing the counter must not stop a delivery.
check('no other fulfilment type is gated on the pos channel',
  (posOrdersSrc.match(/posClosedForStore\(/g) || []).length, 1);

const posHelperSrc = (() => {
  const i = POS_RT.indexOf('function posClosedForStore');
  if (i === -1) return '';
  // Sliced here rather than through §14's helper so this section still runs
  // standalone — a section that only works as part of the whole file is one
  // nobody can check before a push, and that is how two failures reached CI.
  // /\r?\n\}\r?\n/ because a CRLF checkout ends the line '}\r\n': a literal
  // '\n}\n' matches nothing there, and the slice silently widens to the rest
  // of the file.
  const m = /\r?\n\}\r?\n/.exec(POS_RT.slice(i));
  return m ? POS_RT.slice(i, i + m.index + m[0].length) : '';
})();
check('the reader exists at module scope', posHelperSrc.length > 100, true);
// ABSENT ROW = OPEN. Every tenant that has never touched the toggle has no
// channel_status row at all; a check written as `is_open !== 1` would read that
// absence as closed and shut every counter on the platform the day this ships.
check('an absent channel_status row means OPEN, not closed',
  /cell && cell\.is_open === 0/.test(posHelperSrc), true);
check('a shop-wide fulfilment close also closes the counter',
  /fulfillment_open === 0/.test(posHelperSrc), true);
// FAILS OPEN. A status lookup that throws must not stop a shop selling.
check('the reader fails open on any error',
  /catch \(e\) \{ return false; \}/.test(posHelperSrc), true);
check('the reader asks for the pos channel specifically',
  /channel = 'pos'/.test(posHelperSrc), true);

// ── The card, wired the same way the other five are ──────────────────────
check('the channel key map knows pos', /ps: 'pos'/.test(POS_CORE), true);
// csRender finds a card by the id of its revenue metric; without this element
// the toggle silently stays locked and the operator can never close POS.
check('the Sales page has a POS card csRender can find',
  /id="sales-ps-rev"/.test(POS_HTML), true);
check('all four POS metrics have somewhere to land',
  ['rev', 'orders', 'aov', 'extra'].filter((k) => !POS_HTML.includes('id="sales-ps-' + k + '"')), []);
check('the summary fills them', /fill\('ps', c\.pos\)/.test(POS_CORE), true);
check('the card icon has a style of its own', /\.sales-ch-ico\.ps \{/.test(POS_CSS), true);
// The channel name is a LOCKED pair, not composed: 'Counter sale · 前台销售'
// is what the order drawer already prints (04-orders.js:5334).
check('the channel name reuses the locked Counter sale pair',
  /pos: cuT\('Counter sale', '前台销售'\)/.test(POS_CORE), true);

// ── The money actually counts ────────────────────────────────────────────
// KEYED BY FULFILMENT TYPE. A counter sale used to carry channel='manual'
// exactly like a phone order an operator typed in, so a channel-based query
// would sweep both into the POS card and overstate the till. The bucket now
// also excludes the two daemon channels, whose own cards claim their rows —
// the six Sales buckets have to be a partition or the page's total drifts from
// the dashboard's (scripts/test_sales_summary_partition.js). fulfillment_type
// is still what SELECTS the till's sales; the exclusion only fences the edges.
check('POS revenue is keyed on fulfillment_type, not on channel',
  /const ps = storeAgg\("fulfillment_type='counter'/.test(POS_RT), true);
check('POS appears in the sales summary payload', /^\s*pos:\s*\{ connected: true/m.test(POS_RT), true);

// ── The till respects it before the cashier builds a basket ──────────────
check('the till reads the channel grid', /channel-status/.test(POS_TILL), true);
check('the till keeps only stores whose counter is open',
  /posOpen\[st\.code\] !== false/.test(POS_TILL), true);
// Same fail-open contract as the server: a status read that dies must not shut
// a shop's till. `.catch(function () { return null; })` is what guarantees it.
check('the till fails open when the channel grid cannot be read',
  /api\('\/api\/retail-admin\/channel-status'\)\.catch\(function \(\) \{ return null; \}\)/.test(POS_TILL), true);
// Every counter closed is a STATE, said in the grid's own locked words.
check('the till has a locked string for the closed state',
  /closed:\s*\['Closed', '已关闭'\]/.test(POS_TILL), true);

// ── Report ──────────────────────────────────────────────────────────────────
// §8's by-phone classifier is asserted through the REAL async function, so the
// report waits on it: report() is called from that promise's settle handlers,
// never from here. Every synchronous check has already registered by then —
// microtasks run only once this file's top-level code finishes.
function report() {
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
}
