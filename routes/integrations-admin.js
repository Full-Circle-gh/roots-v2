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
const fs = require('fs');
const path = require('path');

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

// Eleme is browser-automation (session cookies on disk), not OAuth — see
// lib/eleme-browser.js and ELEME_BROWSER_RECON.md (the OpenAPI/OAuth path is
// dead; single-store accounts are rejected by Eleme's open platform). A store
// counts as "logged in" once its session file exists, the same signal
// scripts/eleme-login.js writes and lib/eleme-browser.js restores from.
function elemeSessionCount(db) {
  try {
    const codes = db.prepare("SELECT store_code FROM eleme_shops WHERE shop_id IS NOT NULL AND shop_id <> ''").all().map(r => r.store_code);
    const dir = path.join(__dirname, '..', 'data', 'eleme-sessions');
    return codes.filter(c => fs.existsSync(path.join(dir, `${c}-session.json`))).length;
  } catch (_) { return 0; }
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
  // Session-based channels (meituan/qingyun): a wizard-set in_setup/connecting
  // row must not mask a channel that is demonstrably LIVE (e.g. Roots requested
  // a box while its daemons were already syncing the legacy way). Those two
  // states re-enter derivation; explicit connected/paused/error still win.
  const wizardStale = s => s === 'in_setup' || s === 'connecting';
  for (const c of cards) {
    const sessionKind = c.kind === 'meituan' || c.kind === 'qingyun';
    if (!isBaseline(c.status) && !(sessionKind && wizardStale(c.status))) continue;
    try {
      if (c.kind === 'eleme') {
        // Session-based (browser automation, not OAuth): "configured" once a
        // store is linked to an Eleme shop id; "connected"/"paused" once at
        // least one of those stores also has a saved login session, gated on
        // whether the operator has switched the channel on.
        const shopsMapped = db.prepare("SELECT COUNT(*) AS n FROM eleme_shops WHERE shop_id IS NOT NULL AND shop_id <> ''").get()?.n || 0;
        if (elemeSessionCount(db) > 0) c.status = readBool('eleme.enabled') ? 'connected' : 'paused';
        else if (shopsMapped > 0) c.status = 'configured';
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

// ── Store-box request (Meituan / Qingyun assisted setup) ────────────────────
// POST /api/retail-admin/channel-hub/:kind/box-request
// Step 1 of Meituan setup is a real physical box we ship to the merchant (it
// makes their channel logins come from their own shop's internet). This records
// the request on the integration row (config.box) so the wizard remembers it
// across reloads, moves the card to in_setup, and pages platform ops to arrange
// shipping + any cost with the merchant. Idempotent: repeat clicks don't re-page.
router.post('/api/retail-admin/channel-hub/:kind/box-request', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const kind = req.params.kind;
    if (kind !== 'meituan' && kind !== 'qingyun') return res.status(400).json({ success: false, error: 'no_box_for_kind' });
    const id = tenantId(req);
    const cur = registry.detailForTenant(id, kind);
    if (!cur) return res.status(400).json({ success: false, error: 'unknown_integration' });
    const config = cur.config || {};
    if (config.box && config.box.status) return res.json({ success: true, box: config.box, already: true });
    config.box = { status: 'requested', requested_at: new Date().toISOString() };
    // Only nudge the lifecycle forward from the untouched states — never yank a
    // connected/paused channel back to in_setup.
    const status = (cur.status === 'not_configured' || cur.status === 'configured') ? 'in_setup' : cur.status;
    registry.upsertStatus(id, kind, { status, config });
    const tName = (req.tenant && (req.tenant.name || req.tenant.slug)) || `tenant #${id}`;
    const note = String((req.body || {}).note || '').slice(0, 200);
    sendPlatformAlert(`📦 Store-box request — ${tName} · ${kind}${note ? ` — "${note}"` : ''} (arrange shipping + cost)`)
      .catch(() => {});
    res.json({ success: true, box: config.box });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

// A timestamp out of meituan_sync_log / store_business_status, as epoch ms.
// SQLite writes these without a zone; they are UTC, so say so before parsing.
const mtUtc = (t) => (t ? Date.parse(String(t).replace(' ', 'T') + (String(t).includes('Z') ? '' : 'Z')) || 0 : 0);

/* IS THIS STORE'S MEITUAN SESSION WORKING? Lifted out of the route handler and
   exported, so the decision can be exercised over the shapes that actually
   occur without standing a database up to hold them. The handler does the
   reading; this does the deciding, and nothing here touches a db handle.

   Returns { signedIn, issue }. signedIn is null for a store that has never
   connected — no activity either way — which is not the same answer as false.

   Order matters and is the whole fix; see the comments at each branch. */
function decideMeituanSignedIn({ bindingLost, sess, lastLoginErr, lastOkAny }) {
  let signedIn = null;
  // A LOST BINDING SETTLES IT FIRST. It is a positive assertion from a real
  // bound call failing, while a relay `ok` only says a session exists and says
  // nothing about which 门店 it points at — so the two are not rival answers to
  // one question, and the latch is the more specific fact. A store reporting
  // "Signed in" while unbound is the whole defect. It fires only where a daemon
  // actually wrote the latch, so a relay-only tenant (no daemon, no such rows)
  // reads exactly as it did before.
  if (bindingLost) signedIn = false;
  else if (sess && sess.status === 'ok') signedIn = true;
  else if (sess && (sess.status === 'expired' || sess.status === 'failed')) signedIn = false;
  else {
    const errAt = lastLoginErr ? mtUtc(lastLoginErr.created_at) : 0;
    // store_business_status IS DELIBERATELY NOT PART OF THIS CLOCK. Its read
    // posts only the `wmPoiId` cookie to /common/businessStatus — see
    // getBusinessStatus in lib/meituan-browser.js, which sends no acctId and no
    // region — so it keeps answering 200/code:0 straight through a binding
    // loss, and through some sign-out states too. Folding read_at in here made
    // a store look freshly OK on the strength of the one read that proves the
    // least, and meant no error could ever stay newer than it. The timestamp is
    // still reported as `checkedAt`, where it says what it actually is: when we
    // last asked, not evidence that anything works.
    const okAt = lastOkAny ? mtUtc(lastOkAny.created_at) : 0;
    if (errAt && errAt > okAt) signedIn = false;
    else if (okAt) signedIn = true;
  }
  // A lost binding NAMES ITSELF rather than borrowing needs_login's word: the
  // remedy is different — scan the QR and then RE-SELECT the store — and a row
  // that says "signed out" sends staff to do the half they have already done.
  // `binding_lost` is a new value for this field; no renderer of this endpoint
  // ships in the repo yet, so nothing needs updating alongside, but a future
  // one must handle it.
  const issue = signedIn === false
    ? (bindingLost ? 'binding_lost' : (lastLoginErr ? lastLoginErr.event_type : null))
    : null;
  return { signedIn, issue };
}

// ── Meituan per-store connection detail ──────────────────────────────────────
// GET /api/retail-admin/channel-hub/meituan/stores
// Feeds the Meituan "Configure" page: for each active store, is the Meituan
// session signed in, which account it uses (masked — never the secret), and the
// live proof it's working (last stock push, last order import, mapped products).
// Signals come from what the daemons already write: meituan_sync_log (ok events
// vs needs_login/verify_required errors, and the binding_lost/binding_cleared
// latch), store_business_status (is_open/status_desc, and read_at as `checkedAt`
// only — it does NOT vote on signed-in; see the okAt comment below),
// meituan_order_import, meituan_product_map — plus relay sessions for
// self-service tenants. Infra internals (proxy, cookies, daemons) deliberately
// stay platform-side; this endpoint only reports outcomes.
router.get('/api/retail-admin/channel-hub/meituan/stores', requireRetailAdmin, (req, res) => {
  try {
    const id = tenantId(req);
    const db = tdb();
    const get1 = (sql, ...args) => { try { return db.prepare(sql).get(...args) || null; } catch (_) { return null; } };
    let stores = [];
    try {
      stores = db.prepare(
        'SELECT code, name_en AS name, name_cn AS nameCn FROM retail_stores WHERE is_active = 1 ORDER BY sort_order, id'
      ).all();
    } catch (_) {}
    let mtCreds = {};
    try { mtCreds = (getTenantCreds(id).integrations || {}).meituan || {}; } catch (_) {}
    const sessions = {};
    try { for (const s of relay.summary(id, 'meituan')) sessions[s.storeCode] = s; } catch (_) {}
    // "138****56" — enough to recognise which Meituan account, never the secret.
    const mask = (u) => {
      const s = String(u || '').trim();
      if (!s) return null;
      return s.length <= 4 ? s.slice(0, 1) + '***' : s.slice(0, 3) + '****' + s.slice(-2);
    };

    const data = stores.map((s) => {
      const code = s.code;
      const biz = get1('SELECT is_open, status_desc, read_ok, read_at FROM store_business_status WHERE store_code = ?', code);
      const lastPush = get1("SELECT created_at FROM meituan_sync_log WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok' ORDER BY id DESC LIMIT 1", code);
      const lastOkAny = get1("SELECT created_at FROM meituan_sync_log WHERE store_code = ? AND status = 'ok' ORDER BY id DESC LIMIT 1", code);
      const lastLoginErr = get1("SELECT event_type, created_at FROM meituan_sync_log WHERE store_code = ? AND status = 'error' AND event_type IN ('needs_login','verify_required') ORDER BY id DESC LIMIT 1", code);
      // THE STORE-BINDING LATCH. A Meituan session can stay AUTHENTICATED and
      // still lose the acctId/region context that every stock write and order
      // read needs — so the store is "signed in" and useless. That is the exact
      // state this row exists to make visible, and the one it could not report:
      // the daemon has detected it since the 2026-07-09 outage and pages ops for
      // it, and this endpoint read neither event.
      //
      // READ AS A LATCH, not as another entry in the error filter above. Adding
      // 'binding_lost' to that filter would leave it racing `lastOkAny`, which
      // is ANY ok event — and the daemon writes twelve kinds, of which
      // poll_paused, poll_resumed, proxy_elected, proxy_up, queue_resumed and
      // browser_recovered all keep firing while the binding is still gone. The
      // first one to land would put the store back to "Signed in" with nothing
      // restored: the same defect wearing a different clock.
      //
      // The pair strictly alternates, so the newer of the two IS the current
      // state. scripts/meituan-daemon.js noteBindingResult() writes
      // `binding_lost` once per episode (guarded on !alerts[latch], after the
      // loss persists past BINDING_ALERT_AFTER_MS) and `binding_cleared` only
      // where it had alerted.
      const lastBinding = get1("SELECT event_type FROM meituan_sync_log WHERE store_code = ? AND event_type IN ('binding_lost','binding_cleared') ORDER BY id DESC LIMIT 1", code);
      const bindingLost = !!(lastBinding && lastBinding.event_type === 'binding_lost');
      const lastOrder = get1('SELECT imported_at FROM meituan_order_import WHERE store_code = ? ORDER BY id DESC LIMIT 1', code);
      const ordersToday = get1("SELECT COUNT(*) AS n FROM meituan_order_import WHERE store_code = ? AND date(imported_at) = date('now')", code);
      // "Live" = matched to a real Meituan listing (meituan_name present) AND
      // sync on — the only rows whose stock actually pushes. Rows with the sync
      // toggle on but no match are frozen, so they count as "not matched", not
      // as syncing. Same ruler as the Meituan tab's "N live".
      const live = get1("SELECT COUNT(*) AS n FROM meituan_product_map WHERE store_code = ? AND sync_enabled = 1 AND meituan_name IS NOT NULL AND TRIM(meituan_name) <> ''", code);
      const enabled = get1('SELECT COUNT(*) AS n FROM meituan_product_map WHERE store_code = ? AND sync_enabled = 1', code);

      // Signed in? Decided by decideMeituanSignedIn() above, which is where the
      // ordering and its reasons are written down.
      const { signedIn, issue } = decideMeituanSignedIn({
        bindingLost, sess: sessions[code], lastLoginErr, lastOkAny,
      });
      const creds = mtCreds[code] || {};
      return {
        code,
        name: s.name || code,
        nameCn: s.nameCn || s.name || code,
        account: mask(creds.user),
        signedIn,
        issue,
        checkedAt: (biz && biz.read_at) || null,
        open: biz && biz.read_ok ? biz.is_open === 1 : null,
        statusDesc: biz ? biz.status_desc : null,
        lastStockPush: lastPush ? lastPush.created_at : null,
        lastOrder: lastOrder ? lastOrder.imported_at : null,
        ordersToday: ordersToday ? ordersToday.n : 0,
        liveProducts: live ? live.n : 0,
        notMatched: Math.max(0, (enabled ? enabled.n : 0) - (live ? live.n : 0)),
      };
    });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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

// GET the Mini App credential picture for the config page. Non-secret values
// (AppID, merchant id, cert serial) come back as plain text so the fields
// pre-fill; secrets come back only as booleans (set / not set) — never their
// values. For the env-managed tenant (Roots) this is populated from the server
// env, so the page looks the same as a self-serve tenant's, just already filled.
router.get('/api/retail-admin/channel-hub/miniapp/wechat-config', requireRetailAdmin, (req, res) => {
  try {
    const id = tenantId(req);
    const c = getTenantCreds(id);
    res.json({
      success: true,
      source: c.source,
      appId: c.wechat.appId || '',
      appSecretSet: !!c.wechat.appSecret,
      pay: {
        mchId: c.pay.mchId || '',
        serialNo: c.pay.serialNo || '',
        apiV3KeySet: !!c.pay.apiV3Key,
        privateKeySet: !!c.pay.privateKey,
        platformPubKeySet: !!c.pay.platformPubKey,
      },
      status: credsStatus(id),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Save Mini App credentials — Mini Program (AppID + AppSecret) AND WeChat Pay
// (merchant id, API v3 key, merchant private key [pasted PEM], cert serial,
// platform public key). Only fields actually provided are written, so a blank
// (masked) secret means "keep the existing one". After saving, the login pair is
// LIVE-VERIFIED against WeChat (a stable_token mint == valid AppID+secret).
//
// The env-managed tenant (Roots) reads its creds from the server .env, so we
// don't persist edits here (that would silently no-op against the env carve-out);
// instead we live-verify the existing env creds and report success — the page
// already shows everything filled in, so nothing needs changing.
router.post('/api/retail-admin/channel-hub/miniapp/wechat-creds', requireRetailAdmin, express.json(), async (req, res) => {
  try {
    const id = tenantId(req);
    const b = req.body || {};
    const isEnv = getTenantCreds(id).source === 'env';
    const str = (k) => String(b[k] == null ? '' : b[k]).trim();

    if (!isEnv) {
      const appId = str('appId');
      if (appId) {
        if (!/^wx[0-9a-zA-Z]{16}$/.test(appId)) return res.status(400).json({ success: false, error: 'bad_appid' });
        const clash = mainDb.prepare('SELECT id FROM tenants WHERE wx_appid = ? AND id != ?').get(appId, id);
        if (clash) return res.status(409).json({ success: false, error: 'appid_taken' });
        mainDb.prepare('UPDATE tenants SET wx_appid = ? WHERE id = ?').run(appId, id);
      }
      // Persist each provided secret; blank = leave the stored one alone.
      const setIf = (key, val) => { if (val) setTenantSecret(id, key, val); };
      setIf(CRED_KEYS.WX_APP_SECRET, str('appSecret'));
      setIf(CRED_KEYS.PAY_MCH_ID, str('mchId'));
      setIf(CRED_KEYS.PAY_API_V3_KEY, str('apiV3Key'));
      setIf(CRED_KEYS.PAY_PRIVATE_KEY, str('privateKey'));
      setIf(CRED_KEYS.PAY_SERIAL_NO, str('serialNo'));
      setIf(CRED_KEYS.PAY_PLATFORM_PUB_KEY, str('platformPubKey'));
      invalidateCreds(id);
    }

    // Live-verify the login pair (appid+secret) currently in effect.
    const eff = getTenantCreds(id).wechat;
    let verified = false, verr = null;
    if (eff.appId && eff.appSecret) {
      try {
        const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credential', appid: eff.appId, secret: eff.appSecret, force_refresh: false }),
        });
        const j = await r.json().catch(() => ({}));
        verified = !!j.access_token;
        if (!verified) verr = j.errmsg || ('errcode ' + j.errcode);
      } catch (e) { verr = e.message; }
    } else {
      verr = 'app_id_or_secret_missing';
    }
    res.json({ success: true, verified, error: verr, envManaged: isEnv, creds: credsStatus(id) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Save + live-verify the WeChat Pay credentials — the setup wizard's step-3
// check. Persists any provided pay fields (same keep-if-blank semantics as
// wechat-creds), then makes a REAL signed request to WeChat Pay
// (GET /v3/certificates): if WeChat accepts the signature, the merchant id,
// certificate serial and private key are all correct together. When the
// response carries an encrypted platform certificate we also try to decrypt it
// with the API v3 key, which proves that key too (v3KeyOk: true/false/null —
// null = nothing to decrypt, e.g. platform-public-key accounts).
const wxpCrypto = require('crypto');
router.post('/api/retail-admin/channel-hub/miniapp/wechat-pay-verify', requireRetailAdmin, express.json(), async (req, res) => {
  try {
    const id = tenantId(req);
    const b = req.body || {};
    const isEnv = getTenantCreds(id).source === 'env';
    const str = (k) => String(b[k] == null ? '' : b[k]).trim();

    if (!isEnv) {
      const setIf = (key, val) => { if (val) setTenantSecret(id, key, val); };
      setIf(CRED_KEYS.PAY_MCH_ID, str('mchId'));
      setIf(CRED_KEYS.PAY_API_V3_KEY, str('apiV3Key'));
      setIf(CRED_KEYS.PAY_PRIVATE_KEY, str('privateKey'));
      setIf(CRED_KEYS.PAY_SERIAL_NO, str('serialNo'));
      setIf(CRED_KEYS.PAY_PLATFORM_PUB_KEY, str('platformPubKey'));
      invalidateCreds(id);
    }

    const pay = getTenantCreds(id).pay;
    const missing = [];
    if (!pay.mchId) missing.push('mchId');
    if (!pay.serialNo) missing.push('serialNo');
    if (!pay.privateKey) missing.push('privateKey');
    if (missing.length) return res.json({ success: true, verified: false, v3KeyOk: null, error: 'missing_fields', missing });

    // Sign GET /v3/certificates per the v3 spec (empty body for GET).
    const urlPath = '/v3/certificates';
    let auth;
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonceStr = wxpCrypto.randomBytes(16).toString('hex');
      const message = ['GET', urlPath, timestamp, nonceStr, ''].join('\n') + '\n';
      const signature = wxpCrypto.createSign('RSA-SHA256').update(message).sign(pay.privateKey, 'base64');
      auth = 'WECHATPAY2-SHA256-RSA2048 ' +
        `mchid="${pay.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${pay.serialNo}",signature="${signature}"`;
    } catch (_) {
      return res.json({ success: true, verified: false, v3KeyOk: null, error: 'bad_private_key' });
    }

    let verified = false, verr = null, v3KeyOk = null;
    try {
      const resp = await fetch('https://api.mch.weixin.qq.com' + urlPath, {
        headers: { 'Accept': 'application/json', 'Authorization': auth, 'User-Agent': 'roots-v2-pay-verify' },
      });
      const j = await resp.json().catch(() => ({}));
      verified = resp.status === 200;
      if (!verified) verr = (j.message || j.code || ('HTTP ' + resp.status));
      // Prove the API v3 key by decrypting the first platform certificate.
      const enc = verified && Array.isArray(j.data) && j.data[0] && j.data[0].encrypt_certificate;
      if (enc && enc.ciphertext && pay.apiV3Key) {
        try {
          const buf = Buffer.from(enc.ciphertext, 'base64');
          const d = wxpCrypto.createDecipheriv('aes-256-gcm', Buffer.from(pay.apiV3Key, 'utf8'), Buffer.from(enc.nonce || '', 'utf8'));
          d.setAuthTag(buf.subarray(buf.length - 16));
          d.setAAD(Buffer.from(enc.associated_data || '', 'utf8'));
          d.update(buf.subarray(0, buf.length - 16));
          d.final();
          v3KeyOk = true;
        } catch (_) { v3KeyOk = false; }
      }
    } catch (e) { verr = e.message; }

    res.json({ success: true, verified, v3KeyOk, error: verr, creds: credsStatus(id) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ═══════════════ Web store configuration ═══════════════════════════════════
// The browser storefront's own config page (sibling of the Mini App one): shop
// address (free subdomain + optional custom domain), which sign-in methods the
// shop shows, and payment readiness. Sign-in credentials are platform-provided,
// so this page is toggles, not key entry. Domains live in the CONTROL plane
// (tenant_domains, mainDb); sign-in prefs live in the tenant DATA plane
// (storefront_config 'web.signin'), read by the customer /auth/methods endpoint.
const dnsp = require('dns').promises;
const webSocial = require('../lib/social-auth');
const webEmail = require('../lib/email-sender');
const { registerTenantDomain, slugify: webSlugify } = require('../lib/provision-tenant');
const { normalizeHost: webNormalizeHost } = require('../middleware/public-tenant');

const WEB_BASE_DOMAIN = String(process.env.STOREFRONT_BASE_DOMAIN || '').trim().toLowerCase();
const WEB_DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/;
const WEB_SIGNIN_METHODS = ['phone', 'email', 'google', 'apple', 'wechat'];

function webCfgGet(key, fallback) {
  try {
    const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  } catch (_) { return fallback; }
}
function webCfgSet(key, val) {
  tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
       VALUES (?, ?, CURRENT_TIMESTAMP, 'web-config')
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`
  ).run(key, JSON.stringify(val));
}

// Which sign-in methods have working credentials (platform env, or a tenant
// override). Mirrors retail.js /auth/methods so availability is consistent.
function webSigninAvailability(id) {
  const ig = getTenantCreds(id).integrations || {};
  return {
    phone: true,                                       // Aliyun SMS baseline
    email: !!webEmail.isConfigured(ig.email),
    google: !!webSocial.isEnabled('google', ig),
    apple: !!webSocial.isEnabled('apple', ig),
    wechat: !!webSocial.isEnabled('wechat', ig),
  };
}

function webDomainRows(id) {
  try {
    return mainDb.prepare(
      'SELECT id, host, kind, status, is_primary FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC, id ASC'
    ).all(id).map(d => ({ id: d.id, host: d.host, kind: d.kind, status: d.status, isPrimary: !!d.is_primary }));
  } catch (_) { return []; }
}

// The whole picture for the config page.
router.get('/api/retail-admin/channel-hub/web/config', requireRetailAdmin, (req, res) => {
  try {
    const id = tenantId(req);
    const domains = webDomainRows(id);
    // The free platform subdomain we would assign, shown as a hint when the
    // tenant has no address yet (needs the one-time wildcard DNS+TLS to serve).
    let suggestedSub = null;
    if (WEB_BASE_DOMAIN) {
      const t = mainDb.prepare('SELECT brand_name, name FROM tenants WHERE id = ?').get(id) || {};
      suggestedSub = `${webSlugify(t.brand_name || t.name || 'shop')}.${WEB_BASE_DOMAIN}`;
    }
    const available = webSigninAvailability(id);
    const pref = webCfgGet('web.signin', null);
    const enabled = {};
    for (const m of WEB_SIGNIN_METHODS) enabled[m] = pref ? (!!pref[m] && available[m]) : available[m];
    const cs = credsStatus(id);
    const alipay = webCfgGet('integrations.alipayManual', null);
    res.json({
      success: true,
      baseDomain: WEB_BASE_DOMAIN,
      cnameTarget: WEB_BASE_DOMAIN,   // custom domains CNAME to the platform base
      domains, suggestedSub,
      signin: { available, enabled },
      pay: { wechatReady: !!cs.payReady, alipayConfigured: !!(alipay && alipay.enabled && alipay.qr) },
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Save which sign-in methods the web storefront shows. An unavailable method
// (no creds) can never be turned on, so the stored pref stays truthful.
router.post('/api/retail-admin/channel-hub/web/signin', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const id = tenantId(req);
    const available = webSigninAvailability(id);
    const b = req.body || {};
    const next = {};
    for (const m of WEB_SIGNIN_METHODS) next[m] = !!b[m] && !!available[m];
    webCfgSet('web.signin', next);
    res.json({ success: true, enabled: next });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Register a custom (BYO) domain — starts 'pending' until DNS points here and
// TLS is issued. Reserved: our own platform subdomains (those are auto-managed).
router.post('/api/retail-admin/channel-hub/web/domain', requireRetailAdmin, express.json(), (req, res) => {
  try {
    const id = tenantId(req);
    const host = webNormalizeHost(req.body && req.body.host);
    if (!host || !WEB_DOMAIN_RE.test(host)) return res.status(400).json({ success: false, error: 'bad_domain' });
    if (WEB_BASE_DOMAIN && (host === WEB_BASE_DOMAIN || host.endsWith('.' + WEB_BASE_DOMAIN))) {
      return res.status(400).json({ success: false, error: 'reserved' });
    }
    const clash = mainDb.prepare('SELECT tenant_id FROM tenant_domains WHERE host = ?').get(host);
    if (clash) return res.status(409).json({ success: false, error: clash.tenant_id === id ? 'already_yours' : 'taken' });
    registerTenantDomain(id, host, { kind: 'custom', status: 'pending', primary: false });
    const row = mainDb.prepare('SELECT id FROM tenant_domains WHERE host = ?').get(host);
    res.json({ success: true, id: row && row.id, host });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Check whether a pending domain now resolves to us. "Pointing" = the domain's
// A records overlap our base domain's A records (survives an IP change, and
// handles both CNAME-to-base and direct A setups). We record the DNS result but
// do NOT flip the domain to 'active' here: serving a host before its TLS cert
// exists would break HTTPS at the edge. Activation happens when the cert is
// issued (see the custom-domain TLS runbook).
router.post('/api/retail-admin/channel-hub/web/domain/:domainId/check', requireRetailAdmin, async (req, res) => {
  try {
    const id = tenantId(req);
    const d = mainDb.prepare('SELECT * FROM tenant_domains WHERE id = ? AND tenant_id = ?').get(req.params.domainId, id);
    if (!d) return res.status(404).json({ success: false, error: 'not_found' });
    const ourHost = WEB_BASE_DOMAIN || webNormalizeHost(req.hostname);
    const ours = await dnsp.resolve4(ourHost).catch(() => []);
    const theirs = await dnsp.resolve4(d.host).catch(() => []);
    const pointing = theirs.length > 0 && ours.length > 0 && theirs.some(ip => ours.includes(ip));
    res.json({ success: true, pointing, resolved: theirs, host: d.host, status: d.status });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.delete('/api/retail-admin/channel-hub/web/domain/:domainId', requireRetailAdmin, (req, res) => {
  try {
    const id = tenantId(req);
    const d = mainDb.prepare('SELECT * FROM tenant_domains WHERE id = ? AND tenant_id = ?').get(req.params.domainId, id);
    if (!d) return res.status(404).json({ success: false, error: 'not_found' });
    if (d.kind === 'subdomain') return res.status(400).json({ success: false, error: 'platform_subdomain' });
    mainDb.prepare('DELETE FROM tenant_domains WHERE id = ?').run(d.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
// Exported for scripts/test_channel_hub_binding.js — the decision, without a db.
module.exports.decideMeituanSignedIn = decideMeituanSignedIn;
