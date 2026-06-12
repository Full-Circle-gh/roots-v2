// In-app map picker — our own replacement for wx.chooseLocation (whose native
// list has an unreliable bare "Location" entry). Mirrors WeChat's UI: a <map>
// with a fixed centre pin on top, then a search box + a scrollable POI list.
//
//   • Pan the map  → the centre pin's address resolves (reverse-geocode) and
//                    becomes the selection; nearby POIs refresh below.
//   • Tap a POI    → the map recentres on it and it becomes the selection.
//   • Type to search → keyword POI results (biased to the centre / city).
//   • Use this spot → emits a chooseLocation-shaped result to the opener.
//
// MapContext.getCenterLocation() needs no location permission, so the core
// flow works even though wx.getLocation is rejected for this AppID. POI search +
// reverse-geocode go through our server (/api/retail/*), which holds the Amap key.
const api = require('../../utils/api');

Page({
  data: {
    lat: 23.1351,        // default centre — Guangzhou / Tianhe (Roots' area)
    lng: 113.3607,
    scale: 16,
    lang: 'en',
    resolving: false,    // pin address being reverse-geocoded
    pinAddress: '',      // the centre pin's resolved address
    pois: [],            // [{ id, name, address, lat, lng, distance, ... }]
    selectedId: 'pin',   // 'pin' = use the centre pin; otherwise a POI id
    keyword: '',
    listLoading: false,
    listEmpty: false,
    canConfirm: false,
  },

  onLoad(query) {
    let lang = 'en';
    try { lang = getApp().globalData.lang || 'en'; } catch (e) {}
    const patch = { lang };
    const qLat = query && Number(query.lat);
    const qLng = query && Number(query.lng);
    if (qLat && qLng && isFinite(qLat) && isFinite(qLng)) { patch.lat = qLat; patch.lng = qLng; }
    this.setData(patch);
    this._result = null;                          // chosen payload (non-data)
    this._center = { lat: this.data.lat, lng: this.data.lng };
    this._pinCity = '';
    this._suppress = false;                       // skip the next regionchange
    this._t = null;
    this._st = null;
  },

  onReady() {
    this.mapCtx = wx.createMapContext('picker-map', this);
    // Open centred on the customer. Give the map a moment to initialise, then
    // make sure we have location permission BEFORE moving — otherwise the very
    // first open silently no-ops (and the user only sees themselves after
    // tapping the locate button).
    setTimeout(() => this.initLocate(), 300);
  },

  initLocate() {
    wx.getSetting({
      success: (s) => {
        const granted = s.authSetting && s.authSetting['scope.userLocation'];
        if (granted === false) {
          // Explicitly denied before — can't auto-locate; resolve the default.
          this.refreshForCenter();
          return;
        }
        if (granted === true) { this.centerOnMe(true); return; }
        // Undecided → ask once; on grant, locate; otherwise fall back.
        wx.authorize({
          scope: 'scope.userLocation',
          success: () => this.centerOnMe(true),
          fail: () => this.refreshForCenter(),
        });
      },
      fail: () => this.centerOnMe(true),
    });
  },

  onUnload() {
    if (this._t) clearTimeout(this._t);
    if (this._st) clearTimeout(this._st);
  },

  // A user-driven pan/zoom selects the pin again and refreshes; a programmatic
  // recentre (POI tap) is suppressed so it doesn't flip the selection back.
  onRegionChange(e) {
    if (e.type !== 'end') return;
    if (this._suppress) { this._suppress = false; return; }
    if (this.data.selectedId !== 'pin') this.setData({ selectedId: 'pin' });
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => this.refreshForCenter(), 450);
  },

  // Read the map centre once, then refresh the pin address + nearby POIs.
  refreshForCenter() {
    if (!this.mapCtx) return;
    this.mapCtx.getCenterLocation({
      success: (c) => {
        this._center = { lat: c.latitude, lng: c.longitude };
        this.resolvePin(c.latitude, c.longitude);
        if (!this.data.keyword.trim()) this.loadNearby(c.latitude, c.longitude);
      },
    });
  },

  resolvePin(lat, lng) {
    this.setData({ resolving: true });
    api.post('/api/retail/reverse-geocode', { lat, lng })
      .then((g) => {
        const onPin = this.data.selectedId === 'pin';
        if (g && g.address) {
          this._pinCity = g.city || '';
          if (onPin) {
            this._result = { name: '', address: g.address, province: g.province || '', city: g.city || '', district: g.district || '', latitude: lat, longitude: lng };
          }
          this.setData({ resolving: false, pinAddress: g.address, canConfirm: onPin ? true : this.data.canConfirm });
        } else {
          if (onPin) { this._result = null; this.setData({ canConfirm: false }); }
          this.setData({ resolving: false, pinAddress: '' });
        }
      })
      .catch(() => {
        if (this.data.selectedId === 'pin') { this._result = null; this.setData({ canConfirm: false }); }
        this.setData({ resolving: false, pinAddress: '' });
      });
  },

  loadNearby(lat, lng) {
    this.setData({ listLoading: true });
    api.post('/api/retail/poi-search', { lat, lng })
      .then((list) => this.setPois(list))
      .catch(() => this.setPois([]));
  },

  setPois(list) {
    const arr = (Array.isArray(list) ? list : []).slice(0, 25).map((p, i) => ({
      id: 'p' + i,
      name: p.name || '',
      address: p.address || '',
      province: p.province || '',
      city: p.city || '',
      district: p.district || '',
      lat: p.lat,
      lng: p.lng,
      distance: (p.distance != null && isFinite(p.distance)) ? p.distance : null,
    })).filter((x) => x.name && x.lat != null && x.lng != null);
    this.setData({ pois: arr, listLoading: false, listEmpty: arr.length === 0 });
  },

  onSearchInput(e) {
    const kw = e.detail.value || '';
    this.setData({ keyword: kw });
    if (this._st) clearTimeout(this._st);
    if (!kw.trim()) { this.refreshForCenter(); return; }
    this._st = setTimeout(() => this.runSearch(kw.trim()), 400);
  },

  onSearchConfirm(e) {
    const kw = (e.detail.value || '').trim();
    if (kw) this.runSearch(kw);
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.refreshForCenter();
  },

  runSearch(kw) {
    this.setData({ listLoading: true });
    api.post('/api/retail/poi-search', { lat: this._center.lat, lng: this._center.lng, keyword: kw, city: this._pinCity || '' })
      .then((list) => this.setPois(list))
      .catch(() => this.setPois([]));
  },

  selectPin() {
    this.setData({ selectedId: 'pin', keyword: '' });
    this.refreshForCenter();
  },

  selectPoi(e) {
    const i = Number(e.currentTarget.dataset.i);
    const poi = this.data.pois[i];
    if (!poi) return;
    this._result = {
      name: poi.name,
      address: poi.address || poi.name,
      province: poi.province,
      city: poi.city,
      district: poi.district,
      latitude: poi.lat,
      longitude: poi.lng,
    };
    this._center = { lat: poi.lat, lng: poi.lng };
    this._suppress = true;   // the recentre below shouldn't reset to the pin
    this.setData({ selectedId: poi.id, canConfirm: true, lat: poi.lat, lng: poi.lng });
  },

  // Recentre the map on the device. `initial` = on-open (silent on failure);
  // retries once because the first attempt can fire before the map's location
  // subsystem is ready (which is why the on-open jump used to be missed).
  centerOnMe(initial, _retry) {
    if (!this.mapCtx) return;
    this.mapCtx.moveToLocation({
      success: () => { setTimeout(() => this.refreshForCenter(), 250); },
      fail: () => {
        if (!_retry) { setTimeout(() => this.centerOnMe(initial, true), 700); return; }
        if (!initial) {
          wx.showToast({ title: this.data.lang === 'cn' ? '无法定位,请手动拖动地图' : 'Can’t locate — drag the map', icon: 'none' });
        }
        this.refreshForCenter();
      },
    });
  },
  locateMe() { this.setData({ selectedId: 'pin' }); this.centerOnMe(false); },

  confirm() {
    if (this.data.resolving && this.data.selectedId === 'pin') {
      wx.showToast({ title: this.data.lang === 'cn' ? '正在读取地址,请稍候' : 'Reading address — one moment', icon: 'none' });
      return;
    }
    if (!this._result || !this._result.address) {
      wx.showToast({ title: this.data.lang === 'cn' ? '请选择一个位置' : 'Pick a location', icon: 'none' });
      return;
    }
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (ch && typeof ch.emit === 'function') ch.emit('mapPicked', this._result);
    wx.navigateBack();
  },

  cancel() { wx.navigateBack(); },
});
