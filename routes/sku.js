// SKU codes — the settings API behind Settings → SKU codes.
//
// The engine is two libraries: lib/sku-format.js renders a token pattern,
// lib/sku-rules.js decides which pattern applies and hands out the next number.
// This file is the door onto them: it reads and writes the tenant's rules, and
// answers "what would the next code be" for the material form's live preview.
//
// EVERYTHING GOES THROUGH tdb(). sku_rules / sku_counters / sku_settings carry
// no tenant_id column and are not on lib/tenant-db.js's CONTROL_PLANE_TABLES,
// so under data isolation they live in each tenant's own database. Reading them
// off the global handle would show every tenant Roots' numbering scheme and,
// worse, advance Roots' counters from another tenant's save. For Roots, tdb()
// IS the global handle, so nothing about the live install changes.

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const fmt = require('../lib/sku-format');
const rules = require('../lib/sku-rules');

const router = express.Router();

// Only entities lib/sku-rules.js knows how to number. A typo in a URL must not
// reach a query — the entity decides which TABLE the uniqueness check runs
// against, so it is validated before anything else happens.
function entityOr400(req, res) {
  const e = String(req.params.entity || '');
  if (!rules.ENTITIES[e]) {
    res.status(400).json({ success: false, error: 'unknown_entity', message: `No SKU rules for "${e}"` });
    return null;
  }
  return e;
}

// The two levels a material can be filed under, as the settings screen needs
// them: the KIND list is the editable lookup (categories WHERE kind='item_kind'),
// and each kind's categories are the DISTINCT values actually in use on the
// masterlist. Read from the catalogue rather than from a second list, so a
// category that exists on real materials can always be given a code — including
// one typed before any of this shipped.
function materialLevels(db) {
  let kinds = [];
  try {
    kinds = db.prepare("SELECT name FROM categories WHERE kind = 'item_kind' ORDER BY sort_order, name").all().map(r => r.name);
  } catch (_) { /* fresh DB */ }
  if (!kinds.length) kinds = ['food', 'packaging', 'equipment', 'retail', 'other'];

  const rows = db.prepare(
    `SELECT DISTINCT COALESCE(NULLIF(TRIM(item_kind), ''), 'food') AS kind, TRIM(category) AS category
       FROM ingredients
      WHERE category IS NOT NULL AND TRIM(category) <> ''
      ORDER BY kind, category`
  ).all();

  const byKind = {};
  for (const k of kinds) byKind[k] = [];
  for (const r of rows) {
    if (!byKind[r.kind]) byKind[r.kind] = [];
    if (!byKind[r.kind].includes(r.category)) byKind[r.kind].push(r.category);
  }
  return { kinds, byKind };
}

// How many materials each rule currently governs. The settings screen shows it
// beside the rule so an operator can see that "Dried fruits · B" is not a rule
// about nothing — a scheme built against categories that no longer exist is the
// failure mode this number makes visible.
function ruleCounts(db, entity) {
  if (entity !== 'material') return {};
  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(item_kind), ''), 'food') AS kind,
            COALESCE(TRIM(category), '') AS category,
            COUNT(*) AS n
       FROM ingredients
      GROUP BY kind, category`
  ).all();
  const out = {};
  for (const r of rows) out[r.kind.toLowerCase() + '|' + r.category.toLowerCase()] = r.n;
  return out;
}

// ═══ Read the whole settings screen in one call ════════════════════════════
router.get('/api/retail-admin/sku/:entity', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const db = tdb();
  const list = rules.listRules(db, entity);
  const counts = ruleCounts(db, entity);
  const conf = rules.ENTITIES[entity];

  res.json({
    success: true,
    entity,
    label: { en: conf.label_en, cn: conf.label_cn },
    settings: rules.getSettings(db, entity),
    tokens: fmt.tokenCatalogue(),
    levels: entity === 'material' ? materialLevels(db) : { kinds: [], byKind: {} },
    rules: list.map(r => {
      const cat = String(r.category || '').toLowerCase();
      const sub = String(r.subcategory || '').toLowerCase();
      return {
        ...r,
        scope: sub ? 'subcategory' : (cat ? 'category' : 'default'),
        // Next code this rule would issue, so the screen shows the real thing
        // rather than a hypothetical one.
        next_seq: rules.peekSeq(db, entity, r),
        // A subcategory rule governs one category; a category rule governs
        // everything under it that has no rule of its own; the default governs
        // whatever is left, which nothing can count cheaply — hence null.
        in_use: sub ? (counts[cat + '|' + sub] || 0)
          : (cat ? Object.keys(counts).filter(k => k.startsWith(cat + '|')).reduce((a, k) => a + counts[k], 0) : null),
      };
    }),
  });
});

// ═══ Master switch ═════════════════════════════════════════════════════════
router.put('/api/retail-admin/sku/:entity/settings', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const enabled = !!(req.body && req.body.enabled);
  res.json({ success: true, settings: rules.setSettings(tdb(), entity, { enabled }) });
});

// ═══ Rules ═════════════════════════════════════════════════════════════════
// Upsert, keyed by (category, subcategory) rather than by id — the screen edits
// a scope, and saving the same scope twice must not leave two rules disagreeing
// about how one category is numbered.
router.post('/api/retail-admin/sku/:entity/rules', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const out = rules.saveRule(tdb(), entity, req.body || {});
  if (!out.ok) return res.status(400).json({ success: false, ...out });
  res.json({ success: true, id: out.id, warnings: out.warnings || [] });
});

router.delete('/api/retail-admin/sku/:entity/rules/:id', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const out = rules.deleteRule(tdb(), entity, Number(req.params.id));
  if (!out.ok) return res.status(404).json({ success: false, ...out });
  res.json({ success: true, reset: !!out.reset });
});

// ═══ Previews ══════════════════════════════════════════════════════════════
// A pattern being TYPED in the settings screen, rendered against sample values.
// Nothing is stored and no counter moves — this is the line under the field
// that shows what the operator is building.
router.post('/api/retail-admin/sku/:entity/pattern-preview', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const b = req.body || {};
  const v = fmt.validate(b.pattern || '');
  res.json({
    success: true,
    valid: v.ok,
    errors: v.errors,
    warnings: v.warnings,
    samples: [1, 2, 47].map(seq => fmt.render(b.pattern || '', {
      seq,
      categoryCode: b.category_code || '',
      subcategoryCode: b.subcategory_code || '',
      name: b.name || 'Dried Mango',
    })),
  });
});

// What a material saved RIGHT NOW with this filing would be given. The material
// form calls it as the operator picks a kind and a category, and shows the
// answer greyed-out in the SKU field.
//
// READ-ONLY BY DESIGN: it peeks, it never claims. An operator who opens the New
// material form, changes their mind about the category four times and then
// closes it has burned no codes — the number is taken at save, by the create
// route, and only if the field is still empty.
router.get('/api/retail-admin/sku/:entity/next', requireRetailAdmin, (req, res) => {
  const entity = entityOr400(req, res);
  if (!entity) return;
  const q = req.query || {};
  const out = rules.peek(tdb(), entity, {
    category: q.category || '',
    subcategory: q.subcategory || '',
    name: q.name || '',
  });
  res.json({ success: true, ...out });
});

module.exports = router;
