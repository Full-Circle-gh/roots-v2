// Mini-app self-diagnostics — fire-and-forget, posts to the backend's
// POST /api/retail/client-log so support can SEE what happened on a
// customer's device when they report a problem, instead of guessing.
//
// Design rules (same as utils/track):
//   • Never throws and never blocks the UI — diagnostics must be invisible.
//   • One device/version snapshot per launch ('session'), plus one row per
//     caught error ('error'). Both carry the device + app-version snapshot.
//   • Errors are de-duped + throttled client-side so a render loop that
//     throws every frame can't spam the network (or the table).
//   • The Bearer token (when logged in) is attached by utils/api, so the
//     backend attributes the log to the customer automatically.

const api = require('./api');

// Device + version snapshot. Cached for the app's lifetime — none of these
// change mid-session. Built defensively: every WeChat getter is wrapped so a
// missing API on an old base library never throws.
let _snap = null;
function snapshot() {
  if (_snap) return _snap;
  const s = {};
  // System / device. getDeviceInfo + getAppBaseInfo are the modern split;
  // getSystemInfoSync is the universal fallback that still returns all of it.
  let sys = {};
  try { sys = wx.getSystemInfoSync() || {}; } catch (e) {}
  let dev = {};
  try { dev = (wx.getDeviceInfo && wx.getDeviceInfo()) || {}; } catch (e) {}
  let appBase = {};
  try { appBase = (wx.getAppBaseInfo && wx.getAppBaseInfo()) || {}; } catch (e) {}

  s.device_model = dev.model || sys.model || null;
  s.platform     = dev.platform || sys.platform || null;          // 'ios' | 'android' | 'devtools'
  s.system       = dev.system || sys.system || null;              // OS version, e.g. 'iOS 17.4'
  s.wx_version   = appBase.version || sys.version || null;        // WeChat client version
  s.lib_version  = appBase.SDKVersion || sys.SDKVersion || null;  // base-library version

  // Mini-app version: envVersion ('develop'|'trial'|'release') + the published
  // version string, so support can tell a customer on an OLD release apart
  // from one on the current build.
  try {
    const mp = wx.getAccountInfoSync().miniProgram || {};
    s.app_version = [mp.envVersion, mp.version].filter(Boolean).join(' ') || null;
  } catch (e) { s.app_version = null; }

  _snap = s;
  return s;
}

// Current in-app route, e.g. 'pages/checkout/checkout'. Best-effort.
function currentPage() {
  try {
    const pages = getCurrentPages();
    const top = pages && pages[pages.length - 1];
    return top ? top.route : null;
  } catch (e) { return null; }
}

let _scene = null;
function setScene(s) { if (typeof s === 'number' && !Number.isNaN(s)) _scene = s; }

function send(payload) {
  try {
    const body = Object.assign({}, snapshot(), payload);
    if (_scene != null) body.scene = _scene;
    api.post('/api/retail/client-log', body).catch(() => {});
  } catch (e) { /* intentionally silent */ }
}

// One snapshot per launch — answers "what app version / phone is this
// customer on?" even when nothing ever crashes (the common support case).
let _sessionSent = false;
function reportSession() {
  if (_sessionSent) return;
  _sessionSent = true;
  send({ kind: 'session', page: currentPage() });
}

// Client-side error throttle: drop a repeat of the same message within 30s,
// and cap total error posts per launch so a tight throw-loop can't flood.
const _recentErr = new Map();   // message → last-sent ms
let _errCount = 0;
const _ERR_MAX_PER_LAUNCH = 20;
const _ERR_DEDUP_MS = 30 * 1000;

function reportError(message, stack, extra) {
  try {
    const msg = String(message == null ? '' : message).slice(0, 500) || 'unknown_error';
    const now = Date.now();
    const last = _recentErr.get(msg);
    if (last && now - last < _ERR_DEDUP_MS) return;   // same error, too soon
    if (_errCount >= _ERR_MAX_PER_LAUNCH) return;     // launch budget spent
    _recentErr.set(msg, now);
    _errCount++;
    send({
      kind: 'error',
      page: currentPage(),
      message: msg,
      stack: stack != null ? String(stack).slice(0, 4000) : null,
      extra: extra != null ? extra : undefined,
    });
  } catch (e) { /* intentionally silent */ }
}

module.exports = { reportSession, reportError, setScene, snapshot };
