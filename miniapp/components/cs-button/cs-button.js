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
  },
  lifetimes: {
    attached() { this.recompute(); },
  },
  pageLifetimes: {
    show() { this.recompute(); },
  },
  methods: {
    recompute() {
      const cfg = (getApp().globalData.config || {});
      const cs = cfg.customer_service || {};
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
      this.setData({
        visible: true,
        mode,
        openType: mode === 'kf' ? 'contact' : '',
        displayLabel: label,
        displayHours: hours,
        qrUrl: absUrl(cs.qr_image_url || ''),
      });
    },
    onTap() {
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
