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

// ── Picture sizing ────────────────────────────────────────────────────────
// The pop-up picture is never cropped. It fills the card's content width and
// keeps its natural height; when that would push the pop-up off the screen the
// whole image scales down (ratio kept, centred) instead of being trimmed.
//
// Every number below is read off the pop-up frame in popup-manager.wxss:
//   .pm-card is width:100% capped at 600rpx, inside .pm-bg's 56rpx side
//   padding. rpx is a fixed 750-wide grid, so 750 - 2x56 = 638rpx of room and
//   the 600rpx cap always wins — the content width is a hard 600rpx.
const PM_CARD_W_RPX = 600;
// .pm-bg padding: 60rpx top + 60rpx bottom.
const PM_BG_PAD_RPX = 120;
// What's left of the screen after the padding and the text block, at 90%, is
// the tallest a picture may be.
const PM_CAP_RATIO = 0.9;
// .pm-text when it can't be measured: 68rpx padding + headline + two body
// lines + the CTA button.
const PM_TEXT_FALLBACK_RPX = 300;
// Never shrink a picture to nothing, however long the copy runs.
const PM_CAP_FLOOR_RPX = 120;
// Zero height until the natural size is known, so the pop-up never flashes at
// the <image> component's 320x240 default before settling.
const PM_IMG_UNSIZED = 'height:0;opacity:0;';

function pmWindow() {
  try {
    const w = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
    if (w && w.windowWidth && w.windowHeight) return { W: w.windowWidth, H: w.windowHeight };
  } catch {}
  return { W: 375, H: 667 };
}

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
    imgStyle: PM_IMG_UNSIZED,
    dismissible: true,
  },

  lifetimes: {
    attached() {
      this._timer = null;
      // The page's first show() is dispatched before this component exists —
      // it's created during that first render — so pageLifetimes.show alone
      // never fires on a cold launch, and the pop-up only appeared once the
      // customer navigated away and back. Evaluate on attach too. Same
      // both-hooks shape cs-button uses for the same reason.
      this._visible = true;
      this.evaluate();
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
    // is only populated when the launch-time fetch resolves (app.js) — that's
    // a network round trip, so on a cold launch this runs first and a
    // synchronous read saw an empty pop-up list with nothing to re-check it.
    // config.load() is module-cached, so later shows cost no round-trip.
    async evaluate() {
      let cfg;
      try { cfg = await config.load(); } catch { return; }
      // The page may have been hidden or the component detached while the
      // config was in flight — don't pop up onto a screen nobody's looking at.
      if (!this._visible) return;
      // attached() and show() can both land on the first render depending on
      // base-library version. Never stack a second pop-up over an open one.
      if (this.data.open) return;
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
      this._natural = null;
      this.setData({
        open: true,
        popup,
        title:    lang.pick(popup.title_en, popup.title_cn, L),
        body:     lang.pick(popup.body_en,  popup.body_cn,  L),
        ctaLabel: lang.pick(popup.cta_label_en, popup.cta_label_cn, L),
        imageUrl: absUrl(popup.image_url || ''),
        imgStyle: PM_IMG_UNSIZED,
        dismissible: popup.dismissible !== false,
      });
      markShown(popup);
    },

    // The <image> load event hands us the picture's real pixel size — no
    // wx.getImageInfo, which would need the media host on the downloadFile
    // domain allow-list. From there the box is pure arithmetic.
    onImgLoad(e) {
      const d = (e && e.detail) || {};
      if (!d.width || !d.height) return;
      this._natural = { w: d.width, h: d.height };
      this.sizeImage();
    },

    sizeImage() {
      const nat = this._natural;
      if (!nat) return;
      const win = pmWindow();
      const toRpx = px => px * 750 / win.W;
      // Measure the real text block rather than assuming one: a headline-only
      // pop-up leaves far more room for the picture than one with body copy
      // and a CTA, and hard-coding the tallest case would shrink every image.
      this.createSelectorQuery().select('.pm-text').boundingClientRect(rect => {
        const textRpx = (rect && rect.height) ? toRpx(rect.height) : PM_TEXT_FALLBACK_RPX;
        const cap = Math.max(
          PM_CAP_FLOOR_RPX,
          (toRpx(win.H) - PM_BG_PAD_RPX - textRpx) * PM_CAP_RATIO,
        );
        let w = PM_CARD_W_RPX;
        let h = w * nat.h / nat.w;            // natural shape across the card
        if (h > cap) { h = cap; w = h * nat.w / nat.h; }  // too tall: scale it all down
        this.setData({
          imgStyle: `width:${Math.round(w)}rpx;height:${Math.round(h)}rpx;`,
        });
      }).exec();
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
