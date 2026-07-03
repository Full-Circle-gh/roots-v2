'use strict';

// Channels & Delivery hub — tenant-facing API (Platform readiness — Phase 1).
//
// Powers the "Channels · 渠道" section of the Mini App Backend: a card per sales
// channel / logistics plugin, each with status, health, and a "Get help" escape
// hatch. The registry (lib/integrations/registry.js) is the source of truth;
// this router just exposes it to the admin UI under /api/retail-admin/channel-hub
// (a distinct prefix from retail.js's existing /integrations credential config).
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
const { getTenantCreds } = require('../lib/tenant-creds');
const relay = require('../lib/integrations/session-relay');

// Resolve the current tenant id from the auth context (Roots → 1).
function tenantId(req) { return (req.tenant && req.tenant.id) || 1; }

// Live status derivation for plugins whose truth lives in the tenant DATA plane
// (eleme_tokens, storefront_config, …) — which the control-plane registry can't
// see. Runs here where tdb() resolves the right connection. Only overrides a
// card that has no explicit lifecycle row (not_configured / configured); a
// wizard-set status (in_setup / connecting / connected / error / paused) wins.
function deriveStatuses(cards, cardsTenant) {
  const db = tdb();
  const isBaseline = s => s === 'not_configured' || s === 'configured';
  const readBool = (key) => {
    try {
      const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
      return row ? JSON.parse(row.value_json) === true : false;
    } catch (_) { return false; }
  };
  for (const c of cards) {
    if (!isBaseline(c.status)) continue;
    try {
      if (c.kind === 'eleme') {
        // Connected once any store has an Eleme access token; the channel is
        // "live" only when the operator has also switched it on.
        const tokens = db.prepare("SELECT COUNT(*) AS n FROM eleme_tokens WHERE access_token IS NOT NULL").get()?.n || 0;
        if (tokens > 0) c.status = readBool('eleme.enabled') ? 'connected' : 'paused';
      } else if (c.kind === 'jd') {
        // JD app keys present (env for Roots, tenant_secrets otherwise) → the
        // form is filled but untested. A passing "Save & test" writes a
        // connected row (which wins over this baseline); until then: configured.
        try {
          const jc = (getTenantCreds(cardsTenant).integrations || {}).jd || {};
          if (jc.appKey && jc.appSecret) c.status = 'configured';
        } catch (_) {}
      } else if (c.kind === 'meituan' || c.kind === 'qingyun') {
        // Session-based: derive from the login-relay per-store sessions.
        // any ok → connected; any expired → error; mid-flow → connecting.
        try {
          const sess = relay.summary(cardsTenant, c.kind);
          if (sess.length) {
            if (sess.some(s => s.status === 'expired')) c.status = 'error';
            else if (sess.some(s => s.status === 'ok')) c.status = 'connected';
            else if (sess.some(s => ['connecting', 'awaiting_sms', 'captcha'].includes(s.status))) c.status = 'connecting';
            else if (sess.some(s => s.status === 'failed')) c.status = 'error';
          }
        } catch (_) {}
      }
    } catch (_) { /* fresh/older DB — leave baseline */ }
  }
  return cards;
}

// ── Card grid ──────────────────────────────────────────────────────────────
// GET /api/retail-admin/integrations
// → { success, data: [cards], stores: [{code,name}] }
// `stores` feeds the per-store status pills on channel/logistics cards.
router.get('/api/retail-admin/channel-hub', requireRetailAdmin, (req, res) => {
  try {
    const cards = deriveStatuses(registry.listForTenant(tenantId(req)), tenantId(req));
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
// GET /api/retail-admin/channel-hub/:kind
router.get('/api/retail-admin/channel-hub/:kind', requireRetailAdmin, (req, res) => {
  try {
    const detail = registry.detailForTenant(tenantId(req), req.params.kind);
    if (!detail) return res.status(404).json({ success: false, error: 'unknown_integration' });
    res.json({ success: true, data: detail });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── "Get help" — the assisted-self-service escape hatch ─────────────────────
// POST /api/retail-admin/channel-hub/help  { kind, stepKey?, note?, lastError?, attempts? }
// Records the request (with the tenant's context) and best-effort pages platform ops.
router.post('/api/retail-admin/channel-hub/help', requireRetailAdmin, express.json(), (req, res) => {
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
// POST /api/retail-admin/channel-hub/:kind/todos/dismiss  { todoId }
// e.g. after the operator linked a new store by hand outside the wizard.
router.post('/api/retail-admin/channel-hub/:kind/todos/dismiss', requireRetailAdmin, express.json(), (req, res) => {
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

// ── Login relay (session-based channels: Meituan, Qingyun) — Phase 6 ────────
// The merchant can't paste a browser session into a form, so the worker drives
// the portal login and, when it SMS-challenges, the tenant types the code here
// and we relay it to the worker (lib/integrations/session-relay). Credentials
// are stored per-store via tenant-creds (never in the session table); the worker
// reads them there. In dev without a worker, INTEGRATION_RELAY_SIM=1 enables a
// simulation driver so the whole flow is demoable (code 000000).
const { setTenantSecret } = require('../lib/tenant-creds');

function assertRelayKind(kind) { if (!relay.RELAY_KINDS.has(kind)) { const e = new Error('not_a_relay_integration'); e.http = 400; throw e; } }

// Start a login attempt for one store. Stores the merchant credentials for that
// store, then kicks off the relay. Returns the resulting session snapshot.
router.post('/api/retail-admin/channel-hub/:kind/session/start', requireRetailAdmin, express.json(), (req, res) => {
  try {
    assertRelayKind(req.params.kind);
    const id = tenantId(req);
    const { storeCode, username, password } = req.body || {};
    if (!storeCode || !username || !password) return res.status(400).json({ success: false, error: 'store_credentials_required' });
    // Persist per-store credentials (meituan.<code>.user / .pass) — encrypted,
    // read by the worker at login time; never echoed back.
    setTenantSecret(id, `${req.params.kind}.${storeCode}.user`, username);
    setTenantSecret(id, `${req.params.kind}.${storeCode}.pass`, password);
    const s = relay.startLogin(id, req.params.kind, storeCode, { username, password });
    res.json({ success: true, session: publicSession(s) });
  } catch (e) { res.status(e.http || 500).json({ success: false, error: e.message }); }
});

// Relay an SMS code the tenant typed into the wizard.
router.post('/api/retail-admin/channel-hub/:kind/session/sms', requireRetailAdmin, express.json(), (req, res) => {
  try {
    assertRelayKind(req.params.kind);
    const { storeCode, code } = req.body || {};
    if (!storeCode || !code) return res.status(400).json({ success: false, error: 'store_code_and_code_required' });
    const s = relay.submitSms(tenantId(req), req.params.kind, storeCode, code);
    res.json({ success: true, session: publicSession(s) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// Poll all per-store sessions for a kind (the wizard long-polls this).
router.get('/api/retail-admin/channel-hub/:kind/session', requireRetailAdmin, (req, res) => {
  try {
    assertRelayKind(req.params.kind);
    res.json({ success: true, sessions: relay.summary(tenantId(req), req.params.kind) });
  } catch (e) { res.status(e.http || 500).json({ success: false, error: e.message }); }
});

function publicSession(s) {
  if (!s) return null;
  return { storeCode: s.store_code, status: s.status, phoneHint: s.phone_hint, lastError: s.last_error };
}

module.exports = router;
