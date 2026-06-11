// Imported product-page templates for the product editor.
//
// The editor ships built-in templates (PA_TEMPLATES in product-editor.html).
// These endpoints let an operator upload a template FILE (a Claude-authored
// design) and have it show up as a selectable card alongside the built-ins,
// shared across every operator. Stored in retail_page_templates.
//
// File format (JSON):
//   { "fc_template": 1,
//     "id": "bold_deli",                 // slug → products.page_template
//     "label_en": "...", "label_cn": "...",
//     "desc_en": "...",  "desc_cn": "...",
//     "blocks": [ { "type": "...", ... } ],   // same shape as page_blocks
//     "skin_css": ".pa-tpl-bold_deli { ... }" // optional CSS re-skin
//   }

const express = require('express');
// retail_page_templates is TENANT data-plane (cloned per tenant, no tenant_id
// column — isolated by DB file), so every query must go through the
// request-scoped tdb(), NOT the shared global db (which is always Roots). For
// Roots (tenant 1) tdb()===mainDb, so this is a no-op today; it closes the
// cross-tenant read/write leak before multi-tenant data isolation is enabled.
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

const router = express.Router();

// Built-in template ids — an upload may not shadow these.
const RESERVED_IDS = new Set(['editorial_light', 'quiet_minimal']);
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const MAX_SKIN_CSS = 120 * 1024;   // 120 KB of CSS is already generous

function rowToTemplate(r) {
  let blocks = [];
  try { blocks = JSON.parse(r.blocks || '[]'); } catch { blocks = []; }
  return {
    id: r.id,
    label_en: r.label_en, label_cn: r.label_cn,
    desc_en: r.desc_en || '', desc_cn: r.desc_cn || '',
    blocks: Array.isArray(blocks) ? blocks : [],
    skin_css: r.skin_css || '',
    custom: true,
    created_at: r.created_at,
  };
}

// List every imported template (the editor merges these into its chooser).
router.get('/api/retail-admin/page-templates', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    'SELECT * FROM retail_page_templates ORDER BY created_at DESC'
  ).all();
  res.json({ success: true, data: rows.map(rowToTemplate) });
});

// Import (create or overwrite by id) a template from an uploaded file.
router.post('/api/retail-admin/page-templates', requireRetailAdmin, express.json({ limit: '2mb' }), (req, res) => {
  const b = req.body || {};
  if (!b || b.fc_template == null) {
    return res.status(400).json({ success: false, error: 'not_a_template_file' });
  }
  const id = String(b.id || '').trim();
  if (!ID_RE.test(id)) {
    return res.status(400).json({ success: false, error: 'bad_id' });
  }
  if (RESERVED_IDS.has(id)) {
    return res.status(409).json({ success: false, error: 'id_reserved' });
  }
  const label_en = String(b.label_en || '').trim();
  const label_cn = String(b.label_cn || '').trim();
  if (!label_en || !label_cn) {
    return res.status(400).json({ success: false, error: 'label_required' });
  }
  if (!Array.isArray(b.blocks) || b.blocks.length === 0) {
    return res.status(400).json({ success: false, error: 'blocks_required' });
  }
  if (!b.blocks.every(x => x && typeof x === 'object' && typeof x.type === 'string')) {
    return res.status(400).json({ success: false, error: 'bad_blocks' });
  }
  const skin_css = typeof b.skin_css === 'string' ? b.skin_css : '';
  if (skin_css.length > MAX_SKIN_CSS) {
    return res.status(400).json({ success: false, error: 'skin_css_too_large' });
  }

  const createdBy = req.backendUser?.id ?? req.user?.id ?? null;
  tdb().prepare(`
    INSERT INTO retail_page_templates (id, label_en, label_cn, desc_en, desc_cn, blocks, skin_css, created_by)
    VALUES (@id, @label_en, @label_cn, @desc_en, @desc_cn, @blocks, @skin_css, @created_by)
    ON CONFLICT(id) DO UPDATE SET
      label_en = excluded.label_en, label_cn = excluded.label_cn,
      desc_en  = excluded.desc_en,  desc_cn  = excluded.desc_cn,
      blocks   = excluded.blocks,   skin_css = excluded.skin_css,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id, label_en, label_cn,
    desc_en: String(b.desc_en || '').trim(),
    desc_cn: String(b.desc_cn || '').trim(),
    blocks: JSON.stringify(b.blocks),
    skin_css,
    created_by: createdBy,
  });

  const row = tdb().prepare('SELECT * FROM retail_page_templates WHERE id = ?').get(id);
  res.json({ success: true, data: rowToTemplate(row) });
});

// Remove an imported template. Products already built from it keep their saved
// blocks — only the chooser card disappears.
router.delete('/api/retail-admin/page-templates/:id', requireRetailAdmin, (req, res) => {
  const info = tdb().prepare('DELETE FROM retail_page_templates WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true });
});

module.exports = router;
