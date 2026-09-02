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
// money    : optional 'shows' | 'moves' — this permission puts a currency figure
//            on screen the operator would not otherwise see ('shows'), or lets
//            them change what the business owes, is owed, holds or has spent
//            ('moves'). Drawn as ONE marker either way; the value only picks the
//            word. Absent = neither, which is 67 of the 101.
//
//            The marker exists because the presets do not say what they hold.
//            store_manager carries FIVE money-moving permissions (refund,
//            courier spend, invoice issue, wallet adjustment, price edits) while
//            its neighbours' comments claim no money-sensitive powers, and
//            `staff` — commented "no money-sensitive powers" — shows wallet
//            balances, unit cost and margin. Both true today; neither visible
//            anywhere until now.
//
//            MONEY_NOTES below carries the one-line justification for the marks
//            a label doesn't already earn on its own. A coin with no sentence
//            behind it reads as arbitrary, which is how a marker stops being
//            believed.
const CAPABILITIES = [
  // ── RUN ──────────────────────────────────────────────────────────────
  { key: 'dashboard:view',   group: 'run', section: 'dashboard', labelEn: 'View dashboard',        labelCn: '查看概览' },
  { key: 'reports:view',     group: 'run', section: 'dashboard', labelEn: 'View reports (revenue)', labelCn: '查看报表(营收)', money: 'shows' },

  { key: 'orders:view',      group: 'run', section: 'orders',    labelEn: 'View orders',           labelCn: '查看订单' },
  { key: 'orders:edit',      group: 'run', section: 'orders',    labelEn: 'Edit / fulfil orders',  labelCn: '编辑/履约订单' },
  { key: 'orders:refund',    group: 'run', section: 'orders',    labelEn: 'Refund orders',         labelCn: '订单退款', money: 'moves' },
  { key: 'orders:dispatch_courier', group: 'run', section: 'orders', labelEn: 'Book courier — spends account balance', labelCn: '下单快递(扣除账户余额)', money: 'moves' },
  { key: 'orders:export',    group: 'run', section: 'orders',    labelEn: 'Export orders',         labelCn: '导出订单', money: 'shows' },

  { key: 'invoices:view',    group: 'run', section: 'invoices',  labelEn: 'View invoices',         labelCn: '查看发票', money: 'shows' },
  { key: 'invoices:manage',  group: 'run', section: 'invoices',  labelEn: 'Issue / upload invoices', labelCn: '开具/上传发票', money: 'moves' },
  { key: 'invoices:export',  group: 'run', section: 'invoices',  labelEn: 'Export invoices',       labelCn: '导出发票', money: 'shows' },

  // Finance (§36) — the money staircase. Its own section rather than a
  // dashboard verb: Reports answers "what sold", Finance answers "did we make
  // money", and they are different questions with different audiences. An
  // accountant gets Finance without also getting the channel and product
  // analytics that `reports:view` hands over.
  //
  // Two capabilities, not one, and the split is the note this pair carried from
  // the first commit: "the Transactions screen is where a person types (§36);
  // when it lands it needs its own `moves` capability rather than widening this
  // one." It has landed, so it has one. An accountant can be given the whole
  // Finance surface read-only without also being handed the ledger's pen.
  { key: 'finance:view',     group: 'run', section: 'finance',   labelEn: 'View finance',          labelCn: '查看财务', money: 'shows' },
  { key: 'finance:record',   group: 'run', section: 'finance',   labelEn: 'Record transactions',   labelCn: '记录交易', money: 'moves' },

  { key: 'customers:view',   group: 'run', section: 'customers', labelEn: 'View customers',        labelCn: '查看顾客', money: 'shows' },
  { key: 'customers:edit',   group: 'run', section: 'customers', labelEn: 'Edit customer profile', labelCn: '编辑顾客资料' },
  { key: 'customers:adjust', group: 'run', section: 'customers', labelEn: 'Adjust points / wallet', labelCn: '调整积分/余额', money: 'moves' },
  { key: 'customers:block',  group: 'run', section: 'customers', labelEn: 'Block / force logout',  labelCn: '封禁/强制登出' },
  { key: 'customers:export', group: 'run', section: 'customers', labelEn: 'Export customers',      labelCn: '导出顾客', money: 'shows' },

  { key: 'activity:view',    group: 'run', section: 'activity',  labelEn: 'View stock ledger',     labelCn: '查看库存流水' },
  { key: 'activity:export',  group: 'run', section: 'activity',  labelEn: 'Export stock ledger',   labelCn: '导出库存流水' },

  { key: 'quickstock:add',     group: 'run', section: 'quickstock', labelEn: 'Quick Stock — add (kitchen)',   labelCn: '快速库存—加库存(后厨)', feature: 'kitchenAdd' },
  { key: 'quickstock:recount', group: 'run', section: 'quickstock', labelEn: 'Quick Stock — recount (store)', labelCn: '快速库存—盘点(门店)', feature: 'quickStock' },

  { key: 'purchasing:view',    group: 'run', section: 'purchasing', labelEn: 'View suppliers & purchase orders', labelCn: '查看供应商与采购单', money: 'shows' },
  { key: 'purchasing:edit',    group: 'run', section: 'purchasing', labelEn: 'Manage suppliers / create POs',    labelCn: '管理供应商/创建采购单', money: 'moves' },
  { key: 'purchasing:receive', group: 'run', section: 'purchasing', labelEn: 'Receive purchase orders',          labelCn: '采购单收货' },
  // Chasing supplier 发票 is accounting's job, not the buyer's — an operator
  // can be given the invoice screen without also being able to create POs or
  // edit supplier records, which purchasing:edit would hand them.
  // Labelled as a SCREEN, not an action, on purpose. 'invoices' is a noun in the
  // verb slot here and it collides conceptually with the separate `invoices`
  // section, which is the customer-facing 发票. Naming the screen keeps the two
  // apart at the point they are read, side by side in one list.
  { key: 'purchasing:invoices', group: 'run', section: 'purchasing', labelEn: 'Supplier invoices screen',       labelCn: '供应商发票页面', money: 'shows' },

  // Materials (物料) — what a business buys and holds but doesn't sell. Its own
  // section rather than a purchasing verb: the masterlist outlives any one order.
  { key: 'materials:view',     group: 'run', section: 'materials',  labelEn: 'View materials',                   labelCn: '查看物料', money: 'shows' },
  { key: 'materials:edit',     group: 'run', section: 'materials',  labelEn: 'Manage materials (add/edit/archive)', labelCn: '管理物料(新建/编辑/归档)', money: 'moves' },

  // Recipes (食谱) — §29: cost-only, what a material is made from. Own section
  // for the same reason Materials got one: the recipe masterlist outlives any
  // one product. Not yet reachable from any UI (routes/retail-recipes.js
  // ships ahead of the screen); registered now so the caps and the screen
  // land in the same shape the client will read on day one.
  { key: 'recipes:view',       group: 'run', section: 'recipes',    labelEn: 'View recipes',                     labelCn: '查看食谱', money: 'shows' },
  { key: 'recipes:edit',       group: 'run', section: 'recipes',    labelEn: 'Manage recipes (add/edit/archive)', labelCn: '管理食谱(新建/编辑/归档)', money: 'moves' },

  // Waste (损耗) — §32: a stock movement with a reason, not a log beside stock.
  // THREE verbs, not two, and the third is the point: VOID IS NOT IMPLIED BY
  // RECORD. Recording a loss is a daily floor task; voiding one erases a
  // recorded loss from every total, so it is the verb an operator uses about
  // their own mistakes and the one an owner may want to keep. Its own section
  // rather than a stock verb, because waste outlives any one count.
  { key: 'waste:view',         group: 'run', section: 'waste',      labelEn: 'View waste',                       labelCn: '查看损耗', money: 'shows' },
  { key: 'waste:record',       group: 'run', section: 'waste',      labelEn: 'Record waste',                     labelCn: '登记损耗' },
  { key: 'waste:void',         group: 'run', section: 'waste',      labelEn: 'Void a waste entry',               labelCn: '作废损耗记录', money: 'moves' },

  // ── SELL ─────────────────────────────────────────────────────────────
  { key: 'products:view',    group: 'sell', section: 'products',   labelEn: 'View products',        labelCn: '查看产品', money: 'shows' },
  { key: 'products:create',  group: 'sell', section: 'products',   labelEn: 'Create products',      labelCn: '新建产品' },
  { key: 'products:edit',    group: 'sell', section: 'products',   labelEn: 'Edit products',        labelCn: '编辑产品', money: 'moves' },
  { key: 'products:delete',  group: 'sell', section: 'products',   labelEn: 'Delete products',      labelCn: '删除产品' },
  { key: 'products:export',  group: 'sell', section: 'products',   labelEn: 'Export products',      labelCn: '导出产品', money: 'shows' },

  { key: 'categories:view',  group: 'sell', section: 'categories', labelEn: 'View categories',      labelCn: '查看分类' },
  { key: 'categories:edit',  group: 'sell', section: 'categories', labelEn: 'Edit categories',      labelCn: '编辑分类' },

  { key: 'editor:view',      group: 'sell', section: 'editor',     labelEn: 'Open page editor',     labelCn: '打开页面编辑器' },
  { key: 'editor:edit',      group: 'sell', section: 'editor',     labelEn: 'Edit storefront pages', labelCn: '编辑店铺页面' },

  { key: 'coupons:view',     group: 'sell', section: 'coupons',    labelEn: 'View coupons',         labelCn: '查看优惠券' },
  { key: 'coupons:create',   group: 'sell', section: 'coupons',    labelEn: 'Create coupons',       labelCn: '新建优惠券', money: 'moves' },
  { key: 'coupons:edit',     group: 'sell', section: 'coupons',    labelEn: 'Edit coupons',         labelCn: '编辑优惠券', money: 'moves' },
  { key: 'coupons:delete',   group: 'sell', section: 'coupons',    labelEn: 'Delete coupons',       labelCn: '删除优惠券' },
  { key: 'coupons:grant',    group: 'sell', section: 'coupons',    labelEn: 'Issue / revoke to customers', labelCn: '向顾客发放/撤销', money: 'moves' },

  { key: 'flash:view',       group: 'sell', section: 'flash',      labelEn: 'View flash sales',     labelCn: '查看秒杀' },
  { key: 'flash:edit',       group: 'sell', section: 'flash',      labelEn: 'Edit flash sales',     labelCn: '编辑秒杀', money: 'moves' },
  { key: 'flash:delete',     group: 'sell', section: 'flash',      labelEn: 'Delete flash sales',   labelCn: '删除秒杀' },

  { key: 'popups:view',      group: 'sell', section: 'popups',     labelEn: 'View pop-ups',         labelCn: '查看弹窗' },
  { key: 'popups:edit',      group: 'sell', section: 'popups',     labelEn: 'Edit pop-ups',         labelCn: '编辑弹窗' },
  { key: 'popups:delete',    group: 'sell', section: 'popups',     labelEn: 'Delete pop-ups',       labelCn: '删除弹窗' },

  { key: 'broadcasts:view',  group: 'sell', section: 'broadcasts', labelEn: 'View broadcasts',      labelCn: '查看广播' },
  { key: 'broadcasts:send',  group: 'sell', section: 'broadcasts', labelEn: 'Send broadcasts',      labelCn: '发送广播' },

  { key: 'sharing:edit',     group: 'sell', section: 'sharing',    labelEn: 'Edit share cards',     labelCn: '编辑分享卡片' },
  { key: 'social:edit',      group: 'sell', section: 'social',     labelEn: 'Edit social proof',    labelCn: '编辑社交证明', feature: 'socialProof' },
  { key: 'affiliate:view',   group: 'sell', section: 'affiliate',  labelEn: 'View affiliate',       labelCn: '查看分销', feature: 'affiliate', money: 'shows' },
  { key: 'affiliate:edit',   group: 'sell', section: 'affiliate',  labelEn: 'Edit affiliate rules', labelCn: '编辑分销规则', feature: 'affiliate', money: 'moves' },

  { key: 'loyalty:view',     group: 'sell', section: 'loyalty',    labelEn: 'View membership & points', labelCn: '查看会员与积分', feature: 'membership' },
  { key: 'loyalty:edit',     group: 'sell', section: 'loyalty',    labelEn: 'Edit membership & points', labelCn: '编辑会员与积分', feature: 'membership', money: 'moves' },
  { key: 'topup:edit',       group: 'sell', section: 'topup',      labelEn: 'Edit top-up packages', labelCn: '编辑充值套餐', feature: 'membership', money: 'moves' },
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
  { key: 'delivery:edit',    group: 'setup', section: 'delivery',  labelEn: 'Edit delivery zones', labelCn: '编辑配送区域', money: 'moves' },
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
  { key: 'settings:payments', group: 'setup', section: 'settings',  labelEn: 'Payment settings',    labelCn: '支付设置', money: 'moves' },

  { key: 'stores:view',      group: 'setup', section: 'stores',    labelEn: 'View stores',         labelCn: '查看门店' },
  { key: 'stores:edit',      group: 'setup', section: 'stores',    labelEn: 'Edit stores',         labelCn: '编辑门店' },
  { key: 'stores:delete',    group: 'setup', section: 'stores',    labelEn: 'Delete stores',       labelCn: '删除门店' },

  { key: 'team:view',        group: 'setup', section: 'team',      labelEn: 'View team',           labelCn: '查看团队' },
  { key: 'team:manage',      group: 'setup', section: 'team',      labelEn: 'Manage team (add/role/password)', labelCn: '管理团队(添加/角色/密码)' },
  { key: 'team:permissions', group: 'setup', section: 'team',      labelEn: 'Edit other users’ permissions', labelCn: '编辑他人权限' },

  { key: 'billing:view',     group: 'setup', section: 'billing',   labelEn: 'View billing',        labelCn: '查看账单', money: 'shows' },
  { key: 'billing:pay',      group: 'setup', section: 'billing',   labelEn: 'Pay / change plan',   labelCn: '支付/更改套餐', money: 'moves' },

  { key: 'ai:view',          group: 'setup', section: 'ai',        labelEn: 'View AI brand studio', labelCn: '查看AI品牌工作室' },
  { key: 'ai:generate',      group: 'setup', section: 'ai',        labelEn: 'Generate designs',    labelCn: '生成设计' },
  { key: 'ai:publish',       group: 'setup', section: 'ai',        labelEn: 'Publish designs',     labelCn: '发布设计' },

  { key: 'diagnostics:view', group: 'setup', section: 'diagnostics', labelEn: 'View diagnostics',  labelCn: '查看诊断' },
];

// Why a marked capability is marked, where its own label doesn't already say so.
// Shown under the permission in the role editor, so the marker argues its case at
// the point it is read. Only the non-obvious ones are here — 'Refund orders' and
// 'Pay / change plan' need no help.
const MONEY_NOTES = {
  'orders:export':      ['The whole order book, with totals, as a file.', '整本订单账(含金额)导出为文件。'],
  'finance:record':     ['A typed ledger row is what the business says it earned and spent.', '手工记录直接决定账本上的收支。'],
  'invoices:manage':    ['Issuing a 发票 is a fiscal act, not a record of one.', '开具发票是税务行为,而非记录。'],
  'customers:view':     ['The customer list shows each wallet balance.', '顾客列表会显示每个人的余额。'],
  'customers:export':   ['Carries wallet balances and lifetime spend out as a file.', '导出文件含余额与累计消费。'],
  'purchasing:view':    ['Supplier prices are on every line.', '每一行都显示供应商价格。'],
  'purchasing:edit':    ['A purchase order commits the business to pay.', '下达采购单即产生付款义务。'],
  'purchasing:invoices':['Supplier invoice amounts are what the business owes.', '供应商发票金额即应付账款。'],
  'materials:view':     ['Materials show cost per unit.', '物料显示单位成本。'],
  'materials:edit':     ['A material\u2019s cost carries into every recipe and every margin.', '物料成本会带入每个食谱与每项毛利。'],
  'recipes:view':       ['A recipe is a cost.', '食谱本身就是成本。'],
  'recipes:edit':       ['Changes the cost every product built from it reports.', '改动会影响以此制作的所有产品成本。'],
  'waste:view':         ['Waste is totalled in money.', '损耗按金额合计。'],
  'waste:void':         ['Voiding removes a recorded loss from every total.', '作废会将已记录的损耗从所有合计中移除。'],
  'products:view':      ['The product list shows unit cost and margin.', '产品列表显示单位成本与毛利。'],
  'products:edit':      ['Sets what customers are charged.', '决定向顾客收取的价格。'],
  'products:export':    ['Carries cost and margin out as a file.', '导出文件含成本与毛利。'],
  'coupons:create':     ['A coupon is money off, at whatever scale it is issued.', '优惠券即让利,规模取决于发放量。'],
  'coupons:edit':       ['Changes how much is given away.', '改变让利金额。'],
  'coupons:grant':      ['Issues value to a named customer.', '向指定顾客发放价值。'],
  'flash:edit':         ['Sets discounted prices.', '设定促销价格。'],
  'affiliate:view':     ['Shows what is owed in commission.', '显示应付佣金。'],
  'affiliate:edit':     ['Hands one customer a cut of other people\u2019s future orders.', '把他人未来订单的分成给到某位顾客。'],
  'loyalty:edit':       ['Points are a balance the business owes.', '积分是企业的负债。'],
  'topup:edit':         ['Sets what a customer pays and the credit they get for it.', '设定顾客支付金额与到账余额。'],
  'delivery:edit':      ['Sets what customers are charged to deliver.', '设定顾客的配送收费。'],
  'settings:payments':  ['Where the takings land.', '决定营收进入哪个账户。'],
};

// Section names. The registry's `section` is a bare grouping id ('quickstock'),
// not a thing to show anyone — so the names live here, once, and ship to the
// client with the catalog. Without this the role editor would need its own
// forty-entry map, which is precisely the kind of duplicate this pass removes.
//
// `dashboard` covers reports:view too, whose section deliberately isn't its key
// prefix — Reports is read as part of the dashboard, not as an area of its own.
const SECTIONS = {
  dashboard:    ['Dashboard', '概览'],
  orders:       ['Orders', '订单'],
  invoices:     ['Invoices', '发票'],
  finance:      ['Finance', '财务'],
  customers:    ['Customers', '顾客'],
  activity:     ['Stock ledger', '库存流水'],
  quickstock:   ['Quick Stock', '快速库存'],
  purchasing:   ['Purchasing', '采购'],
  materials:    ['Materials', '物料'],
  recipes:      ['Recipes', '食谱'],
  waste:        ['Waste', '损耗'],
  products:     ['Products', '产品'],
  categories:   ['Categories', '分类'],
  editor:       ['Page editor', '页面编辑器'],
  coupons:      ['Coupons', '优惠券'],
  flash:        ['Flash sales', '秒杀'],
  popups:       ['Pop-ups', '弹窗'],
  broadcasts:   ['Broadcasts', '广播'],
  sharing:      ['Share cards', '分享卡片'],
  social:       ['Social proof', '社交证明'],
  affiliate:    ['Affiliate', '分销'],
  loyalty:      ['Membership & points', '会员与积分'],
  topup:        ['Top-up packages', '充值套餐'],
  leaderboard:  ['Leaderboard', '排行榜'],
  voting:       ['Voting', '投票'],
  content:      ['Content pages', '内容页面'],
  media:        ['Media library', '媒体库'],
  reviews:      ['Reviews', '评价'],
  feedback:     ['Feedback', '反馈'],
  integrations: ['Channels & delivery', '渠道与配送'],
  delivery:     ['Delivery zones', '配送区域'],
  meituan:      ['Meituan', '美团'],
  eleme:        ['Eleme', '饿了么'],
  guanyi:       ['gzgrocery', '管易'],
  shipping:     ['Shipping & print', '物流与打印'],
  settings:     ['Shop settings', '店铺设置'],
  stores:       ['Stores', '门店'],
  team:         ['Team', '团队'],
  billing:      ['Billing', '账单'],
  ai:           ['AI brand studio', 'AI 品牌工作室'],
  diagnostics:  ['Diagnostics', '诊断'],
};

// Group names for the four IA buckets. Fuller than the rail's own words on
// purpose: a COLLAPSED group row has to stand on its own — "Run the shop ·
// 18 of 30 on" says what is inside it, "Run" does not.
const GROUPS = {
  run:     ['Run the shop', '运营'],
  sell:    ['Sell', '销售'],
  content: ['Content & inbox', '内容与收件箱'],
  setup:   ['Set up', '设置'],
};

const ALL_KEYS = CAPABILITIES.map(c => c.key);
const KEY_SET = new Set(ALL_KEYS);
// cap key → required feature entitlement (for the plan intersect).
const CAP_FEATURE = {};
for (const c of CAPABILITIES) if (c.feature) CAP_FEATURE[c.key] = c.feature;
// cap key → 'shows' | 'moves', for counting a role's money reach without
// walking the whole registry (the role editor does this on every keystroke).
const MONEY_KEYS = {};
for (const c of CAPABILITIES) if (c.money) MONEY_KEYS[c.key] = c.money;

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
    // Writes off what spoiled on their own shelf. Voiding is not theirs: it
    // removes a recorded loss from every total, so it sits with the owner.
    'waste:view', 'waste:record',
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
    // Damaged in transit, short-dated off the rack — recorded by whoever is
    // holding it. Voiding stays with the owner, as for store managers.
    'waste:view', 'waste:record',
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
//
// SINCE ROLES BECAME TENANT DATA this is no longer where a live operator's base
// set comes from — lib/roles.js reads the tenant's own `tenant_roles` row and
// hands it to resolveCaps as `baseCaps`. Two jobs remain, and both are load-
// bearing:
//   • the SEED. A tenant's four starting roles are stamped out of these presets,
//     which is why nothing changed on the deploy that introduced the table.
//   • the FAIL-OPEN FALLBACK. No row, no table, any error at all in the roles
//     read and resolution lands back here — so an unseeded tenant resolves
//     byte-for-byte as it did before any of this existed.
// It is therefore not dead code and must not be deleted with the migration.
function presetCapsFor(role) {
  if (role === 'owner') return ALL_KEYS.slice();
  const p = PRESETS[role];
  if (p === '*') return ALL_KEYS.slice();
  return Array.isArray(p) ? p.slice() : [];
}

// ── Effective resolution ───────────────────────────────────────────────────
// effective = (base ∪ grants) − revokes, ∩ entitled features; owner ⇒ ALL.
//   role        : tenant_users.role
//   baseCaps    : the role's OWN capability list, read from the tenant's
//                 tenant_roles row by lib/roles.js. Omit it and the base falls
//                 back to presetCapsFor(role) — which is what keeps this module
//                 pure, synchronous and tenant-free: the DB read happens one
//                 layer out, in lib/operator-caps.js, and the answer is passed
//                 in. Nothing here ever touches a database.
//   grants      : array of cap keys force-ON for this user (override)
//   revokes     : array of cap keys force-OFF for this user (override)
//   entitlements: { featureKey: bool } from lib/features.entitlements(); a cap
//                 whose feature is false is dropped. Omit/empty = entitled to all.
// Returns a sorted array of effective cap keys.
function resolveCaps({ role, baseCaps = null, grants = [], revokes = [], entitlements = null } = {}) {
  // Owner is absolute — overrides + entitlements never strip an owner. Checked
  // before baseCaps is even looked at: a tenant cannot narrow its own owner by
  // editing a row, which is the whole of decision 3.
  if (role === 'owner') return ALL_KEYS.slice();

  // A base list from the tenant's role record wins; otherwise the shipped preset.
  // Unknown keys are dropped here rather than trusted — a stored role record
  // outlives the registry entry of a capability that was later removed.
  const set = new Set(Array.isArray(baseCaps) ? baseCaps.filter(k => KEY_SET.has(k))
                                              : presetCapsFor(role));
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
  MONEY_NOTES,
  MONEY_KEYS,
  SECTIONS,
  GROUPS,
  presetCapsFor,
  resolveCaps,
  capSet,
  isKnown: (k) => KEY_SET.has(k),
  sect,
  viewsOf,
};
