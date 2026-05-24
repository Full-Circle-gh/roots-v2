const cart = require('../utils/cart');
const api  = require('../utils/api');
const { dataUri } = require('./icons');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

// Page → tab-bar index. Pages list paths without the leading slash for
// switchTab compatibility; the label is overridden per-language on attach.
const TABS_DEF = [
  { name: 'home', path: '/pages/home/home', en: 'Home', cn: '首页' },
  { name: 'shop', path: '/pages/shop/shop', en: 'Shop', cn: '商城' },
  { name: 'cart', path: '/pages/cart/cart', en: 'Cart', cn: '购物车' },
  { name: 'me',   path: '/pages/me/me',     en: 'Me',   cn: '我的'   },
];

Component({
  data: {
    selected: 0,
    tabs: [],
    color: '#7a6f64',
    selectedColor: '#365329',
    backgroundColor: '#F2E7DF',
    borderColor: 'rgba(0,0,0,0.06)',
  },

  lifetimes: {
    attached() {
      this.unsubscribe = cart.subscribe(() => this.refreshBadge());
      this.refresh();
    },
    detached() {
      if (this.unsubscribe) this.unsubscribe();
    },
  },

  methods: {
    // Called by pages from their onShow to mark the active tab + sync any
    // freshly-published config tweaks. Pass the page's path (no leading /).
    setSelected(pagePath) {
      const path = '/' + pagePath.replace(/^\//, '');
      const i = TABS_DEF.findIndex(t => t.path === path);
      if (i >= 0 && this.data.selected !== i) this.setData({ selected: i });
      this.refresh();
    },

    refresh() {
      const app = getApp();
      const cfg = app?.globalData?.config?.tabBar || {};
      const styleCfg = app?.globalData?.tabBarStyle || {};
      const lang = app?.globalData?.lang || 'en';

      const iconStyle    = cfg.iconStyle      || 'outline';
      const color        = styleCfg.color         || cfg.color         || '#7a6f64';
      const selectedColor= styleCfg.selectedColor || cfg.selectedColor || '#365329';
      const bg           = styleCfg.backgroundColor || cfg.backgroundColor || '#F2E7DF';
      const border       = styleCfg.borderColor || cfg.borderColor || 'rgba(0,0,0,0.06)';
      // Per-tab custom icon URL overrides, set from the CMS TAB BAR picker.
      // When present, the URL is used for BOTH active and inactive states —
      // the active highlight comes from the indicator bar above the icon
      // (rendered in WXSS), not from re-tinting the image.
      const customIcons = cfg.icons || {};

      const cartCount = cart.count();
      const tabs = TABS_DEF.map(t => {
        const customUrl = customIcons[t.name];
        const icon       = customUrl ? absUrl(customUrl) : dataUri(iconStyle, t.name, color);
        const iconActive = customUrl ? absUrl(customUrl) : dataUri(iconStyle, t.name, selectedColor);
        return {
          path: t.path,
          label: lang === 'cn' ? t.cn : t.en,
          icon, iconActive,
          badge: t.name === 'cart' ? cartCount : 0,
        };
      });

      this.setData({
        tabs,
        color,
        selectedColor,
        backgroundColor: bg,
        borderColor: border,
      });
    },

    refreshBadge() {
      const cartCount = cart.count();
      const tabs = this.data.tabs.map(t =>
        t.path.endsWith('/cart/cart') ? { ...t, badge: cartCount } : t);
      this.setData({ tabs });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;
      const index = Number(e.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      wx.switchTab({ url: path });
    },
  },
});
