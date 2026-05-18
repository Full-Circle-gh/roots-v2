// Privacy / Terms page. Body text comes from storefront_config:
//   legal.privacy.body_en / legal.privacy.body_cn
//   legal.terms.body_en   / legal.terms.body_cn
// Office edits these in /retail-admin → Settings.

const config = require('../../utils/config');

Page({
  data: {
    doc: 'privacy',
    title: 'Privacy',
    paragraphs: [],
    lang: 'en',
    updated: '',
    emptyMsg: 'Not published yet.',
  },

  async onLoad(query) {
    const doc = query.doc === 'terms' ? 'terms' : 'privacy';
    const app = getApp();
    const L = app.globalData.lang;
    const titles = {
      privacy: L === 'cn' ? '隐私政策' : 'Privacy Policy',
      terms:   L === 'cn' ? '服务条款' : 'Terms of Service',
    };
    this.setData({
      doc,
      lang: L,
      title: titles[doc],
      emptyMsg: L === 'cn' ? '尚未发布。' : 'Not published yet.',
    });
    wx.setNavigationBarTitle({ title: titles[doc] });
    try {
      const cfg = await config.load();
      const body = (L === 'cn' ? cfg?.legal?.[doc]?.body_cn : cfg?.legal?.[doc]?.body_en) || '';
      // Split by blank lines into paragraphs — preserve simple structure.
      const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      this.setData({
        paragraphs,
        updated: cfg?.legal?.[doc]?.updated_at || '',
      });
    } catch (e) {
      console.warn('[legal] load failed:', e.message);
    }
  },
});
