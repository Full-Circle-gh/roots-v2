// Onboarding — first-launch welcome. Renders the CMS-composed
// onboarding.layout (sticker collage, hero, progress dots).

const config = require('../../utils/config');

Page({
  data: { layout: [], lang: 'en', loading: true, version: '1' },

  async onLoad() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    try {
      const cfg = await config.load();
      const ver = Number.isFinite(cfg?.onboarding?.version)
        ? String(cfg.onboarding.version) : '1';
      this.setData({
        layout: cfg?.onboarding?.layout || [],
        version: ver,
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
