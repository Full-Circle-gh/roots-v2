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

/* The DEFAULTS object that stood here was the FIRST TENANT's own copy — the
   manifesto, EST. 2017, MADE IN 广州, the founder's quote, the in/out list —
   and it was merged field by field under whatever the shop had actually
   written, so a merchant who wrote half an About page published the other half
   of somebody else's story to their own customers (audit D-04).

   Its stated reason was resilience: "so the screen renders even if the config
   call fails". That is a real concern and this keeps it — the page still
   renders when the config is unreachable. It renders EMPTY, which is the
   honest thing for a screen whose entire content comes from that call, rather
   than renders a different company's story and lets it pass for the shop's.

   public/shop.html and the phone admin both do the same now; the phone always
   did. */

Page({
  data: {
    lang: 'en',
    c: {},                        // the shop's own content, from the server; empty until it arrives
    manifestoSegments: [],        // [{ text, bold }] for the active language
    founderPhoto: '',             // resolved absolute URL or ''
    heroImage: '',                // the SHOP's own hero, or '' for no hero
    hasFounder: false,            // did the shop write a founder at all?
    storyExpanded: false,         // founder quote clamp/expand toggle
  },

  toggleStory() { this.setData({ storyExpanded: !this.data.storyExpanded }); },

  onShow() {
    const app = getApp();
    const L = app.globalData.lang || 'en';
    this.setData({ lang: L });
    wx.setNavigationBarTitle({ title: L === 'cn' ? '关于' : 'About' });
    this.refresh();
  },

  async refresh() {
    let cfg;
    try { cfg = await config.load(false); } catch { cfg = null; }
    const stored = cfg?.about?.content;
    /* The shop's own content or nothing at all — never another shop's. */
    const merged = stored && typeof stored === 'object' ? Object.assign({}, stored) : {};
    // A partial save can leave an array missing or wrong-typed. Empty, not
    // borrowed: the WXML skips a section whose list has no rows.
    if (!Array.isArray(merged.stats))     merged.stats     = [];
    if (!Array.isArray(merged.in_items))  merged.in_items  = [];
    if (!Array.isArray(merged.out_items)) merged.out_items = [];
    merged.hasContent = !!(String(merged.manifesto_en || merged.manifesto_cn || '').trim()
      || merged.stats.length || merged.in_items.length || merged.out_items.length
      || String(merged.founder_name_en || merged.founder_name_cn || '').trim());

    const lang = this.data.lang;
    const manifesto = lang === 'cn' ? (merged.manifesto_cn || merged.manifesto_en) : (merged.manifesto_en || merged.manifesto_cn);
    this.setData({
      c: merged,
      manifestoSegments: parseBold(manifesto),
      founderPhoto: absUrl(merged.founder_photo_url),
      heroImage: absUrl(merged.hero_image_url),
      hasFounder: !!(String(merged.founder_name_en || merged.founder_name_cn || '').trim()
        || String(merged.founder_quote_en || merged.founder_quote_cn || '').trim()),
    });
  },

  goShop() { wx.switchTab({ url: '/pages/shop/shop' }); },
});
