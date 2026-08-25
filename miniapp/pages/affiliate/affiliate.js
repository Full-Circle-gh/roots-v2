// Refer-a-friend — design page #15.
// Reads /api/retail/affiliate (the program rules, the customer's code, their
// invite list + cached stats). Settings (enabled, ¥reward) come from the
// server — the customer can't change them; that's admin-only.

const api  = require('../../utils/api');

const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function dateLabel(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const day = String(parseInt(m[3], 10));
  const mon = MONTH_ABBR[parseInt(m[2], 10) - 1] || '';
  return mon + ' ' + day;
}

function firstInitial(s) {
  if (!s) return '?';
  const ch = String(s).trim().charAt(0).toUpperCase();
  return ch || '?';
}

const COPY = {
  en: {
    kicker:        'AFFILIATE',
    title1:        'Plant seeds.',
    title2:        'Reap rewards',
    // The reward fires ONCE, on the invited friend's FIRST paid order —
    // creditReferralReward voids the referral outright if they had already
    // bought before. Copy that implies "every order" or "any friend" promises
    // money that can never arrive.
    tagline:       '¥{you} for you, ¥{them} for them — on their first order.',
    taglineSolo:   '¥{you} when a friend places their first order.',
    earned:        'EARNED',
    invited:       'INVITED',
    joined:        'JOINED',
    cardLbl:       'SCAN TO SHOP',
    cardFoot:      '¥{them} off their first order',
    saveCard:      'SAVE CARD',
    sendWechat:    'SEND ON WECHAT',
    orTheCode:     'OR SEND THE CODE',
    ordered:       'ORDERED',
    copy:          'COPY',
    moments:       'MOMENTS',
    how:           'HOW IT WORKS',
    how1:          'Share',
    how1sub:       'Send your code',
    how2:          'They order',
    how2sub:       'Their first order',
    how3:          'You earn',
    how3sub:       '¥{r} to your wallet',
    yourInvites:   'YOUR INVITES',
    applyHead:     'GOT A CODE?',
    applyPlaceholder: 'ROOTS-XXXXXX',
    apply:         'APPLY',
    referredByLabel: 'INVITED BY',
    empty:         'Share your code to start earning.',
    disabledTitle: 'Refer-a-friend is paused.',
    disabledBody:  'Our affiliate program is taking a short break. Check back soon — we will let you know when it returns.',
    shareTitle:    'INVITE FRIENDS',
    shareBody:     'Share this code with a friend. They get ¥{them}, you get ¥{you} on their first order.',
    shareBodySolo: 'Share this code with a friend. You get ¥{you} on their first order.',
    qrLoading:     'Drawing your code…',
    qrFailed:      "Couldn't draw your code — pull down to refresh.",
    statusJoined:  'JOINED · ¥{r}',
    statusOrdered: 'ORDERED · ¥{r}',
    statusVoid:    'VOIDED',
    toastCopied:   'Code copied',
    toastApplied:  'Code applied',
    toastShareSoon: 'Tap "..." and pick Moments to share.',
    toastSaved:     'Card saved to photos',
    toastSaveFail:  "Couldn't save the card",
    errAlreadyReferred: 'You already applied a code.',
    errNotFound:        'Code not found.',
    errCannotSelf:      "That's your own code.",
    errProgram:         'Program is not running right now.',
    errMutual:          'You and that friend can\'t refer each other.',
    errGeneric:         "Couldn't apply that code. Please try again.",
  },
  cn: {
    kicker:        '推广计划',
    title1:        '种下种子,',
    title2:        '收获奖励',
    tagline:       '好友首单,你得 ¥{you},TA 得 ¥{them}。',
    taglineSolo:   '好友完成首单,你得 ¥{you}。',
    earned:        '已赚',
    invited:       '邀请',
    joined:        '加入',
    cardLbl:       '扫码进店',
    cardFoot:      '好友首单立减 ¥{them}',
    saveCard:      '保存邀请卡',
    sendWechat:    '发送给微信好友',
    orTheCode:     '或发送邀请码',
    ordered:       '已下单',
    copy:          '复制',
    moments:       '朋友圈',
    how:           '流程',
    how1:          '分享',
    how1sub:       '把邀请码发给朋友',
    how2:          '下单',
    how2sub:       '好友注册并完成首单',
    how3:          '获奖',
    how3sub:       '到账 ¥{r}',
    yourInvites:   '我的邀请',
    applyHead:     '有邀请码?',
    applyPlaceholder: '请输入邀请码',
    apply:         '确认',
    referredByLabel: '邀请人',
    empty:         '邀请第一位朋友开始赚钱吧。',
    disabledTitle: '推广计划暂停中。',
    disabledBody:  '我们的推广计划暂时关闭,稍后会重新开放。',
    shareTitle:    '邀请好友',
    shareBody:     '把邀请码发给朋友,TA 得 ¥{them},TA 完成首单后你得 ¥{you}。',
    shareBodySolo: '把邀请码发给朋友,TA 完成首单后你得 ¥{you}。',
    qrLoading:     '正在生成…',
    qrFailed:      '生成失败,请下拉刷新后重试。',
    statusJoined:  '加入 · ¥{r}',
    statusOrdered: '已下单 · ¥{r}',
    statusVoid:    '已失效',
    toastCopied:   '已复制',
    toastApplied:  '邀请码已应用',
    toastShareSoon: '点右上角"..."分享到朋友圈',
    toastSaved:     '邀请卡已保存到相册',
    toastSaveFail:  '保存失败',
    errAlreadyReferred: '你已应用过邀请码。',
    errNotFound:        '邀请码不存在。',
    errCannotSelf:      '不能填自己的邀请码。',
    errProgram:         '推广计划暂未开放。',
    errMutual:          '互相邀请不可叠加。',
    errGeneric:         '邀请码应用失败,请重试。',
  },
};

Page({
  data: {
    lang: 'en',
    copy: COPY.en,
    loading: true,
    enabled: true,
    code: '',
    rewardPerOrder: 30,   // referrer reward ("for you")
    rewardReferee: 0,      // friend reward ("for them"); 0 = friend gets nothing
    shareImage: '',        // office-set share-card picture (absolute URL); '' = bundled default
    referredBy: null,
    canApply: false,
    applyInput: '',
    applyError: '',
    stats: { earned: '0.00', total_invites: 0, joined: 0, converted: 0 },
    invites: [],
    // The mini-program code is minted by WeChat, so it costs a round trip.
    // It is the centrepiece of the card, so it loads with the page.
    qrPng: '',
    qrLoading: false,
    qrError: '',
    how3subResolved: '',
    taglineResolved: '',
    cardFootResolved: '',
  },

  onShow() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyCopy();
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  applyCopy() {
    const copy = this.data.lang === 'cn' ? COPY.cn : COPY.en;
    this.setData({ copy, ...this.resolveCopy(copy, this.data.rewardPerOrder, this.data.rewardReferee) });
  },

  // Build the render-ready strings from the two reward amounts. When the
  // friend reward ("them") is 0 we use the single-sided "solo" copy so the
  // page never advertises a ¥0 friend reward. `how3sub` (the "You earn" step)
  // always reflects the referrer amount.
  resolveCopy(copy, you, them) {
    const y = String(Number(you) || 0);
    const t = String(Number(them) || 0);
    const sub = (s) => String(s || '').replace(/\{you\}/g, y).replace(/\{them\}/g, t);
    const split = (Number(them) || 0) > 0;
    return {
      how3subResolved:   copy.how3sub.replace('{r}', y),
      taglineResolved:   sub(split ? copy.tagline   : copy.taglineSolo),
      shareBodyResolved: sub(split ? copy.shareBody : copy.shareBodySolo),
      // Only shown when the friend actually gets something — otherwise the
      // card would advertise '¥0 off'.
      cardFootResolved:  split ? sub(copy.cardFoot) : '',
    };
  },

  async refresh() {
    const app = getApp();
    if (!app.globalData.token) {
      try { await app.silentLogin(); } catch {}
    }
    if (!app.globalData.token) {
      this.setData({ loading: false });
      return;
    }
    this.loadQr();
    this.setData({ loading: true });
    try {
      const data = await api.get('/api/retail/affiliate');
      const reward = Number(data.reward_per_order) || 0;
      const refereeReward = Number(data.reward_referee) || 0;
      const invites = (data.invites || []).map(it => ({
        id: it.id,
        nickname: it.nickname || '',
        avatar_url: it.avatar_url || '',
        initial: firstInitial(it.nickname),
        dateLabel: dateLabel(it.joined_at || it.rewarded_at),
        status: it.status,
        statusLabel: this.labelForStatus(it.status, Number(it.reward_amount) || 0),
      }));
      this.setData({
        loading: false,
        enabled: data.enabled !== false,
        code: data.code || '',
        rewardPerOrder: reward,
        rewardReferee: refereeReward,
        shareImage: data.share_image || '',
        referredBy: data.referred_by || null,
        canApply: !data.referred_by && data.enabled !== false,
        stats: {
          earned: (Number(data.stats?.earned) || 0).toFixed(2),
          total_invites: data.stats?.total_invites || 0,
          joined: data.stats?.joined || 0,
          converted: data.stats?.converted || 0,
        },
        invites,
        ...this.resolveCopy(this.data.copy, reward, refereeReward),
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message || 'Failed', icon: 'none' });
    }
  },

  labelForStatus(status, reward) {
    const c = this.data.copy;
    const r = (reward || 0).toFixed(0);
    if (status === 'ordered') return c.statusOrdered.replace('{r}', r);
    if (status === 'joined')  return c.statusJoined.replace('{r}', r);
    return c.statusVoid;
  },

  copyCode() {
    if (!this.data.code) return;
    wx.setClipboardData({
      data: this.data.code,
      success: () => wx.showToast({ title: this.data.copy.toastCopied, icon: 'success' }),
    });
  },

  shareTimeline() {
    // Mini-program Moments share is gated on user gesture from the
    // right-corner menu; we can only nudge the user to use it.
    wx.showToast({ title: this.data.copy.toastShareSoon, icon: 'none', duration: 2500 });
  },

  // The card IS the QR, so the code is fetched on load rather than on a tap.
  // Guarded so a pull-to-refresh doesn't re-mint one we already hold.
  async loadQr() {
    if (this.data.qrPng || this.data.qrLoading) return;
    this.setData({ qrLoading: true, qrError: '' });
    try {
      const d = await api.get('/api/retail/affiliate/qr');
      this.setData({ qrPng: d.qr || '', qrLoading: false });
    } catch (e) {
      // Includes a tenant with no WeChat credentials yet (501). Either way
      // there is no code to draw, so say so instead of spinning forever.
      this.setData({ qrLoading: false, qrError: this.data.copy.qrFailed });
    }
  },

  // Write the code's data URL to a real file. wx.canvasToTempFilePath and
  // saveImageToPhotosAlbum both need a path, never a base64 string; the
  // canvas image loader is happier with one too.
  qrToFile() {
    return new Promise((resolve, reject) => {
      const dataUrl = this.data.qrPng;
      if (!dataUrl) return reject(new Error('no_qr'));
      const fp = `${wx.env.USER_DATA_PATH}/referral-qr-${this.data.code || 'code'}.png`;
      wx.getFileSystemManager().writeFile({
        filePath: fp,
        data: dataUrl.replace(/^data:image\/\w+;base64,/, ''),
        encoding: 'base64',
        success: () => resolve(fp),
        fail: reject,
      });
    });
  },

  // Canvas has no letter-spacing, and the brand's small caps live or die by
  // their tracking — so tracked text is drawn a character at a time.
  drawTracked(ctx, text, cx, y, spacing) {
    const chars = String(text).split('');
    const width = chars.reduce((w, ch) => w + ctx.measureText(ch).width + spacing, -spacing);
    let x = cx - width / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + spacing;
    }
  },

  // Redraw the card as a picture. What gets forwarded into a chat is this
  // image, so the lime slab and the code travel together — a bare QR would
  // arrive on a stranger's screen with nothing saying Roots on it.
  //
  // Falls back to saving the code on its own if any part of the canvas path
  // fails: a plain QR is worth more than an error toast.
  async saveCard() {
    const c = this.data.copy;
    if (!this.data.qrPng) return;
    let filePath;
    try {
      filePath = await this.composeCard();
    } catch (e) {
      console.warn('[affiliate] card compose failed, saving the bare code:', e && e.message);
      try { filePath = await this.qrToFile(); }
      catch (e2) { return wx.showToast({ title: c.toastSaveFail, icon: 'none' }); }
    }
    this.saveToAlbum(filePath);
  },

  // Draw the card offscreen and hand back a temp file path.
  composeCard() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#cardCanvas')
        .fields({ node: true, size: true })
        .exec(async (res) => {
          const node = res && res[0] && res[0].node;
          if (!node) return reject(new Error('no_canvas_node'));

          let qrPath;
          try { qrPath = await this.qrToFile(); } catch (e) { return reject(e); }

          // The card's own proportions, in the same rpx figures the WXSS uses,
          // scaled up to a size worth sending: 662rpx wide card -> 1080px.
          const S = 1080 / 662;
          const px = (rpx) => rpx * S;
          const BORDER = px(3), QR = px(400);
          const W = px(662);
          const H = px(28) + px(23 * 1.2) + px(24) + QR + px(20) + px(64) + px(8) + px(37) + px(32);

          const ctx = node.getContext('2d');
          node.width = W;
          node.height = H;

          // Lime slab + ink keyline — the part that says Roots.
          ctx.fillStyle = '#CCD900';
          ctx.fillRect(0, 0, W, H);
          ctx.strokeStyle = '#1a1a17';
          ctx.lineWidth = BORDER * 2;
          ctx.strokeRect(0, 0, W, H);

          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          let y = px(28);

          // Label — tracked small caps, forest on lime.
          ctx.fillStyle = '#365329';
          ctx.font = `${px(23)}px "Toni Grotesk", sans-serif`;
          this.drawTracked(ctx, c.cardLbl, W / 2, y, px(23) * 0.22);
          y += px(23 * 1.2) + px(24);

          const img = node.createImage();
          img.onload = () => {
            ctx.drawImage(img, (W - QR) / 2, y, QR, QR);
            y += QR + px(20);

            ctx.textAlign = 'center';
            ctx.fillStyle = '#1a1a17';
            ctx.font = `${px(64)}px "Bear Serif", serif`;
            ctx.fillText(this.data.code || '', W / 2, y);
            y += px(64) + px(8);

            const foot = this.data.cardFootResolved;
            if (foot) {
              ctx.fillStyle = '#365329';
              ctx.font = `${px(25)}px "Aleo", serif`;
              ctx.fillText(foot, W / 2, y);
            }

            wx.canvasToTempFilePath({
              canvas: node,
              success: (r) => resolve(r.tempFilePath),
              fail: reject,
            });
          };
          img.onerror = () => reject(new Error('qr_image_load_failed'));
          img.src = qrPath;
        });
    });
  },

  saveToAlbum(filePath) {
    const c = this.data.copy;
    const doSave = () => wx.saveImageToPhotosAlbum({
      filePath,
      success: () => wx.showToast({ title: c.toastSaved, icon: 'success' }),
      // Covers the customer declining the album prompt — a toast, not an
      // error screen.
      fail: () => wx.showToast({ title: c.toastSaveFail, icon: 'none' }),
    });
    // A previously-refused album permission never re-prompts on its own; send
    // the customer to the settings sheet once, then retry.
    wx.getSetting({
      success: (s) => {
        if (s.authSetting && s.authSetting['scope.writePhotosAlbum'] === false) {
          wx.openSetting({ success: doSave });
        } else { doSave(); }
      },
      fail: doSave,
    });
  },


  onApplyInput(e) {
    this.setData({
      applyInput: String(e.detail.value || '').toUpperCase().slice(0, 32),
      applyError: '',
    });
  },

  async applyCode() {
    const code = String(this.data.applyInput || '').trim().toUpperCase();
    if (!code) return;
    const c = this.data.copy;
    try {
      await api.post('/api/retail/affiliate/apply', { code });
      this.setData({ applyInput: '', applyError: '' });
      wx.showToast({ title: c.toastApplied, icon: 'success' });
      this.refresh();
    } catch (e) {
      const map = {
        already_referred:  c.errAlreadyReferred,
        code_not_found:    c.errNotFound,
        cannot_refer_self: c.errCannotSelf,
        program_disabled:  c.errProgram,
        mutual_referral:   c.errMutual,
      };
      // Only show mapped, localized messages. Unknown backend codes / raw
      // transport strings (e.g. 'network_…', 'server_error_500') would leak
      // developer text to the customer, so fall back to a generic message.
      this.setData({ applyError: map[e.message] || c.errGeneric });
    }
  },

  // WeChat-built-in share — the user taps the right-corner menu "..." or
  // the green "WECHAT" share button (open-type="share"). We attach the
  // referral code to a tracked link so when the friend opens the mini app
  // we can pre-fill the apply box on the affiliate page.
  onShareAppMessage() {
    const code = this.data.code || '';
    // The share lands on the FRIEND, so it advertises THEIR reward
    // (rewardReferee). When that's 0 we use a neutral invite rather than
    // promising money the friend won't receive.
    const them = Number(this.data.rewardReferee) || 0;
    const en = this.data.lang === 'en';
    const title = them > 0
      ? (en ? `¥${them} back on your first Roots order — code ${code}`
            : `Roots 邀请码 ${code} · 首单返 ¥${them}`)
      : (en ? `Join me on Roots — use my code ${code}`
            : `Roots 邀请码 ${code} · 一起来逛`);
    return {
      title,
      // Land the friend on the storefront Home (not the affiliate page). The
      // ref code rides along so home.js can stash it; the affiliate apply box
      // falls back to that stashed code the next time the friend opens it.
      path: `/pages/home/home?ref=${encodeURIComponent(code)}`,
      // Office-set picture (admin → Affiliate) else the bundled default.
      imageUrl: this.data.shareImage || '/assets/brand/share-affiliate.png',
    };
  },

  onShareTimeline() {
    const code = this.data.code || '';
    const them = Number(this.data.rewardReferee) || 0;
    const en = this.data.lang === 'en';
    const title = them > 0
      ? (en ? `¥${them} back on your first Roots order — ${code}`
            : `Roots 首单返 ¥${them} · ${code}`)
      : (en ? `Join me on Roots — ${code}`
            : `一起来逛 Roots · ${code}`);
    return {
      title,
      query: `ref=${encodeURIComponent(code)}`,
    };
  },

  onLoad(query) {
    // Enable share-to-Moments. WeChat only fires onShareTimeline (and surfaces
    // the Moments entry in the "..." menu) if the page opts in here — without
    // this call the onShareTimeline handler below is dead and Moments referral
    // sharing never works.
    if (typeof this.enableShareTimeline === 'function') {
      this.enableShareTimeline();
    }
    // Pre-fill the apply box from a shared link's ref, or from the ref a
    // shared card stashed when it landed the friend on Home instead.
    let ref = query && query.ref ? String(query.ref) : '';
    if (!ref) {
      try { ref = wx.getStorageSync('pending_ref') || ''; } catch (e) {}
    }
    if (ref) {
      this.setData({ applyInput: ref.toUpperCase().slice(0, 32) });
    }
  },
});
