// 11 STORY / WHO WE ARE — content lives in /api/retail/config under
// about.content (edited from retail-admin → About page). Defaults are
// inlined here so the screen renders even if the config call fails
// (network blip, fresh DB before seed runs, etc.).

const config = require('../../utils/config');
const { BASE } = require('../../utils/api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

// Tiny **bold** → <text class="bold">…</text> parser used for the
// manifesto. WeChat templates can't render raw HTML, so we emit a
// segments array and let the WXML loop print regular + bold spans.
function parseBold(s) {
  const out = [];
  if (!s) return out;
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false });
  return out;
}

const DEFAULTS = {
  kicker_en: 'WHO WE ARE',
  kicker_cn: '我们是谁',
  manifesto_en: 'We exist to make **plant-based food** so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
  manifesto_cn: '我们存在的意义,是把**植物食物**做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
  stats: [
    { value_en: '2017', value_cn: '2017', label_en: 'EST.',     label_cn: '成立' },
    { value_en: '广州', value_cn: '广州', label_en: 'MADE IN',  label_cn: '产地' },
    { value_en: '50+',  value_cn: '50+',  label_en: 'PRODUCTS', label_cn: '产品' },
    { value_en: '100%', value_cn: '100%', label_en: 'PLANT',    label_cn: '植物' },
  ],
  founder_kicker_en: 'MEET THE FOUNDER',
  founder_kicker_cn: '创始人',
  founder_name_en: 'Founder Name',
  founder_name_cn: '创始人姓名',
  founder_title_en: 'FOUNDER & CEO',
  founder_title_cn: '创始人兼首席执行官',
  founder_quote_en: 'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
  founder_quote_cn: '我创立 Roots,是想证明植物从来不该是无聊的选择。',
  founder_photo_url: '',
  promise_kicker_en: 'OUR PROMISE',
  promise_kicker_cn: '我们的承诺',
  in_items: [
    { en: '100% plant-based',     cn: '100% 植物' },
    { en: 'Made from scratch',    cn: '原料自制' },
    { en: 'Real fermentation',    cn: '真发酵' },
    { en: 'Whole ingredients',    cn: '完整食材' },
    { en: 'Small batch',          cn: '小批量' },
    { en: 'Seasonal',             cn: '应季' },
    { en: 'Local-first · 广州',   cn: '本地优先' },
    { en: 'Recyclable packaging', cn: '可回收包装' },
  ],
  out_items: [
    { en: 'Preservatives',     cn: '防腐剂' },
    { en: 'Refined sugar',     cn: '精制糖' },
    { en: 'Artificial color',  cn: '人造色素' },
    { en: 'Artificial flavor', cn: '人造香精' },
    { en: 'Additives',         cn: '添加剂' },
    { en: 'GMO',               cn: '转基因' },
    { en: 'Animal products',   cn: '动物产品' },
    { en: 'Cutting corners',   cn: '走捷径' },
  ],
  outro_en: 'From soil to soul.',
  outro_cn: '从土壤到灵魂',
  cta_en: 'SHOP NOW',
  cta_cn: '立即购买',
};

Page({
  data: {
    lang: 'en',
    c: DEFAULTS,                  // merged content (defaults ← server)
    manifestoSegments: [],        // [{ text, bold }] for the active language
    founderPhoto: '',             // resolved absolute URL or ''
    storyExpanded: false,         // founder quote clamp/expand toggle
  },

  toggleStory() { this.setData({ storyExpanded: !this.data.storyExpanded }); },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang || 'en' });
    this.refresh();
  },

  async refresh() {
    let cfg;
    try { cfg = await config.load(false); } catch { cfg = null; }
    const stored = cfg?.about?.content;
    const merged = stored && typeof stored === 'object'
      ? Object.assign({}, DEFAULTS, stored)
      : DEFAULTS;
    // Defensive: arrays might be missing or wrong-typed from a partial save
    if (!Array.isArray(merged.stats))     merged.stats     = DEFAULTS.stats;
    if (!Array.isArray(merged.in_items))  merged.in_items  = DEFAULTS.in_items;
    if (!Array.isArray(merged.out_items)) merged.out_items = DEFAULTS.out_items;

    const lang = this.data.lang;
    const manifesto = lang === 'cn' ? (merged.manifesto_cn || merged.manifesto_en) : (merged.manifesto_en || merged.manifesto_cn);
    this.setData({
      c: merged,
      manifestoSegments: parseBold(manifesto),
      founderPhoto: absUrl(merged.founder_photo_url),
    });
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
});
