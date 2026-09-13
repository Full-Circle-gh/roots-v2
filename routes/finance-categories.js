// Finance — the tenant's own expense-category list.
//
// docs/tacet-consolidation-decisions.md §87 part two governs this file. It is
// the list a person picks from when they record money out, and until now it did
// not exist as a list at all.
//
// ── WHAT WAS THERE BEFORE, AND WHY IT WAS NOT A LIST ───────────────────────
// `categories` has carried a `kind='accounting'` since the table was written,
// and NOTHING EVER WROTE TO IT. The admin category CRUD in `routes/retail.js`
// serves `kind='product'` and only that; the boot seed covers 'recipe',
// 'product', 'item_kind' and 'payment_method'. So the expense form built its
// suggestions from the categories already present on rows on screen
// (`finTxCatOptions` in public/retail-admin/22-finance.js) — **the list was the
// accumulated history of what people had typed, which makes the first typo a
// permanent option.** `storeCategory()` snapped new writes onto whatever was
// nearest, including onto the typo.
//
// This file gives the tenant the list itself. `storeCategory` is unchanged and
// still does the snapping; what changes is that there is now something clean to
// snap onto.
//
// ── THE LIST SHIPS EMPTY, AND THAT IS §36's RULE, NOT AN OMISSION ──────────
// No seed, no defaults, nothing created on provision. §36: "an empty list
// cannot offer a wrong option", written after a dropdown of four inherited
// kitchen categories produced the ¥152,309 mis-filing. Nothing here seeds a
// starter set, and a later session must not add one.
//
// ── THE TWO FLAGS ──────────────────────────────────────────────────────────
// `is_operating` is §87's own decision: an owner's private transfer is real
// money that is NOT a cost of running the shop, and a list that cannot say so
// puts it in the same sum as rent. `routes/finance-summary.js` is the reader.
//
// `is_active` is the guard on the first one. An expense row stores its category
// as TEXT and the flag lives on this record, so the two are joined by name —
// **delete a category and every row that named it becomes an operating expense
// again, with no event to see.** A category nothing references may be deleted;
// one that is referenced is deactivated, which takes it off the form and keeps
// the flag readable. Same rule §18 applies to archiving elsewhere.
//
// ── CAPABILITY ─────────────────────────────────────────────────────────────
// No gate is declared here. `lib/cap-routes.js` maps every mutation under
// `/api/retail-admin/finance/` to `finance:record` already, and a second rule
// beside it is how the two come to disagree.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { normaliseCategory, spacingKey, storeCategory } = require('../lib/category-text');
const { withTransaction } = require('../lib/db-transaction');
const { requireRetailAdmin } = require('./retail');
const { logActivity } = require('../middleware/auth');

const router = express.Router();

// This file serves ONE list. `kind` is a constant rather than a parameter on
// purpose: `categories` also holds the product, recipe, item-kind, payment-method
// and income lists, and a route that took the kind from the URL would let the
// expense screen rename a product category. The income list is §36's and is
// read (not written) by routes/finance-transactions.js; it does not travel
// through here.
const KIND = 'accounting';

const ERR = {
  name:      'name required · 分类名称必填',
  duplicate: 'that category already exists · 该分类已存在',
  notFound:  'Not found · 未找到',
};

/** Every category with the count of expense rows that name it. */
function listCategories(db) {
  // THE COUNT IS OVER ALL TIME AND EVERY ROW, PO-derived included. It answers
  // one question — may this be deleted — and a window would answer a different
  // one while looking like this one. A category last used in May is still named
  // by those rows, and deleting it would still silently re-file them.
  // `needs_po` IS NOT COALESCED, and that is the difference between it and the
  // two flags beside it (§111 part two). NULL means nobody has been asked yet;
  // 1 and 0 are answers a person gave. Defaulting it here would tell the screen
  // an answer exists when none does, and the form would stop asking.
  return db.prepare(`
    SELECT c.id, c.name, c.sort_order,
           COALESCE(c.is_operating, 1) AS is_operating,
           COALESCE(c.is_active, 1)    AS is_active,
           c.needs_po                  AS needs_po,
           (SELECT COUNT(*) FROM expense_entries e WHERE e.category = c.name) AS usage_count
      FROM categories c
     WHERE c.kind = ?
     ORDER BY c.sort_order, c.name`).all(KIND);
}

/** The stored row behind an id, or a 404. */
function loadCategory(db, id) {
  if (!/^\d+$/.test(String(id))) return { error: ERR.notFound };
  const row = db.prepare('SELECT * FROM categories WHERE id = ? AND kind = ?').get(id, KIND);
  return row ? { row } : { error: ERR.notFound };
}

/**
 * A submitted name, normalised the way every finance category is normalised.
 *
 * `normaliseCategory` REPAIRS THE PASTE — the Kangxi-radical characters that
 * produced two live spellings of one category on this tenant's own data. It runs
 * here for the same reason `storeCategory` runs on the write side: the master
 * list is the authority for snapping, and a list carrying its own paste artefact
 * would make every row that snapped onto it carry one too.
 */
function readName(body) {
  const name = normaliseCategory((body || {}).name);
  return name === null ? { error: ERR.name } : { name };
}

/**
 * Would this name collide with one already on the list?
 *
 * NOT a SQL `=` and not the UNIQUE index, which both compare bytes. Two entries
 * differing only in spacing or case are ONE category to `storeCategory` — it
 * snaps on `spacingKey` — so a list holding both would decide which of them a
 * typed value lands on by whichever the loop reached first, and the flags on the
 * two could disagree. The comparison here is the same key, so what the list can
 * hold matches what the writer can tell apart.
 */
function collides(db, name, exceptId) {
  const key = spacingKey(name);
  return db.prepare('SELECT id, name FROM categories WHERE kind = ?').all(KIND)
    .some(r => r.id !== exceptId && spacingKey(r.name) === key);
}

// ── GET /api/retail-admin/finance/categories ───────────────────────────────
router.get('/api/retail-admin/finance/categories', requireRetailAdmin, (req, res) => {
  try {
    res.json({ success: true, data: listCategories(tdb()) });
  } catch (e) {
    console.error('[finance/categories GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/retail-admin/finance/categories ──────────────────────────────
router.post('/api/retail-admin/finance/categories', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const db = tdb();
    const v = readName(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (collides(db, v.name)) return res.status(400).json({ error: ERR.duplicate });

    // A NEW CATEGORY IS AN OPERATING EXPENSE UNLESS THE FORM SAYS OTHERWISE.
    // The default matches the column's, and it matches what the money usually
    // is: rent, wages and taxis are the ordinary case, an owner's drawing is
    // the exception somebody chooses deliberately.
    const isOperating = req.body && req.body.is_operating === false ? 0 : 1;
    // Appended, so adding one never reshuffles the order somebody arranged.
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE kind = ?').get(KIND);
    const sort = (max.m || 0) + 1;
    const info = db.prepare(
      'INSERT INTO categories (kind, name, sort_order, is_operating, is_active) VALUES (?,?,?,?,1)'
    ).run(KIND, v.name, sort, isOperating);

    logActivity(req.user?.id || null, req.user?.username || null, 'create', 'finance_category',
      info.lastInsertRowid, { name: v.name, is_operating: isOperating }, req.ip);
    res.json({
      success: true,
      data: { id: info.lastInsertRowid, name: v.name, sort_order: sort, is_operating: isOperating, is_active: 1, usage_count: 0 },
    });
  } catch (e) {
    console.error('[finance/categories POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/retail-admin/finance/categories/:id ─────────────────────────
// Name, operating flag and active flag, in any combination. Absent fields are
// left alone rather than defaulted, so a screen that sends only the flag cannot
// blank the name.
router.patch('/api/retail-admin/finance/categories/:id', requireRetailAdmin, express.json(), async (req, res) => {
  try {
    const db = tdb();
    const found = loadCategory(db, req.params.id);
    if (found.error) return res.status(404).json({ error: found.error });
    const cur = found.row;
    const body = req.body || {};

    let name = cur.name;
    if (body.name !== undefined) {
      const v = readName(body);
      if (v.error) return res.status(400).json({ error: v.error });
      if (collides(db, v.name, cur.id)) return res.status(400).json({ error: ERR.duplicate });
      name = v.name;
    }
    const isOperating = body.is_operating === undefined
      ? (cur.is_operating == null ? 1 : (cur.is_operating ? 1 : 0))
      : (body.is_operating === false ? 0 : 1);
    const isActive = body.is_active === undefined
      ? (cur.is_active == null ? 1 : (cur.is_active ? 1 : 0))
      : (body.is_active === false ? 0 : 1);
    // §111 part two, and it is the one field here that can be set back to "not
    // asked". A person who answers wrongly — "no" for Ingredients — would
    // otherwise never be asked again and would have no way to say so; the same
    // reason `is_active` exists rather than a delete. `null` is that way back.
    const needsPo = body.needs_po === undefined
      ? (cur.needs_po == null ? null : (cur.needs_po ? 1 : 0))
      : (body.needs_po === null ? null : (body.needs_po ? 1 : 0));

    // THE RENAME CARRIES THE ROWS WITH IT, IN ONE TRANSACTION. The expense row
    // stores the category as text, so a rename that did not propagate would
    // leave every existing row pointing at a name the list no longer holds —
    // the rows would lose the flag, and the Summary would move an owner's
    // drawings back into operating expenses on a rename. This is the same
    // propagation the product-category rename already does to store_products,
    // for the same reason, and it must both land or neither.
    //
    // `po_line_items.expense_category` and `ingredients.accounting_category`
    // hold the same vocabulary and are NOT carried. They are the PURCHASING
    // side's copy of the word: a PO's expense rows are re-posted from the line's
    // own category, so renaming that text here would rewrite what Purchasing
    // says a line was for, on a screen this one does not serve. §87 does not
    // decide that, and it is not decided by a side effect here.
    await withTransaction(db, (tx) => {
      tx.prepare('UPDATE categories SET name = ?, is_operating = ?, is_active = ?, needs_po = ? WHERE id = ?')
        .run(name, isOperating, isActive, needsPo, cur.id);
      if (name !== cur.name) {
        tx.prepare('UPDATE expense_entries SET category = ? WHERE category = ?').run(name, cur.name);
      }
    });

    logActivity(req.user?.id || null, req.user?.username || null, 'update', 'finance_category', cur.id,
      { from: cur.name, to: name, is_operating: isOperating, is_active: isActive, needs_po: needsPo }, req.ip);
    res.json({ success: true, data: { id: cur.id, name, is_operating: isOperating, is_active: isActive, needs_po: needsPo } });
  } catch (e) {
    console.error('[finance/categories PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/retail-admin/finance/categories/answer ────────────────────────
// §111 part two. THE ANSWER TO THE ONE QUESTION THE EXPENSE FORM ASKS, recorded
// where the next row filed under the same category will find it.
//
// **BY NAME, NOT BY ID, AND THAT IS WHAT THE CALLER HAS.** The form's category
// box is free text with the tenant's list behind it as suggestions; at the
// moment the question is answered the screen holds a NAME and nothing else.
// Making it look the id up first would be a second round trip to learn something
// this route can read for itself — and it snaps the name through
// `storeCategory` on the way in, the same normalisation every writer of this
// vocabulary uses, so an answer given against a typed spelling lands on the
// listed one rather than missing it.
//
// **A NAME THE LIST DOES NOT HOLD IS A NO-OP, NOT A CREATE** (`recorded: false`).
// §36 ships this list empty and the tenant decides what goes on it; a form that
// quietly added a category every time somebody answered a question would grow
// the list out of typos, which is the failure the list exists to end. The person
// still gets what they answered for THIS row — the answer simply is not
// remembered, because there is nothing yet to remember it on.
//
// The gate is `finance:record`, from lib/cap-routes.js's prefix rule, and it is
// the right one: this is only ever reached by somebody recording money out.
router.put('/api/retail-admin/finance/categories/answer', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const db = tdb();
    const body = req.body || {};
    const name = storeCategory(db, body.name, KIND);
    if (!name) return res.status(400).json({ error: ERR.name });
    // Three states in, three states out — `null` un-answers it, the same way
    // back the PATCH above offers.
    const needsPo = body.needs_po === null ? null : (body.needs_po ? 1 : 0);
    const row = db.prepare('SELECT id, name FROM categories WHERE kind = ? AND name = ?').get(KIND, name);
    if (!row) return res.json({ success: true, recorded: false, name });
    db.prepare('UPDATE categories SET needs_po = ? WHERE id = ? AND kind = ?').run(needsPo, row.id, KIND);
    logActivity(req.user?.id || null, req.user?.username || null, 'update', 'finance_category', row.id,
      { name: row.name, needs_po: needsPo }, req.ip);
    res.json({ success: true, recorded: true, name: row.name, needs_po: needsPo });
  } catch (e) {
    console.error('[finance/categories answer]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/retail-admin/finance/categories/reorder ──────────────────────
// The whole list, in the order it should read. Positions are assigned inside one
// transaction so a half-written order cannot leave the list shuffled.
router.post('/api/retail-admin/finance/categories/reorder', requireRetailAdmin, express.json(), async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite)
    : null;
  if (!ids || !ids.length) return res.status(400).json({ error: ERR.notFound });
  try {
    const db = tdb();
    await withTransaction(db, (tx) => {
      // `AND kind = ?` is what keeps a posted id list from reordering the
      // product categories through this route.
      const stmt = tx.prepare('UPDATE categories SET sort_order = ? WHERE id = ? AND kind = ?');
      ids.forEach((id, i) => stmt.run(i + 1, id, KIND));
    });
    logActivity(req.user?.id || null, req.user?.username || null, 'update', 'finance_category_order',
      null, { count: ids.length }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[finance/categories reorder]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/retail-admin/finance/categories/:id ────────────────────────
// **REFUSED WHILE ANY EXPENSE NAMES IT, and the refusal is the point of the
// active flag.** The row stores the category as text; deleting the record would
// leave those rows intact and unflagged, so an owner's private-expense category
// could be removed from the list and five thousand yuan would walk back into
// operating expenses with nothing on any screen to say it had.
router.delete('/api/retail-admin/finance/categories/:id', requireRetailAdmin, (req, res) => {
  try {
    const db = tdb();
    const found = loadCategory(db, req.params.id);
    if (found.error) return res.status(404).json({ error: found.error });
    const usage = db.prepare('SELECT COUNT(*) AS n FROM expense_entries WHERE category = ?')
      .get(found.row.name).n;
    if (usage > 0) return res.status(409).json({ error: 'in_use', usage_count: usage });

    db.prepare('DELETE FROM categories WHERE id = ? AND kind = ?').run(found.row.id, KIND);
    logActivity(req.user?.id || null, req.user?.username || null, 'delete', 'finance_category',
      found.row.id, { name: found.row.name }, req.ip);
    res.json({ success: true });
  } catch (e) {
    console.error('[finance/categories DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.listCategories = listCategories;
