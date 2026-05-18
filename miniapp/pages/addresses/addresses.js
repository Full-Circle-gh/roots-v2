// Address book — full CRUD on saved delivery addresses.
// Reads/writes /api/retail/addresses (already implemented in routes/retail.js).
// One page, two modes: 'list' (show cards) and 'form' (add/edit).

const api = require('../../utils/api');

const EMPTY_FORM = {
  id: null,
  recipient_name: '',
  phone: '',
  address: '',
  detail: '',
  city: '',
  district: '',
  province: '',
  is_default: false,
};

Page({
  data: {
    addresses: [],
    mode: 'list',           // 'list' | 'form'
    form: { ...EMPTY_FORM },
    // Region picker value: [province, city, district]. Always 3 strings.
    // Empty string means "not picked yet" — WeChat shows the first
    // province/city/district in the wheel as the default starting position.
    regionValue: ['', '', ''],
    lang: 'en',
    loading: true,
    saving: false,
    wxPicking: false,
    copy: {
      title: 'Addresses',
      addBtn: '+ Add new address',
      editLabel: 'Edit',
      deleteLabel: 'Delete',
      defaultBadge: 'DEFAULT',
      setDefault: 'Set as default',
      saveBtn: 'Save',
      cancelBtn: 'Cancel',
      formAdd: 'Add address',
      formEdit: 'Edit address',
      empty: 'No saved addresses yet.',
      wxPickBtn: 'Import from WeChat address',
      placeholders: {
        name:   'Recipient name',
        phone:  'Phone number',
        addr:   'Street address',
        detail: 'Floor / unit / apartment (optional)',
        region: 'Tap to choose province / city / district',
      },
      confirmDelete: 'Delete this address?',
      regionRequired: 'Please pick province, city, district',
    },
  },

  onLoad() {
    const app = getApp();
    this.setData({ lang: app.globalData.lang });
    this.applyLangCopy();
    this.refresh();
  },

  applyLangCopy() {
    if (this.data.lang !== 'cn') return;
    this.setData({
      copy: {
        title: '收货地址',
        addBtn: '+ 新增地址',
        editLabel: '编辑',
        deleteLabel: '删除',
        defaultBadge: '默认',
        setDefault: '设为默认',
        saveBtn: '保存',
        cancelBtn: '取消',
        formAdd: '新增地址',
        formEdit: '编辑地址',
        empty: '暂无保存的地址。',
        wxPickBtn: '从微信地址导入',
        placeholders: {
          name:   '收件人姓名',
          phone:  '手机号码',
          addr:   '详细地址',
          detail: '楼层 / 单元 / 公寓 (可选)',
          region: '点击选择省 / 市 / 区',
        },
        confirmDelete: '删除此地址?',
        regionRequired: '请选择省 / 市 / 区',
      },
    });
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const list = await api.get('/api/retail/addresses');
      const arr = Array.isArray(list) ? list : list?.data || [];
      this.setData({ addresses: arr, loading: false });
    } catch (e) {
      console.warn('[addresses] load failed:', e.message);
      this.setData({ loading: false });
    }
  },

  showAddForm() {
    this.setData({
      mode: 'form',
      form: { ...EMPTY_FORM },
      regionValue: ['', '', ''],
    });
  },
  showEditForm(e) {
    const id = e.currentTarget.dataset.id;
    const a = this.data.addresses.find(x => x.id === id);
    if (!a) return;
    this.setData({
      mode: 'form',
      form: {
        id: a.id,
        recipient_name: a.recipient_name || '',
        phone: a.phone || '',
        address: a.address || '',
        detail: a.detail || '',
        province: a.province || '',
        city: a.city || '',
        district: a.district || '',
        is_default: !!a.is_default,
      },
      // Seed the picker's wheels with the saved region so editing doesn't
      // wipe the values when the customer opens the picker.
      regionValue: [a.province || '', a.city || '', a.district || ''],
    });
  },
  cancelForm() {
    this.setData({
      mode: 'list',
      form: { ...EMPTY_FORM },
      regionValue: ['', '', ''],
    });
  },

  // Region picker change — WeChat returns { value: [province, city, district] }.
  // Mirror the three strings into the form so save() picks them up.
  onRegionChange(e) {
    const [province, city, district] = e.detail.value || ['', '', ''];
    this.setData({
      regionValue: [province, city, district],
      'form.province': province,
      'form.city': city,
      'form.district': district,
    });
  },

  onField(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  // Pull a saved address from WeChat. Requires `scope.address`. If the user
  // denies or the API isn't approved for this AppID, we surface a soft toast
  // and fall through to manual entry.
  pickFromWechat() {
    if (this.data.wxPicking) return;
    this.setData({ wxPicking: true });
    const apply = (addr) => {
      const province = addr.provinceName || '';
      const city = addr.cityName || '';
      const county = addr.countyName || '';
      const street = addr.detailInfo || '';
      this.setData({
        'form.recipient_name': addr.userName || this.data.form.recipient_name,
        'form.phone': addr.telNumber || this.data.form.phone,
        // Street + building only — province/city/district are kept in their
        // own fields (no longer concatenated into the address field).
        'form.address': street || this.data.form.address,
        'form.city': city || this.data.form.city,
        // WeChat's countyName is the delivery-zone district (e.g. 番禺区).
        // Without persisting it, GZ-district zone-match fails at checkout.
        'form.district': county || this.data.form.district,
        'form.province': province || this.data.form.province,
        // Seed the visible region-picker wheel so it shows what WeChat gave us.
        regionValue: [province, city, county],
        wxPicking: false,
      });
      wx.showToast({ title: this.data.lang === 'cn' ? '已导入' : 'Imported', icon: 'success' });
    };
    const fail = (err) => {
      this.setData({ wxPicking: false });
      const cancelled = err && /cancel|deny|auth.*deny/i.test(err.errMsg || '');
      if (cancelled) return;
      wx.showToast({
        title: this.data.lang === 'cn' ? '微信地址不可用' : 'WeChat address unavailable',
        icon: 'none',
      });
    };
    if (!wx.chooseAddress) return fail({ errMsg: 'api_missing' });
    wx.getSetting({
      success: (s) => {
        const granted = s.authSetting['scope.address'];
        if (granted === false) {
          wx.openSetting({
            success: (r) => {
              if (r.authSetting['scope.address']) {
                wx.chooseAddress({ success: apply, fail });
              } else {
                this.setData({ wxPicking: false });
              }
            },
            fail,
          });
        } else {
          wx.chooseAddress({ success: apply, fail });
        }
      },
      fail,
    });
  },

  onDefaultToggle(e) {
    this.setData({ 'form.is_default': e.detail.value });
  },

  async save() {
    if (this.data.saving) return;
    const f = this.data.form;
    if (!f.recipient_name || !f.phone || !f.address) {
      wx.showToast({
        title: this.data.lang === 'cn' ? '请填写姓名、电话、地址' : 'Fill name, phone, address',
        icon: 'none',
      });
      return;
    }
    if (!f.province || !f.city || !f.district) {
      wx.showToast({ title: this.data.copy.regionRequired, icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const body = {
        recipient_name: f.recipient_name,
        phone: f.phone,
        address: f.address,
        detail: f.detail || null,
        province: f.province,
        city: f.city,
        district: f.district,
        is_default: !!f.is_default,
      };
      if (f.id) {
        await api.put('/api/retail/addresses/' + f.id, body);
      } else {
        await api.post('/api/retail/addresses', body);
      }
      wx.showToast({ title: this.data.lang === 'cn' ? '已保存' : 'Saved', icon: 'success' });
      this.setData({
        saving: false,
        mode: 'list',
        form: { ...EMPTY_FORM },
        regionValue: ['', '', ''],
      });
      await this.refresh();
    } catch (e) {
      this.setData({ saving: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async deleteAddr(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise(resolve =>
      wx.showModal({
        title: this.data.copy.confirmDelete,
        confirmText: this.data.lang === 'cn' ? '删除' : 'Delete',
        cancelText:  this.data.lang === 'cn' ? '取消' : 'Cancel',
        success: r => resolve(r.confirm),
      })
    );
    if (!ok) return;
    try {
      await api.del('/api/retail/addresses/' + id);
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async setDefault(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await api.put('/api/retail/addresses/' + id, { is_default: true });
      await this.refresh();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
