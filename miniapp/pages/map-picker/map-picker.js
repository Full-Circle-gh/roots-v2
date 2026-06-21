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
    // Open centred on the customer. The <map show-location> green dot is the
    // device's PRECISE fix (the map component is allowed it for this AppID even
    // though wx.getLocation is rejected); MapContext.moveToLocation() snaps the
    // centre to that dot. Give the map a beat to acquire the dot first. If it
    // isn't ready, fall back to a coarse getFuzzyLocation fix, then to a server
    // IP lookup. We use FUZZY not wx.getLocation because the precise-location
    // interface is rejected for this AppID; getFuzzyLocation is the approvable
    // one for "locate to fill a delivery address".
    setTimeout(() => this.locate(true), 600);
  },

  // Snap the map centre to the green dot (the map's own precise show-location
  // fix), then resolve the pin/POIs there. Falls back to the coarse fuzzy fix
  // (then server IP) when the dot isn't available yet. `_suppress` skips the
  // regionchange the programmatic move fires so we refresh on our own terms.
  locate(initial) {
    if (this.mapCtx && typeof this.mapCtx.moveToLocation === 'function') {
      this.mapCtx.moveToLocation({
        success: () => {
          this._suppress = true;
          this.setData({ selectedId: 'pin' });
          setTimeout(() => this.refreshForCenter(), 350);
        },
        fail: () => this.locateViaFuzzy(initial),
      });
      return;
    }
    this.locateViaFuzzy(initial);
  },

  // type:'gcj02' so the coords line up with the <map> component's coordinate
  // system (and could feed chooseLocation/openLocation directly).
  locateViaFuzzy(initial) {
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: (r) => {
        if (r && isFinite(r.latitude) && isFinite(r.longitude)) {
          this.recenterTo(r.latitude, r.longitude);
        } else {
          this.ipLocateFallback(initial);
        }
      },
      fail: () => this.ipLocateFallback(initial),
    });
  },

  // Move the map to a fix and resolve the pin's address (selection stays on the
  // centre pin so the customer drags the final spot). `_suppress` skips the
  // regionchange the programmatic move would otherwise trigger.
  recenterTo(lat, lng) {
    this._center = { lat, lng };
    this._suppress = true;
    this.setData({ selectedId: 'pin', lat, lng });
    setTimeout(() => this.refreshForCenter(), 300);
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

  // Coarse "where am I" from the server's IP geolocation — the fallback when
  // getFuzzyLocation is denied or its interface isn't enabled yet. Recenters on
  // the returned city centre (selection stays on the pin so the customer drags
  // the final spot). Toasts only on an explicit tap that yields nothing.
  ipLocateFallback(initial) {
    const toast = () => {
      if (!initial) wx.showToast({ title: this.data.lang === 'cn' ? '无法定位,请手动拖动地图' : 'Can’t locate — drag the map', icon: 'none' });
      this.refreshForCenter();
    };
    api.get('/api/retail/ip-locate')
      .then((g) => {
        if (g && isFinite(g.lat) && isFinite(g.lng)) this.recenterTo(g.lat, g.lng);
        else toast();
      })
      .catch(toast);
  },
  locateMe() { this.locate(false); },

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
