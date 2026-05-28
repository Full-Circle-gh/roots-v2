// Onboarding — first-launch welcome. Renders the CMS-composed
// onboarding.layout (sticker collage, hero, progress dots).

const config = require('../../utils/config');

// Hardcoded fallbacks — used when the CMS hasn't overridden the labels
// or when /api/retail/config fails to resolve.
const DEFAULT_SKIP = { en: 'SKIP',     cn: '跳过' };
const DEFAULT_NEXT = { en: 'NEXT →',   cn: '下一步 →' };

function pickLabel(node, lang, fallback) {
  const v = node && typeof node === 'object' ? String(node[lang] || '').trim() : '';
  return v || fallback[lang] || fallback.en;
}

Page({
  data: {
    layout: [], lang: 'en', loading: true, version: '1',
    skipLabel: DEFAULT_SKIP.en,
    nextLabel: DEFAULT_NEXT.en,
  },

  async onLoad() {
    const app = getApp();
    const lang = app.globalData.lang || 'en';
    this.setData({
      lang,
      skipLabel: DEFAULT_SKIP[lang] || DEFAULT_SKIP.en,
      nextLabel: DEFAULT_NEXT[lang] || DEFAULT_NEXT.en,
    });
    try {
      const cfg = await config.load();
      const ver = Number.isFinite(cfg?.onboarding?.version)
        ? String(cfg.onboarding.version) : '1';
      this.setData({
        layout: cfg?.onboarding?.layout || [],
        version: ver,
        skipLabel: pickLabel(cfg?.onboarding?.skip_label, lang, DEFAULT_SKIP),
        nextLabel: pickLabel(cfg?.onboarding?.next_label, lang, DEFAULT_NEXT),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  goHome() {
    // Mark as onboarded for THIS content version, so a future admin
    // version-bump can re-show the page to returning users.
    try { wx.setStorageSync('onboarded', this.data.version || '1'); } catch {}
    // reLaunch closes all pages and opens the new one fresh, so the back
    // button on Home doesn't take you back to onboarding.
    wx.reLaunch({ url: '/pages/home/home' });
  },
});
