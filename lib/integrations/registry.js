'use strict';

// Integrations registry — the spine of the self-service "Channels & Delivery"
// hub (Platform readiness — Phase 1 FOUNDATION).
//
// One place that answers, per tenant: which sales channels + logistics plugins
// exist, what each needs, and — via a single control-plane row per (tenant,kind)
// — its status / health / step-by-step setup progress. The tenant settings hub
// and the saas-admin support dashboard both read from here, so a card can show
// "Meituan · session expired" or "Eleme · not set up" from one source of truth.
//
// ── Two control-plane tables (shared roots.db only) ───────────────────────
// tenant_integrations   — one row per (tenant, kind): status/config/health/steps
// integration_help_requests — the "Get help" escape hatch behind every wizard
//
// Both live ONLY in the shared control plane (never cloned into per-tenant DBs —
// see CONTROL_PLANE_TABLES in lib/tenant-db.js), because support needs a
// cross-tenant view. Secrets NEVER live here — they go through lib/tenant-creds.js;
// this table holds only non-secret status, mappings, and step progress.

const mainDb = require('../../database');
const { listConfiguredKeys, KEYS } = require('../tenant-creds');

// ── Schema (idempotent, control-plane) ────────────────────────────────────
mainDb.exec(`
  CREATE TABLE IF NOT EXISTS tenant_integrations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    kind         TEXT NOT NULL,            -- 'eleme' | 'meituan' | 'jd' | 'qingyun' | 'wechat_miniapp' | 'web'
    status       TEXT NOT NULL DEFAULT 'not_configured',
      -- not_configured | in_setup | connecting | connected | error | paused
    config_json  TEXT,                     -- non-secret config (shop ids, store mappings, toggles)
    health_json  TEXT,                     -- { last_sync_at, last_error, session_expires_at, counters, egress }
    setup_state  TEXT,                     -- JSON: step_key -> { status, error, updated_at, by }
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, kind),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
  CREATE TABLE IF NOT EXISTS integration_help_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    step_key     TEXT,                     -- the wizard step the tenant was on (nullable)
    status       TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | resolved
    attempts     INTEGER DEFAULT 0,        -- how many times the tenant retried before asking
    last_error   TEXT,                     -- machine error code / message at time of asking
    note         TEXT,                     -- free-text from the tenant
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );
`);
try { mainDb.prepare('CREATE INDEX IF NOT EXISTS idx_help_open ON integration_help_requests(status, created_at)').run(); } catch (_) {}

// ── Plugin descriptors (static catalogue) ─────────────────────────────────
// Order here = card order in the hub. `credKeys` are tenant-creds keys (or
// { prefix } for dynamic per-store families) used to derive a baseline
// "configured?" hint before a real integration row exists. `capsSection`
// mirrors lib/capabilities.js. `steps` is the wizard skeleton (bilingual, same
// shape as lib/onboarding-steps.js) — filled in per-plugin in later phases.
const DESCRIPTORS = [
  {
    kind: 'wechat_miniapp', category: 'first_party', capsSection: 'settings',
    labelEn: 'Mini App', labelCn: '小程序',
    blurbEn: 'Your WeChat Mini Program storefront — the first-party channel.',
    blurbCn: '您的微信小程序店铺 — 自有销售渠道。',
    estimateEn: 'guided setup', estimateCn: '引导式设置',
    credKeys: [KEYS.WX_APP_SECRET],
    steps: [],
  },
  {
    kind: 'web', category: 'first_party', capsSection: 'settings',
    labelEn: 'Web store', labelCn: '网页商店',
    blurbEn: 'Your browser storefront — always on, nothing to connect.',
    blurbCn: '网页版商店 — 无需接入,开箱即用。',
    estimateEn: 'no setup', estimateCn: '无需设置',
    credKeys: [],
    steps: [],
    alwaysOn: true,
  },
  {
    kind: 'eleme', category: 'channel', capsSection: 'eleme',
    labelEn: 'Eleme', labelCn: '饿了么',
    blurbEn: 'Official API — connect with your Eleme merchant login, then map shops to stores.',
    blurbCn: '官方接口 — 使用饿了么商家账号授权,再将店铺关联到门店。',
    estimateEn: 'about 15 min', estimateCn: '约 15 分钟',
    // Eleme merchant tokens live in the data-plane eleme_tokens table (per store,
    // inside the tenant's own DB), so credKeys can't see them from here — baseline
    // stays not_configured until an integration row is written in the Eleme phase.
    credKeys: [],
    steps: [
      { key: 'authorize',   en: 'Authorize', cn: '授权' },
      { key: 'link_shops',  en: 'Link shops', cn: '关联门店' },
      { key: 'map_products', en: 'Map products', cn: '商品映射' },
      { key: 'verify',      en: 'Verify & enable', cn: '验证并开启' },
    ],
  },
  {
    kind: 'meituan', category: 'channel', capsSection: 'meituan',
    labelEn: 'Meituan', labelCn: '美团',
    blurbEn: 'Waimai + Shangou. We ship a store box, then connect your merchant account.',
    blurbCn: '外卖 + 闪购。我们寄送门店盒子,再连接您的商家账号。',
    estimateEn: 'assisted setup', estimateCn: '协助式设置',
    credKeys: [{ prefix: 'meituan.' }],
    steps: [
      { key: 'store_box',    en: 'Store box', cn: '门店盒子' },
      { key: 'credentials',  en: 'Credentials', cn: '商家账号' },
      { key: 'verify_login', en: 'Verify login', cn: '登录验证' },
      { key: 'link_stores',  en: 'Link stores', cn: '关联门店' },
      { key: 'map_products', en: 'Map products', cn: '商品映射' },
      { key: 'verify',       en: 'Verify & enable', cn: '验证并开启' },
    ],
  },
  {
    kind: 'jd', category: 'logistics', capsSection: 'shipping',
    labelEn: 'JD Logistics', labelCn: '京东物流',
    blurbEn: 'Create waybills for delivery orders. Enter your JD app keys and test.',
    blurbCn: '为配送订单生成运单。填入京东应用密钥并测试。',
    estimateEn: 'about 10 min', estimateCn: '约 10 分钟',
    credKeys: [KEYS.JD_APP_KEY, KEYS.JD_APP_SECRET],
    steps: [
      { key: 'credentials', en: 'Credentials', cn: '应用密钥' },
      { key: 'verify',      en: 'Save & test', cn: '保存并测试' },
    ],
  },
  {
    kind: 'qingyun', category: 'logistics', capsSection: 'shipping',
    labelEn: 'Qingyun riders', labelCn: '青云配送',
    blurbEn: 'Live rider tracking for delivery orders. Same store box as Meituan.',
    blurbCn: '配送订单的骑手实时追踪。与美团共用门店盒子。',
    estimateEn: 'assisted setup', estimateCn: '协助式设置',
    credKeys: [{ prefix: 'qingyun.' }],
    steps: [
      { key: 'credentials', en: 'Credentials', cn: '账号' },
      { key: 'verify_login', en: 'Verify login', cn: '登录验证' },
      { key: 'link_stores', en: 'Link stores', cn: '关联门店' },
      { key: 'verify',      en: 'Verify & enable', cn: '验证并开启' },
    ],
  },
];

const BY_KIND = new Map(DESCRIPTORS.map(d => [d.kind, d]));
function getDescriptor(kind) { return BY_KIND.get(kind) || null; }
function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// Does the tenant have the credentials a descriptor needs? Baseline hint only
// (present ≠ verified) — a real integration row always wins over this.
function hasCreds(desc, configuredKeys) {
  if (!desc.credKeys || !desc.credKeys.length) return false;
  const set = configuredKeys;
  return desc.credKeys.some(k => {
    if (typeof k === 'string') return set.includes(k);
    if (k && k.prefix) return set.some(key => key.startsWith(k.prefix));
    return false;
  });
}

// ── Row access (control plane, keyed by tenant) ───────────────────────────
function indexRows(tenantId) {
  const rows = mainDb.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ?').all(Number(tenantId));
  const out = {};
  for (const r of rows) out[r.kind] = r;
  return out;
}

// The card list a tenant's hub renders. Combines the static catalogue, the
// tenant's integration rows, and a credentials-presence hint into one honest
// status per plugin. Never throws; unknown/missing → not_configured.
function listForTenant(tenantId) {
  const rows = indexRows(tenantId);
  let configured = [];
  try { configured = listConfiguredKeys(tenantId) || []; } catch (_) {}
  return DESCRIPTORS.map(d => {
    const row = rows[d.kind];
    let status;
    if (d.alwaysOn) status = 'connected';
    else if (row && row.status) status = row.status;
    else status = hasCreds(d, configured) ? 'configured' : 'not_configured';
    return {
      kind: d.kind,
      category: d.category,
      labelEn: d.labelEn, labelCn: d.labelCn,
      blurbEn: d.blurbEn, blurbCn: d.blurbCn,
      estimateEn: d.estimateEn, estimateCn: d.estimateCn,
      capsSection: d.capsSection,
      stepCount: (d.steps || []).length,
      status,
      health: row ? safeParse(row.health_json) : null,
      config: row ? safeParse(row.config_json) : null,
      updatedAt: row ? row.updated_at : null,
    };
  });
}

// Detail for one plugin's wizard: descriptor + the tenant's row (steps resolved
// with saved progress). Returns null for an unknown kind.
function detailForTenant(tenantId, kind) {
  const d = getDescriptor(kind);
  if (!d) return null;
  const row = mainDb.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ? AND kind = ?')
    .get(Number(tenantId), kind);
  const state = row ? (safeParse(row.setup_state) || {}) : {};
  const steps = (d.steps || []).map(s => ({
    key: s.key, en: s.en, cn: s.cn,
    status: state[s.key]?.status || 'pending',
    error: state[s.key]?.error || null,
    by: state[s.key]?.by || null,
  }));
  return {
    kind: d.kind, category: d.category, capsSection: d.capsSection,
    labelEn: d.labelEn, labelCn: d.labelCn,
    blurbEn: d.blurbEn, blurbCn: d.blurbCn,
    status: d.alwaysOn ? 'connected' : (row?.status || 'not_configured'),
    health: row ? safeParse(row.health_json) : null,
    config: row ? safeParse(row.config_json) : null,
    steps,
  };
}

// Upsert a plugin's control-plane row. Only the provided fields change; the rest
// are preserved. Used by every later phase to move a card through its lifecycle.
function upsertStatus(tenantId, kind, { status, config, health, setupState } = {}) {
  const id = Number(tenantId);
  if (!id) throw new Error('tenant id required');
  if (!BY_KIND.has(kind)) throw new Error('unknown integration kind: ' + kind);
  const existing = mainDb.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ? AND kind = ?').get(id, kind);
  const next = {
    status: status != null ? status : (existing?.status || 'not_configured'),
    config_json: config !== undefined ? JSON.stringify(config) : (existing?.config_json || null),
    health_json: health !== undefined ? JSON.stringify(health) : (existing?.health_json || null),
    setup_state: setupState !== undefined ? JSON.stringify(setupState) : (existing?.setup_state || null),
  };
  mainDb.prepare(
    `INSERT INTO tenant_integrations (tenant_id, kind, status, config_json, health_json, setup_state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id, kind) DO UPDATE SET
       status = excluded.status, config_json = excluded.config_json,
       health_json = excluded.health_json, setup_state = excluded.setup_state,
       updated_at = CURRENT_TIMESTAMP`
  ).run(id, kind, next.status, next.config_json, next.health_json, next.setup_state);
  return detailForTenant(id, kind);
}

// ── Store-added hook (locations wizard) ────────────────────────────────────
// When a tenant adds a location, every channel/logistics integration that is
// already past not_configured gets a "link this store" to-do on its card —
// which Meituan POI is this? which Eleme shop? — so a new store never silently
// stays un-synced. Returns the list of integrations that received a to-do so
// the wizard can render its "wire into your channels" panel.
// Best-effort by design: a failure here must never break store creation.
function notifyStoreAdded(tenantId, store) {
  const id = Number(tenantId);
  const out = [];
  if (!id || !store || !store.code) return out;
  let rows = [];
  try { rows = mainDb.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ?').all(id); } catch (_) { return out; }
  for (const row of rows) {
    const d = getDescriptor(row.kind);
    if (!d || (d.category !== 'channel' && d.category !== 'logistics')) continue;
    if (!row.status || row.status === 'not_configured') continue;
    try {
      const config = safeParse(row.config_json) || {};
      const todos = Array.isArray(config.todos) ? config.todos : [];
      if (todos.some(t => t.type === 'link_store' && t.store_code === store.code)) continue; // dedupe
      todos.push({
        id: `link_store:${store.code}`,
        type: 'link_store',
        store_code: store.code,
        store_name: store.name_en || store.name_cn || store.code,
        created_at: new Date().toISOString(),
      });
      config.todos = todos.slice(-20);   // bound growth
      upsertStatus(id, row.kind, { config });
      out.push({ kind: row.kind, labelEn: d.labelEn, labelCn: d.labelCn });
    } catch (_) { /* per-row best-effort */ }
  }
  return out;
}

// Dismiss one card to-do (e.g. after the operator linked the store by hand).
function dismissTodo(tenantId, kind, todoId) {
  const id = Number(tenantId);
  const row = mainDb.prepare('SELECT * FROM tenant_integrations WHERE tenant_id = ? AND kind = ?').get(id, kind);
  if (!row) return false;
  const config = safeParse(row.config_json) || {};
  const before = Array.isArray(config.todos) ? config.todos.length : 0;
  config.todos = (config.todos || []).filter(t => t.id !== todoId);
  if (config.todos.length === before) return false;
  upsertStatus(id, kind, { config });
  return true;
}

// ── Help requests ──────────────────────────────────────────────────────────
function createHelpRequest(tenantId, { kind, stepKey, note, lastError, attempts } = {}) {
  const id = Number(tenantId);
  if (!id) throw new Error('tenant id required');
  const info = mainDb.prepare(
    `INSERT INTO integration_help_requests (tenant_id, kind, step_key, note, last_error, attempts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, String(kind || ''), stepKey || null, note || null, lastError || null, Number(attempts) || 0);
  return mainDb.prepare('SELECT * FROM integration_help_requests WHERE id = ?').get(info.lastInsertRowid);
}

// Cross-tenant list for the saas-admin stuck-tenant dashboard (Phase 4 reads this).
function listHelpRequests({ status } = {}) {
  if (status) {
    return mainDb.prepare('SELECT * FROM integration_help_requests WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return mainDb.prepare('SELECT * FROM integration_help_requests ORDER BY created_at DESC').all();
}

module.exports = {
  DESCRIPTORS, getDescriptor,
  listForTenant, detailForTenant,
  upsertStatus,
  notifyStoreAdded, dismissTodo,
  createHelpRequest, listHelpRequests,
};
