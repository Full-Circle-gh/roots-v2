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
const { getTenantCreds, credsStatus, setTenantSecret, invalidate: invalidateCreds, KEYS: CRED_KEYS } = require('../lib/tenant-creds');
const relay = require('../lib/integrations/session-relay');
const onboarding = require('../lib/onboarding-steps');
const mainDb = require('../database');

// Resolve the current tenant id from the auth context (Roots → 1).
function tenantId(req) { return (req.tenant && req.tenant.id) || 1; }

// Live status derivation for plugins whose truth lives in the tenant DATA plane
// (eleme_tokens, storefront_config, …) — which the control-plane registry can't
// see. Runs here where tdb() resolves the right connection. Only overrides a
// card that has no explicit lifecycle row (not_configured / configured); a
// wizard-set status (in_setup / connecting / connected / error / paused) wins.
// Is a session-based channel already live via the LEGACY path (env credentials
// + the standing scraper daemon), i.e. set up before the self-service relay
// existed? Roots is the case that matters: its Meituan/Qingyun run off env creds
// and write daemon activity, but have no integration_sessions row. Signals, any
// of which means "connected": daemon sync activity in this tenant's DB, or the
// channel's credentials being present. All reads are defensive (older/fresh DBs
// may lack a table).
function legacyChannelLive(db, tenantId, kind) {
  const count = (sql) => { try { return db.prepare(sql).get()?.n || 0; } catch (_) { return 0; } };
  if (kind === 'meituan') {
    if (count('SELECT COUNT(*) AS n FROM store_business_status') > 0) return true;
    if (count("SELECT COUNT(*) AS n FROM meituan_sync_log WHERE status = 'ok'") > 0) return true;
    try {
      const m = (getTenantCreds(tenantId).integrations || {}).meituan || {};
      if ((m.tianhe && m.tianhe.user) || (m.yuexiu && m.yuexiu.user)) return true;
    } catch (_) {}
    return false;
  }
  if (kind === 'qingyun') {
    if (count('SELECT COUNT(*) AS n FROM qingyun_status WHERE logged_in = 1') > 0) return true;
    if (count('SELECT COUNT(*) AS n FROM delivery_jobs') > 0) return true;
    return false;
  }
  return false;
}

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
      } else if (c.kind === 'wechat_miniapp') {
        // Mini App truth = WeChat login + Pay readiness (credsStatus booleans),
        // falling back to onboarding progress for the "started but not live" state.
        try {
          const cs = credsStatus(cardsTenant);
          if (cs.wechatLoginReady && cs.payReady) c.status = 'connected';
          else if (cs.wxAppIdSet || miniappStarted(cardsTenant)) c.status = 'in_setup';
        } catch (_) {}
      } else if (c.kind === 'meituan' || c.kind === 'qingyun') {
        // Session-based: derive from the login-relay per-store sessions (new
        // self-service flow). any ok → connected; any expired → error;
        // mid-flow → connecting.
        try {
          const sess = relay.summary(cardsTenant, c.kind);
          if (sess.length) {
            if (sess.some(s => s.status === 'expired')) c.status = 'error';
            else if (sess.some(s => s.status === 'ok')) c.status = 'connected';
            else if (sess.some(s => ['connecting', 'awaiting_sms', 'captcha'].includes(s.status))) c.status = 'connecting';
            else if (sess.some(s => s.status === 'failed')) c.status = 'error';
          } else if (legacyChannelLive(db, cardsTenant, c.kind)) {
            // No relay session, but the tenant already runs this channel the
            // LEGACY way (env creds + the standing daemon — e.g. Roots). Reflect
            // that it's connected rather than falsely inviting a re-setup.
            c.status = 'connected';
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

// ── Mini App (WeChat) — interactive onboarding checklist — Phase 8 ─────────
// The A-to-Z a tenant completes before their mini app takes live orders is
// already modelled in lib/onboarding-steps + tenant_onboarding (platform-driven
// via saas-admin). This surfaces the SAME checklist tenant-facing as the Mini
// App card so a self-service (Model A) tenant sees one place for everything,
// with live credential verification (credsStatus booleans) — no duplicate model.

// Any onboarding progress recorded for a tenant → the checklist has been started.
function miniappStarted(tenantId) {
  try {
    const n = mainDb.prepare("SELECT COUNT(*) AS n FROM tenant_onboarding WHERE tenant_id = ? AND status NOT IN ('pending','na')").get(Number(tenantId))?.n || 0;
    return n > 0;
  } catch (_) { return false; }
}

function tenantOnboarding(tenantId) {
  const t = mainDb.prepare('SELECT id, onboarding_model, business_category FROM tenants WHERE id = ?').get(Number(tenantId)) || {};
  const rows = mainDb.prepare('SELECT step_key, status, value FROM tenant_onboarding WHERE tenant_id = ?').all(Number(tenantId));
  const state = {};
  for (const r of rows) state[r.step_key] = { status: r.status, value: r.value };
  const model = t.onboarding_model === 'managed' ? 'managed' : 'self';
  const phases = onboarding.resolveChecklist(model, t.business_category, state);
  return { model, phases, progress: onboarding.progress(phases) };
}

// GET the tenant's own mini-app checklist + live credential status.
router.get('/api/retail-admin/channel-hub/miniapp/checklist', requireRetailAdmin, (req, res) => {
  try {
    const id = tenantId(req);
    const ob = tenantOnboarding(id);
    let creds = null;
    try { creds = credsStatus(id); } catch (_) {}
    res.json({ success: true, model: ob.model, progress: ob.progress, phases: ob.phases, creds });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Advance one checklist step the tenant OWNS (owner resolves to 'tenant'). Steps
// owned by us / WeChat are read-only here — platform / external process drives
// them (preserves the managed-model + waiting-external semantics).
router.patch('/api/retail-admin/channel-hub/miniapp/step', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const id = tenantId(req);
    const { stepKey, status, value } = req.body || {};
    if (!stepKey) return res.status(400).json({ success: false, error: 'step_key_required' });
    if (!onboarding.STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'bad_status' });
    // Confirm the step exists AND is tenant-owned in this tenant's resolved checklist.
    const ob = tenantOnboarding(id);
    let step = null;
    for (const p of ob.phases) for (const s of p.steps) if (s.key === stepKey) step = s;
    if (!step) return res.status(404).json({ success: false, error: 'unknown_step' });
    if (step.owner !== 'tenant') return res.status(403).json({ success: false, error: 'step_not_tenant_owned' });
    mainDb.prepare(`
      INSERT INTO tenant_onboarding (tenant_id, step_key, status, value, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, step_key) DO UPDATE SET status = excluded.status, value = COALESCE(excluded.value, tenant_onboarding.value), updated_at = CURRENT_TIMESTAMP
    `).run(id, stepKey, status, value != null ? String(value) : null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Save the tenant's WeChat Mini Program AppID + AppSecret, then LIVE-VERIFY them
// against WeChat (minting a stable_token = the creds are valid). Self-service
// equivalent of the platform PUT /credentials for the login half. Roots is
// configured from server env, so it's read-only here. Pay certs (cert files)
// stay on the managed/platform path — this covers login readiness.
router.post('/api/retail-admin/channel-hub/miniapp/wechat-creds', requireRetailAdmin, express.json(), async (req, res) => {
  try {
    const id = tenantId(req);
    if (getTenantCreds(id).source === 'env') return res.status(400).json({ success: false, error: 'managed_via_env' });
    const appId = String((req.body || {}).appId || '').trim();
    const appSecret = String((req.body || {}).appSecret || '').trim();
    if (!/^wx[0-9a-zA-Z]{16}$/.test(appId)) return res.status(400).json({ success: false, error: 'bad_appid' });
    if (!appSecret) return res.status(400).json({ success: false, error: 'app_secret_required' });
    const clash = mainDb.prepare('SELECT id FROM tenants WHERE wx_appid = ? AND id != ?').get(appId, id);
    if (clash) return res.status(409).json({ success: false, error: 'appid_taken' });
    // Persist: AppID on the tenant row, secret encrypted in tenant_secrets.
    mainDb.prepare('UPDATE tenants SET wx_appid = ? WHERE id = ?').run(appId, id);
    setTenantSecret(id, CRED_KEYS.WX_APP_SECRET, appSecret);
    invalidateCreds(id);
    // Live-verify: a successful token mint proves the AppID+secret pair.
    let verified = false, verr = null;
    try {
      const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: false }),
      });
      const j = await r.json().catch(() => ({}));
      verified = !!j.access_token;
      if (!verified) verr = j.errmsg || ('errcode ' + j.errcode);
    } catch (e) { verr = e.message; }
    res.json({ success: true, verified, error: verr, creds: credsStatus(id) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
