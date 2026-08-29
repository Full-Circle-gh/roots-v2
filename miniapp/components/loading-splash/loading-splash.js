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

const config = require('../../utils/config');

// How long the fade-out transition (see .ls-hide in the wxss) takes, plus a
// small margin — after this the overlay unmounts so it stops eating taps.
const FADE_MS = 320;

Component({
  properties: {
    visible: { type: Boolean, value: false },
    text: { type: String, value: '' },
  },
  data: {
    mounted: false,
    logoUrl: '',
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
      this.setData({ logoUrl: splash.logo_image || '' });
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
