// Customer-service button. Reads customer_service config from storefront,
// renders one of three variants (menu row / floating bubble / inline pill),
// and dispatches the tap based on the configured mode:
//   wecom → wx.openCustomerServiceChat({ corpId, url })
//   kf    → native <button open-type="contact"> handles it itself
//   qr    → show an in-app modal with the QR image
//   off   → component renders nothing

const lang = require('../../utils/lang');
const config = require('../../utils/config');
const { BASE } = require('../../utils/api');

function absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return u;
}

function winSize() {
  try {
    if (typeof wx.getWindowInfo === 'function') {
      const w = wx.getWindowInfo();
      return { W: w.windowWidth, H: w.windowHeight };
    }
  } catch (e) { /* fall through */ }
  const s = wx.getSystemInfoSync();
  return { W: s.windowWidth, H: s.windowHeight };
}

const DRAG_MARGIN = 10; // px gap kept from the screen edge when snapped

Component({
  properties: {
    // 'row' (Me tab full-width row), 'fab' (floating bubble), 'inline' (pill)
    variant: { type: String, value: 'row' },
    // 'me' | 'home' | 'product' | 'checkout' | 'order' — which show_* flag to check
    placement: { type: String, value: '' },
    // optional override label, defaults to admin config
    label:   { type: String, value: '' },
  },
  data: {
    visible: false,
    mode: 'off',        // 'wecom' | 'kf' | 'qr' | 'off'
    openType: '',       // 'contact' for kf mode, '' otherwise (so bindtap fires)
    displayLabel: '',
    displayHours: '',
    qrModalOpen: false,
    qrUrl: '',
    // Drag override for the floating bubble — appended after fabStyle so its
    // left/top win over the config-driven right/bottom. Empty until dragged.
    dragStyle: '',
    // Floating-bubble (fab) appearance — driven by admin config
    fabStyle: '',
    fabIsDots: true,
    fabGlyph: '',
    fabGlyphSize: 42,
    fabShowLabel: false,
  },
  lifetimes: {
    attached() { this.recompute(); },
  },
  pageLifetimes: {
    show() { this.recompute(); },
  },
  methods: {
    // Resolve the storefront config and (re)render. On a cold launch
    // globalData.config is still in flight when this component attaches, so
    // recompute would hide the button and only reappear on the next page
    // show() (navigate away + back). When config isn't ready yet, await the
    // shared config cache and re-apply once it lands.
    recompute() {
      const app = getApp();
      if (app.globalData.config) {
        this.applyConfig(app.globalData.config);
        return;
      }
      config.load(false).then((full) => {
        if (full && !app.globalData.config) app.globalData.config = full;
        this.applyConfig(full || {});
      }).catch(() => this.applyConfig({}));
    },
    applyConfig(cfg) {
      const cs = (cfg && cfg.customer_service) || {};
      const mode = cs.mode || 'off';
      if (mode === 'off') {
        this.setData({ visible: false });
        return;
      }
      // Honour the per-placement show flag (defaults match the admin defaults)
      const placement = this.properties.placement || '';
      const flagDefault = { me: true, home: false, product: true, checkout: true, order: true };
      if (placement) {
        const flagKey = 'show_' + placement;
        const flag = (flagKey in cs) ? !!cs[flagKey] : !!flagDefault[placement];
        if (!flag) { this.setData({ visible: false }); return; }
      }
      const L = getApp().globalData.lang || 'en';
      const label = (this.properties.label && this.properties.label.trim())
        || lang.pick(cs.label_en, cs.label_cn, L)
        || (L === 'cn' ? '联系客服' : 'Help');
      const hours = lang.pick(cs.hours_en, cs.hours_cn, L) || '';
      const fab = this.computeFab(cs);
      this.setData(Object.assign({
        visible: true,
        mode,
        openType: mode === 'kf' ? 'contact' : '',
        displayLabel: label,
        displayHours: hours,
        qrUrl: absUrl(cs.qr_image_url || ''),
        dragStyle: this.restoreDragStyle(),
      }, fab));
    },
    // Build the inline style + icon choices for the floating bubble from
    // admin config. Falls back to the original round green dots-bubble.
    computeFab(cs) {
      const SIZES = { sm: 80, md: 96, lg: 120 };
      const sizePx = SIZES[cs.fab_size] || 96;
      const shape  = cs.fab_shape || 'circle';
      const color  = (cs.fab_color || '').trim() || '#365329';
      const side   = cs.fab_side === 'left' ? 'left' : 'right';
      const bn     = Number(cs.fab_bottom);
      const bottom = (isFinite(bn) && bn >= 0) ? bn : 220;

      let style = `background:${color};${side}:28rpx;bottom:${bottom}rpx;`;
      let showLabel = false;
      if (shape === 'pill') {
        const h = Math.round(sizePx * 0.72);
        style += `height:${h}rpx;min-height:${h}rpx;padding:0 28rpx;border-radius:999rpx;`;
        showLabel = true;
      } else {
        const radius = shape === 'rounded' ? Math.round(sizePx * 0.28) + 'rpx' : '50%';
        style += `width:${sizePx}rpx;height:${sizePx}rpx;padding:0;border-radius:${radius};`;
      }

      const ICONS = { bubble: '💬', question: '?', headset: '🎧' };
      const kind = cs.fab_icon || 'dots';
      const isDots = kind === 'dots';
      let glyph = '';
      if (!isDots) {
        glyph = kind === 'custom'
          ? ((cs.fab_icon_emoji || '').trim() || '💬')
          : (ICONS[kind] || '💬');
      }
      return {
        fabStyle: style,
        fabIsDots: isDots,
        fabGlyph: glyph,
        fabGlyphSize: Math.round(sizePx * 0.44),
        fabShowLabel: showLabel,
      };
    },
    // ─── Draggable floating bubble ─────────────────────────────────────
    // Rebuild the saved left/top style for the bubble. Snaps to whichever
    // side the user last released it on; clamps top to the current screen so
    // a position saved on a taller device can't land off-screen.
    restoreDragStyle() {
      if (this.properties.variant !== 'fab') return '';
      let pos;
      try { pos = wx.getStorageSync('cs_fab_pos'); } catch (e) { pos = null; }
      if (!pos || !pos.side) return '';
      const { W, H } = winSize();
      const w = pos.w || 48;
      const h = pos.h || 48;
      const left = pos.side === 'left' ? DRAG_MARGIN : (W - w - DRAG_MARGIN);
      const top = Math.max(DRAG_MARGIN, Math.min(pos.top || 0, H - h - DRAG_MARGIN));
      return `left:${left}px;top:${top}px;right:auto;bottom:auto;`;
    },
    onFabTouchStart(e) {
      const t = e.touches && e.touches[0];
      if (!t) return;
      this._drag = { moved: false, sx: t.clientX, sy: t.clientY, offX: 0, offY: 0, w: 0, h: 0 };
      this.createSelectorQuery().select('.cs-fab').boundingClientRect((rect) => {
        if (!rect || !this._drag) return;
        this._drag.offX = this._drag.sx - rect.left;
        this._drag.offY = this._drag.sy - rect.top;
        this._drag.w = rect.width;
        this._drag.h = rect.height;
      }).exec();
    },
    onFabTouchMove(e) {
      const d = this._drag;
      if (!d) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - d.sx) > 6 || Math.abs(t.clientY - d.sy) > 6) d.moved = true;
      if (!d.moved) return;
      const { W, H } = winSize();
      let left = t.clientX - d.offX;
      let top = t.clientY - d.offY;
      left = Math.max(DRAG_MARGIN, Math.min(left, W - d.w - DRAG_MARGIN));
      top = Math.max(DRAG_MARGIN, Math.min(top, H - d.h - DRAG_MARGIN));
      this.setData({ dragStyle: `left:${left}px;top:${top}px;right:auto;bottom:auto;` });
    },
    onFabTouchEnd(e) {
      const d = this._drag;
      this._drag = null;
      if (!d || !d.moved) return; // treat as a plain tap → let onTap proceed
      this._suppressTap = true;
      setTimeout(() => { this._suppressTap = false; }, 60);
      const { W, H } = winSize();
      const t = (e.changedTouches && e.changedTouches[0]) || {};
      const left = (t.clientX || 0) - d.offX;
      const top = Math.max(DRAG_MARGIN, Math.min((t.clientY || 0) - d.offY, H - d.h - DRAG_MARGIN));
      const snapLeft = (left + d.w / 2) < W / 2;
      const x = snapLeft ? DRAG_MARGIN : (W - d.w - DRAG_MARGIN);
      this.setData({ dragStyle: `left:${x}px;top:${top}px;right:auto;bottom:auto;` });
      try {
        wx.setStorageSync('cs_fab_pos', { side: snapLeft ? 'left' : 'right', top, w: d.w, h: d.h });
      } catch (e2) { /* storage full / unavailable — position just won't persist */ }
    },
    onTap() {
      // A drag just ended on this bubble — swallow the synthetic tap so the
      // chat/QR doesn't open when the user only meant to move it.
      if (this._suppressTap) { this._suppressTap = false; return; }
      // If mode is 'kf', the button's open-type="contact" handles it natively;
      // bindtap still fires but we just do nothing.
      if (this.data.mode === 'kf') return;
      if (this.data.mode === 'wecom') return this.openWeCom();
      if (this.data.mode === 'qr')    return this.openQr();
    },
    openWeCom() {
      const cfg = (getApp().globalData.config || {}).customer_service || {};
      const corpId = (cfg.corp_id || '').trim();
      const url    = (cfg.url || '').trim();
      if (!corpId || !url) {
        wx.showToast({ title: 'Service not configured', icon: 'none' });
        return;
      }
      if (typeof wx.openCustomerServiceChat !== 'function') {
        wx.showToast({ title: 'Update WeChat to use chat', icon: 'none' });
        return;
      }
      // WeChat expects the 微信客服 link inside extInfo.url — NOT as a
      // top-level `url`. Passing it at the top level silently drops the
      // link, so the chat never opens. corpId is the enterprise's 企业ID.
      wx.openCustomerServiceChat({
        corpId,
        extInfo: { url },
        showMessageCard: false,
        fail: (e) => {
          console.warn('[cs] openCustomerServiceChat failed', e);
          wx.showToast({ title: 'Could not open chat', icon: 'none' });
        },
      });
    },
    openQr() {
      if (!this.data.qrUrl) {
        wx.showToast({ title: 'No QR set', icon: 'none' });
        return;
      }
      this.setData({ qrModalOpen: true });
    },
    closeQr() { this.setData({ qrModalOpen: false }); },
    previewQr() {
      if (!this.data.qrUrl) return;
      wx.previewImage({ urls: [this.data.qrUrl], current: this.data.qrUrl });
    },
    onContact(e) {
      // WeChat 客服 callback (open-type="contact"). No-op — WeChat handles UI.
      console.log('[cs] contact session', e?.detail);
    },
  },
});
