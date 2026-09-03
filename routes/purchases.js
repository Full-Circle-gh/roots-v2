const express = require('express');
// Routed through the database seam (lib/db-seam.js). No converter is installed,
// so this is a zero-cost passthrough; the point is that this file is now on the
// covered side of the boundary. Proven by scripts/diagnose_seam_statements.js.
const { seam } = require('../lib/db-seam');
const db = seam(require('../database'));
const { requireAuth, requirePermission, requireDelete, logActivity } = require('../middleware/auth');
// The one cost-per-recipe-unit derivation — shared so purchasing cannot drift
// from what the ingredient form computes. See lib/ingredient-cost.js.
const { deriveCostPerUnit, normaliseUnit } = require('../lib/ingredient-cost');
// Finance category text — the one normalisation. See lib/category-text.js.
const { storeCategory } = require('../lib/category-text');
// The no-invoice mark and invoice_status are one fact in two columns; every
// write of either goes through here so the two can never contradict each other.
const { setNoInvoiceMark, setLineInvoiceStatus } = require('../lib/invoice-mark');
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
function recordReceipt(h, { poId, storeId, scope, actor, receipts, note, kind, returns }) {
  const ids = returns ? [...returns.keys()] : receiptLineIds(receipts);
  if (!ids.length) return null;
  const info = h.prepare(`INSERT INTO po_receipts
      (po_id, store_id, scope, actor_user_id, actor_label, actor_realm, note, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(poId, storeId ?? null, scope || 'kitchen',
         actor?.userId ?? null, actor?.label ?? null, actor?.realm ?? null, note ?? null,
         kind === 'return' ? 'return' : 'receipt');
  const receiptId = info.lastInsertRowid;
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
  return { receiptId, lines };
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
// kitchen API. Mirrors getRetailPO() in routes/retail-purchasing.js, which has
// always had both predicates.
//
// tenant_id is COALESCEd rather than compared bare so a row that predates the
// column, or somehow holds NULL, still reads as Roots' rather than vanishing.
function getKitchenPO(id) {
  return db.prepare(
    "SELECT * FROM purchase_orders WHERE id = ? AND COALESCE(scope,'kitchen') = 'kitchen' AND COALESCE(tenant_id,1) = 1"
  ).get(id);
}

// GET all POs
router.get('/api/purchases', requireAuth, requirePermission('purchases'), (req, res) => {
  const { status, search, month } = req.query;
  // Retail (online store) POs live in the same table with scope='retail' and
  // their own admin at /api/retail-admin/purchases — keep them out of the
  // kitchen buying list so the two departments don't see each other's noise.
  let q = "SELECT * FROM purchase_orders WHERE COALESCE(scope,'kitchen') = 'kitchen'";
  const params = [];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (month)  { q += " AND substr(date, 1, 7) = ?"; params.push(String(month).slice(0,7)); }
  if (search) {
    // Match across PO number, header supplier, AND any line-level supplier
    // or channel — so the buyer can search "京东" or "美团闪购" and find
    // every PO that touched that channel.
    q += ` AND (po_number LIKE ? OR supplier LIKE ? OR id IN (
      SELECT po_id FROM po_line_items
      WHERE supplier_name LIKE ? OR purchase_channel LIKE ?
    ))`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  q += ' ORDER BY date DESC, id DESC';
  const pos = db.prepare(q).all(...params);
  res.json({ success: true, data: pos });
});

// GET single PO with line items
router.get('/api/purchases/:id', requireAuth, requirePermission('purchases'), (req, res) => {
  const po = getKitchenPO(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found · 未找到' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(po.id);
  res.json({ success: true, data: { ...po, items } });
});

// GET per-ingredient history context for a PO. Returns, for every line item
// that has an ingredient_id, the most recent prior PO line + lifetime stats
// (count, avg/min/max cost). Used by the PO detail view to surface "last
// ordered: 5kg @ ¥X · trending ▼ 8%" without N+1 fetches.
router.get('/api/purchases/:id/history', requireAuth, requirePermission('purchases'), (req, res) => {
  const items = db.prepare('SELECT id, ingredient_id FROM po_line_items WHERE po_id = ?').all(req.params.id);
  const prevStmt = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date, po.source, po.supplier
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.ingredient_id = ? AND po.id != ?
    ORDER BY po.created_at DESC, pli.id DESC
    LIMIT 1`);
  const statsStmt = db.prepare(`
    SELECT COUNT(*)               AS total_orders,
           AVG(pli.cost_per_unit) AS avg_price,
           MIN(pli.cost_per_unit) AS min_price,
           MAX(pli.cost_per_unit) AS max_price,
           SUM(pli.qty)           AS total_qty
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.ingredient_id = ? AND po.id != ?`);
  const out = {};
  for (const it of items) {
    if (!it.ingredient_id) continue;
    const prev  = prevStmt.get(it.ingredient_id, req.params.id) || null;
    const stats = statsStmt.get(it.ingredient_id, req.params.id) || null;
    out[it.ingredient_id] = { previous: prev, stats };
  }
  res.json({ success: true, data: out });
});

// POST create PO
router.post('/api/purchases', requireAuth, requirePermission('purchases'), (req, res) => {
  const { date, delivery_date, supplier, warehouse, notes, items, source } = req.body;
  if (items?.length) {
    const badIdx = findMissingQtyLine(items);
    if (badIdx !== -1) {
      const label = items[badIdx].name_en || items[badIdx].sku || `#${badIdx + 1}`;
      return res.status(400).json({ error: `Line "${label}" needs a quantity greater than zero · 该行数量必须大于零` });
    }
  }
  const po_number = nextKitchenPONumber(db);
  try {
    const result = db.prepare('INSERT INTO purchase_orders (po_number,date,delivery_date,status,supplier,warehouse,notes,source,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(po_number, date, delivery_date||null, 'Requested', supplier||null, warehouse||null, notes||null, source||'manual', req.user.id);
    const poId = result.lastInsertRowid;
    if (items?.length) {
      const insertItem = db.prepare(`INSERT INTO po_line_items
        (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
         supplier_name, purchase_channel, invoice_status, no_invoice_expected, note, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const VALID_STATUS = new Set(['not_received','received','no_invoice']);
      // When a line is linked to an ingredient, fall back to that
      // ingredient's master supplier — so the canonical "we always buy
      // this from X" stays the source of truth even when the buyer left
      // the per-line picker on "inherit".
      const ingSupplierStmt = db.prepare('SELECT supplier FROM ingredients WHERE id = ?');
      items.forEach((item, i) => {
        const total = (parseFloat(item.qty)||0) * (parseFloat(item.cost_per_unit)||0);
        const status = VALID_STATUS.has(item.invoice_status) ? item.invoice_status : 'not_received';
        let lineSupplier = item.supplier_name || supplier || null;
        if (!lineSupplier && item.ingredient_id) {
          const ing = ingSupplierStmt.get(item.ingredient_id);
          if (ing && ing.supplier && ing.supplier.trim()) lineSupplier = ing.supplier.trim();
        }
        insertItem.run(
          poId, item.ingredient_id||null, item.name_en||'', item.name_cn||null, item.sku||null,
          item.qty||0, item.unit || null, item.cost_per_unit||0, total, storeCategory(db, item.expense_category),
          lineSupplier, item.purchase_channel || null,
          // The mark travels with the status from the very first row — a line
          // created as 'no_invoice' that carried no mark was chased as awaiting
          // on every screen that reads the mark instead. See lib/invoice-mark.js.
          status, status === 'no_invoice' ? 1 : 0, (item.note||'').trim() || null, i
        );
      });
    }
    logActivity(req.user.id, req.user.username, 'create', 'purchase_order', poId, {po_number}, req.ip);
    // Fan out a push notification to anyone with `purchases` perm —
    // OS-level alert even if their browser is closed.
    _firePOPush(poId, 'created');
    _broadcastPO(poId, 'created', req.user.id);
    res.json({ success: true, id: poId, po_number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update PO status + items
// Only writes ingredients.cost_per_unit/buy_price (via firePriceAlertsForPO)
// when `items` is present AND the status is one that fires the price
// write-back (mirrors the route's own guard at the firePriceAlertsForPO call
// below) — blocked conditionally on exactly that (material cost columns). A
// plain date/notes/warehouse edit, or an items edit that leaves status at
// Requested, still goes through.
router.put('/api/purchases/:id', requireAuth, requirePermission('purchases'), blockCostWriteIf(
  (req) => !!(req.body && req.body.items) && ['Ordered', 'Delivered', 'Confirmed'].includes(req.body.status),
  'material cost'
), (req, res) => {
  const { date, delivery_date, status, supplier, warehouse, notes, items } = req.body;
  if (items?.length) {
    const badIdx = findMissingQtyLine(items);
    if (badIdx !== -1) {
      const label = items[badIdx].name_en || items[badIdx].sku || `#${badIdx + 1}`;
      return res.status(400).json({ error: `Line "${label}" needs a quantity greater than zero · 该行数量必须大于零` });
    }
  }
  db.prepare('UPDATE purchase_orders SET date=?,delivery_date=?,status=?,supplier=?,warehouse=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(date, delivery_date||null, status||'Requested', supplier||null, warehouse||null, notes||null, req.params.id);
  if (items) {
    // Editing the lines used to be DELETE-all + INSERT-all, which handed every
    // surviving line a brand-new id. invoice_lines.line_id is ON DELETE
    // CASCADE, so a routine PO edit silently took the supplier-invoice
    // allocations down with it — live PO-0048 lost its ¥848.24 link this way
    // and invoice 25 has read half-allocated ever since, with nothing on the
    // screen to say why. A line the payload names by id is UPDATED in place
    // instead, so everything hanging off that id survives the edit.
    // id → what that row already says about invoicing, so an edit can hand both
    // columns back untouched. This screen's payload carries no invoice_status,
    // and defaulting it on every save is how a stored 不开发票 turned back into
    // 'not_received' the next time anyone edited the order's lines.
    const existing = new Map(
      db.prepare('SELECT id, invoice_status, no_invoice_expected FROM po_line_items WHERE po_id = ?')
        .all(req.params.id).map(r => [r.id, r]));
    const kept = new Set();
    const insertItem = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, invoice_status, no_invoice_expected, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const updateItem = db.prepare(`UPDATE po_line_items SET
       ingredient_id=?, name_en=?, name_cn=?, sku=?, qty=?, unit=?, cost_per_unit=?, total_cost=?,
       expense_category=?, supplier_name=?, purchase_channel=?, invoice_status=?, no_invoice_expected=?,
       note=?, sort_order=?
       WHERE id=? AND po_id=?`);
    const VALID_STATUS = new Set(['not_received','received','no_invoice']);
    const ingSupplierStmt = db.prepare('SELECT supplier FROM ingredients WHERE id = ?');
    items.forEach((item, i) => {
      const total = (parseFloat(item.qty)||0) * (parseFloat(item.cost_per_unit)||0);
      // A payload that names an invoice status states both columns; one that
      // says nothing gives the stored pair straight back. Same rule every other
      // writer follows — lib/invoice-mark.js.
      const held = existing.get(parseInt(item.id, 10));
      const status = VALID_STATUS.has(item.invoice_status) ? item.invoice_status
                   : (held && held.invoice_status) || 'not_received';
      const mark = VALID_STATUS.has(item.invoice_status)
        ? (item.invoice_status === 'no_invoice' ? 1 : 0)
        : (held && held.no_invoice_expected ? 1 : 0);
      // Same fallback chain as the create path: line override → header
      // → ingredient master supplier.
      let lineSupplier = item.supplier_name || supplier || null;
      if (!lineSupplier && item.ingredient_id) {
        const ing = ingSupplierStmt.get(item.ingredient_id);
        if (ing && ing.supplier && ing.supplier.trim()) lineSupplier = ing.supplier.trim();
      }
      const cols = [
        item.ingredient_id||null, item.name_en||'', item.name_cn||null, item.sku||null,
        item.qty||0, item.unit || null, item.cost_per_unit||0, total, storeCategory(db, item.expense_category),
        lineSupplier, item.purchase_channel || null,
        status, mark, (item.note||'').trim() || null, i,
      ];
      const lineId = parseInt(item.id, 10);
      if (lineId > 0 && existing.has(lineId)) {
        updateItem.run(...cols, lineId, req.params.id);
        kept.add(lineId);
      } else {
        insertItem.run(req.params.id, ...cols);
      }
    });
    // Only the lines the buyer actually removed are dropped. Their invoice
    // allocations still cascade away — that is the buyer's own decision — but
    // it is now recorded rather than silent.
    const dropped = [...existing.keys()].filter(id => !kept.has(id));
    if (dropped.length) {
      const marks = dropped.map(() => '?').join(',');
      const orphaned = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(allocated_amount),0) AS amount
           FROM invoice_lines WHERE line_id IN (${marks})`).get(...dropped);
      db.prepare(`DELETE FROM po_line_items WHERE po_id = ? AND id IN (${marks})`).run(req.params.id, ...dropped);
      if (orphaned.n) {
        logActivity(req.user.id, req.user.username, 'invoice_links_dropped', 'purchase_order', req.params.id,
          { lines: dropped.length, links: orphaned.n, amount: orphaned.amount }, req.ip);
      }
    }
    // Fire price-history records + alerts on Ordered/Delivered/Confirmed.
    // Was previously gated on Delivered/Confirmed only — but most POs sit
    // at "Ordered" and never get explicitly delivered (the team just
    // partial-receives), so price changes silently accumulated without
    // ever generating an alert. Triggering at Ordered is more practical:
    // the buyer sees the alert the moment they record a higher price.
    if (status === 'Ordered' || status === 'Delivered' || status === 'Confirmed') {
      firePriceAlertsForPO(req.params.id, status === 'Ordered' ? 'po_ordered' : 'po_delivery');
    }
  }
  // First-time delivery: backfill qty_received from qty so the partial-receive
  // UI has a sensible default. Subsequent receive edits go through /receive.
  if (status === 'Delivered' || status === 'Confirmed') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(req.params.id);
  }
  // Auto-post / wipe expense_entries to keep finance in sync with PO state.
  postPOExpenses(req.params.id);
  logActivity(req.user.id, req.user.username, 'update', 'purchase_order', req.params.id, {status}, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/status — status-only update. Avoids the items
// round-trip used by the previous PUT path which would wipe per-line state
// (qty_received, tracking, damaged_qty) every time the user clicked a status.
// Fires firePriceAlertsForPO (mirrors the guard at that call below) whenever
// status moves to Ordered or Delivered — blocked conditionally on exactly
// that (material cost columns). Moving back to Requested is left open.
router.put('/api/purchases/:id/status', requireAuth, requirePermission('purchases'), blockCostWriteIf(
  (req) => ['Ordered', 'Delivered'].includes(req.body && req.body.status),
  'material cost'
), (req, res) => {
  const { status } = req.body || {};
  if (!['Requested','Ordered','Delivered'].includes(status)) return res.status(400).json({ error: 'Invalid status · 状态无效' });
  const po = getKitchenPO(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  // First-time delivery → seed qty_received from qty so the receive UI has
  // a sensible default. Subsequent edits go through /receive.
  if (status === 'Delivered') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(req.params.id);
  }
  // On Ordered or Delivered, push ingredient prices + fire alerts. Mirrors
  // the items-PUT path above — see that comment for the rationale (POs sit
  // at "Ordered" indefinitely, so gating only on Delivered means alerts
  // never fire in practice).
  if (status === 'Ordered' || status === 'Delivered') {
    firePriceAlertsForPO(req.params.id, status === 'Ordered' ? 'po_ordered' : 'po_delivery');
  }
  // Status flip drives expense posting. PRACTICAL CHANGE (2026): the
  // moment a PO goes Ordered, money is committed (the buyer placed it),
  // so it should land in Finance → Expenses immediately rather than
  // waiting for goods to physically arrive. postPOExpenses is idempotent
  // (DELETE-then-INSERT), so flipping back to Requested wipes the rows.
  if (status === 'Ordered' || status === 'Delivered') {
    postPOExpenses(req.params.id);
  } else if (status === 'Requested') {
    db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(req.params.id);
  }
  logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', req.params.id, { from: po.status, to: status }, req.ip);
  // Push notification on meaningful transitions only (Requested → Ordered,
  // Ordered → Delivered). Skip if the status didn't actually change.
  if (po.status !== status) {
    if (status === 'Delivered') {
      _firePOPush(req.params.id, 'delivered');
      _broadcastPO(req.params.id, 'delivered', req.user.id);
    } else if (status === 'Ordered') {
      _firePOPush(req.params.id, 'ordered');
      _broadcastPO(req.params.id, 'ordered', req.user.id);
    }
  }
  res.json({ success: true });
});

// PUT /api/purchases/:id/receive — bulk-set per-line receive state. Body:
// { receipts: [{ line_id, qty_received, damaged_qty, tracking_number, tracking_carrier }] }
// Returns alert counts so the UI can flag missing/damaged on save.
router.put('/api/purchases/:id/receive', requireAuth, requirePermission('purchases'), (req, res) => {
  try {
    const { receipts } = req.body || {};
    if (!Array.isArray(receipts)) return res.status(400).json({ error: 'receipts[] required · 收货数据必填' });
    const poId = parseInt(req.params.id, 10);
    if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
    // Reasons are resolved and refused up front — nothing below runs on a bad
    // code. Kitchen receiving moves no stock, but it records the same fact.
    const planned = planReceiptReasons(db, poId, receipts);
    if (planned.error) return res.status(400).json({ error: RECEIPT_REASON_ERRORS[planned.error], line_id: planned.line_id });
    // Returns, resolved and refused the same way. Kitchen receiving moves no
    // stock, so there is no shelf to check against here — the whole of what a
    // return means to this endpoint is the quantity, its reason, and the money
    // that follows from both.
    const returns = planReturns(db, poId, receipts);
    if (returns.error) return res.status(400).json({ error: RETURN_ERRORS[returns.error], code: returns.error, line_id: returns.line_id });
    const reasonUpd = db.prepare('UPDATE po_line_items SET receipt_reason = ? WHERE id = ? AND po_id = ?');
    const upd = db.prepare(`UPDATE po_line_items SET
      qty_received    = ?,
      damaged_qty     = ?,
      tracking_number = ?,
      tracking_carrier= ?
      WHERE id = ? AND po_id = ?`);
    let missing_lines = 0, damaged_lines = 0, total_missing = 0, total_damaged = 0;
    let any_qty_received = false;
    let receipt = null, returnReceipt = null;
    let returned_lines = 0, returned_units = 0;
    const returnMoves = new Map();
    // Three statements rather than one with a computed date, because
    // returned_at answers a different question to the quantity beside it: it
    // dates the LAST RETURN, so it moves when the figure grows, clears when the
    // figure goes to zero, and is untouched by a correction that merely lowers
    // it. CURRENT_TIMESTAMP for the reason the retail twin gives — it is read
    // beside po_receipts.received_at, which takes the same default.
    const returnUpd = db.prepare(
      'UPDATE po_line_items SET returned_qty = ?, return_reason = ? WHERE id = ? AND po_id = ?');
    const returnUpdNew = db.prepare(
      'UPDATE po_line_items SET returned_qty = ?, return_reason = ?, returned_at = CURRENT_TIMESTAMP WHERE id = ? AND po_id = ?');
    const returnUpdNone = db.prepare(
      'UPDATE po_line_items SET returned_qty = 0, return_reason = NULL, returned_at = NULL WHERE id = ? AND po_id = ?');
    const tx = db.transaction(() => {
      for (const r of receipts) {
        const lineId = parseInt(r.line_id, 10);
        if (!lineId) continue;
        const line = db.prepare('SELECT qty FROM po_line_items WHERE id = ? AND po_id = ?').get(lineId, poId);
        if (!line) continue;
        const orderedQty = parseFloat(line.qty) || 0;
        const q  = r.qty_received == null || r.qty_received === ''
                   ? null
                   : Math.max(0, parseFloat(r.qty_received) || 0);
        const dq = Math.max(0, parseFloat(r.damaged_qty) || 0);
        const tn = (r.tracking_number || '').toString().trim() || null;
        const tc = (r.tracking_carrier || '').toString().trim() || null;
        // Tracking-only save: caller omits qty_received and damaged_qty
        // entirely (per-line auto-save from the new bottom-of-line tracking
        // input). We update only tracking columns and leave the warehouse's
        // receive state untouched — even if the user is clearing the
        // tracking number to empty (tn = null).
        const isTrackingOnly = r.qty_received === undefined && r.damaged_qty === undefined;
        if (isTrackingOnly) {
          db.prepare('UPDATE po_line_items SET tracking_number = ?, tracking_carrier = ? WHERE id = ? AND po_id = ?')
            .run(tn, tc, lineId, poId);
        } else {
          upd.run(q, dq, tn, tc, lineId, poId);
        }
        // Written separately rather than folded into `upd`, so a tracking-only
        // save can still clear a reason its quantity change made stale without
        // that statement touching the receive columns it must leave alone.
        const plan = planned.plans.get(lineId);
        if (plan && plan.write) reasonUpd.run(plan.value, lineId, poId);
        // Written on its own statement for the same reason the reason above is:
        // a tracking-only save must be able to leave every receive column alone,
        // and a returns-aware save must be able to move a return without
        // re-asserting an arrived count it was not sent.
        const rPlan = returns.plans.get(lineId);
        if (rPlan && rPlan.write) {
          if (rPlan.delta > 0)      returnUpdNew.run(rPlan.qty, rPlan.reason, lineId, poId);
          else if (rPlan.qty === 0) returnUpdNone.run(lineId, poId);
          else                      returnUpd.run(rPlan.qty, rPlan.reason, lineId, poId);
          if (rPlan.delta > 0) { returnMoves.set(lineId, rPlan.delta); returned_lines++; returned_units += rPlan.delta; }
        }
        if (q != null) any_qty_received = true;
        if (q != null && q < orderedQty) { missing_lines++; total_missing += orderedQty - q; }
        if (dq > 0)                       { damaged_lines++; total_damaged += dq; }
      }
      // The delivery record, appended last so it reads the lines back as
      // stored. Gated on any_qty_received for the same reason the expense
      // re-post below is: a save carrying only a tracking number is not a
      // delivery, and one that booked nothing must not leave a phantom row in
      // the Received list. Kitchen receipts carry no store — kitchen
      // purchasing moves no stock and has no stores to move it between — but
      // the delivery is recorded exactly as retail's is.
      if (any_qty_received) {
        receipt = recordReceipt(db, {
          poId, storeId: null, scope: 'kitchen',
          actor: { userId: req.user.id, label: req.user.display_name || req.user.username || null, realm: 'kitchen' },
          receipts, note: (req.body && req.body.receipt_note) || null,
        });
      }
      // The return is its own event, in the other direction, and never folded
      // into the delivery record beside it — see recordReceipt's `kind`.
      if (returnMoves.size) {
        returnReceipt = recordReceipt(db, {
          poId, storeId: null, scope: 'kitchen', kind: 'return', returns: returnMoves,
          actor: { userId: req.user.id, label: req.user.display_name || req.user.username || null, realm: 'kitchen' },
          receipts, note: (req.body && req.body.return_note) || null,
        });
      }
    });
    tx();
    // Only re-post expenses when an actual received quantity was entered.
    // Tracking-only saves leave Finance untouched — tracking is buyer-side
    // metadata, not a money event.
    // A return is a money event even when nothing arrived on this save, so the
    // re-post follows either kind of change. Tracking-only saves still leave
    // Finance alone, which is the distinction this gate was always drawing.
    if (any_qty_received || returns.increased || returns.decreased) postPOExpenses(poId);
    logActivity(req.user.id, req.user.username, 'receive', 'purchase_order', poId,
      { lines: receipts.length, missing_lines, damaged_lines, total_missing, total_damaged,
        receipt_id: receipt?.receiptId ?? null, returned_lines, returned_units,
        return_receipt_id: returnReceipt?.receiptId ?? null }, req.ip);
    res.json({ success: true, missing_lines, damaged_lines, total_missing, total_damaged,
               returned_lines, returned_units,
               receipt_id: receipt?.receiptId ?? null, receipt_lines: receipt?.lines ?? 0,
               return_receipt_id: returnReceipt?.receiptId ?? null });
  } catch (e) {
    console.error('[receive PO error]', e);
    res.status(500).json({ error: 'Receive failed · 收货失败: ' + (e.message || 'unknown error') });
  }
});

// GET expense-post status for one PO (used by detail page indicator).
router.get('/api/purchases/:id/expense-status', requireAuth, requirePermission('purchases'), (req, res) => {
  const poId = parseInt(req.params.id, 10);
  if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
  const po = getKitchenPO(poId);
  if (!po) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const rows = db.prepare(`SELECT category, amount FROM expense_entries WHERE po_id = ? ORDER BY id`).all(poId);
  const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const lineCount = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ?`).get(poId).c;
  const zeroCostLines = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(cost_per_unit,0) = 0`).get(poId).c;
  // Number of lines whose received-or-ordered qty would actually contribute
  // to the expense post (>0). This is the same filter postPOExpenses uses.
  const liveLines = db.prepare(`SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(qty_received, qty) > 0`).get(poId).c;
  // Compute a smart reason when posted=0 so the UI can explain why.
  // Mirrors the same checks postPOExpenses runs internally.
  const POSTABLE = new Set(['Ordered','Delivered','Confirmed']);
  let skipped = null;
  if (rows.length === 0) {
    if (!POSTABLE.has(po.status)) skipped = 'not-postable';
    else if (lineCount === 0)     skipped = 'no-line-items';
    else if (liveLines === 0)     skipped = 'no-live-qty';   // every line has qty=0 / received=0
    else if (zeroCostLines === lineCount) skipped = 'all-zero-cost';
    else                           skipped = 'never-posted'; // rows exist with cost+qty but nothing was written → posting was never triggered
  }
  res.json({ success: true,
    status: po.status, posted: rows.length, total, skipped,
    categories: rows.map(r => ({ category: r.category, amount: +r.amount })),
    diagnostics: { lineCount, zeroCostLines, liveLines },
  });
});

// POST manual re-post — useful after editing prices or if the auto-post
// silently failed for any reason. Returns the same shape as the helper
// so the UI can show what happened.
router.post('/api/purchases/:id/repost-expense', requireAuth, requirePermission('purchases'), (req, res) => {
  const poId = parseInt(req.params.id, 10);
  if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
  const r = postPOExpenses(poId);
  logActivity(req.user.id, req.user.username, 'repost_expense', 'purchase_order', poId, r, req.ip);
  res.json({ success: true, ...r });
});

// POST /api/purchases/:id/order — transition to "Ordered" with optional split.
// Body: { defer_line_ids: [..] }  — lines listed here are removed from this PO
// and placed into a fresh Requested PO (linked via backorder_of) so the user
// can keep tracking what's still owed by the supplier. Empty/missing array =
// order everything.
// Unconditionally calls firePriceAlertsForPO on every successful order —
// blocked outright (material cost columns).
router.post('/api/purchases/:id/order', requireAuth, requirePermission('purchases'), blockCostWrite('material cost'), (req, res) => {
  try {
    const poId = parseInt(req.params.id, 10);
    if (!poId) return res.status(400).json({ error: 'invalid PO id · 采购单 ID 无效' });
    const src = getKitchenPO(poId);
    if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
    const defer = Array.isArray(req.body?.defer_line_ids) ? req.body.defer_line_ids.map(n => parseInt(n,10)).filter(Boolean) : [];

    let splitId = null, splitNumber = null;
    const tx = db.transaction(() => {
      if (defer.length) {
        // Make a sibling PO for the deferred lines and move them across.
        const lines = db.prepare(`SELECT * FROM po_line_items WHERE po_id = ? AND id IN (${defer.map(()=>'?').join(',')})`).all(poId, ...defer);
        if (lines.length) {
          const today = new Date().toISOString().slice(0, 10);
          splitNumber = nextKitchenPONumber(db);
          const r = db.prepare(`INSERT INTO purchase_orders
            (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by, backorder_of)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            splitNumber, today, null, 'Requested',
            src.supplier, src.warehouse,
            `Deferred from ${src.po_number}${src.notes ? ' · ' + src.notes : ''}`,
            'split', req.user.id, src.id
          );
          splitId = r.lastInsertRowid;
          // Move (not copy) the line items into the new PO.
          db.prepare(`UPDATE po_line_items SET po_id = ? WHERE po_id = ? AND id IN (${defer.map(()=>'?').join(',')})`).run(splitId, poId, ...defer);
        }
      }
      db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('Ordered', poId);
    });
    tx();
    // Now that the PO is at Ordered, fire price alerts so a buyer recording a
    // higher-than-expected price gets surfaced immediately. (The other two
    // status-flip paths already do this; this one used to silently skip it.)
    firePriceAlertsForPO(poId, 'po_ordered');
    postPOExpenses(poId);  // Ordered isn't paid-yet, but keep the row idempotent.
    logActivity(req.user.id, req.user.username, 'order_split', 'purchase_order', poId,
      { deferred_lines: defer.length, split_po: splitNumber }, req.ip);
    res.json({ success: true, split_po_id: splitId, split_po_number: splitNumber });
  } catch (e) {
    console.error('[order split error]', e);
    res.status(500).json({ error: 'Order failed · 下单失败: ' + (e.message || 'unknown') });
  }
});

// POST /api/purchases/:id/backorder — clones outstanding lines (qty - received
// > 0) into a fresh Requested PO linked back via backorder_of. Used when the
// supplier short-shipped and you want to keep tracking the unfulfilled qty.
router.post('/api/purchases/:id/backorder', requireAuth, requirePermission('purchases'), (req, res) => {
  const src = getKitchenPO(req.params.id);
  if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const lines = db.prepare(`SELECT * FROM po_line_items WHERE po_id = ?
    AND (COALESCE(qty_received, qty) < qty)
    ORDER BY sort_order`).all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: 'No outstanding qty · 没有缺货项目' });

  const today = new Date().toISOString().slice(0, 10);
  const po_number = nextKitchenPONumber(db);

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders
      (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by, backorder_of)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      po_number, today, null, 'Requested',
      src.supplier, src.warehouse,
      `Back-order from ${src.po_number}${src.notes ? ' · ' + src.notes : ''}`,
      'backorder', req.user.id, src.id
    );
    const newId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    lines.forEach((l, i) => {
      const outstanding = (parseFloat(l.qty) || 0) - (l.qty_received == null ? 0 : parseFloat(l.qty_received) || 0);
      const total = outstanding * (parseFloat(l.cost_per_unit) || 0);
      // Carry supplier_name + purchase_channel + note forward; invoice_received
      // resets to false on the back-order so the new line tracks its own
      // separate fulfilment.
      ins.run(newId, l.ingredient_id, l.name_en, l.name_cn, l.sku, outstanding, l.unit, l.cost_per_unit, total, storeCategory(db, l.expense_category),
        l.supplier_name || null, l.purchase_channel || null, l.note || null, i);
    });
    return { newId, po_number };
  });
  const r = tx();
  logActivity(req.user.id, req.user.username, 'backorder', 'purchase_order', r.newId, { from: src.id, lines: lines.length, po_number: r.po_number }, req.ip);
  res.json({ success: true, id: r.newId, po_number: r.po_number });
});

// DELETE expense rows + log when a PO is hard-deleted (we keep them otherwise
// because expense_entries.po_id is FK without CASCADE).
function clearPOExpenses(poId) {
  db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
}

// POST duplicate — clones a PO into a fresh draft (status=Requested, new
// po_number, today's date). Items are copied verbatim. Useful for recurring
// orders to the same supplier.
router.post('/api/purchases/:id/duplicate', requireAuth, requirePermission('purchases'), (req, res) => {
  const src = getKitchenPO(req.params.id);
  if (!src) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order').all(src.id);

  const today = new Date().toISOString().slice(0, 10);
  const po_number = nextKitchenPONumber(db);

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders
      (po_number, date, delivery_date, status, supplier, warehouse, notes, source, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      po_number, today, null, 'Requested',
      src.supplier, src.warehouse, src.notes ? src.notes + ' (copy)' : null,
      'manual', req.user.id
    );
    const newId = r.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO po_line_items
      (po_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost, expense_category,
       supplier_name, purchase_channel, note, lot_number, expiry_date, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Copy structure but DROP lot/expiry + invoice flag on duplicate —
    // those are per-delivery; a duplicate PO is a fresh order so blank-out
    // makes sense. supplier_name + purchase_channel + note ARE carried forward
    // since the buyer is likely re-ordering from the same place.
    items.forEach(i => ins.run(newId, i.ingredient_id, i.name_en, i.name_cn, i.sku, i.qty, i.unit, i.cost_per_unit, i.total_cost, storeCategory(db, i.expense_category),
      i.supplier_name || null, i.purchase_channel || null, i.note || null, null, null, i.sort_order));
    return { newId, po_number };
  });
  const r = tx();
  logActivity(req.user.id, req.user.username, 'duplicate', 'purchase_order', r.newId, { from: src.id, po_number: r.po_number }, req.ip);
  res.json({ success: true, id: r.newId, po_number: r.po_number });
});

// DELETE PO
router.delete('/api/purchases/:id', requireAuth, requireDelete, requirePermission('purchases'), (req, res) => {
  // Clear linked expense rows first — expense_entries.po_id is FK without
  // CASCADE so this prevents stale finance entries pointing to a missing PO.
  clearPOExpenses(req.params.id);
  db.prepare('DELETE FROM po_line_items WHERE po_id = ?').run(req.params.id);
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, req.user.username, 'delete', 'purchase_order', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── Lot tracking / recall traceability ──────────────────────────────────────

// GET /api/lots/search?q=2024-A — find every PO line item with that lot,
// joined to the parent PO so the user can trace back to supplier + date.
router.get('/api/lots/search', requireAuth, requirePermission('purchases'), (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ success: true, data: [] });
  const rows = db.prepare(`
    SELECT pli.*, po.po_number, po.date AS po_date, po.delivery_date, po.supplier, po.status
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.lot_number LIKE ?
    ORDER BY po.date DESC, pli.id DESC
    LIMIT 200
  `).all('%' + q + '%');
  res.json({ success: true, data: rows });
});

// PUT /api/purchases/:id/line/:line_id/invoice — set one line's invoice
// status. Body: { invoice_status: 'not_received' | 'received' | 'no_invoice' }.
// Used by the Invoice Tracking report so accounting can flip status as
// invoices come in (or as suppliers are confirmed not to issue any).
const INVOICE_STATUSES = new Set(['not_received', 'received', 'no_invoice']);
router.put('/api/purchases/:id/line/:line_id/invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const lineId = parseInt(req.params.line_id, 10);
  const poId   = parseInt(req.params.id, 10);
  if (!lineId || !poId) return res.status(400).json({ error: 'invalid id · ID 无效' });
  const status = (req.body && req.body.invoice_status) || '';
  if (!INVOICE_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invoice_status must be not_received | received | no_invoice · 状态无效' });
  }
  // Writes the no_invoice_expected mark and the legacy invoice_received bit
  // alongside the status. The mark is the column the Invoices tab and Finance
  // actually read: setting 'no_invoice' here without it left this line still
  // being chased as awaiting, and clearing it here without lowering the mark
  // left it marked 不开发票 on screens this one cannot see.
  const r = setLineInvoiceStatus(db, lineId, status, poId);
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'invoice_status_change', 'po_line_item', lineId, { invoice_status: status }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/supplier — set just the supplier (and optional
// warehouse) on the PO header without touching the rest. Useful from the
// Invoices tab when accounting wants to assign a supplier name to old
// POs that fell into the "未指定 Unspecified" bucket.
router.put('/api/purchases/:id/supplier', requireAuth, requirePermission('purchases'), (req, res) => {
  const supplier = (req.body?.supplier || '').trim();
  if (!supplier) return res.status(400).json({ error: 'supplier required · 供应商必填' });
  const r = db.prepare('UPDATE purchase_orders SET supplier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(supplier, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  logActivity(req.user.id, req.user.username, 'set_supplier', 'purchase_order', req.params.id, { supplier }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/line/:line_id/no-invoice — flag ONE line as
// "no invoice expected" (cash / market line on a mixed buying order).
// Toggle, not destructive.
router.put('/api/purchases/:id/line/:line_id/no-invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const flag = !!(req.body && req.body.no_invoice_expected);
  const r = setNoInvoiceMark(db, parseInt(req.params.line_id, 10), flag, parseInt(req.params.id, 10));
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'line_no_invoice_toggle', 'po_line_item', req.params.line_id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/line/:line_id/supplier — set ONE line's supplier.
// Used by the inline picker on the Invoices tab when a line landed in
// "未指定 Unspecified" because no supplier was set.
router.put('/api/purchases/:id/line/:line_id/supplier', requireAuth, requirePermission('purchases'), (req, res) => {
  const supplier = (req.body?.supplier || '').trim();
  if (!supplier) return res.status(400).json({ error: 'supplier required · 供应商必填' });
  const r = db.prepare('UPDATE po_line_items SET supplier_name = ? WHERE id = ? AND po_id = ?')
    .run(supplier, req.params.line_id, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Line not found · 行未找到' });
  logActivity(req.user.id, req.user.username, 'set_line_supplier', 'po_line_item', req.params.line_id, { supplier }, req.ip);
  res.json({ success: true });
});

// PUT /api/purchases/:id/no-invoice — flag a PO as "supplier doesn't issue
// an invoice for this purchase" (cash / market). Removes it from the
// awaiting-invoice list. Toggle, not destructive.
router.put('/api/purchases/:id/no-invoice', requireAuth, requirePermission('purchases'), (req, res) => {
  const flag = !!(req.body && req.body.no_invoice_expected);
  const r = db.prepare('UPDATE purchase_orders SET no_invoice_expected = ? WHERE id = ?')
    .run(flag ? 1 : 0, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'PO not found · 采购单未找到' });
  logActivity(req.user.id, req.user.username, 'no_invoice_toggle', 'purchase_order', req.params.id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true });
});

// GET /api/lots/expiring?days=7 — line items whose expiry_date is within N days
// (or already past). Used by the dashboard "Expiring soon" card and the
// Lot Tracker page. Only Delivered/Confirmed POs count — Requested/Ordered
// items haven't physically arrived yet.
router.get('/api/lots/expiring', requireAuth, requirePermission('purchases'), (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db.prepare(`
    SELECT pli.*, po.po_number, po.supplier, po.status
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.expiry_date IS NOT NULL
      AND pli.expiry_date <= date('now', '+' || ? || ' days')
      AND po.status IN ('Delivered', 'Confirmed')
    ORDER BY pli.expiry_date ASC
    LIMIT 200
  `).all(days);
  // Annotate each row with how many days until expiry (negative = past)
  const today = new Date().toISOString().slice(0, 10);
  const t = new Date(today);
  rows.forEach(r => {
    const exp = new Date(r.expiry_date);
    r.days_until = Math.round((exp - t) / 86400000);
  });
  res.json({ success: true, data: rows });
});

// GET /api/lots/all — list every distinct lot # currently in inventory
// (Delivered/Confirmed only). Useful for the lot tracker autocomplete.
router.get('/api/lots/all', requireAuth, requirePermission('purchases'), (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT pli.lot_number, pli.name_en, pli.name_cn, pli.sku, MAX(po.date) AS last_received
    FROM po_line_items pli
    JOIN purchase_orders po ON po.id = pli.po_id
    WHERE pli.lot_number IS NOT NULL AND pli.lot_number != ''
      AND po.status IN ('Delivered', 'Confirmed')
    GROUP BY pli.lot_number, pli.name_en
    ORDER BY last_received DESC
    LIMIT 500
  `).all();
  res.json({ success: true, data: rows });
});

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
