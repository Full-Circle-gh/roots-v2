// Material requests — the kitchen asks the buyer to BUY, in the realm the
// kitchen is actually in.
//
// docs/tacet-consolidation-decisions.md §86.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// IT IS NOT A PURCHASE ORDER, AND THE SEND DOES NOT MAKE ONE. Ash was given two
// readings of "the kitchen's order fills the buying department's PO
// automatically" and chose the second: the request WAITS here, and the buyer
// converts it into a DRAFT purchase order in one action
// (POST /api/retail-admin/purchases/from-material-requests, in
// routes/retail-purchasing.js beside the copy-from-kitchen bridge it is modelled
// on).
//
// The reason is money. A purchase order posts to `expense_entries` the moment it
// reaches Ordered, and writes the material's price back on the same transition —
// postRetailPOExpenses' postable set is ['Ordered','Delivered'], and the status
// route calls firePriceAlertsForPO on both. So a send that created a PO outright
// would let a cook's tap reach the books, and would have to invent a supplier, a
// price and a store nobody has chosen yet. "Automatic" here means nothing is
// retyped; it does not mean the kitchen spends.
//
// IT IS NOT A RESTOCK. routes/restock.js moves goods Roots already owns between
// Roots' own locations and spends nothing. This asks the company to buy from a
// supplier, which is why it is its own capability and not `restock:request`.
//
// ── WHAT THE COOK SEES, AND WHAT THEY DELIBERATELY DO NOT ───────────────────
//
// A name, a SKU, a unit and a number. NOT a price: a material's buy price is
// `materials:costs`, a money-shows grant, and the kitchen role does not hold it.
// GET /materials below therefore selects the columns the picker needs and no
// cost column at all — the absence is the gate, rather than a screen choosing
// not to draw a field the response happily carried.
//
// ── THE UNIT IS THE MATERIAL'S OWN, AND IS NOT CONVERTED ────────────────────
//
// Ash: "they order according to the unit setup of that material". The line
// stores `ingredients.buy_unit` as it stood when asked, because a material line
// on a retail PO already defaults to buy_unit — firePriceAlertsForPO only writes
// a price back when the line's unit matches it. Carrying buy_unit here makes the
// conversion into a PO the identity. THERE IS NO UNIT ARITHMETIC ON THIS PATH
// AND NONE SHOULD BE ADDED: a gram figure converted on the way into a PO is a
// price write-back quietly not firing.
//
// ── THE LINE IS THE UNIT OF SOURCING, NOT THE REQUEST ───────────────────────
//
// §86 part two, which is §61's grain change applied here for §61's reason. A
// buyer splits a morning's flour and oil across two suppliers as a matter of
// course. `material_request_items.sourced_po_id` is both the record and the
// refusal — a line already carrying one cannot be converted again — and the
// request's status is the rollup, reaching 'sourced' only once every one of its
// lines has.

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { logActivity } = require('../middleware/auth');
const { requireRetailAdmin } = require('./retail');
// §449 — the one clause for "still waiting on the buyer", shared with Home's
// Needs you row on /dashboard/ops.
const { PENDING_FROM, PENDING_WHERE } = require('../lib/material-requests-pending');

const router = express.Router();

/* The next request number.
 *
 * MAX over the series, never COUNT — lib/po-number.js records what COUNT(*) + 1
 * cost the kitchen PO series: clearing test rows drops the count below numbers
 * still in use and the next order reissues one. Written the right way from the
 * start rather than inherited and repaired. */
function nextRequestNumber() {
  const row = tdb().prepare(
    "SELECT MAX(CAST(SUBSTR(mr_number, 4) AS INTEGER)) AS n FROM material_requests WHERE mr_number LIKE 'MR-%'"
  ).get();
  return 'MR-' + String((row && row.n ? row.n : 0) + 1).padStart(4, '0');
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ── §176's TWO MARKS ON A LINE ──────────────────────────────────────────────
 *
 * Ash chose shape C: urgency AND a wanted-by date, both per LINE, neither on
 * the request. §176 carries the reasoning and the objection that survives it —
 * the two can disagree, nothing here can stop them, and THE URGENT FLAG WINS
 * wherever they do. That rule is expressed in the ORDER BY of the buyer's list,
 * not by editing either value on the way in: a route that quietly cleared a
 * date because the line was urgent would be deciding something the kitchen
 * said twice.
 *
 * BOTH ARE OPTIONAL AND NEITHER IS PREFILLED (§39). Absent means absent: a
 * request of plain lines writes 0 and NULL and reads exactly as it did before
 * this section.
 */
function urgentFlag(v) {
  // Anything truthy from a JSON client, and nothing clever: the phone sends a
  // boolean, and `0`, `''`, null and undefined all mean "not urgent".
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}
/* A PLAIN CALENDAR DAY, VALIDATED FOR SHAPE AND FOR EXISTENCE. `2026-02-31`
 * parses in every naive check and is not a day, so the round trip through Date
 * is the test: a string that does not come back as itself never existed.
 *
 * A DATE IN THE PAST IS ACCEPTED, deliberately (§176). A line needed yesterday
 * is late, which is information the buyer wants; refusing it would only mean
 * the kitchen writes the real date somewhere nobody can see. */
function neededBy(v) {
  if (v == null || v === '') return null;
  const raw = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;     // undefined = REFUSE
  const d = new Date(raw + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return undefined;
  return raw;
}
/* THE MERGE ERRS TOWARD BUYING SOONER, which is §176's rule and the reason it
 * is a named function rather than two lines inlined at each of its two call
 * sites. §86 adds the quantities when one request names the same material
 * twice; these two cannot be added, so `urgent` is OR-ed and `needed_by` takes
 * the EARLIER, with a missing date treated as later than any date.
 *
 * LAST-WRITE-WINS WOULD BE THE DANGEROUS ONE: the second of two identical lines
 * would silently cancel the first's urgency, and the kitchen would never see it
 * happen. */
function mergeMarks(seen, add) {
  seen.urgent = seen.urgent || add.urgent ? 1 : 0;
  if (add.needed_by && (!seen.needed_by || add.needed_by < seen.needed_by)) seen.needed_by = add.needed_by;
}

/* Roll the request up from its lines.
 *
 * A REQUEST IS 'sourced' ONLY WHEN EVERY LINE IS, and it rolls BACK when a line
 * is released (the buyer deleted the draft PO it went into). Both directions in
 * one function, called from every place that can move a line, because a rollup
 * maintained at only one of its two edges is how a request ends up permanently
 * closed against lines that are outstanding again. */
function rollUp(requestId) {
  const r = tdb().prepare('SELECT status, archived_at FROM material_requests WHERE id = ?').get(requestId);
  if (!r || r.status === 'draft') return;
  // A STRUCK-OFF LINE IS SETTLED, NOT OUTSTANDING (§174), so it leaves the sum
  // entirely rather than counting as done. Counting it as done would flip the
  // request to 'sourced' — "every line reached a purchase order" — for lines
  // nobody ever bought, and 'sourced' is a word the books are read through.
  const n = tdb().prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN sourced_po_id IS NOT NULL THEN 1 ELSE 0 END) AS done
      FROM material_request_items WHERE request_id = ? AND declined_at IS NULL`).get(requestId);
  const all = n.total > 0 && n.done === n.total;
  if (all && r.status !== 'sourced') {
    tdb().prepare("UPDATE material_requests SET status = 'sourced', sourced_at = CURRENT_TIMESTAMP WHERE id = ?").run(requestId);
  } else if (!all && r.status === 'sourced') {
    tdb().prepare("UPDATE material_requests SET status = 'sent', sourced_at = NULL WHERE id = ?").run(requestId);
  }
  // EVERY LINE STRUCK OFF AND NOTHING BOUGHT — the ask is withdrawn, which is
  // what archived_at has meant here since §86, so it is set rather than a second
  // flag invented for the same fact. Left alone, such a request would sit in the
  // open tab forever with nothing outstanding on it: a row that costs a click
  // and says nothing, which is the shape this module already refuses at POST.
  //
  // SAFE BECAUSE STRIKING OFF IS ONE-WAY. There is no restore to leave a request
  // wrongly archived, and a line already on a purchase order cannot be struck
  // off at all — so `total === 0` here means every line was refused by a buyer,
  // never that a bought one was hidden.
  if (!r.archived_at && n.total === 0) {
    const anySourced = tdb().prepare(
      'SELECT COUNT(*) AS c FROM material_request_items WHERE request_id = ? AND sourced_po_id IS NOT NULL').get(requestId);
    if (!anySourced.c) {
      tdb().prepare('UPDATE material_requests SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(requestId);
    }
  }
}

function itemsFor(id) {
  return tdb().prepare(`
    SELECT i.*, po.po_number AS sourced_po_number, po.status AS sourced_po_status
      FROM material_request_items i
      LEFT JOIN purchase_orders po ON po.id = i.sourced_po_id
     WHERE i.request_id = ?
     ORDER BY i.sort_order, i.id`).all(id);
}

function requestWithItems(id) {
  const r = tdb().prepare('SELECT * FROM material_requests WHERE id = ?').get(id);
  if (!r) return null;
  r.items = itemsFor(id);
  return r;
}

/* ── The picker list ────────────────────────────────────────────────────────
 *
 * Active materials, with the unit they are BOUGHT in. No cost column: see the
 * header. Ordered by name so the list reads the same way twice. */
router.get('/api/retail-admin/material-requests/materials', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(`
    SELECT id, name_en, name_cn, sku, COALESCE(buy_unit, 'pcs') AS buy_unit
      FROM ingredients
     WHERE COALESCE(is_active, 1) = 1
     ORDER BY LOWER(COALESCE(name_en, '')), id`).all();
  res.json({ success: true, data: rows });
});

/* ── What the buyer works from ──────────────────────────────────────────────
 *
 * Every line that has been SENT and not yet sourced, each carrying enough of
 * its parent to be read on its own — the buyer is looking at a list of demand,
 * not at a list of requests they must open one by one.
 *
 * URGENT FIRST, THEN WANTED SOONEST, THEN NEWEST REQUEST (§176). This is where
 * "the buying department will know to prioritise" actually happens: the marks
 * would be decoration if the list they arrive in still read newest-first. A
 * line with no date sorts after every line that has one — `needed_by IS NULL`
 * ahead of `needed_by` in the key, because SQLite sorts NULL first otherwise
 * and "no date" is the loosest claim on the buyer's morning, not the tightest.
 * Urgency outranks both, which is §176's rule for a line whose two marks
 * disagree.
 *
 * Drafts are excluded because a draft is somebody still typing. Archived
 * requests are excluded because archiving is how a request is withdrawn, and
 * struck-off lines (§174) are excluded because refusing to buy one is the buyer
 * saying it is finished with — the same "not outstanding" the other two mean. */
router.get('/api/retail-admin/material-requests/pending-lines', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(`
    SELECT i.id, i.request_id, i.ingredient_id, i.name_en, i.name_cn, i.sku,
           i.qty, i.unit, i.notes,
           COALESCE(i.urgent, 0) AS urgent, i.needed_by,
           r.mr_number, r.date, r.created_by_name, r.notes AS request_notes
      FROM ${PENDING_FROM}
     WHERE ${PENDING_WHERE}
     ORDER BY COALESCE(i.urgent, 0) DESC,
              (i.needed_by IS NULL), i.needed_by,
              r.sent_at DESC, r.id DESC, i.sort_order, i.id`).all();
  res.json({ success: true, data: rows });
});

/* ── What became of what YOU asked for (§175) ───────────────────────────────
 *
 * The cook's side of this module, and the only route here written for the
 * kitchen rather than for the buyer. A cook tapped Send and, until this existed,
 * learned nothing ever again — not that it was ordered, not that a buyer struck
 * a line off (§174), not that the whole request was withdrawn.
 *
 * SCOPED TO THE CALLER by `created_by`, the column the request already stamps.
 * It is *your* requests. A kitchen sharing one login sees everything that login
 * raised, which is the true answer to the question the screen is asking.
 *
 * THE LINE CARRIES THE STATE, NOT THE REQUEST. §86 part two made the line the
 * unit of sourcing and §174 made it the unit of refusal, so one request can be
 * part ordered, part waiting and part struck off at once — any single word
 * printed on the request as a whole is wrong about at least one of its lines.
 * The only genuinely request-level fact is whether it was withdrawn, and that is
 * the only one the header carries.
 *
 * `state` IS DECIDED HERE AND NOT ON THE PHONE. Two screens each deciding what a
 * null means is how they come to disagree; this is Rule 6's "labels have one
 * definition site" applied to a state.
 *
 * NO PRICE, AND NO PURCHASE ORDER NUMBER. The first is §86's rule and the
 * columns below are the gate rather than a screen's discretion. The second is
 * §175's own call: a cook needs to know the thing is ON ORDER, and which order
 * is the buyer's business. */
router.get('/api/retail-admin/material-requests/mine', requireRetailAdmin, (req, res) => {
  const me = (req.user && req.user.id) || null;
  if (!me) return res.json({ success: true, data: [] });
  const rows = tdb().prepare(`
    SELECT id, mr_number, date, status, notes, sent_at, archived_at
      FROM material_requests
     WHERE created_by = ? AND status <> 'draft'
     ORDER BY COALESCE(sent_at, date) DESC, id DESC
     LIMIT 60`).all(me);
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const lines = tdb().prepare(`
      SELECT id, request_id, name_en, name_cn, sku, qty, unit,
             sourced_po_id, declined_at, declined_by_name
        FROM material_request_items
       WHERE request_id IN (${marks})
       ORDER BY sort_order, id`).all(...rows.map(r => r.id));
    const byReq = new Map(rows.map(r => [r.id, []]));
    for (const l of lines) {
      // ORDER MATTERS AND IS NOT ARBITRARY: a line cannot be struck off once it
      // is on an order (§174 refuses it), so the two are already exclusive —
      // but reading sourced first means that if one ever did carry both, the
      // cook is told the thing was BOUGHT rather than that it was refused.
      l.state = l.sourced_po_id ? 'ordered' : (l.declined_at ? 'removed' : 'waiting');
      delete l.sourced_po_id;   // the order is the buyer's business (§175)
      byReq.get(l.request_id).push(l);
    }
    rows.forEach(r => { r.items = byReq.get(r.id) || []; r.withdrawn = !!r.archived_at; });
  }
  res.json({ success: true, data: rows });
});

/* ── The list ───────────────────────────────────────────────────────────────
 *
 * `tab=open` (the default) is everything not yet fully sourced; `tab=all` adds
 * the finished ones; `tab=archived` is the withdrawn ones. Archived rows never
 * appear in the first two — the same soft-delete reading routes/restock.js uses,
 * and the reason scripts/oneoff_clear_kitchen_lists.js could empty three lists
 * with one flag. */
router.get('/api/retail-admin/material-requests', requireRetailAdmin, (req, res) => {
  const tab = String(req.query.tab || 'open');
  const where = tab === 'archived' ? 'r.archived_at IS NOT NULL'
              : tab === 'all'      ? 'r.archived_at IS NULL'
              :                      "r.archived_at IS NULL AND r.status <> 'sourced'";
  const rows = tdb().prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id = r.id) AS line_count,
           (SELECT COUNT(*) FROM material_request_items i WHERE i.request_id = r.id AND i.sourced_po_id IS NOT NULL) AS sourced_count
      FROM material_requests r
     WHERE ${where}
     ORDER BY r.date DESC, r.id DESC
     LIMIT 300`).all();
  res.json({ success: true, data: rows });
});

router.get('/api/retail-admin/material-requests/:id', requireRetailAdmin, (req, res) => {
  const r = requestWithItems(parseInt(req.params.id, 10));
  if (!r) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: r });
});

/* ── Raise one ──────────────────────────────────────────────────────────────
 *
 * `send: true` (what the phone sends) writes it straight to 'sent'. A request
 * with no lines is refused rather than created empty: an empty request in the
 * buyer's list is a row that costs them a click and says nothing.
 *
 * ONE TRANSACTION. The same reason routes/retail-production.js gives for its
 * own: a phone on kitchen wifi that writes the header and loses the connection
 * before its lines have left a request nobody can act on and nobody can see is
 * broken. */
router.post('/api/retail-admin/material-requests', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) return res.status(400).json({ success: false, error: 'no_items' });

  // Resolved BEFORE the transaction opens, so a bad line writes nothing at all
  // rather than half a request — the same all-or-nothing shape
  // copy-from-kitchen promises for a batch.
  const lookup = tdb().prepare(
    "SELECT id, name_en, name_cn, sku, COALESCE(buy_unit, 'pcs') AS buy_unit FROM ingredients WHERE id = ? AND COALESCE(is_active, 1) = 1");
  const resolved = [];
  for (const raw of lines) {
    const ing = lookup.get(parseInt(raw.ingredient_id, 10));
    if (!ing) return res.status(400).json({ success: false, error: 'material_not_found', ingredient_id: raw.ingredient_id });
    const qty = positiveNumber(raw.qty);
    if (qty == null) return res.status(400).json({ success: false, error: 'qty_invalid', ingredient_id: ing.id });
    // REFUSED BEFORE THE TRANSACTION, like every other bad line here: a date
    // that is not a day must cost the whole request rather than be dropped, or
    // the kitchen gets a success for an ask it did not make.
    const by = neededBy(raw.needed_by);
    if (by === undefined) return res.status(400).json({ success: false, error: 'needed_by_invalid', ingredient_id: ing.id });
    resolved.push({ ing, qty, notes: raw.notes ? String(raw.notes).slice(0, 500) : null,
                    urgent: urgentFlag(raw.urgent), needed_by: by });
  }
  // ONE MATERIAL, ONE LINE. Two lines for the same flour reach the buyer as two
  // rows to tick and two lines on the PO for one thing; the quantities are
  // added instead. Merged here rather than on the screen so the rule holds for
  // any client.
  const merged = [];
  for (const r of resolved) {
    const seen = merged.find(m => m.ing.id === r.ing.id);
    if (seen) { seen.qty += r.qty; if (!seen.notes) seen.notes = r.notes; mergeMarks(seen, r); }
    else merged.push(r);
  }

  const send = b.send !== false;
  const actor = req.user || {};
  const out = tdb().transaction(() => {
    const number = nextRequestNumber();
    const info = tdb().prepare(`
      INSERT INTO material_requests (mr_number, date, status, notes, sent_at, created_by, created_by_name)
      VALUES (?, DATE('now'), ?, ?, ${send ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?, ?)`)
      .run(number, send ? 'sent' : 'draft', b.notes ? String(b.notes).slice(0, 1000) : null,
           actor.id || null, actor.display_name || actor.username || null);
    const ins = tdb().prepare(`
      INSERT INTO material_request_items (request_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, sort_order, urgent, needed_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    merged.forEach((r, i) => {
      ins.run(info.lastInsertRowid, r.ing.id, r.ing.name_en, r.ing.name_cn, r.ing.sku, r.qty, r.ing.buy_unit, r.notes, i,
              r.urgent, r.needed_by);
    });
    return { id: info.lastInsertRowid, mr_number: number };
  })();

  logActivity(actor.id, actor.username, 'material_request_created', 'material_request', out.id,
              { mr_number: out.mr_number, lines: merged.length, sent: send }, req.ip);
  res.json({ success: true, data: requestWithItems(out.id) });
});

/* Replace the lines of a request that has not gone out yet.
 *
 * DRAFT ONLY, and the refusal is the point: once the buyer can see it, editing
 * it underneath them would change what they are working from without telling
 * them. A sent request is withdrawn (archived) and raised again. */
router.put('/api/retail-admin/material-requests/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('SELECT * FROM material_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, error: 'not_found' });
  if (r.status !== 'draft') return res.status(409).json({ success: false, error: 'not_draft' });

  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : null;
  if (lines && !lines.length) return res.status(400).json({ success: false, error: 'no_items' });

  let resolved = null;
  if (lines) {
    const lookup = tdb().prepare(
      "SELECT id, name_en, name_cn, sku, COALESCE(buy_unit, 'pcs') AS buy_unit FROM ingredients WHERE id = ? AND COALESCE(is_active, 1) = 1");
    resolved = [];
    for (const raw of lines) {
      const ing = lookup.get(parseInt(raw.ingredient_id, 10));
      if (!ing) return res.status(400).json({ success: false, error: 'material_not_found', ingredient_id: raw.ingredient_id });
      const qty = positiveNumber(raw.qty);
      if (qty == null) return res.status(400).json({ success: false, error: 'qty_invalid', ingredient_id: ing.id });
      const by = neededBy(raw.needed_by);
      if (by === undefined) return res.status(400).json({ success: false, error: 'needed_by_invalid', ingredient_id: ing.id });
      const mark = { urgent: urgentFlag(raw.urgent), needed_by: by };
      const seen = resolved.find(m => m.ing.id === ing.id);
      // THE SAME MERGE AS THE POST, through the same function. Two copies of
      // "OR the flag, keep the earlier date" drift the first time one is fixed.
      if (seen) { seen.qty += qty; mergeMarks(seen, mark); }
      else resolved.push({ ing, qty, notes: raw.notes ? String(raw.notes).slice(0, 500) : null, ...mark });
    }
  }

  tdb().transaction(() => {
    if (b.notes !== undefined) {
      tdb().prepare('UPDATE material_requests SET notes = ? WHERE id = ?')
        .run(b.notes ? String(b.notes).slice(0, 1000) : null, id);
    }
    if (resolved) {
      tdb().prepare('DELETE FROM material_request_items WHERE request_id = ?').run(id);
      const ins = tdb().prepare(`
        INSERT INTO material_request_items (request_id, ingredient_id, name_en, name_cn, sku, qty, unit, notes, sort_order, urgent, needed_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      resolved.forEach((x, i) => ins.run(id, x.ing.id, x.ing.name_en, x.ing.name_cn, x.ing.sku, x.qty, x.ing.buy_unit, x.notes, i,
                                         x.urgent, x.needed_by));
    }
  })();
  res.json({ success: true, data: requestWithItems(id) });
});

/* Send it to the buyer. Idempotent: a second send on an already-sent request
 * answers success without moving `sent_at`, which is the record of when the
 * buyer could first have seen it. */
router.put('/api/retail-admin/material-requests/:id/send', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('SELECT * FROM material_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, error: 'not_found' });
  if (r.archived_at) return res.status(409).json({ success: false, error: 'archived' });
  if (r.status === 'draft') {
    const n = tdb().prepare('SELECT COUNT(*) AS c FROM material_request_items WHERE request_id = ?').get(id);
    if (!n.c) return res.status(400).json({ success: false, error: 'no_items' });
    tdb().prepare("UPDATE material_requests SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logActivity(req.user?.id, req.user?.username, 'material_request_sent', 'material_request', id,
                { mr_number: r.mr_number }, req.ip);
  }
  res.json({ success: true, data: requestWithItems(id) });
});

/* Withdraw / restore. A soft-delete toggle, never a DELETE: the row is the
 * record that the ask happened, and routes/restock.js's archive is the
 * precedent this copies rather than reinvents.
 *
 * A LINE THAT IS ALREADY ON A PURCHASE ORDER STOPS THIS. Archiving would hide
 * the request while its purchase stands, leaving the buyer holding a PO whose
 * origin has vanished from the list it came from. */
router.put('/api/retail-admin/material-requests/:id/archive', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('SELECT * FROM material_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, error: 'not_found' });
  const archived = (req.body || {}).archived !== false;
  if (archived) {
    const sourced = tdb().prepare(
      'SELECT COUNT(*) AS c FROM material_request_items WHERE request_id = ? AND sourced_po_id IS NOT NULL').get(id);
    if (sourced.c) return res.status(409).json({ success: false, error: 'already_sourced' });
  }
  tdb().prepare(`UPDATE material_requests SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`).run(id);
  logActivity(req.user?.id, req.user?.username, archived ? 'material_request_archived' : 'material_request_restored',
              'material_request', id, { mr_number: r.mr_number }, req.ip);
  res.json({ success: true, data: requestWithItems(id) });
});

/* ── Strike one line off ────────────────────────────────────────────────────
 *
 * §174. The buyer, looking at the kitchen's asks, says "we are not buying this
 * one". THE GRAIN IS THE LINE, matching §86 part two's grain for sourcing and
 * for the same reason: a buyer drops the desiccant and still buys the
 * containers. Archiving (above) is the whole-request answer and cannot do that.
 *
 * ONE-WAY, AND DELIBERATELY SO. There is no un-strike, because §86's own rule
 * for a sent request that needs changing is that it is withdrawn and RAISED
 * AGAIN: the ask belongs to the kitchen, so a buyer putting a line back would be
 * the buyer re-raising somebody else's request. It is also what makes rollUp's
 * auto-archive safe to read — see its comment.
 *
 * A LINE ALREADY ON A PURCHASE ORDER STOPS THIS, for archiving's reason at the
 * line's grain: striking it off would hide the ask while its purchase stands,
 * leaving the buyer holding a PO line whose origin has left the list it came
 * from. The order is deleted first, which releases the line, and then it can be
 * struck off. */
router.put('/api/retail-admin/material-requests/lines/:lineId/decline', requireRetailAdmin, express.json(), (req, res) => {
  const lineId = parseInt(req.params.lineId, 10);
  const line = tdb().prepare(`
    SELECT i.*, r.mr_number
      FROM material_request_items i
      JOIN material_requests r ON r.id = i.request_id
     WHERE i.id = ?`).get(lineId);
  if (!line) return res.status(404).json({ success: false, error: 'not_found' });
  if (line.sourced_po_id) return res.status(409).json({ success: false, error: 'already_sourced' });
  // Idempotent, like the send above: a second press on a stale screen answers
  // success without moving `declined_at`, which is the record of when the buyer
  // actually refused it.
  if (!line.declined_at) {
    const actor = req.user || {};
    tdb().prepare(`
      UPDATE material_request_items
         SET declined_at = CURRENT_TIMESTAMP, declined_by = ?, declined_by_name = ?
       WHERE id = ?`).run(actor.id || null, actor.display_name || actor.username || null, lineId);
    rollUp(line.request_id);
    logActivity(actor.id, actor.username, 'material_request_line_declined', 'material_request', line.request_id,
                { mr_number: line.mr_number, line_id: lineId, name_en: line.name_en, qty: line.qty }, req.ip);
  }
  res.json({ success: true, data: requestWithItems(line.request_id) });
});

module.exports = router;
// Shared with routes/retail-purchasing.js, which owns the conversion into a
// purchase order and must roll the request up the moment a line is sourced or
// released. Exported rather than duplicated so the two edges of the rollup
// cannot drift — see rollUp's own comment for why both edges matter.
module.exports.rollUpMaterialRequest = rollUp;
