// Product review form (design #19) — opened from order detail after delivery.
// Query: ?product_id=N&order_id=M&product_name=...&product_image=...&qty=N&order_no=...&delivered_at=...

const api = require('../../utils/api');
const config = require('../../utils/config');

// Read a wx temp file as a base64 data URI, then POST it to the review-photo
// endpoint and return the server URL. Errors propagate so the submit flow can
// surface them via the existing toast handler.
function uploadReviewPhoto(tempPath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: async (res) => {
        const ext = (tempPath.split('.').pop() || 'jpeg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        try {
          const resp = await api.post('/api/retail/review-photos', {
            data: `data:${mime};base64,${res.data}`,
          });
          resolve(resp.url);
        } catch (e) { reject(e); }
      },
      fail: (e) => reject(new Error(e.errMsg || 'read_failed')),
    });
  });
}

// Fallback chip list — used on a cold first launch when the storefront
// config hasn't loaded yet. Staff can rename / recolour / add chips from
// /retail-admin → Reviews → Review tags; those overrides arrive via
// app.globalData.config.reviews.tags.
const DEFAULT_TAGS = [
  { id: 'fresh',     en: 'Super fresh',     cn: '很新鲜', color: 'lime'     },
  { id: 'tasty',     en: 'Tastes great',    cn: '味道好', color: 'papaya'   },
  { id: 'fast-ship', en: 'Fast ship',       cn: '发货快', color: 'sky'      },
  { id: 'packed',    en: 'Great packaging', cn: '包装好', color: 'corn'     },
  { id: 'value',     en: 'Worth it',        cn: '值得',   color: 'pea'      },
  { id: 'eco',       en: 'Eco-friendly',    cn: '环保',   color: 'cucumber' },
  { id: 'will-buy',  en: 'Will reorder',    cn: '会回购', color: 'pink'     },
];

function tagListFromConfig() {
  const cfg = getApp()?.globalData?.config;
  const list = cfg?.reviews?.tags;
  return (Array.isArray(list) && list.length) ? list : DEFAULT_TAGS;
}

const RATING_LABELS_EN = ['', 'Bad', 'Meh', 'OK', 'Great', 'Loved it'];
const RATING_LABELS_CN = ['', '不好', '一般', '还行', '很棒', '超爱'];

const COPY_EN = {
  kicker: 'LEAVE A REVIEW',
  title: 'How was it?',
  overall: 'OVERALL',
  tagsLabel: 'QUICK TAGS',
  tellLabel: 'TELL US MORE',
  placeholder: 'Real fruit really comes through. Tangy without the burn. Will reorder.',
  photoLabel: 'PHOTO',
  pointsNote: 'Reviews earn points and help other shoppers.',
  submit: 'SUBMIT REVIEW',
  saving: 'SUBMITTING…',
  submitted: 'Thank you!',
  ratings: RATING_LABELS_EN,
};

const COPY_CN = {
  kicker: '写评价',
  title: '感觉如何?',
  overall: '总体',
  tagsLabel: '快速标签',
  tellLabel: '说说看',
  placeholder: '果味十足,酸度刚好,会回购。',
  photoLabel: '照片',
  pointsNote: '评价可得积分,也能帮到其他买家。',
  submit: '提交评价',
  saving: '提交中…',
  submitted: '感谢您的反馈',
  ratings: RATING_LABELS_CN,
};

function buildTags(lang, selectedIds) {
  return tagListFromConfig().map(t => ({
    id: t.id,
    l: t.en || t.cn || t.id,
    cn: t.cn || '',
    color: t.color || 'lime',
    on: selectedIds.has(t.id),
  }));
}

function formatDeliveredLabel(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  if (lang === 'cn') {
    return `${d.getMonth() + 1}月${d.getDate()}日 已送达`;
  }
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `DELIVERED ${months[d.getMonth()]} ${d.getDate()}`;
}

Page({
  data: {
    productId: null,
    orderId: null,
    productName: '',
    productImage: '',
    qty: 0,
    orderNo: '',
    deliveredLabel: '',
    rating: 4,
    tags: [],
    comment: '',
    photos: [],
    saving: false,
    lang: 'en',
    copy: COPY_EN,
  },

  onLoad(query) {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    const copy = lang === 'cn' ? COPY_CN : COPY_EN;
    const selected = new Set(['fresh', 'fast-ship']);
    this.setData({
      productId: parseInt(query.product_id, 10) || null,
      orderId: parseInt(query.order_id, 10) || null,
      productName: decodeURIComponent(query.product_name || ''),
      productImage: decodeURIComponent(query.product_image || ''),
      qty: parseInt(query.qty, 10) || 0,
      orderNo: decodeURIComponent(query.order_no || ''),
      deliveredLabel: formatDeliveredLabel(decodeURIComponent(query.delivered_at || ''), lang),
      tags: buildTags(lang, selected),
      _selectedTagIds: selected,
      lang,
      copy,
    });
  },

  setRating(e) {
    const r = parseInt(e.currentTarget.dataset.r, 10);
    this.setData({ rating: r });
  },

  toggleTag(e) {
    const id = e.currentTarget.dataset.id;
    const next = new Set(this.data._selectedTagIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setData({
      _selectedTagIds: next,
      tags: buildTags(this.data.lang, next),
    });
  },

  onComment(e) { this.setData({ comment: e.detail.value }); },

  addPhoto() {
    const remaining = 6 - this.data.photos.length;
    if (remaining <= 0) return;
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = (res.tempFiles || []).map(f => f.tempFilePath);
        this.setData({ photos: this.data.photos.concat(paths).slice(0, 6) });
      },
    });
  },

  removePhoto(e) {
    const i = parseInt(e.currentTarget.dataset.i, 10);
    const next = this.data.photos.slice();
    next.splice(i, 1);
    this.setData({ photos: next });
  },

  async submit() {
    if (this.data.saving) return;
    if (!this.data.rating) {
      wx.showToast({ title: this.data.copy.overall, icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const tagIds = this.data.tags.filter(t => t.on).map(t => t.id);
      const comment = (this.data.comment || '').trim();

      // Upload any picked photos first so the review POST gets back
      // server-owned /api/retail/media/:id URLs. wx.uploadFile can't be
      // used on the preview AppID (separate whitelist) so we base64 each
      // file and POST through the normal wx.request channel.
      const photoUrls = await Promise.all(
        (this.data.photos || []).map(p => uploadReviewPhoto(p))
      );

      await api.post('/api/retail/products/' + this.data.productId + '/reviews', {
        order_id: this.data.orderId,
        rating: this.data.rating,
        comment,
        tags: tagIds,
        photos: photoUrls,
      });
      wx.showToast({ title: this.data.copy.submitted, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      this.setData({ saving: false });
      const msg = e.message === 'already_reviewed'
        ? (this.data.lang === 'cn' ? '已评价过' : 'You already reviewed this')
        : (e.message === 'too_large'
          ? (this.data.lang === 'cn' ? '照片过大' : 'Photo too large')
          : e.message);
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
