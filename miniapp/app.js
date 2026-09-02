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
const diag   = require('./utils/diag');

App({
  globalData: {
    token: '',
    customer: null,
    lang: 'en',
    configVersion: 0,
    // The address the customer last selected at checkout (or the default they
    // landed on). Lets the cart's free-shipping bar resolve the right zone
    // threshold for the address actually in play, not just the saved default.
    activeAddressId: null,
    // CMS draft-preview mode. Populated when the mini-app is opened from
    // a /cms preview QR (scene = `dp=1&t=...&p=...`) or via DevTools
    // custom-compile with `?preview_draft=1&preview_token=...&page=...`
    // on the launch URL. While set, config.load() routes through the
    // token-gated draft overlay so staff see their unpublished draft on
    // a real phone before publishing.
    preview: null,  // { draft: true, token: 'xxxx', page: 'home' } | null
  },

  onLaunch(options = {}) {
    // Start of this app session. `frequency: session` pop-ups compare their
    // stored "last shown" against this, so it has to be stamped once per cold
    // start — it used to be stamped by whichever popup-manager attached first,
    // which made the baseline drift with navigation. globalData lives until
    // WeChat evicts the mini app, so the next cold start gets a fresh stamp.
    this.globalData.sessionStartMs = Date.now();

    this.capturePreviewLaunch(options);
    // Stash a scanned affiliate code before anything async runs, so a slow
    // config/auth round-trip can't lose it.
    this.captureReferralLaunch(options);

    // Capture the WeChat launch-scene code for traffic attribution.
    track.setScene(options.scene);
    diag.setScene(options.scene);

    // Diagnostics: post one device + app-version snapshot per launch so
    // support can see what phone / app build a customer is on when they
    // report a problem — even when nothing crashes. Fire-and-forget; runs
    // after a tick so it never competes with first-frame work.
    setTimeout(() => { try { diag.reportSession(); } catch (e) {} }, 0);

    // 1. Fonts — fire-and-forget, swap when ready. `fontsReady` (a promise)
    //    resolves once the primary brand fonts have loaded, so pages can fade
    //    brand text in instead of flashing system fonts on the very first
    //    launch (before utils/fonts.js has cached the files on-device). On
    //    every later launch the cache makes this resolve almost immediately.
    this.globalData.fontsReady = false;
    this.fontsReady = new Promise((resolve) => {
      fonts.loadAll(() => {
        this.globalData.fontsReady = true;
        resolve();
      });
    });

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

    // 5b. A scanned affiliate code needs a customer to attach to, so it waits
    //     on auth. On a cold launch from a scan this is the step that registers
    //     the new customer under the affiliate who owns the code.
    this.authReady.then(() => this.applyPendingReferral());

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

    diag.setScene(options.scene);

    // Scanning an affiliate's code while the app is already open comes through
    // here, not onLaunch. Auth is already settled in that case, so it can go
    // straight out; on a cold start there's no token yet and this no-ops,
    // leaving onLaunch's authReady hand-off to do it.
    this.captureReferralLaunch(options);
    this.applyPendingReferral();

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

  // App-level JS error. WeChat calls this for any uncaught error in page /
  // component lifecycle and event handlers. Forward to diagnostics so a
  // crash a customer hits shows up in the admin's per-customer log. The
  // string carries "message\n  at stack…"; split so the message is searchable.
  onError(err) {
    try {
      const s = String(err == null ? '' : err);
      const nl = s.indexOf('\n');
      const message = nl === -1 ? s : s.slice(0, nl);
      const stack   = nl === -1 ? null : s.slice(nl + 1);
      // WeChat throws this MiniProgramError itself while it resolves the
      // missing pages/index/index launch/relaunch (see onPageNotFound below)
      // — it's the same benign, self-recovering event, just surfaced through
      // onError instead of onPageNotFound. Treat it the same way (a notice,
      // not an error) so it doesn't double up a healthy customer's error count.
      if (message.indexOf('Component is not found in path "wx://not-found"') !== -1) {
        diag.reportNotice(message, { stack });
      } else {
        diag.reportError(message, stack);
      }
    } catch (e) { /* never let the error reporter throw */ }
  },

  // Unhandled promise rejection (e.g. an awaited api call that nobody caught).
  onUnhandledRejection(res) {
    try {
      const reason = res && res.reason;
      const message = reason && reason.message ? reason.message : String(reason);
      const stack   = reason && reason.stack ? reason.stack : null;
      diag.reportError('unhandledRejection: ' + message, stack);
    } catch (e) { /* never let the error reporter throw */ }
  },

  // Stale share cards, QR scenes, or an old console "start page" can point at
  // a path that no longer exists (e.g. the conventional pages/index/index,
  // which this app never registered — its entry is pages/home/home). Without a
  // handler WeChat surfaces that as an uncaught MiniProgramError and the app
  // fails to open. Land the customer on home instead, and log it so support can
  // see the bad path that was attempted.
  onPageNotFound(res) {
    // pages/index/index is the conventional WeChat home this app never
    // registered (its entry is pages/home/home). A stale shortcut, share card,
    // or cached start-page on a customer's device keeps asking for it; we bounce
    // them to home every launch, so it's a fully self-recovering non-event.
    // Log it as a quiet breadcrumb — NOT an error — so it doesn't inflate a
    // healthy customer's error count. Any OTHER missing path is a real bug.
    const path = res && res.path;
    try {
      const label = 'onPageNotFound: ' + path;
      if (path === 'pages/index/index') diag.reportNotice(label, res);
      else diag.reportError(label, null, res);
    } catch (e) {}
    // home is a tab-bar page → switchTab; reLaunch covers anything else.
    try {
      wx.switchTab({
        url: '/pages/home/home',
        fail() { try { wx.reLaunch({ url: '/pages/home/home' }); } catch (e) {} },
      });
    } catch (e) {
      try { wx.reLaunch({ url: '/pages/home/home' }); } catch (e2) {}
    }
  },

  // Decode the scene string a scanned mini-program code (小程序码) carries.
  //
  // At APP level `options.scene` is WeChat's numeric 场景值 (1047 = "scanned a
  // mini-program code") — the same number track.setScene() records, which is
  // why it type-guards on `typeof s === 'number'`. The scene STRING the code
  // was minted with arrives as `options.query.scene`, URL-encoded. Reading it
  // off `options.scene` yields "1047", which parses to nothing and fails
  // silently, so both readers below go through here.
  sceneParams(options) {
    const raw = options && options.query ? options.query.scene : '';
    if (!raw) return {};
    let scene = '';
    try { scene = decodeURIComponent(String(raw)); } catch (e) { scene = String(raw); }
    return Object.fromEntries(
      scene.split('&').map(kv => kv.split('=')).filter(p => p.length === 2)
    );
  },

  // Read launch options + scene query string and stash preview state on
  // globalData if the right flags are present. Two sources are accepted:
  //   1. options.query.preview_draft = '1' + options.query.preview_token + page
  //      — used by DevTools custom-compile (path = pages/index/index?…).
  //   2. scene = 'dp=1&t=TOKEN&p=PAGE'
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
    const parts = this.sceneParams(options);
    if (parts.dp === '1' && typeof parts.t === 'string') {
      this.globalData.preview = {
        draft: true,
        token: parts.t,
        page:  parts.p || 'home',
      };
    }
  },

  // Referral capture. Two doorways, one destination:
  //   • an affiliate's mini-program code → scene `r=CODE` (this is the scan)
  //   • a shared card or ?ref= link      → options.query.ref
  // Both are stashed under `pending_ref`; applyPendingReferral() below turns
  // that into the real referral once a customer record exists. Stashing rather
  // than posting straight away matters because on a cold launch from a scan
  // there is no customer yet — wx.login hasn't run.
  captureReferralLaunch(options) {
    if (!options || typeof options !== 'object') return;
    const q = options.query || {};
    const fromScene = this.sceneParams(options).r || '';
    const code = String(fromScene || q.ref || '').toUpperCase().slice(0, 32);
    if (!code) return;
    try { wx.setStorageSync('pending_ref', code); } catch (e) {}
  },

  // Apply a stashed referral code. Deliberately posts to the SAME endpoint the
  // affiliate page's typed-code box uses, so a scan gets the identical guards
  // (already referred / own code / mutual / program off) and the identical
  // reward — the friend is registered under the affiliate either way.
  applyPendingReferral() {
    let code = '';
    try { code = wx.getStorageSync('pending_ref') || ''; } catch (e) {}
    // No token yet → leave it stashed; the next launch (or onShow) retries.
    if (!code || !this.globalData.token) return Promise.resolve();
    if (this._applyingRef) return this._applyingRef;

    const cn = this.globalData.lang === 'cn';
    const clear = () => { try { wx.removeStorageSync('pending_ref'); } catch (e) {} };

    this._applyingRef = api.post('/api/retail/affiliate/apply', { code })
      .then(() => {
        clear();
        wx.showToast({
          title: cn ? '已通过好友邀请进入' : "Your friend's invite is applied",
          icon: 'none',
          duration: 2200,
        });
      })
      .catch((e) => {
        // These four can never succeed for this customer, so stop carrying the
        // code around. Anything else (offline, program paused, a 5xx) keeps it
        // stashed and retries on the next launch.
        const spent = ['already_referred', 'code_not_found', 'cannot_refer_self', 'mutual_referral'];
        if (spent.includes(e && e.message)) clear();
      })
      .then(() => { this._applyingRef = null; });

    return this._applyingRef;
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

  // Mid-session token recovery. api.js calls this when a request comes back
  // 401 (token expired, or an admin "force logout" wiped the server-side
  // tokens), then replays the failed request. We drop the dead token first
  // so a concurrent request can't keep reusing it, then run a fresh silent
  // login. Concurrent 401s coalesce onto one wx.login round-trip via the
  // in-flight guard, which clears once the login settles so a *later*
  // force-logout can trigger another recovery.
  reauth() {
    if (!this._reauthPromise) {
      this.globalData.token = '';
      try { wx.removeStorageSync('token'); } catch {}
      this._reauthPromise = this.silentLogin();
      this._reauthPromise.then(
        () => { this._reauthPromise = null; },
        () => { this._reauthPromise = null; },
      );
    }
    return this._reauthPromise;
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
