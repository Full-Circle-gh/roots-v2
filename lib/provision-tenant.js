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
const { resolveLocale, feeDefaultsApply } = require('./locale-defaults');

const TRIAL_DAYS = 14;

// Platform base domain for free per-tenant storefront subdomains, e.g.
// "shop.fullcircle.app" → a tenant gets "<slug>.shop.fullcircle.app". Unset in
// dev / until DNS+wildcard-TLS are in place → auto-subdomain is simply skipped
// (the operator can still add a custom domain later from the backend).
const STOREFRONT_BASE_DOMAIN = String(process.env.STOREFRONT_BASE_DOMAIN || '').trim().toLowerCase();

function sqlDt(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shop';
}

// Register a storefront hostname for a tenant. Idempotent (host is globally
// unique). `kind` is 'subdomain' (free) or 'custom' (BYO); a custom domain
// should usually start 'pending' until DNS/SSL/ICP are verified.
function registerTenantDomain(tenantId, host, { kind = 'custom', status = 'active', primary = false } = {}) {
  host = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!host) throw new Error('Host required · 域名必填');
  mainDb.prepare(
    `INSERT OR IGNORE INTO tenant_domains (tenant_id, host, kind, status, is_primary)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tenantId, host, kind, status, primary ? 1 : 0);
  return host;
}

// Give a new tenant a free subdomain under the platform base, if one is set.
// Collisions (two "acme" tenants) fall back to "<slug>-<id>.<base>".
function autoAssignSubdomain(tenantId, brand) {
  if (!STOREFRONT_BASE_DOMAIN) return null;
  const slug = slugify(brand);
  let host = `${slug}.${STOREFRONT_BASE_DOMAIN}`;
  if (mainDb.prepare('SELECT 1 FROM tenant_domains WHERE host = ?').get(host)) {
    host = `${slug}-${tenantId}.${STOREFRONT_BASE_DOMAIN}`;
  }
  return registerTenantDomain(tenantId, host, { kind: 'subdomain', status: 'active', primary: true });
}

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
// categories, delivery zones / shipping rates, store address + hours, the
// about layout, customer-service contact. The HOME layout is the exception:
// every tenant starts from the same brand-neutral starter design (below) so a
// fresh store never opens on a blank page — and never on Roots' own layout.
//
// INSERT OR IGNORE → idempotent + never clobbers an operator edit.
function buildDefaultConfig(brand, locale) {
  const wordmark = String(brand || '').trim();
  // Audit D-08. These four were not seeded at all and fell back to yuan and
  // Guangzhou time. They are answers now, given at sign-up and resolved from the
  // merchant's country by lib/locale-defaults.js.
  const L = locale || resolveLocale({});
  // The yuan fee defaults are seeded only in the currency they were written in
  // — see feeDefaultsApply(). Everyone else starts unset and is asked, because
  // a £399 free-shipping threshold nobody chose looks exactly like one somebody
  // did, and the merchant may not find out until a customer does.
  const money = feeDefaultsApply(L.currency.code);
  const fees = money
    ? [['fees.freeShippingThreshold', 399], ['fees.standardShipping', 12],
       ['fees.sameDayDelivery', 18], ['fees.minOrder', 0]]
    : [];
  const points = money
    ? [['points.earnPoints', 1], ['points.earnSpend', 100], ['points.earnRate', 100],
       ['points.redeemRate', 1]]
    : [];
  return [
    // ── The four answers ──────────────────────────────────────────────────
    ['currency',                   L.currency],
    ['shop.country',               L.country],
    // Read by lib/business-date.js when no location carries a zone yet, so a
    // merchant's business day is their own from the first order — before they
    // have created a store (audit A-05 closed the SQL half of this; without
    // this key a brand-new account would still close its books in Guangzhou).
    ['shop.timezone',              L.timezone],
    // Theme — accent name maps to a CSS var client-side; intensity 'none'
    // keeps a new tenant free of Roots' mascot artwork until they pick a look.
    ['theme.accent',               'forest-kale'],
    ['theme.ipIntensity',          'none'],
    ['theme.language',             L.language],
    ['theme.notif_color',          '#C43A6A'],   // UI's labelled default (Berry)
    // Fees / thresholds — seeded only when the currency they were written in
    // is the one this merchant sells in. See `fees` above.
    ...fees,
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
    // Loyalty points — the earn/redeem numbers are a yuan sentence ("1 point =
    // ¥1"), so they follow the same rule as the fees.
    ...points,
    // Earn on the net total actually paid (after discounts). 'subtotal' would
    // earn on the pre-discount goods value instead.
    ['points.earnBase',            'paid'],
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
    // Roots / tacet fallback baked into me.js. Image + taglines stay
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

// ── Starter home layout ──────────────────────────────────────────────────
// The same brand-neutral home design for every new tenant. Only blocks that
// POPULATE THEMSELVES are used — nothing needs copy, photos or catalog work
// before the page looks intentional:
//   greeting          time-of-day welcome; personalises once customers sign in
//   notification_bar  hides itself while the customer has no unread updates
//   product_grid      new_arrivals / top_selling auto-sources — fill up as the
//                     operator adds products and orders come in
// (category_tabs is deliberately absent: it needs hand-picked category_ids,
// which a fresh tenant doesn't have yet.)
// Copy is generic bilingual; colours are brand tokens the theme maps per
// tenant. The dedicated per-brand redesign is a later, plan-gated upgrade —
// this is the floor every store starts from, not Roots' layout.
function starterId() {
  return 'b' + Math.random().toString(36).slice(2, 10);
}
function buildStarterHomeLayout() {
  const spacer = () => ({ id: starterId(), type: 'spacer', height_px: 40, divider_style: 'none', divider_color: 'olive-moss' });
  return [
    { id: starterId(), type: 'greeting', view: 'wallet',
      kicker_en: 'WELCOME', kicker_cn: '欢迎光临',
      show_points: true, show_tod_emoji: 'off',
      bg_color: 'forest-kale', fg_color: 'oat-milk' },
    { id: starterId(), type: 'notification_bar', view: 'bar',
      bg_color: 'lime-leaf', fg_color: 'ink', show_order_status: false },
    spacer(),
    { id: starterId(), type: 'product_grid', view: 'grid',
      source_type: 'new_arrivals', columns: 2, limit: 6,
      corner_radius: 'subtle', density: 'normal',
      kicker_en: 'JUST IN', kicker_cn: '新品',
      title_en: 'New arrivals', title_cn: '最新上架' },
    spacer(),
    { id: starterId(), type: 'product_grid', view: 'grid',
      source_type: 'top_selling', top_window: '30d', top_channel: 'combined',
      columns: 2, limit: 6, corner_radius: 'subtle', density: 'normal',
      rank_badge: 'top_3',
      kicker_en: 'POPULAR', kicker_cn: '热卖',
      title_en: 'Customer favourites', title_cn: '人气之选' },
    spacer(),
  ];
}

// Write the baseline into a tenant's own DB. Safe to call repeatedly.
function seedTenantDefaults(tenantDb, { brand, locale } = {}) {
  const ins = tenantDb.prepare(
    'INSERT OR IGNORE INTO storefront_config (key, value_json) VALUES (?, ?)'
  );
  const rows = buildDefaultConfig(brand, locale);
  // Live + draft get the IDENTICAL starter (same block ids) so the CMS opens
  // clean — a byte-different draft would read as "unpublished changes" on a
  // brand-new account.
  const starterJson = JSON.stringify(buildStarterHomeLayout());
  const tx = tenantDb.transaction(() => {
    for (const [k, v] of rows) ins.run(k, JSON.stringify(v));
    ins.run('home.layout', starterJson);
    ins.run('cms.draft.home_layout', starterJson);
  });
  tx();
  return rows.length + 2;
}

function provisionTenant({ company, brand, ownerUsername, ownerPassword, ownerName,
                           country, currency, timezone, language }) {
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

  // Audit D-08 / H-01. Country, currency, time zone and working language were
  // never asked and never seeded, so every account fell back to yuan and
  // Guangzhou time. Resolved once, here, and seeded below — anything the
  // merchant chose wins, anything they left blank follows from their country.
  const locale = resolveLocale({ country, currency, timezone, language });

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

  // The four starting roles — Owner, Manager, Shop floor, Stockroom. Stamped
  // from the shipped presets by lib/roles.js. A new tenant gets exactly four:
  // the other five are only ever carried into a tenant that already has people
  // on them, which a tenant one line old does not. Best-effort like the two
  // steps below — an unseeded tenant still resolves from presetCapsFor, so a
  // failure here costs the Roles tab its content, never anyone their access.
  try { require('./roles').seedTenant(tenantId); }
  catch (e) { console.warn('[provision] role seed failed for tenant ' + tenantId + ':', e && e.message); }

  // Materialize the isolated, empty per-tenant data DB (schema only), then
  // seed the brand-neutral storefront baseline into it. Done after the
  // control-plane commit so a rolled-back tenant leaves no file. Both are
  // best-effort: a failure here must not undo a committed tenant — the
  // operator can re-seed (INSERT OR IGNORE) or the baseline self-heals on a
  // later save.
  try {
    const tenantDb = getTenantDb(tenantId);
    const seeded = seedTenantDefaults(tenantDb, { brand: brand || company, locale });
    console.log('[provision] tenant #' + tenantId + ' seeded ' + seeded + ' storefront defaults.');
  } catch (e) {
    console.error('[provision] tenant #' + tenantId + ' DB init/seed failed:', e.message);
  }

  // Best-effort: hand the tenant a free storefront subdomain (no-op until the
  // platform base domain is configured). Never undo a committed tenant.
  // ── AUDIT H-03 ────────────────────────────────────────────────────────
  // A merchant got a web address only if the platform had a base domain
  // configured; without one this step returned null and said nothing, and the
  // merchant finished the setup checklist — "Open the doors" included — with a
  // shop that had no address to send anyone to.
  //
  // It is still best-effort, because a committed account must not be undone by
  // a DNS setting. What changes is that it is REPORTED: the caller is told, so
  // sign-up can say "your shop address is being set up" instead of implying
  // there is one, and the platform group is told, because a base domain nobody
  // configured is the platform's to fix and no merchant can see it.
  let storefrontHost = null;
  let storefrontWhy = null;
  try {
    storefrontHost = autoAssignSubdomain(tenantId, brand || company);
    if (storefrontHost) console.log('[provision] tenant #' + tenantId + ' storefront → https://' + storefrontHost);
    else storefrontWhy = 'no platform base domain is configured (STOREFRONT_BASE_DOMAIN)';
  } catch (e) {
    storefrontWhy = e.message;
    console.error('[provision] tenant #' + tenantId + ' subdomain assign failed:', e.message);
  }
  if (!storefrontHost) {
    console.error('[provision] tenant #' + tenantId + ' HAS NO WEB ADDRESS — ' + storefrontWhy
      + '. The setup checklist will show "Open the doors" for a shop nobody can reach.');
    try {
      require('./ops-alert').alertPlatform(
        `🟠 New account #${tenantId} (${company}) was created with NO storefront address — ${storefrontWhy}. `
        + `They can finish setup and open a shop nobody can reach.`);
    } catch (e) { /* alerting must never fail a provision that otherwise worked */ }
  }

  console.log('[provision] tenant #' + tenantId + ' (' + company + ') created — owner: ' + ownerUsername + ', 14-day trial.');
  return {
    tenantId, ownerUsername, trialEnd: sqlDt(trialEnd),
    locale,
    // null when none could be issued — the caller must not imply one exists.
    storefrontHost, storefrontWhy,
  };
}

module.exports = {
  provisionTenant, seedTenantDefaults, buildDefaultConfig, buildStarterHomeLayout, TRIAL_DAYS,
  registerTenantDomain, autoAssignSubdomain, slugify,
};
