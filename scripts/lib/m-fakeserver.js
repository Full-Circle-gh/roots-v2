/**
 * A fake backend for public/m.html, as a string of browser JS.
 *
 * Every visual check before this one photographed the app with no server, so
 * every screen showed its offline branch — which proved the empty and failed
 * states look right and proved nothing at all about the states an operator
 * actually spends the day in. This stubs window.fetch with one plausible
 * answer per endpoint, so a screenshot shows the populated screen.
 *
 * The shapes come from routes/*.js, not from what the phone happens to read:
 * a fake server that answers in the phone's own vocabulary would hide exactly
 * the bugs this exists to find.
 */
'use strict';

const D = {
  '/config': {
    currency: { symbol: '¥' },
    brand: { me_footer: { wordmark_text: 'Roots' } },
    features: { membership: 1, affiliate: 1, reviews: 1, feedback: 1, socialProof: 1, faq: 1, quickStock: 1, kitchenAdd: 1 },
    roots_club: { tiers: [
      { key: 'seed', name_en: 'Seed', name_cn: '种子', threshold: 0, points_mult: 1, perks_en: ['5% off your first order', 'Member newsletter'], perks_cn: ['首单 5% 折扣', '会员通讯'] },
      { key: 'sprout', name_en: 'Sprout', name_cn: '幼苗', threshold: 500, points_mult: 1.2, perks_en: ['10% off all orders', 'Free shipping ¥299+'], perks_cn: ['全场 10% 折扣', '满 ¥299 包邮'] },
      { key: 'tree', name_en: 'Tree', name_cn: '大树', threshold: 5000, points_mult: 2, perks_en: ['20% off all orders', 'Birthday gift'], perks_cn: ['全场 20% 折扣', '生日礼物'] },
    ] },
    sharing: { home: '/api/retail-admin/media/1', homeTitle: { en: 'Roots — plant-based grocery', cn: 'Roots — 植物基杂货' } },
    delivery: { sameDayCutoffMinutes: 20, holidayMode: false },
    popups: { list: [
      { id: 'p1', name: 'Autumn promo', enabled: true, title_en: '20% off this week', title_cn: '本周 8 折', body_en: 'Every plant milk, until Sunday.', body_cn: '全场植物奶，仅至周日。', pages: ['home', 'shop'], frequency: 'once', cta_label_en: 'Shop now', cta_label_cn: '去逛逛', cta_target: '/pages/shop/index', start_at: '2026-08-01', end_at: '2026-12-01' },
      { id: 'p2', name: 'Holiday notice', enabled: true, title_en: 'Closed Mid-Autumn', title_cn: '中秋歇业', pages: ['all'], frequency: 'daily', end_at: '2026-07-01' },
    ] },
    faq: {
      categories: [{ id: 'orders', en: 'Orders', cn: '订单' }, { id: 'delivery', en: 'Delivery', cn: '配送' }],
      questions: [
        { id: 'q1', cat: 'orders', q_en: 'Where is my order?', q_cn: '我的订单在哪里？', a_en: 'Track it under Me → Orders in the mini app.', a_cn: '在小程序“我的 → 订单”中查看。' },
        { id: 'q2', cat: 'delivery', q_en: 'Do you deliver to my district?', q_cn: '你们配送到我这里吗？', a_en: 'Enter your address at checkout and we will tell you.', a_cn: '结账时填写地址即可查看。' },
      ],
    },
    legal: { terms: { body_en: 'These terms govern your use of the Roots store.', body_cn: '本条款适用于 Roots 商店。', updated_at: '2026-05-01' },
             privacy: { body_en: 'We keep only what an order needs.', body_cn: '我们只保留订单所需的信息。', updated_at: '2026-05-01' } },
    about: { content: { kicker_en: 'Our story', kicker_cn: '我们的故事', manifesto_en: 'We started with one shelf of ferments and a very small van.', manifesto_cn: '我们从一架发酵food和一辆小货车开始。', founder_name_en: 'Mei Chen', founder_name_cn: '陈玫', founder_title_en: 'Founder', founder_title_cn: '创始人', founder_quote_en: 'Good food should not be a special occasion.', founder_quote_cn: '好食物不该只在特别的日子。' } },
  },
  '/dashboard': { kpi: { revenue: 3182.5, orders: 19, new_customers: 4, sessions: 412, conversion_rate: 4.6, refunded_orders: 1, refund_rate: 5.3 },
    baseline: { revenue: 2840, orders: 16, new_customers: 5 },
    new_vs_returning: { buyers: 17, returning_buyers: 9 },
    funnel: { paid: 7, preparing: 3 } },
  // `waiting_since` — the field oldestMins actually reads. Sending placed_at
  // made every fire lose its "oldest 2d" line, which looked like the app
  // dropping it and was this file getting the column name wrong.
  '/dashboard/ops': {
    unhandled: { count: 3, items: [{ waiting_since: '2026-08-22 07:10:00' }, { waiting_since: '2026-08-22 09:40:00' }] },
    refunds: { count: 1, items: [{ waiting_since: '2026-08-22 08:00:00' }] },
    awaiting_restock: { count: 2, items: [{ waiting_since: '2026-08-20 12:00:00' }] },
    invoices: { count: 2, items: [{ waiting_since: '2026-08-21 09:00:00' }] },
    payment_unconfirmed: { count: 2, unread: 1, items: [{ waiting_since: '2026-08-22 10:00:00' }] },
    out_of_stock: { count: 2 }, low_stock: { count: 5 },
  },
  '/dashboard/activity': { rows: [
    { at: '2026-08-22 09:41:00', kind: 'order_paid', ref_type: 'order', ref_id: 412, payload: { order_no: 'RT-…047', total: 312, customer: 'Chen Meiling' } },
    { at: '2026-08-22 09:12:00', kind: 'stock_out', ref_type: 'product', ref_id: 5, payload: { name: 'Carrots' } },
  ] },
  '/order-status-counts': { pending_payment: 2, paid: 7, preparing: 3, dispatched: 5, awaiting_restock: 2, refunds_open: 1 },
  '/order-channel-counts': { all: 31, wechat: 20, web: 6, meituan: 3, gzgrocery: 1, manual: 1 },
  '/stores': [ { id: 1, code: 'tianhe', name_en: 'Tianhe store', name_cn: '天河店', city: 'Guangzhou', district: 'Tianhe', address: '12 Linhe Rd', lat: 23.13, lng: 113.33, is_active: 1 },
               { id: 2, code: 'panyu', name_en: 'Panyu store', name_cn: '番禺店', city: 'Guangzhou', district: 'Panyu', address: '8 Shiqiao Rd', is_active: 1 } ],
  '/setup': { percent: 60, requiredDone: 3, requiredTotal: 5, allDone: false,
    steps: [{ key: 'store', done: true, count: 2 }, { key: 'products', done: true, count: 128 },
            { key: 'payment', done: true, method: 'both' }, { key: 'fulfillment', done: false },
            { key: 'open', done: false }],
    optional: [{ key: 'wechat', done: false }, { key: 'brand', done: true }] },
  '/delivery-zones': [
    { id: 1, is_active: 1, zone_type: 'gz_district', province_cn: '广东省', name_en: 'Tianhe', same_day_allowed: 1 },
    { id: 2, is_active: 1, zone_type: 'gz_district', province_cn: '广东省', name_en: 'Yuexiu', same_day_surcharge: 5 },
    { id: 3, is_active: 1, zone_type: 'city', province_cn: '江苏省', name_en: 'Nanjing' },
    { id: 4, is_active: 0, zone_type: 'city', province_cn: '浙江省', name_en: 'Hangzhou' },
  ],
  '/inventory/geocode-status': { tencent_maps_configured: true, provider: 'amap', last_error: null,
    stores: { total: 2, missing: 1, geocoded: 1 }, addresses: { total: 184, missing: 6, geocoded: 178 } },
  '/printer': { auto_print: true },
  '/fapiao-settings': { autoIssue: false },
  '/alipay-manual': { enabled: true, account: 'Roots Ltd' },
  '/channel-status': { channels: [
    { channel: 'mini_app', integrated: true, cardOpen: true, stores: [{ name_en: 'Tianhe', open: true }] },
    { channel: 'meituan', integrated: true, cardOpen: false, stores: [{ name_en: 'Tianhe', open: false }] },
    { channel: 'web', integrated: true, cardOpen: true, stores: [] } ] },
  '/sales/summary': { channels: { wechat: { orders: 20, revenue: 2100 }, web: { orders: 6, revenue: 640 }, meituan: { orders: 3, revenue: 260 } } },
  '/tier-counts': { seed: 186, sprout: 44, tree: 12 },
  '/topup-packages': [ { id: 1, amount: 200, bonus_points: 20, title_en: 'Starter', title_cn: '入门', is_active: 1 },
                       { id: 2, amount: 500, bonus_points: 80, title_en: 'Regular', title_cn: '常用', is_active: 1 } ],
  '/leaderboard/preview': { config: { enabled: true, title_en: 'Top growers', title_cn: '排行榜', metric: 'lifetime_spend', period: 'month', top_n: 20, reveal_mode: 'first_char' },
    revealed_entries: [{ rank: 1, name: 'C***', value: 6240 }, { rank: 2, name: 'S***', value: 4180 }, { rank: 3, name: 'Z***', value: 2260 }] },
  '/polls': [
    { id: 1, question_en: 'Next flavour', question_cn: '下款口味', status: 'open', reward_points: 5, is_featured: 1, closes_at: '2026-08-30 12:00:00', total_votes: 312,
      options: [{ id: 11, label_en: 'Matcha oat', label_cn: '抹茶燕麦', votes: 193 }, { id: 12, label_en: 'Black sesame', label_cn: '黑芝麻', votes: 104 }, { id: 13, label_en: 'Yuzu', label_cn: '柚子', votes: 15 }] },
    { id: 2, question_en: 'Opening hours', question_cn: '营业时间', status: 'closed', winner_option_id: 21, total_votes: 80,
      options: [{ id: 21, label_en: 'Until 22:00', label_cn: '至 22:00', votes: 60 }, { id: 22, label_en: 'Until 20:00', label_cn: '至 20:00', votes: 20 }] },
  ],
  '/purchases': [
    { id: 4, po_number: 'RPO-0004', supplier: 'Fresh Co.', store_name_en: 'Tianhe', store_name_cn: '天河店', date: '2026-08-14', delivery_date: '2026-08-16', status: 'Ordered', line_count: 6, received_lines: 0, total_cost: 3240 },
    { id: 5, po_number: 'RPO-0005', supplier: 'Oat Works', date: '2026-08-20', delivery_date: '2026-09-30', status: 'Ordered', line_count: 2, received_lines: 0, total_cost: 1880 },
    { id: 6, po_number: 'RPO-0006', supplier: 'Nut House', date: '2026-08-10', status: 'Delivered', line_count: 3, received_lines: 3, total_cost: 960 },
  ],
  '/category-tree': [
    { id: 'dry', name: 'Dry & Pantry', name_cn: '干货 & 杂货', subs: [{ id: 'nuts', name: 'Nuts & Seeds', name_cn: '坚果 & 籽' }, { id: 'jams', name: 'Jams', name_cn: '果酱' }] },
    { id: 'fresh', name: 'Fresh & Deli', name_cn: '鲜食 & 熟食', subs: [{ id: 'milks', name: 'Plant Milks', name_cn: '植物奶' }] },
    { id: 'drinks', name: 'Drinks', name_cn: '饮品', subs: [] },
  ],
  '/category-counts': { counts: { dry: { n: 14, published: 11 }, nuts: { n: 9, published: 9 }, jams: { n: 5, published: 0 }, fresh: { n: 8, published: 8 }, milks: { n: 8, published: 8 }, drinks: { n: 0, published: 0 } } },
  '/media/list': { rows: [{ id: 1, url: '/api/retail-admin/media/1', name: 'hero.jpg', size: 184000, created_at: '2026-08-20 10:00:00' }], total: 1 },
  '/meituan/status': { queuePending: 107, queueFailed: 0, queueOldestMin: 1140, mappedCount: 212, lastOrder: [{ imported_at: '2026-08-22 09:00:00', store_code: 'tianhe' }] },
  '/meituan/orders': [{ id: 1, order_no: 'MT-88213', recipient_name: 'Li Na', total: 95, placed_at: '2026-08-22 13:15:00', store_name_en: 'Tianhe', store_name_cn: '天河店', items: [1, 2] }],
  '/guanyi/pickups': { mode: 'live', summary: { flaggedCount: 1, appliedUnits24h: 11, appliedEvents24h: 4 },
    flagged: [{ id: 9, product_id: 5, name_en: 'Carrots', name_cn: '胡萝卜', product_sku: 'CR-01', baseline_qty: 40, observed_qty: 10, drift: -30, inferred_pickup: 30, current_qty: 38, created_at: '2026-08-22 08:00:00' }],
    recent: [{ product_id: 7, inferred_pickup: 3, created_at: '2026-08-22 09:00:00', name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', product_sku: 'OM-1L' }] },
  '/cms/layout': { page: 'home', dirty: true,
    live: [{ id: 'a', type: 'hero_banner', title_en: 'Autumn drop', title_cn: '秋季上新' }, { id: 'b', type: 'product_grid' }, { id: 'c', type: 'flash_sale_strip' }],
    draft: [{ id: 'a', type: 'hero_banner' }, { id: 'b', type: 'product_grid' }, { id: 'c', type: 'flash_sale_strip' }, { id: 'd', type: 'coupon_block' }] },
  '/affiliate/settings': { shareImage: '/api/retail-admin/media/4', shareTitle: { en: 'Join me on Roots', cn: '来 Roots 一起买' }, rewardAmount: 20 },
};

// Endpoints whose answer carries meta beside `data` (api() unwraps `data`;
// apiRaw() gets the whole envelope), so both readers see the right thing.
const ENVELOPES = {
  '/orders?': () => ({ data: ORDERS, meta: { total: 31 } }),
  '/customers?': (u) => (u.indexOf('pageSize=1&') >= 0
    ? { data: [], segments: { all: 242, new_week: 6, sleeping: 31, blocked: 1 }, returning: { buyers: 17, returners: 9 }, customers_on_file: 242 }
    : { data: CUSTOMERS, meta: { total: 242 } }),
  '/invoices': () => ({ data: INVOICES, counts: { requested: 1, issued: 2 } }),
  '/activity?': () => ({ total: 3, rows: ACTIVITY, summary: ACT_SUMMARY, digest: ACT_DIGEST }),
  '/affiliate/referrals?': () => ({ data: REFERRALS, page: 1, pageSize: 50, total: 3,
    summary: { total: 24, converted: 9, paid_out: 180, lifetime_paid: 42.5, still_earning: 6, joined_this_month: 5, joined_last_month: 3 } }),
  '/topup-transactions?': () => ({ data: TOPUPS }),
};

// Column names come from the real SELECT in routes/retail.js, not from what the
// phone happens to read. A fake server answering in the phone's own vocabulary
// would hide exactly the bugs this exists to find — the first draft of this
// file sent `customer_name` and every row rendered a dash, which looked like an
// app bug and was not.
const ORDERS = [
  { id: 412, order_no: 'RT-…047', channel: 'wechat', recipient_name: 'Chen Meiling', nickname: 'Chen Meiling',
    recipient_phone: '138****2841', total: 312, placed_at: '2026-08-22 14:22:00', status: 'paid',
    ship_city: 'Guangzhou', ship_district: 'Tianhe', store_name_en: 'Tianhe store', store_name_cn: '天河店',
    item_count: 3, unit_count: 4, payment_method: 'wechat', fulfillment_type: 'delivery',
    promised_ship_date: '2026-08-23', subtotal: 300, shipping_fee: 12, seen_at: '2026-08-22 14:25:00' },
  { id: 411, order_no: 'RT-…046', channel: 'web', recipient_name: 'Sarah Lim', nickname: 'Sarah Lim',
    total: 186, placed_at: '2026-08-22 14:07:00', status: 'preparing',
    ship_city: 'Guangzhou', ship_district: 'Yuexiu', store_name_en: 'Tianhe store', store_name_cn: '天河店',
    item_count: 1, unit_count: 2, payment_method: 'wechat', fulfillment_type: 'delivery',
    subtotal: 186, seen_at: '2026-08-22 14:10:00' },
  { id: 410, order_no: 'RT-…045', channel: 'wechat', recipient_name: 'Wang Zhiqiang', total: 458,
    placed_at: '2026-08-22 13:41:00', status: 'dispatched', ship_pickup: true, fulfillment_type: 'pickup',
    store_name_en: 'Panyu store', store_name_cn: '番禺店', item_count: 6, unit_count: 6,
    payment_method: 'wechat', subtotal: 458, seen_at: '2026-08-22 13:45:00' },
  { id: 409, order_no: 'RT-…044', channel: 'meituan', recipient_name: 'Li Na', total: 95,
    placed_at: '2026-08-22 13:15:00', status: 'dispatched', ship_city: 'Guangzhou', ship_district: 'Haizhu',
    item_count: 3, unit_count: 3, fulfillment_type: 'delivery', channel_status: 'delivering', channel_eta: 12,
    subtotal: 95, seen_at: '2026-08-22 13:20:00' },
  { id: 408, order_no: 'RT-…043', channel: 'wechat', recipient_name: 'Zhang Wei', total: 726,
    placed_at: '2026-08-22 11:50:00', status: 'pending_payment', ship_city: 'Shenzhen', ship_district: 'Nanshan',
    item_count: 8, unit_count: 12, fulfillment_type: 'delivery', has_alipay_proof: 1,
    alipay_ocr_verdict: 'mismatch', subtotal: 700, shipping_fee: 26 },
];

// Column names from the real SELECT: lifetime_spend, orders_count (subquery
// alias), last_login_at — not `total_spent` / `last_seen`, which the first
// draft invented and which made every customer read "¥0 · never signed in".
const CUSTOMERS = [
  { id: 1, nickname: 'Chen Meiling', phone: '138****2841', tier_key: 'tree', orders_count: 24, lifetime_spend: 6240, last_login_at: '2026-08-22 09:40:00', created_at: '2025-04-02 10:00:00', points_balance: 2410, balance: 82, channel: 'wechat' },
  { id: 2, nickname: 'Sarah Lim', phone: '159****7723', tier_key: 'tree', orders_count: 18, lifetime_spend: 4180, last_login_at: '2026-08-21 19:12:00', created_at: '2025-06-11 10:00:00', points_balance: 2050, balance: 0, channel: 'web' },
  { id: 3, nickname: 'Zhang Wei', phone: '186****0092', tier_key: 'sprout', orders_count: 9, lifetime_spend: 2260, last_login_at: '2026-08-18 11:02:00', created_at: '2025-09-01 10:00:00', points_balance: 1180, balance: 12, channel: 'wechat' },
  { id: 4, nickname: 'Wang Zhiqiang', phone: '137****5510', tier_key: 'seed', orders_count: 3, lifetime_spend: 812, last_login_at: null, created_at: '2026-08-20 10:00:00', points_balance: 420, balance: 0, channel: 'manual' },
];

const PRODUCTS = [
  { id: 41, name_en: 'Organic carrots', name_cn: '有机胡萝卜', sku: '10231', sell_price: 18, effective_stock: 42, is_published: 1, top_category: 'Fresh & Deli', has_blocks: 1 },
  { id: 42, name_en: 'Oat milk 1L', name_cn: '燕麦奶 1L', sku: '10188', sell_price: 32, effective_stock: 8, is_published: 1, top_category: 'Drinks' },
  { id: 43, name_en: 'Mixed nuts', name_cn: '混合坚果', sku: '10450', sell_price: 45, effective_stock: 0, is_published: 1, top_category: 'Dry & Pantry' },
  { id: 44, name_en: 'Sourdough', name_cn: '酸种面包', sku: '10012', sell_price: 28, effective_stock: 15, is_published: 0, top_category: 'Fresh & Deli' },
  { id: 45, name_en: 'Cold brew', name_cn: '冷萃咖啡', sku: '10770', sell_price: 22, effective_stock: 60, is_published: 1, top_category: 'Drinks' },
  { id: 46, name_en: 'Almond butter', name_cn: '杏仁酱', sku: '10999', sell_price: 68, effective_stock: 0, is_published: 1, ship_from_supplier: 1, top_category: 'Dry & Pantry' },
];

// placed_at / invoice_issued_at / invoice_file_url — the names the SELECT at
// routes/retail.js `GET /api/retail-admin/invoices` returns. This block sent
// created_at and file_url, so every row's date rendered as an em dash and the
// issued rows offered no Open button, both of which looked like app bugs.
const INVOICES = [
  { id: 1, invoice_number: 'FP-2026-0451', order_no: 'RT-…047', total: 312, invoice_status: 'issued',
    invoice_type: 'company', invoice_title: 'Guangzhou Lin Trading Co.', invoice_tax_id: '91440101MA5X',
    invoice_email: 'ap@lintrading.cn', placed_at: '2026-08-21 10:00:00',
    invoice_issued_at: '2026-08-22 14:30:00', invoice_file_url: '/x.pdf' },
  { id: 2, invoice_number: 'FP-2026-0450', order_no: 'RT-…043', total: 726, invoice_status: 'issued',
    invoice_type: 'personal', invoice_title: 'Chen Meiling', placed_at: '2026-08-20 09:00:00',
    invoice_issued_at: '2026-08-22 12:02:00', invoice_file_url: '/x.pdf' },
  { id: 3, order_no: 'RT-…040', total: 390, invoice_status: 'requested',
    invoice_type: 'company', invoice_title: 'Panyu Oat Works Ltd', invoice_tax_id: '91440113MA7K',
    placed_at: '2026-08-21 18:00:00' },
];

const ACTIVITY = [
  { id: 3, ts_local: '2026-08-22 09:12:00', source: 'miniapp', store: 'Tianhe', sku: 'OM-1L', product: 'Oat milk 1L', delta: -2, balance_after: 10 },
  { id: 2, ts_local: '2026-08-22 08:40:00', source: 'meituan_tianhe', store: 'Tianhe', sku: 'SD-01', product: 'Sourdough', delta: -1, balance_after: 4 },
  { id: 1, ts_local: '2026-08-22 08:02:00', source: 'manual', store: 'Tianhe', sku: 'CR-01', product: 'Carrots', delta: -6, balance_after: 0, actor_label: 'Mei', note: 'binned, frost damage' },
];
const ACT_SUMMARY = [ { source: 'miniapp', events: 1, units_out: 2, units_in: 0 },
                      { source: 'meituan_tianhe', events: 1, units_out: 1, units_in: 0 },
                      { source: 'manual', events: 1, units_out: 6, units_in: 0 } ];
const ACT_DIGEST = { zeroed: [{ ts_local: '2026-08-22 08:02:00', product: 'Carrots', sku: 'CR-01', store: 'Tianhe' }],
  big: [{ ts_local: '2026-08-22 08:02:00', source: 'manual', product: 'Carrots', sku: 'CR-01', delta: -6, actor_label: 'Mei' }], zeroed_total: 1 };

const REFERRALS = [
  { id: 1, referrer_id: 1, invitee_id: 2, referrer_nickname: 'Chen Meiling', invitee_nickname: 'Ling Wu', invitee_phone: '138****1', code_used: 'CHEN24', status: 'ordered', reward_amount: 20, first_paid_order_id: 412, joined_at: '2026-08-01 10:00:00', lifetime_active: 1 },
  { id: 2, referrer_id: 1, invitee_id: 3, referrer_nickname: 'Chen Meiling', invitee_nickname: 'Wu Yaqi', code_used: 'CHEN24', status: 'joined', reward_amount: 0, joined_at: '2026-08-18 10:00:00' },
  { id: 3, referrer_id: 4, invitee_id: 5, referrer_nickname: 'Sarah Lim', invitee_nickname: 'Mo Chen', code_used: 'SAR7', status: 'void', voided_reason: 'duplicate account', reward_amount: 0, joined_at: '2026-07-02 10:00:00' },
];

const TOPUPS = [
  { id: 9, customer_id: 1, nickname: 'Chen Meiling', phone: '138****2841', amount: 200, bonus_points: 20, payment_method: 'wechat', status: 'success', created_at: '2026-08-22 09:00:00', paid_at: '2026-08-22 09:01:00' },
  { id: 8, customer_id: 3, nickname: 'Zhang Wei', phone: '186****0092', amount: 100, bonus_points: 5, payment_method: 'wechat', status: 'pending', created_at: '2026-08-22 08:00:00' },
  { id: 7, customer_id: 4, nickname: 'Wu Yaqi', amount: 50, bonus_points: 0, payment_method: 'wechat', status: 'failed', created_at: '2026-08-21 19:00:00' },
];

// type / value / min_subtotal / max_uses / title_en / title_cn — retail_vouchers'
// own columns (database.js, plus the added title_en/title_cn/is_public/
// auto_apply). This block invented discount_type, discount_value, min_order,
// total_limit and name_en, so every coupon rendered "¥0 off" with no rule and
// no title, which read as the app failing to map a voucher.
const VOUCHERS = [
  { id: 1, code: 'WELCOME10', title_en: 'First order', title_cn: '首单优惠', type: 'fixed_amount', value: 10, min_subtotal: 50, per_customer_limit: 1, used_count: 128, max_uses: null, expires_at: null, is_active: 1, is_public: 1, auto_apply: 1, auto_grant_signup: 1 },
  { id: 2, code: 'WEEKEND20', title_en: 'Weekend', title_cn: '周末活动', type: 'percent', value: 20, min_subtotal: 0, per_customer_limit: 0, used_count: 64, max_uses: 200, expires_at: '2026-08-27', is_active: 1, is_public: 1 },
  { id: 3, code: 'OVER200', title_en: 'Big baskets', title_cn: '大额订单', type: 'fixed_amount', value: 30, min_subtotal: 200, per_customer_limit: 1, used_count: 12, expires_at: '2026-07-31', is_active: 1 },
];

// flash_state / flash_stock_limit / flash_starts_at / flash_ends_at — the keys
// mapFlash actually reads.
const FLASH = [
  { id: 41, name_en: 'Lemongrass Kombucha', name_cn: '香茅康普茶', sku: '2-110', flash_price: 20, sell_price: 29,
    flash_state: 'active', flash_stock_limit: 120, flash_sold: 86,
    flash_starts_at: '2026-08-23 12:00:00', flash_ends_at: '2026-08-23 14:00:00', is_published: 1 },
  { id: 42, name_en: 'Coconut Flakes', name_cn: '椰子片', sku: '4-290', flash_price: 16, sell_price: 23,
    flash_state: 'upcoming', flash_starts_at: '2026-08-29 09:00:00', flash_ends_at: '2026-08-31 21:00:00', is_published: 1 },
];

const BROADCASTS = [
  { id: 1, status: 'sent', title_en: 'New arrivals this week', title_cn: '本周新品到货', body_en: 'Six new ferments landed this morning — the lemongrass kombucha is back.', body_cn: '六款新发酵品今早到店 — 香茅康普茶已回归。', audience: 'all', sent_at: '2026-08-19 10:00:00', recipient_count: 2140, deeplink: '/pages/shop/index' },
  { id: 2, status: 'scheduled', title_en: 'Double points weekend', title_cn: '会员积分翻倍', body_en: 'Two points on everything, Saturday and Sunday only.', body_cn: '周六周日全场积分翻倍。', audience: 'tier:tree,root', scheduled_at: '2026-08-24 09:00:00' },
];

const REVIEWS = [
  { id: 1, source: 'real', customer_name: 'Chen Meiling', rating: 5, comment: 'Fast delivery, carrots were super fresh!', created_at: '2026-08-22 12:00:00', is_visible: 1, product_name_en: 'Organic carrots', product_name_cn: '有机胡萝卜' },
  { id: 2, source: 'real', customer_name: 'Sarah Lim', rating: 4, comment: 'Great oat milk. Wish the cold brew came in larger sizes.', reply: 'Larger cold brew is coming next month — thank you!', created_at: '2026-08-22 09:00:00', is_visible: 1, product_name_en: 'Oat milk 1L', product_name_cn: '燕麦奶 1L' },
];

const FEEDBACK = [
  { id: 11, customer_id: 5, customer_name: 'Wu Yaqi', kind: 'bug', needs_reply: 1, replied: 0, reply_count: 2, message: 'Checkout kept the pickup time from my last order.', last_body: 'Still doing it on the newest build.', last_author: 'customer', page_context: 'checkout', app_version: '2.4.1', created_at: '2026-08-19 10:02:00', last_at: '2026-08-22 09:10:00' },
  { id: 12, customer_id: 3, customer_name: 'Zhang Wei', kind: 'message', needs_reply: 0, replied: 1, reply_count: 1, message: 'Sorry about the late delivery — here is 20 off.', last_body: 'Thanks, got it.', last_author: 'customer', created_at: '2026-08-20 12:00:00', last_at: '2026-08-21 08:00:00' },
];

/** The stub, as browser JS. */
function fakeServer() {
  const dump = (o) => JSON.stringify(o);
  return `
  (function(){
    var D=${dump(D)}, ORDERS=${dump(ORDERS)}, CUSTOMERS=${dump(CUSTOMERS)}, PRODUCTS=${dump(PRODUCTS)},
        INVOICES=${dump(INVOICES)}, ACTIVITY=${dump(ACTIVITY)}, ACT_SUMMARY=${dump(ACT_SUMMARY)},
        ACT_DIGEST=${dump(ACT_DIGEST)}, REFERRALS=${dump(REFERRALS)}, TOPUPS=${dump(TOPUPS)},
        VOUCHERS=${dump(VOUCHERS)}, FLASH=${dump(FLASH)}, BROADCASTS=${dump(BROADCASTS)},
        REVIEWS=${dump(REVIEWS)}, FEEDBACK=${dump(FEEDBACK)};
    function body(u){
      if(u.indexOf('/api/backend/me')>=0) return {user:{id:1,username:'mei',displayName:'Mei Chen',role:'owner',
        tenant:{id:1,name:'Roots',entitlements:{}}}};
      var p=u.replace(/^.*\\/api\\/retail-admin/,'');
      if(p.indexOf('/orders?')===0) return {success:true,data:ORDERS,meta:{total:31}};
      if(/^\\/orders\\/\\d+$/.test(p)) return {success:true,data:Object.assign({},ORDERS[0],{
        items:[{name_en:'Organic carrots 500g',name_cn:'有机胡萝卜 500g',qty:1,unit_price:18,line_total:18},
               {name_en:'Oat milk 1L',name_cn:'燕麦奶 1L',qty:2,unit_price:32,line_total:64}],
        subtotal:300, delivery_fee:12, ship_name:'Chen Meiling', ship_phone:'138****2841',
        ship_address:'12 Linhe Rd, Tianhe, Guangzhou', shipments:[]})};
      if(p.indexOf('/customers?pageSize=1&')===0) return {success:true,data:[],
        segments:{all:242,new_week:6,sleeping:31,blocked:1},returning:{buyers:17,returners:9},customers_on_file:242};
      if(p.indexOf('/customers?')===0) return {success:true,data:CUSTOMERS,meta:{total:242}};
      if(/^\\/customers\\/\\d+$/.test(p)) return {success:true,data:{customer:CUSTOMERS[0],
        stats:{orders:{count:24,total:6240,avg:260},points:2410,wallet:82,joined:'2025-04-02'},
        recent_orders:ORDERS.slice(0,2), addresses:[{line:'12 Linhe Rd, Tianhe',is_default:1}]}};
      if(p.indexOf('/products?')===0) return {success:true,data:PRODUCTS};
      if(p.indexOf('/invoices')===0) return {success:true,data:INVOICES,counts:{requested:1,issued:2}};
      if(p.indexOf('/activity?')===0) return {success:true,total:3,rows:ACTIVITY,summary:ACT_SUMMARY,digest:ACT_DIGEST};
      if(p.indexOf('/affiliate/referrals?')===0) return {success:true,data:REFERRALS,page:1,pageSize:50,total:3,
        summary:{total:24,converted:9,paid_out:180,lifetime_paid:42.5,still_earning:6,joined_this_month:5,joined_last_month:3}};
      if(p.indexOf('/topup-transactions?')===0) return {success:true,data:TOPUPS};
      if(p.indexOf('/vouchers')===0) return {success:true,data:VOUCHERS};
      if(p.indexOf('/flash-sales')===0) return {success:true,data:FLASH};
      if(p.indexOf('/broadcasts')===0) return {success:true,data:BROADCASTS};
      // The two the dot reads. The since= param is the client's stored
      // last-seen stamp; an empty one means never opened, so everything counts.
      if(p.indexOf('/reviews/unseen-count')===0)
        return {success:true,data:{count: /since=$|since=&|^\\/reviews\\/unseen-count$/.test(p)?2:0, latest:'2026-08-22 12:00:00'}};
      if(p.indexOf('/feedback/unseen-count')===0)
        return {success:true,data:{count: /since=$|since=&|^\\/feedback\\/unseen-count$/.test(p)?1:0, latest:'2026-08-22 09:10:00'}};
      if(p.indexOf('/reviews')===0) return {success:true,data:REVIEWS};
      if(p.indexOf('/feedback')===0) return {success:true,data:FEEDBACK};
      if(p.indexOf('/dashboard/activity')===0) return {success:true,data:D['/dashboard/activity']};
      if(p.indexOf('/dashboard/ops')===0) return {success:true,data:D['/dashboard/ops']};
      if(p.indexOf('/dashboard?')===0) return {success:true,data:D['/dashboard']};
      if(p.indexOf('/cms/layout')===0) return {success:true,data:D['/cms/layout']};
      if(p.indexOf('/media/list')===0) return {success:true,data:D['/media/list']};
      if(p.indexOf('/meituan/status')===0) return Object.assign({success:true},D['/meituan/status']);
      if(p.indexOf('/meituan/orders')===0) return {success:true,data:D['/meituan/orders']};
      if(p.indexOf('/guanyi/pickups')===0) return Object.assign({success:true},D['/guanyi/pickups']);
      if(p.indexOf('/category-counts')===0) return Object.assign({success:true},D['/category-counts']);
      if(p.indexOf('/purchases/')===0) return {success:true,data:{id:4,po_number:'RPO-0004',supplier:'Fresh Co.',
        store_name_en:'Tianhe',store_name_cn:'天河店',date:'2026-08-14',delivery_date:'2026-08-16',status:'Ordered',
        total_cost:3240,notes:'Back door before 9am.',items:[
          {id:1,name_en:'Oat milk 1L',name_cn:'燕麦奶 1L',sku:'OM-1L',qty:48,unit:'btl',total_cost:1440,current_stock:12},
          {id:2,name_en:'Carrots',name_cn:'胡萝卜',sku:'CR-01',qty:20,unit:'kg',total_cost:1800,qty_received:18,damaged_qty:2}]}};
      var key=Object.keys(D).filter(function(k){return p.indexOf(k)===0;}).sort(function(a,b){return b.length-a.length;})[0];
      if(key) return {success:true,data:D[key]};
      return {success:true,data:[]};
    }
    window.fetch=function(u){
      var j=body(String(u));
      return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(j);}});
    };
  })();`;
}

module.exports = { fakeServer };
