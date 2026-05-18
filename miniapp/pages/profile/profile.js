// Bind-WeChat-profile page. The only sanctioned 2023+ flow:
//   • <button open-type="chooseAvatar"> → user picks their real WeChat avatar
//   • <input type="nickname">           → auto-fills real WeChat nickname
//   • <button open-type="getPhoneNumber"> → real bound phone (needs real AppID)
// All three require explicit user action — WeChat no longer hands them out
// silently via wx.getUserInfo / wx.getUserProfile.

const api = require('../../utils/api');

Page({
  data: {
    avatarPreview: '',    // local tempFilePath OR uploaded URL
    avatarTempPath: '',   // set only when user just picked one and we still need to upload
    nickname: '',
    phone: '',
    saving: false,
    wxAddrPicking: false,
    addrPreview: null,    // { name, phone, address } once picked
    pendingAddr: null,    // saved on PATCH save → /api/retail/addresses
    showPhone: false,     // toggle on once getPhoneNumber works (needs real AppID)
    lang: 'en',
    copy: {
      kicker: 'BIND PROFILE · 绑定资料',
      title: 'Hey,\nyou.',
      sub: 'WeChat keeps your nickname, avatar and address private. Tap to pull them in.',
      pickAvatar: 'Pick avatar',
      avatarHint: 'Tap to pick your WeChat avatar or upload one.',
      nicknameLabel: 'NICKNAME',
      nicknamePh: 'Tap, then choose from WeChat',
      addrLabel: 'ADDRESS · NAME · PHONE',
      wxAddrBtn: 'Import from WeChat',
      addrLoading: 'Loading…',
      addrHint: 'WeChat gives us your name, phone, and full address in a single tap.',
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
        kicker: '绑定资料 · BIND PROFILE',
        title: '你好。',
        sub: '微信不会自动告诉我们您的昵称、头像和地址，请点击下方手动绑定。',
        pickAvatar: '选择头像',
        avatarHint: '点击选择微信头像或上传图片。',
        nicknameLabel: '昵称',
        nicknamePh: '点击输入框，从微信选择',
        addrLabel: '地址 · 姓名 · 电话',
        wxAddrBtn: '从微信一键导入',
        addrLoading: '加载中…',
        addrHint: '一键导入姓名、手机号与完整地址。',
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

  // One-shot WeChat address — fills name + phone + full address in a single tap.
  pickWxAddress() {
    if (this.data.wxAddrPicking || !wx.chooseAddress) {
      if (!wx.chooseAddress) {
        wx.showToast({ title: this.data.lang === 'cn' ? '微信地址不可用' : 'WeChat address unavailable', icon: 'none' });
      }
      return;
    }
    this.setData({ wxAddrPicking: true });
    const apply = (addr) => {
      const composed = [addr.provinceName, addr.cityName, addr.countyName, addr.detailInfo]
        .filter(Boolean).join(' ');
      const pending = {
        recipient_name: addr.userName || '',
        phone: addr.telNumber || '',
        address: composed,
        // WeChat returns the GZ district as `countyName` (e.g. 番禺区). Persist
        // it so the server's zone-match (`matchDeliveryZone`) can route to the
        // right delivery rule — without this the saved address has no district
        // and every WeChat-picked GZ order fails with "no_zone_match".
        city: addr.cityName || '',
        district: addr.countyName || '',
        province: addr.provinceName || '',
        is_default: true,
      };
      this.setData({
        wxAddrPicking: false,
        nickname: this.data.nickname || addr.userName || '',
        phone: addr.telNumber || this.data.phone,
        pendingAddr: pending,
        addrPreview: { name: pending.recipient_name, phone: pending.phone, address: composed },
      });
    };
    const fail = (err) => {
      this.setData({ wxAddrPicking: false });
      if (/cancel|deny/i.test(err?.errMsg || '')) return;
      wx.showToast({ title: this.data.lang === 'cn' ? '微信地址不可用' : 'WeChat address unavailable', icon: 'none' });
    };
    wx.getSetting({
      success: (s) => {
        if (s.authSetting['scope.address'] === false) {
          wx.openSetting({
            success: (r) => r.authSetting['scope.address']
              ? wx.chooseAddress({ success: apply, fail })
              : this.setData({ wxAddrPicking: false }),
            fail,
          });
        } else {
          wx.chooseAddress({ success: apply, fail });
        }
      },
      fail,
    });
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
    const resp = await api.post('/api/retail/customer/avatar', { data: dataUri });
    return resp.url;
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
        avatar_url = await this.uploadAvatar(localPath);
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
      if (this.data.phone) body.phone = this.data.phone;
      const updated = await api.patch('/api/retail/customer', body);
      const app = getApp();
      app.globalData.customer = { ...(app.globalData.customer || {}), ...updated };
      try { wx.setStorageSync('customer', app.globalData.customer); } catch {}

      // If the user pulled an address from WeChat, persist it too.
      if (this.data.pendingAddr) {
        try { await api.post('/api/retail/addresses', this.data.pendingAddr); }
        catch (e) { console.warn('[profile] address save failed:', e.message); }
      }

      wx.showToast({ title: this.data.copy.savedToast, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: e.message || 'failed', icon: 'none' });
    }
  },

  cancel() {
    wx.navigateBack();
  },
});
