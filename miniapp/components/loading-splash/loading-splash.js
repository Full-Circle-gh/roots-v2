// Branded loading splash — a full-screen overlay showing the tenant's own
// logo (set in /cms → Theme & brand → Loading screen, stored under
// brand.loading_splash) instead of a blank page while something the
// customer is staring at loads: app launch, a live map initialising, a
// full-page fetch. Falls back to a generic dot-pulse + localized "Loading…"
// when the tenant hasn't uploaded a logo.
//
// Usage: <loading-splash visible="{{someFlag}}" />
// Optional `text` property overrides the label for a specific screen
// (e.g. "Loading map…"); otherwise it reads brand.loading_splash's own
// label, then falls back to a generic bilingual "Loading…".
// Optional `tabbar` property (Boolean) — set true on a page that sits under
// the custom tab bar (currently just Home) so the mark centres in the space
// actually free of chrome instead of the full raw screen height.

const config = require('../../utils/config');

// How long the fade-out transition (see .ls-hide in the wxss) takes, plus a
// small margin — after this the overlay unmounts so it stops eating taps.
const FADE_MS = 320;

Component({
  properties: {
    visible: { type: Boolean, value: false },
    text: { type: String, value: '' },
    tabbar: { type: Boolean, value: false },
  },
  data: {
    mounted: false,
    logoUrl: '',
    isGif: false,
    displayLabel: '',
  },
  lifetimes: {
    attached() {
      if (this.properties.visible) this.show();
    },
    detached() {
      if (this._hideTimer) clearTimeout(this._hideTimer);
    },
  },
  observers: {
    visible(v) {
      if (v) this.show();
      else this.hide();
    },
    text() {
      if (this.data.mounted) this.applyLabel();
    },
  },
  methods: {
    show() {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      this.applyConfig();
      this.setData({ mounted: true });
    },
    hide() {
      if (!this.data.mounted) return;
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => {
        this._hideTimer = null;
        if (!this.properties.visible) this.setData({ mounted: false });
      }, FADE_MS);
    },
    applyConfig() {
      const splash = config.get('brand.loading_splash', {}) || {};
      const logoUrl = splash.logo_image || '';
      // An animated GIF supplies its own motion — that's the "let it move"
      // option — so the CSS breathing pulse (meant to keep a STATIC logo
      // from looking dead) is skipped for it; see .ls-logo-breathe in the wxss.
      const isGif = /^data:image\/gif/i.test(logoUrl) || /\.gif($|\?)/i.test(logoUrl);
      this.setData({ logoUrl, isGif });
      this.applyLabel(splash);
    },
    applyLabel(splash) {
      const s = splash || config.get('brand.loading_splash', {}) || {};
      const app = getApp();
      const L = (app && app.globalData && app.globalData.lang) || 'en';
      const custom = (this.properties.text || '').trim();
      const label = custom
        || (L === 'cn' ? (s.label_cn || '').trim() : (s.label_en || '').trim())
        || (L === 'cn' ? '加载中…' : 'Loading…');
      this.setData({ displayLabel: label });
    },
  },
});
