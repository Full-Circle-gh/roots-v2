// Tenant provisioning (Phase 2). Creates a brand-new, fully isolated tenant:
//   1. a tenants row (the company)
//   2. an owner tenant_user (bcrypt password)
//   3. a 14-day trial billing_subscription
//   4. the tenant's own empty SQLite data file (schema cloned, no rows)
//   5. a brand-neutral storefront_config baseline seeded into (4)
//
// Control-plane rows (1–3) go in the shared roots.db; (4) is the isolated
// per-tenant DB via tenant-db.js. Usernames are enforced GLOBALLY unique so
// the username-based backend login stays unambiguous across tenants.

const bcrypt = require('bcrypt');
const mainDb = require('../database');
const { getTenantDb } = require('./tenant-db');

const TRIAL_DAYS = 14;

function sqlDt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

// ── Storefront baseline (Platform readiness ④) ───────────────────────────
// A fresh tenant DB is a SCHEMA-ONLY clone (tenant-db.initTenantSchema) — it
// has every storefront table but zero rows, so it inherits none of the
// boot-time `seed_storefront_config_v1` defaults (those only ever run against
// the main/Roots DB). Without a baseline the tenant's mini-app falls back to
// hardcoded Roots-flavoured defaults. This seeds the SAME proven key set the
// main DB uses, made brand-neutral:
//   • ipIntensity 'none'  — suppress Roots' IP mascot art (Roots uses 'soft')
//   • brand.me_footer.wordmark_text = the tenant's own brand
// Operational values mirror the backend's own cfgValue() fallbacks so the
// admin Settings page opens showing real saved values, not placeholders.
//
// Out of scope by design (per lib/onboarding-steps.js these are MANUAL human
// onboarding steps, business-specific, not auto-inventable): product catalog,
// categories, delivery zones / shipping rates, store address + hours, CMS
// home/about layouts, customer-service contact.
//
// INSERT OR IGNORE → idempotent + never clobbers an operator edit.
function buildDefaultConfig(brand) {
  const wordmark = String(brand || '').trim();
  return [
    // Theme — accent name maps to a CSS var client-side; intensity 'none'
    // keeps a new tenant free of Roots' mascot artwork until they pick a look.
    ['theme.accent',               'forest-kale'],
    ['theme.ipIntensity',          'none'],
    ['theme.language',             'bilingual'],
    ['theme.notif_color',          '#C43A6A'],   // UI's labelled default (Berry)
    // Fees / thresholds — identical to the backend cfgValue() fallbacks.
    ['fees.freeShippingThreshold', 399],
    ['fees.standardShipping',      12],
    ['fees.sameDayDelivery',       18],
    ['fees.minOrder',              0],
    // Shop grid presentation (admin Settings → Shop). Dietary filter off by
    // default since not every tenant is a food business.
    ['shop.layout',                'grid-2col'],
    ['shop.defaultSort',           'newest'],
    ['shop.showSort',              true],
    ['shop.showDietary',           false],
    ['shop.showStockFilter',       true],
    ['shop.showBadgeFilter',       true],
    ['shop.showPriceFilter',       true],
    ['shop.hideOutOfStock',        false],
    ['shop.lockLayout',            false],
    // Loyalty points — mirrors the main DB's points seed + cfgValue defaults.
    ['points.earnPoints',          1],
    ['points.earnSpend',           100],
    ['points.earnRate',            100],
    // Earn on the net total actually paid (after discounts). 'subtotal' would
    // earn on the pre-discount goods value instead.
    ['points.earnBase',            'paid'],
    // 1 point = ¥1 when redeeming (redeemRate = points per ¥1).
    ['points.redeemRate',          1],
    ['points.expiryMonths',        12],
    ['points.coverShipping',       false],
    // Referral program off until the operator opts in from the Affiliate tab.
    ['affiliate.enabled',          false],
    // Delivery global toggles (per-zone fees are a manual onboarding step).
    ['delivery.holidayMode',         false],
    ['delivery.holidayMessage',    {
      en: "We're closed for a short break — your order will ship as soon as we're back. Thank you for your patience!",
      cn: '我们短暂休息中 — 订单将在我们回来后第一时间发货。感谢您的耐心等待！',
    }],
    // Tab bar — same four tabs the mini-app expects.
    ['tabBar.theme',               'oat'],
    ['tabBar.items',               [
      { id: 'home', en: 'Home', cn: '首页' },
      { id: 'shop', en: 'Shop', cn: '商品' },
      { id: 'cart', en: 'Cart', cn: '购物车' },
      { id: 'me',   en: 'Me',   cn: '我的' },
    ]],
    // Mini-app Me-page footer — show the tenant's OWN wordmark text, not the
    // Roots / Full Circle fallback baked into me.js. Image + taglines stay
    // null so the operator fills them in later.
    ['brand.me_footer',            {
      wordmark_image: null,
      wordmark_text:  wordmark || null,
      tagline_en:     null,
      tagline_cn:     null,
      credit_en:      null,
      credit_cn:      null,
    }],
  ];
}

// Write the baseline into a tenant's own DB. Safe to call repeatedly.
function seedTenantDefaults(tenantDb, { brand } = {}) {
  const ins = tenantDb.prepare(
    'INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)'
  );
  const rows = buildDefaultConfig(brand);
  const tx = tenantDb.transaction(() => {
    for (const [k, v] of rows) ins.run(k, JSON.stringify(v));
  });
  tx();
  return rows.length;
}

function provisionTenant({ company, brand, ownerUsername, ownerPassword, ownerName }) {
  company = String(company || '').trim();
  brand = String(brand || '').trim();
  ownerUsername = String(ownerUsername || '').trim().toLowerCase();
  ownerName = String(ownerName || '').trim();

  if (!company) throw new Error('Company name required · 公司名称必填');
  if (!ownerUsername) throw new Error('Owner username required · 用户名必填');
  if (!ownerPassword || ownerPassword.length < 10) throw new Error('Password must be at least 10 characters · 密码至少需要 10 位');
  if (!/^[a-z0-9._-]+$/.test(ownerUsername)) throw new Error('Username may use letters, numbers, . _ - only · 用户名仅限字母、数字和 . _ -');

  // Username must be unique across ALL tenants (login is username-based).
  if (mainDb.prepare('SELECT id FROM tenant_users WHERE username = ?').get(ownerUsername)) {
    throw new Error('That username is already taken · 该用户名已被占用');
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86400000);
  const hash = bcrypt.hashSync(ownerPassword, 10);

  const tx = mainDb.transaction(() => {
    const t = mainDb.prepare('INSERT INTO tenants (name, brand_name, status) VALUES (?, ?, ?)')
      .run(company, brand || company, 'active');
    const tenantId = t.lastInsertRowid;

    mainDb.prepare('INSERT INTO tenant_users (tenant_id, username, password, display_name, role) VALUES (?,?,?,?,?)')
      .run(tenantId, ownerUsername, hash, ownerName || 'Owner', 'owner');

    mainDb.prepare(`INSERT INTO billing_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, trial_end, is_internal)
                    VALUES (?, NULL, 'trialing', ?, ?, ?, 0)`)
      .run(tenantId, sqlDt(now), sqlDt(trialEnd), sqlDt(trialEnd));

    return tenantId;
  });

  const tenantId = tx();

  // Materialize the isolated, empty per-tenant data DB (schema only), then
  // seed the brand-neutral storefront baseline into it. Done after the
  // control-plane commit so a rolled-back tenant leaves no file. Both are
  // best-effort: a failure here must not undo a committed tenant — the
  // operator can re-seed (INSERT OR IGNORE) or the baseline self-heals on a
  // later save.
  try {
    const tenantDb = getTenantDb(tenantId);
    const seeded = seedTenantDefaults(tenantDb, { brand: brand || company });
    console.log('[provision] tenant #' + tenantId + ' seeded ' + seeded + ' storefront defaults.');
  } catch (e) {
    console.error('[provision] tenant #' + tenantId + ' DB init/seed failed:', e.message);
  }

  console.log('[provision] tenant #' + tenantId + ' (' + company + ') created — owner: ' + ownerUsername + ', 14-day trial.');
  return { tenantId, ownerUsername, trialEnd: sqlDt(trialEnd) };
}

module.exports = { provisionTenant, seedTenantDefaults, buildDefaultConfig, TRIAL_DAYS };
