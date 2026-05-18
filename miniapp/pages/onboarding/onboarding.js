// Onboarding — first-launch welcome. Renders the CMS-composed
// onboarding.layout (sticker collage, hero, progress dots).

const config = require('../../utils/config');

Page({
  data: { layout: [], lang: 'en', loading: true },

  async onLoad() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    try {
      const cfg = await config.load();
      this.setData({ layout: cfg?.onboarding?.layout || [], loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  goHome() {
    // Mark as onboarded BEFORE redirect so home.js doesn't bounce us back.
    try { wx.setStorageSync('onboarded', '1'); } catch {}
    // reLaunch closes all pages and opens the new one fresh, so the back
    // button on Home doesn't take you back to onboarding.
    wx.reLaunch({ url: '/pages/home/home' });
  },
});
