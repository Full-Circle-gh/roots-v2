// Ambient brand mascot — a chill skater pickle that drifts across every
// screen. It behaves like one continuous creature: its position + facing
// live on globalData, so moving between pages doesn't respawn it, it just
// keeps gliding from wherever it last was. All motion is pure WXSS (a slow
// reggae sway + breathing, plus the occasional wave / ollie / scoot) on a
// single image — no extra artwork needed. The whole layer is
// pointer-events:none, so the pickle never eats a tap.

// Screens where a wandering mascot would be noise, not delight — payment,
// first-run onboarding, and the embedded tracking webview. It goes away here.
const HIDE_ON = [
  'pages/checkout/checkout',
  'pages/alipay-pay/alipay-pay',
  'pages/topup/topup',
  'pages/onboarding/onboarding',
  'pages/track-webview/track-webview',
];

// On-screen sprite width in rpx. Converted to px against the live screen so
// the roam bounds always keep the pickle fully on-screen.
const SPRITE_RPX = 168;

Component({
  data: {
    show: false,
    x: 24,         // px from the layer's left edge
    y: 64,         // px lifted up from the resting baseline
    facing: 1,     // 1 faces right, -1 faces left (scaleX)
    mood: 'idle',  // idle | wave | hop | roll
    moveMs: 700,   // current glide duration (transition-duration)
  },

  lifetimes: {
    attached() {
      this._alive = true;

      let sys;
      try { sys = wx.getSystemInfoSync(); } catch { sys = {}; }
      this._W = sys.windowWidth || 375;
      this._H = sys.windowHeight || 700;
      this._sprite = (this._W * SPRITE_RPX) / 750;

      // User opt-out (default on), driven by the Me-page toggle through the
      // shared 'mascotEnabled' storage flag.
      this._enabled = this._readEnabled();
      if (!this._enabled || this._onHiddenPage()) return;

      const saved = this._restore();
      if (saved) {
        this.setData({ x: saved.x, y: saved.y, facing: saved.facing, mood: 'idle', moveMs: 700 });
      } else {
        this.setData({ x: this._clampX(this._W * 0.10), y: 64, moveMs: 700 });
      }
      this.setData({ show: true });
      this._next(1000);
    },

    detached() {
      this._alive = false;
      clearTimeout(this._t);
      this._persist();
    },
  },

  // React to the host page's visibility so we pause timers in the background
  // and snap back to the creature's global position when the page reappears.
  pageLifetimes: {
    show() {
      if (!this._alive) return;
      // Re-sync the opt-out each time the page surfaces, so flipping it off
      // on the Me page also clears mascots already attached to other tabs.
      this._enabled = this._readEnabled();
      if (!this._enabled || this._onHiddenPage()) { clearTimeout(this._t); this.setData({ show: false }); return; }
      const saved = this._restore();
      if (saved) this.setData({ x: saved.x, y: saved.y, facing: saved.facing, moveMs: 500 });
      this.setData({ show: true });
      this._next(1200);
    },
    hide() {
      clearTimeout(this._t);
      this._persist();
    },
  },

  methods: {
    _onHiddenPage() {
      try {
        const pages = getCurrentPages();
        return HIDE_ON.includes(pages[pages.length - 1].route);
      } catch { return false; }
    },

    _readEnabled() {
      try {
        const s = wx.getStorageSync('mascotEnabled');
        return s === '' || s === undefined ? true : !!s;
      } catch { return true; }
    },

    // Called by the Me-page toggle for an instant show/hide on the current
    // page (other pages pick the flag up from storage on their next show).
    applyEnabled(on) {
      this._enabled = !!on;
      try { wx.setStorageSync('mascotEnabled', !!on); } catch {}
      if (!on) { clearTimeout(this._t); this.setData({ show: false }); return; }
      if (this._onHiddenPage()) { this.setData({ show: false }); return; }
      const saved = this._restore();
      if (saved) this.setData({ x: saved.x, y: saved.y, facing: saved.facing, moveMs: 400 });
      this.setData({ show: true });
      this._next(600);
    },

    _clampX(x) {
      const max = this._W - this._sprite - 8;
      return Math.max(8, Math.min(x, max > 8 ? max : 8));
    },

    _restore() {
      try {
        const app = getApp();
        return (app && app.globalData && app.globalData.mascot) || null;
      } catch { return null; }
    },

    _persist() {
      try {
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.mascot = { x: this.data.x, y: this.data.y, facing: this.data.facing };
        }
      } catch {}
    },

    _next(delay) {
      clearTimeout(this._t);
      this._t = setTimeout(() => this._tick(), delay);
    },

    // Weighted, deliberately calm behaviour picker. Heavy bias toward drifting
    // and standing still so it reads as an ambient companion, not a fidget.
    _tick() {
      if (!this._alive) return;
      const r = Math.random();
      if (r < 0.46)      this._drift();
      else if (r < 0.70) this._rest();
      else if (r < 0.84) this._perform('wave', 1600);
      else if (r < 0.94) this._perform('hop', 880);
      else               this._scoot();
    },

    // Leisurely glide to a new resting spot somewhere in the lower band.
    _drift() {
      const tx = this._clampX(8 + Math.random() * (this._W - this._sprite - 16));
      const ty = 36 + Math.random() * 190;
      const facing = tx >= this.data.x ? 1 : -1;
      const dist = Math.abs(tx - this.data.x);
      const ms = Math.round(2800 + dist * 7 + Math.random() * 1600);
      this.setData({ x: tx, y: ty, facing, mood: 'idle', moveMs: ms });
      this._persist();
      this._next(ms + 700 + Math.random() * 2600);
    },

    _rest() {
      this.setData({ mood: 'idle' });
      this._next(2600 + Math.random() * 3400);
    },

    // Fire a one-shot pose (wave / hop), then settle back to idle.
    _perform(mood, dur) {
      this.setData({ mood });
      this._persist();
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        if (!this._alive) return;
        this.setData({ mood: 'idle' });
        this._next(900 + Math.random() * 2300);
      }, dur);
    },

    // A quick push on the board — short, fast horizontal dash with a lean.
    _scoot() {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const tx = this._clampX(this.data.x + dir * this._W * 0.30);
      this.setData({ x: tx, facing: dir, mood: 'roll', moveMs: 760 });
      this._persist();
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        if (!this._alive) return;
        this.setData({ mood: 'idle' });
        this._next(1300 + Math.random() * 2300);
      }, 980);
    },
  },
});
