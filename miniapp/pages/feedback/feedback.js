// Customer "Found a bug?" form — opened from the Me tab. One-way submit:
// message (+ optional screenshots) → /api/retail/feedback, which lands
// read-only in the Mini App Backend → Feedback tab. Photos go through the
// same base64 → retail_media uploader as reviews (wx.uploadFile isn't
// whitelisted on the preview AppID, so we base64 each file via wx.request).

const api = require('../../utils/api');

function uploadPhoto(tempPath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: async (res) => {
        const ext = (tempPath.split('.').pop() || 'jpeg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        try {
          const resp = await api.post('/api/retail/review-photos', { data: `data:${mime};base64,${res.data}` });
          resolve(resp.url);
        } catch (e) { reject(e); }
      },
      fail: (e) => reject(new Error(e.errMsg || 'read_failed')),
    });
  });
}

const COPY_EN = {
  kicker: 'FOUND A BUG?',
  title: 'Tell us what broke.',
  intro: 'Spotted something not working right? Let us know and we’ll fix it. A screenshot helps a lot.',
  label: 'WHAT HAPPENED',
  placeholder: 'e.g. The checkout button does nothing after I pick an address.',
  photoLabel: 'SCREENSHOT',
  submit: 'SEND REPORT',
  saving: 'SENDING…',
  thanks: 'Thanks! We’re on it.',
  emptyMsg: 'Please describe the problem',
  tooLarge: 'Photo too large',
  pastLabel: 'YOUR REPORTS',
  newReply: 'New reply',
  replied: 'Replied',
};

const COPY_CN = {
  kicker: '发现问题?',
  title: '告诉我们哪里出错了。',
  intro: '遇到用不了的地方?告诉我们,我们会尽快修复。方便的话附上截图,会很有帮助。',
  label: '问题描述',
  placeholder: '例如:选好地址后,点结算按钮没反应。',
  photoLabel: '截图',
  submit: '提交反馈',
  saving: '提交中…',
  thanks: '感谢反馈,我们马上处理!',
  emptyMsg: '请描述遇到的问题',
  tooLarge: '图片过大',
  pastLabel: '你的反馈',
  newReply: '新回复',
  replied: '已回复',
};

Page({
  data: {
    message: '',
    photos: [],
    saving: false,
    lang: 'en',
    copy: COPY_EN,
    pageContext: '',
    reports: [],
  },

  onLoad() {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    // Best-effort: which page the customer was on before opening this form,
    // so the inbox can show "reported from /pages/checkout/checkout".
    let from = '';
    try {
      const stack = getCurrentPages();
      if (stack.length > 1) from = stack[stack.length - 2].route || '';
    } catch {}
    this.setData({ lang, copy: lang === 'cn' ? COPY_CN : COPY_EN, pageContext: from });
  },

  // Refresh the past-reports list each time the page shows (e.g. on return
  // from a thread) so the "new reply" dots stay current.
  onShow() { this.loadReports(); },

  async loadReports() {
    const app = getApp();
    if (!app.globalData.token) { try { await app.silentLogin(); } catch {} }
    if (!app.globalData.token) return;
    try {
      const res = await api.get('/api/retail/feedback');
      const list = (res && res.data) || res || [];
      const reports = list.map(r => ({
        id: r.id,
        preview: (r.message || '').slice(0, 60),
        unread: !!r.unread,
        hasReply: r.reply_count > 0 || !!r.last_admin_msg_at,
      }));
      this.setData({ reports });
    } catch (e) { /* non-fatal — the compose form still works */ }
  },

  openThread(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/feedback-thread/feedback-thread?id=' + id });
  },

  onMessage(e) { this.setData({ message: e.detail.value }); },

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
    const message = (this.data.message || '').trim();
    if (!message) {
      wx.showToast({ title: this.data.copy.emptyMsg, icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      // Upload screenshots first so the report POST carries server-owned
      // /api/retail/media/:id URLs.
      const photoUrls = await Promise.all((this.data.photos || []).map(p => uploadPhoto(p)));
      let appVersion = '';
      try { appVersion = wx.getAccountInfoSync().miniProgram.version || ''; } catch {}
      await api.post('/api/retail/feedback', {
        message,
        photos: photoUrls,
        page_context: this.data.pageContext || 'me',
        app_version: appVersion,
      });
      wx.showToast({ title: this.data.copy.thanks, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      this.setData({ saving: false });
      const msg = e.message === 'too_large' ? this.data.copy.tooLarge : e.message;
      wx.showToast({ title: msg, icon: 'none' });
    }
  },
});
