// Pop-up manager. One component sits on each page that's eligible to show
// pop-ups. It reads `popups.list` from storefront_config, filters by:
//   1. enabled flag
//   2. start_at / end_at window
//   3. pages array (matches the `page` prop, or 'all')
//   4. frequency rule (storage tracks each popup's last shown)
// Picks the first eligible popup and schedules it per its trigger.

const lang = require('../../utils/lang');
const config = require('../../utils/config');
const { BASE } = require('../../utils/api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function nowMs()    { return Date.now(); }

function storageKey(id) { return 'popup_seen:' + id; }

function shouldShowPerFrequency(popup) {
  let seen = null;
  try { seen = wx.getStorageSync(storageKey(popup.id)); } catch {}
  const freq = popup.frequency || 'once';
  if (freq === 'every_visit') return true;
  if (!seen) return true;
  if (freq === 'once') return false;
  if (freq === 'session') {
    const app = getApp();
    const sessionStart = app?.globalData?.sessionStartMs || 0;
    // If "seen" was during this session, skip
    return Number(seen.ts || 0) < sessionStart;
  }
  if (freq === 'daily') {
    return seen.day !== todayKey();
  }
  return true;
}

function markShown(popup) {
  try {
    wx.setStorageSync(storageKey(popup.id), { ts: nowMs(), day: todayKey() });
  } catch {}
}

function withinDateWindow(p) {
  const today = todayKey();
  if (p.start_at && today < p.start_at) return false;
  if (p.end_at   && today > p.end_at)   return false;
  return true;
}

Component({
  properties: {
    // Which page key this manager runs on: 'home', 'shop', 'product', etc.
    page: { type: String, value: '' },
  },
  data: {
    open: false,
    popup: null,
    title: '',
    body: '',
    ctaLabel: '',
    imageUrl: '',
    dismissible: true,
  },

  lifetimes: {
    attached() {
      this._timer = null;
    },
    detached() {
      this._visible = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
  },
  pageLifetimes: {
    // evaluate() is async (it awaits the storefront config), so fire it
    // without blocking the page's show — the pop-up lands a beat after the
    // page paints rather than holding up first frame.
    show() { this._visible = true; this.evaluate(); },
    hide() {
      this._visible = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
  },

  methods: {
    // Awaits the real config rather than reading app.globalData.config, which
    // is only populated when the launch-time fetch resolves (app.js) — on a
    // cold launch this component's first `show` fires well before that, so a
    // synchronous read saw an empty list and no pop-up ever rendered until the
    // customer left and re-entered. config.load() is module-cached, so on
    // re-entry / later shows this resolves without a second round-trip.
    async evaluate() {
      let cfg;
      try { cfg = await config.load(); } catch { return; }
      // The page may have been hidden or the component detached while the
      // config was in flight — don't pop up onto a screen nobody's looking at.
      if (!this._visible) return;
      const list = Array.isArray(cfg?.popups?.list) ? cfg.popups.list : [];
      const page = this.properties.page || '';
      const eligible = list
        .filter(p => p && p.enabled)
        .filter(withinDateWindow)
        .filter(p => {
          const pages = Array.isArray(p.pages) ? p.pages : [];
          return pages.includes('all') || pages.includes(page);
        })
        .filter(shouldShowPerFrequency);

      if (!eligible.length) return;
      const popup = eligible[0];
      const delaySec = popup.trigger === 'after_seconds'
        ? Math.max(0, Number(popup.delay_seconds) || 0)
        : 0;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this._timer = setTimeout(() => this.show(popup), delaySec * 1000);
    },

    show(popup) {
      const L = getApp().globalData.lang || 'en';
      this.setData({
        open: true,
        popup,
        title:    lang.pick(popup.title_en, popup.title_cn, L),
        body:     lang.pick(popup.body_en,  popup.body_cn,  L),
        ctaLabel: lang.pick(popup.cta_label_en, popup.cta_label_cn, L),
        imageUrl: absUrl(popup.image_url || ''),
        dismissible: popup.dismissible !== false,
      });
      markShown(popup);
    },

    onTapCta() {
      const popup = this.data.popup;
      if (!popup) return;
      this.setData({ open: false });
      const target = (popup.cta_target || '').trim();
      if (!target) return;
      this.routeTarget(target);
    },

    onClose() {
      if (!this.data.dismissible) return;
      this.setData({ open: false });
    },

    // Don't dismiss when tapping the modal body itself
    swallow() {},

    routeTarget(t) {
      // Same scheme as block-renderer hero-banner CTAs
      if (t === 'shop')       return wx.switchTab({ url: '/pages/shop/shop' });
      if (t === 'cart')       return wx.switchTab({ url: '/pages/cart/cart' });
      if (t === 'home')       return wx.switchTab({ url: '/pages/home/home' });
      if (t === 'me')         return wx.switchTab({ url: '/pages/me/me' });
      if (t === 'membership') return wx.navigateTo({ url: '/pages/membership/membership' });
      if (t === 'promotions' || t === 'about' || t === 'categories') {
        return wx.navigateTo({ url: '/pages/layout/layout?page=' + t });
      }
      if (t.startsWith('product:'))  return wx.navigateTo({ url: '/pages/product/product?id=' + t.split(':')[1] });
      if (t.startsWith('category:')) return wx.switchTab({ url: '/pages/shop/shop' });
      // External web URL not supported in mini-program — silently ignore.
    },
  },
});
