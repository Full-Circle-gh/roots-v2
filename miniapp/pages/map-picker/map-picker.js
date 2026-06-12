// In-app map picker — our own replacement for wx.chooseLocation, whose native
// list has an unreliable bare "Location" (current-position) entry that fails on
// some clients. Here the customer drags the map so the FIXED centre pin sits on
// their building, we reverse-geocode the pin's coordinates via
// /api/retail/reverse-geocode (Amap), and emit a chooseLocation-shaped result
// back to the opener (addresses / checkout) through the page event channel —
// so the opener's existing apply() consumes it unchanged.
//
// Why this is robust: MapContext.getCenterLocation() returns the map's centre
// coordinates with NO location permission at all — so even though
// wx.getLocation is rejected for this AppID, panning + confirming always works.
// show-location / moveToLocation (the blue dot + "locate me") are best-effort
// niceties layered on top; the core flow never depends on them.
const api = require('../../utils/api');

Page({
  data: {
    lat: 23.1351,      // default centre — Guangzhou / Tianhe (Roots' area)
    lng: 113.3607,
    scale: 16,
    lang: 'en',
    resolving: false,
    resolvedAddress: '',
  },

  onLoad(query) {
    let lang = 'en';
    try { lang = getApp().globalData.lang || 'en'; } catch (e) {}
    const patch = { lang };
    // Opener may pass a starting centre (e.g. the address being edited).
    const qLat = query && Number(query.lat);
    const qLng = query && Number(query.lng);
    if (qLat && qLng && isFinite(qLat) && isFinite(qLng)) { patch.lat = qLat; patch.lng = qLng; }
    this.setData(patch);
    this._result = null;
    this._t = null;
  },

  onReady() {
    this.mapCtx = wx.createMapContext('picker-map', this);
    // Open centred on the customer. moveToLocation() with no args jumps the map
    // to the current position via the <map> component's own location access —
    // this works with scope.userLocation even though the wx.getLocation API is
    // rejected for this AppID. Falls back to the default centre if it can't.
    setTimeout(() => this.centerOnMe(true), 200);
  },

  onUnload() { if (this._t) clearTimeout(this._t); },

  // Fires on every pan/zoom; only the 'end' of a move is worth resolving.
  onRegionChange(e) {
    if (e.type !== 'end') return;
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => this.resolveCenter(), 450);
  },

  // Read the map centre → reverse-geocode → show the address in the sheet.
  resolveCenter() {
    if (!this.mapCtx) return;
    this.mapCtx.getCenterLocation({
      success: (c) => {
        this.setData({ resolving: true });
        // api unwraps to the data payload on success, or throws on success:false
        // (no maps key / no result) — either way we end with a clean state.
        api.post('/api/retail/reverse-geocode', { lat: c.latitude, lng: c.longitude })
          .then((g) => {
            if (g && g.address) {
              this._result = {
                name: '',
                address: g.address,
                province: g.province || '',
                city: g.city || '',
                district: g.district || '',
                latitude: c.latitude,
                longitude: c.longitude,
              };
              this.setData({ resolving: false, resolvedAddress: g.address });
            } else {
              this._result = null;
              this.setData({ resolving: false, resolvedAddress: '' });
            }
          })
          .catch(() => {
            this._result = null;
            this.setData({ resolving: false, resolvedAddress: '' });
          });
      },
      fail: () => this.setData({ resolving: false }),
    });
  },

  // Locate-me button → recentre on the device, nudging the customer if it can't.
  locateMe() { this.centerOnMe(false); },

  // Recentre the map on the device location. `initial` = the on-open call (stay
  // silent on failure and just resolve the default centre); otherwise it's the
  // locate-me button (toast if it can't locate). wx.getLocation is rejected for
  // this AppID, so this leans on the <map> component's own location access; the
  // pan-to-confirm flow works regardless.
  centerOnMe(initial) {
    if (!this.mapCtx) return;
    this.mapCtx.moveToLocation({
      success: () => { setTimeout(() => this.resolveCenter(), 250); },
      fail: () => {
        if (!initial) {
          wx.showToast({
            title: this.data.lang === 'cn' ? '无法定位,请手动拖动地图' : 'Can’t locate — drag the map',
            icon: 'none',
          });
        }
        // Resolve whatever centre we're on so the sheet isn't blank.
        this.resolveCenter();
      },
    });
  },

  confirm() {
    if (this.data.resolving) {
      wx.showToast({ title: this.data.lang === 'cn' ? '正在读取地址,请稍候' : 'Reading address — one moment', icon: 'none' });
      return;
    }
    if (!this._result) {
      wx.showToast({ title: this.data.lang === 'cn' ? '无法读取此处地址,请微调图钉' : 'Can’t read this spot — nudge the pin', icon: 'none' });
      return;
    }
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (ch && typeof ch.emit === 'function') ch.emit('mapPicked', this._result);
    wx.navigateBack();
  },

  cancel() { wx.navigateBack(); },
});
