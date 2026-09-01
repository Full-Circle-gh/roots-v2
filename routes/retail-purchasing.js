// Retail purchasing — the online store's buying department.
//
// Shares the kitchen procurement engine (suppliers, supplier_documents,
// purchase_orders, po_line_items, expense_entries) but lives behind the Mini
// App Backend operator gate. Differences from the kitchen module:
//   • POs carry scope='retail' + a retail_stores.id they restock into
//     (kitchen POs stay scope='kitchen'; the kitchen list filters them apart)
//   • A line item reference EITHER store_products (store_product_id) OR
//     ingredients (ingredient_id) — mutually exclusive, never both. A material
//     line is Phase 1b (§28 addendum item 2): buying a material still needs a
//     PO, but a material has no stock table, so its "receiving" is a price
//     write-back (ingredient_price_history + the ±5% alert, via
//     firePriceAlertsForPO — see below), never a call to inventory.adjustStock.
//   • Receiving a PRODUCT line pushes goods into retail_store_stock via
//     inventory.adjustStock, which writes the stock ledger AND fans out to
//     Meituan/Guanyi/Eleme sync. po_line_items.stock_applied_qty remembers
//     what's already been applied so a corrected receive only moves the
//     difference (idempotent, both ways). A MATERIAL line never touches this.
//   • Expense auto-posting mirrors routes/purchases.js postPOExpenses —
//     retail POs land in Finance → Expenses the moment they're Ordered.
//   • created_by stays NULL: it FKs kitchen `users`, and backend operators live
//     in tenant_users (separate id space; FK enforcement is ON). The actor is
//     recorded in the activity log + stock ledger instead.
//
// NOTE (multi-tenant): the purchasing tables live on the shared control-plane
// db today. When a second tenant needs purchasing, these tables need a
// tenant_id column + scoping — flagged in the roadmap, not built here.

const express = require('express');
const db = require('../database');
const { tdb, currentTenantId } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
// Finance category text — the one normalisation. See lib/category-text.js.
const { storeCategory } = require('../lib/category-text');
const { logActivity } = require('../middleware/auth');
const { requireRetailAdmin } = require('./retail');
// Materials Phase 1b (§28 addendum item 2): a retail PO line can carry
// ingredient_id instead of store_product_id. Price history + the ±5% alert
// for that line reuse routes/purchases.js's write-back verbatim — server.js
// loads that module first (line ~344, before this one at ~370), so this
// require resolves the already-cached router with firePriceAlertsForPO
// attached to it. One alert path, not two.
const { firePriceAlertsForPO, allocateLandedExtras, planReceiptReasons,
        recordReceipt, appliedReceiptStore, postPOExpenses } = require('./purchases');
// The ONE rule for "this kitchen order has been replaced by the copy somebody
// made of it here" — read lib/po-supersede.js before changing either ledger it
// governs. Consumed by the expense poster below and by the 发票 chase.
const { notSupersededByCopySql, supersededByCopySql, invoicedOnSuperseded,
        PLACED_COPY_STATUSES } = require('../lib/po-supersede');
// Goods that arrived, were accepted, and went BACK. lib/po-returns.js is the
// one definition site for what a return does to stock, to the books and to the
// 发票 chase — this file reads all three of those numbers and must not invent a
// fourth. Read that header before changing anything below that mentions a
// return.
const { planReturns, billableQtySql, billableQty, onHandQty } = require('../lib/po-returns');
const { recipeOwnsProductCost } = require('../lib/recipe-rollup');

const router = express.Router();

const PO_STATUSES = new Set(['Requested', 'Ordered', 'Delivered', 'Cancelled']);
const VALID_INVOICE = new Set(['not_received', 'received', 'no_invoice']);

// Next RPO number from the highest existing suffix (not a row count, so a
// deleted PO can never cause a UNIQUE collision on po_number).
function nextRetailPONumber() {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(po_number, 5) AS INTEGER)) AS n FROM purchase_orders WHERE po_number LIKE 'RPO-%'"
  ).get();
  return 'RPO-' + String((row?.n || 0) + 1).padStart(4, '0');
}

function getRetailPO(id) {
  return db.prepare(
    "SELECT * FROM purchase_orders WHERE id = ? AND COALESCE(scope,'kitchen') = 'retail' AND COALESCE(tenant_id,1) = ?"
  ).get(id, currentTenantId());
}

function actorLabel(req) {
  return req.user?.display_name || req.user?.username || null;
}

// Shape firePriceAlertsForPO's optional `actor` param wants, so a cost_update
// activity_log row it writes carries who made this PO's material price
// write-back — the record rollbackMaterialCost() below reads back.
function actorFor(req) {
  return { userId: req.user?.id || null, username: actorLabel(req), ip: req.ip };
}

// ── Expense auto-posting — mirror of routes/purchases.js postPOExpenses ────
// Idempotent DELETE-then-INSERT keyed on po_id; posts on Ordered/Delivered,
// wiped when the PO drops back to Requested (or is Cancelled). Amount uses
// qty_received once receiving started, so shortages adjust the books — LESS
// anything sent back to the supplier (lib/po-returns.js billableQtySql).
//
// A RETURN CORRECTS THE PURCHASE IN PLACE; IT DOES NOT OPEN A SECOND ENTRY.
// The rows are rewritten under the same po_id and re-dated to po.date, so
// flour bought on 25 August and sent back on 1 September leaves August holding
// what August actually cost. That is the whole reason this poster has always
// been DELETE-then-INSERT rather than append: there is one purchase, so there
// is one set of expense rows, and every correction restates them.
//
// The cost of that choice, stated rather than hidden: a return restates a month
// that may already have been reported, and nothing in this codebase locks a
// period to stop it (docs/purchase-returns.md, WHAT THIS DOES NOT DO). The
// alternative — booking the credit in the month the goods went back — is a
// different accounting policy, not a bug fix, and it is not one this file may
// choose on a tenant's behalf.
function postRetailPOExpenses(poId) {
  const po = db.prepare('SELECT id, date, supplier, po_number, status, extra_freight, extra_tax, extra_handling FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) return { skipped: 'po-missing' };
  db.prepare('DELETE FROM expense_entries WHERE po_id = ?').run(poId);
  if (!['Ordered', 'Delivered'].includes(po.status)) return { skipped: 'not-postable' };
  const groups = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(expense_category),''),'门店进货 Retail stock') AS category,
           SUM(${billableQtySql()} * COALESCE(cost_per_unit, 0))               AS amount,
           COUNT(*)                                                            AS line_count
      FROM po_line_items
     WHERE po_id = ? AND ${billableQtySql()} > 0
     GROUP BY 1
  `).all(poId);
  const insert = db.prepare('INSERT INTO expense_entries (date, amount, category, description, po_id) VALUES (?,?,?,?,?)');
  let inserted = 0, total = 0;
  for (const g of groups) {
    if (!g.amount || g.amount <= 0) continue;
    const desc = `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · ${g.line_count} line${g.line_count === 1 ? '' : 's'}`;
    insert.run(po.date, +g.amount, g.category, desc, poId);
    inserted++; total += +g.amount;
  }
  // Landed-cost extras (freight/tax/handling) post as one shipping & fees line.
  const extras = (+po.extra_freight || 0) + (+po.extra_tax || 0) + (+po.extra_handling || 0);
  if (extras > 0) {
    insert.run(po.date, extras, '运费及杂费 Freight & fees',
      `${po.po_number}${po.supplier ? ' · ' + po.supplier : ''} · shipping & fees`, poId);
    inserted++; total += extras;
  }
  return { inserted, total };
}

// A copy pulled out of the kitchen list shares its purchase with the kitchen
// order it came from, and the two must never both be in the books. postPOExpenses
// refuses to post a kitchen order while a placed copy stands it down
// (lib/po-supersede.js), but it only learns that when something asks it to
// re-post — and nothing touches the kitchen row when the buyer places the copy
// HERE. So the copy asks on its behalf, on every one of its own posts: placing
// this copy wipes the original's expense rows, and putting it back to Draft or
// cancelling it posts them again. Both directions, one call, no stored flag.
//
// Wrapped rather than folded into postRetailPOExpenses' body so that the five
// call sites keep reading as "re-post this order" and get the pair kept honest
// for free.
function postRetailPOExpensesWithSource(poId) {
  const posted = postRetailPOExpenses(poId);
  const src = db.prepare('SELECT copied_from_po_id FROM purchase_orders WHERE id = ?').get(poId);
  if (src && src.copied_from_po_id) postPOExpenses(src.copied_from_po_id);
  return posted;
}

// ── Stock application — push received goods into store inventory ───────────
// good = qty_received − damaged_qty − returned_qty (lib/po-returns.js
// onHandQty); apply (good − stock_applied_qty) as a delta through
// inventory.adjustStock (ledger row + channel sync fan-out). Safe to call
// repeatedly; corrections move stock in either direction.
//
// A RETURN NEEDS NO PATH OF ITS OWN HERE, and that is the point of expressing
// it as a quantity on the line rather than as an event to replay: goods going
// back out lower `good`, which makes the delta negative, which is a mechanism
// this function has always had and which /undo-receive already proved. What a
// return does NOT get to do is drive the shelf below zero unnoticed —
// adjustStock clamps at zero, so the receive route refuses a return the shelf
// cannot honour BEFORE any of this runs (planReturnRemoval below).
//
// A PRODUCT line also writes its price back to store_products.unit_cost — the
// mirror of what firePriceAlertsForPO does for a MATERIAL line, and the reason
// margin can be shown at all. Last price wins, no averaging: Roots buys and
// resells, so "cost" means whatever the most recent delivery charged.
// MATERIAL LINES ARE UNTOUCHED BY THIS — they still `continue` on the very next
// line and their pricing stays entirely with firePriceAlertsForPO /
// ingredient_price_history / the ±5% alert, which this change does not go near.
// `storeId` is WHERE THIS RECEIPT ACTUALLY WENT, which is not always the store
// the order was raised against — the receive route now takes an optional one
// and defaults it to the PO's. Passing it in rather than reading po.store_id
// here is the whole location fix: the shelf that gains the goods is the shelf
// the person at the door named.
function applyReceivedToStock(poId, req, storeId) {
  const po = getRetailPO(poId);
  const targetStore = storeId ?? po?.store_id ?? null;
  if (!po || !targetStore) return { applied: 0, costed: 0, costSkippedRecipe: 0, landedSkipped: [] };
  // The PO's freight/tax/handling, split over its lines by goods value — the
  // SAME allocation firePriceAlertsForPO uses for materials (routes/purchases.js
  // allocateLandedExtras). A product's stored cost is what it cost to get onto
  // the shelf, not what the supplier's line said, and the two cost paths must
  // not disagree about how the extras were split.
  //
  // On tdb() for the same reason the reads below are: it reads purchase_orders
  // and po_line_items, which are tenant data. Handing it `db` would allocate a
  // non-Roots receipt's extras from Roots' purchase order.
  const landed = allocateLandedExtras(poId, tdb());
  // tdb(), not the global handle — for the reason planPOReversal states below
  // ("EVERYTHING RUNS ON tdb()"): po_line_items and store_products are tenant
  // data, so `db` is the MAIN database for any tenant running isolated. The
  // cost write-back here was the one statement in this file's cost path still
  // on the global handle, which meant a non-Roots receipt read its own PO lines
  // through one connection and stamped Roots' unit_cost through another.
  const lines = tdb().prepare(`
    SELECT id, store_product_id, ingredient_id, qty_received, damaged_qty, returned_qty,
           stock_applied_qty, name_en, cost_per_unit
      FROM po_line_items WHERE po_id = ?
  `).all(poId);
  const readCost   = tdb().prepare('SELECT unit_cost FROM store_products WHERE id = ?');
  const writeCost  = tdb().prepare('UPDATE store_products SET unit_cost = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  let applied = 0, costed = 0, costSkippedRecipe = 0;
  for (const l of lines) {
    // Materials have no stock table (§28) — a material line's "receiving" is
    // the price write-back firePriceAlertsForPO does on the Ordered/Delivered
    // status transition (see the /status and /:id routes below), not a stock
    // adjustment here. Deliberate no-op, not the old silent skip: that one
    // dropped ANY line without a store_product_id, including one that should
    // have priced a material and never did.
    if (l.ingredient_id) continue;
    if (!l.store_product_id || l.qty_received == null) continue;
    // Whole units: retail_store_stock.physical_qty is an INTEGER, so both the
    // applied bookkeeping and the delta are rounded the same way — repeated
    // saves always converge instead of drifting on a fractional entry.
    const good = Math.round(onHandQty(l) || 0);
    const alreadyApplied = Math.round(parseFloat(l.stock_applied_qty) || 0);
    const delta = good - alreadyApplied;
    if (delta !== 0) {
      inventory.adjustStock({
        storeId: targetStore, productId: l.store_product_id, deltaQty: delta,
        actorUserId: req.user?.id || null, actorLabel: actorLabel(req),
        note: po.po_number, reason: 'restock',
      });
      applied++;
    }
    tdb().prepare('UPDATE po_line_items SET stock_applied_qty = ? WHERE id = ?').run(good, l.id);

    // Cost write-back. Deliberately NOT inside the `delta !== 0` branch above: a
    // correction that re-saves the same quantity at a different price is exactly
    // the case where the cost moved and the stock did not.
    //
    // An unusable price LEAVES THE EXISTING COST ALONE rather than clearing it.
    // A line can legitimately carry no price (a freebie, a sample, a not-yet
    // -invoiced delivery), and letting that write 0 or NULL would throw away a
    // real cost and report a 100% margin on the next screen.
    // A product Roots MAKES takes its cost from its recipe, and the recipe
    // cascade owns that figure — receiving must not overwrite it with what a
    // delivery of the ingredients happened to charge. With Production off this
    // is false and the purchase-order fill below resumes exactly as before.
    //
    // LANDED, not invoiced: the line's share of the PO's extras is added on top
    // of the supplier's unit price. Zero when the PO carries no extras, so every
    // PO written before this behaves exactly as it did.
    const invoiced = parseFloat(l.cost_per_unit);
    const cost = Number.isFinite(invoiced) && invoiced > 0
      ? invoiced + (landed.perUnit.get(l.id) || 0)
      : invoiced;
    if (recipeOwnsProductCost(tdb(), l.store_product_id)) { costSkippedRecipe++; }
    else if (Number.isFinite(cost) && cost > 0) {
      const before = readCost.get(l.store_product_id)?.unit_cost ?? null;
      // Only write on an actual change, so re-saving a received PO does not
      // stamp updated_at or spend an audit row saying nothing happened.
      if (before === null || Math.abs(before - cost) > 1e-9) {
        writeCost.run(cost, l.store_product_id);
        costed++;
        // The audit trail is activity_log — the same mechanism this module's
        // header names for every other actor-attributed write here, and the one
        // that already tolerates a tenant operator with no kitchen users row
        // (it stores a NULL id and keeps the name). No new mechanism invented.
        logActivity(req.user?.id || null, actorLabel(req), 'cost_update', 'product', l.store_product_id,
          { from: before, to: cost, po_id: poId, po_number: po.po_number,
            line_id: l.id, name: l.name_en, source: 'po_receive',
            invoiced_unit_cost: invoiced, landed_share_per_unit: landed.perUnit.get(l.id) || 0 }, req.ip);
      }
    }
  }
  // Lines that took no share because they had no goods value — surfaced to the
  // receive response rather than swallowed, so the operator can see which line
  // is not carrying its part of the freight.
  return { applied, costed, costSkippedRecipe,
           landedSkipped: landed.extras > 0 ? landed.skipped : [] };
}

// ── Receipt reversal — all of it, or none of it ────────────────────────────
// Reversing a receipt asserts the goods never arrived. That is only true while
// they are still on the shelf. Where some have already been sold or consumed
// the assertion is false, so the reversal is REFUSED OUTRIGHT — no clamping to
// zero, no partial return, nothing written, not even the lines that would have
// succeeded. A partial reversal leaves stock and the order records disagreeing
// with no sign on any screen that they do, which is worse than a refusal the
// operator can read and act on.
//
// inventory.adjustStock's `Math.max(0, …)` clamp is deliberately NOT changed —
// other callers depend on it. This pre-check is what stops this path from ever
// reaching it, and the assertion below is what proves it never did.
//
// EVERYTHING RUNS ON tdb(). Three reasons, all load-bearing:
//   1. It is the handle adjustStock writes through, so the outer transaction
//      opened here CONTAINS its per-line transactions as savepoints. Without
//      that the check and the writes are separated by a window in which a sale
//      can land, and the clamp bites after all.
//   2. seam() caches one wrapper per handle and passes `transaction` straight
//      through to better-sqlite3, so the nesting above actually happens.
//   3. purchase_orders / po_line_items are tenant data, not control-plane
//      (lib/tenant-db.js CONTROL_PLANE_TABLES), so tdb() is the correct handle
//      for those writes too — `db` would be the main database for a tenant
//      running isolated.
// `storeId` — the shelf the goods actually landed on (appliedReceiptStore), not
// necessarily po.store_id. For every order that existed before receipts did,
// those are the same value, so this changes nothing about how any current PO
// reverses; it only stops a receipt taken in at another store being clawed back
// off the wrong shelf.
function planPOReversal(po, storeId) {
  const lines = tdb().prepare(`
    SELECT id, store_product_id, name_en, name_cn, stock_applied_qty
      FROM po_line_items
     WHERE po_id = ? AND store_product_id IS NOT NULL
       AND COALESCE(stock_applied_qty, 0) <> 0
  `).all(po.id);
  // AGGREGATED BY PRODUCT, NOT BY LINE. Nothing on the server stops two lines
  // of one PO carrying the same store_product_id — lineConflict() only rejects
  // product AND material on a single line, and the wizard's de-dupe is
  // client-side only. Checked per line, two 5-unit lines against 6 units on the
  // shelf would both pass their own test and the second would clamp.
  const byProduct = new Map();
  for (const l of lines) {
    const qty = Math.round(parseFloat(l.stock_applied_qty) || 0);
    if (!qty) continue;
    const seen = byProduct.get(l.store_product_id);
    if (seen) seen.qty += qty;
    else byProduct.set(l.store_product_id, {
      product_id: l.store_product_id, qty,
      name_en: l.name_en || null, name_cn: l.name_cn || null,
    });
  }
  // A product with no stock row reads 0, so any reversal against it blocks —
  // which is right: there is nothing there to give back.
  const readQty = tdb().prepare(
    'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  );
  const blocking = [];
  for (const p of byProduct.values()) {
    const have = Math.round(parseFloat(readQty.get(storeId, p.product_id)?.physical_qty) || 0);
    if (p.qty > have) blocking.push({ ...p, on_shelf: have, short: p.qty - have });
  }
  return { lines, products: [...byProduct.values()], blocking };
}

// Returns { blocked: [...] } and writes nothing, or { blocked: null,
// reversed_units, reversed_lines } having reversed every line in full.
// reversed_units counts UNITS ACTUALLY RETURNED TO THE SHELF, not lines
// attempted — the old count reported the latter and called it success.
function reversePOStock(po, req, storeId) {
  let outcome = { blocked: null, reversed_units: 0, reversed_lines: 0 };
  const tx = tdb().transaction(() => {
    // Planned INSIDE the transaction: the reads and the writes must not be
    // separable by a concurrent sale.
    const plan = planPOReversal(po, storeId);
    if (plan.blocking.length) { outcome = { blocked: plan.blocking, reversed_units: 0, reversed_lines: 0 }; return; }
    if (!plan.products.length) return;
    let units = 0;
    for (const p of plan.products) {
      const r = inventory.adjustStock({
        storeId, productId: p.product_id, deltaQty: -p.qty,
        actorUserId: req.user?.id || null, actorLabel: actorLabel(req),
        note: po.po_number, reason: 'restock_undo',
      });
      // The pre-check ran in this same transaction, so the clamp cannot have
      // bitten. Assert it rather than trust it — if this ever fires, the throw
      // rolls the whole transaction back and nothing is written, which is the
      // same promise the refusal makes.
      if (r.delta !== -p.qty) {
        const e = new Error('reversal_clamped');
        e.code = 'reversal_clamped';
        throw e;
      }
      units += p.qty;
    }
    // Only now, with every product proven fully returned, is the line
    // bookkeeping cleared. stock_applied_qty therefore records what actually
    // reversed: all of it, or — on the refusal path above — none of it.
    const clear = tdb().prepare('UPDATE po_line_items SET stock_applied_qty = 0 WHERE id = ?');
    for (const l of plan.lines) clear.run(l.id);
    outcome = { blocked: null, reversed_units: units, reversed_lines: plan.lines.length };
  });
  tx();
  return outcome;
}

// The refusal body. `undoBlocked` is the locked pair in
// docs/tacet-delivery-vocabulary.md ("Receipt reversal refused — purchasing",
// LOCKED 2026-08-27); the screen renders it. The server sends the FACTS only —
// which products, how short — because the language belongs to the viewer, not
// to the route. One shape for all three entry points, so they cannot diverge.
function blockedResponse(res, blocking) {
  return res.status(409).json({ success: false, error: 'undo_blocked', blocking });
}

// ── Can this return actually come off the shelf? ───────────────────────────
// The same test planPOReversal makes, asked of a return instead of an undo,
// and asked for the same reason: inventory.adjustStock CLAMPS at zero, so a
// return of three units against one on the shelf would remove one, write
// stock_applied_qty as though it had removed three, and leave the line and the
// shelf disagreeing with nothing on any screen saying so. REFUSES RATHER THAN
// CLAMPS, exactly as the undo path does, and refuses the WHOLE save — a return
// half-applied is worse than one not applied at all.
//
// ONLY WHEN THE SAVE INCREASES A RETURN. A save that merely lowers an arrived
// count reaches adjustStock the same way and has always been allowed to clamp;
// tightening that is a separate change to a path the warehouse uses daily, and
// is recorded in docs/purchase-returns.md rather than smuggled in here. So the
// caller gates on plan.increased, and within such a save the removal is
// measured in full — including any the corrected counts add — because by then
// the operator is being refused anyway and half a rule would be a lie.
//
// AGGREGATED BY PRODUCT for the reason planPOReversal spells out: two lines of
// one PO may carry the same store_product_id, and per-line checks would each
// pass against stock only one of them can have.
function planReturnRemoval(po, storeId, plans) {
  const byProduct = new Map();
  for (const plan of plans.values()) {
    const l = plan.line;
    // A material line moves no stock at all (§28) and a line with no arrived
    // count is skipped by applyReceivedToStock, so neither can be the reason a
    // shelf comes up short.
    if (l.ingredient_id || !l.store_product_id) continue;
    if (plan.next.received == null) continue;
    const applied = Math.round(parseFloat(l.stock_applied_qty) || 0);
    // What the shelf will hold for this line once this save lands — computed
    // through the same onHandQty() and the same rounding applyReceivedToStock
    // will use, so the check and the write cannot disagree about a half unit.
    const next = Math.round(onHandQty({
      qty_received: plan.next.received, damaged_qty: plan.next.damaged, returned_qty: plan.qty,
    }) || 0);
    const remove = applied - next;
    if (remove <= 0) continue;
    const seen = byProduct.get(l.store_product_id);
    if (seen) seen.qty += remove;
    else byProduct.set(l.store_product_id, {
      product_id: l.store_product_id, qty: remove,
      name_en: l.name_en || null, name_cn: l.name_cn || null,
    });
  }
  const readQty = tdb().prepare(
    'SELECT physical_qty FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
  );
  const blocking = [];
  for (const pr of byProduct.values()) {
    const have = Math.round(parseFloat(readQty.get(storeId, pr.product_id)?.physical_qty) || 0);
    if (pr.qty > have) blocking.push({ ...pr, on_shelf: have, short: pr.qty - have });
  }
  return blocking;
}

// Its own code, not undo_blocked. The two refusals share a shape and a shelf
// test but say different things: one is "this delivery cannot be taken back",
// the other "these goods cannot go back to the supplier", and an operator told
// the wrong one goes looking for the wrong order. docs/tacet-delivery-
// vocabulary.md carries both headlines and forbids collapsing them into one.
function returnBlockedResponse(res, blocking) {
  return res.status(409).json({ success: false, error: 'return_blocked', blocking });
}

// ── Material cost rollback — undo the ingredients.cost_per_unit / buy_price
// write firePriceAlertsForPO made for this PO's material lines, when leaving
// Ordered/Delivered (see the /status route below). Stock and expenses already
// reverse on that transition; the material price write-back did not, and a
// cancelled PO left its price standing — the bug this exists to close.
//
// firePriceAlertsForPO now logs a 'cost_update' activity_log row (entity_type
// 'ingredient') every time it writes, carrying the value it overwrote. That
// row is the ONLY source of truth for what the ingredient's cost was before
// this PO touched it — recomputing it from ingredient_price_history would mean
// re-running the pack-size/unit division against whatever the ingredient's
// fields hold *today*, which can have changed since, and that is a guess, not
// a fact. A material line on this PO with no such row (written before this
// logging existed, or the ingredient/PO predates it) has no recoverable prior
// value — reported back, never defaulted to 0 or left silently wrong.
//
// ── AND IT ASKS FOR IT ONLY WHERE THERE IS SOMETHING TO GIVE BACK ──────────
// The rule above is right; the population it was applied to was not. It
// demanded a record for EVERY priced material line, and two kinds of line can
// never have one and need none:
//
//   • THE ORDER NEVER PRICED IT. firePriceAlertsForPO refuses a line before it
//     writes anything — marked free, made not bought, unit mismatch, no
//     derivable cost — and records the refusal in ingredient_cost_skips. That
//     table is positive proof this order left the ingredient's cost alone, so
//     there is nothing for it to restore.
//   • THE ORDER'S PRICE IS NO LONGER STANDING. Something newer — another order,
//     a hand edit — has since moved the ingredient. rollbackMaterialCost
//     already declines to clobber that (`stillCurrent`), so blocking the whole
//     transition over a write it would not have touched protects nothing.
//
// WHAT THIS COST, before it was found: on the live database, SIX retail orders
// were refused and every blocking line on all six was the first case —
// packaging samples bought in `pcs` against a master in `bag`, and items with
// no pack contents to divide by. None of them had ever had a cost written, so
// the guard was holding orders hostage over ingredients it had nothing to say
// about. The screen tells the buyer to return an order to draft to change it
// and the wizard only opens a draft, so those orders could not be edited at
// all — a deadlock with a bare error code for an explanation.
//
// `buy_price` is what "still standing" is tested against, deliberately, and NOT
// cost_per_unit. buy_price is written STRAIGHT from po_line_items.cost_per_unit
// (firePriceAlertsForPO), so the test is a comparison of two stored numbers.
// cost_per_unit is derived through pack size and unit, and re-deriving it today
// to compare would be exactly the guess the paragraph above refuses to make.
function planMaterialCostRollback(po) {
  const materialLines = tdb().prepare(`
      SELECT ingredient_id, cost_per_unit FROM po_line_items
       WHERE po_id = ? AND ingredient_id IS NOT NULL AND cost_per_unit IS NOT NULL AND cost_per_unit > 0
    `).all(po.id);
  const materialIds = [...new Set(materialLines.map(r => r.ingredient_id))];
  if (!materialIds.length) return { restorable: [], unrecoverable: [] };
  const placeholders = materialIds.map(() => '?').join(',');
  // activity_log stays on the GLOBAL handle deliberately — it is a control-plane
  // table (lib/tenant-db.js CONTROL_PLANE_TABLES) and is never cloned into a
  // tenant DB, so tdb() would look for it where it does not exist. Everything
  // around it here is tenant data and moves to tdb().
  const logs = db.prepare(`
    SELECT entity_id, details FROM activity_log
     WHERE action = 'cost_update' AND entity_type = 'ingredient' AND entity_id IN (${placeholders})
     ORDER BY id ASC
  `).all(...materialIds);
  const byIngredient = new Map();
  for (const row of logs) {
    let d; try { d = JSON.parse(row.details); } catch (e) { continue; }
    if (!d || Number(d.po_id) !== Number(po.id)) continue;
    if (!byIngredient.has(row.entity_id)) byIngredient.set(row.entity_id, []);
    byIngredient.get(row.entity_id).push(d);
  }
  // Did this order refuse to price this ingredient? Guarded the same way
  // firePriceAlertsForPO guards its own use of the table — a database restored
  // from before it existed must not take the transition down with it. Absent,
  // the standing-price test below still catches most of the same lines.
  let skipped = new Set();
  try {
    skipped = new Set(tdb().prepare(`
      SELECT DISTINCT ingredient_id FROM ingredient_cost_skips WHERE po_id = ?
    `).all(po.id).map(r => r.ingredient_id));
  } catch (e) { console.warn('[cost rollback] ingredient_cost_skips unavailable:', e.message); }

  const restorable = [], unrecoverable = [];
  for (const id of materialIds) {
    const entries = byIngredient.get(id) || [];
    if (entries.length) {
      restorable.push({ ingredient_id: id, from: entries[0].from, to: entries[entries.length - 1].to });
      continue;
    }
    // No record of a prior value. Whether that matters depends on whether this
    // order has anything standing to give back.
    if (skipped.has(id)) continue;
    const ing = tdb().prepare('SELECT name_en, name_cn, buy_price FROM ingredients WHERE id = ?').get(id);
    const standing = materialLines.some(l => l.ingredient_id === id
      && Math.abs((parseFloat(l.cost_per_unit) || 0) - (parseFloat(ing?.buy_price) || 0)) < 1e-9);
    if (!standing) continue;
    unrecoverable.push({ ingredient_id: id, name_en: ing?.name_en || null, name_cn: ing?.name_cn || null,
                         buy_price: ing?.buy_price ?? null });
  }
  return { restorable, unrecoverable };
}

// Returns { blocked: [...] } and writes nothing, or { blocked: null, restored }.
// A material whose current cost no longer matches what this PO last wrote has
// already been re-priced by something newer (another PO, a manual edit) — that
// write is left alone rather than clobbered, same as it would be if two POs
// raced each other going forward.
function rollbackMaterialCost(po) {
  const plan = planMaterialCostRollback(po);
  if (plan.unrecoverable.length) return { blocked: plan.unrecoverable, restored: 0 };
  const readIng = tdb().prepare('SELECT buy_price, cost_per_unit FROM ingredients WHERE id = ?');
  const write = tdb().prepare('UPDATE ingredients SET buy_price = ?, cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  let restored = 0;
  for (const r of plan.restorable) {
    const cur = readIng.get(r.ingredient_id);
    if (!cur) continue;
    const stillCurrent = Math.abs((cur.buy_price ?? 0) - (r.to?.buy_price ?? 0)) < 1e-9
                       && Math.abs((cur.cost_per_unit ?? 0) - (r.to?.cost_per_unit ?? 0)) < 1e-9;
    if (!stillCurrent) continue;
    write.run(r.from?.buy_price ?? null, r.from?.cost_per_unit ?? 0, r.ingredient_id);
    restored++;
  }
  return { blocked: null, restored };
}

// ═══ Suppliers (shared master — same table the kitchen uses) ═══════════════

router.get('/api/retail-admin/suppliers', requireRetailAdmin, (req, res) => {
  const includeInactive = req.query.all === '1';
  const tid = Number(currentTenantId()) || 1;
  // A consolidated PO leaves po.supplier blank and carries the real supplier
  // per line instead (see supplierLabel() in 16-purchasing.js). Matching only
  // po.supplier here undercounted — the same order shows up fine on this
  // supplier's own detail page (whose scorecard already falls back to the
  // line-level supplier_name) but as 0 on this list. Mirror that same
  // fallback so the two never disagree again.
  const SUP_MATCH = "COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') = s.name";
  const rows = db.prepare(`
    SELECT s.id, s.name, s.name_cn, s.contact_name, s.contact_phone, s.contact_wechat,
           s.payment_terms, s.payment_method, s.rating, s.notes, s.is_active,
           s.channel_type, s.channel_link, s.products_supplied, s.price_info,
           s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM supplier_documents d WHERE d.supplier_id = s.id) AS doc_count,
           (SELECT COUNT(DISTINCT po.id) FROM purchase_orders po JOIN po_line_items pli ON pli.po_id = po.id
             WHERE COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}) AS po_count,
           (SELECT MAX(po.date) FROM purchase_orders po JOIN po_line_items pli ON pli.po_id = po.id
             WHERE COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}) AS last_po_date
      FROM suppliers s
     WHERE s.tenant_id = ?${includeInactive ? '' : ' AND s.is_active = 1'}
     ORDER BY s.name COLLATE NOCASE
  `).all(tid);
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  // Base64 payloads stay out of the detail read — documents fetch individually.
  delete s.channel_qr_data; delete s.business_license_data;
  delete s.permits_data; delete s.payment_qr_data;
  const tid = Number(currentTenantId()) || 1;   // integer — safe to inline in SQL
  const documents = db.prepare(`
    SELECT id, kind, label, filename, mime_type, size_bytes, uploaded_at
      FROM supplier_documents WHERE supplier_id = ? ORDER BY uploaded_at DESC
  `).all(s.id);
  const recentPOs = db.prepare(`
    SELECT id, po_number, date, status,
           (SELECT SUM(COALESCE(total_cost,0)) FROM po_line_items WHERE po_id = purchase_orders.id) AS total
      FROM purchase_orders
     WHERE supplier = ? AND COALESCE(scope,'kitchen') = 'retail' AND COALESCE(tenant_id,1) = ${tid}
     ORDER BY date DESC, id DESC LIMIT 10
  `).all(s.name);
  // Scorecard — honest, computed-from-history metrics only (no faked on-time/
  // fill without the data to back them). Lines match this supplier whether the
  // supplier sits on the line or only on the PO header.
  const SUP_MATCH = "COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') = ?";
  const stat = db.prepare(`
    SELECT COUNT(DISTINCT po.id) AS order_count,
           COALESCE(SUM(pli.total_cost),0) AS spend,
           MAX(po.date) AS last_date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}`).get(s.name) || {};
  // This tile used to be "Owed now": unpaid invoices, i.e. everything nobody
  // had clicked Mark paid on. On a business that pays before the 发票 exists
  // that was a balance of already-settled money. What the supplier actually
  // still owes us is PAPER, so that is what the tile reports now — and it comes
  // from the same computation the Invoices tab uses, so the two screens cannot
  // disagree about one supplier.
  const paper = awaitingForSupplier(tid, s.name);
  const priceList = db.prepare(`
    SELECT pli.store_product_id,
           MAX(pli.name_en) AS name_en, MAX(pli.name_cn) AS name_cn, MAX(pli.sku) AS sku,
           COUNT(*) AS times, AVG(pli.cost_per_unit) AS avg_cost, SUM(pli.qty) AS total_qty
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH} AND pli.store_product_id IS NOT NULL
     GROUP BY pli.store_product_id
     ORDER BY times DESC, name_en LIMIT 50`).all(s.name);
  const lastStmt = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id=? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND ${SUP_MATCH}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  for (const pl of priceList) {
    const l = lastStmt.get(pl.store_product_id, s.name) || {};
    pl.last_cost = l.cost != null ? l.cost : pl.avg_cost;
    pl.last_date = l.date || null;
  }
  const scorecard = {
    order_count: stat.order_count || 0, spend: stat.spend || 0, last_date: stat.last_date || null,
    awaiting: paper.awaiting, awaiting_lines: paper.awaiting_lines, product_count: priceList.length,
  };
  res.json({ success: true, data: { ...s, documents, recent_pos: recentPOs, scorecard, price_list: priceList } });
});

const SUPPLIER_FIELDS = ['name', 'name_cn', 'contact_name', 'contact_phone', 'contact_wechat',
  'payment_terms', 'payment_method', 'rating', 'notes', 'channel_type', 'channel_link',
  'products_supplied', 'price_info'];

router.post('/api/retail-admin/suppliers', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  // Scoped: without the tenant predicate one tenant's supplier name blocked
  // every other tenant from creating the same name (§0). The UNIQUE index on
  // suppliers.name is still global — see the PR, it needs a table rebuild.
  if (db.prepare('SELECT id FROM suppliers WHERE name = ? AND COALESCE(tenant_id,1) = ?').get(name, currentTenantId())) {
    return res.status(409).json({ success: false, error: 'name_taken' });
  }
  const info = db.prepare(`
    INSERT INTO suppliers (name, name_cn, contact_name, contact_phone, contact_wechat,
                           payment_terms, payment_method, rating, notes, channel_type,
                           channel_link, products_supplied, price_info, is_active, tenant_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  `).run(
    name, b.name_cn || null, b.contact_name || null, b.contact_phone || null, b.contact_wechat || null,
    b.payment_terms || null, b.payment_method || null,
    Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)),
    b.notes || null, b.channel_type || null, b.channel_link || null,
    b.products_supplied || null, b.price_info || null, currentTenantId(),
  );
  logActivity(req.user.id, req.user.username, 'create', 'supplier', info.lastInsertRowid, { name }, req.ip);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/api/retail-admin/suppliers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const s = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  if ('name' in b) {
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name_required' });
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ? AND id != ? AND COALESCE(tenant_id,1) = ?').get(name, s.id, currentTenantId());
    if (dup) return res.status(409).json({ success: false, error: 'name_taken' });
    b.name = name;
  }
  const sets = [], vals = [];
  for (const k of SUPPLIER_FIELDS) {
    if (k in b) {
      sets.push(`${k} = ?`);
      vals.push(k === 'rating' ? Math.min(5, Math.max(0, parseInt(b.rating, 10) || 0)) : (b[k] ?? null));
    }
  }
  if ('is_active' in b) { sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0); }
  if (!sets.length) return res.json({ success: true });
  vals.push(s.id);
  db.prepare(`UPDATE suppliers SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id,1) = ?`).run(...vals, currentTenantId());
  // Historical POs keep the old supplier name on purpose — they're a snapshot
  // of what was ordered from whom at the time (same rule as the kitchen side).
  logActivity(req.user.id, req.user.username, 'update', 'supplier', s.id, b, req.ip);
  res.json({ success: true });
});

// Soft-delete: keep the row (and its name) so historical POs stay attributable.
router.delete('/api/retail-admin/suppliers/:id', requireRetailAdmin, (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  db.prepare('UPDATE suppliers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(tenant_id,1) = ?').run(s.id, currentTenantId());
  logActivity(req.user.id, req.user.username, 'delete', 'supplier', s.id, {}, req.ip);
  res.json({ success: true });
});

// Documents — base64 data URI payloads (images / PDFs), 10MB per file.
router.post('/api/retail-admin/suppliers/:id/documents', requireRetailAdmin, express.json({ limit: '15mb' }), (req, res) => {
  const s = db.prepare('SELECT id FROM suppliers WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, currentTenantId());
  if (!s) return res.status(404).json({ success: false, error: 'not_found' });
  const b = req.body || {};
  if (!b.data || typeof b.data !== 'string') return res.status(400).json({ success: false, error: 'data_required' });
  if (b.data.length > 14 * 1024 * 1024) return res.status(413).json({ success: false, error: 'too_large' });
  const kind = ['license', 'permit', 'payment_qr', 'other'].includes(b.kind) ? b.kind : 'other';
  const info = db.prepare(`
    INSERT INTO supplier_documents (supplier_id, kind, label, filename, mime_type, size_bytes, data)
    VALUES (?,?,?,?,?,?,?)
  `).run(s.id, kind, b.label || null, b.filename || null, b.mime_type || null,
         b.size_bytes != null ? parseInt(b.size_bytes, 10) : null, b.data);
  logActivity(req.user.id, req.user.username, 'create', 'supplier_document', info.lastInsertRowid,
              { supplier_id: s.id, kind, filename: b.filename }, req.ip);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.get('/api/retail-admin/suppliers/:id/documents/:docId', requireRetailAdmin, (req, res) => {
  const doc = db.prepare('SELECT * FROM supplier_documents WHERE id = ? AND supplier_id = ?')
    .get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: doc });
});

router.delete('/api/retail-admin/suppliers/:id/documents/:docId', requireRetailAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM supplier_documents WHERE id = ? AND supplier_id = ?')
    .run(req.params.docId, req.params.id);
  if (!info.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'supplier_document', +req.params.docId,
              { supplier_id: +req.params.id }, req.ip);
  res.json({ success: true });
});

// ═══ Purchase orders (scope='retail') ══════════════════════════════════════

router.get('/api/retail-admin/purchases', requireRetailAdmin, (req, res) => {
  const { status, search, month, store_id } = req.query;
  let q = `
    SELECT po.*,
           (SELECT COUNT(*) FROM po_line_items i WHERE i.po_id = po.id)                        AS line_count,
           (SELECT SUM(COALESCE(i.total_cost,0)) FROM po_line_items i WHERE i.po_id = po.id)   AS total_cost,
           (SELECT COUNT(*) FROM po_line_items i WHERE i.po_id = po.id AND i.qty_received IS NOT NULL) AS received_lines,
           -- po.supplier is one string, left blank on a consolidated order that
           -- mixes several suppliers' items into one PO/store delivery. This
           -- gives the list something better than "No supplier" for that case
           -- (GROUP_CONCAT(DISTINCT ...) already drops NULL/blank on its own).
           (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(i.supplier_name),'')) FROM po_line_items i WHERE i.po_id = po.id) AS line_suppliers,
           -- Provenance for a copy pulled out of the kitchen list, so the row
           -- can say which PO-#### it mirrors rather than looking native.
           (SELECT k.po_number FROM purchase_orders k WHERE k.id = po.copied_from_po_id) AS copied_from_po_number
      FROM purchase_orders po
     WHERE COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ?`;
  const params = [currentTenantId()];
  if (status)   { q += ' AND po.status = ?'; params.push(status); }
  if (store_id) { q += ' AND po.store_id = ?'; params.push(parseInt(store_id, 10)); }
  if (month)    { q += ' AND substr(po.date, 1, 7) = ?'; params.push(String(month).slice(0, 7)); }
  if (search) {
    q += ` AND (po.po_number LIKE ? OR po.supplier LIKE ? OR po.id IN (
      SELECT po_id FROM po_line_items WHERE name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ? OR supplier_name LIKE ?))`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }
  q += ' ORDER BY po.date DESC, po.id DESC';
  const pos = db.prepare(q).all(...params);
  // Store names come from the tenant connection (retail_stores is data-plane).
  const stores = new Map(inventory.listStores({ activeOnly: false }).map(s => [s.id, s]));
  for (const po of pos) {
    const s = po.store_id ? stores.get(po.store_id) : null;
    po.store_name_en = s?.name_en || null;
    po.store_name_cn = s?.name_cn || null;
  }
  // The `search` above already reaches into po_line_items, so an order can
  // match on a product nothing on its row mentions — the reader is then told
  // "this one matched" and left to open it to find out why. Send back the
  // lines that actually matched so the row can name them. Only computed when
  // there is a search; an unsearched list pays nothing.
  if (search) {
    const like = `%${search}%`;
    const lines = db.prepare(`SELECT name_en, name_cn, sku FROM po_line_items
       WHERE po_id = ? AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)
       ORDER BY sort_order, id LIMIT 4`);
    for (const po of pos) po.matched_lines = lines.all(po.id, like, like, like);
  }
  res.json({ success: true, data: pos });
});

// ── Deliveries — reading receipts back as a list of DELIVERIES ─────────────
// The tables store one receipt per save. A person does not think in saves: a
// three-supplier order arriving over three days is three deliveries, and Jing
// fixing Shun's count an hour later is not a fourth — it is a correction to
// the one that already happened.
//
// THE RULE, and it is derived at read time rather than stamped at write time:
// a receipt is a DELIVERY when it is the first to receive at least one line.
// A receipt that only revisits lines an earlier receipt already covered is a
// CORRECTION, and it hangs under the line it corrects rather than earning a
// row of its own. Nothing is flagged when it is written because the same save
// is a delivery from one angle and a correction from another — Wednesday's
// receipt brought Red lentils for the first time AND revised Mint — and only
// the reader knows which question is being asked.
//
// THE TRANSITION GAP FALLS OUT OF THIS FOR FREE. A PO received before the
// tables existed has no receipt for its lines, so the first correction after
// the fact IS a first appearance, and renders as its own delivery rather than
// as a correction dangling off nothing. What that delivery cannot say is what
// came before it — hence untrackedLines() below, which the screen states in
// words instead of leaving a gap.
const DELIVERY_SQL = `
  SELECT r.id, r.po_id, r.store_id, r.actor_label, r.actor_realm, r.note, r.received_at,
         COALESCE(r.kind, 'receipt') AS kind,
         po.po_number, po.supplier, po.status AS po_status,
         (SELECT COUNT(*) FROM po_receipt_lines l WHERE l.receipt_id = r.id) AS line_count,
         -- Coverage is counted from RECEIPTS ONLY. A return row also names the
         -- line, but it is not a claim that the line was received — it is the
         -- opposite claim — so letting one count as coverage would make the
         -- next genuine correction to that line look like it had a delivery
         -- ahead of it and quietly drop it out of the list.
         (SELECT COUNT(*) FROM po_receipt_lines l
           WHERE l.receipt_id = r.id
             AND NOT EXISTS (
               SELECT 1 FROM po_receipt_lines l2 JOIN po_receipts r2 ON r2.id = l2.receipt_id
                WHERE l2.line_id = l.line_id AND r2.po_id = r.po_id AND r2.id < r.id
                  AND COALESCE(r2.kind, 'receipt') = 'receipt')
         ) AS new_lines
    FROM po_receipts r
    JOIN purchase_orders po ON po.id = r.po_id
   WHERE COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ?`;

// The lines of one receipt, each with what its PO line ORDERED — which is the
// only way "4 of 5" can be said at all, and the only way short/over is known.
function receiptLines(receiptId) {
  return db.prepare(`
    SELECT l.id, l.line_id, l.qty_received, l.damaged_qty, l.receipt_reason, l.note,
           l.returned_qty,
           pli.name_en, pli.name_cn, pli.sku, pli.unit, pli.qty AS ordered,
           pli.supplier_name
      FROM po_receipt_lines l
      JOIN po_line_items pli ON pli.id = l.line_id
     WHERE l.receipt_id = ?
     ORDER BY pli.sort_order, pli.id`).all(receiptId);
}

// short / damaged / over, from the lines of one delivery. The same three words
// the list marks a row with and the detail repeats per line.
//
// A RETURN IS FLAGGED AND NOTHING ELSE IS. Its lines carry the arrived counts
// the delivery left on them — they are a snapshot of the line, not a fresh
// claim — so running the three delivery tests over a return row would flag the
// original delivery's shortfall a second time, on the event that took goods
// back. Sent-back and came-up-short are the two facts this feature exists to
// keep apart, so the return row says only what it did.
function deliveryFlags(lines, kind) {
  if (kind === 'return') return ['returned'];
  const f = [];
  if (lines.some(l => l.qty_received != null && +l.qty_received < +l.ordered)) f.push('short');
  if (lines.some(l => +l.damaged_qty > 0)) f.push('damaged');
  if (lines.some(l => l.qty_received != null && +l.qty_received > +l.ordered)) f.push('over');
  return f;
}

// Who a delivery came from. A PO is a mixed shopping list, so the answer is the
// LINES' suppliers, not the header's — falling back to the header when a line
// carries none, which is what every other supplier read in this file does.
function deliverySuppliers(lines, poSupplier) {
  const names = new Set();
  for (const l of lines) {
    const n = (l.supplier_name || '').trim() || (poSupplier || '').trim();
    if (n) names.add(n);
  }
  return [...names];
}

// Lines already received where no receipt covers them: the deliveries that
// happened before this history existed. Counted, never invented.
function untrackedLines(poId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM po_line_items pli
     WHERE pli.po_id = ? AND pli.qty_received IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM po_receipt_lines l WHERE l.line_id = pli.id)`).get(poId).c;
}

function decorateDelivery(row) {
  const lines = receiptLines(row.id);
  const store = row.store_id ? inventory.getStore(row.store_id) : null;
  return {
    ...row,
    lines,
    // Units that left on THIS event — zero on every delivery, and the headline
    // number on a return.
    returned_units: lines.reduce((n, l) => n + (parseFloat(l.returned_qty) || 0), 0),
    flags: deliveryFlags(lines, row.kind),
    suppliers: deliverySuppliers(lines, row.supplier),
    store_name_en: store?.name_en || null,
    store_name_cn: store?.name_cn || null,
  };
}

// GET /api/retail-admin/receiving/deliveries — the Received list.
// Deliveries and returns; corrections stay inside the delivery they correct.
//
// A RETURN EARNS ITS OWN ROW ON DIFFERENT TERMS TO A DELIVERY, and the two
// tests below are not interchangeable. A delivery qualifies by bringing at
// least one line in for the first time (`new_lines`, the derivation the
// DELIVERY_SQL header explains). A return can never satisfy that — the goods it
// sends back were received by an earlier event, by definition — so it qualifies
// on being a return at all. Judged by the delivery test a return would be
// invisible in the one list that should show it; judged by neither, a PO
// received before the receipt tables existed would have its first return
// render as a delivery of goods that were leaving.
const isJournalRow = r => (r.kind === 'return' ? true : r.new_lines > 0);
router.get('/api/retail-admin/receiving/deliveries', requireRetailAdmin, (req, res) => {
  const rows = db.prepare(DELIVERY_SQL + ' ORDER BY r.received_at DESC, r.id DESC LIMIT 200')
    .all(currentTenantId())
    .filter(isJournalRow);
  const out = rows.map(decorateDelivery);

  // Search and filter here rather than in SQL: both read the DERIVED shape —
  // the supplier list is assembled from lines, and the flags from a comparison
  // against the ordered quantity. A WHERE clause could not see either without
  // rebuilding both, and then there would be two of each.
  const q = String(req.query.q || '').trim().toLowerCase();
  const flag = String(req.query.flag || 'all');
  const match = d => {
    if (flag === 'issues' && !d.flags.length) return false;
    if (flag !== 'all' && flag !== 'issues' && d.flags.indexOf(flag) === -1) return false;
    if (!q) return true;
    // WHAT ARRIVED IS THE QUESTION THIS SEARCH IS USUALLY ASKED. Somebody wants
    // to know when the mint came in and how much of it — not which supplier
    // they should have thought of first. Matching only the header fields left
    // that answerable one purchase order at a time, which is the same as not
    // answerable. The lines are already loaded by decorateDelivery, so this
    // costs nothing but the comparison.
    //
    // The matching lines travel back with the row, so the list can say WHICH
    // product it matched instead of making the reader open every result to
    // find out why it is there.
    d.matched_lines = d.lines.filter(l =>
      [l.name_en, l.name_cn, l.sku].filter(Boolean).join(' ').toLowerCase().indexOf(q) !== -1);
    if (d.matched_lines.length) return true;
    const hay = [d.po_number, d.actor_label, d.store_name_en, d.store_name_cn, ...d.suppliers]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  };
  res.json({ success: true, data: out.filter(match) });
});

// GET /api/retail-admin/receiving/deliveries/:id — one delivery, with every
// later revision of its lines nested under the line it corrects.
router.get('/api/retail-admin/receiving/deliveries/:id', requireRetailAdmin, (req, res) => {
  const row = db.prepare(DELIVERY_SQL + ' AND r.id = ?').all(currentTenantId(), req.params.id)[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const d = decorateDelivery(row);
  // Every later receipt row for these lines, on this PO. Ordered, so the
  // screen reads them as "recorded N, changed to M" straight down the list.
  // RECEIPTS ONLY. A later return touches these same lines, but it is not a
  // revision of what this delivery says arrived — it is its own event with its
  // own row in the list above, and nesting it here would show the same return
  // twice while reading as "recorded 15, changed to 15".
  const corr = db.prepare(`
    SELECT l.line_id, l.qty_received, l.damaged_qty, l.receipt_reason, l.note,
           r.id AS receipt_id, r.received_at, r.actor_label
      FROM po_receipt_lines l
      JOIN po_receipts r ON r.id = l.receipt_id
     WHERE r.po_id = ? AND r.id > ? AND COALESCE(r.kind, 'receipt') = 'receipt'
       AND l.line_id IN (${d.lines.map(() => '?').join(',') || 'NULL'})
     ORDER BY r.id`).all(row.po_id, row.id, ...d.lines.map(l => l.line_id));
  for (const l of d.lines) l.corrections = corr.filter(c => c.line_id === l.line_id);
  res.json({ success: true, data: d });
});

// GET /api/retail-admin/purchases/:id/receipts — the deliveries taken against
// one order, for the PO detail screen.
router.get('/api/retail-admin/purchases/:id/receipts', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const rows = db.prepare(DELIVERY_SQL + ' AND r.po_id = ? ORDER BY r.received_at, r.id')
    .all(currentTenantId(), po.id)
    .filter(isJournalRow)
    .map(decorateDelivery);
  res.json({ success: true, data: { deliveries: rows, untracked_lines: untrackedLines(po.id) } });
});

// ── Copying a kitchen order into Tacet ────────────────────────────────────
// The kitchen buying list (routes/purchases.js, scope='kitchen', PO-####) and
// this one (scope='retail', RPO-####) filter each other out, so an order bought
// through the kitchen app can never be opened, re-quantified or received here.
// These two routes are the bridge the buyer asked for: pick kitchen orders, get
// retail DRAFTS of them that Tacet can edit.
//
// A copy, deliberately, not a move: the kitchen order stays exactly where it is
// and keeps working for the kitchen. The cost of that choice is that the same
// real-world purchase now has two rows, so the copy is built to stay out of
// every ledger until someone deliberately places it, and the ledgers are built
// to believe exactly one of the two once they have:
//   • status is always 'Requested' (Draft). postRetailPOExpenses only posts on
//     Ordered/Delivered, and the invoice chase only reads INV_PO_STATUSES — so
//     a fresh copy adds nothing to Finance and nothing to the paperwork chase.
//   • THE MOMENT THE BUYER PLACES THE COPY, THE COPY TAKES OVER. Its cost posts
//     and its lines join the 发票 chase, and in the same breath the kitchen
//     original is SUPERSEDED: its expense rows are wiped and its lines drop out
//     of both chases. That is lib/po-supersede.js, and the reason it exists is
//     that this used to be left to the buyer — the same goods went into the
//     books twice and were chased for a 发票 twice, differing only by whatever
//     the buyer had corrected on the copy. Nothing about the kitchen row itself
//     changes, and putting the copy back to Draft hands it straight back.
//   • received counts, stock_applied_qty, lot/tracking, invoice_status and the
//     invoice_lines allocations are NOT copied. Those belong to the kitchen
//     order's own history; a draft has received nothing and is on no invoice.
//     A 发票 recorded against the original before the handover therefore stays
//     recorded against the original — the chase reports that figure on the copy
//     rather than re-pointing allocations at lines whose quantities have since
//     been edited (see lib/po-supersede.js, WHAT IT DOES NOT DO).
//   • copied_from_po_id records the source, which is also the duplicate guard,
//     and now also the supersede link.
// Kitchen lines carry ingredient_id (materials), never store_product_id, so the
// copies are material lines: receiving one is a price write-back, not a stock
// movement (see the module header). The target store still has to be named —
// every retail PO is store-scoped — it just isn't a shelf these lines land on.

// What is available to copy: kitchen POs, newest first, with the same line
// count / total the retail list computes, plus the copy (if any) already made.
router.get('/api/retail-admin/purchases/kitchen-source', requireRetailAdmin, (req, res) => {
  const { status, search } = req.query;
  let q = `
    SELECT po.id, po.po_number, po.date, po.delivery_date, po.status, po.supplier,
           po.warehouse, po.notes,
           (SELECT COUNT(*) FROM po_line_items i WHERE i.po_id = po.id)                      AS line_count,
           (SELECT SUM(COALESCE(i.total_cost,0)) FROM po_line_items i WHERE i.po_id = po.id) AS total_cost,
           (SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(i.supplier_name),'')) FROM po_line_items i WHERE i.po_id = po.id) AS line_suppliers,
           c.id        AS copy_id,
           c.po_number AS copy_po_number,
           c.status    AS copy_status
      FROM purchase_orders po
      LEFT JOIN purchase_orders c
             ON c.copied_from_po_id = po.id
            AND COALESCE(c.scope,'kitchen') = 'retail'
            AND COALESCE(c.tenant_id,1) = ?
     WHERE COALESCE(po.scope,'kitchen') = 'kitchen' AND COALESCE(po.tenant_id,1) = ?`;
  // Tenant-scoped on BOTH sides. Every kitchen PO carries tenant_id 1 (the
  // DEFAULT the column shipped with — the kitchen app is Roots' own), so this
  // shows Roots its kitchen history and shows a second tenant an empty picker,
  // rather than offering them another business's orders to copy.
  const params = [currentTenantId(), currentTenantId()];
  if (status) { q += ' AND po.status = ?'; params.push(status); }
  if (search) {
    q += ` AND (po.po_number LIKE ? OR po.supplier LIKE ? OR po.id IN (
      SELECT po_id FROM po_line_items WHERE name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ? OR supplier_name LIKE ?))`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }
  q += ' ORDER BY po.date DESC, po.id DESC';
  res.json({ success: true, data: db.prepare(q).all(...params) });
});

// Copy the named kitchen orders in as retail drafts. All-or-nothing per batch:
// one transaction, so a batch that trips the guard leaves nothing half-copied.
router.post('/api/retail-admin/purchases/copy-from-kitchen', requireRetailAdmin, express.json(), (req, res) => {
  const { po_ids, store_id } = req.body || {};
  const ids = [...new Set((Array.isArray(po_ids) ? po_ids : [])
    .map(n => parseInt(n, 10)).filter(n => n > 0))];
  if (!ids.length) return res.status(400).json({ success: false, error: 'po_ids_required' });
  const storeId = parseInt(store_id, 10);
  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(400).json({ success: false, error: 'store_required' });
  }
  const marks = ids.map(() => '?').join(',');
  const sources = db.prepare(
    `SELECT * FROM purchase_orders
      WHERE id IN (${marks}) AND COALESCE(scope,'kitchen') = 'kitchen'
        AND COALESCE(tenant_id,1) = ?`).all(...ids, currentTenantId());
  // An id that names no kitchen PO is a mistake worth reporting, not skipping:
  // the buyer ticked something, and silence would read as "copied".
  if (sources.length !== ids.length) {
    const found = new Set(sources.map(p => p.id));
    return res.status(404).json({ success: false, error: 'not_found',
                                  missing: ids.filter(id => !found.has(id)) });
  }
  const already = db.prepare(
    `SELECT copied_from_po_id AS src, po_number FROM purchase_orders
      WHERE copied_from_po_id IN (${marks})
        AND COALESCE(scope,'kitchen') = 'retail' AND COALESCE(tenant_id,1) = ?`
  ).all(...ids, currentTenantId());
  if (already.length) {
    const bySrc = new Map(sources.map(p => [p.id, p.po_number]));
    return res.status(409).json({ success: false, error: 'already_copied',
      copies: already.map(a => ({ po_id: a.src, po_number: bySrc.get(a.src) || null,
                                  copy_po_number: a.po_number })) });
  }
  const lineStmt = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order, id');
  try {
    const tx = db.transaction(() => {
      const made = [];
      // Newest kitchen order last, so the RPO numbers run in the same order the
      // kitchen numbers do rather than in reverse.
      for (const src of [...sources].sort((a, b) => a.id - b.id)) {
        const po_number = nextRetailPONumber();
        const poId = db.prepare(`
          INSERT INTO purchase_orders
            (po_number, date, delivery_date, status, supplier, notes, source, scope,
             store_id, created_by, tenant_id, copied_from_po_id)
          VALUES (?,?,?,'Requested',?,?,'kitchenCopy','retail',?,NULL,?,?)
        `).run(po_number, src.date, src.delivery_date || null, src.supplier || null,
               src.notes || null, storeId, currentTenantId(), src.id).lastInsertRowid;
        const items = lineStmt.all(src.id).map(l => ({
          // store_product_id is left off entirely: a kitchen line never has one,
          // and passing it would risk a line_conflict against ingredient_id.
          ingredient_id: l.ingredient_id || null,
          name_en: l.name_en, name_cn: l.name_cn, sku: l.sku,
          qty: l.qty, unit: l.unit, cost_per_unit: l.cost_per_unit,
          expense_category: l.expense_category, supplier_name: l.supplier_name,
          purchase_channel: l.purchase_channel, note: l.note,
        }));
        if (items.length) insertLineItems(poId, items, src.supplier || null);
        made.push({ id: poId, po_number, from_po_id: src.id, from_po_number: src.po_number,
                    line_count: items.length });
      }
      return made;
    });
    const made = tx();
    for (const m of made) {
      logActivity(req.user.id, req.user.username, 'create', 'purchase_order', m.id,
                  { po_number: m.po_number, scope: 'retail', copied_from_po_id: m.from_po_id,
                    copied_from_po_number: m.from_po_number }, req.ip);
    }
    res.json({ success: true, data: made });
  } catch (e) {
    console.error('[retail-purchasing copy-from-kitchen]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/api/retail-admin/purchases/:id', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const items = db.prepare('SELECT * FROM po_line_items WHERE po_id = ? ORDER BY sort_order, id').all(po.id);
  // Current shelf qty at the PO's store for context next to each line.
  if (po.store_id) {
    const ids = items.map(i => i.store_product_id).filter(Boolean);
    if (ids.length) {
      const rows = tdb().prepare(`
        SELECT product_id, physical_qty FROM retail_store_stock
         WHERE store_id = ? AND product_id IN (${ids.map(() => '?').join(',')})
      `).all(po.store_id, ...ids);
      const byId = new Map(rows.map(r => [r.product_id, r.physical_qty]));
      for (const i of items) i.current_stock = i.store_product_id ? (byId.get(i.store_product_id) ?? 0) : null;
      // Is this line's product actually LISTED on a sales channel at this store?
      // The receive screen promises a channel sync, and until now it promised it
      // for every PO regardless — including one whose products no channel
      // carries. "Listed" here means exactly what the sync means by it: a
      // sync_enabled row in that channel's product map for this store and
      // product (lib/meituan-bundles.js, lib/guanyi-sync.js, lib/eleme-sync.js
      // each open with that same lookup before they enqueue anything).
      //
      // Per table, in its own try: a tenant database that has never carried a
      // channel has no such table, and a missing table must read as "not
      // listed", never as an error that costs the operator the whole screen.
      const listed = new Set();
      for (const tbl of ['meituan_product_map', 'guanyi_product_map', 'eleme_product_map']) {
        try {
          const hits = tdb().prepare(`
            SELECT product_id FROM ${tbl}
             WHERE retail_store_id = ? AND sync_enabled = 1
               AND product_id IN (${ids.map(() => '?').join(',')})
          `).all(po.store_id, ...ids);
          for (const h of hits) listed.add(h.product_id);
        } catch { /* no such table on this tenant — nothing is listed there */ }
      }
      for (const i of items) i.channel_listed = i.store_product_id ? listed.has(i.store_product_id) : false;
    }
  }
  const expenses = db.prepare('SELECT id, date, amount, category, description FROM expense_entries WHERE po_id = ? ORDER BY id').all(po.id);
  const store = po.store_id ? inventory.getStore(po.store_id) : null;
  // ── Where this order may still be received into ──────────────────────────
  // The receive screen must never offer a destination the receive route will
  // then refuse with store_locked. So the answer travels WITH the order: which
  // shelf its stock is on, whether that is now fixed, and the list to choose
  // from while it is not. A screen that has to POST to discover it cannot
  // change the store has already shown the operator a choice that was a lie.
  const receivingStoreId = appliedReceiptStore(db, po);
  const locked = !!db.prepare(
    'SELECT 1 FROM po_line_items WHERE po_id = ? AND COALESCE(stock_applied_qty, 0) <> 0 LIMIT 1'
  ).get(po.id);
  const rStore = receivingStoreId ? inventory.getStore(receivingStoreId) : null;
  res.json({ success: true, data: {
    ...po, items, expenses,
    store_name_en: store?.name_en || null, store_name_cn: store?.name_cn || null,
    receiving_store_id: receivingStoreId,
    receiving_store_name_en: rStore?.name_en || null,
    receiving_store_name_cn: rStore?.name_cn || null,
    store_locked: locked,
    // Only worth sending while a choice is still open.
    stores: locked ? [] : inventory.listStores({ activeOnly: true })
      .map(s => ({ id: s.id, name_en: s.name_en, name_cn: s.name_cn })),
  } });
});

// Per-line cost history: for every line with a store_product_id, the latest
// prior retail PO line + lifetime stats. Drives "last paid ¥X on RPO-0007".
router.get('/api/retail-admin/purchases/:id/history', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const items = db.prepare('SELECT id, store_product_id FROM po_line_items WHERE po_id = ?').all(po.id);
  const tid = Number(currentTenantId()) || 1;
  const prevStmt = db.prepare(`
    SELECT pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost,
           po.id AS po_id, po.po_number, po.date, po.supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  const statsStmt = db.prepare(`
    SELECT COUNT(*) AS total_orders, AVG(pli.cost_per_unit) AS avg_price,
           MIN(pli.cost_per_unit) AS min_price, MAX(pli.cost_per_unit) AS max_price,
           SUM(pli.qty) AS total_qty
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND po.id != ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}`);
  const out = {};
  for (const it of items) {
    if (!it.store_product_id) continue;
    out[it.store_product_id] = {
      previous: prevStmt.get(it.store_product_id, po.id) || null,
      stats: statsStmt.get(it.store_product_id, po.id) || null,
    };
  }
  res.json({ success: true, data: out });
});

// Per-product supplier price list: every supplier we've bought THIS product
// from on a retail PO, with last price + who + average. Powers the order
// picker's "who sells this / what we paid last time". Derived from PO history
// only — a brand-new tenant with no orders gets an empty list, never someone
// else's suppliers. Preferred = who we buy it from most; cheapest = lowest last
// price.
router.get('/api/retail-admin/products/:spid/suppliers', requireRetailAdmin, (req, res) => {
  const spid = parseInt(req.params.spid, 10);
  if (!spid) return res.status(400).json({ success: false, error: 'bad_id' });
  const tid = Number(currentTenantId()) || 1;   // integer — safe to inline
  // Group by the resolved supplier (line supplier wins, else the PO's supplier).
  // Positional GROUP BY 1 so the alias never shadows a real column.
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') AS supplier,
           COUNT(*)               AS order_count,
           SUM(pli.qty)           AS total_qty,
           AVG(pli.cost_per_unit) AS avg_cost,
           MIN(pli.cost_per_unit) AS min_cost,
           MAX(pli.cost_per_unit) AS max_cost
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     GROUP BY 1
     ORDER BY order_count DESC, MAX(po.date) DESC`).all(spid);
  const lastStmt = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date, po.po_number
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
       AND COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') = ?
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`);
  const suppliers = rows.map(r => {
    const last = lastStmt.get(spid, r.supplier) || {};
    return {
      supplier: r.supplier || null,
      order_count: r.order_count, total_qty: r.total_qty,
      avg_cost: r.avg_cost, min_cost: r.min_cost, max_cost: r.max_cost,
      last_cost: last.cost != null ? last.cost : r.avg_cost,
      last_date: last.date || null, last_po_number: last.po_number || null,
    };
  });
  const overall = db.prepare(`
    SELECT pli.cost_per_unit AS cost, po.date, po.po_number,
           COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier) AS supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     ORDER BY po.date DESC, pli.id DESC LIMIT 1`).get(spid) || null;
  // Cost-over-time series + overall stats + product identity, for the
  // standalone Price-history screen (sparkline + metric tiles).
  const series = db.prepare(`
    SELECT po.date AS date, pli.cost_per_unit AS cost
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND COALESCE(pli.cost_per_unit,0) > 0
     ORDER BY po.date, pli.id`).all(spid);
  const stats = db.prepare(`
    SELECT COUNT(*) AS order_count, SUM(pli.qty) AS total_qty,
           AVG(pli.cost_per_unit) AS avg_cost, MIN(pli.cost_per_unit) AS min_cost, MAX(pli.cost_per_unit) AS max_cost,
           MIN(po.date) AS first_date, MAX(po.date) AS last_date
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid} AND COALESCE(pli.cost_per_unit,0) > 0`).get(spid) || {};
  const prod = db.prepare(`
    SELECT MAX(pli.name_en) AS name_en, MAX(pli.name_cn) AS name_cn, MAX(pli.sku) AS sku
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen')='retail' AND COALESCE(po.tenant_id,1) = ${tid}`).get(spid) || {};
  res.json({ success: true, data: {
    store_product_id: spid, product: prod, suppliers, series, stats,
    last: overall ? { cost: overall.cost, date: overall.date, supplier: overall.supplier, po_number: overall.po_number } : null,
  } });
});

// ═══ SUPPLIER INVOICES 发票 ══════════════════════════════════════════════════
// What Roots actually does here is CHASE MISSING 发票 — not run accounts
// payable. So this screen is organised the way the kitchen one is: grouped by
// supplier, expandable to the lines, with "awaiting" as the headline figure.
// NO PAYABLES. The due-date / paid / aging fields the earlier Bills port built
// are gone from what this file serves. Roots pays the supplier first and the
// 发票 turns up afterwards, so every invoice that can be recorded here has
// already been paid: `paid_at` could only ever be set to assert something
// always true, and the aging it drove reported money that had already left the
// account as debt still owed. The COLUMNS survive untouched — invoices.due_date
// and invoices.paid_at keep every value they hold, and an edit round-trips the
// due date it loaded — so a tenant on real terms loses no data and this is a
// UI removal, not a migration.
//
// TENANT-SCOPED ONLY. Every read and write is filtered by tenant_id and by
// nothing else. `scope` is stamped on create ('retail') and is never a filter
// on read: everything Roots is chasing sits on kitchen-scope POs (66 of 67),
// so a scope-filtered screen would show an empty page. The kitchen's own
// routes/finance.js now filters scope='kitchen', and that is what keeps an
// invoice created here out of reach of that screen's delete.
//
// THE LINK IS AT PO LINE LEVEL. invoice_lines(invoice_id, line_id) with a
// per-link allocated_amount, many-to-many in both directions. A kitchen PO is
// a mixed shopping list whose lines each carry their own supplier, so a
// PO-level link would attribute one supplier's invoice to another's goods.
//
// THE FOUR STATES ARE COMPUTED, NEVER STORED — see lineStatus() below.
// po_line_items.invoice_status is a second, STORED mechanism, still never read
// here: awaiting/received is the buyer's own note on the receive row and says
// nothing about what has actually been invoiced. Its 'no_invoice' value is the
// one exception, and it is not read either — the receive route writes the
// no_invoice_expected mark alongside it, so the two can no longer contradict
// each other. invoice_pos is dead with 0 rows and is left alone.
const INV_PO_STATUSES = "('Ordered','Delivered','Confirmed')";
const gzToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const INV_UNSPECIFIED = '未指定 Unspecified';

// Supplier resolution chain, most-specific first: the line's own supplier, the
// PO header's, the linked item's master supplier, then a literal fallback.
// Character-for-character the chain routes/finance.js uses, so the two screens
// can never group the same line under different suppliers.
const SUPPLIER_EXPR = `COALESCE(
    NULLIF(TRIM(pli.supplier_name),''),
    NULLIF(TRIM(po.supplier),''),
    NULLIF(TRIM(ing.supplier),''),
    '${INV_UNSPECIFIED}'
  )`;

// The same read for a whole page of lines, keyed by line_id. Lines with no
// allocation are absent from the map rather than present as 0, so the caller
// keeps the COALESCE it already had.
const allocatedByLine = (lineIds) => {
  const out = new Map();
  for (let i = 0; i < lineIds.length; i += 400) {
    const chunk = lineIds.slice(i, i + 400);
    const rows = db.prepare(`SELECT line_id, allocated_amount FROM invoice_lines
                              WHERE line_id IN (${chunk.map(() => '?').join(',')})
                              ORDER BY id`).all(...chunk);
    for (const a of rows) out.set(a.line_id, (out.get(a.line_id) || 0) + (a.allocated_amount || 0));
  }
  return out;
};

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// The four states, computed per line at read time. Same order of tests as
// routes/finance.js: the no-invoice mark wins over everything, because a line
// nobody will ever get a 发票 for is not "awaiting" one no matter what has
// been allocated against it.
function lineStatus(row) {
  if (row.line_no_invoice || row.po_no_invoice) return 'no_invoice_expected';
  if (row.covered >= row.amount && row.amount > 0) return 'fully_invoiced';
  if (row.covered > 0) return 'partially_invoiced';
  return 'awaiting';
}

// Reach — the supplier's own contact channel, keyed by name because that is
// the only thing an invoice or a PO line carries. Not invoice data; general
// supplier data, surfaced here so someone chasing a 发票 can act on the row
// without leaving the screen. The QR itself is fetched on demand (it is a
// base64 blob) — this only reports whether one exists.
// Supplier names are stored as one free-text string, so a lot of the live ones
// read "Dry Fruit 果干" — both languages glued into a single label. The suppliers
// master keeps them apart (name / name_cn), so hand the 中文 name alongside the
// stored one and let the screen show whichever language it is currently in.
function supplierCnByName(tid) {
  const m = new Map();
  for (const r of db.prepare(
    'SELECT name, name_cn FROM suppliers WHERE COALESCE(tenant_id,1) = ?').all(tid)) {
    if (r.name_cn && r.name_cn.trim()) m.set(r.name, r.name_cn.trim());
  }
  return m;
}

function reachByName(tid) {
  const rows = db.prepare(
    'SELECT id, name, channel_type, channel_link, channel_qr_data IS NOT NULL AS has_qr FROM suppliers WHERE COALESCE(tenant_id,1) = ?'
  ).all(tid);
  const m = new Map();
  for (const r of rows) {
    m.set(r.name, { supplier_id: r.id, type: r.channel_type || null, link: r.channel_link || null, has_qr: !!r.has_qr });
  }
  return m;
}

// What one supplier still owes us ON PAPER — the supplier page's tile, and the
// figure that replaced a payables balance there. It is computed HERE, with the
// invoice screen's rules and no others, because the supplier page and the
// Invoices tab must never put two different numbers on the same supplier:
// tenant-scoped and never scope-scoped (filter to scope='retail' and every
// supplier reports ¥0, since the paperwork all sits on kitchen-scope POs),
// placed POs only, superseded copies stood down, billable qty net of returns.
// 'awaiting' is the same status the tab's group total counts, so the two agree
// line for line.
function awaitingForSupplier(tid, name) {
  const rows = db.prepare(`
    SELECT pli.id AS line_id, pli.qty, pli.qty_received, pli.returned_qty, pli.cost_per_unit,
           pli.no_invoice_expected AS line_no_invoice,
           po.no_invoice_expected  AS po_no_invoice
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
      LEFT JOIN ingredients ing ON ing.id = pli.ingredient_id
     WHERE COALESCE(po.tenant_id,1) = ${tid} AND po.status IN ${INV_PO_STATUSES}
       AND ${notSupersededByCopySql('po')} AND ${SUPPLIER_EXPR} = ?`).all(name);
  if (!rows.length) return { awaiting: 0, awaiting_lines: 0 };
  const allocated = allocatedByLine(rows.map(r => r.line_id));
  let awaiting = 0, lines = 0;
  for (const r of rows) {
    r.amount = round2(billableQty(r) * (r.cost_per_unit || 0));
    r.covered = round2(allocated.get(r.line_id) || 0);
    if (lineStatus(r) === 'awaiting') { awaiting += r.amount; lines++; }
  }
  return { awaiting: round2(awaiting), awaiting_lines: lines };
}

// ── 发票 MONEY THE FOUR STATES CANNOT SEE ───────────────────────────────────
// A recorded 发票 is only counted by this screen through the PO LINE it was
// allocated to: lineStatus() reads `covered`, and `covered` comes from the
// lines the chase below actually selects. So an allocation whose line falls
// out of that selection stops being counted anywhere on the screen — the four
// figures go on adding up to the total without it, and the headline reads
// "¥0.00 fully invoiced" over a ledger holding real, fully-allocated invoices.
//
// THAT IS THE BUG A BUYER REPORTED, and the ordinary way to reach it is
// "Copy from kitchen": recording a 发票 against PO-0059's lines and then
// placing the RPO copy of that order stands the original down
// (lib/po-supersede.js), and the allocation goes down with it. The copy's own
// lines then read "Awaiting" — the chase asking for a 发票 that is already
// filed, which is the one thing lib/po-supersede.js says it must never do.
//
// SURFACED, NEVER CORRECTED — the stance this screen already takes on an
// over-allocated invoice and on a credit due. Re-pointing an allocation at the
// copy's lines is the buyer's call to make on a screen, not a silent remap
// here (lib/po-supersede.js spells out why), so what this does is name the
// money, name the orders it is sitting on, and say why it is not upstairs.
//
// BOOK-LEVEL, NOT FILTERED: it answers "where did the invoices I recorded
// go?", and that question does not change because a month is selected. (It
// read "like agingFor() beside it" until the payables apparatus came out —
// see NO PAYABLES above; this is now the only book-level read on the screen.)
//
// Three reasons cover every way a line can leave the chase, and they are the
// chase's own WHERE clause read backwards:
//   superseded    a placed retail copy stood this order down
//   not_placed    the order is a draft or was cancelled after the 发票 landed
//   other_tenant  the allocation sits on another tenant's order
function recordedOffChase(tid) {
  const rows = db.prepare(`
    SELECT il.allocated_amount AS amount, po.po_number, po.status,
           COALESCE(po.tenant_id,1) AS po_tenant,
           ${supersededByCopySql('po')} AS superseded,
           (SELECT c.po_number FROM purchase_orders c
             WHERE c.copied_from_po_id = po.id
               AND COALESCE(c.scope,'kitchen') = 'retail'
               AND COALESCE(c.tenant_id,1)     = COALESCE(po.tenant_id,1)
               AND c.status IN ${PLACED_COPY_STATUSES}
             ORDER BY c.id LIMIT 1) AS copy_po_number
      FROM invoice_lines il
      JOIN invoices inv       ON inv.id = il.invoice_id
      JOIN po_line_items pli  ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id  = pli.po_id
     WHERE COALESCE(inv.tenant_id,1) = ?
       AND (${supersededByCopySql('po')}
            OR po.status NOT IN ${INV_PO_STATUSES}
            OR COALESCE(po.tenant_id,1) <> ?)`).all(tid, tid);

  let amount = 0;
  // Keyed by order, because the buyer acts on an ORDER — one row per PO with
  // what is sitting on it, not one row per allocation.
  const byPo = new Map();
  for (const r of rows) {
    amount += r.amount || 0;
    const reason = r.superseded ? 'superseded'
                 : (r.po_tenant !== tid) ? 'other_tenant'
                 : 'not_placed';
    if (!byPo.has(r.po_number)) {
      byPo.set(r.po_number, { po_number: r.po_number, reason, amount: 0,
                              status: r.status, copy_po_number: r.copy_po_number || null });
    }
    byPo.get(r.po_number).amount += r.amount || 0;
  }
  const orders = [...byPo.values()]
    .map(o => ({ ...o, amount: round2(o.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const by_reason = {};
  for (const o of orders) by_reason[o.reason] = round2((by_reason[o.reason] || 0) + o.amount);
  return { amount: round2(amount), order_count: orders.length, by_reason, orders };
}

// GET .../invoices/outstanding?month=&q=&supplier=
// Every line on a placed PO for this tenant, with its computed state, grouped
// by supplier. This is the action-item view: "who do we still need a 发票 from?"
//
// no_invoice_expected lines are INCLUDED, as a state. The earlier Bills port
// filtered them out of the query entirely, which is why it could never show a
// "No invoice" figure — that is ¥6,797 of real classification on live data.
router.get('/api/retail-admin/purchasing/invoices/outstanding', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const month = (req.query.month || '').trim().slice(0, 7);
  const supplier = (req.query.supplier || '').trim();
  const search = (req.query.q || '').trim();
  const params = [];
  // …and not standing behind a copy of itself. A kitchen order somebody pulled
  // into Tacet and then placed here is the SAME purchase as the RPO-#### below
  // it, and listing both asked for the same 发票 twice, line for line. The copy
  // is the version the buyer corrected, so the original stands down — the rule,
  // and every reason for it, is lib/po-supersede.js.
  let where = `COALESCE(po.tenant_id,1) = ${tid} AND po.status IN ${INV_PO_STATUSES}
               AND ${notSupersededByCopySql('po')}`;
  if (month) { where += ' AND substr(po.date,1,7) = ?'; params.push(month); }
  if (supplier) {
    if (supplier === INV_UNSPECIFIED) {
      where += ` AND NULLIF(TRIM(pli.supplier_name),'') IS NULL
                 AND NULLIF(TRIM(po.supplier),'')       IS NULL
                 AND NULLIF(TRIM(ing.supplier),'')      IS NULL`;
    } else {
      where += ` AND ${SUPPLIER_EXPR} = ?`; params.push(supplier);
    }
  }
  if (search) {
    const t = '%' + search + '%';
    where += ` AND (
        LOWER(${SUPPLIER_EXPR})            LIKE LOWER(?)
     OR LOWER(COALESCE(pli.name_en,''))    LIKE LOWER(?)
     OR LOWER(COALESCE(pli.name_cn,''))    LIKE LOWER(?)
     OR LOWER(COALESCE(pli.sku,''))        LIKE LOWER(?)
     OR LOWER(COALESCE(po.po_number,''))   LIKE LOWER(?))`;
    params.push(t, t, t, t, t);
  }
  const rows = db.prepare(`
    SELECT pli.id AS line_id, pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit, pli.cost_per_unit,
           pli.qty_received, pli.returned_qty, pli.return_reason, pli.returned_at,
           pli.no_invoice_expected AS line_no_invoice,
           po.id AS po_id, po.po_number, po.date, po.status,
           po.no_invoice_expected AS po_no_invoice,
           -- Which kitchen order this one replaced. Every copy in this result is
           -- placed (the status filter says so), so a copy here has by
           -- definition stood its source down — the number is what lets the
           -- screen say where PO-#### went instead of just losing it.
           po.copied_from_po_id,
           (SELECT k.po_number FROM purchase_orders k WHERE k.id = po.copied_from_po_id) AS supersedes_po_number,
           ${SUPPLIER_EXPR} AS supplier
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
      LEFT JOIN ingredients ing ON ing.id = pli.ingredient_id
     WHERE ${where}
     ORDER BY po.date DESC, pli.sort_order, pli.id`).all(...params);

  const allocated = allocatedByLine(rows.map(r => r.line_id));
  // 发票 already recorded against the order this copy replaced. Normally 0 — the
  // copy is made and placed long before anyone has an invoice to record — but
  // when it isn't, that money must not vanish with the row it was allocated to.
  // It stays where it is in the ledger and is REPORTED here, on the copy, so
  // the chase never asks for a 发票 somebody has already filed. See
  // lib/po-supersede.js on why it is reported rather than re-attributed.
  const supersededInvoiced = new Map();
  for (const srcId of new Set(rows.map(r => r.copied_from_po_id).filter(Boolean))) {
    supersededInvoiced.set(srcId, invoicedOnSuperseded(db, srcId));
  }
  const reach = reachByName(tid);
  const supCn = supplierCnByName(tid);
  const bySup = new Map();
  const totals = { total: 0, fully_invoiced: 0, partially_invoiced: 0, awaiting: 0, no_invoice_expected: 0,
                   credit_due: 0, line_count: rows.length };

  for (const r of rows) {
    // WHAT WE OWE, WHICH IS NOT WHAT WE ORDERED. This used to be qty ×
    // cost_per_unit — the ordered quantity — while Finance had always expensed
    // COALESCE(qty_received, qty). One purchase, two figures: a delivery that
    // came up five short was expensed at what turned up and chased at what was
    // asked for, and nothing on either screen said why they differed.
    //
    // billableQty (lib/po-returns.js) is now the single answer for both, and it
    // is the reason a return reaches the paperwork at all: send 15 kg back and
    // the supplier is asked for a 发票 covering what we kept, not what was
    // delivered.
    r.billable_qty = billableQty(r);
    r.amount = round2(r.billable_qty * (r.cost_per_unit || 0));
    r.covered = round2(allocated.get(r.line_id) || 0);
    r.outstanding = round2(Math.max(0, r.amount - r.covered));
    // A 发票 already recorded for MORE than the line is now worth — almost
    // always a return against goods invoiced before they went back. SURFACED,
    // NEVER CORRECTED, which is the stance this screen already takes on an
    // invoice allocated past its own header (`unallocated`, below): the money
    // is real, it is in the ledger, and what closes the gap is a credit note
    // from the supplier, not this route quietly writing the allocation down.
    r.credit_due = round2(Math.max(0, r.covered - r.amount));
    r.status = lineStatus(r);
    r.line_no_invoice = !!r.line_no_invoice;
    r.po_no_invoice = !!r.po_no_invoice;
    r.supersedes_invoiced = r.copied_from_po_id ? (supersededInvoiced.get(r.copied_from_po_id) || 0) : 0;
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, {
      supplier: r.supplier, total: 0, fully_invoiced: 0, partially_invoiced: 0,
      awaiting: 0, no_invoice_expected: 0, credit_due: 0, lines: [],
    });
    const g = bySup.get(r.supplier);
    g.total += r.amount; g[r.status] += r.amount; g.credit_due += r.credit_due; g.lines.push(r);
    totals.total += r.amount; totals[r.status] += r.amount; totals.credit_due += r.credit_due;
  }

  // Awaiting first, because awaiting is the job. Partial counts as unfinished
  // and sorts with it; a supplier who is fully invoiced has nothing to chase.
  const groups = [...bySup.values()].map(g => ({
    supplier: g.supplier,
    supplier_cn: supCn.get(g.supplier) || null,
    total: round2(g.total),
    fully_invoiced: round2(g.fully_invoiced),
    partially_invoiced: round2(g.partially_invoiced),
    awaiting: round2(g.awaiting),
    no_invoice_expected: round2(g.no_invoice_expected),
    credit_due: round2(g.credit_due),
    line_count: g.lines.length,
    po_numbers: [...new Set(g.lines.map(l => l.po_number))],
    reach: reach.get(g.supplier) || null,
    lines: g.lines,
  })).sort((a, b) => (b.awaiting + b.partially_invoiced) - (a.awaiting + a.partially_invoiced) || b.total - a.total);

  for (const k of Object.keys(totals)) if (k !== 'line_count') totals[k] = round2(totals[k]);
  // Recorded 发票 money none of the four figures above can account for. Sits
  // beside them rather than inside them: it belongs to no line this read
  // selected, so there is no state to put it in and no honest way to fold it
  // into one. recordedOffChase() says why it is out there.
  const recorded_elsewhere = recordedOffChase(tid);
  res.json({ success: true, data: { month: month || null, groups, totals, recorded_elsewhere } });
});

// The recorded-invoice ledger for this tenant.
router.get('/api/retail-admin/purchasing/invoices', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const month = (req.query.month || '').trim().slice(0, 7);
  const search = (req.query.q || '').trim();
  const params = [tid];
  let where = 'COALESCE(tenant_id,1) = ?';
  if (month)  { where += ' AND substr(date,1,7) = ?'; params.push(month); }
  if (search) {
    where += " AND (LOWER(supplier) LIKE LOWER(?) OR LOWER(COALESCE(invoice_number,'')) LIKE LOWER(?))";
    const t = '%' + search + '%'; params.push(t, t);
  }
  const invs = db.prepare(`SELECT * FROM invoices WHERE ${where} ORDER BY date DESC, id DESC`).all(...params);
  const linkStmt = db.prepare(`
    SELECT il.id AS link_id, il.allocated_amount, pli.id AS line_id,
           pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit, pli.cost_per_unit,
           po.id AS po_id, po.po_number, po.date AS po_date, po.status
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE il.invoice_id = ?
     ORDER BY po.date DESC, pli.id`);
  const supCn = supplierCnByName(tid);
  const data = invs.map(inv => {
    const lines = linkStmt.all(inv.id);
    const seen = new Map();
    for (const l of lines) if (!seen.has(l.po_number)) seen.set(l.po_number, { po_id: l.po_id, po_number: l.po_number, po_date: l.po_date, status: l.status });
    const allocated = round2(lines.reduce((s, l) => s + (l.allocated_amount || 0), 0));
    return {
      ...inv, lines, pos: [...seen.values()], allocated,
      supplier_cn: supCn.get(inv.supplier) || null,
      // Surfaced, never corrected. Live invoice 25 is allocated exactly half
      // its header amount; the screen says so rather than quietly reconciling.
      unallocated: round2((inv.amount || 0) - allocated),
    };
  });
  res.json({ success: true, data });
});

router.get('/api/retail-admin/purchasing/invoices/:id', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, tid);
  if (!inv) return res.status(404).json({ success: false, error: 'not_found' });
  const lines = db.prepare(`
    SELECT il.id AS link_id, il.allocated_amount, pli.id AS line_id,
           pli.name_en, pli.name_cn, pli.sku, pli.qty, pli.unit, pli.cost_per_unit,
           po.id AS po_id, po.po_number, po.date AS po_date, po.status
      FROM invoice_lines il
      JOIN po_line_items pli ON pli.id = il.line_id
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE il.invoice_id = ? ORDER BY po.date DESC, pli.id`).all(inv.id);
  const allocated = round2(lines.reduce((s, l) => s + (l.allocated_amount || 0), 0));
  res.json({ success: true, data: { ...inv, lines, allocated, unallocated: round2((inv.amount || 0) - allocated) } });
});

// What this same request has already written for this invoice/line pair.
const allocatedForThisRequest = (invoiceId, lineId) => db
  .prepare('SELECT allocated_amount FROM invoice_lines WHERE invoice_id = ? AND line_id = ?')
  .all(invoiceId, lineId)
  .reduce((s, r) => s + (r.allocated_amount || 0), 0);

// Shared allocation writer for create and update.
//
// `skipInvoiceId` is what makes an EDIT possible: the remaining headroom on a
// line has to ignore this invoice's own previous allocation, or re-saving an
// unchanged invoice would refuse itself as over-allocated. Create passes null.
function writeLinks(invoiceId, links, skipInvoiceId) {
  const insertLink = db.prepare('INSERT OR IGNORE INTO invoice_lines (invoice_id, line_id, allocated_amount) VALUES (?,?,?)');
  const lineInfo = db.prepare('SELECT id, qty, cost_per_unit FROM po_line_items WHERE id = ?');
  const priorFor = (lineId) => db
    .prepare('SELECT allocated_amount FROM invoice_lines WHERE line_id = ? AND invoice_id != ? ORDER BY id')
    .all(lineId, skipInvoiceId || -1)
    .reduce((s, r) => s + (r.allocated_amount || 0), 0);
  for (const l of (Array.isArray(links) ? links : [])) {
    const lineId = parseInt(l.line_id, 10);
    const alloc = parseFloat(l.allocated_amount) || 0;
    if (!(lineId > 0) || !(alloc > 0)) continue;
    const info = lineInfo.get(lineId);
    if (!info) throw new Error(`line ${lineId} not found`);
    const lineTotal = (info.qty || 0) * (info.cost_per_unit || 0);
    // Read inside the loop so an earlier link to this same line in this same
    // request is already counted.
    const remaining = Math.max(0, lineTotal - priorFor(lineId) - allocatedForThisRequest(invoiceId, lineId));
    if (alloc > remaining + 0.01) throw new Error(`line ${lineId} over-allocated`);
    insertLink.run(invoiceId, lineId, alloc);
  }
}

router.post('/api/retail-admin/purchasing/invoices', requireRetailAdmin, express.json(), (req, res) => {
  const { supplier, invoice_number, amount, date, due_date, store_id, notes, links } = req.body || {};
  if (!supplier || !String(supplier).trim()) return res.status(400).json({ success: false, error: 'supplier_required' });
  if (!(parseFloat(amount) > 0)) return res.status(400).json({ success: false, error: 'amount_required' });
  if (!date) return res.status(400).json({ success: false, error: 'date_required' });
  const tid = Number(currentTenantId()) || 1;
  try {
    let id;
    db.transaction(() => {
      // scope is stamped here and never read back as a filter. Its one job is
      // to keep this invoice out of the kitchen screen's reach.
      const r = db.prepare(`INSERT INTO invoices
        (supplier, invoice_number, amount, date, notes, created_by, scope, store_id, due_date, tenant_id)
        VALUES (?,?,?,?,?,?,'retail',?,?,?)`).run(
        String(supplier).trim(), invoice_number ? String(invoice_number).trim() : null,
        parseFloat(amount), date, notes || null, (req.user && req.user.id) || null,
        store_id ? parseInt(store_id, 10) : null, due_date || null, tid);
      id = r.lastInsertRowid;
      writeLinks(id, links, null);
    })();
    logActivity(req.user.id, req.user.username, 'create', 'supplier_invoice', id, { supplier, amount }, req.ip);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[supplier invoice create]', e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// Edit an invoice and re-diff its allocations. The Bills port had no edit path
// at all — a wrong amount or a mis-picked line meant delete and re-enter.
router.put('/api/retail-admin/purchasing/invoices/:id', requireRetailAdmin, express.json(), (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, tid);
  if (!inv) return res.status(404).json({ success: false, error: 'not_found' });
  const { supplier, invoice_number, amount, date, due_date, store_id, notes, links } = req.body || {};
  if (!supplier || !String(supplier).trim()) return res.status(400).json({ success: false, error: 'supplier_required' });
  if (!(parseFloat(amount) > 0)) return res.status(400).json({ success: false, error: 'amount_required' });
  if (!date) return res.status(400).json({ success: false, error: 'date_required' });
  try {
    db.transaction(() => {
      db.prepare(`UPDATE invoices SET supplier=?, invoice_number=?, amount=?, date=?, due_date=?, store_id=?, notes=?,
                  updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        String(supplier).trim(), invoice_number ? String(invoice_number).trim() : null,
        parseFloat(amount), date, due_date || null,
        store_id ? parseInt(store_id, 10) : inv.store_id, notes || null, inv.id);
      // Replace-then-rewrite, with the headroom check ignoring this invoice's
      // own rows (skipInvoiceId), so an unchanged re-save is always accepted.
      if (links !== undefined) {
        db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(inv.id);
        writeLinks(inv.id, links, inv.id);
      }
    })();
    logActivity(req.user.id, req.user.username, 'update', 'supplier_invoice', inv.id, { supplier, amount }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[supplier invoice update]', e);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.delete('/api/retail-admin/purchasing/invoices/:id', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const r = db.prepare('DELETE FROM invoices WHERE id = ? AND COALESCE(tenant_id,1) = ?').run(req.params.id, tid);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'supplier_invoice', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ── "No invoice expected" 不开发票 ───────────────────────────────────────────
// The mark that says a purchase will never have a 发票 — cash, a market stall,
// a supplier who simply does not issue them. Tacet had no way to set this at
// all; it classifies ¥6,797 of live purchasing today. Two levels, either of
// which suppresses a line, because a buying order can be entirely cash OR
// carry one cash line among invoiced ones. A toggle, never destructive.
router.put('/api/retail-admin/purchasing/po/:id/no-invoice', requireRetailAdmin, express.json(), (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const po = db.prepare('SELECT id FROM purchase_orders WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, tid);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const flag = !!(req.body && req.body.no_invoice_expected);
  db.prepare('UPDATE purchase_orders SET no_invoice_expected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(flag ? 1 : 0, po.id);
  logActivity(req.user.id, req.user.username, 'no_invoice_toggle', 'purchase_order', po.id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true, no_invoice_expected: flag });
});

router.put('/api/retail-admin/purchasing/po/:id/line/:lineId/no-invoice', requireRetailAdmin, express.json(), (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const line = db.prepare(`SELECT pli.id FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
                            WHERE pli.id = ? AND pli.po_id = ? AND COALESCE(po.tenant_id,1) = ?`)
    .get(req.params.lineId, req.params.id, tid);
  if (!line) return res.status(404).json({ success: false, error: 'not_found' });
  const flag = !!(req.body && req.body.no_invoice_expected);
  db.prepare('UPDATE po_line_items SET no_invoice_expected = ? WHERE id = ?').run(flag ? 1 : 0, line.id);
  logActivity(req.user.id, req.user.username, 'line_no_invoice_toggle', 'po_line_item', line.id, { no_invoice_expected: flag }, req.ip);
  res.json({ success: true, no_invoice_expected: flag });
});

// ── Attributing lines to a supplier 指定供应商 ───────────────────────────────
// The Invoices screen groups by the supplier chain (line → PO header →
// ingredient master → "未指定 Unspecified"), and everything that falls all the
// way through lands in the Unspecified group. That group could be described
// but not fixed: the screen said "set a supplier on these lines first" and
// offered nowhere to do it. The order wizard only reopens DRAFTS, and the
// lines sitting there are on placed POs — most of them kitchen-scope, which
// this admin never opens at all. So the instruction was unfollowable.
//
// THE WRITE IS AT LINE LEVEL, deliberately. Stamping po.supplier instead would
// re-attribute every other blank line on the same order too, because the
// header sits AHEAD of the ingredient master in the chain — a line grouped
// today under its item's master supplier would silently move. The line's own
// supplier_name is the most specific link in that chain, so it moves exactly
// the lines that were picked and nothing else.
//
// The name must already be one this tenant uses — a supplier on the master, or
// a name already carried by one of its POs. Grouping keys on the string, so a
// typo here would not fail: it would quietly open a second, near-identical
// supplier group.
router.put('/api/retail-admin/purchasing/lines/supplier', requireRetailAdmin, express.json(), (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const supplier = String((req.body && req.body.supplier) || '').trim().slice(0, 120);
  if (!supplier) return res.status(400).json({ success: false, error: 'supplier_required' });
  const ids = [...new Set((Array.isArray(req.body && req.body.line_ids) ? req.body.line_ids : [])
    .map(n => parseInt(n, 10)).filter(n => n > 0))];
  if (!ids.length) return res.status(400).json({ success: false, error: 'lines_required' });
  if (ids.length > 400) return res.status(400).json({ success: false, error: 'too_many_lines' });

  const known = db.prepare(
    `SELECT 1 FROM suppliers WHERE name = ? AND COALESCE(tenant_id,1) = ?
      UNION ALL
     SELECT 1 FROM purchase_orders WHERE TRIM(supplier) = ? AND COALESCE(tenant_id,1) = ?
      UNION ALL
     SELECT 1 FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
      WHERE TRIM(pli.supplier_name) = ? AND COALESCE(po.tenant_id,1) = ?
     LIMIT 1`).get(supplier, tid, supplier, tid, supplier, tid);
  if (!known) return res.status(400).json({ success: false, error: 'unknown_supplier' });

  const upd = db.prepare(`UPDATE po_line_items SET supplier_name = ?
                           WHERE id = ? AND po_id IN (SELECT id FROM purchase_orders
                                                       WHERE COALESCE(tenant_id,1) = ?)`);
  const updated = db.transaction(() => {
    let n = 0;
    for (const id of ids) n += upd.run(supplier, id, tid).changes;
    return n;
  })();
  if (!updated) return res.status(404).json({ success: false, error: 'not_found' });
  // One row for the whole assignment; the id is only meaningful when a single
  // line moved, so a bulk one carries its ids in the details instead.
  logActivity(req.user.id, req.user.username, 'set_line_supplier', 'po_line_item',
              ids.length === 1 ? ids[0] : null, { supplier, line_ids: ids, updated }, req.ip);
  res.json({ success: true, updated });
});

// The receive row's invoice picker, saved on its own. It used to ride along on
// the bulk receive route, which meant the only way to record "no 发票 for this
// line" was to press Confirm delivery — booking stock and flipping the order
// to received for goods that may not have arrived. Whether a supplier will
// issue paperwork is not a fact about delivery, so it saves by itself, with no
// stock or expense side effects. Writes the no_invoice_expected mark too, for
// the same reason the bulk route does: only the mark is ever read.
router.put('/api/retail-admin/purchasing/po/:id/line/:lineId/invoice-status', requireRetailAdmin, express.json(), (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const line = db.prepare(`SELECT pli.id FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
                            WHERE pli.id = ? AND pli.po_id = ? AND COALESCE(po.tenant_id,1) = ?`)
    .get(req.params.lineId, req.params.id, tid);
  if (!line) return res.status(404).json({ success: false, error: 'not_found' });
  const status = req.body && req.body.invoice_status;
  if (!VALID_INVOICE.has(status)) return res.status(400).json({ success: false, error: 'invalid_invoice_status' });
  const mark = status === 'no_invoice' ? 1 : 0;
  db.prepare('UPDATE po_line_items SET invoice_status = ?, no_invoice_expected = ? WHERE id = ?').run(status, mark, line.id);
  logActivity(req.user.id, req.user.username, 'line_invoice_status', 'po_line_item', line.id,
              { invoice_status: status, no_invoice_expected: !!mark }, req.ip);
  res.json({ success: true, invoice_status: status, no_invoice_expected: !!mark });
});

// The Reach chip's QR, fetched only when someone clicks it — it is a base64
// blob and has no business riding along in every supplier list read.
router.get('/api/retail-admin/suppliers/:id/channel-qr', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  const s = db.prepare('SELECT name, channel_qr_data FROM suppliers WHERE id = ? AND COALESCE(tenant_id,1) = ?').get(req.params.id, tid);
  if (!s || !s.channel_qr_data) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: { name: s.name, qr: s.channel_qr_data } });
});

// ═══ REORDER ════════════════════════════════════════════════════════════════
// Products sitting below their safety buffer across every active store, grouped
// by the supplier we'd order each from (its most-used vendor in retail PO
// history) + the store. Each group can become a one-tap draft order.
router.get('/api/retail-admin/reorder', requireRetailAdmin, (req, res) => {
  const tid = Number(currentTenantId()) || 1;
  let stores = [];
  try { stores = inventory.listStores({ activeOnly: true }); } catch (_) { stores = []; }
  const low = [];
  for (const st of stores) {
    let rows = [];
    try {
      rows = tdb().prepare(`
        SELECT p.id AS product_id, p.name_en, p.name_cn, p.sku,
               COALESCE(s.physical_qty,0)  AS physical_qty,
               COALESCE(s.safety_buffer,0) AS safety_buffer
          FROM store_products p
          LEFT JOIN retail_store_stock s ON s.product_id = p.id AND s.store_id = ?
         WHERE COALESCE(p.is_active,1) = 1
      `).all(st.id);
    } catch (_) { rows = []; }
    for (const r of rows) {
      const buffer = r.safety_buffer > 0 ? r.safety_buffer : 5;
      if (r.physical_qty < buffer) {
        low.push({
          store_id: st.id, store_name: st.name_en || st.code || ('#' + st.id),
          product_id: r.product_id, name_en: r.name_en, name_cn: r.name_cn, sku: r.sku,
          physical_qty: r.physical_qty, buffer,
          suggest: Math.max(1, Math.round(buffer * 2 - r.physical_qty)),
        });
      }
    }
  }
  const prefStmt = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(COALESCE(pli.supplier_name,'')),''), po.supplier, '') AS supplier, COUNT(*) AS c
      FROM po_line_items pli JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.store_product_id = ? AND COALESCE(po.scope,'kitchen') = 'retail' AND COALESCE(po.tenant_id,1) = ${tid}
     GROUP BY 1 ORDER BY c DESC LIMIT 1`);
  const groups = new Map();
  for (const it of low) {
    const pref = prefStmt.get(it.product_id);
    it.supplier = (pref && pref.supplier) ? pref.supplier : null;
    const key = (it.supplier || '—') + '|' + it.store_id;
    if (!groups.has(key)) groups.set(key, { supplier: it.supplier, store_id: it.store_id, store_name: it.store_name, items: [] });
    groups.get(key).items.push(it);
  }
  const out = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  res.json({ success: true, data: out });
});

// Back-order the shortfall: make a fresh draft PO holding the outstanding
// quantity of every line that arrived short (received < ordered), linked to the
// original via backorder_of. Lines never received at all stay on the original
// order — only genuine shortfalls carry over.
router.post('/api/retail-admin/purchases/:id/backorder', requireRetailAdmin, (req, res) => {
  const src = getRetailPO(req.params.id);
  if (!src) return res.status(404).json({ success: false, error: 'not_found' });
  const lines = db.prepare(`
    SELECT * FROM po_line_items WHERE po_id = ? AND (COALESCE(qty_received, qty) < qty) ORDER BY sort_order, id
  `).all(src.id);
  if (!lines.length) return res.status(400).json({ success: false, error: 'nothing_outstanding' });
  try {
    const po_number = nextRetailPONumber();
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO purchase_orders
        (po_number, date, delivery_date, status, supplier, notes, source, scope, store_id, created_by, backorder_of, tenant_id)
        VALUES (?,?,?,'Requested',?,?,'backorder','retail',?,NULL,?,?)`).run(
        po_number, gzToday(), null, src.supplier || null,
        `Back-order from ${src.po_number}`, src.store_id, src.id, currentTenantId());
      const newId = r.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO po_line_items
        (po_id, store_product_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost,
         expense_category, supplier_name, purchase_channel, note, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      lines.forEach((l, i) => {
        const outstanding = (parseFloat(l.qty) || 0) - (l.qty_received == null ? 0 : parseFloat(l.qty_received) || 0);
        ins.run(newId, l.store_product_id, l.ingredient_id, l.name_en, l.name_cn, l.sku, outstanding, l.unit || 'pcs',
          l.cost_per_unit, outstanding * (parseFloat(l.cost_per_unit) || 0), storeCategory(db, l.expense_category),
          l.supplier_name || null, l.purchase_channel || null, l.note || null, i);
      });
      return newId;
    });
    const newId = tx();
    logActivity(req.user.id, req.user.username, 'backorder', 'purchase_order', newId, { from: src.id, po_number, scope: 'retail' }, req.ip);
    res.json({ success: true, id: newId, po_number });
  } catch (e) {
    console.error('[retail backorder]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Set landed-cost extras on a PO, then re-post expenses so Finance reflects
// them (no-op posting until the order is placed — same rule as goods).
router.put('/api/retail-admin/purchases/:id/landed', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const num = v => Math.max(0, parseFloat(v) || 0);
  const { freight, tax, handling } = req.body || {};
  db.prepare('UPDATE purchase_orders SET extra_freight=?, extra_tax=?, extra_handling=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(num(freight), num(tax), num(handling), po.id);
  const posted = postRetailPOExpensesWithSource(po.id);
  // The extras now feed per-unit cost (allocateLandedExtras), and on this screen
  // they are typed AFTER the goods arrive — so a save has to re-run the cost
  // write-back or the new figure would sit on the header and never reach a
  // product. Only on a Delivered PO: before that there is no received quantity
  // to allocate against, and the write-back runs on the way to Ordered anyway.
  // applyReceivedToStock is idempotent (stock moves on the delta, cost writes
  // only on a change), so this re-run books no stock and no duplicate history.
  //
  // MATERIAL lines are deliberately NOT re-costed here. Their write-back is
  // firePriceAlertsForPO, which appends an ingredient_price_history row on every
  // call — the documented reason /undo-receive and the receive route both refuse
  // to re-fire it. So extras typed after a material PO is Delivered reach that
  // PO's ingredients only on the next PO that prices them. Flagged, not papered
  // over: closing it means deciding whether a landed-cost edit deserves its own
  // history row, which is a pricing decision, not a code one.
  // Same shelf the receipts used — see appliedReceiptStore. Identical to
  // po.store_id for every order received before receipts existed.
  const recosted = po.status === 'Delivered' ? applyReceivedToStock(po.id, req, appliedReceiptStore(db, po)) : null;
  logActivity(req.user.id, req.user.username, 'landed_cost', 'purchase_order', po.id, { freight: num(freight), tax: num(tax), handling: num(handling) }, req.ip);
  res.json({ success: true, posted,
             cost_lines_updated: recosted ? recosted.costed : 0,
             landed_lines_skipped: recosted ? recosted.landedSkipped : [] });
});

// A line is a PRODUCT or a MATERIAL, never both — one PO can freely mix lines
// of each kind, but no single line carries both ids. Checked up front, before
// any row is written, so a bad request never leaves a half-inserted PO.
function lineConflict(items) {
  return (items || []).some(item => item.store_product_id && item.ingredient_id);
}

function insertLineItems(poId, items, headerSupplier, reuseExisting) {
  const insertItem = db.prepare(`INSERT INTO po_line_items
    (po_id, store_product_id, ingredient_id, name_en, name_cn, sku, qty, unit, cost_per_unit, total_cost,
     expense_category, supplier_name, purchase_channel, invoice_status, note, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // On an edit (reuseExisting), a line the payload names by id is UPDATED in
  // place rather than dropped and re-inserted. invoice_lines.line_id is ON
  // DELETE CASCADE, so re-inserting used to take the supplier-invoice
  // allocations with it — the kitchen twin of this path (routes/purchases.js)
  // lost a live ¥848.24 link exactly that way, and nothing on either screen
  // said so afterwards.
  const updateItem = db.prepare(`UPDATE po_line_items SET
     store_product_id=?, ingredient_id=?, name_en=?, name_cn=?, sku=?, qty=?, unit=?, cost_per_unit=?,
     total_cost=?, expense_category=?, supplier_name=?, purchase_channel=?, invoice_status=?, note=?, sort_order=?
     WHERE id=? AND po_id=?`);
  const existing = reuseExisting
    ? new Set(db.prepare('SELECT id FROM po_line_items WHERE po_id = ?').all(poId).map(r => r.id))
    : new Set();
  const kept = new Set();
  // Material lines default unit + supplier from the ingredient master, same
  // fallback order the kitchen insert path uses (routes/purchases.js). Unit
  // matters beyond display: firePriceAlertsForPO refuses to write back a price
  // whose line unit doesn't match ingredients.buy_unit, so defaulting a
  // material line to the generic 'pcs' product default would silently make
  // every material price alert impossible.
  const ingStmt = db.prepare('SELECT supplier, buy_unit FROM ingredients WHERE id = ?');
  items.forEach((item, i) => {
    const qty = parseFloat(item.qty) || 0;
    const cpu = parseFloat(item.cost_per_unit) || 0;
    const status = VALID_INVOICE.has(item.invoice_status) ? item.invoice_status : 'not_received';
    let unit = item.unit || null;
    let supplierName = item.supplier_name || headerSupplier || null;
    if (item.ingredient_id) {
      const ing = ingStmt.get(item.ingredient_id);
      if (ing) {
        if (!unit) unit = ing.buy_unit || null;
        if (!item.supplier_name && !headerSupplier && ing.supplier && ing.supplier.trim()) supplierName = ing.supplier.trim();
      }
    }
    const cols = [
      item.store_product_id || null, item.ingredient_id || null,
      item.name_en || '', item.name_cn || null, item.sku || null,
      qty, unit || 'pcs', cpu, qty * cpu, storeCategory(db, item.expense_category),
      supplierName, item.purchase_channel || null, status,
      (item.note || '').trim() || null, i,
    ];
    const lineId = parseInt(item.id, 10);
    if (lineId > 0 && existing.has(lineId)) {
      updateItem.run(...cols, lineId, poId);
      kept.add(lineId);
    } else {
      insertItem.run(poId, ...cols);
    }
  });
  // Only the lines the buyer actually removed are dropped. Their allocations
  // still cascade away — that is the buyer's own decision — but the caller now
  // gets told, so it can be recorded rather than vanish silently.
  const dropped = [...existing].filter(id => !kept.has(id));
  if (!dropped.length) return { dropped: 0, orphaned_links: 0, orphaned_amount: 0 };
  const marks = dropped.map(() => '?').join(',');
  const orphaned = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(allocated_amount),0) AS amount
       FROM invoice_lines WHERE line_id IN (${marks})`).get(...dropped);
  db.prepare(`DELETE FROM po_line_items WHERE po_id = ? AND id IN (${marks})`).run(poId, ...dropped);
  return { dropped: dropped.length, orphaned_links: orphaned.n, orphaned_amount: orphaned.amount };
}

router.post('/api/retail-admin/purchases', requireRetailAdmin, express.json(), (req, res) => {
  const { date, delivery_date, supplier, store_id, notes, items } = req.body || {};
  if (!date) return res.status(400).json({ success: false, error: 'date_required' });
  const storeId = parseInt(store_id, 10);
  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(400).json({ success: false, error: 'store_required' });
  }
  if (lineConflict(items)) return res.status(400).json({ success: false, error: 'line_conflict' });
  try {
    const po_number = nextRetailPONumber();
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO purchase_orders (po_number, date, delivery_date, status, supplier, notes, source, scope, store_id, created_by, tenant_id)
        VALUES (?,?,?,'Requested',?,?,'manual','retail',?,NULL,?)
      `).run(po_number, date, delivery_date || null, supplier || null, notes || null, storeId, currentTenantId());
      const poId = result.lastInsertRowid;
      if (Array.isArray(items) && items.length) insertLineItems(poId, items, supplier);
      return poId;
    });
    const poId = tx();
    logActivity(req.user.id, req.user.username, 'create', 'purchase_order', poId, { po_number, scope: 'retail' }, req.ip);
    res.json({ success: true, id: poId, po_number });
  } catch (e) {
    console.error('[retail-purchasing create]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/api/retail-admin/purchases/:id', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const { date, delivery_date, supplier, store_id, notes, items } = req.body || {};
  // Once receiving has touched stock, the store + lines are frozen — a moved
  // PO would strand its applied quantities at the old store.
  const applied = db.prepare(
    'SELECT COUNT(*) AS c FROM po_line_items WHERE po_id = ? AND COALESCE(stock_applied_qty,0) > 0'
  ).get(po.id).c;
  if (applied && (Array.isArray(items) || (store_id && parseInt(store_id, 10) !== po.store_id))) {
    return res.status(409).json({ success: false, error: 'already_receiving' });
  }
  const storeId = store_id ? parseInt(store_id, 10) : po.store_id;
  if (!storeId || !inventory.getStore(storeId)) {
    return res.status(400).json({ success: false, error: 'store_required' });
  }
  if (lineConflict(items)) return res.status(400).json({ success: false, error: 'line_conflict' });
  let lineDiff = null;
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE purchase_orders SET date = ?, delivery_date = ?, supplier = ?, notes = ?, store_id = ?,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(date || po.date, delivery_date || null, supplier || null, notes || null, storeId, po.id);
    if (Array.isArray(items)) {
      lineDiff = insertLineItems(po.id, items, supplier, true);
    }
  });
  tx();
  // Price write-back + ±5% alert for material lines — mirrors the kitchen
  // items-PUT path (routes/purchases.js), which fires the same way on an
  // items edit against an already-placed PO, not only on the status flip.
  if (Array.isArray(items) && (po.status === 'Ordered' || po.status === 'Delivered')) {
    firePriceAlertsForPO(po.id, po.status === 'Ordered' ? 'po_ordered' : 'po_delivery', actorFor(req));
  }
  postRetailPOExpensesWithSource(po.id);
  logActivity(req.user.id, req.user.username, 'update', 'purchase_order', po.id, { scope: 'retail' }, req.ip);
  if (lineDiff && lineDiff.orphaned_links) {
    logActivity(req.user.id, req.user.username, 'invoice_links_dropped', 'purchase_order', po.id, lineDiff, req.ip);
  }
  res.json({ success: true });
});

// Delete — Draft (Requested) only. Every later status has already posted
// expenses and/or written prices/stock; "Cancel order" is the reversible exit
// for those (keeps the row, zeroes it out — see the /status route). A draft
// never touched any ledger, so deleting it outright is safe and final.
router.delete('/api/retail-admin/purchases/:id', requireRetailAdmin, (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  if (po.status !== 'Requested') return res.status(409).json({ success: false, error: 'not_draft' });
  db.prepare('DELETE FROM po_line_items WHERE po_id = ?').run(po.id);
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(po.id);
  logActivity(req.user.id, req.user.username, 'delete', 'purchase_order', po.id, { po_number: po.po_number, scope: 'retail' }, req.ip);
  res.json({ success: true });
});

router.put('/api/retail-admin/purchases/:id/status', requireRetailAdmin, express.json(), (req, res) => {
  const { status } = req.body || {};
  if (!PO_STATUSES.has(status)) return res.status(400).json({ success: false, error: 'invalid_status' });
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  // LEAVING A POSTABLE STATE GIVES THE GOODS BACK, OR IT DOES NOT HAPPEN.
  // Back to draft (Requested) and Cancel used to fall through to the expense
  // DELETE below and leave the stock booked — stock saying the goods arrived,
  // Finance saying they were never bought. Both now run the same reversal
  // /undo-receive runs, under the same refusal, and expenses and stock move
  // together or neither moves.
  //
  // THE GUARD IS HERE, ON THE ROUTE, NOT ON THE BUTTONS. The buttons already
  // stop rendering once a PO is Delivered, but a status PUT does not come from
  // a button — a defect that is only hard to reach is still reachable. This
  // runs BEFORE the status is written, so a refusal leaves the order exactly
  // as it was found.
  const leavingPostable = status !== 'Ordered' && status !== 'Delivered';
  if (leavingPostable) {
    // Checked BEFORE anything is written: a cancel that cannot fully reverse
    // — stock short on the shelf, or a material cost with no recoverable
    // prior value — writes nothing at all, the same "all of it or none of
    // it" promise reversePOStock already makes for stock alone.
    const costPlan = planMaterialCostRollback(po);
    if (costPlan.unrecoverable.length) {
      return res.status(409).json({ success: false, error: 'cost_not_recoverable', ingredients: costPlan.unrecoverable });
    }
    const rev = reversePOStock(po, req, appliedReceiptStore(db, po));
    if (rev.blocked) return blockedResponse(res, rev.blocked);
    if (rev.reversed_units) {
      logActivity(req.user.id, req.user.username, 'stock_reversed', 'purchase_order', po.id,
                  { scope: 'retail', to: status, reversed_units: rev.reversed_units,
                    reversed_lines: rev.reversed_lines }, req.ip);
    }
    const costRollback = rollbackMaterialCost(po);
    if (costRollback.blocked) {
      // Re-planned inside rollbackMaterialCost() to stay race-safe against the
      // check above; a fresh unrecoverable line here means one appeared in the
      // window between the two, not that the check above was wrong.
      return res.status(409).json({ success: false, error: 'cost_not_recoverable', ingredients: costRollback.blocked });
    }
    if (costRollback.restored) {
      logActivity(req.user.id, req.user.username, 'cost_reverted', 'purchase_order', po.id,
                  { scope: 'retail', to: status, materials_restored: costRollback.restored }, req.ip);
    }
  }
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, po.id);
  // First-time delivery seeds qty_received = qty (the common "everything
  // arrived" case); receive-route edits refine it afterwards.
  if (status === 'Delivered') {
    db.prepare('UPDATE po_line_items SET qty_received = COALESCE(qty_received, qty) WHERE po_id = ?').run(po.id);
    applyReceivedToStock(po.id, req, appliedReceiptStore(db, po));
  }
  // Price write-back + ±5% alert for material lines on this PO. Fires on
  // Ordered too, not just Delivered — mirrors routes/purchases.js exactly:
  // most POs sit at Ordered and never get an explicit Delivered flip, so
  // gating only on Delivered would mean a material's price alert never fires
  // in practice.
  if (status === 'Ordered' || status === 'Delivered') {
    firePriceAlertsForPO(po.id, status === 'Ordered' ? 'po_ordered' : 'po_delivery', actorFor(req));
  }
  // One call for both directions, where a status test and a bare DELETE stood.
  // The poster already refuses to post anything a Draft or a Cancelled order
  // owns, and wipes its rows on the way — and going through it rather than
  // round it is what hands the books BACK to the kitchen original when this
  // copy stands down (see postRetailPOExpensesWithSource).
  postRetailPOExpensesWithSource(po.id);
  logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', po.id,
              { from: po.status, to: status, scope: 'retail' }, req.ip);
  res.json({ success: true });
});

// Undo an accidental "Delivered" — pulls back whatever stock this PO's own
// receiving pushed in (reversing exactly stock_applied_qty per line, so a
// correction made after the fact is never double-reversed) and drops the
// order back to Ordered/Sent.
//
// qty_received AND damaged_qty ARE CLEARED, and that reverses an earlier
// decision here. They used to be left in place so that a re-confirm re-applied
// the same delta without the operator re-entering anything — a real
// convenience, and the reason the old behaviour was chosen. What it cost was
// worse: an order sitting at Sent with every ARRIVED box holding a number
// reads as fully received, because the box shows the ordered qty as a grey
// PLACEHOLDER when nothing is recorded and a solid VALUE when something is
// (receiveRow, public/retail-admin/16-purchasing.js). RPO-0001 went to
// Delivered and back three times on 2026-08-27 and has looked received ever
// since; the buyer read it as the system filling counts on its own. An undo
// asserts THE GOODS NEVER ARRIVED — the same assertion the refusal below is
// built on — so leaving the counts behind contradicts the operation.
//
// The convenience is not lost: "All arrived as ordered" refills every line in
// one click, which is where those numbers came from in the first place.
//
// NOTHING IS ERASED. po_receipts / po_receipt_lines keep their OWN
// qty_received and damaged_qty per receipt (receiptLines() reads them and
// never touches po_line_items), so the delivery that was taken and undone is
// still in Receiving, with its numbers, exactly as before.
//
// Expenses follow honestly: postRetailPOExpenses sums COALESCE(qty_received,
// qty), so a cleared line re-posts at the ORDERED quantity — which is what a
// placed-but-undelivered order should carry, and the same figure it held
// before it was ever marked Delivered.
//
// Deliberately does NOT
// re-fire firePriceAlertsForPO (that already ran once on the way to
// Delivered — re-running it on the way back would append a duplicate price
// history row for no reason) or fire it again when re-confirmed later.
//
// REFUSES RATHER THAN CLAMPS. It used to loop the lines, hand each one to
// adjustStock, and take the result on trust — which meant a reversal into
// stock that had since been sold silently returned less than it claimed,
// zeroed stock_applied_qty anyway, and reported success with a count of lines
// ATTEMPTED. reversePOStock() now checks every product before it writes
// anything and refuses the whole operation if any of them is short; the count
// below is units actually returned to the shelf.
router.put('/api/retail-admin/purchases/:id/undo-receive', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  if (po.status !== 'Delivered') return res.status(409).json({ success: false, error: 'not_delivered' });
  // Reverse off the shelf the goods actually landed on. Identical to
  // po.store_id for every order received before receipts existed.
  const rev = reversePOStock(po, req, appliedReceiptStore(db, po));
  if (rev.blocked) return blockedResponse(res, rev.blocked);
  // AFTER the refusal, never before it. A blocked reversal writes nothing at
  // all — that is the promise undoBlocked makes in so many words
  // (docs/tacet-delivery-vocabulary.md, LOCKED 2026-08-27) — and clearing the
  // counts on the way to a 409 would break it.
  // The returns go with the counts, for the same reason the counts go at all.
  // An undo asserts THE GOODS NEVER ARRIVED, and goods that never arrived
  // cannot have been sent back — a line left claiming "3 returned" against a
  // line claiming nothing was received is a contradiction the screens would
  // then have to render. The stock side needs no separate reversal: a returned
  // unit was already out of stock_applied_qty, so reversePOStock above has
  // already put back exactly what this PO still had on the shelf.
  //
  // The RETURN EVENTS survive, exactly as the delivery does — po_receipts /
  // po_receipt_lines are append-only and keep their own numbers, so what went
  // back is still readable in Receiving after the undo.
  db.prepare(`UPDATE po_line_items
                 SET qty_received = NULL, damaged_qty = 0,
                     returned_qty = 0, return_reason = NULL, returned_at = NULL
               WHERE po_id = ?`).run(po.id);
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('Ordered', po.id);
  postRetailPOExpensesWithSource(po.id);
  logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', po.id,
              { from: 'Delivered', to: 'Ordered', scope: 'retail', undo_receive: true,
                reversed_units: rev.reversed_units, reversed_lines: rev.reversed_lines }, req.ip);
  res.json({ success: true, reversed_units: rev.reversed_units, reversed_lines: rev.reversed_lines });
});

// Bulk per-line receive: qty_received / damaged_qty / tracking / invoice_status
// (which also carries the line's no-invoice mark — see below).
// Every save re-applies the stock delta, re-posts expenses, and — when it
// carried an actual arrived count — moves an Ordered PO to Delivered, which is
// what makes /undo-receive reachable for the stock this route books.
router.put('/api/retail-admin/purchases/:id/receive', requireRetailAdmin, express.json(), (req, res) => {
  const po = getRetailPO(req.params.id);
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  const { receipts } = req.body || {};
  if (!Array.isArray(receipts)) return res.status(400).json({ success: false, error: 'receipts_required' });
  // Reasons are resolved and refused BEFORE the transaction opens, so a bad
  // code cannot leave half a delivery saved, and no stock moves on a payload
  // that was never going to be accepted. The rule itself lives in
  // routes/purchases.js — one definition for both receive endpoints.
  const planned = planReceiptReasons(db, po.id, receipts);
  if (planned.error) return res.status(400).json({ success: false, error: planned.error, line_id: planned.line_id });
  // Returns are resolved and refused in the same breath and for the same
  // reason. lib/po-returns.js holds every rule this enforces — how much may go
  // back, that it needs a reason, and that a payload lowering an arrived count
  // may not strand a return above it — so nothing about what a return IS is
  // decided in this route.
  const returns = planReturns(db, po.id, receipts);
  if (returns.error) return res.status(400).json({ success: false, error: returns.error, line_id: returns.line_id });

  // ── Where this delivery is going ──────────────────────────────────────────
  // Optional. Absent — which is every call the desktop screen makes — means the
  // store the order was raised against, so nothing about that screen changes.
  //
  // REFUSED WHEN STOCK IS ALREADY ON A DIFFERENT SHELF, and that refusal is
  // load-bearing rather than cautious. po_line_items.stock_applied_qty is one
  // number per line with no store in it, so it cannot describe five units at
  // Tianhe and three at Pearl River. Let a second receipt name a different
  // store and the delta lands on the new shelf while the old one keeps the
  // units it already had — and undo-receive, which reverses one figure from one
  // store, could never put that right. So the first receipt that books stock
  // fixes the destination for the rest of the order; anything else needs a
  // transfer (routes/restock.js), which is the mechanism that already moves
  // stock between stores and ledgers both halves.
  const rawStore = req.body?.store_id;
  const wantStore = rawStore === undefined || rawStore === null || rawStore === ''
    ? null : parseInt(rawStore, 10);
  const appliedStore = appliedReceiptStore(db, po);
  if (wantStore != null) {
    if (!Number.isFinite(wantStore) || !inventory.getStore(wantStore)) {
      return res.status(400).json({ success: false, error: 'store_not_found' });
    }
    if (wantStore !== appliedStore) {
      const booked = db.prepare(
        'SELECT 1 FROM po_line_items WHERE po_id = ? AND COALESCE(stock_applied_qty, 0) <> 0 LIMIT 1'
      ).get(po.id);
      if (booked) {
        return res.status(409).json({ success: false, error: 'store_locked', store_id: appliedStore });
      }
    }
  }
  const storeId = wantStore != null ? wantStore : appliedStore;

  // Goods cannot go back to a supplier off a shelf that has not got them.
  // Checked BEFORE the transaction opens, so a refusal writes nothing at all —
  // the promise `undoBlocked` makes for the reversal path, kept here too.
  if (returns.increased) {
    const blocking = planReturnRemoval(po, storeId, returns.plans);
    if (blocking.length) return returnBlockedResponse(res, blocking);
  }

  let missing_lines = 0, damaged_lines = 0, any_qty = false, receipt = null;
  let returned_lines = 0, returned_units = 0, returnReceipt = null;
  const returnMoves = new Map();
  const tx = db.transaction(() => {
    for (const r of receipts) {
      const lineId = parseInt(r.line_id, 10);
      if (!lineId) continue;
      const line = db.prepare('SELECT id, qty FROM po_line_items WHERE id = ? AND po_id = ?').get(lineId, po.id);
      if (!line) continue;
      const sets = [], vals = [];
      if (r.qty_received !== undefined) {
        const q = r.qty_received == null || r.qty_received === '' ? null : Math.max(0, parseFloat(r.qty_received) || 0);
        sets.push('qty_received = ?'); vals.push(q);
        if (q != null) { any_qty = true; if (q < (parseFloat(line.qty) || 0)) missing_lines++; }
      }
      if (r.damaged_qty !== undefined) {
        const dq = Math.max(0, parseFloat(r.damaged_qty) || 0);
        sets.push('damaged_qty = ?'); vals.push(dq);
        if (dq > 0) damaged_lines++;
      }
      if (r.tracking_number !== undefined) { sets.push('tracking_number = ?'); vals.push((r.tracking_number || '').toString().trim() || null); }
      if (r.tracking_carrier !== undefined) { sets.push('tracking_carrier = ?'); vals.push((r.tracking_carrier || '').toString().trim() || null); }
      // "None" on the receive row and the Invoices screen's no-invoice mark are
      // the same fact stated twice, and only the mark is ever read (lineStatus
      // above). Keep them in step: the picker writes both, so a line the buyer
      // marks "None" here stops being chased as "awaiting" over there.
      if (r.invoice_status !== undefined && VALID_INVOICE.has(r.invoice_status)) {
        sets.push('invoice_status = ?'); vals.push(r.invoice_status);
        sets.push('no_invoice_expected = ?'); vals.push(r.invoice_status === 'no_invoice' ? 1 : 0);
      }
      // Why this line came in short. { write:false } for a caller that sent no
      // reason key and has no stale one to clear, which is every save the
      // desktop screen makes today — so a payload that never mentions reasons
      // still writes exactly the columns it always did.
      const plan = planned.plans.get(lineId);
      if (plan && plan.write) { sets.push('receipt_reason = ?'); vals.push(plan.value); }
      // What went back to the supplier.
      //
      // `returned_at` MOVES ONLY WHEN THE FIGURE GROWS. It dates the most
      // recent return, and a correction that lowers one — miscounted the
      // pallet, two sacks came back off the van — is not a new return to be
      // dated. It is cleared with the quantity, so a line can never carry the
      // date of a return it no longer claims, and it is left alone entirely by
      // a save that only restates the same number.
      //
      // CURRENT_TIMESTAMP, not this file's GZ-local clock, and deliberately: the
      // column it will be read beside is po_receipts.received_at, which takes
      // the same SQLite default. Two timestamps in one story must not sit eight
      // hours apart. (Whether that pair should be local rather than UTC is a
      // real question and an older one — it belongs to received_at, and
      // answering it for one column only would be the drift, not the fix.)
      const rPlan = returns.plans.get(lineId);
      if (rPlan && rPlan.write) {
        sets.push('returned_qty = ?');   vals.push(rPlan.qty);
        sets.push('return_reason = ?');  vals.push(rPlan.reason);
        if (rPlan.delta > 0) sets.push('returned_at = CURRENT_TIMESTAMP');
        else if (rPlan.qty === 0) sets.push('returned_at = NULL');
        if (rPlan.delta > 0) { returnMoves.set(lineId, rPlan.delta); returned_lines++; returned_units += rPlan.delta; }
      }
      if (!sets.length) continue;
      vals.push(lineId, po.id);
      db.prepare(`UPDATE po_line_items SET ${sets.join(', ')} WHERE id = ? AND po_id = ?`).run(...vals);
    }
    // The delivery record, appended last so it reads the lines back as stored.
    // Gated on any_qty for the same reason postRetailPOExpenses below is: a
    // save carrying only a tracking number or an invoice mark is not a
    // delivery, and must not leave a phantom row in the Received list.
    // The return, recorded as its own event rather than folded into the
    // delivery record. TWO ROWS, NOT ONE, when a save does both: they are
    // different movements in different directions, and the Received list reads
    // `kind` to keep them apart. A save that only corrects an arrived count
    // writes no return row at all — returnMoves holds only lines whose returned
    // figure actually grew.
    if (returnMoves.size) {
      returnReceipt = recordReceipt(db, {
        poId: po.id, storeId, scope: 'retail', kind: 'return', returns: returnMoves,
        actor: {
          userId: req.user?.id || null,
          label: actorLabel(req),
          realm: req.backendUser ? 'backend' : 'kitchen',
        },
        receipts, note: (req.body && req.body.return_note) || null,
      });
    }
    if (any_qty) {
      receipt = recordReceipt(db, {
        poId: po.id, storeId, scope: 'retail',
        actor: {
          userId: req.user?.id || null,
          label: actorLabel(req),
          // Two id spaces, and this is the half that says which one the id
          // above belongs to: a Mini App Backend operator is a tenant_users
          // row, a kitchen-app session reaching this route through
          // requireRetailAdmin's second branch is a users row.
          realm: req.backendUser ? 'backend' : 'kitchen',
        },
        receipts, note: (req.body && req.body.receipt_note) || null,
      });
    }
  });
  tx();
  // Stock + finance follow the receive state (adjustStock runs outside the PO
  // transaction: it opens its own per-line transactions on the tenant handle).
  const stock = applyReceivedToStock(po.id, req, storeId);
  // Receiving IS the delivery, so record it as one. This route used to book
  // stock and leave the order at Ordered, which put /undo-receive out of reach
  // for the stock it had just booked — that route 409s on anything but
  // Delivered, and its button only renders on Delivered. The only way to an
  // undoable state was "All arrived as ordered", which re-seeds qty_received
  // from qty and so overwrites the counts the operator had just entered.
  //
  // Gated on `any_qty` for the same reason postRetailPOExpenses is: a save
  // carrying only a tracking number or an invoice mark is not a delivery.
  // Only Ordered advances — a draft never reaches the receive screen, and a
  // Cancelled order must not be revived by a receipt.
  //
  // Deliberately does NOT fire firePriceAlertsForPO: it already ran on the way
  // to Ordered (see the /status route's comment), and re-running it here would
  // append a duplicate price-history row — the same reason /undo-receive gives
  // for not re-firing it on the way back.
  // A return-only save is still a money event and still a stock event, so
  // neither of the two `any_qty` gates below may be the only way to reach them.
  // It is NOT a delivery, though: it must not move an Ordered PO to Delivered
  // (nothing turned up) and it must not write a phantom row in the Received
  // list — which is why `delivered` and the receipt record above stay gated on
  // an arrived count while stock and Finance follow either kind of change.
  const anyReturnChange = returns.increased > 0 || returns.decreased > 0;
  const delivered = any_qty && po.status === 'Ordered';
  if (delivered) {
    db.prepare("UPDATE purchase_orders SET status = 'Delivered', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(po.id);
    logActivity(req.user.id, req.user.username, 'status_change', 'purchase_order', po.id,
                { from: po.status, to: 'Delivered', scope: 'retail', via: 'receive' }, req.ip);
  }
  if (any_qty || anyReturnChange) postRetailPOExpensesWithSource(po.id);
  logActivity(req.user.id, req.user.username, 'receive', 'purchase_order', po.id,
              { lines: receipts.length, missing_lines, damaged_lines, scope: 'retail',
                store_id: storeId, receipt_id: receipt?.receiptId ?? null,
                returned_lines, returned_units,
                return_receipt_id: returnReceipt?.receiptId ?? null }, req.ip);
  res.json({ success: true, missing_lines, damaged_lines, stock_lines_adjusted: stock.applied,
             cost_lines_updated: stock.costed, cost_lines_owned_by_recipe: stock.costSkippedRecipe,
             landed_lines_skipped: stock.landedSkipped,
             store_id: storeId,
             receipt_id: receipt?.receiptId ?? null, receipt_lines: receipt?.lines ?? 0,
             returned_lines, returned_units,
             return_receipt_id: returnReceipt?.receiptId ?? null,
             status: delivered ? 'Delivered' : po.status });
});

module.exports = router;
