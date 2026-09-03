// Waste — a stock movement with a reason.
//
// docs/tacet-consolidation-decisions.md §32 and its 2026-08-27 addendum, with
// the current-state evidence in docs/tacet-waste-survey.md.
//
// THIS IS NOT THE KITCHEN WASTE SCREEN'S API. `routes/waste.js` and its
// `waste_entries` table are untouched by this file and stay live until Roots is
// cut over (§32 rule 2). They share no table, no route prefix and no code. The
// kitchen one writes a log that moves no stock and points at the KITCHEN
// `products` table; this one moves stock and points at `store_products`.
//
// WHAT THIS FILE IS RESPONSIBLE FOR, IN ONE LINE EACH
//   • Recording a loss so the on-hand number goes down and the channels hear
//     about it, in one transaction (§32 rule 6).
//   • Snapshotting what it cost, once, at entry, never recomputed (§32 rule 9),
//     and saying so out loud when it could not (§32 rule 10).
//   • Voiding by REVERSAL, never by edit or delete (§32 rule 11, §20).
//
// PRODUCT SUBJECTS ONLY, TODAY. The table carries the material subject and its
// constraint, and this API refuses one (§32 addendum point 1): materials have no
// stock and no ledger, so "recording waste moves stock" cannot hold for one, and
// the resolution is to refuse it rather than to record a material loss that
// moves nothing — which is precisely the kitchen defect being replaced.
//
// A NOTE ON THE PICKER, WHICH IS A BUG FIX, NOT A CONVENIENCE. The kitchen
// screen's product picker calls an endpoint gated on the `products` permission,
// while the screen itself is gated on `waste` — so the default permission set
// (waste on, products off) hands a waste-only user an empty picker with no
// error. That is H13 in the survey. The picker here is gated on the waste
// capability alone and never consults a products permission.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const inventory = require('../lib/inventory');
const { productUnitCostYuan } = require('../lib/product-cost');
const { businessDateForLocation } = require('../lib/business-date');
const { requireRetailAdmin } = require('./retail');
const { logActivity } = require('../middleware/auth');

const router = express.Router();

// ── The seeded reason list (§32 rule 7) ──────────────────────────────────────
//
// FIXED IN THIS PHASE AND NOT ACCOUNT-EDITABLE. §32's open items record that
// whether an account may add, rename or retire a code is NOT decided, so this
// list is a constant rather than a table — a table would be a half-built answer
// to a question nobody has settled, and it is far easier to add one later than
// to take one away.
//
// `staff_consumption` and `sampling` are their own codes deliberately (§32 rule
// 8): stock taken by the team, or given away to sell something, is a real cost
// and a DIFFERENT one from spoilage, and a number that merges them cannot be
// acted on. A discounted sale is not in this list at all and must never be —
// it is revenue and it belongs in Orders.
//
// Served over the wire by GET /reasons so the screen, when it is built, reads
// the list from here rather than keeping a second copy that drifts — which is
// exactly how the kitchen screen ended up with a reason vocabulary that exists
// only in the browser and an assistant documenting a seventh code nobody built.
const REASONS = [
  { code: 'spoiled',           en: 'Spoiled',           cn: '变质' },
  { code: 'expired',           en: 'Expired',           cn: '过期' },
  { code: 'damaged',           en: 'Damaged',           cn: '损坏' },
  { code: 'preparation_error', en: 'Preparation error', cn: '制作失误' },
  { code: 'staff_consumption', en: 'Staff consumption', cn: '员工取用' },
  { code: 'sampling',          en: 'Sampling',          cn: '试吃样品' },
  { code: 'other',             en: 'Other',             cn: '其他' },
];
const REASON_CODES = new Set(REASONS.map(r => r.code));

// The row shape every endpoint returns, so a caller never has to know which one
// it came from.
const ROW_COLS = `
  id, location_id, subject_type, store_product_id, material_id,
  qty, unit, reason_code, note,
  cost_total_cents, is_uncosted, business_date,
  created_at, created_by, created_by_label,
  reverses_waste_id, voided_at, voided_by, voided_by_label, voided_by_waste_id
`;

// A live loss: not itself a reversal, and not voided by one. BOTH halves are
// needed and neither implies the other — the original stays in the table after
// it is voided, and the reversal is a row in its own right. Summing without
// this predicate counts a voided loss twice and then adds its own reversal.
const LIVE_ONLY = 'reverses_waste_id IS NULL AND voided_by_waste_id IS NULL';
// The same columns qualified for the list's join. Derived from ROW_COLS rather
// than typed twice, so a column added above cannot be forgotten here — the two
// lists drifting apart is exactly how a screen ends up silently missing a field.
const W_COLS = ROW_COLS.split(',').map(c => c.trim()).filter(Boolean).map(c => 'w.' + c).join(', ');


// ── Account-level switch (§32 rule 4) ────────────────────────────────────────
//
// Waste has its OWN toggle and is NOT gated behind Production, because a pure
// retail account that makes nothing still wastes finished stock. Read exactly
// the way lib/features.js reads `production`: the operator preference in
// storefront_config, absent meaning never-touched, which is ON. An unreadable
// row is also ON — a loss must not silently fail to record because a config read
// hiccuped.
//
// There is no Settings UI for this yet (see the PR description); the reader
// exists so the switch has one meaning the day the control is added, rather than
// being invented twice.
function wasteEnabled(db) {
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = 'features.waste'").get();
    if (!row) return true;
    return JSON.parse(row.value_json) !== false;
  } catch (e) { return true; }
}

function requireWasteEnabled(req, res, next) {
  if (!wasteEnabled(tdb())) {
    return res.status(403).json({ error: 'waste_disabled', message: 'Waste is switched off for this account.' });
  }
  next();
}

// ── Who may read what a loss COST (Ash, 2026-09-02) ──────────────────────────
//
// `waste:view` opens the ledger; `waste:costs` reads the money in it. The two
// were one capability, so the warehouse and store_manager presets — whose job
// is recording what spoiled — read the cost of every loss in the business.
//
// THIS IS ENFORCED HERE, ON THE WIRE, and not only in the two clients. A screen
// that hides a number it was sent is a screen, not a permission: the figure is
// still in the JSON, one devtools tab or one proxy away. So a caller without
// the capability is never SENT a cost, and the clients then have nothing to
// leak. Both clients still gate their own layout — that is what keeps the
// column from rendering as an empty gap — but this is the half that is true
// regardless of which client is asking.
//
// FAILS CLOSED, unlike every other cap check in this product. Elsewhere a null
// cap set means "unknown, allow" — an operator locked out of their own app by
// a resolution hiccup is worse than one shown a control they cannot use. Money
// inverts that trade: the cost of failing closed is a figure missing for one
// request, and the cost of failing open is money on a screen that must never
// show it. req.caps is null only when resolveOperator threw, which is already
// a degraded request.
//
// NOT gated through lib/cap-routes.js, deliberately: that map only runs when a
// tenant has switched rbac_enforce on, and it gates MUTATIONS while leaving
// reads open. This is a read, it must hold for every tenant today, and it
// refuses a FIELD rather than a request — nobody is 403'd for lacking it.
function canSeeCosts(req) {
  return !!(req.caps && req.caps.has && req.caps.has('waste:costs'));
}

// Strip the money out of a row for a caller who may not read it.
//
// The keys are DELETED, not zeroed. A cost of null with is_uncosted still set
// would render as "No cost" — a claim about this product's costing that we are
// not making — and a zero would say the jar was free. Absent is the only honest
// shape, and `costs_hidden` on the envelope is what tells a client the
// difference between "we are not showing you this" and "there was none".
function stripCost(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.cost_total_cents;
  delete out.is_uncosted;
  return out;
}

// Who did this. The id alone is ambiguous — a kitchen users(id) and a backend
// operator's tenant_users(id) are two colliding sequences — so the label is
// stored beside it and is the field to read. Same reasoning, and the same
// shape, as retail_stock_ledger.actor_user_id / actor_label.
function actorOf(req) {
  return {
    id: req.user?.id ?? null,
    label: req.user?.display_name || req.user?.username || null,
  };
}

// ── GET /reasons ─────────────────────────────────────────────────────────────
router.get('/api/retail-admin/waste/reasons', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: REASONS });
});

// ── GET /products — THE PICKER ───────────────────────────────────────────────
//
// Gated on requireRetailAdmin and nothing else, which is the point (H13). It
// returns what a person choosing a product to write off actually needs: what it
// is, what it costs, and HOW MANY ARE THERE — because the record will be refused
// if they type more than that, and finding out at save time is worse than
// seeing it while choosing.
//
// `on_hand` is PHYSICAL, not available (§10 requires every screen to say which
// it shows, and the field name is the saying). Waste removes what is on the
// shelf; reservations and buffers are a selling concept and have no bearing on
// whether a jar can be dropped.
router.get('/api/retail-admin/waste/products', requireRetailAdmin, requireWasteEnabled, (req, res) => {
  const db = tdb();
  const locationId = Number(req.query.location_id);
  if (!locationId) return res.status(400).json({ error: 'location_required' });

  const search = (req.query.search || '').trim();
  const params = [locationId];
  let where = 'COALESCE(p.is_active, 1) = 1';
  if (search) {
    where += ' AND (p.name_en LIKE ? OR p.name_cn LIKE ? OR p.sku LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const rows = db.prepare(`
    SELECT p.id, p.name_en, p.name_cn, p.sku, p.weight AS size, p.unit_cost,
           COALESCE(ss.physical_qty, 0) AS on_hand
      FROM store_products p
      LEFT JOIN retail_store_stock ss ON ss.product_id = p.id AND ss.store_id = ?
     WHERE ${where}
     ORDER BY p.name_en
     LIMIT 200
  `).all(...params);
  // `unit_cost` is money and rides on every picker row. Neither client renders
  // it — which is exactly why it survived a reading of both screens — but it is
  // on the wire, and a per-unit cost is the figure the totals are built from.
  if (!canSeeCosts(req)) {
    return res.json({ success: true, costs_hidden: true,
      data: rows.map(r => { const o = { ...r }; delete o.unit_cost; return o; }) });
  }
  res.json({ success: true, data: rows });
});

// ── GET /preview — what will this cost, before I commit to it ────────────────
//
// The same accessor and the same arithmetic the write uses, so the figure shown
// and the figure stored cannot disagree. Returns `uncosted` rather than a zero,
// for the reason §32 rule 10 gives.
router.get('/api/retail-admin/waste/preview', requireRetailAdmin, requireWasteEnabled, (req, res) => {
  const db = tdb();
  const productId = Number(req.query.store_product_id);
  const qty = Number(req.query.qty);
  if (!productId) return res.status(400).json({ error: 'store_product_id_required' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty_positive_required' });

  // This endpoint is nothing BUT the cost, so for a caller who may not read one
  // there is no reduced answer to give — it returns the shape with the money
  // absent and says why. The clients do not call it in that state; this is the
  // backstop for the one that forgets, and for anyone calling the API directly.
  if (!canSeeCosts(req)) {
    return res.json({ success: true, costs_hidden: true, data: { store_product_id: productId, qty } });
  }
  const unitYuan = productUnitCostYuan(db, productId);
  const cost = resolveCostCents(unitYuan, qty);
  res.json({
    success: true,
    data: {
      store_product_id: productId,
      qty,
      unit_cost_yuan: unitYuan,
      cost_total_cents: cost.cents,
      is_uncosted: cost.uncosted ? 1 : 0,
    },
  });
});

// ── The cost snapshot (§32 addendum point 3) ─────────────────────────────────
//
// Unit cost times quantity, ROUNDED ONCE, here, and stored as whole cents. §24's
// exclusion of whole cents for per-unit costs is about RATES that get multiplied
// downstream — a per-gram figure rounded to a cent and then multiplied by a
// thousand carries the rounding error a thousand times. This is the product of
// that multiplication and nothing multiplies it again.
//
// THE SUB-CENT FLOOR. A real loss whose total rounds below one cent is stored as
// one cent, not as zero. Zero is reserved for nothing at all: §32 rule 10 says a
// loss nobody could price and a loss that cost nothing must not render alike,
// and the table's CHECK enforces that a stored cost is strictly positive. The
// alternative — letting a genuine loss round away to a figure the schema then
// refuses — would fail the save outright over a tenth of a cent.
function resolveCostCents(unitYuan, qty) {
  if (unitYuan == null) return { cents: null, uncosted: true };
  const cents = Math.round(unitYuan * qty * 100);
  return { cents: Math.max(1, cents), uncosted: false };
}

// ── GET / — the list ───────────────────────────────────────────────
//
// `include_voided=1` returns the reversals and the rows they cancelled as well.
// The screen asks for it, because a voided entry must stay VISIBLE — a ledger
// that quietly drops its own corrections is how nobody notices one.
//
// THE TOTALS DO NOT FOLLOW THE LIST, AND THAT IS THE POINT. They are always
// computed over the LIVE subset of the same filter, whether or not voided rows
// are being listed. A void returns the stock and cancels the loss (§32 rule 11),
// so counting a voided entry as a loss reports money that was never lost; and
// because a reversal is itself a positive row, summing the listed set with
// voided rows in it counts the same loss twice and then adds its own undo.
// `voided_entries` is returned beside the total so the exclusion is STATED
// rather than silent — a reader can see that corrections exist and that they
// are not in the number.
//
// The names are JOINED, not stored. Unlike the kitchen table this row does not
// snapshot a product name, so a rename rewrites what history reads — recorded
// here because it is a real trade and not an oversight: the id is the record and
// the name is a lookup. A product deleted outright leaves a null name, which the
// screen renders as an unknown rather than as a blank.
router.get('/api/retail-admin/waste', requireRetailAdmin, requireWasteEnabled, (req, res) => {
  const db = tdb();
  const { from, to, location_id, reason, include_voided } = req.query;
  const parts = [];
  const params = [];
  if (from)        { parts.push('w.business_date >= ?'); params.push(from); }
  if (to)          { parts.push('w.business_date <= ?'); params.push(to); }
  if (location_id) { parts.push('w.location_id = ?');    params.push(Number(location_id)); }
  if (reason)      { parts.push('w.reason_code = ?');    params.push(reason); }
  const filter = parts.length ? parts.join(' AND ') : '1=1';
  const live = LIVE_ONLY.replace(/(reverses_waste_id|voided_by_waste_id)/g, 'w.$1');
  const listWhere = (include_voided === '1' || include_voided === 'true') ? filter : `${filter} AND ${live}`;

  const rows = db.prepare(`
    SELECT ${W_COLS},
           p.name_en AS product_name_en, p.name_cn AS product_name_cn, p.sku AS product_sku,
           s.code    AS location_code,   s.name_en AS location_name_en, s.name_cn AS location_name_cn
      FROM waste_records w
      LEFT JOIN store_products p ON p.id = w.store_product_id
      LEFT JOIN retail_stores  s ON s.id = w.location_id
     WHERE ${listWhere}
     ORDER BY w.business_date DESC, w.id DESC
     LIMIT 500
  `).all(...params);

  // The uncosted COUNT travels with the total, always (§32 rule 10) — a total
  // presented alone reads as complete, and the whole point of the flag is that
  // sometimes it is not.
  const totals = db.prepare(`
    SELECT COALESCE(SUM(w.cost_total_cents), 0) AS cost_total_cents,
           COALESCE(SUM(w.qty), 0)              AS qty_total,
           COUNT(*)                             AS entries,
           COALESCE(SUM(w.is_uncosted), 0)      AS uncosted_entries
      FROM waste_records w
     WHERE ${filter} AND ${live}
  `).get(...params);
  const voided = db.prepare(
    `SELECT COUNT(*) AS n FROM waste_records w WHERE ${filter} AND w.voided_by_waste_id IS NOT NULL`
  ).get(...params);
  totals.voided_entries = voided.n;

  // The money comes out of BOTH halves or neither. Leaving the total behind
  // while stripping the rows would hand back the one figure that matters most,
  // and the uncosted count is a statement about costing, so it goes with it.
  if (!canSeeCosts(req)) {
    delete totals.cost_total_cents;
    delete totals.uncosted_entries;
    return res.json({ success: true, data: rows.map(stripCost), totals, costs_hidden: true });
  }
  res.json({ success: true, data: rows, totals });
});

// ── POST / — record a loss ───────────────────────────────────────────────────
router.post('/api/retail-admin/waste', requireRetailAdmin, requireWasteEnabled, (req, res) => {
  const db = tdb();
  const b = req.body || {};
  const subjectType = String(b.subject_type || 'product');

  // The material subject is REFUSED, not silently dropped and not quietly
  // recorded as a log (§32 addendum point 1). The message says what is missing
  // rather than "invalid", because the caller did nothing wrong — the capability
  // does not exist yet.
  if (subjectType === 'material') {
    return res.status(400).json({
      error: 'material_subject_unavailable',
      message: 'Material waste is not available yet. Materials have no stock to move, so a material loss cannot be recorded as a stock movement. Product waste is available now.',
    });
  }
  if (subjectType !== 'product') return res.status(400).json({ error: 'subject_type_invalid' });

  const locationId = Number(b.location_id);
  const productId  = Number(b.store_product_id);
  const qty        = Number(b.qty);
  const reason     = String(b.reason_code || '');
  const note       = b.note == null ? null : String(b.note).trim() || null;

  if (!locationId) return res.status(400).json({ error: 'location_required' });
  if (!productId)  return res.status(400).json({ error: 'store_product_id_required' });
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'qty_positive_required', message: 'Quantity must be greater than zero.' });
  }
  // Products are counted in whole units (§7). The stock column is an INTEGER,
  // so a fractional quantity would be recorded in full on the waste row and
  // truncated on the movement — the two records would disagree by design.
  if (!Number.isInteger(qty)) {
    return res.status(400).json({ error: 'qty_whole_units_required', message: 'Products are counted in whole units.' });
  }
  if (!REASON_CODES.has(reason)) {
    return res.status(400).json({ error: 'reason_invalid', allowed: [...REASON_CODES] });
  }
  if (reason === 'other' && !note) {
    return res.status(400).json({ error: 'note_required_for_other', message: 'Tell us what happened when the reason is Other.' });
  }

  // `unit` is left EMPTY for a product unless the caller states one. A product
  // subject is counted in whole selling units by definition (§7, and the
  // integer check above), so there is nothing for a unit string to add. The
  // kitchen screen hardcodes 'pcs' on every row including things sold by
  // weight, which is survey hazard H7 — a label that is right by accident is
  // not better than an empty one. The column stays for the material subject,
  // where grams and millilitres are the whole point.
  const location = db.prepare('SELECT id, timezone FROM retail_stores WHERE id = ?').get(locationId);
  if (!location) return res.status(404).json({ error: 'location_not_found' });
  const product = db.prepare('SELECT id, name_en, sku, weight FROM store_products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'product_not_found' });

  const actor = actorOf(req);
  const businessDate = businessDateForLocation(db, locationId);

  try {
    const out = db.transaction(() => {
      // REFUSE, DO NOT CLAMP. adjustStock's delta path silently applies
      // `Math.max(0, old + delta)` and discards the shortfall — a behaviour §10
      // has already withdrawn but which is still live. Reusing it without this
      // check would write a waste row saying 5 and a movement saying 3, with no
      // error anywhere. A mismatch means the count is already wrong, and the
      // person entering it is the one who can see the shelf; tell them the
      // figure we hold and let them decide.
      //
      // The check lives INSIDE the transaction so the quantity it read cannot
      // move before the movement is applied. Passing it also makes the clamp
      // unreachable, which is the point — this does not fix adjustStock, it
      // stops depending on it being wrong.
      const onHand = db.prepare(
        'SELECT COALESCE(physical_qty, 0) AS q FROM retail_store_stock WHERE store_id = ? AND product_id = ?'
      ).get(locationId, productId)?.q ?? 0;
      if (qty > onHand) {
        const e = new Error('insufficient_stock');
        e.detail = { on_hand: onHand, requested: qty };
        throw e;
      }

      const unitYuan = productUnitCostYuan(db, productId);
      const cost = resolveCostCents(unitYuan, qty);

      const ins = db.prepare(`
        INSERT INTO waste_records
          (location_id, subject_type, store_product_id, qty, unit, reason_code, note,
           cost_total_cents, is_uncosted, business_date, created_by, created_by_label)
        VALUES (?, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        locationId, productId, qty, b.unit || null, reason, note,
        cost.cents, cost.uncosted ? 1 : 0, businessDate, actor.id, actor.label
      );
      const wasteId = Number(ins.lastInsertRowid);

      // The movement. One transaction with the row above: better-sqlite3 nests
      // this as a savepoint, so a failure in either rolls back both and neither
      // lands. adjustStock is what fans the change out to Meituan, Eleme and
      // gzgrocery (enqueueChannelSync) — stock that drops here and not there is
      // live overselling, which is why this reuses it rather than writing its
      // own ledger row.
      inventory.adjustStock({
        storeId: locationId,
        productId,
        deltaQty: -qty,
        actorUserId: actor.id,
        actorLabel: actor.label,
        note: `waste #${wasteId} · ${reason}`,
        reason: 'waste',
      });

      linkLedgerToWaste(db, locationId, productId, wasteId);
      return db.prepare(`SELECT ${ROW_COLS} FROM waste_records WHERE id = ?`).get(wasteId);
    })();

    logActivity(actor.id, actor.label, 'create', 'waste_record', out.id,
      { product: product.name_en, qty, reason, cost_total_cents: out.cost_total_cents }, req.ip);
    // The activity log above keeps the real figure — it is the audit trail and
    // is read by people who may see money. What goes BACK to the recorder is
    // stripped: this response is what a phone builds its "recorded ¥96" toast
    // from, and that toast is the easiest place in the whole flow to leak a
    // cost to somebody who may not read one.
    if (!canSeeCosts(req)) return res.json({ success: true, costs_hidden: true, data: stripCost(out) });
    res.json({ success: true, data: out });
  } catch (e) {
    if (e.message === 'insufficient_stock') {
      return res.status(409).json({
        error: 'insufficient_stock',
        message: `Only ${e.detail.on_hand} on hand at this location — cannot write off ${e.detail.requested}.`,
        ...e.detail,
      });
    }
    console.error('[waste] record failed:', e);
    res.status(500).json({ error: 'record_failed', message: e.message });
  }
});

// Point the ledger row just written back at the waste record that caused it.
//
// adjustStock hardcodes ref_table/ref_id and takes no argument for them, and the
// brief for this work says not to change it — so the link is made here instead,
// inside the same transaction. The columns already exist; nothing is added to
// the ledger.
//
// Finding the row by MAX(id) is safe for exactly one reason: better-sqlite3 is
// synchronous and this runs inside the transaction that wrote it, so no other
// statement can have appended a matching row in between. `last_insert_rowid()`
// is NOT usable here — enqueueChannelSync writes to the channel queue tables
// after the ledger insert and moves it.
function linkLedgerToWaste(db, storeId, productId, wasteId) {
  try {
    const row = db.prepare(
      `SELECT MAX(id) AS id FROM retail_stock_ledger
        WHERE store_id = ? AND product_id = ? AND reason = 'waste'`
    ).get(storeId, productId);
    if (row?.id) {
      db.prepare("UPDATE retail_stock_ledger SET ref_table = 'waste_records', ref_id = ? WHERE id = ?")
        .run(wasteId, row.id);
    }
  } catch (e) {
    // Best-effort: the movement and the record are both already correct, and an
    // audit convenience must not roll back a loss that really happened.
    console.error('[waste] ledger link failed:', e.message);
  }
}

// ── POST /:id/void — undo by reversal, never by edit ─────────────────────────
//
// §32 rule 11 and §20: nothing with history is deleted. The original keeps every
// field it was written with; the only columns that ever change on it are its
// void status and the pointer to the row that voided it. The stock comes back
// through the same path it left by, so the channels hear about the correction
// exactly as they heard about the loss.
router.post('/api/retail-admin/waste/:id/void', requireRetailAdmin, requireWasteEnabled, (req, res) => {
  const db = tdb();
  const id = Number(req.params.id);
  const original = db.prepare('SELECT * FROM waste_records WHERE id = ?').get(id);
  if (!original) return res.status(404).json({ error: 'not_found' });
  if (original.voided_by_waste_id != null) {
    return res.status(409).json({ error: 'already_voided', message: 'This entry has already been voided.' });
  }
  if (original.reverses_waste_id != null) {
    return res.status(409).json({ error: 'cannot_void_a_reversal', message: 'This row is itself a reversal.' });
  }
  if (original.subject_type !== 'product') {
    return res.status(400).json({ error: 'material_subject_unavailable' });
  }

  const actor = actorOf(req);
  const note = req.body?.note == null ? null : String(req.body.note).trim() || null;

  try {
    const out = db.transaction(() => {
      // The reversal carries the ORIGINAL's cost, copied rather than recomputed.
      // §32 rule 9: a later price change must not restate a past loss, and
      // re-deriving here would do exactly that at the worst moment — the pair
      // would stop netting to zero.
      //
      // Its business date is TODAY at the location, because that is when the
      // correction happened. Which day each row lands on does not affect any
      // total: the live-row predicate excludes the original (it now has a
      // voided_by_waste_id) and the reversal (it has a reverses_waste_id), so
      // both drop out of every report either way.
      const ins = db.prepare(`
        INSERT INTO waste_records
          (location_id, subject_type, store_product_id, qty, unit, reason_code, note,
           cost_total_cents, is_uncosted, business_date, created_by, created_by_label, reverses_waste_id)
        VALUES (?, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        original.location_id, original.store_product_id, original.qty, original.unit,
        original.reason_code, note, original.cost_total_cents, original.is_uncosted,
        businessDateForLocation(db, original.location_id), actor.id, actor.label, original.id
      );
      const reversalId = Number(ins.lastInsertRowid);

      db.prepare(`
        UPDATE waste_records
           SET voided_at = CURRENT_TIMESTAMP, voided_by = ?, voided_by_label = ?, voided_by_waste_id = ?
         WHERE id = ?
      `).run(actor.id, actor.label, reversalId, original.id);

      // Stock returns. Reason stays 'waste' with a POSITIVE delta rather than
      // becoming 'adjust': this movement belongs to the waste story and the
      // ledger's ref_id ties it to the reversal row. Calling it an adjustment
      // would hide a correction inside the bucket used for recounts.
      // Returning stock can promote orders that were waiting on it: adjustStock
      // runs that check itself on a positive delta, and here it runs inside this
      // transaction rather than after one. That is the behaviour we want — the
      // jar is back, the order can go — and it is safe because nothing after
      // this point can throw (the ledger link swallows its own errors). Worth
      // knowing before adding a step below it that can fail.
      inventory.adjustStock({
        storeId: original.location_id,
        productId: original.store_product_id,
        deltaQty: original.qty,
        actorUserId: actor.id,
        actorLabel: actor.label,
        note: `void of waste #${original.id}`,
        reason: 'waste',
      });

      linkLedgerToWaste(db, original.location_id, original.store_product_id, reversalId);
      return {
        reversal: db.prepare(`SELECT ${ROW_COLS} FROM waste_records WHERE id = ?`).get(reversalId),
        original: db.prepare(`SELECT ${ROW_COLS} FROM waste_records WHERE id = ?`).get(original.id),
      };
    })();

    logActivity(actor.id, actor.label, 'void', 'waste_record', original.id,
      { reversal_id: out.reversal.id, qty: original.qty }, req.ip);
    // Void carries the original's cost on both rows (§32 rule 9), so both are
    // stripped. In practice waste:void is an owner capability and an owner
    // resolves to every capability there is — but a tenant may hand void to a
    // custom role without costs, and this must not be the hole it walks in by.
    if (!canSeeCosts(req)) {
      return res.json({ success: true, costs_hidden: true,
        data: { reversal: stripCost(out.reversal), original: stripCost(out.original) } });
    }
    res.json({ success: true, data: out });
  } catch (e) {
    console.error('[waste] void failed:', e);
    res.status(500).json({ error: 'void_failed', message: e.message });
  }
});

module.exports = router;
module.exports.REASONS = REASONS;
