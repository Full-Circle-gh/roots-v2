// Per-user capabilities — the single source of truth for what a backend operator
// (tenant_users) is allowed to see and do in the Mini App Backend + Quick Stock.
//
// One mechanism drives BOTH "control each user" and "same app, different view":
//
//   effective = (preset ∪ grants) − revokes, ∩ tenant-entitled features
//               owner ⇒ ALL  (superuser, can never be locked out)
//
//   → the SERVER gates every route on the effective set (the real enforcement)
//   → the CLIENT renders only what's in the set (the "different view")
//
// This module is PURE + Node-only (required by routes). The client receives the
// resolved cap ARRAY via /api/backend/me; the full registry below (with labels)
// is what the admin permission-matrix UI reads in a later phase.
//
// ── Rollout status ────────────────────────────────────────────────────────
// Only owner resolves to ALL caps (see presetCapsFor). Every other role —
// admin, staff, … — resolves to its PRESETS entry, which the client uses to hide
// nav/controls it lacks. Hard server-side blocking stays behind the per-tenant
// tenant.rbac_enforce flag; until that's on, req.caps is shipped for the view
// but not used to reject requests.

'use strict';

// ── Capability registry ───────────────────────────────────────────────────
// key      : `section:action`, the stable id gated on server + client.
// group    : sidebar IA bucket (run | sell | content | setup) for the matrix UI.
// section  : nav section it belongs to (groups verbs of one area together).
// labelEn/Cn: shown in the admin permission matrix (kept bilingual, never glued).
// feature  : optional lib/features.js key — if the tenant isn't entitled to that
//            feature, the cap is dropped from the effective set (plan gating).
const CAPABILITIES = [
  // ── RUN ──────────────────────────────────────────────────────────────
  { key: 'dashboard:view',   group: 'run', section: 'dashboard', labelEn: 'View dashboard',        labelCn: '查看概览' },
  { key: 'reports:view',     group: 'run', section: 'dashboard', labelEn: 'View reports (revenue)', labelCn: '查看报表(营收)' },

  { key: 'orders:view',      group: 'run', section: 'orders',    labelEn: 'View orders',           labelCn: '查看订单' },
  { key: 'orders:edit',      group: 'run', section: 'orders',    labelEn: 'Edit / fulfil orders',  labelCn: '编辑/履约订单' },
  { key: 'orders:refund',    group: 'run', section: 'orders',    labelEn: 'Refund orders',         labelCn: '订单退款' },
  { key: 'orders:dispatch_courier', group: 'run', section: 'orders', labelEn: 'Book courier — spends account balance', labelCn: '下单快递(扣除账户余额)' },
  { key: 'orders:export',    group: 'run', section: 'orders',    labelEn: 'Export orders',         labelCn: '导出订单' },

  { key: 'invoices:view',    group: 'run', section: 'invoices',  labelEn: 'View invoices',         labelCn: '查看发票' },
  { key: 'invoices:manage',  group: 'run', section: 'invoices',  labelEn: 'Issue / upload invoices', labelCn: '开具/上传发票' },
  { key: 'invoices:export',  group: 'run', section: 'invoices',  labelEn: 'Export invoices',       labelCn: '导出发票' },

  { key: 'customers:view',   group: 'run', section: 'customers', labelEn: 'View customers',        labelCn: '查看顾客' },
  { key: 'customers:edit',   group: 'run', section: 'customers', labelEn: 'Edit customer profile', labelCn: '编辑顾客资料' },
  { key: 'customers:adjust', group: 'run', section: 'customers', labelEn: 'Adjust points / wallet', labelCn: '调整积分/余额' },
  { key: 'customers:block',  group: 'run', section: 'customers', labelEn: 'Block / force logout',  labelCn: '封禁/强制登出' },
  { key: 'customers:export', group: 'run', section: 'customers', labelEn: 'Export customers',      labelCn: '导出顾客' },

  { key: 'activity:view',    group: 'run', section: 'activity',  labelEn: 'View stock ledger',     labelCn: '查看库存流水' },
  { key: 'activity:export',  group: 'run', section: 'activity',  labelEn: 'Export stock ledger',   labelCn: '导出库存流水' },

  { key: 'quickstock:add',     group: 'run', section: 'quickstock', labelEn: 'Quick Stock — add (kitchen)',   labelCn: '快速库存—加库存(后厨)', feature: 'kitchenAdd' },
  { key: 'quickstock:recount', group: 'run', section: 'quickstock', labelEn: 'Quick Stock — recount (store)', labelCn: '快速库存—盘点(门店)', feature: 'quickStock' },

  { key: 'purchasing:view',    group: 'run', section: 'purchasing', labelEn: 'View suppliers & purchase orders', labelCn: '查看供应商与采购单' },
  { key: 'purchasing:edit',    group: 'run', section: 'purchasing', labelEn: 'Manage suppliers / create POs',    labelCn: '管理供应商/创建采购单' },
  { key: 'purchasing:receive', group: 'run', section: 'purchasing', labelEn: 'Receive purchase orders',          labelCn: '采购单收货' },
  // Chasing supplier 发票 is accounting's job, not the buyer's — an operator
  // can be given the invoice screen without also being able to create POs or
  // edit supplier records, which purchasing:edit would hand them.
  { key: 'purchasing:invoices', group: 'run', section: 'purchasing', labelEn: 'Record supplier invoices',        labelCn: '登记供应商发票' },

  // Materials (物料) — what a business buys and holds but doesn't sell. Its own
  // section rather than a purchasing verb: the masterlist outlives any one order.
  { key: 'materials:view',     group: 'run', section: 'materials',  labelEn: 'View materials',                   labelCn: '查看物料' },
  { key: 'materials:edit',     group: 'run', section: 'materials',  labelEn: 'Manage materials (add/edit/archive)', labelCn: '管理物料(新建/编辑/归档)' },

  // Recipes (食谱) — §29: cost-only, what a material is made from. Own section
  // for the same reason Materials got one: the recipe masterlist outlives any
  // one product. Not yet reachable from any UI (routes/retail-recipes.js
  // ships ahead of the screen); registered now so the caps and the screen
  // land in the same shape the client will read on day one.
  { key: 'recipes:view',       group: 'run', section: 'recipes',    labelEn: 'View recipes',                     labelCn: '查看食谱' },
  { key: 'recipes:edit',       group: 'run', section: 'recipes',    labelEn: 'Manage recipes (add/edit/archive)', labelCn: '管理食谱(新建/编辑/归档)' },

  // ── SELL ─────────────────────────────────────────────────────────────
  { key: 'products:view',    group: 'sell', section: 'products',   labelEn: 'View products',        labelCn: '查看产品' },
  { key: 'products:create',  group: 'sell', section: 'products',   labelEn: 'Create products',      labelCn: '新建产品' },
  { key: 'products:edit',    group: 'sell', section: 'products',   labelEn: 'Edit products',        labelCn: '编辑产品' },
  { key: 'products:delete',  group: 'sell', section: 'products',   labelEn: 'Delete products',      labelCn: '删除产品' },
  { key: 'products:export',  group: 'sell', section: 'products',   labelEn: 'Export products',      labelCn: '导出产品' },

  { key: 'categories:view',  group: 'sell', section: 'categories', labelEn: 'View categories',      labelCn: '查看分类' },
  { key: 'categories:edit',  group: 'sell', section: 'categories', labelEn: 'Edit categories',      labelCn: '编辑分类' },

  { key: 'editor:view',      group: 'sell', section: 'editor',     labelEn: 'Open page editor',     labelCn: '打开页面编辑器' },
  { key: 'editor:edit',      group: 'sell', section: 'editor',     labelEn: 'Edit storefront pages', labelCn: '编辑店铺页面' },

  { key: 'coupons:view',     group: 'sell', section: 'coupons',    labelEn: 'View coupons',         labelCn: '查看优惠券' },
  { key: 'coupons:create',   group: 'sell', section: 'coupons',    labelEn: 'Create coupons',       labelCn: '新建优惠券' },
  { key: 'coupons:edit',     group: 'sell', section: 'coupons',    labelEn: 'Edit coupons',         labelCn: '编辑优惠券' },
  { key: 'coupons:delete',   group: 'sell', section: 'coupons',    labelEn: 'Delete coupons',       labelCn: '删除优惠券' },
  { key: 'coupons:grant',    group: 'sell', section: 'coupons',    labelEn: 'Issue / revoke to customers', labelCn: '向顾客发放/撤销' },

  { key: 'flash:view',       group: 'sell', section: 'flash',      labelEn: 'View flash sales',     labelCn: '查看秒杀' },
  { key: 'flash:edit',       group: 'sell', section: 'flash',      labelEn: 'Edit flash sales',     labelCn: '编辑秒杀' },
  { key: 'flash:delete',     group: 'sell', section: 'flash',      labelEn: 'Delete flash sales',   labelCn: '删除秒杀' },

  { key: 'popups:view',      group: 'sell', section: 'popups',     labelEn: 'View pop-ups',         labelCn: '查看弹窗' },
  { key: 'popups:edit',      group: 'sell', section: 'popups',     labelEn: 'Edit pop-ups',         labelCn: '编辑弹窗' },
  { key: 'popups:delete',    group: 'sell', section: 'popups',     labelEn: 'Delete pop-ups',       labelCn: '删除弹窗' },

  { key: 'broadcasts:view',  group: 'sell', section: 'broadcasts', labelEn: 'View broadcasts',      labelCn: '查看广播' },
  { key: 'broadcasts:send',  group: 'sell', section: 'broadcasts', labelEn: 'Send broadcasts',      labelCn: '发送广播' },

  { key: 'sharing:edit',     group: 'sell', section: 'sharing',    labelEn: 'Edit share cards',     labelCn: '编辑分享卡片' },
  { key: 'social:edit',      group: 'sell', section: 'social',     labelEn: 'Edit social proof',    labelCn: '编辑社交证明', feature: 'socialProof' },
  { key: 'affiliate:view',   group: 'sell', section: 'affiliate',  labelEn: 'View affiliate',       labelCn: '查看分销', feature: 'affiliate' },
  { key: 'affiliate:edit',   group: 'sell', section: 'affiliate',  labelEn: 'Edit affiliate rules', labelCn: '编辑分销规则', feature: 'affiliate' },

  { key: 'loyalty:view',     group: 'sell', section: 'loyalty',    labelEn: 'View membership & points', labelCn: '查看会员与积分', feature: 'membership' },
  { key: 'loyalty:edit',     group: 'sell', section: 'loyalty',    labelEn: 'Edit membership & points', labelCn: '编辑会员与积分', feature: 'membership' },
  { key: 'topup:edit',       group: 'sell', section: 'topup',      labelEn: 'Edit top-up packages', labelCn: '编辑充值套餐', feature: 'membership' },
  { key: 'leaderboard:edit', group: 'sell', section: 'leaderboard', labelEn: 'Edit leaderboard',    labelCn: '编辑排行榜', feature: 'membership' },
  { key: 'voting:edit',      group: 'sell', section: 'voting',     labelEn: 'Edit voting campaigns', labelCn: '编辑投票活动' },

  // ── CONTENT / INBOX ──────────────────────────────────────────────────
  { key: 'content:view',     group: 'content', section: 'content',  labelEn: 'View content pages',  labelCn: '查看内容页面' },
  { key: 'content:edit',     group: 'content', section: 'content',  labelEn: 'Edit content (about/legal/FAQ/copy)', labelCn: '编辑内容(关于/条款/常见问题/文案)' },
  { key: 'media:view',       group: 'content', section: 'media',    labelEn: 'View media library',  labelCn: '查看媒体库' },
  { key: 'media:upload',     group: 'content', section: 'media',    labelEn: 'Upload media',        labelCn: '上传媒体' },
  { key: 'media:delete',     group: 'content', section: 'media',    labelEn: 'Delete media',        labelCn: '删除媒体' },

  { key: 'reviews:view',     group: 'content', section: 'reviews',  labelEn: 'View reviews',        labelCn: '查看评价', feature: 'reviews' },
  { key: 'reviews:moderate', group: 'content', section: 'reviews',  labelEn: 'Moderate reviews',    labelCn: '审核评价', feature: 'reviews' },
  { key: 'feedback:view',    group: 'content', section: 'feedback', labelEn: 'View feedback',       labelCn: '查看反馈', feature: 'feedback' },
  { key: 'feedback:moderate', group: 'content', section: 'feedback', labelEn: 'Moderate feedback',  labelCn: '处理反馈', feature: 'feedback' },
  { key: 'feedback:export',  group: 'content', section: 'feedback', labelEn: 'Export feedback',     labelCn: '导出反馈', feature: 'feedback' },

  // ── SET UP (high-privilege) ──────────────────────────────────────────
  { key: 'integrations:view',   group: 'setup', section: 'integrations', labelEn: 'View channels & delivery', labelCn: '查看渠道与配送' },
  { key: 'integrations:manage', group: 'setup', section: 'integrations', labelEn: 'Set up / manage integrations', labelCn: '设置/管理接入' },

  { key: 'delivery:view',    group: 'setup', section: 'delivery',  labelEn: 'View delivery zones', labelCn: '查看配送区域' },
  { key: 'delivery:edit',    group: 'setup', section: 'delivery',  labelEn: 'Edit delivery zones', labelCn: '编辑配送区域' },
  { key: 'delivery:delete',  group: 'setup', section: 'delivery',  labelEn: 'Delete delivery zones', labelCn: '删除配送区域' },

  { key: 'meituan:view',     group: 'setup', section: 'meituan',   labelEn: 'View Meituan sync',   labelCn: '查看美团同步' },
  { key: 'meituan:map',      group: 'setup', section: 'meituan',   labelEn: 'Map Meituan products', labelCn: '映射美团商品' },
  { key: 'meituan:sync',     group: 'setup', section: 'meituan',   labelEn: 'Push Meituan stock',  labelCn: '推送美团库存' },

  { key: 'eleme:view',       group: 'setup', section: 'eleme',     labelEn: 'View Eleme sync',     labelCn: '查看饿了么同步' },
  { key: 'eleme:map',        group: 'setup', section: 'eleme',     labelEn: 'Map Eleme products',  labelCn: '映射饿了么商品' },
  { key: 'eleme:sync',       group: 'setup', section: 'eleme',     labelEn: 'Push Eleme stock',    labelCn: '推送饿了么库存' },

  { key: 'guanyi:view',      group: 'setup', section: 'guanyi',    labelEn: 'View gzgrocery sync', labelCn: '查看管易同步' },
  { key: 'guanyi:map',       group: 'setup', section: 'guanyi',    labelEn: 'Map gzgrocery products', labelCn: '映射管易商品' },
  { key: 'guanyi:sync',      group: 'setup', section: 'guanyi',    labelEn: 'Push gzgrocery stock', labelCn: '推送管易库存' },

  { key: 'shipping:config',  group: 'setup', section: 'shipping',  labelEn: 'Configure shipping / print', labelCn: '配置物流/打印' },

  { key: 'settings:shop',     group: 'setup', section: 'settings',  labelEn: 'Shop settings',       labelCn: '店铺设置' },
  { key: 'settings:push',     group: 'setup', section: 'settings',  labelEn: 'Push-notification settings', labelCn: '推送通知设置' },
  { key: 'settings:payments', group: 'setup', section: 'settings',  labelEn: 'Payment settings',    labelCn: '支付设置' },

  { key: 'stores:view',      group: 'setup', section: 'stores',    labelEn: 'View stores',         labelCn: '查看门店' },
  { key: 'stores:edit',      group: 'setup', section: 'stores',    labelEn: 'Edit stores',         labelCn: '编辑门店' },
  { key: 'stores:delete',    group: 'setup', section: 'stores',    labelEn: 'Delete stores',       labelCn: '删除门店' },

  { key: 'team:view',        group: 'setup', section: 'team',      labelEn: 'View team',           labelCn: '查看团队' },
  { key: 'team:manage',      group: 'setup', section: 'team',      labelEn: 'Manage team (add/role/password)', labelCn: '管理团队(添加/角色/密码)' },
  { key: 'team:permissions', group: 'setup', section: 'team',      labelEn: 'Edit other users’ permissions', labelCn: '编辑他人权限' },

  { key: 'billing:view',     group: 'setup', section: 'billing',   labelEn: 'View billing',        labelCn: '查看账单' },
  { key: 'billing:pay',      group: 'setup', section: 'billing',   labelEn: 'Pay / change plan',   labelCn: '支付/更改套餐' },

  { key: 'ai:view',          group: 'setup', section: 'ai',        labelEn: 'View AI brand studio', labelCn: '查看AI品牌工作室' },
  { key: 'ai:generate',      group: 'setup', section: 'ai',        labelEn: 'Generate designs',    labelCn: '生成设计' },
  { key: 'ai:publish',       group: 'setup', section: 'ai',        labelEn: 'Publish designs',     labelCn: '发布设计' },

  { key: 'diagnostics:view', group: 'setup', section: 'diagnostics', labelEn: 'View diagnostics',  labelCn: '查看诊断' },
];

const ALL_KEYS = CAPABILITIES.map(c => c.key);
const KEY_SET = new Set(ALL_KEYS);
// cap key → required feature entitlement (for the plan intersect).
const CAP_FEATURE = {};
for (const c of CAPABILITIES) if (c.feature) CAP_FEATURE[c.key] = c.feature;

// ── Built-in presets ──────────────────────────────────────────────────────
// '*' = every capability. Listing a section name expands to all caps in that
// section (keeps the presets readable + auto-extends when a verb is added).
function sect(...sections) {
  const set = new Set(sections);
  return CAPABILITIES.filter(c => set.has(c.section)).map(c => c.key);
}
function viewsOf(...sections) {
  const set = new Set(sections);
  return CAPABILITIES.filter(c => set.has(c.section) && c.key.endsWith(':view')).map(c => c.key);
}

const PRESETS = {
  // Superuser. Never reduced — see presetCapsFor (always resolves to ALL).
  owner: '*',

  // Deputy. Runs the whole business and manages the team, but can't change the
  // plan/payment, rewrite other people's permissions, or delete a store.
  admin: ALL_KEYS.filter(k =>
    !['billing:pay', 'team:permissions', 'stores:delete'].includes(k)),

  // Generalist floor staff — runs the shop day-to-day, no money-sensitive or
  // setup powers. Owner ticks up refunds / revenue / exports per person.
  staff: [
    'dashboard:view',
    'orders:view', 'orders:edit',
    'invoices:view',
    'customers:view',
    'products:view', 'categories:view',
    'activity:view',
    'quickstock:recount',
  ],

  // Full operational control, minus money + permission-editing + destructive store ops.
  manager: ALL_KEYS.filter(k =>
    !['billing:pay', 'team:permissions', 'stores:delete'].includes(k)),

  // One store's day-to-day: orders, customers, stock, product edits — no setup/marketing.
  // Sees revenue (dashboard pulse + Reports) — their own store is their business;
  // the dashboard store lock keeps the view on their shelf.
  store_manager: [
    ...sect('dashboard', 'orders', 'invoices', 'customers', 'activity'),
    'quickstock:recount',
    'products:view', 'products:edit', 'categories:view',
    'stores:view',
    // Store managers receive inbound stock but don't create POs or edit suppliers.
    'purchasing:view', 'purchasing:receive',
    // Looks a material up (what unit, whose supplier); doesn't own the masterlist.
    'materials:view',
  ],

  // ── Dashboard positions (2026-07) — each maps to a fixed dashboard view ──
  // (see retail-admin 03-dashboard.js dashPos*). Store/kitchen keep their own.

  // Stock and shipments only — no revenue, no orders, no customers.
  warehouse: [
    'dashboard:view',
    ...sect('activity'),                       // stock ledger view + export
    'quickstock:recount', 'quickstock:add',
    'products:view', 'categories:view',
    'stores:view',
    ...sect('purchasing'),                     // suppliers, POs, receiving
    ...sect('materials'),                      // the materials masterlist — purchasing's sibling
    // May push stock to the channels after a restock; mapping stays setup-only.
    'meituan:view', 'meituan:sync', 'eleme:view', 'eleme:sync', 'guanyi:view', 'guanyi:sync',
  ],

  // Talks to customers: refunds, invoices, order fixes, reviews and feedback.
  customer_service: [
    'dashboard:view',
    'orders:view', 'orders:edit', 'orders:refund',
    'invoices:view', 'invoices:manage',
    'customers:view', 'customers:edit',
    'reviews:view', 'reviews:moderate',
    'feedback:view', 'feedback:moderate',
  ],

  // Keeps deliveries moving — orders in motion, nothing else.
  dispatch: [
    'dashboard:view',
    'orders:view', 'orders:edit', 'orders:dispatch_courier',
    'customers:view',
    'delivery:view',
    'stores:view',
  ],

  // Campaigns + content, no operations/money.
  marketing: [
    'dashboard:view',
    ...sect('coupons', 'flash', 'popups', 'broadcasts', 'sharing', 'social',
            'loyalty', 'topup', 'leaderboard', 'voting',
            'content', 'media', 'reviews', 'feedback'),
    'products:view', 'categories:view',
    'editor:view', 'editor:edit',
  ],

  // Order desk.
  fulfillment: [
    'dashboard:view',
    'orders:view', 'orders:edit', 'orders:refund', 'orders:dispatch_courier', 'orders:export',
    'invoices:view', 'invoices:manage',
    'customers:view',
    'activity:view', 'quickstock:recount',
  ],

  // Channel sync operators.
  channel: [
    ...sect('meituan', 'guanyi', 'eleme', 'integrations'),
    'activity:view',
  ],

  // The two existing restricted stockers (kept identical to today's behaviour).
  kitchen:     ['quickstock:add'],
  store_stock: ['quickstock:recount'],

  // Blank — admin builds it from the matrix.
  custom: [],
};

// Resolve a role/preset key to its base capability list. Only owner stays
// absolute full-access; every other role (admin, staff, …) falls through to its
// entry in the PRESETS table above.
function presetCapsFor(role) {
  if (role === 'owner') return ALL_KEYS.slice();
  const p = PRESETS[role];
  if (p === '*') return ALL_KEYS.slice();
  return Array.isArray(p) ? p.slice() : [];
}

// ── Effective resolution ───────────────────────────────────────────────────
// effective = (preset ∪ grants) − revokes, ∩ entitled features; owner ⇒ ALL.
//   role        : tenant_users.role (preset key)
//   grants      : array of cap keys force-ON for this user (override)
//   revokes     : array of cap keys force-OFF for this user (override)
//   entitlements: { featureKey: bool } from lib/features.entitlements(); a cap
//                 whose feature is false is dropped. Omit/empty = entitled to all.
// Returns a sorted array of effective cap keys.
function resolveCaps({ role, grants = [], revokes = [], entitlements = null } = {}) {
  // Owner is absolute — overrides + entitlements never strip an owner.
  if (role === 'owner') return ALL_KEYS.slice();

  const set = new Set(presetCapsFor(role));
  for (const g of grants) if (KEY_SET.has(g)) set.add(g);
  for (const r of revokes) set.delete(r);

  if (entitlements) {
    for (const key of [...set]) {
      const feat = CAP_FEATURE[key];
      if (feat && entitlements[feat] === false) set.delete(key);
    }
  }
  return [...set].sort();
}

// Convenience used by middleware: build a fast lookup Set for req.caps.
function capSet(args) { return new Set(resolveCaps(args)); }

module.exports = {
  CAPABILITIES,
  ALL_KEYS,
  PRESETS,
  CAP_FEATURE,
  presetCapsFor,
  resolveCaps,
  capSet,
  isKnown: (k) => KEY_SET.has(k),
  sect,
  viewsOf,
};
