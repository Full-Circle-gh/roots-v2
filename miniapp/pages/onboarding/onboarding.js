// Onboarding — first-launch welcome. Renders the CMS-composed
// onboarding.layout (sticker collage, hero, progress dots).

const config = require('../../utils/config');
const api    = require('../../utils/api');

// Hardcoded fallback — used when the CMS hasn't overridden the label
// or when /api/retail/config fails to resolve.
const DEFAULT_NEXT = { en: 'GET STARTED', cn: '开始' };

function pickLabel(node, lang, fallback) {
  const v = node && typeof node === 'object' ? String(node[lang] || '').trim() : '';
  return v || fallback[lang] || fallback.en;
}

Page({
  data: {
    layout: [], lang: 'en', loading: true, version: '1',
    nextLabel: DEFAULT_NEXT.en,
    leaderboards: {},
    // True when the layout contains a full-screen video block — switches the
    // page into splash mode (video covers the screen, button floats on top).
    splash: false,
  },

  async onLoad() {
    const app = getApp();
    const lang = app.globalData.lang || 'en';
    this.setData({
      lang,
      nextLabel: DEFAULT_NEXT[lang] || DEFAULT_NEXT.en,
    });
    try {
      const cfg = await config.load();
      const ver = Number.isFinite(cfg?.onboarding?.version)
        ? String(cfg.onboarding.version) : '1';
      const layout = cfg?.onboarding?.layout || [];
      const splash = layout.some(b => b && b.type === 'video_banner' && b.display === 'fullscreen');
      this.setData({
        layout,
        version: ver,
        splash,
        nextLabel: pickLabel(cfg?.onboarding?.next_label, lang, DEFAULT_NEXT),
        loading: false,
      });
      this._fetchLeaderboardsFor(layout);
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  // Lazily fetch the public storefront leaderboard for any leaderboard block
  // placed on the onboarding layout — keyed by metric|period|top_n|reveal_mode,
  // same pattern as home/layout pages. Setting data.leaderboards triggers the
  // block-renderer observer so the strip fills in place.
  async _fetchLeaderboardsFor(layout) {
    const keys = new Set();
    (layout || []).forEach(b => {
      if (b.type !== 'leaderboard') return;
      const metric = b.metric || 'lifetime_spend';
      const period = b.period || 'month';
      const topN   = Math.max(3, Math.min(10, b.top_n || 5));
      const reveal = b.reveal_mode || 'first_char';
      keys.add(`${metric}|${period}|${topN}|${reveal}`);
    });
    if (!keys.size) return;
    const next = { ...(this.data.leaderboards || {}) };
    await Promise.all([...keys].map(async key => {
      if (next[key]) return;
      const [metric, period, top_n, reveal_mode] = key.split('|');
      try {
        const res = await api.get(`/api/retail/storefront/leaderboard?metric=${encodeURIComponent(metric)}&period=${encodeURIComponent(period)}&top_n=${encodeURIComponent(top_n)}&reveal_mode=${encodeURIComponent(reveal_mode)}`);
        next[key] = (res && Array.isArray(res.entries)) ? res.entries : [];
      } catch {
        next[key] = [];
      }
    }));
    this.setData({ leaderboards: next });
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
