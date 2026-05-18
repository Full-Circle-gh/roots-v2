// Roots mini app entry point.
// Sequence on launch:
//   1. Load brand fonts (async, non-blocking)
//   2. Restore auth token from storage (if any)
//   3. Detect language preference
//   4. Fetch storefront config (theme + layouts + copy)
//   5. wx.login → /api/retail/auth (silent — no user prompt)

const api    = require('./utils/api');
const fonts  = require('./utils/fonts');
const config = require('./utils/config');
const lang   = require('./utils/lang');
const cart   = require('./utils/cart');

App({
  globalData: {
    token: '',
    customer: null,
    lang: 'en',
    configVersion: 0,
  },

  onLaunch() {
    // 1. Fonts — fire-and-forget, swap when ready
    fonts.loadAll();

    // 2. Restore auth from storage
    try {
      const t = wx.getStorageSync('token');
      const c = wx.getStorageSync('customer');
      if (t) this.globalData.token = t;
      if (c) this.globalData.customer = c;
    } catch {}

    // 3. Language
    this.globalData.lang = lang.detect();

    // 4. Config — fire-and-forget. Pages call config.load() themselves and
    //    render with cached/empty config if this is still in flight. Blocking
    //    onLaunch on a network round-trip pushes launch over 1s and trips
    //    WeChat's frame-end timeout in dev tools.
    config.load(true).then((cfg) => {
      this.globalData.config = cfg;
      this.globalData.configVersion = cfg.version;
      if (!wx.getStorageSync('lang') && cfg.theme?.language && ['en', 'cn'].includes(cfg.theme.language)) {
        this.globalData.lang = cfg.theme.language;
      }
      this.applyTabBarTheme(cfg.tabBar?.theme || 'oat');
    }).catch((e) => {
      console.warn('[onLaunch] config load failed:', e.message);
    });

    // 5. Auth — silent wx.login exchange. If it fails the customer still
    //    sees the storefront; only checkout / cart-server-sync need auth.
    if (!this.globalData.token) {
      this.silentLogin().catch(e => console.warn('[onLaunch] silent login failed:', e.message));
    }

    // 6. Cart badge from local storage
    cart.updateBadge();
  },

  applyTabBarTheme(theme) {
    const presets = {
      oat:    { backgroundColor: '#FFFCF7', color: '#9b9285', selectedColor: '#365329', borderStyle: 'white' },
      paper:  { backgroundColor: '#fafaf5', color: '#9b9285', selectedColor: '#365329', borderStyle: 'white' },
      forest: { backgroundColor: '#2a3a22', color: '#a8b8a0', selectedColor: '#ccd900', borderStyle: 'black' },
      lime:   { backgroundColor: '#ccd900', color: '#5a6300', selectedColor: '#16161a', borderStyle: 'white' },
    };
    const p = presets[theme] || presets.oat;
    try { wx.setTabBarStyle(p); }
    catch (e) { console.warn('[applyTabBarTheme]', e.message); }
  },

  async silentLogin() {
    const { code } = await new Promise((resolve, reject) =>
      wx.login({ success: resolve, fail: reject }));
    if (!code) throw new Error('no_login_code');
    const userInfo = wx.getStorageSync('userInfo') || {};
    const resp = await api.post('/api/retail/auth', {
      code,
      nickname: userInfo.nickName,
      avatar_url: userInfo.avatarUrl,
    });
    this.globalData.token = resp.token;
    this.globalData.customer = resp.customer;
    try {
      wx.setStorageSync('token', resp.token);
      wx.setStorageSync('customer', resp.customer);
    } catch {}
  },
});
