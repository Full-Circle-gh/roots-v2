// Tenant onboarding roadmap — the A-to-Z a new company must complete before
// its mini app can take live orders. The TEMPLATE lives here (easy to evolve +
// render EN/CN); per-tenant PROGRESS lives in the `tenant_onboarding` table
// (see routes/saas-admin.js).
//
// Two operating models the customer chooses between (priced differently):
//   'self'    = Model A — the tenant registers their own WeChat Mini Program
//               + WeChat Pay merchant, and hands us the credentials. Cheaper.
//   'managed' = Model B — we register + operate everything for them as a
//               WeChat service-provider; they just authorize us. Premium.
//
// IMPORTANT: in BOTH models each tenant's sales settle to THAT TENANT'S OWN
// WeChat Pay merchant → THEIR OWN bank account. Money never routes through the
// platform; we earn from the subscription, not from their takings.
//
// Per-step metadata:
//   owner:        'tenant' | 'us' | { self:'…', managed:'…' }  (resolved by model)
//   onlyModel:    'self' | 'managed'   → hidden unless the tenant is on that model
//   onlyCategory: 'food' | …           → hidden unless the tenant's category matches
//   note:         short operator hint (EN)

const PHASES = [
  {
    key: 'legal', en: 'Business identity', cn: '企业资质',
    steps: [
      { key: 'biz_license',  en: 'Business license + unified credit code', cn: '营业执照 + 统一社会信用代码', owner: 'tenant' },
      { key: 'legal_rep',    en: 'Legal representative ID (front/back + phone)', cn: '法人身份证（正反面 + 手机号）', owner: 'tenant' },
      { key: 'food_license', en: 'Food business license', cn: '食品经营许可证', owner: 'tenant', onlyCategory: 'food' },
    ],
  },
  {
    key: 'bank', en: 'Banking', cn: '银行结算',
    steps: [
      { key: 'bank_account', en: 'Corporate settlement account', cn: '对公结算账户', owner: 'tenant',
        note: 'This account receives the tenant’s sales — their own bank, never ours.' },
    ],
  },
  {
    key: 'brand', en: 'People & brand', cn: '联系人与品牌',
    steps: [
      { key: 'super_admin',  en: 'Super-admin contact (does WeChat face-scan verifications)', cn: '超级管理员（负责微信扫脸验证）', owner: 'tenant' },
      { key: 'cs_phone',     en: 'Customer-service phone (shown in app)', cn: '客服电话（应用内展示）', owner: 'tenant' },
      { key: 'brand_assets', en: 'App name (+2 backups), square logo, service category', cn: '小程序名称（+2 备选）、方形 Logo、经营类目', owner: 'tenant' },
    ],
  },
  {
    key: 'miniapp', en: 'WeChat Mini Program', cn: '微信小程序',
    steps: [
      { key: 'miniapp_register', en: 'Register Mini Program + WeChat verification (¥300/yr)', cn: '注册小程序 + 微信认证（¥300/年）', owner: { self: 'tenant', managed: 'us' } },
      { key: 'appid',            en: 'Provide AppID + AppSecret to platform', cn: '提供 AppID + AppSecret', owner: { self: 'tenant', managed: 'us' } },
      { key: 'dev_access',       en: 'Grant us developer access to upload code', cn: '授予开发者权限以上传代码', owner: 'tenant', onlyModel: 'self' },
      { key: 'authorize',        en: 'Authorize our platform to manage the app (one scan)', cn: '扫码授权平台代管小程序', owner: 'tenant', onlyModel: 'managed' },
    ],
  },
  {
    key: 'pay', en: 'WeChat Pay → tenant’s own bank', cn: '微信支付（结算至租户自有账户）',
    steps: [
      { key: 'pay_merchant',    en: 'Register WeChat Pay merchant', cn: '注册微信支付商户号', owner: { self: 'tenant', managed: 'us' } },
      { key: 'pay_bind',        en: 'Bind merchant ↔ AppID + sign payment agreement', cn: '商户号绑定 AppID + 支付签约', owner: { self: 'tenant', managed: 'us' } },
      { key: 'pay_creds',       en: 'Hand over merchant ID + API v3 key + certificate', cn: '提供商户号 + APIv3 密钥 + 商户证书', owner: { self: 'tenant', managed: 'us' },
        note: 'Record the merchant ID + a note that the key/cert were received. Keep raw secrets out of this tracker.' },
      { key: 'pay_bank_verify', en: 'Confirm settlement account = tenant’s own bank', cn: '确认结算账户为租户自有账户', owner: 'us' },
    ],
  },
  {
    key: 'config', en: 'Platform setup', cn: '平台配置',
    steps: [
      { key: 'platform_config', en: 'Wire AppID + Pay credentials into the platform', cn: '将 AppID 与支付凭证接入平台', owner: 'us' },
      { key: 'catalog',         en: 'Products, prices, images', cn: '商品、价格、图片', owner: 'us' },
      { key: 'zones',           en: 'Delivery zones + fees', cn: '配送区域与运费', owner: 'us' },
      { key: 'store_info',      en: 'Store / warehouse address + hours', cn: '门店 / 仓库地址与营业时间', owner: 'us' },
    ],
  },
  {
    key: 'golive', en: 'Go-live', cn: '上线',
    steps: [
      { key: 'submit_review', en: 'Submit mini app for WeChat review', cn: '提交微信审核', owner: 'us' },
      { key: 'smoke_test',    en: 'End-to-end test: order → real payment → refund', cn: '全链路测试：下单 → 真实支付 → 退款', owner: 'us' },
      { key: 'launch',        en: 'Release + operator training / handover', cn: '发布 + 操作培训 / 交接', owner: 'us' },
    ],
  },
];

const STATUSES = ['pending', 'provided', 'verified', 'done', 'na'];

function resolveOwner(owner, model) {
  if (owner && typeof owner === 'object') return owner[model] || owner.self || 'tenant';
  return owner;
}

// Build the resolved checklist for a tenant: filter steps by model + category,
// then merge in saved progress. `state` is a map: step_key -> { status, value }.
function resolveChecklist(model, category, state) {
  model = model === 'managed' ? 'managed' : 'self';
  state = state || {};
  const phases = [];
  for (const p of PHASES) {
    const steps = [];
    for (const s of p.steps) {
      if (s.onlyModel && s.onlyModel !== model) continue;
      if (s.onlyCategory && s.onlyCategory !== category) continue;
      const st = state[s.key] || {};
      steps.push({
        key: s.key, en: s.en, cn: s.cn, note: s.note || null,
        owner: resolveOwner(s.owner, model),
        status: STATUSES.includes(st.status) ? st.status : 'pending',
        value: st.value || '',
      });
    }
    if (steps.length) phases.push({ key: p.key, en: p.en, cn: p.cn, steps });
  }
  return phases;
}

// Count completion across applicable steps ('na' excluded; 'verified'/'done' count).
function progress(phases) {
  let total = 0, done = 0;
  for (const p of phases) for (const s of p.steps) {
    if (s.status === 'na') continue;
    total++;
    if (s.status === 'done' || s.status === 'verified') done++;
  }
  return { total, done, remaining: total - done };
}

module.exports = { PHASES, STATUSES, resolveChecklist, progress };
