// Recent-buyers ticker. A gentle, dismissible toast that slides in bottom-left
// and cycles through real recent purchases ("李** just bought X · 5 min ago"),
// giving the store a "live" feel. Self-contained: fetches its own feed from
// /api/retail/social/recent-buyers (names already masked server-side) and
// renders nothing until data arrives. Drop <recent-buyers lang="{{lang}}"/>
// onto any page that wants it.

const api = require('../../utils/api');

const FIRST_MS   = 2500;  // settle delay before the first toast
const VISIBLE_MS = 4500;  // how long each toast stays up
const GAP_MS     = 5000;  // quiet gap between toasts

Component({
  properties: {
    // Current UI language, passed from the host page; falls back to global.
    lang: { type: String, value: 'en' },
  },

  data: {
    items: [],
    text: '',
    idx: 0,
    visible: false,
    dismissed: false,
  },

  observers: {
    // Re-render the live toast text when the user flips EN/CN mid-cycle.
    lang() {
      if (this.data.visible && this.data.items.length) {
        const it = this.data.items[this.data.idx % this.data.items.length];
        if (it) this.setData({ text: this.format(it) });
      }
    },
  },

  lifetimes: {
    attached() {
      this._timer = null;
      const app = getApp();
      // Stay dismissed for the rest of the session if the user closed it.
      if (app && app.globalData && app.globalData.recentBuyersDismissed) {
        this.setData({ dismissed: true });
        return;
      }
      this.load();
    },
    detached() { this.stop(); },
  },

  pageLifetimes: {
    hide() {
      this.stop();
      if (this.data.visible) this.setData({ visible: false });
    },
    show() {
      if (this.data.items.length && !this.data.dismissed && !this._timer) {
        this.queueNext(FIRST_MS);
      }
    },
  },

  methods: {
    async load() {
      try {
        const res = await api.get('/api/retail/social/recent-buyers');
        const items = Array.isArray(res) ? res : (res && res.data) || [];
        if (!items.length || this.data.dismissed) return;
        this.setData({ items });
        this.queueNext(FIRST_MS);
      } catch (e) {
        // Nice-to-have surface — fail silently, never block the page.
      }
    },

    queueNext(delay) {
      this.stop();
      this._timer = setTimeout(() => this.showCurrent(), delay);
    },

    showCurrent() {
      if (this.data.dismissed || !this.data.items.length) return;
      const it = this.data.items[this.data.idx % this.data.items.length];
      this.setData({ text: this.format(it), visible: true });
      this._timer = setTimeout(() => {
        this.setData({ visible: false });
        this._timer = setTimeout(() => {
          this.setData({ idx: (this.data.idx + 1) % this.data.items.length });
          this.showCurrent();
        }, GAP_MS);
      }, VISIBLE_MS);
    },

    stop() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },

    format(it) {
      const app = getApp();
      const L = this.properties.lang || (app && app.globalData && app.globalData.lang) || 'en';
      const name = it.name || (L === 'cn' ? '有人' : 'Someone');
      const product = L === 'cn'
        ? (it.product_cn || it.product_en)
        : (it.product_en || it.product_cn);
      const ago = this.agoText(it.ts, L);
      return L === 'cn'
        ? `${name} ${ago}购买了${product}`
        : `${name} bought ${product} · ${ago}`;
    },

    agoText(ts, L) {
      const ms = Date.now() - Number(ts || 0);
      const min = Math.floor(ms / 60000);
      if (min < 1)  return L === 'cn' ? '刚刚' : 'just now';
      if (min < 60) return L === 'cn' ? `${min}分钟前` : `${min} min ago`;
      const hr = Math.floor(min / 60);
      if (hr < 24)  return L === 'cn' ? `${hr}小时前` : `${hr}h ago`;
      const d = Math.floor(hr / 24);
      if (d <= 1)   return L === 'cn' ? '昨天' : 'yesterday';
      return L === 'cn' ? `${d}天前` : `${d}d ago`;
    },

    dismiss() {
      this.stop();
      this.setData({ visible: false, dismissed: true });
      const app = getApp();
      if (app && app.globalData) app.globalData.recentBuyersDismissed = true;
    },
  },
});
