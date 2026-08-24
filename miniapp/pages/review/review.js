// Product review form (design #19) — opened from order detail after delivery.
// Query: ?product_id=N&order_id=M&product_name=...&product_image=...&qty=N&order_no=...&delivered_at=...

const api = require('../../utils/api');
const config = require('../../utils/config');
const contentCheck = require('../../utils/content-check');

// Read a wx temp file as a base64 data URI, then POST it to the review-photo
// endpoint and return { url, sec_status }. Errors propagate so the submit flow
// can surface them via the existing toast handler.
function uploadReviewPhoto(tempPath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: async (res) => {
        const ext = (tempPath.split('.').pop() || 'jpeg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        try {
          resolve(await api.post('/api/retail/review-photos', {
            data: `data:${mime};base64,${res.data}`,
          }));
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

// The submit bar advertises points for reviewing. Both the amount and whether
// it is offered at all are operator settings (storefront_config reviews.reward,
// public via /api/retail/config), so the sticker reads them live instead of
// hardcoding a number.
//
// It hardcoded "+10 PTS" for a long time while the server awarded nothing —
// a promise on screen that was never paid. Reading the live value is what stops
// that happening again: if the operator turns the reward off, the sticker goes
// with it.
function reviewRewardPoints() {
  const r = getApp()?.globalData?.config?.reviews?.reward;
  if (!r || !r.enabled) return 0;
  const pts = Math.floor(Number(r.points));
  return pts > 0 ? pts : 0;
}

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
  // Shown instead when no reward is on offer — never promise points we
  // aren't paying.
  noteNoPoints: 'Helps other shoppers decide.',
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
  noteNoPoints: '帮助其他买家做选择。',
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
    rewardPoints: 0,
  },

  onLoad(query) {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    const copy = lang === 'cn' ? COPY_CN : COPY_EN;
    // Start with NO tags pre-selected — pre-checking 'fresh'/'fast-ship' meant
    // every review silently submitted those claims unless the customer manually
    // deselected them, polluting the aggregate review tags.
    const selected = new Set();
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
      rewardPoints: reviewRewardPoints(),
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
      const uploaded = await Promise.all(
        (this.data.photos || []).map(p => uploadReviewPhoto(p))
      );

      // WeChat judges each picture asynchronously. Wait for the verdicts so a
      // refused photo is refused here, with the review still on screen to fix,
      // rather than the review quietly never appearing.
      const verdicts = await Promise.all(
        uploaded.map(u => u.sec_status === 'pending'
          ? contentCheck.waitForImageVerdict(u.url)
          : Promise.resolve(u.sec_status))
      );
      if (verdicts.some(v => v === 'risky')) {
        this.setData({ saving: false });
        contentCheck.showContentViolation(null, this.data.lang);
        return;
      }
      const photoUrls = uploaded.map(u => u.url);

      const res = await api.post('/api/retail/products/' + this.data.productId + '/reviews', {
        order_id: this.data.orderId,
        rating: this.data.rating,
        comment,
        tags: tagIds,
        photos: photoUrls,
      });
      // Confirm the points from the SERVER's answer, not from what the sticker
      // promised — the per-order cap means the second review on one order
      // earns nothing, and saying "+20" there would be a lie.
      const earned = Math.floor(Number(res && res.points_awarded)) || 0;
      wx.showToast({
        title: earned
          ? (this.data.lang === 'cn' ? '+' + earned + ' 积分' : '+' + earned + ' points')
          : this.data.copy.submitted,
        icon: 'success',
      });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      this.setData({ saving: false });
      if (contentCheck.isContentViolation(e)) {
        contentCheck.showContentViolation(e, this.data.lang);
        return;
      }
      const msg = e.message === 'already_reviewed'
        ? (this.data.lang === 'cn' ? '已评价过' : 'You already reviewed this')
        : (e.message === 'too_large'
          ? (this.data.lang === 'cn' ? '照片过大' : 'Photo too large')
          : e.message);
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
