// Toggleable backend features — the single source of truth for which
// optional sections of the Mini App Backend a tenant can switch on/off.
//
// Two layers decide whether a feature is visible (see retail-admin.html boot):
//   1. ENTITLEMENT (platform-controlled) — tenants.features_json. A null/absent
//      entry means "available", so by default every tenant is entitled to
//      everything. The platform lowers this ceiling per tenant only when a
//      feature becomes a paid/gated capability (saas-admin UI, built later).
//   2. PREFERENCE (tenant-controlled) — storefront_config `features.<key>`,
//      flipped by the operator in their own Settings → Features tab. Defaults
//      to each feature's `default` below.
// Effective = entitled AND preference-on. `key` is also the data-feat value the
// markup is tagged with and the `feat-<key>` body class used to gate it in CSS.

const FEATURES = [
  { key: 'membership',  en: 'Membership & points', cn: '会员与积分', default: true,
    desc_en: 'Roots Club tiers and the points the mini-app shows shoppers.',
    desc_cn: '会员等级与小程序向顾客展示的积分。' },
  { key: 'affiliate',   en: 'Referral program',    cn: '推荐计划',   default: true,
    desc_en: 'The affiliate / referral tab and shopper referral links.',
    desc_cn: '推荐计划标签页与顾客推荐链接。' },
  { key: 'reviews',     en: 'Product reviews',      cn: '商品评价',   default: true,
    desc_en: 'Customer reviews and the review-tag editor.',
    desc_cn: '顾客评价与评价标签编辑。' },
  { key: 'feedback',    en: 'Customer feedback',    cn: '用户反馈',   default: true,
    desc_en: 'The "Found a bug?" feedback inbox from the mini-app Me page.',
    desc_cn: '来自小程序“我的”页面的反馈收件箱。' },
  { key: 'socialProof', en: 'Social proof',         cn: '社交证明',   default: true,
    desc_en: 'Bought-counts, recent-buyers ticker and the SOLD badge.',
    desc_cn: '购买人数、最近购买动态与“已售”标签。' },
  { key: 'faq',         en: 'Help / FAQ',           cn: '帮助 / 常见问题', default: true,
    desc_en: 'The Me → Help & FAQ screen with categories, search and contact bar.',
    desc_cn: '“我的”→帮助与常见问题页面,含分类、搜索与联系入口。' },

  // ── Channels & delivery integrations (Channels hub cards) ──────────────────
  // Entitlement-gated so a plugin can be sold as a paid add-on: default true =
  // available to every tenant until the platform lowers the ceiling per tenant
  // (tenants.features_json). The Channels hub hides a card whose feature is off.
  { key: 'channel_meituan',  en: 'Meituan channel',   cn: '美团渠道',   default: true,
    desc_en: 'Sync orders and stock with Meituan waimai + Shangou (assisted setup, store box).',
    desc_cn: '与美团外卖 + 闪购同步订单与库存(协助式设置,门店盒子)。' },
  { key: 'channel_eleme',    en: 'Eleme channel',     cn: '饿了么渠道', default: true,
    desc_en: 'Sync orders and stock with Eleme via its official API.',
    desc_cn: '通过官方接口与饿了么同步订单与库存。' },
  { key: 'logistics_jd',     en: 'JD Logistics',      cn: '京东物流',   default: true,
    desc_en: 'Create JD waybills for delivery orders.',
    desc_cn: '为配送订单生成京东运单。' },
  { key: 'tracking_qingyun', en: 'Qingyun tracking',  cn: '青云追踪',   default: true,
    desc_en: 'Live rider tracking for delivery orders via Qingyun.',
    desc_cn: '通过青云为配送订单提供骑手实时追踪。' },
];

const KEYS = FEATURES.map(f => f.key);

// Map a raw tenants.features_json value to an entitlement object. null/absent
// (or an unparseable value) → all keys entitled. Unknown keys are ignored.
function entitlements(featuresJson) {
  let parsed = null;
  if (featuresJson) { try { parsed = JSON.parse(featuresJson); } catch { parsed = null; } }
  const out = {};
  for (const k of KEYS) out[k] = parsed && parsed[k] === false ? false : true;
  return out;
}

// Default preference map (customer-on defaults) — used by the client when a
// tenant has never touched the Features tab.
function defaults() {
  const out = {};
  for (const f of FEATURES) out[f.key] = f.default;
  return out;
}

module.exports = { FEATURES, KEYS, entitlements, defaults };
