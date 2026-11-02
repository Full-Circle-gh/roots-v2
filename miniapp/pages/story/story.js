// The complete founder essay. About keeps a three-line quote; this page is
// what "Read the full story" and the home story card open. The words are the
// shop's own about.content. The photograph and the title come from the home
// story card that points here, when the shop has one. A shop that wrote
// nothing shows nothing of somebody else's.

const config = require('../../utils/config');
const { BASE } = require('../../utils/api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

// cn picks the Chinese field, then the English one. A shop writing one
// language has not left the line blank.
function pick(cn, en, zh) {
  return String((cn ? (zh || en) : (en || zh)) || '').trim();
}

function storyCard(layout) {
  const list = Array.isArray(layout) ? layout : [];
  return list.find(b => b && b.type === 'recipe_story'
    && (b.cta_target === 'about' || b.cta_target === 'story')) || null;
}

function paragraphsOf(text) {
  return String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
}

Page({
  data: {
    image: '',
    kicker: '',
    headline: '',
    byline: '',
    paragraphs: [],
    outro: '',
    cta: '',
  },

  onShow() {
    const L = getApp().globalData.lang || 'en';
    // Live pair, copied from the Me menu (aboutMeta) and the web shop menu.
    wx.setNavigationBarTitle({ title: L === 'cn' ? '我们的故事' : 'Our story' });
    this.refresh();
  },

  async refresh() {
    let cfg;
    try { cfg = await config.load(false); } catch { cfg = null; }
    const cn = (getApp().globalData.lang || 'en') === 'cn';
    const c = (cfg && cfg.about && cfg.about.content && typeof cfg.about.content === 'object')
      ? cfg.about.content : {};
    const card = storyCard(config.forMiniApp(cfg && cfg.home && cfg.home.layout));
    const quote = pick(cn, c.founder_quote_en, c.founder_quote_cn);
    const cardBody = card ? pick(cn, card.body_en, card.body_cn) : '';
    // The quote is the complete essay. The card's own text is the short
    // version on the front page; it fills in only when the shop has not
    // written the quote.
    const essay = quote || cardBody;
    const name = pick(cn, c.founder_name_en, c.founder_name_cn);
    const role = pick(cn, c.founder_title_en, c.founder_title_cn);
    const headline = (card && pick(cn, card.headline_en, card.headline_cn))
      || name
      || (cn ? '我们的故事' : 'Our story');
    const kicker = (card && pick(cn, card.kicker_en, card.kicker_cn))
      || pick(cn, c.founder_kicker_en, c.founder_kicker_cn);
    const minutes = card && Number(card.read_time_minutes);
    const bits = [];
    if (name) bits.push(name);
    if (role) bits.push(role);
    if (minutes) bits.push(minutes + (cn ? ' 分钟' : ' min'));
    const byline = bits.length ? bits.join(' · ') : (card ? pick(cn, card.byline_en, card.byline_cn) : '');
    const image = absUrl((card && card.image_url) || c.founder_photo_url || c.hero_image_url || '');
    const outro = pick(cn, c.outro_en, c.outro_cn);
    // Fallback pair already live on the web About page.
    const cta = pick(cn, c.cta_en, c.cta_cn) || (cn ? '去逛逛' : 'SHOP NOW');
    this.setData({
      image,
      kicker,
      headline,
      byline,
      paragraphs: paragraphsOf(essay),
      outro,
      cta,
    });
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
});
