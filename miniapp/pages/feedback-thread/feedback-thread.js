// One feedback conversation — the customer's report and the store's replies,
// with a box to reply back. Reached from the Notifications inbox (when the
// store replies) or from the "Your reports" list on the Found-a-bug page.
// GET marks the thread read (clears the "new reply" dot); POST adds a turn.
const api = require('../../utils/api');

// Server timestamps are UTC ('YYYY-MM-DD HH:MM:SS'); render a short label.
function fmtTime(iso, cn) {
  if (!iso) return '';
  const norm = String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z';
  const d = new Date(norm);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const COPY_EN = {
  kicker: 'YOUR REPORT', title: 'Conversation.',
  store: 'Store', you: 'You',
  placeholder: 'Reply to the store…', send: 'SEND', sending: 'SENDING…',
  empty: 'Please type a reply', notFound: 'This report could not be found.',
};
const COPY_CN = {
  kicker: '你的反馈', title: '对话记录。',
  store: '商家', you: '你',
  placeholder: '回复商家…', send: '发送', sending: '发送中…',
  empty: '请输入回复内容', notFound: '未找到该反馈。',
};

Page({
  data: {
    id: null,
    lang: 'en',
    copy: COPY_EN,
    loading: true,
    notFound: false,
    messages: [],
    reply: '',
    sending: false,
  },

  onLoad(query) {
    const app = getApp();
    const lang = app?.globalData?.lang || 'en';
    const id = parseInt(query.id, 10) || null;
    this.setData({ id, lang, copy: lang === 'cn' ? COPY_CN : COPY_EN });
  },

  // Re-read while the page stays open, so a reply sent from the website or
  // the back office shows up here. 8000 matches the website's FB_POLL_MS.
  // onShow also covers the first open (it runs after onLoad).
  onShow() {
    this.load(!!this._seen);
    this._seen = true;
    clearInterval(this._poll);
    this._poll = setInterval(() => this.load(true), 8000);
  },
  onHide() { clearInterval(this._poll); },
  onUnload() { clearInterval(this._poll); },

  async load(quiet) {
    const app = getApp();
    if (!app.globalData.token) { try { await app.silentLogin(); } catch {} }
    if (!this.data.id) { this.setData({ loading: false, notFound: true }); return; }
    const cn = this.data.lang === 'cn';
    // A re-read must not swap the thread for the loading dots, and must not
    // touch `reply` — that is the sentence the customer is typing.
    if (!quiet && !(this.data.messages || []).length) this.setData({ loading: true });
    try {
      const res = await api.get('/api/retail/feedback/' + this.data.id);
      const data = (res && res.data) || res;
      const messages = (data.messages || []).map(m => ({
        id: m.id,
        mine: m.author === 'customer',
        who: m.author === 'customer' ? this.data.copy.you
          : (m.author_name || this.data.copy.store),
        body: m.body || '',
        time: fmtTime(m.created_at, cn),
      }));
      const sig = messages.map(m => m.id + '\0' + m.body).join('\n');
      if (quiet && sig === this._sig) return;
      this._sig = sig;
      // A store-initiated direct message isn't "your report" — relabel the
      // header so the customer sees it as a message from the store.
      const copy = data.kind === 'message'
        ? { ...this.data.copy, kicker: cn ? '消息' : 'MESSAGE', title: cn ? '来自商家。' : 'From the store.' }
        : this.data.copy;
      this.setData({ messages, copy, loading: false, notFound: false });
    } catch (e) {
      if (quiet) return;
      this.setData({ loading: false, notFound: true });
    }
  },

  onReply(e) { this.setData({ reply: e.detail.value }); },

  async send() {
    if (this.data.sending) return;
    const message = (this.data.reply || '').trim();
    if (!message) { wx.showToast({ title: this.data.copy.empty, icon: 'none' }); return; }
    this.setData({ sending: true });
    try {
      await api.post('/api/retail/feedback/' + this.data.id + '/reply', { message });
      this.setData({ reply: '' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || 'failed', icon: 'none' });
    } finally {
      this.setData({ sending: false });
    }
  },
});
