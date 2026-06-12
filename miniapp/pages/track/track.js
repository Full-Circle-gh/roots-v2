// Native shipment-tracking page. Replaces the old <web-view> tracking page
// (pages/track-webview) — same data, rendered natively, so it needs NO
// 业务域名 / ICP. Data comes from GET /api/retail/orders/:orderNo/tracking/:number
// over the plain request domain (already whitelisted, no ICP required).
const api = require('../../utils/api');

// Scenario banner tints, mirrored from the old server-rendered page.
const URG_BG = { urgent: '#FCE3E5', action_needed: '#FBEFC9', info: '#E3EFD3', transit: '#E5EEF8' };
const URG_BR = { urgent: '#E96174', action_needed: '#E8B53A', info: '#7BBD3B', transit: '#B2CFED' };

Page({
  data: {
    lang: 'en',
    loading: true,
    error: false,
    t: null,            // tracking view from the API
    bannerStyle: '',    // computed urgency-tinted banner style
  },

  onLoad(q) {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    const orderNo = String(q.order_no || '').replace(/[^A-Za-z0-9_-]/g, '');
    const number  = String(q.number   || '').replace(/[^A-Za-z0-9_-]/g, '');
    wx.setNavigationBarTitle({ title: lang === 'cn' ? '物流跟踪' : 'Tracking' });
    if (!orderNo || !number) { this.setData({ lang, loading: false, error: true }); return; }
    this.setData({ lang });
    this.load(orderNo, number, lang);
  },

  async load(orderNo, number, lang) {
    try {
      const t = await api.get(
        `/api/retail/orders/${encodeURIComponent(orderNo)}/tracking/${encodeURIComponent(number)}?lang=${lang}`
      );
      let bannerStyle = '';
      if (t && t.scenario) {
        const bg = URG_BG[t.scenario.urgency] || '#eeeeee';
        const br = URG_BR[t.scenario.urgency] || '#888888';
        bannerStyle = `background:${bg};border:3rpx solid ${br}`;
      }
      this.setData({ t, bannerStyle, loading: false, error: false });
    } catch (e) {
      console.warn('[track] load failed:', e.message);
      this.setData({ loading: false, error: true });
    }
  },

  // Tap the waybill number (or the Copy CTA) to copy it — the customer can
  // paste it into the carrier's own app for the official live view.
  copyNumber() {
    const t = this.data.t || {};
    if (!t.number) return;
    wx.setClipboardData({
      data: t.number,
      success: () => wx.showToast({
        title: this.data.lang === 'cn' ? '运单号已复制' : 'Tracking number copied',
        icon: 'success',
      }),
    });
  },

  // Tap the scenario banner to copy a pickup code when one is present
  // (needed to retrieve the parcel at a 菜鸟驿站 / locker).
  copyPickup() {
    const sc = (this.data.t && this.data.t.scenario) || null;
    if (!sc || !sc.pickup_code) return;
    wx.setClipboardData({
      data: sc.pickup_code,
      success: () => wx.showToast({
        title: this.data.lang === 'cn' ? '取件码已复制' : 'Pickup code copied',
        icon: 'success',
      }),
    });
  },
});
