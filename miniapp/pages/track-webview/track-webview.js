// Web-view tracking page. Builds the src URL from the order_no +
// tracking_number query params and lets WeChat's built-in web-view
// component render the page in-app. The host domain must be added to
// 业务域名 on mp.weixin.qq.com before this works in production
// builds; the trial/preview builds load it freely.

const api = require('../../utils/api');

Page({
  data: { src: '', lang: 'en' },

  onLoad(q) {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    const orderNo = String(q.order_no || '').replace(/[^A-Za-z0-9_-]/g, '');
    const number  = String(q.number   || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!orderNo || !number) { this.setData({ lang }); return; }
    const src = `${api.BASE}/track/${orderNo}/${number}?lang=${lang}`;
    this.setData({ src, lang });
    wx.setNavigationBarTitle({ title: lang === 'cn' ? '物流跟踪' : 'Tracking' });
  },
});
