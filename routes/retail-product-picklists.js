// §150 · The shop's own entries in the product editor's pick lists.
//
// The editor ships six bilingual lists baked into public/product-editor.html —
// PA_ALLERGENS, PA_SPEC_LABELS, PA_SPEC_VALUES, PA_STORAGE_HEADS,
// PA_STORAGE_UNITS, PA_STORAGE_NOTES (decisions §145 to §149). Every entry in
// them was read off the catalogue and chosen by most-used-wins, which is what
// makes them trustworthy and also what makes them CLOSED: a shop that sells
// something this catalogue has never sold has no way to add its word, so it
// retypes the term on every product and the spelling drifts — which is the
// problem those five sections were written to end.
//
// A row here is an ADDITION to one of those lists, never a replacement.
// Nothing removes a built-in entry, nothing rewrites a live page (Ash's
// standing answer: "lists only, for now"), and deleting a row only takes the
// chip away — every product that already used the term keeps saying it.
//
// retail_product_picklists is TENANT data-plane (cloned per tenant, no
// tenant_id column — isolated by DB file), so every query goes through the
// request-scoped tdb(), NOT the shared global db. For Roots (tenant 1)
// tdb() === mainDb, so this is a no-op today; it closes the cross-tenant
// read/write leak before multi-tenant data isolation is enabled.

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

const router = express.Router();

// THE ALLOWLIST IS THE POINT OF THIS FILE. `list_key` is written straight into
// the editor's own list names, so an unknown key would be a row that is stored,
// counted against the cap, and never displayed anywhere — a silent sink. The
// fixed names must match _paCustomTarget() in public/product-editor.html.
const FIXED_KEYS = new Set([
  'allergens',
  'spec_labels',
  'storage_notes',
  'storage_heads.left',
  'storage_heads.right',
  'storage_units.left',
  'storage_units.right',
]);

// The spec strip's value list hangs off the LABEL ("Guangzhou, China" is an
// answer to Origin and nonsense under Net Wt), so its key carries the label's
// English, lower-cased — the same key paSpecValuesFor() already looks up. The
// label is operator-typed, so the tail cannot be an allowlist; it is bounded
// instead. Letters, digits, space and the punctuation the live labels actually
// use — `Net Wt`, `Home & Body`, `Dry & Pantry`, `Raw · whole`.
const SPEC_VALUES_RE = /^spec_values:[a-z0-9][a-z0-9 ._&'’·()/-]{0,59}$/;

const MAX_TEXT = 80;      // longest built-in is 43 chars
const MAX_PER_LIST = 40;  // a list nobody can read is not a convenience

function validKey(k) {
  return FIXED_KEYS.has(k) || SPEC_VALUES_RE.test(k);
}

const rowToOption = (r) => ({ id: r.id, list_key: r.list_key, en: r.en, cn: r.cn });

// Every option the shop has added, flat. The editor groups them by list_key
// itself, because it is the side that knows which lists exist.
router.get('/api/retail-admin/product-picklists', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    'SELECT id, list_key, en, cn FROM retail_product_picklists ORDER BY list_key, id'
  ).all();
  res.json({ success: true, data: rows.map(rowToOption) });
});

// Add one option to one list. BOTH LANGUAGES ARE REQUIRED and that is the
// whole reason these lists beat typing: a term filled in English and forgotten
// in 中文 is invisible on the English view, which is §145's finding. A pick
// that can only fill half the pair would put the gap back.
router.post('/api/retail-admin/product-picklists', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const list_key = String(b.list_key || '').trim();
  if (!validKey(list_key)) {
    return res.status(400).json({ success: false, error: 'bad_list_key' });
  }
  const en = String(b.en || '').trim();
  const cn = String(b.cn || '').trim();
  if (!en || !cn) {
    return res.status(400).json({ success: false, error: 'both_languages_required' });
  }
  if (en.length > MAX_TEXT || cn.length > MAX_TEXT) {
    return res.status(400).json({ success: false, error: 'too_long' });
  }

  const n = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_product_picklists WHERE list_key = ?'
  ).get(list_key).n;
  if (n >= MAX_PER_LIST) {
    return res.status(409).json({ success: false, error: 'list_full' });
  }

  // Duplicates are refused against the shop's OWN rows only. The built-in
  // lists are NOT copied here on purpose: a second copy of PA_ALLERGENS on the
  // server is two lists that must agree with nothing to make them, which is
  // exactly the failure §148 found between the wizard and the details panel.
  // The editor drops a custom entry that duplicates a built-in at merge time,
  // so the invariant holds however the row got in.
  const dup = tdb().prepare(
    'SELECT id FROM retail_product_picklists WHERE list_key = ? AND en = ? COLLATE NOCASE'
  ).get(list_key, en);
  if (dup) {
    return res.status(409).json({ success: false, error: 'duplicate' });
  }

  const createdBy = req.backendUser?.id ?? req.user?.id ?? null;
  const info = tdb().prepare(
    'INSERT INTO retail_product_picklists (list_key, en, cn, created_by) VALUES (?, ?, ?, ?)'
  ).run(list_key, en, cn, createdBy);
  res.json({ success: true, data: { id: info.lastInsertRowid, list_key, en, cn } });
});

// Remove an option the shop added. Products that already carry the term keep
// carrying it — this takes the chip away, not the word off the page.
router.delete('/api/retail-admin/product-picklists/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'bad_id' });
  const info = tdb().prepare('DELETE FROM retail_product_picklists WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

module.exports = router;
module.exports.FIXED_KEYS = FIXED_KEYS;
module.exports.SPEC_VALUES_RE = SPEC_VALUES_RE;
module.exports.MAX_PER_LIST = MAX_PER_LIST;
module.exports.MAX_TEXT = MAX_TEXT;
