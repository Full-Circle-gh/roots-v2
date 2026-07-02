'use strict';

// Channels & Delivery hub — tenant-facing API (Platform readiness — Phase 1).
//
// Powers the "Channels · 渠道" section of the Mini App Backend: a card per sales
// channel / logistics plugin, each with status, health, and a "Get help" escape
// hatch. The registry (lib/integrations/registry.js) is the source of truth;
// this router just exposes it to the admin UI under /api/retail-admin/integrations.
//
// Phase 1 is intentionally read-mostly: cards render live from the registry, and
// help requests are captured. The per-plugin setup wizards (connect, map, verify)
// land in later phases and will POST their own status transitions via the
// registry's upsertStatus().

const express = require('express');
const router = express.Router();

const { requireRetailAdmin } = require('./retail');
const { tdb } = require('../lib/tenant-db');
const registry = require('../lib/integrations/registry');
const { sendPlatformAlert } = require('../lib/platform-alert');

// Resolve the current tenant id from the auth context (Roots → 1).
function tenantId(req) { return (req.tenant && req.tenant.id) || 1; }

// ── Card grid ──────────────────────────────────────────────────────────────
// GET /api/retail-admin/integrations
// → { success, data: [cards], stores: [{code,name}] }
// `stores` feeds the per-store status pills on channel/logistics cards.
router.get('/api/retail-admin/integrations', requireRetailAdmin, (req, res) => {
  try {
    const cards = registry.listForTenant(tenantId(req));
    let stores = [];
    try {
      stores = tdb().prepare(
        'SELECT code, name_en AS name FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id'
      ).all();
    } catch (_) { stores = []; }
    res.json({ success: true, data: cards, stores });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── One plugin's detail (wizard skeleton + saved progress) ──────────────────
// GET /api/retail-admin/integrations/:kind
router.get('/api/retail-admin/integrations/:kind', requireRetailAdmin, (req, res) => {
  try {
    const detail = registry.detailForTenant(tenantId(req), req.params.kind);
    if (!detail) return res.status(404).json({ success: false, error: 'unknown_integration' });
    res.json({ success: true, data: detail });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── "Get help" — the assisted-self-service escape hatch ─────────────────────
// POST /api/retail-admin/integrations/help  { kind, stepKey?, note?, lastError?, attempts? }
// Records the request (with the tenant's context) and best-effort pages platform ops.
router.post('/api/retail-admin/integrations/help', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const id = tenantId(req);
    const { kind, stepKey, note, lastError, attempts } = req.body || {};
    if (!kind || !registry.getDescriptor(kind)) {
      return res.status(400).json({ success: false, error: 'unknown_integration' });
    }
    const row = registry.createHelpRequest(id, { kind, stepKey, note, lastError, attempts });
    const tName = (req.tenant && (req.tenant.name || req.tenant.slug)) || `tenant #${id}`;
    const where = stepKey ? ` · step ${stepKey}` : '';
    sendPlatformAlert(`🆘 Integration help — ${tName} · ${kind}${where}${note ? ` — "${String(note).slice(0, 120)}"` : ''}`)
      .catch(() => {});
    res.json({ success: true, data: { id: row.id, status: row.status } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Dismiss a card to-do ─────────────────────────────────────────────────────
// POST /api/retail-admin/integrations/:kind/todos/dismiss  { todoId }
// e.g. after the operator linked a new store by hand outside the wizard.
router.post('/api/retail-admin/integrations/:kind/todos/dismiss', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const { todoId } = req.body || {};
    if (!todoId) return res.status(400).json({ success: false, error: 'todo_id_required' });
    const ok = registry.dismissTodo(tenantId(req), req.params.kind, String(todoId));
    if (!ok) return res.status(404).json({ success: false, error: 'todo_not_found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
