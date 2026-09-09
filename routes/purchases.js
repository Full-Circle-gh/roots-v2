const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { logActivity } = require('../middleware/auth');
// The one cost-per-recipe-unit derivation — shared so purchasing cannot drift
// from what the ingredient form computes. See lib/ingredient-cost.js.
const { deriveCostPerUnit, normaliseUnit } = require('../lib/ingredient-cost');
// Finance category text — the one normalisation. See lib/category-text.js.
const { storeCategory } = require('../lib/category-text');
// The no-invoice mark and invoice_status are one fact in two columns; every
// write of either goes through here so the two can never contradict each other.
const { setNoInvoiceMark, setPONoInvoiceMark, setLineInvoiceStatus } = require('../lib/invoice-mark');
const { nextKitchenPONumber } = require('../lib/po-number');
const { supersedingCopy } = require('../lib/po-supersede');
// Goods that arrived, were accepted, and went BACK. One definition site for
// both receive endpoints and for every screen that reports the money — see the
// header of lib/po-returns.js before touching anything below that nets a
// return out of a quantity.
const { planReturns, billableQtySql, resolveQty } = require('../lib/po-returns');
// The nested-recipe recompute (§29 step 3) — fired after a PO price
// write-back moves a non-linked ingredient's cost, since that can move a
// linked material's recipe-derived cost transitively. See lib/recipe-rollup.js.
const { fireRecompute } = require('../lib/recipe-rollup');
const { blockCostWrite, blockCostWriteIf } = require('../middleware/block-kitchen-cost-writes');
const router = express.Router();

// ── Receipt reasons ─────────────────────────────────────────────────────────
// Why a line's received count came in BELOW what was ordered. Validated the
// same way invoice_status is: a fixed set, checked server-side, no free text.
//
// DAMAGE IS NOT A REASON. It has its own quantity (po_line_items.damaged_qty)
// and it happens on lines that are not short at all — 20 of 20 arrived, 2 of
// them broken. A reason only ever explains the shortfall.
const RECEIPT_REASONS = new Set(['short_delivery', 'wrong_item', 'not_sent']);

// A PO line with no real quantity is not a line — it's a template left
// blank. Ten rows across several POs (Burrito Carton, Yogurt Cup, Meat
// Grinder Accessories, Dill, 450ml Glass Jars…) trace back to exactly this:
// a recurring line resaved without anyone typing a quantity into it. Both
// item-accepting save paths (create + update) take `items` straight off the
// request body, so both are checked here before any row is written.
// Returns the index of the first line with no positive quantity, or -1.
function findMissingQtyLine(items) {
  for (let i = 0; i < items.length; i++) {
    const qty = parseFloat(items[i] && items[i].qty);
    if (!(qty > 0)) return i;
  }
  return -1;
}

// What one receipt payload should do to a line's receipt_reason.
//   ordered  — the line's qty
//   nextQty  — qty_received AFTER this save (null = nothing received yet)
//   sent     — the payload's receipt_reason, or undefined if the key is absent
//   current  — what the column holds now
// → { write:false } leave it alone | { write:true, value } | { error:code }
//
// THE KEY BEING ABSENT IS ITS OWN ANSWER, and that is what keeps this additive.
// The rule is "a short line carries a reason", but the desktop receive screen
// (public/retail-admin/16-purchasing.js puReceiveSave) has no picker and sends
// short quantities with no reason at all. Enforcing the rule against a payload
// that cannot satisfy it would 400 every short receive on a screen the
// warehouse uses daily — so the rule binds the callers that participate: send
// the key and it is enforced in both directions, omit it and nothing is
// written. That is the same present-vs-absent discipline qty_received already
// uses on this endpoint, and puReceiveSave's own comment spells out why the
// distinction matters there. Once every receive screen sends the key,
// `sent === undefined` stops happening and the rule is live everywhere with no
// further change here.
//
// A line that is no longer short is the one case a silent caller still moves:
// the stale reason is cleared, because a row must never claim a shortfall it
// does not have.
function planReceiptReason({ ordered, nextQty, sent, current }) {
  const isShort = nextQty != null && nextQty < ordered;
  if (sent === undefined) {
    return (!isShort && current != null) ? { write: true, value: null } : { write: false };
  }
  const value = (sent == null || sent === '') ? null : String(sent);
  if (isShort) {
    if (!RECEIPT_REASONS.has(value)) {
      return { error: value == null ? 'reason_required' : 'reason_invalid' };
    }
    return { write: true, value };
  }
  if (value != null) return { error: 'reason_not_applicable' };
  return { write: true, value: null };
}

// The received quantity a line will hold after this payload is applied. An
// absent qty_received key preserves what is stored; a null blanks it.
//
// The rule itself is resolveQty (lib/po-returns.js), which every quantity on a
// receive payload now obeys — arrived, damaged and returned alike. Kept as a
// named function here because planReceiptReason reads better for it, but there
// is only one copy of the rule, and a change to how absence is treated can no
// longer land on two of the three columns.
function nextReceivedQty(line, r) {
  return resolveQty(line.qty_received, r.qty_received, { nullable: true });
}

// Validate every line's reason BEFORE anything is written, so a bad code can
// never leave half a delivery saved. Returns a Map of line_id → plan, or
// { error, line_id } for the caller to turn into its own 400 shape.
// ── Receipts ────────────────────────────────────────────────────────────────
// One header + one row per line, appended every time a save actually books a
// delivery. See the table comment in database.js for why this exists and why
// there is no backfill.

// Which lines this save is asserting a receipt for. A line qualifies when the
// payload puts a real arrived count on it, or reports damage — not merely when
// it appears. The desktop screen sends every row of the PO on every save,
// including ones still blank, and a receipt that claimed those had arrived
// would make a two-line delivery read as five.
//
// A caller that re-sends lines it already entered (which the desktop does) gets
// rows for them again. That is faithful: the save did re-assert those numbers.
// A screen wanting "what changed on Tuesday" compares consecutive receipts.
function receiptLineIds(receipts) {
  const ids = [];
  for (const r of receipts) {
    const lineId = parseInt(r.line_id, 10);
    if (!lineId) continue;
    const assertsQty = r.qty_received !== undefined && r.qty_received !== null && r.qty_received !== '';
    const assertsDmg = r.damaged_qty !== undefined && (parseFloat(r.damaged_qty) || 0) > 0;
    if (assertsQty || assertsDmg) ids.push(lineId);
  }
  return ids;
}

// Append one receipt. MUST be called inside the same transaction as the line
// updates, and AFTER them — it reads the lines back, so what it records is what
// was actually stored rather than what the payload hoped for.
// Returns { receiptId, lines } or null when the save booked nothing.
//
// `receipt_note` on a line, not `note`: po_line_items already has a `note`
// column holding the buyer's own remark about the item ("substitute brand"),
// and the two would have quietly overwritten each other's meaning.
//
// ── kind + returns: the same table, the other direction ────────────────────
// `kind` is 'receipt' (goods came in) or 'return' (goods went back), and it is
// STAMPED rather than derived — see the column's comment in database.js for
// why the delivery-vs-correction derivation cannot answer this one.
//
// `returns` is a Map of line_id → units that went back ON THIS EVENT. When it
// is passed, it also decides which lines the receipt covers: a return covers
// the lines that actually moved, not every line the payload happened to
// mention, and receiptLineIds' arrived/damaged test would have covered all of
// them. The quantity recorded is a MOVEMENT, unlike qty_received beside it,
// which is the running total the line holds — the column comment in
// database.js carries that distinction and it is the one asymmetry in this
// table.
function recordReceipt(h, { poId, storeId, scope, actor, receipts, note, kind, returns, intoReceiptId }) {
  const ids = returns ? [...returns.keys()] : receiptLineIds(receipts);
  if (!ids.length) return null;
  // ── AMENDING THE RECEIPT A VISIT ALREADY OPENED ───────────────────────────
  // `intoReceiptId` names a receipt on this same PO to add these lines to
  // instead of opening another. It exists for one caller — the phone's receive
  // screen, which saves itself as the operator answers rather than on a button
  // (public/m.html recvFlush) — and for one reason: the Received list shows a
  // row per receipt that brought a line for the FIRST time (DELIVERY_SQL in
  // routes/retail-purchasing.js), so without this a van counted in over six
  // pauses would read as six deliveries. One visit, one receipt, one van.
  //
  // `received_at` is deliberately NOT touched. It dates when the delivery
  // started being counted, and a later answer in the same visit is more of that
  // delivery, not a new one.
  //
  // A NAMED RECEIPT THAT NO LONGER QUALIFIES OPENS A NEW ONE rather than
  // refusing. It can happen — the desk undoes the receive while the door is
  // still counting — and the answer to "I cannot amend that" must never be
  // "then nothing is recorded". An extra row in the journal is a blemish; a
  // delivery lost at the door is the failure this screen may not have.
  const wantKind = kind === 'return' ? 'return' : 'receipt';
  let receiptId = null, amended = false;
  if (intoReceiptId) {
    const open = h.prepare(
      "SELECT id FROM po_receipts WHERE id = ? AND po_id = ? AND COALESCE(kind, 'receipt') = ?"
    ).get(parseInt(intoReceiptId, 10) || 0, poId, wantKind);
    if (open) { receiptId = open.id; amended = true; }
  }
  if (receiptId == null) {
    const info = h.prepare(`INSERT INTO po_receipts
        (po_id, store_id, scope, actor_user_id, actor_label, actor_realm, note, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(poId, storeId ?? null, scope || 'kitchen',
           actor?.userId ?? null, actor?.label ?? null, actor?.realm ?? null, note ?? null,
           wantKind);
    receiptId = info.lastInsertRowid;
  }
  // A line answered twice in one visit is REPLACED on the receipt, not listed
  // twice. The receipt is a statement of what this delivery brought, and "5,
  // then 4" on one delivery is two answers to one question — the correction is
  // the answer. Corrections ACROSS visits are still their own receipt, which is
  // what the journal reads as a revision.
  const drop = h.prepare('DELETE FROM po_receipt_lines WHERE receipt_id = ? AND line_id = ?');
  const read = h.prepare('SELECT qty_received, damaged_qty, receipt_reason, return_reason FROM po_line_items WHERE id = ? AND po_id = ?');
  const ins  = h.prepare(`INSERT INTO po_receipt_lines
      (receipt_id, line_id, qty_received, damaged_qty, receipt_reason, note, returned_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const notes = new Map();
  for (const r of receipts) {
    const id = parseInt(r.line_id, 10);
    if (id && r.receipt_note !== undefined) notes.set(id, String(r.receipt_note || '').trim() || null);
  }
  let lines = 0;
  for (const id of ids) {
    const l = read.get(id, poId);
    if (!l) continue;
    if (amended) drop.run(receiptId, id);
    // A return row carries the line's return_reason rather than its receipt
    // one: a receipt_reason explains a SHORTFALL and a return has none — the
    // goods turned up in full and went back afterwards. Putting the shortfall
    // reason on a return row would have every return read as a short delivery,
    // which is the confusion this whole feature exists to end.
    ins.run(receiptId, id, l.qty_received, l.damaged_qty || 0,
            returns ? l.return_reason : l.receipt_reason,
            notes.get(id) ?? null, returns ? (returns.get(id) || 0) : 0);
    lines++;
  }
  // `lines` is what this DELIVERY holds, not what this call wrote — on an
  // amend those differ, and the caller reports it to a screen asking "how big
  // was the delivery", never "how big was the last save".
  if (amended) {
    lines = h.prepare('SELECT COUNT(*) AS n FROM po_receipt_lines WHERE receipt_id = ?')
      .get(receiptId).n;
  }
  return { receiptId, lines, amended };
}

// The store a PO's already-applied stock is sitting at: the last receipt that
// named one, else the order's own store. Historical POs have no receipts, so
// this is po.store_id for every order that exists today — which is what makes
// the store change below a no-op for all of them.
function appliedReceiptStore(h, po) {
  const last = h.prepare(
    'SELECT store_id FROM po_receipts WHERE po_id = ? AND store_id IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(po.id);
  return last ? last.store_id : (po.store_id ?? null);
}

// Kitchen-side wording for the three refusals. The retail route answers in its
// own shape (a bare code the screen translates), matching each file's existing
// error convention rather than inventing a third.
const RECEIPT_REASON_ERRORS = {
  reason_required:       'A short line needs a reason · 短少行需要填写原因',
  reason_invalid:        'Unknown reason code · 收货原因无效',
  reason_not_applicable: 'A reason belongs only on a short line · 仅短少行可填写原因',
};

// The return refusals, in the same shape and for the same callers. The retail
// route answers in bare codes its screen translates (its own convention); this
// one answers in words, which is this file's. Both refuse before writing.
const RETURN_ERRORS = {
  return_invalid:               'That returned quantity is not a number · 退货数量无效',
  return_before_receipt:        'Nothing has been received on that line yet, so nothing can go back · 该行尚未收货，无法退货',
  return_exceeds_received:      'More would go back than was accepted on that line · 退货数量超过该行实收数量',
  return_reason_required:       'A return needs a reason · 退货需要填写原因',
  return_reason_invalid:        'Unknown return reason · 退货原因无效',
  return_reason_not_applicable: 'A reason belongs only on a line with a return · 仅退货行可填写原因',
};

function planReceiptReasons(h, poId, receipts) {
  const plans = new Map();
  for (const r of receipts) {
    const lineId = parseInt(r.line_id, 10);
    if (!lineId) continue;
    const line = h.prepare(
      'SELECT qty, qty_received, receipt_reason FROM po_line_items WHERE id = ? AND po_id = ?'
    ).get(lineId, poId);
    if (!line) continue;
    const plan = planReceiptReason({
      ordered: parseFloat(line.qty) || 0,
      nextQty: nextReceivedQty(line, r),
      sent: r.receipt_reason,
      current: line.receipt_reason,
    });
    if (plan.error) return { error: plan.error, line_id: lineId };
    plans.set(lineId, plan);
  }
  return { plans };
}

// Web Push helpers — fan-out to subscribed devices when a PO event
// happens. Lazy-loaded so a missing or mis-configured push module
// doesn't break the rest of the route.
let _push = null;
try { _push = require('./push'); } catch (e) { console.warn('[purchases] push module not available:', e.message); }
// SSE companion — sub-second in-app pings on plain HTTP.
let _events = null;
try { _events = require('./events'); } catch (e) { console.warn('[purchases] events module not available:', e.message); }
function _broadcastPO(poId, kind, actorUserId) {
  if (!_events || !_events.broadcast) return;
  try {
    const po = db.prepare('SELECT id, po_number, supplier, status, source FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return;
    _events.broadcast('po', {
      kind, id: po.id, po_number: po.po_number,
      supplier: po.supplier, status: po.status, source: po.source,
      ts: Date.now(),
    }, { perms: ['purchases'], excludeUserId: actorUserId });
  } catch (e) { console.warn('[broadcastPO]', e.message); }
}
function _firePOPush(poId, kind) {
  if (!_push || !_push.ENABLED) return;
  try {
    const po = db.prepare('SELECT id, po_number, supplier, status, source FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) return;
    const isKitchen = po.source === 'kitchenOrder';
    // Item summary so the notification reads like "ACME · 4 items · ¥1,240"
    // and "(Tomato, Onion, Olive Oil…)" instead of just the supplier name.
    const items = db.prepare(`SELECT name_en, name_cn, qty, total_cost
                              FROM po_line_items WHERE po_id = ?
                              ORDER BY COALESCE(sort_order,0), id`).all(poId);
    const count = items.length;
    const totalCost = items.reduce((s, i) => s + (Number(i.total_cost) || 0), 0);
    const top = items.slice(0, 3).map(i => i.name_cn || i.name_en || '?').join(', ');
    const summary = count === 0
      ? ''
      : `${count} item${count === 1 ? '' : 's'}${top ? ' (' + top + (count > 3 ? '…' : '') + ')' : ''}${totalCost > 0 ? ' · ¥' + Math.round(totalCost).toLocaleString() : ''}`;
    const compose = (lead) => [lead, summary].filter(Boolean).join(' · ');
    let title, body;
    if (kind === 'created') {
      title = isKitchen ? `🛒 ${po.po_number} · 新厨房订货` : `📋 ${po.po_number} · 新采购单`;
      body  = compose((po.supplier ? po.supplier : '') + (isKitchen ? ' · From kitchen' : (po.supplier ? '' : (po.status || 'Requested'))));
    } else if (kind === 'delivered') {
      title = `📦 ${po.po_number} delivered · 到货`;
      body  = compose(po.supplier || 'No supplier · 未指定供应商');
    } else if (kind === 'ordered') {
      title = `✓ ${po.po_number} ordered · 已下单`;
      body  = compose(po.supplier || '');
    } else { return; }
    // Send to anyone with `purchases` perm (or admin) — they're the
    // people who care about PO state changes. Server-side resolution
    // covers users who aren't currently online.
    _push.sendPushByPermission('purchases', {
      title, body, url: '/?po=' + poId, tag: 'po-' + poId,
    });
  } catch (e) { console.warn('[firePOPush]', e.message); }
}

// A line's unit is stored exactly as it arrives, blank included. The old
// `|| 'kg'` here re-instated the very default the PO form stopped setting, so
// the write-back's mismatch guard could never see that nobody had chosen a
// unit. "Nobody said" has to stay "nobody said" the whole way down.

// ── Fire price-history rows + alerts for every line in a PO ────────────────
// Called whenever a PO transitions to Ordered or Delivered (including the
// split-order path which previously skipped this and was the last gap).
// `source` is 'po_ordered' or 'po_delivery' for the price-history row.
// Price alerts (≥5% delta vs current buy_price) are inserted into price_alerts
// — the front-end push poller picks them up and surfaces a toast.
//
// LAST ORDER WINS. The most recent PO price becomes the item's cost, however
// high. No confirmation, no outlier check — that is the decision, not an
// oversight.
//
// The divisor comes from the INGREDIENT row via lib/ingredient-cost.js, never
// from the PO line's unit. The old code looked `item.unit` up in a local
// unit→grams table that held no container units, so a bag / bottle / pcs line
// fell through to `|| 1` and stored the PACK price as the per-gram cost — a
// ¥15.80 500 g bag of sesame seeds became ¥15.80/g, 500× too high, and every
// recipe using it costed 500× too high with it.
//
// Two guards make the function write NOTHING rather than write something wrong:
//   * unit mismatch — the line's unit must equal the item's buy_unit. buy_price
//     is a price per package; a price recorded against some other unit cannot
//     be compared to it or divided by this item's pack size.
//   * no derivable divisor — a container item with no recorded contents, or a
//     recipe unit outside g / ml / pcs. Dividing by 1 or storing 0 would both
//     destroy a good cost.
// Skips are returned to the caller, logged, and recorded in
// ingredient_cost_skips, which the Alerts page reads. A later PO that prices
// the item cleanly closes them again.
//
// buy_unit is NOT written any more. It is a property of the item as the
// supplier sells it, and overwriting it from a PO line silently re-based every
// future division.
//
// `actor` (optional {userId, username, ip}) is who to credit the cost_update
// activity_log rows below to. Every caller in this file omits it (kitchen
// writes are attributed to 'system'); routes/retail-purchasing.js passes the
// requesting operator so a cancellation can find, and roll back, exactly what
// this PO changed — see rollbackMaterialCost() there. Nothing here reads the
// log back; it exists purely so a later reversal has something to read.

// ── Landed-cost allocation — the PO's freight / tax / handling onto its lines ─
// purchase_orders.extra_freight / extra_tax / extra_handling are what the
// delivery cost ON TOP of the goods. They already post to Finance as one
// "Freight & fees" expense line (postPOExpenses / postRetailPOExpenses); until
// now they stopped there and never reached a per-unit cost, so every cost this
// module derives understated what the goods actually cost to get here.
//
// Split in proportion to each line's GOODS VALUE — received qty × unit price,
// the same COALESCE(qty_received, qty) basis the expense posting groups on, so
// a shortage moves the allocation with it. Returned per BUY UNIT (share ÷ qty)
// because that is the shape deriveCostPerUnit() and the store_products
// write-back both consume: caller adds it to the line's cost_per_unit and feeds
// the sum to the SAME derivation as before. No second cost formula exists.
//
// A line with ZERO goods value (no price, or nothing received) takes no share
// and is reported in `skipped` — dividing its zero qty into a share is the
// division this function exists to not do. If EVERY line is zero the total is
// zero, nothing is allocated at all, and the caller writes exactly what it
// wrote before.
//
// Pure read. Nothing here writes, so it is safe to call on any PO in any state.
function allocateLandedExtras(poId, dbh) {
  const h = dbh || db;
  const num = v => Math.max(0, parseFloat(v) || 0);
  // Behind a guard for the same reason ingredient_cost_skips is below: the three
  // columns arrive by migration (database.js), and a database restored from
  // before them must not take a whole PO status flip down with it. No columns →
  // no extras → every caller writes exactly what it wrote before this existed.
  const none = { extras: 0, totalGoods: 0, perUnit: new Map(), skipped: [] };
  let po = null;
  try {
    po = h.prepare('SELECT extra_freight, extra_tax, extra_handling FROM purchase_orders WHERE id = ?').get(poId);
  } catch (e) { console.warn('[landed cost] extras unavailable:', e.message); return none; }
  const extras = po ? num(po.extra_freight) + num(po.extra_tax) + num(po.extra_handling) : 0;
  // No extras — the overwhelmingly common case, and every PO written before this
  // existed. Return before reading a single line: nothing to split, nothing to
  // report, and the caller's arithmetic is untouched.
  if (!(extras > 0)) return none;
  const lines = h.prepare('SELECT id, name_en, qty, qty_received, cost_per_unit FROM po_line_items WHERE po_id = ?').all(poId);
  const perUnit = new Map();
  const skipped = [];
  const priced = [];
  let totalGoods = 0;
  for (const l of lines) {
    const qty = parseFloat(l.qty_received == null ? l.qty : l.qty_received) || 0;
    const cpu = parseFloat(l.cost_per_unit) || 0;
    const value = qty * cpu;
    if (!(value > 0)) { skipped.push({ line_id: l.id, name_en: l.name_en || '', qty, cost_per_unit: cpu }); continue; }
    priced.push({ id: l.id, qty, value });
    totalGoods += value;
  }
  // totalGoods === 0 means every line was skipped. Nothing is allocated — the
  // guard that keeps the division below off a zero denominator.
  if (totalGoods > 0) {
    for (const p of priced) perUnit.set(p.id, (extras * (p.value / totalGoods)) / p.qty);
  }
  return { extras, totalGoods, perUnit, skipped };
}

function firePriceAlertsForPO(poId, source, actor) {
  const a = actor || {};
  const items = db.prepare('SELECT id, ingredient_id, unit, cost_per_unit FROM po_line_items WHERE po_id = ?').all(poId);
  const landed = allocateLandedExtras(poId, db);
  const skips = [];
  // Prepared behind a guard: a database restored from before this table
  // existed must not take the whole PO status flip down with it. Prices still
  // write; only the record of skips is lost, and loudly.
  let insSkip = null, resolveSkips = null;
  try {
    insSkip = db.prepare(`INSERT INTO ingredient_cost_skips
      (ingredient_id, po_id, reason, line_unit, line_price) VALUES (?,?,?,?,?)`);
    resolveSkips = db.prepare(`UPDATE ingredient_cost_skips
         SET resolved_at = CURRENT_TIMESTAMP
       WHERE ingredient_id = ? AND resolved_at IS NULL`);
  } catch (e) { console.warn('[price write-back] ingredient_cost_skips unavailable:', e.message); }
  const skip = (ing, item, reason) => {
    skips.push({ ingredient_id: ing.id, sku: ing.sku || null, name_en: ing.name_en || '', name_cn: ing.name_cn || null, reason });
    console.warn(`[price write-back] skipped ${ing.sku || 'id ' + ing.id} ${ing.name_en || ''} — ${reason}`);
    // Recorded so the refusal reaches the Alerts page. A skip that only ever
    // reached the server log would leave the item's cost stale in silence.
    try { if (insSkip) insSkip.run(ing.id, poId, reason, item.unit || null, item.cost_per_unit); }
    catch (e) { console.warn('[price write-back] could not record skip:', e.message); }
  };
  // Set when a line actually moves a non-linked ingredient's cost — checked
  // once after the loop rather than per-line, so a PO with several priced
  // lines triggers one recompute pass instead of running the (cheap but not
  // free) full graph walk once per line.
  let cpuMoved = false;
  for (const item of items) {
    if (!item.ingredient_id || !item.cost_per_unit) continue;
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(item.ingredient_id);
    if (!ing) continue;

    // Price history is append-only and carries its own buy_unit column, so it
    // stays honest even for lines we refuse to write back. Recorded first, and
    // for every priced line, exactly as before.
    db.prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source) VALUES (?,?,?,?)').run(item.ingredient_id, item.cost_per_unit, item.unit, source);

    // Through normaliseUnit, so 'pc' on the line and 'pcs' on the item are the
    // same unit and the price flows.
    // Marked free by hand. A supplier price on a PO line does not get to start
    // costing something someone deliberately said is free — the flag is a
    // decision, the invoice is just data.
    if (ing.free_by_design) { skip(ing, item, 'marked_free'); continue; }

    // Made here, not bought (§29). Its cost comes from the recipe that makes
    // it, so a supplier price on a PO line is not the authority on what it
    // costs — the same reasoning as free_by_design directly above. Buying a
    // batch of something you normally make does not re-base the recipe.
    if (ing.source_recipe_id) { skip(ing, item, 'source_recipe_linked'); continue; }

    if (normaliseUnit(item.unit) !== normaliseUnit(ing.buy_unit)) { skip(ing, item, 'unit_mismatch'); continue; }

    // LANDED, not invoiced. The line's share of the PO's freight/tax/handling
    // is added to the pack price BEFORE the one derivation divides it down, so
    // cost_per_unit is what the goods cost to get here rather than what the
    // supplier's line said. Zero when the PO carries no extras, which is every
    // PO written before this existed — their costs do not move.
    //
    // buy_price still stores the INVOICE pack price, unchanged: it is what the
    // supplier charges for one package, it is what the ±5% alert below compares
    // against, and folding delivery into it would re-base that comparison on
    // something the next invoice cannot be checked against.
    const landedPackPrice = (parseFloat(item.cost_per_unit) || 0) + (landed.perUnit.get(item.id) || 0);
    const { cpu, reason } = deriveCostPerUnit(ing, landedPackPrice);
    if (cpu === null) { skip(ing, item, reason); continue; }

    if (Number(cpu) !== Number(ing.cost_per_unit || 0)) cpuMoved = true;
    const costBefore = { buy_price: ing.buy_price ?? null, cost_per_unit: ing.cost_per_unit ?? null };
    db.prepare('UPDATE ingredients SET buy_price=?,cost_per_unit=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.cost_per_unit, cpu, item.ingredient_id);
    logActivity(a.userId ?? null, a.username || 'system', 'cost_update', 'ingredient', item.ingredient_id,
      { from: costBefore, to: { buy_price: item.cost_per_unit, cost_per_unit: cpu }, po_id: poId, source,
        landed_pack_price: landedPackPrice, landed_share_per_unit: landed.perUnit.get(item.id) || 0 }, a.ip ?? null);
    // The item just priced cleanly, so whatever blocked it before is no longer
    // true — close its open skips. They stay in the table with resolved_at set,
    // because the history of what went unpriced is worth keeping. Without this
    // the alert would outlive the problem and have to be dismissed by hand.
    if (resolveSkips) resolveSkips.run(item.ingredient_id);
    if (ing.buy_price > 0 && item.cost_per_unit !== ing.buy_price) {
      const changePct = ((item.cost_per_unit - ing.buy_price) / ing.buy_price) * 100;
      if (Math.abs(changePct) >= 5) {
        db.prepare('INSERT INTO price_alerts (ingredient_id,old_price,new_price,change_pct) VALUES (?,?,?,?)').run(item.ingredient_id, ing.buy_price, item.cost_per_unit, changePct);
      }
    }
  }
  // ing.source_recipe_id is already filtered out above (the 'source_recipe_linked'
  // skip), so every line that reached the UPDATE loop was on a non-linked
  // ingredient — exactly the trigger condition.
  if (cpuMoved) fireRecompute(db, { source: 'purchases.po_price_writeback', po_id: poId });
  // landedSkips = lines that took no share of the extras because they had no
  // goods value. Reported, not silent: a line the operator priced at 0 quietly
  // pushing its freight onto its neighbours is the same class of invisible
  // money movement the skips above exist to surface.
  if (landed.skipped.length && landed.extras > 0) {
    console.warn(`[landed cost] PO ${poId}: ¥${landed.extras.toFixed(2)} extras allocated over `
      + `¥${landed.totalGoods.toFixed(2)} of goods; ${landed.skipped.length} line(s) took no share `
      + `(zero goods value): ${landed.skipped.map(s => s.name_en || 'line ' + s.line_id).join(', ')}`);
  }
  return { skips, landedSkips: landed.skipped, landedExtras: landed.extras };
}

// ── Auto-post PO line items into expense_entries by category ────────────────
// Idempotent: wipes any existing PO-linked rows first, then inserts fresh.
// Posts as soon as the PO moves to Ordered — matches cash-basis bookkeeping
// where Taobao/1688 payment happens at order time. On Delivered we re-post
// using qty_received instead of qty so shortages/damages adjust the books.
// Only the 'Requested' (and legacy 'Confirmed') states stay un-posted.
function postPOExpenses(poId) {
  const result = { skipped: null, inserted: 0, total: 0, categories: 0, status: null };
  try {
    const po = db.prepare('SELECT id, date, supplier, po_number, status FROM purchase_orders WHERE id = ?').get(poId);
    if (!po) { result.skipped = 'po-missing'; return result; }
    result.status = po.status;
    // Always clear so flipping status back to Requested correctly removes the entries.
    db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
    const POSTABLE = new Set(['Ordered', 'Delivered', 'Confirmed']);
    if (!POSTABLE.has(po.status)) { result.skipped = 'not-postable'; return result; }
    // STOOD DOWN BY ITS RETAIL COPY. Somebody copied this order into Tacet and
    // placed the copy, so postRetailPOExpenses() is posting the same goods
    // against RPO-####; posting them here as well is the same purchase in the
    // books twice. lib/po-supersede.js holds the rule and the reasoning. The
    // DELETE above has already run, which is the whole reversal: when the copy
    // goes back to Draft or is cancelled the next call posts these rows again.
    const copy = supersedingCopy(db, poId);
    if (copy) {
      result.skipped = 'superseded-by-' + copy.po_number;
      result.superseded_by = copy.po_number;
      return result;
    }
    // Group by expense_category, summing (received − returned × cost) per
    // category. The quantity is billableQtySql (lib/po-returns.js) — the same
    // expression the retail poster and the 发票 chase use, so one purchase can
    // no longer be worth one figure in the books and another on the chase.
    //
    // A return RESTATES THIS PURCHASE rather than opening a second entry: the
    // DELETE above has already cleared the rows and these are written back
    // against po.date, so goods bought in one month and sent back in the next
    // leave the first month holding what it actually cost.
    const groups = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(expense_category),''),'未分类 Uncategorized') AS category,
        SUM(${billableQtySql()} * COALESCE(cost_per_unit, 0))             AS amount,
        COUNT(*)                                                            AS line_count
      FROM po_line_items
      WHERE po_id = ?
        AND ${billableQtySql()} > 0
      GROUP BY COALESCE(NULLIF(TRIM(expense_category),''),'未分类 Uncategorized')
    `).all(poId);
    const insert = db.prepare('INSERT INTO expense_entries (date, amount, category, description, po_id) VALUES (?,?,?,?,?)');
    for (const g of groups) {
      if (!g.amount || g.amount <= 0) continue;
      const desc = `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · ${g.line_count} line${g.line_count === 1 ? '' : 's'}`;
      insert.run(po.date, +g.amount, g.category, desc, poId);
      result.inserted++;
      result.total += +g.amount;
      result.categories++;
    }
    if (result.inserted === 0 && groups.length === 0) result.skipped = 'no-line-items';
    else if (result.inserted === 0) result.skipped = 'all-zero-cost';
    return result;
  } catch (e) {
    console.error('[postPOExpenses error] po=' + poId, e);
    result.skipped = 'error: ' + (e.message || 'unknown');
    return result;
  }
}

// One PO, kitchen scope only. The LIST has filtered on scope since retail
// purchasing landed in the same table; every by-id route did not, so a kitchen
// user holding `purchases` could read and mutate a retail PO through the
// THIS FILE IS NOW A LIBRARY, NOT A ROUTER (§80).
//
// Everything between here and the backfill below was the kitchen app's
// purchasing API: 22 endpoints under /api/purchases and /api/lots, plus
// getKitchenPO and clearPOExpenses which served only them. public/app.html
// was their only caller and §78 deleted it; every one was gated on requireAuth,
// the realm §80 retires, so they could not be reached even by accident.
//
// WHAT IT KEEPS IS WHY IT SURVIVES, and §77 named this before it was true:
// routes/retail-purchasing.js requires SIX functions out of this file at load
// — firePriceAlertsForPO, allocateLandedExtras, planReceiptReasons,
// recordReceipt, appliedReceiptStore and postPOExpenses — so that one price
// write-back and one expense poster serve both purchasing surfaces rather than
// two that drift. Those all sit ABOVE this comment and are untouched.
//
// THE /api/lots ENDPOINTS WENT WITH THE REST, and that is §77's ruling landing
// rather than an oversight: Ash was asked directly whether lot numbers and
// expiry dates were used and answered that they are not. The COLUMNS keep
// their data; nothing was migrated and nothing was backfilled.
//
// It is still mounted in server.js. The mount is now only how this module gets
// LOADED — which is what arms the boot task below, and what puts it in the
// require cache before routes/retail-purchasing.js asks for it. Load order is
// load-bearing; that file's own header says so.
// One-time backfill: any Ordered/Delivered/Confirmed PO that has zero rows in
// expense_entries gets posted. Safe to run on every boot — the postPOExpenses
// helper is idempotent (it deletes existing po_id rows first), but we filter
// to "missing" POs to avoid unnecessary writes. Logs a one-line summary.
function backfillOrderedExpenses() {
  try {
    const rows = db.prepare(`
      SELECT po.id, po.po_number, po.status
      FROM purchase_orders po
      WHERE po.status IN ('Ordered', 'Delivered', 'Confirmed')
        AND NOT EXISTS (SELECT 1 FROM expense_entries e WHERE e.po_id = po.id)
    `).all();
    if (!rows.length) {
      console.log('[backfillOrderedExpenses] nothing to do — all postable POs already have expense rows.');
      return { scanned: 0, posted: 0 };
    }
    let posted = 0, totalAmount = 0;
    for (const r of rows) {
      const result = postPOExpenses(r.id);
      if (result.inserted > 0) { posted++; totalAmount += result.total; }
    }
    console.log(`[backfillOrderedExpenses] scanned ${rows.length} PO(s) → posted ${posted} (¥${totalAmount.toFixed(2)} total).`);
    return { scanned: rows.length, posted, totalAmount };
  } catch (e) {
    console.error('[backfillOrderedExpenses error]', e);
    return { error: e.message };
  }
}

// Run once, deferred so the rest of the app boots first.
setTimeout(backfillOrderedExpenses, 2000);

module.exports = router;
module.exports.postPOExpenses = postPOExpenses;
// Exported for scripts/test_price_writeback.js — the price write-back is money
// maths and needs to be exercisable against a fixture DB, not only through a
// live PO status flip.
module.exports.firePriceAlertsForPO = firePriceAlertsForPO;
// The ONE landed-cost allocation. routes/retail-purchasing.js consumes it for
// the store_products.unit_cost write-back so both cost paths split the same
// extras the same way — a second copy is what let the pack-price bug happen.
module.exports.allocateLandedExtras = allocateLandedExtras;
// The ONE receipt-reason rule. routes/retail-purchasing.js consumes it so the
// kitchen and retail receive endpoints cannot disagree about what a valid
// reason is or when one is owed — a second copy is exactly how invoice_status
// ended up with a no_invoice mark the invoice report never read.
module.exports.RECEIPT_REASONS = RECEIPT_REASONS;
module.exports.planReceiptReasons = planReceiptReasons;
// The ONE receipt writer, shared for the same reason: a delivery must be
// recorded the same shape whichever scope took it in, or the Received list
// reads two different histories depending on who was standing at the door.
module.exports.recordReceipt = recordReceipt;
module.exports.appliedReceiptStore = appliedReceiptStore;
module.exports.backfillOrderedExpenses = backfillOrderedExpenses;
