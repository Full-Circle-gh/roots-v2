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

  // Counter till (前台收银) — the cashier-facing screen on a shop tablet
  // (public/till.html, served at /till). ONE capability, because the till has
  // exactly one power: ring a counter sale. There is no void button, no refund
  // button and no price override at the counter — prices come from
  // products.sell_price and the cashier cannot type over them. A second cap
  // (`till:void`) would be a tickbox in the role editor guarding a control that
  // does not exist, so it is not registered until that flow is built.
  //
  // REVERSING a counter sale is already somebody else's permission: it happens
  // on the backend Orders screen under `orders:refund`. A cashier holding only
  // this cap can sell all day and cannot undo a thing.
  //
  // SITS BESIDE ORDERS DELIBERATELY. A till sale is not a separate write path —
  // it POSTs the ordinary manual order (POST /api/retail-admin/orders,
  // fulfillment_type 'counter'), which lib/cap-routes.js already gates on
  // `orders:edit`. So this cap opens the SCREEN and `orders:edit` saves the
  // sale: a role granted one without the other gets a till whose Confirm
  // button 403s once the tenant turns rbac_enforce on. Both presets below that
  // carry it also carry orders:edit; the role editor cannot enforce a pair, so
  // this comment is where that pairing is written down.
  { key: 'till:use',         group: 'run', section: 'till',      labelEn: 'Open the counter till', labelCn: '使用前台收银', money: 'moves' },

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

  /* Recording what the kitchen made. ITS OWN KEY, and not folded into
     `quickstock:add`, because the two answer different questions about the same
     person: `quickstock:add` says they may put units on a shelf, and this says
     they may state what a batch YIELDED — including the part of it that never
     reached the shelf. An account that wants the shelf kept without keeping
     production figures grants the first and withholds this one. */
  { key: 'production:log',     group: 'run', section: 'production', labelEn: 'Record what was made',           labelCn: '登记生产批次' },

  { key: 'quickstock:add',     group: 'run', section: 'quickstock', labelEn: 'Quick Stock — add (kitchen)',   labelCn: '快速库存—加库存(后厨)', feature: 'kitchenAdd' },
  { key: 'quickstock:recount', group: 'run', section: 'quickstock', labelEn: 'Quick Stock — recount (store)', labelCn: '快速库存—盘点(门店)', feature: 'quickStock' },

  // Transfers between locations, and asking the kitchen to make something.
  // THREE KEYS RATHER THAN ONE, because the three jobs divide between Roots'
  // locations rather than between people at one of them: Yuexiu raises requests,
  // Tianhe pulls and dispatches them, and both count deliveries in. One key
  // covering all three would mean anyone who can count a box arriving can also
  // send a van out — fine while Tianhe is one team and wrong the day it is not.
  // Asking the kitchen rides with `request`: it is a request, it just goes to a
  // pot instead of a shelf, and it moves no stock either way.
  { key: 'restock:request', group: 'run', section: 'restock', labelEn: 'Ask for stock (and ask the kitchen)', labelCn: '发起补货申请(含向厨房下单)' },
  { key: 'restock:pick',    group: 'run', section: 'restock', labelEn: 'Pick and dispatch a run',             labelCn: '拣货与发货' },
  { key: 'restock:receive', group: 'run', section: 'restock', labelEn: 'Count a delivery in',                 labelCn: '收货点数' },
  // The other end of a kitchen request: whoever MAKES it. Its own key because
  // it is its own job and its own people — at Roots the kitchen shares Tianhe's
  // building and does not share its staff. Holding this and nothing else scopes
  // an operator to kitchen requests only: they cannot dispatch a van, which is
  // what `restock:pick` is for, and the route enforces that rather than trusting
  // the screen to hide it.
  { key: 'restock:fulfil',  group: 'run', section: 'restock', labelEn: 'Work the kitchen queue',               labelCn: '处理厨房制作队列' },

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
  // THE MASTERLIST AND ITS PRICES ARE TWO PERMISSIONS, for the reason waste:costs
  // gives above and with the same shape (Ash, 2026-09-03). `materials:view` was
  // marked money:'shows' because the list carries two money columns — Buy price
  // and Cost per unit — so the warehouse and store_manager presets read what
  // every supplier charges and the cost basis of every margin. A warehouse
  // operator can no longer see what a dropped jar cost; leaving them every
  // ingredient's buy price was the same fact by another door.
  //
  // `materials:costs` also gates SETTING a price, not just reading one: you
  // cannot change what you cannot see, and a form that omits the field must not
  // silently write a zero over it (routes/retail-materials.js carries the
  // existing value through instead).
  { key: 'materials:view',     group: 'run', section: 'materials',  labelEn: 'View materials',                   labelCn: '查看物料' },
  { key: 'materials:costs',    group: 'run', section: 'materials',  labelEn: 'See material costs & buy prices',   labelCn: '查看物料成本与采购价', money: 'shows' },
  // KEEPS ITS MARKER, and not by oversight. Cost per unit is DERIVED from the
  // buy price AND the pack size — so an editor without materials:costs still
  // moves every margin by changing pack_contents_qty, without ever touching a
  // price. Halving a recorded pack doubles the cost of everything made from it.
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
  // SEEING THE LEDGER AND SEEING WHAT IT COST ARE TWO PERMISSIONS (Ash,
  // 2026-09-02). They used to be one: `waste:view` carried money:'shows'
  // because "waste is totalled in money", so anyone who could open the screen
  // read the cost — including the warehouse and store_manager presets, whose
  // whole job is recording what spoiled. They record the loss; what it cost
  // the business is a different question with a different audience, and an
  // owner must be able to answer it per person.
  //
  // `waste:view` is now money-free: a ledger of what was lost, how much of it
  // and why, which is exactly what the person holding the tray needs.
  // `waste:costs` is the money, and it is OFF in the two floor presets below.
  { key: 'waste:view',         group: 'run', section: 'waste',      labelEn: 'View waste',                       labelCn: '查看损耗' },
  { key: 'waste:costs',        group: 'run', section: 'waste',      labelEn: 'See what waste cost',              labelCn: '查看损耗成本', money: 'shows' },
  { key: 'waste:record',       group: 'run', section: 'waste',      labelEn: 'Record waste',                     labelCn: '登记损耗' },
  { key: 'waste:void',         group: 'run', section: 'waste',      labelEn: 'Void a waste entry',               labelCn: '作废损耗记录', money: 'moves' },

  // ── SELL ─────────────────────────────────────────────────────────────
  // THE CATALOGUE AND ITS COSTS ARE TWO PERMISSIONS — the third and widest of
  // the three bundles §7 of docs/tacet-waste-mobile-options.md left open, after
  // waste and materials (Ash, 2026-09-03).
  //
  // `products:view` was marked money:'shows' with the note "The product list
  // shows unit cost and margin", and it is held by FIVE presets — including
  // `staff`, commented "no money-sensitive powers", and `marketing`, commented
  // "no operations/money". Both read a margin percentage on every row.
  //
  // SELL PRICE IS NOT WHAT MOVES. What a customer is charged is on the
  // storefront; anyone who may open the catalogue may read it, and it stays.
  // What goes is the pair that is nobody's business but the owner's: `unit_cost`
  // — what we pay — and the margin computed from it.
  { key: 'products:view',    group: 'sell', section: 'products',   labelEn: 'View products',        labelCn: '查看产品' },
  { key: 'products:costs',   group: 'sell', section: 'products',   labelEn: 'See product cost & margin', labelCn: '查看产品成本与毛利', money: 'shows' },
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
  'materials:costs':    ['Materials show cost per unit and what the supplier charges.', '物料显示单位成本与供应商价格。'],
  'materials:edit':     ['A material\u2019s cost carries into every recipe and every margin.', '物料成本会带入每个食谱与每项毛利。'],
  'recipes:view':       ['A recipe is a cost.', '食谱本身就是成本。'],
  'recipes:edit':       ['Changes the cost every product built from it reports.', '改动会影响以此制作的所有产品成本。'],
  'till:use':           ['A sale rung at the till takes payment and books revenue.', '在收银台开单即为收款并计入营收。'],
  'waste:costs':        ['Waste is totalled in money.', '损耗按金额合计。'],
  'waste:void':         ['Voiding removes a recorded loss from every total.', '作废会将已记录的损耗从所有合计中移除。'],
  'products:costs':     ['The product list shows unit cost and margin.', '产品列表显示单位成本与毛利。'],
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
  till:         ['Counter till', '前台收银'],
  invoices:     ['Invoices', '发票'],
  finance:      ['Finance', '财务'],
  customers:    ['Customers', '顾客'],
  activity:     ['Stock ledger', '库存流水'],
  production:   ['Production', '生产'],
  quickstock:   ['Quick Stock', '快速库存'],
  restock:      ['Transfers & kitchen requests', '调拨与厨房下单'],
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

  // Generalist floor staff — runs the shop day-to-day, no setup powers. Owner
  // ticks up refunds / revenue / exports per person.
  //
  // THE ONE MONEY-MARKED CAP HERE IS `till:use`, and the older comment on this
  // preset ("no money-sensitive … powers") is amended rather than left standing.
  // Taking payment across the counter is the shop floor's job — a Shop floor
  // role that cannot open the till is not a shop floor role. It is also the
  // narrowest money power in the registry: ringing a sale at the marked price.
  // Reversing one is still `orders:refund`, which this preset does not hold.
  staff: [
    'dashboard:view',
    'orders:view', 'orders:edit',
    'till:use',
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
    // The counter in their own store. LISTED, not sect()'d, for the reason the
    // warehouse preset gives below: a section that may grow a second verb
    // (till:void, when it is built) must not hand it over by itself.
    'till:use',
    'quickstock:recount',
    // Their store's end of a transfer: ask for stock, count in what arrives —
    // and PICK, because a request now runs in either direction (#264). When
    // Tianhe asks Yuexiu for a case, Yuexiu is the one who pulls it off the
    // shelf; a store that can be asked has to be able to answer.
    'restock:request', 'restock:pick', 'restock:receive',
    'products:view', 'products:edit', 'categories:view',
    'stores:view',
    // Store managers receive inbound stock but don't create POs or edit suppliers.
    'purchasing:view', 'purchasing:receive',
    // Looks a material up (what unit, whose supplier); doesn't own the masterlist.
    'materials:view',
    // Writes off what spoiled on their own shelf. Voiding is not theirs: it
    // removes a recorded loss from every total, so it sits with the owner.
    // NO `waste:costs`, deliberately — they record the loss, they do not read
    // what it cost the business. An owner can tick it on per person.
    'waste:view', 'waste:record',
  ],

  // ── Dashboard positions (2026-07) — each maps to a fixed dashboard view ──
  // (see retail-admin 03-dashboard.js dashPos*). Store/kitchen keep their own.

  // Stock and shipments only — no revenue, no orders, no customers.
  warehouse: [
    'dashboard:view',
    ...sect('activity'),                       // stock ledger view + export
    'quickstock:recount', 'quickstock:add',
    // TRANSFERS, WHICH THIS ROLE'S OWN DESCRIPTION HAS ALWAYS CLAIMED —
    // "Deliveries, counts and stock pushes". The three capabilities were added
    // to the registry when the transfer screens moved to Tacet and no preset
    // gained them, so the role built to pick a run, send it and count one in
    // held none of the three. Same defect the kitchen preset had with
    // `restock:fulfil` (see the note on it below), from the same change.
    // NOT `restock:fulfil`: making what was asked for is the kitchen's job, and
    // holding fulfil WITHOUT pick is what confines a kitchen operator to kitchen
    // requests (routes/restock.js _kitchenScopedSession) — a role holding both
    // is not confined, which is right, and one holding only fulfil is.
    'restock:request', 'restock:pick', 'restock:receive',
    'products:view', 'categories:view',
    'stores:view',
    ...sect('purchasing'),                     // suppliers, POs, receiving
    // The materials masterlist — purchasing's sibling. LISTED, not sect()'d:
    // sect('materials') means "every verb in this section", so the day
    // `materials:costs` was added it would have handed this role every
    // supplier's buy price back, silently, as a side effect of a change made
    // to take it away. A preset that grows by itself is the wrong shape for a
    // section that now holds a money key.
    'materials:view', 'materials:edit',
    // Damaged in transit, short-dated off the rack — recorded by whoever is
    // holding it. Voiding stays with the owner, as for store managers, and so
    // does `waste:costs`: this role sees no money anywhere else in the product
    // and waste was the one screen that leaked it.
    'waste:view', 'waste:record',
    // May push stock to the channels after a restock; mapping stays setup-only.
    'meituan:view', 'meituan:sync', 'eleme:view', 'eleme:sync', 'guanyi:view', 'guanyi:sync',
  ],

  // ── The books, and nothing else (audit E-11) ─────────────────────────────
  // Every shipped preset before this one either saw Finance because it saw
  // EVERYTHING (owner / deputy / manager) or did not see it at all: `staff`,
  // `store_manager`, `warehouse`, `customer_service` and `dispatch` held no
  // `finance:*` and no `reports:*` between them. A merchant whose accountant
  // needed the ledger and the supplier invoices — and nothing else — had to
  // make them a manager, which hands over the catalogue, the customers, the
  // team page and every setting in the product.
  //
  // WHAT IT READS: the ledger, the revenue reports, the supplier invoices and
  // the purchase orders behind them, and the exports of each. Money-marked
  // capabilities are the POINT of this role, not an oversight.
  //
  // WHAT IT DOES NOT: `finance:record` is here (a bookkeeper types the rows —
  // §36 calls Transactions "the only surface where a person types") but
  // `purchasing:edit` is NOT. Reading what was bought is bookkeeping; deciding
  // what to buy is not, and committing spend is the one money power an
  // accountant should not have by default. Nor are orders, customers, products
  // or any setting: an accountant who can edit a price is a different job.
  //
  // `dashboard:view` is included because Reports lives behind it, and
  // `reports:view` without the section that holds it is a capability pointing
  // at a screen the holder cannot reach.
  bookkeeper: [
    'dashboard:view', 'reports:view',
    ...sect('finance'),
    'invoices:view', 'invoices:export',
    'purchasing:view', 'purchasing:invoices',
    // The masterlist behind a purchase line, and what it cost — a supplier
    // invoice cannot be checked against a PO without them. `materials:edit` is
    // deliberately absent: reading a buy price is the job, changing one is not.
    'materials:view', 'materials:costs',
    // Stock movements as a record, for reconciling waste and shrinkage against
    // the books. View and export; recording a movement stays with the shop.
    ...sect('activity'),
    'waste:view', 'waste:costs',
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

  // The two restricted stockers.
  //
  // KITCHEN GAINS restock:fulfil, AND WITHOUT IT #262 SHIPPED A QUEUE ITS OWN
  // ROLE COULD NOT OPEN. That change added the capability to the registry and
  // mapped the routes to it, but left this list at 'quickstock:add' — so the
  // kitchen queue was gated on a capability no kitchen operator held, and the
  // people it was built for saw nothing. `fulfil` WITHOUT `pick` is also what
  // _kitchenScopedSession reads to confine them to kitchen requests, so the
  // grant is what makes the confinement work, not what widens it: an operator
  // holding neither is not scoped, and would have been read as a full one.
  // `production:log` joins them for the same reason `restock:fulfil` did, and
  // the lesson is the one #262 taught: a capability added to the registry and
  // mapped to routes but granted to nobody is a screen its own role cannot
  // open. The migration below (kitchen_role_can_log_production_v1 in
  // database.js) is what reaches tenants whose kitchen role was seeded before
  // this line — tenant_roles is seeded INSERT OR IGNORE, so changing the preset
  // alone reaches new tenants only.
  kitchen:     ['quickstock:add', 'restock:fulfil', 'production:log'],
  // store_stock is the shelf clerk, locked to the stock app — which is exactly
  // where "Ask for stock" and "Count a delivery in" live. The launcher has
  // offered them both tiles since #267; these are the capabilities behind them.
  // No `pick`: dispatching a run to another location is the manager's call.
  store_stock: ['quickstock:recount', 'restock:request', 'restock:receive'],

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
