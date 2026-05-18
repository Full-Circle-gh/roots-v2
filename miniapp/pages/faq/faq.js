// FAQ / Help centre. Mirrors the design from Roots Mini App.html · No.14.
// Categories + questions come from storefront_config (faq.categories /
// faq.questions). Both languages are stored together; the customer's
// language picks which one renders. Office edits these in /retail-admin
// → Settings → FAQ. If config has no rows yet we fall back to a sensible
// starter set so the page is never empty on a fresh deploy.

const config = require('../../utils/config');

// Brand-colour name → hex (mirrors miniapp app.wxss tokens). Lets the
// admin pick by name (lime/papaya/pink/...) the same way review-tag
// colours work, instead of typing a hex.
const COLOR_HEX = {
  lime:     '#CCD900',
  forest:   '#365329',
  olive:    '#6A6E2D',
  almond:   '#C37F4E',
  corn:     '#F2CA6C',
  pink:     '#F4B8CB',
  berry:    '#E96174',
  carrot:   '#FF6B0C',
  papaya:   '#FFAF60',
  sky:      '#B2CFED',
  lotus:    '#EEB8E4',
  citrus:   '#E7E74C',
  lemon:    '#F4F087',
  pea:      '#7BBD3B',
  cucumber: '#A8D185',
  avocado:  '#73BF83',
};

const DEFAULT_CATEGORIES = [
  { id: 'orders',     en: 'Orders',     cn: '订单',     color: 'lime'    },
  { id: 'delivery',   en: 'Delivery',   cn: '配送',     color: 'papaya'  },
  { id: 'products',   en: 'Products',   cn: '产品',     color: 'pink'    },
  { id: 'wallet',     en: 'Wallet',     cn: '钱包',     color: 'sky'     },
  { id: 'membership', en: 'Membership', cn: '会员',     color: 'corn'    },
  { id: 'account',    en: 'Account',    cn: '账户',     color: 'avocado' },
];

const DEFAULT_QUESTIONS = [
  { id: 'q-delivery-eta',    cat: 'delivery',
    q_en: 'When will my order arrive?',                 q_cn: '订单什么时候到？',
    a_en: 'Standard orders ship within 24 hours and arrive in 2–3 days via 顺丰. Same-day delivery (¥18) is available in 广州 for orders placed before 2pm.',
    a_cn: '标准订单 24 小时内发货,通过顺丰送达,通常 2–3 天到达。广州市内 14:00 前下单可选当日达(¥18)。' },
  { id: 'q-delivery-coverage', cat: 'delivery',
    q_en: 'Do you ship outside 广州?',                  q_cn: '是否支持广州以外发货？',
    a_en: 'Yes — we ship nationally via 顺丰. Free shipping on orders over ¥99. International shipping is not available at this time.',
    a_cn: '支持。全国顺丰发货,满 ¥99 包邮。暂不支持国际配送。' },
  { id: 'q-order-cancel',    cat: 'orders',
    q_en: 'Can I change or cancel my order?',           q_cn: '能修改或取消订单吗？',
    a_en: 'You can cancel free of charge within 30 minutes of placing the order, before it is packed. After packing, please contact us — we will do our best to help.',
    a_cn: '下单后 30 分钟内,在打包前可免费取消。已打包的订单请联系客服,我们会尽力协助。' },
  { id: 'q-order-return',    cat: 'orders',
    q_en: 'How do I return something?',                 q_cn: '如何退货？',
    a_en: "Perishables (kombucha, juice, fresh meals) can't be returned. Unopened dry goods can be returned within 7 days. Tap 'After-sales' in your order to start a return.",
    a_cn: '生鲜类(康普茶、果汁、鲜食)不支持退货;未开封的干货 7 天内可退。在订单详情点击「售后」即可申请。' },
  { id: 'q-products-plant',  cat: 'products',
    q_en: 'Are your products really 100% plant-based?', q_cn: '产品全是植物基吗？',
    a_en: 'Yes. Every product is fully plant-based — no animal ingredients, no traces, no exceptions. We have been certified by 中国素食认证.',
    a_cn: '是的。每一款产品都是 100% 植物基,无动物成分、无痕量、无例外。已通过中国素食认证。' },
  { id: 'q-products-shelf',  cat: 'products',
    q_en: 'How long do products last after opening?',   q_cn: '开封后保质期？',
    a_en: 'Kombucha and juice: 3 days refrigerated. Dry goods: see package — usually 30 days. Always keep refrigerated once opened.',
    a_cn: '康普茶和果汁:冷藏 3 天内饮用;干货请见包装,通常 30 天。开封后请冷藏保存。' },
  { id: 'q-wallet-topup',    cat: 'wallet',
    q_en: 'How does top-up work?',                      q_cn: '充值怎么用？',
    a_en: 'Pre-pay any of 4 tiers (¥500 / ¥1,000 / ¥2,000 / ¥3,000) and earn bonus points on top. Balance never expires. Non-refundable.',
    a_cn: '预付任一档(¥500 / ¥1,000 / ¥2,000 / ¥3,000)即可获得赠送积分。余额永不过期,不支持退款。' },
  { id: 'q-wallet-point',    cat: 'wallet',
    q_en: 'What is 1 point worth?',                     q_cn: '1积分等于多少？',
    a_en: '1 point = ¥0.10 off any order. Points can be combined with vouchers and tier discounts.',
    a_cn: '1 积分 = ¥0.10 抵扣,可与优惠券、等级折扣叠加。' },
  { id: 'q-member-tier',     cat: 'membership',
    q_en: 'How do I level up my tier?',                 q_cn: '如何升级会员？',
    a_en: 'Lifetime spend determines tier. Sprout = ¥500, Root = ¥2,000, Tree = ¥6,000. Tier perks are permanent once unlocked.',
    a_cn: '累计消费决定等级:幼苗 ¥500、根 ¥2,000、大树 ¥6,000。等级权益一旦解锁永久保留。' },
  { id: 'q-member-points',   cat: 'membership',
    q_en: 'When do points expire?',                     q_cn: '积分多久过期？',
    a_en: 'Never. Points and tier status do not expire as long as your account is active.',
    a_cn: '永不过期。只要账户活跃,积分和等级均长期有效。' },
  { id: 'q-account-delete',  cat: 'account',
    q_en: 'How do I delete my account?',                q_cn: '如何注销账户？',
    a_en: 'Tap Me → Settings → Account → Delete account. Your data is removed within 30 days. Wallet balance is forfeited.',
    a_cn: '进入「我的 → 设置 → 账户 → 注销账户」。数据将在 30 天内删除,余额视为放弃。' },
  { id: 'q-account-privacy', cat: 'account',
    q_en: 'Can I hide from the leaderboard?',           q_cn: '能从排行榜隐藏吗？',
    a_en: 'Yes. Toggle "Show on leaderboard" off in Me → Privacy. Your spend still counts toward your tier.',
    a_cn: '可以。在「我的 → 隐私」中关闭「显示在排行榜」。消费金额仍照常计入等级。' },
];

function colorHex(name) {
  if (!name) return COLOR_HEX.lime;
  if (name[0] === '#') return name;
  return COLOR_HEX[name] || COLOR_HEX.lime;
}

Page({
  data: {
    lang: 'en',
    categories: [],
    questions: [],
    filtered: [],
    activeCat: '',     // '' = all
    search: '',
    openIdx: 0,
    csMode: 'off',
    csLabelWechat: 'WECHAT',
    csPhone: '',
    csHours: '',
    csStillStuck: 'STILL STUCK · 仍有疑问',
  },

  async onLoad() {
    const app = getApp();
    const L = app.globalData.lang || 'en';
    this.setData({ lang: L });
    await this.refresh();
  },

  async onPullDownRefresh() {
    try { await this.refresh(true); }
    finally { wx.stopPullDownRefresh(); }
  },

  async refresh(force = false) {
    try {
      const cfg = await config.load(force);
      const lang = this.data.lang;

      const rawCats = Array.isArray(cfg?.faq?.categories) && cfg.faq.categories.length
        ? cfg.faq.categories : DEFAULT_CATEGORIES;
      const rawQs = Array.isArray(cfg?.faq?.questions) && cfg.faq.questions.length
        ? cfg.faq.questions : DEFAULT_QUESTIONS;

      const categories = rawCats.map(c => ({
        id: String(c.id || ''),
        en: String(c.en || c.id || ''),
        cn: String(c.cn || c.en || c.id || ''),
        color: colorHex(c.color),
      })).filter(c => c.id);

      // Build a colour lookup by category id so each question can render
      // its chip without a per-row find().
      const catMap = {};
      for (const c of categories) catMap[c.id] = c;

      const questions = rawQs.map(q => {
        const cm = catMap[q.cat] || { en: '', cn: '', color: COLOR_HEX.lime };
        const q_text = lang === 'cn' ? (q.q_cn || q.q_en) : (q.q_en || q.q_cn);
        const q_sub  = lang === 'cn' ? (q.q_en || '')    : (q.q_cn || '');
        const a_text = lang === 'cn' ? (q.a_cn || q.a_en) : (q.a_en || q.a_cn);
        return {
          id: String(q.id || ''),
          cat: q.cat || '',
          catLabel: (lang === 'cn' ? cm.cn : cm.en) || '',
          catColor: cm.color || COLOR_HEX.lime,
          q: q_text || '',
          q_sub: q_sub || '',
          a: a_text || '',
          // Lowercased haystack for live search across both languages.
          _search: [q.q_en, q.q_cn, q.a_en, q.a_cn].join(' ').toLowerCase(),
        };
      });

      // Contact-footer copy from customer_service config (admin already
      // edits these). We reuse the WeChat / call options on the FAQ
      // sticky footer rather than introducing a brand-new schema.
      const cs = cfg?.customer_service || {};
      const csHours = (lang === 'cn' ? cs.hours_cn : cs.hours_en) || (lang === 'cn' ? '周一至周六 · 9–18' : "We're here Mon–Sat · 9–18");
      const csLabelWechat = (lang === 'cn' ? cs.label_cn : cs.label_en) || (lang === 'cn' ? '微信' : 'WECHAT');

      this.setData({
        categories,
        questions,
        csMode: cs.mode || 'off',
        csPhone: String(cs.phone || '').trim(),
        csHours,
        csLabelWechat,
        csStillStuck: lang === 'cn' ? '仍有疑问 · STILL STUCK' : 'STILL STUCK · 仍有疑问',
      });
      this.applyFilter();
    } catch (e) {
      console.warn('[faq] load failed:', e.message);
    }
  },

  applyFilter() {
    const { questions, activeCat, search } = this.data;
    const s = search.trim().toLowerCase();
    const filtered = questions.filter(q => {
      if (activeCat && q.cat !== activeCat) return false;
      if (s && !q._search.includes(s)) return false;
      return true;
    }).map((q, i) => ({ ...q, num: String(i + 1).padStart(2, '0') }));
    this.setData({ filtered, openIdx: filtered.length ? 0 : -1 });
  },

  onSearchInput(e) {
    this.setData({ search: e.detail.value });
    this.applyFilter();
  },

  clearSearch() {
    this.setData({ search: '' });
    this.applyFilter();
  },

  pickCat(e) {
    const id = e.currentTarget.dataset.id || '';
    this.setData({ activeCat: id });
    this.applyFilter();
  },

  toggleRow(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ openIdx: this.data.openIdx === idx ? -1 : idx });
  },

  // Thumbs-up / thumbs-down — fire-and-forget; if the feedback endpoint
  // isn't around yet we just swallow the error so the UI still feels
  // responsive. Server side can be added later without breaking the page.
  voteHelpful(e) {
    const { id, vote } = e.currentTarget.dataset;
    wx.showToast({
      title: vote === 'up' ? (this.data.lang === 'cn' ? '感谢反馈' : 'Thanks!') : (this.data.lang === 'cn' ? '我们会改进' : "We'll fix this"),
      icon: 'none',
      duration: 1200,
    });
    try {
      const api = require('../../utils/api');
      api.post('/api/retail/faq/feedback', { question_id: id, helpful: vote === 'up' }).catch(() => {});
    } catch (_) {}
  },

  async tapWechat() {
    const { csMode } = this.data;
    if (csMode === 'off') {
      wx.showToast({ title: this.data.lang === 'cn' ? '客服暂未开放' : 'Support unavailable', icon: 'none' });
      return;
    }
    let cfg = {};
    try { cfg = await config.load(); } catch (_) {}
    const cs = (cfg && cfg.customer_service) || {};
    if (csMode === 'wecom') {
      if (!cs.corp_id || !cs.url) {
        wx.showToast({ title: 'WeCom not configured', icon: 'none' });
        return;
      }
      if (wx.openCustomerServiceChat) {
        wx.openCustomerServiceChat({
          extInfo: { url: cs.url },
          corpId: cs.corp_id,
          fail() { wx.showToast({ title: 'Open failed', icon: 'none' }); },
        });
      }
      return;
    }
    if (csMode === 'qr') {
      const url = cs.qr_image_url;
      if (!url) { wx.showToast({ title: 'No QR set', icon: 'none' }); return; }
      const full = /^https?:/.test(url) ? url : (require('../../utils/api').BASE + url);
      wx.previewImage({ urls: [full] });
      return;
    }
    // kf mode — the native open-type="contact" button is what actually
    // dispatches into WeChat customer service. We don't have one mounted
    // here (the design uses a flat ink-painted pill, not a native button),
    // so the customer's path is via the cs-button on the Me tab instead.
    wx.showToast({ title: this.data.lang === 'cn' ? '请通过微信客服联系我们' : 'Use WeChat customer service', icon: 'none' });
  },

  tapCall() {
    const num = (this.data.csPhone || '').replace(/\s+/g, '');
    if (!num) {
      wx.showToast({ title: this.data.lang === 'cn' ? '电话号码未设置' : 'No phone set', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: num, fail() {} });
  },
});
