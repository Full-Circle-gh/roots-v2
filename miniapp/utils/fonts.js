// Brand font loading. wx.loadFontFace fetches fonts from the Roots server
// at runtime and makes them available across the whole app (global: true).
// The download domain (rootskitchenchina.com) must be on the WeChat mp
// console's "downloadFile legal domain" whitelist or these fail silently.

const { BASE } = require('./api');

const FONTS = [
  { family: 'Bear Serif',    url: BASE + '/assets/fonts/BearSerif.otf'      },
  { family: 'Toni Grotesk',  url: BASE + '/assets/fonts/ToniGroteskPro.otf' },
  { family: 'League Gothic', url: BASE + '/assets/fonts/LeagueGothic.ttf'   },
  { family: 'Aleo',          url: BASE + '/assets/fonts/Aleo-Regular.otf'   },
  { family: 'DF Yuan',       url: BASE + '/assets/fonts/DFYuanW5.ttf', weight: '500' },
  { family: 'DF Yuan',       url: BASE + '/assets/fonts/DFYuanW7.ttf', weight: '700' },
  { family: 'DF Yuan',       url: BASE + '/assets/fonts/DFYuanW9.ttf', weight: '900' },
];

function loadOne(f) {
  return new Promise((resolve) => {
    wx.loadFontFace({
      family: f.family,
      source: 'url("' + f.url + '")',
      global: true,
      scopes: ['webview', 'native'],
      desc: { weight: f.weight || 'normal', style: 'normal' },
      success: () => {
        console.log('[font] ✓ loaded:', f.family, f.weight || '');
        resolve();
      },
      fail: (e) => {
        console.error('[font] ✗ failed:', f.family, f.weight || '', '·', e?.errMsg, '· url:', f.url);
        resolve();
      },
    });
  });
}

// Sequential, not parallel. iOS WeChat throttled 7 concurrent downloadFile
// calls during the first TLS handshake and all 7 failed with a generic
// "A network error occurred". Loading one at a time lets the first
// establish the connection that subsequent ones multiplex over.
async function loadAll() {
  for (const f of FONTS) {
    await loadOne(f);
  }
}

module.exports = { loadAll };
