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
const track  = require('./utils/track');

App({
  globalData: {
    token: '',
    customer: null,
    lang: 'en',
    configVersion: 0,
    // CMS draft-preview mode. Populated when the mini-app is opened from
    // a /cms preview QR (scene = `dp=1&t=...&p=...`) or via DevTools
    // custom-compile with `?preview_draft=1&preview_token=...&page=...`
    // on the launch URL. While set, config.load() routes through the
    // token-gated draft overlay so staff see their unpublished draft on
    // a real phone before publishing.
    preview: null,  // { draft: true, token: 'xxxx', page: 'home' } | null
  },

  onLaunch(options = {}) {
    this.capturePreviewLaunch(options);

    // Capture the WeChat launch-scene code for traffic attribution.
    track.setScene(options.scene);

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
      this.applyTabBarTheme(cfg.tabBar);
    }).catch((e) => {
      console.warn('[onLaunch] config load failed:', e.message);
    });

    // 5. Auth — silent wx.login exchange. If it fails the customer still
    //    sees the storefront; only checkout / cart-server-sync need auth.
    //
    // The returned promise is exposed as `app.authReady` so any page that
    // actually needs auth before rendering (checkout, addresses, me) can
    // `await getApp().authReady` instead of reading the half-populated
    // `globalData.customer` and showing a bind-empty state until the user
    // navigates somewhere else (the visible "I have to click Me first"
    // bug). Resolves either way — auth failures are logged but don't
    // reject, so pages don't need try/catch.
    if (this.globalData.token) {
      // Restored from storage — already authed for this session, mark
      // ready immediately. Still fire a background silentLogin to bump
      // last_login_at and refresh the customer payload (nickname /
      // tier / balance could have changed in admin).
      this.authReady = Promise.resolve();
      this.silentLogin().catch(() => {});
    } else {
      this.authReady = this.silentLogin()
        .catch(e => { console.warn('[onLaunch] silent login failed:', e.message); });
    }

    // 6. Cart badge from local storage
    cart.updateBadge();
  },

  // onShow fires every time the mini-app is brought to the foreground —
  // including launches from a fresh QR scan when the app is already
  // running. Re-capture preview params here so scanning a different
  // /cms preview QR mid-session correctly swaps preview mode.
  onShow(options = {}) {
    // Traffic: every foreground is an "open". setScene first so a fresh
    // QR-launch scene is attributed; track() groups opens by launch session.
    track.setScene(options.scene);
    track.track(options.path || 'app:show');

    const before = JSON.stringify(this.globalData.preview);
    this.capturePreviewLaunch(options);
    const after  = JSON.stringify(this.globalData.preview);
    if (before !== after) {
      // Preview state changed — force-refresh config so the new draft
      // (or live, if scanning a non-preview QR after a preview one)
      // lands immediately.
      try { config.load(true); } catch {}
    }
  },

  // Read launch options + scene query string and stash preview state on
  // globalData if the right flags are present. Two sources are accepted:
  //   1. options.query.preview_draft = '1' + options.query.preview_token + page
  //      — used by DevTools custom-compile (path = pages/index/index?…).
  //   2. options.scene = 'dp=1&t=TOKEN&p=PAGE'
  //      — used by the wxacode/getUnlimited preview QR.
  // Either path → globalData.preview = { draft: true, token, page }.
  capturePreviewLaunch(options) {
    if (!options || typeof options !== 'object') return;
    const q = options.query || {};
    // (1) DevTools custom-compile path
    if (q.preview_draft === '1' && typeof q.preview_token === 'string') {
      this.globalData.preview = {
        draft: true,
        token: q.preview_token,
        page:  q.page || 'home',
      };
      return;
    }
    // (2) Preview QR scene — short codes to fit the 32-char scene budget
    const scene = decodeURIComponent(options.scene || '');
    if (!scene) return;
    const parts = Object.fromEntries(
      scene.split('&').map(kv => kv.split('=')).filter(p => p.length === 2)
    );
    if (parts.dp === '1' && typeof parts.t === 'string') {
      this.globalData.preview = {
        draft: true,
        token: parts.t,
        page:  parts.p || 'home',
      };
    }
  },

  applyTabBarTheme(tabBarCfg) {
    // Accepts either a string (legacy: just the preset name) or the full
    // tabBar config object from storefront_config. Resolves to the merged
    // visual config used by both the native fallback and the custom tab bar
    // component (which reads globalData.tabBarStyle on its refresh()).
    //
    // oat    = warm cream — matches navigationBarBackgroundColor & brand artwork
    // paper  = clean near-white, slightly cooler than oat
    // forest = dark green for night mode
    // lime   = brand accent as the bar
    const presets = {
      oat:    { backgroundColor: '#F2E7DF', color: '#7a6f64', selectedColor: '#365329', borderStyle: 'white', borderColor: 'rgba(0,0,0,0.06)' },
      paper:  { backgroundColor: '#FBF6E8', color: '#8a8174', selectedColor: '#365329', borderStyle: 'white', borderColor: 'rgba(0,0,0,0.06)' },
      forest: { backgroundColor: '#2a3a22', color: '#a8b8a0', selectedColor: '#ccd900', borderStyle: 'black', borderColor: 'rgba(255,255,255,0.06)' },
      lime:   { backgroundColor: '#ccd900', color: '#5a6300', selectedColor: '#16161a', borderStyle: 'white', borderColor: 'rgba(0,0,0,0.10)' },
    };

    const cfg = typeof tabBarCfg === 'string' ? { theme: tabBarCfg } : (tabBarCfg || {});
    const base = presets[cfg.theme] || presets.oat;
    // Per-property overrides win over preset values when present.
    const merged = {
      ...base,
      ...(cfg.backgroundColor ? { backgroundColor: cfg.backgroundColor } : {}),
      ...(cfg.color           ? { color: cfg.color }                     : {}),
      ...(cfg.selectedColor   ? { selectedColor: cfg.selectedColor }     : {}),
      ...(cfg.borderColor     ? { borderColor: cfg.borderColor }         : {}),
    };
    this.globalData.tabBarStyle = merged;

    // Native fallback — only fires if the custom tab bar isn't rendered
    // (e.g. an older base library that ignores `tabBar.custom`).
    const { backgroundColor, color, selectedColor, borderStyle } = merged;
    try { wx.setTabBarStyle({ backgroundColor, color, selectedColor, borderStyle }); }
    catch (e) { /* setTabBarStyle is a no-op when custom: true is honoured */ }

    // Push to the custom tab bar on whatever page is currently active.
    try {
      const pages = getCurrentPages();
      const top = pages[pages.length - 1];
      const tb = top && top.getTabBar && top.getTabBar();
      if (tb && typeof tb.refresh === 'function') tb.refresh();
    } catch {}
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
