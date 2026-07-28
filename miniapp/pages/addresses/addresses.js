// Address book — full CRUD on saved delivery addresses.
// Reads/writes /api/retail/addresses (already implemented in routes/retail.js).
// One page, two modes: 'list' (show cards) and 'form' (add/edit).

const api = require('../../utils/api');
const zones = require('../../utils/zones');

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
    // Delivery-area selector, split by language (mirrors checkout):
    //  • CN → WeChat native region picker (省/市/区, always current/complete).
    //  • EN → bilingual city → district cascade (utils/zones + /api/retail/
    //    districts). Both write canonical Chinese province/city/district onto
    //    `form`, which is what the zone matcher needs.
    areaLabel: '',        // localized summary on the trigger ("Guangzhou · Tianhe")
    regionValue: [],      // CN native picker position [省, 市, 区]
    cityOptions: [],      // EN: [{ label, name_cn, name_en }] — for syncAreaLabel city→EN lookup
    cityLabel: '',        // EN: selected city label (label-build helper)
    // EN cascade picker (multiSelector): 省→市→区 columns mirroring the native wheel.
    areaTree: { provCn: [], provLabel: [], citiesByProv: {} },
    areaArray: [[], [], []],   // [provinceLabels, cityLabels, districtLabels]
    areaIndex: [0, 0, 0],      // [provinceIdx, cityIdx, districtIdx]
    areaDistData: [],          // district rows backing column 3
    areaDistCity: '',          // city name_cn areaDistData belongs to (race guard)
    lang: 'en',
    loading: true,
    saving: false,
    wxPicking: false,
    mapPicking: false,
    // Mirror of app.globalData.customer.nickname presence. When false we
    // show the bind-empty card in place of the list + add button — same
    // contract as checkout: addresses tie to WeChat-verified identity.
    isBound: true,
    copy: {
      title: 'Addresses',
      addBtn: '+ Add new address',
      editLabel: 'Edit',
      deleteLabel: 'Delete',
      defaultBadge: 'DEFAULT',
      // Card-tap UX: the selected card carries this badge instead of "DEFAULT"
      // since "default" is jargon the customer doesn't need to think about.
      selectedBadge: 'SELECTED',
      tapToSelectHint: 'Tap an address to use it',
      // Same flag the list badges as SELECTED — one idea, one wording.
      setDefault: 'Use this address',
      saveBtn: 'Save',
      cancelBtn: 'Cancel',
      formAdd: 'Add address',
      formEdit: 'Edit address',
      empty: 'No saved addresses yet.',
      wxPickBtn: 'Import from WeChat address',
      mapPickBtn: '📍 Choose on map',
      mapUnavailable: 'Map picker unavailable',
      placeholders: {
        name:   'Recipient name',
        phone:  'Phone number',
        addr:   'Street address',
        detail: 'Floor / unit / apartment (optional)',
        region: 'Tap to choose your delivery area',
      },
      confirmDelete: 'Delete this address?',
      regionRequired: 'Please choose your delivery area',
      // Bind-WeChat empty state — shown for unbound customers landing
      // here from the Me tab. Tapping the CTA opens /pages/profile.
      bindTitle: 'Bind WeChat to save addresses',
      bindBody: 'We pull your name, phone and address straight from WeChat — accurate every time, no manual typing.',
      bindCta: 'Bind WeChat →',
    },
  },

  async onLoad() {
    const app = getApp();
    // Wait for onLaunch's silentLogin to settle. Without this a deep-link
    // straight to /pages/addresses races auth and shows the bind-empty
    // state to a customer who's actually bound. Resolves immediately when
    // already authed (token restored from storage).
    if (app.authReady) { try { await app.authReady; } catch {} }
    const cust = app.globalData.customer || {};
    this.setData({ lang: app.globalData.lang, isBound: !!cust.nickname });
    this.applyLangCopy();
    this.loadAreaOptions();
    if (this.data.isBound) this.refresh();
    else this.setData({ loading: false });
  },

  // Fetch the served-zone list and build the localized area-selector options.
  // Cheap + cached in utils/zones. Called on land so the options are ready
  // whenever the customer opens the add/edit form.
  async loadAreaOptions() {
    try {
      const list = await zones.loadZones();
      this.setData({ cityOptions: zones.cityOptions(list, this.data.lang) });
      if (this.data.lang !== 'cn') this.buildAreaPicker(list);
    } catch (e) {
      console.warn('[addresses] loadAreaOptions failed:', e && e.message);
    }
  },

  // Re-derive the trigger label (and CN picker position) from the current form.
  // Used after editing an existing address or importing from WeChat. In EN we
  // localize the city to English when it's a known catalogue city.
  syncAreaLabel() {
    const f = this.data.form || {};
    let cityLabel = f.city || '';
    if (this.data.lang !== 'cn') {
      const m = (this.data.cityOptions || []).find(o => o.name_cn === f.city);
      if (m) cityLabel = m.name_en;
    }
    const patch = {
      cityLabel,
      areaLabel: [cityLabel, f.district].filter(Boolean).join(' · '),
    };
    if (this.data.lang === 'cn' && f.province) {
      patch.regionValue = [f.province, f.city, f.district].filter(Boolean);
    }
    this.setData(patch);
  },

  // Re-check bind state on every show so returning from /pages/profile via
  // navigateBack flips the page from empty-state to the real address book.
  // Also re-runs refresh() on every show so edits made on this page,
  // pulled from WeChat, or any other source land immediately — the
  // previous `bind-status unchanged → bail` shortcut left the list stale
  // when nothing about the bind flow had changed.
  onShow() {
    const app = getApp();
    const cust = app.globalData.customer || {};
    const isBound = !!cust.nickname;
    if (isBound !== this.data.isBound) this.setData({ isBound });
    if (isBound) this.refresh();
  },

  // Routes into the WeChat-profile bind flow. wx.navigateBack returns here
  // and onShow refreshes the page once nickname is set.
  bindWechat() {
    wx.navigateTo({ url: '/pages/profile/profile' });
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
        selectedBadge: '已选',
        tapToSelectHint: '点击地址即可使用',
        setDefault: '使用此地址',
        saveBtn: '保存',
        cancelBtn: '取消',
        formAdd: '新增地址',
        formEdit: '编辑地址',
        empty: '暂无保存的地址。',
        wxPickBtn: '从微信地址导入',
        mapPickBtn: '📍 地图选点',
        mapUnavailable: '地图选点不可用',
        placeholders: {
          name:   '收件人姓名',
          phone:  '手机号码',
          addr:   '详细地址',
          detail: '楼层 / 单元 / 公寓 (可选)',
          region: '点击选择配送区域',
        },
        confirmDelete: '删除此地址?',
        regionRequired: '请选择配送区域',
        bindTitle: '绑定微信,保存地址',
        bindBody: '我们从微信直接读取您的姓名、电话和地址 — 准确无误,无需手动输入。',
        bindCta: '绑定微信 →',
      },
    });
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const list = await api.get('/api/retail/addresses');
      const arr = Array.isArray(list) ? list : list?.data || [];
      this.setData({ addresses: arr, loading: false });
      return arr;
    } catch (e) {
      console.warn('[addresses] load failed:', e.message);
      this.setData({ loading: false });
      return this.data.addresses;
    }
  },

  // The delivery pill (ride-time / "ships by courier") is computed server-side
  // from the address's geocoded lat/lng, which is resolved in a fire-and-forget
  // background call AFTER the save responds. So the first refresh right after
  // adding/editing can land before coords exist — the new card shows with no
  // pill until you leave and re-enter. Re-pull a few times so the pill fills in
  // on its own. Bounded + only while the list is on screen.
  _clearEtaSettle() {
    if (this._etaSettleTimer) { clearTimeout(this._etaSettleTimer); this._etaSettleTimer = null; }
  },
  scheduleEtaSettle(tries = 4) {
    this._clearEtaSettle();
    if (tries <= 0) return;
    this._etaSettleTimer = setTimeout(async () => {
      this._etaSettleTimer = null;
      if (this.data.mode !== 'list') return;   // customer started another edit
      const arr = await this.refresh();
      // Stop once every address has resolved an ETA (or we run out of tries).
      const pending = (arr || []).some(a => !a.delivery_eta);
      if (pending) this.scheduleEtaSettle(tries - 1);
    }, 1500);
  },

  onHide() { this._clearEtaSettle(); },
  onUnload() { this._clearEtaSettle(); },

  showAddForm() {
    this.setData({
      mode: 'form',
      form: { ...EMPTY_FORM },
      areaLabel: '',
      regionValue: [],
      cityLabel: '',
      areaIndex: [0, 0, 0],
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
    });
    // Show the localized label for the saved area (if it's a served zone).
    this.syncAreaLabel();
  },
  cancelForm() {
    this.setData({
      mode: 'list',
      form: { ...EMPTY_FORM },
      areaLabel: '',
      regionValue: [],
      cityLabel: '',
      areaIndex: [0, 0, 0],
    });
  },

  // CN — WeChat native region picker. value = [省, 市, 区] (Chinese). Fold a
  // 市辖区 city column onto the province (municipalities) so the matcher sees a
  // real city.
  onRegionChange(e) {
    const v = e.detail.value || [];
    let [province, city, district] = v;
    if (city === '市辖区' || city === '县') city = province;
    this.setData({
      regionValue: v,
      areaLabel: v.filter(Boolean).join(' · '),
      'form.province': province || '',
      'form.city': city || '',
      'form.district': district || '',
    });
  },

  // EN — initialize the 省→市→区 cascade columns from the served-zone tree.
  buildAreaPicker(list) {
    const tree = zones.provinceTree(list, this.data.lang);
    if (!tree.provCn.length) return;
    const cities = tree.citiesByProv[tree.provCn[0]] || [];
    this.setData({
      areaTree: tree,
      areaArray: [tree.provLabel.slice(), cities.map(c => c.label), [this._distNoneLabel()]],
      areaIndex: [0, 0, 0],
      areaDistData: [this._distNone()],
      areaDistCity: '',
    });
    this._loadDistCol(cities[0]);
  },

  _distNoneLabel() { return this.data.lang === 'cn' ? '全城' : 'City-wide'; },
  _distNone() { return { label: this._distNoneLabel(), name_cn: '', name_en: 'City-wide' }; },

  // Load a city's districts into column 3 (leading "City-wide" sentinel for
  // districtless / whole-city picks). Cached per city in utils/zones.
  async _loadDistCol(city) {
    const cn = this.data.lang === 'cn';
    let rows = [this._distNone()];
    if (city) {
      try {
        const raw = await zones.loadDistricts(city.name_cn);
        rows = rows.concat((raw || []).map(d => ({
          label: cn ? d.name_cn : d.name_en, name_cn: d.name_cn, name_en: d.name_en,
        })));
      } catch (e) { console.warn('[addresses] loadDistricts failed:', e && e.message); }
    }
    const arr = (this.data.areaArray || [[], [], []]).slice();
    arr[2] = rows.map(r => r.label);
    this.setData({ areaArray: arr, areaDistData: rows, areaDistCity: city ? city.name_cn : '' });
  },

  // EN — a wheel column moved.
  async onAreaColumn(e) {
    const { column, value } = e.detail;
    const tree = this.data.areaTree;
    const idx = (this.data.areaIndex || [0, 0, 0]).slice();
    if (column === 0) {
      idx[0] = value; idx[1] = 0; idx[2] = 0;
      const cities = tree.citiesByProv[tree.provCn[value]] || [];
      const arr = this.data.areaArray.slice();
      arr[1] = cities.map(c => c.label);
      arr[2] = [this._distNoneLabel()];
      this.setData({ areaArray: arr, areaIndex: idx });
      await this._loadDistCol(cities[0]);
    } else if (column === 1) {
      idx[1] = value; idx[2] = 0;
      this.setData({ areaIndex: idx });
      const cities = tree.citiesByProv[tree.provCn[idx[0]]] || [];
      await this._loadDistCol(cities[value]);
    } else {
      idx[2] = value;
      this.setData({ areaIndex: idx });
    }
  },

  // EN — cascade confirmed. Province is known, so set it directly; district 0
  // is the "City-wide" sentinel → blank district (city-wide delivery).
  async onAreaConfirm(e) {
    const v = e.detail.value || [];
    const pi = v[0] || 0, ci = v[1] || 0, di = v[2] || 0;
    const tree = this.data.areaTree;
    const provCn = tree.provCn[pi];
    const cities = tree.citiesByProv[provCn] || [];
    const c = cities[ci] || cities[0];
    if (!c) return;
    let dists = this.data.areaDistData;
    if (this.data.areaDistCity !== c.name_cn) {     // fast-confirm race guard
      const cn = this.data.lang === 'cn';
      let rows = [this._distNone()];
      try {
        const raw = await zones.loadDistricts(c.name_cn);
        rows = rows.concat((raw || []).map(d => ({
          label: cn ? d.name_cn : d.name_en, name_cn: d.name_cn, name_en: d.name_en,
        })));
      } catch (_) {}
      dists = rows;
    }
    const d = dists[di] || dists[0];
    const districtCn = (d && d.name_cn) || '';
    const provLabel = tree.provLabel[pi];
    const parts = (provLabel === c.label ? [c.label] : [provLabel, c.label])
      .concat(districtCn ? [d.label] : []);
    this.setData({
      areaIndex: [pi, ci, di],
      cityLabel: c.label,
      areaLabel: parts.join(' · '),
      'form.province': provCn,
      'form.city': c.name_cn,
      'form.district': districtCn,
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
        wxPicking: false,
      });
      // Snap the area selector to the imported region if it's a served zone;
      // otherwise the label falls back to the raw imported city/district.
      this.syncAreaLabel();
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

  // Open WeChat's native map picker — centers on the customer's current
  // location, lets them drag the pin / search, and returns a Chinese address
  // ({ name, address, latitude, longitude }) for ANY spot (no need for it to
  // be in their saved WeChat address book, unlike pickFromWechat). This is the
  // English-address answer: the customer points at the place and we store
  // canonical Chinese — nothing to translate. Requires `scope.userLocation`
  // (declared in app.json) AND the geolocation interface approved for the
  // AppID in the WeChat MP console — see note in the form WXML.
  pickOnMap() {
    if (this.data.mapPicking) return;
    this.setData({ mapPicking: true });

    // Consume the picker's result. It's shaped like a wx.chooseLocation result
    // ({ name, address, latitude, longitude } + already-resolved province/city/
    // district), so the parse below is identical to the old native-picker path.
    const apply = (res) => {
      const addressStr = (res && res.address) || '';
      const p = this.parseCnAddress(addressStr);
      let street = p.rest || '';
      // Prefix the POI name as a landmark when it isn't already in the street.
      if (res && res.name && street.indexOf(res.name) === -1) {
        street = street ? `${res.name} ${street}` : res.name;
      }
      if (!street && !p.city && !p.province) {
        this.setData({ mapPicking: false });
        wx.showToast({ title: this.data.lang === 'cn' ? '无法读取此处地址' : "Couldn't read that spot", icon: 'none' });
        return;
      }
      this.setData({
        mapPicking: false,
        // Overwrite the street with the pick (never keep a stale street from a
        // previously-loaded/edited address — that could pair the new region
        // with an old, unrelated street). street already folds in the POI name.
        'form.address': street,
        'form.province': p.province || '',
        'form.city': p.city || '',
        'form.district': p.district || '',
        // Label the picked region in CHINESE — it's exactly what's stored and
        // what JD prints on the waybill, so we don't half-translate it to a
        // mixed "Guangzhou · 天河区".
        cityLabel: p.city || this.data.cityLabel,
        areaLabel: [p.city, p.district].filter(Boolean).join(' · '),
      });
      wx.showToast({ title: this.data.lang === 'cn' ? '已选择' : 'Picked', icon: 'success' });
    };

    // Open OUR in-app map picker instead of wx.chooseLocation — its native
    // list's bare "Location" entry fails on some clients. Seed the picker with
    // the address being edited if it carries coordinates.
    const f = this.data.form || {};
    const sLat = Number(f.lat), sLng = Number(f.lng);
    const q = (sLat && sLng && isFinite(sLat) && isFinite(sLng)) ? `?lat=${sLat}&lng=${sLng}` : '';
    wx.navigateTo({
      url: '/pages/map-picker/map-picker' + q,
      events: { mapPicked: apply },
      success: () => this.setData({ mapPicking: false }),
      fail: () => {
        this.setData({ mapPicking: false });
        wx.showToast({ title: this.data.copy.mapUnavailable, icon: 'none' });
      },
    });
  },

  // Split a flat Chinese address string into { province, city, district, rest }.
  // chooseLocation returns the address as one string (unlike chooseAddress's
  // structured fields), so we segment on the standard administrative suffixes.
  // Handles direct-controlled municipalities (北京/上海/天津/重庆), where the
  // 市 IS the province and the next token is the 区.
  parseCnAddress(input) {
    const str = String(input || '').trim();
    const out = { province: '', city: '', district: '', rest: str };
    let rest = str;

    let m = rest.match(/^(.*?(?:省|特别行政区|自治区))/);
    if (m) { out.province = m[1]; rest = rest.slice(m[1].length); }
    else {
      const muni = rest.match(/^(北京市|上海市|天津市|重庆市)/);
      if (muni) { out.province = muni[1]; rest = rest.slice(muni[1].length); }
    }

    m = rest.match(/^(.*?(?:市|自治州|地区|盟))/);
    if (m) { out.city = m[1]; rest = rest.slice(m[1].length); }

    m = rest.match(/^(.*?(?:区|县|旗))/);
    if (m) { out.district = m[1]; rest = rest.slice(m[1].length); }

    // Municipality: 市 was consumed as the province → use it as the city too,
    // matching how onRegionChange folds 市辖区 onto the province.
    if (!out.city && /市$/.test(out.province)) out.city = out.province;

    out.rest = rest.trim();
    return out;
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
    // Every served zone sets a city (GZ districts also set a district; non-GZ
    // city zones don't need one), so requiring a city is enough to confirm an
    // area was picked from the selector.
    if (!f.city) {
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
        // A brand-new address is the one the customer wants to use — that's why
        // they just typed it. The list calls that flag SELECTED and checkout
        // reads the same flag, so adding and choosing are one step instead of
        // save → find the new card → tap it. Editing a stored address says
        // nothing about where to ship, so there the switch still decides.
        is_default: f.id ? !!f.is_default : true,
      };
      let newId = null;
      if (f.id) {
        await api.put('/api/retail/addresses/' + f.id, body);
      } else {
        const saved = await api.post('/api/retail/addresses', body);
        newId = (saved && saved.id) || null;
      }
      wx.showToast({ title: this.data.lang === 'cn' ? '已保存' : 'Saved', icon: 'success' });
      this.setData({
        saving: false,
        mode: 'list',
        form: { ...EMPTY_FORM },
        areaLabel: '',
        regionValue: [],
        cityLabel: '',
        areaIndex: [0, 0, 0],
      });
      await this.refresh();
      if (newId) {
        // Point the rest of the app at the address they just added: the cart
        // reads this for its free-shipping threshold, and a checkout page
        // sitting underneath us re-pulls on the flag (same handoff as
        // pickAddress) instead of keeping its older pick.
        try { getApp().globalData.activeAddressId = newId; } catch {}
        const pages = getCurrentPages();
        const prev = pages.length > 1 ? pages[pages.length - 2] : null;
        if (prev && prev.setData) {
          try { prev.setData({ _addressJustPicked: newId }); } catch {}
        }
      }
      // New/edited row's geocode resolves in the background — keep refreshing
      // until its delivery pill appears, so the customer doesn't have to leave.
      this.scheduleEtaSettle();
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

  // Tap the whole address card → mark it as default (which is what checkout
  // reads to pre-select an address) and bounce back to the previous page if
  // there's one underneath us (typical entry: checkout → CHANGE → here).
  // From the Me-tab entry there's no page to go back to, so we just refresh
  // in place and toast — the badge moves to the tapped card so the customer
  // sees the change took effect.
  async pickAddress(e) {
    const id = e.currentTarget.dataset.id;
    const current = this.data.addresses.find(a => a.is_default);
    // Skip the round-trip if they tapped the already-selected card.
    const alreadySelected = current && current.id === id;
    try {
      if (!alreadySelected) {
        await api.put('/api/retail/addresses/' + id, { is_default: true });
      }
      // Optimistic local update — flip is_default on the tapped row before
      // refresh() returns so the badge moves instantly.
      const next = this.data.addresses.map(a => ({ ...a, is_default: a.id === id }));
      this.setData({ addresses: next });

      const pages = getCurrentPages();
      if (pages.length > 1) {
        // Came from another page (almost always checkout). Drop a flag the
        // previous page can read in onShow() so it re-pulls /addresses and
        // re-runs /quote with the new pick.
        const prev = pages[pages.length - 2];
        if (prev && prev.setData) {
          try { prev.setData({ _addressJustPicked: id }); } catch {}
        }
        wx.navigateBack();
      } else {
        wx.showToast({
          title: this.data.lang === 'cn' ? '已选择' : 'Selected',
          icon: 'success',
          duration: 1200,
        });
      }
    } catch (err) {
      wx.showToast({ title: err.message || 'Failed', icon: 'none' });
    }
  },
});
