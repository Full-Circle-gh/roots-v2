// Lightweight, fire-and-forget visit tracking for the mini app.
// Posts to the backend's POST /api/retail/track, which writes a
// retail_visits row that powers the dashboard's traffic + conversion
// metrics. Design rules:
//   • Never throws and never blocks the UI — analytics must be invisible.
//   • One session id per app launch (module-level, regenerated only when
//     the JS VM restarts, i.e. a cold relaunch). Groups multiple foregrounds
//     within a single launch so we can count sessions vs. raw opens.
//   • The Bearer token (when logged in) is attached by utils/api itself, so
//     the backend attributes the visit to a customer automatically.

const api = require('./api');

let sessionId = '';
let scene = null;

function getSession() {
  if (!sessionId) {
    sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  return sessionId;
}

// WeChat passes a numeric launch-scene code (how the user entered: scan,
// share, ad, etc.) on onLaunch/onShow. Stored once and sent with each event.
function setScene(s) {
  if (typeof s === 'number' && !Number.isNaN(s)) scene = s;
}

function track(page, extra = {}) {
  try {
    const payload = { session_id: getSession(), page: page || '' };
    if (scene != null) payload.scene = scene;
    Object.assign(payload, extra);
    api.post('/api/retail/track', payload).catch(() => {});
  } catch (e) {
    // Intentionally silent.
  }
}

module.exports = { track, setScene, getSession };
