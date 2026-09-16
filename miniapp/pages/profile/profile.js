// Bind-WeChat-profile page. The only sanctioned 2023+ flow:
//   • avatar: custom picker (wx.showActionSheet → wx.chooseMedia) so the sheet
//     copy stays in our app language. (We dropped open-type="chooseAvatar"
//     because its native sheet follows the user's WeChat language, not ours.)
//   • <input type="nickname">           → auto-fills real WeChat nickname
//   • <button open-type="getPhoneNumber"> → real bound phone (needs real AppID)
// All three require explicit user action — WeChat no longer hands them out
// silently via wx.getUserInfo / wx.getUserProfile.
//
// NO ADDRESS FIELD. This page is the first wall a new customer hits (cart,
// checkout and addresses all route here), and the only address control it ever
// had was a wx.chooseAddress shortcut. With nothing saved in WeChat that API
// drops the customer straight into WeChat's own create-address form, whose
// chrome follows their WeChat language but whose region list is Chinese-only —
// an English-speaking first-timer got buttons they could read over a list they
// could not, at the moment before they had bought anything. The address is
// collected at checkout instead, on our own bilingual form
// (pages/addresses, pages/checkout), where it is asked for with a reason.

const api = require('../../utils/api');
const contentCheck = require('../../utils/content-check');

Page({
  data: {
    avatarPreview: '',    // local tempFilePath OR uploaded URL
    avatarTempPath: '',   // set only when user just picked one and we still need to upload
    nickname: '',
    phone: '',
    saving: false,
    showPhone: false,     // toggle on once getPhoneNumber works (needs real AppID)
    lang: 'en',
    copy: {
      kicker: 'BIND PROFILE',
      title: 'Hey,\nyou.',
      sub: 'WeChat keeps your nickname and avatar private. Tap to pull them in.',
      pickAvatar: 'Pick avatar',
      avatarHint: 'Tap to pick your WeChat avatar or upload one.',
      useWxAvatar: 'Use my WeChat avatar',
      nicknameLabel: 'NICKNAME',
      nicknamePh: 'Tap, then choose from WeChat',
      phoneLabel: 'PHONE',
      phoneBtn: 'Use my WeChat phone number',
      phoneHint: 'Optional. Available once we go live on WeChat.',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      note: 'WeChat requires you to confirm each piece of profile info — we never read it silently.',
      savedToast: 'Saved',
      missingToast: 'Add at least a nickname',
      uploadFailToast: 'Avatar upload failed',
    },
  },

  onLoad() {
    const app = getApp();
    const c = app.globalData.customer || {};
    this.setData({
      lang: app.globalData.lang,
      nickname: c.nickname || '',
      avatarPreview: c.avatar_url ? this.resolveAvatarUrl(c.avatar_url) : '',
      phone: c.phone || '',
    });
    this.applyLangCopy();
  },

  resolveAvatarUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    return api.BASE + url;
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        kicker: '绑定资料',
        title: '你好。',
        sub: '微信不会自动告诉我们您的昵称和头像，请点击下方手动绑定。',
        pickAvatar: '选择头像',
        avatarHint: '点击选择微信头像或上传图片。',
        useWxAvatar: '使用微信头像',
        nicknameLabel: '昵称',
        nicknamePh: '点击输入框，从微信选择',
        phoneLabel: '手机号',
        phoneBtn: '使用微信绑定的手机号',
        phoneHint: '可选，上线后可用。',
        save: '保存',
        saving: '保存中…',
        cancel: '取消',
        note: '微信要求每一项资料都需您手动确认 — 我们不会静默读取。',
        savedToast: '已保存',
        missingToast: '请至少填写昵称',
        uploadFailToast: '头像上传失败',
      },
    });
  },

  // Custom avatar picker. We draw our OWN action sheet (English/CN copy we
  // control) instead of WeChat's native chooseAvatar sheet, whose language
  // follows the user's WeChat app setting and can't be overridden.
  // Trade-off vs chooseAvatar: no one-tap "use my real WeChat avatar" option.
  pickAvatar() {
    const cn = this.data.lang === 'cn';
    wx.showActionSheet({
      itemList: cn ? ['从相册选择', '拍照'] : ['Choose from album', 'Take photo'],
      success: (r) => {
        const sourceType = r.tapIndex === 1 ? ['camera'] : ['album'];
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType,
          sizeType: ['compressed'],
          camera: 'front',
          success: (res) => {
            const f = res.tempFiles && res.tempFiles[0];
            if (!f || !f.tempFilePath) return;
            this.setData({
              avatarPreview: f.tempFilePath,
              avatarTempPath: f.tempFilePath,   // save() uploads this local path
            });
          },
          fail: (e) => {
            if (/cancel/i.test(e?.errMsg || '')) return;
            wx.showToast({ title: cn ? '选择失败' : 'Pick failed', icon: 'none' });
          },
        });
      },
      // showActionSheet "fail" fires on dismiss/cancel — ignore.
    });
  },

  // Native WeChat-avatar shortcut. Opens WeChat's own sheet (Chinese if the
  // user's WeChat is Chinese); the only path to the real WeChat avatar.
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    if (!avatarUrl) return;
    this.setData({
      avatarPreview: avatarUrl,
      avatarTempPath: avatarUrl,
    });
  },

  onNicknameInput(e) {
    this.setData({ nickname: (e.detail.value || '').trim() });
  },

  onGetPhone(e) {
    // The real phone is server-side: WeChat returns an encrypted blob + code
    // that we exchange for a phone number via mp.weixin.qq.com. Stub for now.
    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      wx.showToast({ title: this.data.lang === 'cn' ? '已取消' : 'Cancelled', icon: 'none' });
      return;
    }
    wx.showToast({
      title: this.data.lang === 'cn' ? '即将上线' : 'Coming soon',
      icon: 'none',
    });
  },

  async uploadAvatar(tempPath) {
    const app = getApp();
    if (!app?.globalData?.token) {
      try { await app.silentLogin(); } catch (e) {
        throw new Error('login_failed: ' + (e?.message || ''));
      }
    }
    if (!app?.globalData?.token) throw new Error('no_auth_token');
    // Read the picked file as base64 and POST as JSON. wx.uploadFile has a
    // separate whitelist that we can't control on the preview AppID; the JSON
    // request path reuses the already-provisioned request whitelist.
    const fs = wx.getFileSystemManager();
    const base64 = await new Promise((resolve, reject) => {
      fs.readFile({
        filePath: tempPath,
        encoding: 'base64',
        success: (r) => resolve(r.data),
        fail: (e) => reject(new Error('read_failed: ' + (e?.errMsg || ''))),
      });
    });
    // Guess MIME from extension; default to jpeg
    const ext = (tempPath.match(/\.([a-zA-Z0-9]+)(?:\?|$)/) || [, 'jpg'])[1].toLowerCase();
    const mime = ext === 'png' ? 'image/png'
              : ext === 'webp' ? 'image/webp'
              : ext === 'gif'  ? 'image/gif'
              : 'image/jpeg';
    const dataUri = `data:${mime};base64,${base64}`;
    // Answers { url, sec_status } — 'pending' means WeChat is still judging
    // the picture and save() has to wait for the verdict before using it.
    return api.post('/api/retail/customer/avatar', { data: dataUri });
  },

  async save() {
    if (this.data.saving) return;
    const nickname = (this.data.nickname || '').trim();
    if (!nickname && !this.data.avatarTempPath) {
      wx.showToast({ title: this.data.copy.missingToast, icon: 'none' });
      return;
    }
    this.setData({ saving: true });

    let avatar_url = null;
    if (this.data.avatarTempPath) {
      try {
        // chooseAvatar can return either a local tmp path (wxfile:// or
        // http://tmp/) or a remote https URL. wx.uploadFile only accepts
        // local paths, so download first if needed.
        let localPath = this.data.avatarTempPath;
        if (/^https?:\/\//.test(localPath) && !localPath.startsWith('http://tmp/')) {
          console.log('[profile] downloading remote avatar first', localPath);
          localPath = await new Promise((resolve, reject) => {
            wx.downloadFile({
              url: localPath,
              success: (r) => r.statusCode === 200 ? resolve(r.tempFilePath) : reject(new Error('download_http_' + r.statusCode)),
              fail: (e) => reject(new Error('download_failed: ' + (e?.errMsg || ''))),
            });
          });
        }
        const uploaded = await this.uploadAvatar(localPath);
        // WeChat checks every picture a customer publishes. Hold the save for
        // a couple of seconds so a refused picture is refused to their face.
        if (uploaded.sec_status === 'pending') {
          const verdict = await contentCheck.waitForImageVerdict(uploaded.url);
          if (verdict === 'risky') {
            this.setData({ saving: false, avatarPreview: '', avatarTempPath: '' });
            contentCheck.showContentViolation(null, this.data.lang);
            return;
          }
        }
        avatar_url = uploaded.url;
      } catch (e) {
        this.setData({ saving: false });
        const msg = e.message || 'unknown';
        console.warn('[profile] avatar upload failed:', msg);
        let hint = msg;
        if (/url not in domain list|domain.*list/i.test(msg)) {
          hint = msg + '\n\n' + (this.data.lang === 'cn'
            ? '请在微信开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」'
            : 'In WeChat DevTools: Details → Local Settings → check "Skip domain validation"');
        } else if (/no_auth_token|login_failed|missing_token/i.test(msg)) {
          hint = msg + '\n\n' + (this.data.lang === 'cn'
            ? '登录尚未完成。返回上一页等几秒重试。'
            : 'Login not ready yet. Go back and try again in a few seconds.');
        }
        wx.showModal({
          title: this.data.copy.uploadFailToast,
          content: hint,
          showCancel: false,
        });
        return;
      }
    }

    try {
      const body = { nickname };
      if (avatar_url) body.avatar_url = avatar_url;
      // NOTE: phone is intentionally NOT sent here. The server only accepts a
      // phone via the WeChat-verified getPhoneNumber path (POST /api/retail/phone,
      // wired on the wallet page), because the phone unlocks OUT1N migration
      // credit and must prove ownership. A free-form phone PATCH would be a
      // money-theft vector, so it's ignored server-side.
      const updated = await api.patch('/api/retail/customer', body);
      const app = getApp();
      app.globalData.customer = { ...(app.globalData.customer || {}), ...updated };
      try { wx.setStorageSync('customer', app.globalData.customer); } catch {}

      wx.showToast({ title: this.data.copy.savedToast, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      this.setData({ saving: false });
      // A nickname WeChat won't publish gets its own explanation, not a
      // bare error code in a toast.
      if (contentCheck.isContentViolation(e)) {
        contentCheck.showContentViolation(e, this.data.lang);
        return;
      }
      wx.showToast({ title: e.message || 'failed', icon: 'none' });
    }
  },

  cancel() {
    wx.navigateBack();
  },
});
