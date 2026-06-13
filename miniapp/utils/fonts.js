// Brand font loading. wx.loadFontFace makes the Roots brand fonts available
// across the whole app (global: true).
//
// FOUT fix — local caching:
//   On the very first launch the fonts are fetched from the Roots server, but
//   each file is ALSO saved into the mini-app's user-data dir. Every launch
//   after that loads the font straight from that local file, which is near-
//   instant — so the "wrong font while loading → right font once loaded" flash
//   only ever happens on the first run, not on every open.
//
// The download domain (rootskitchenchina.com) must be on the WeChat mp
// console's "downloadFile legal domain" whitelist or the first fetch fails
// silently (and nothing gets cached).

const { BASE } = require('./api');

// Bump this whenever a font FILE changes so stale cached copies are dropped.
const CACHE_VERSION = 1;

const FONTS = [
  { family: 'Bear Serif',    file: 'BearSerif.otf'      },
  // Bear Serif's digits are thin/geometric — Lilita One is the chunky
  // numeral pair. Loaded under its own family so the unicode-range @font-face
  // in app.wxss can pick it up for digits + currency symbols.
  { family: 'Lilita One',    file: 'LilitaOne.ttf'      },
  { family: 'Toni Grotesk',  file: 'ToniGroteskPro.otf' },
  { family: 'League Gothic', file: 'LeagueGothic.ttf'   },
  { family: 'Aleo',          file: 'Aleo-Regular.otf'   },
  { family: 'DF Yuan',       file: 'DFYuanW5.ttf', weight: '500' },
  { family: 'DF Yuan',       file: 'DFYuanW7.ttf', weight: '700' },
  { family: 'DF Yuan',       file: 'DFYuanW9.ttf', weight: '900' },
].map((f) => ({ ...f, url: BASE + '/assets/fonts/' + f.file }));

const fs = wx.getFileSystemManager();
const CACHE_DIR = `${wx.env.USER_DATA_PATH}/fonts-v${CACHE_VERSION}`;

// Ensure the version-stamped cache dir exists (and prune older versions so
// bumped fonts don't leave dead files behind on the device).
function ensureCacheDir() {
  try { fs.accessSync(CACHE_DIR); return; } catch {}
  // Drop any previous fonts-v* dirs before recreating the current one.
  try {
    const entries = fs.readdirSync(wx.env.USER_DATA_PATH);
    entries.filter((n) => /^fonts-v\d+$/.test(n)).forEach((n) => {
      try { fs.rmdirSync(`${wx.env.USER_DATA_PATH}/${n}`, true); } catch {}
    });
  } catch {}
  try { fs.mkdirSync(CACHE_DIR, true); } catch {}
}

function localPathFor(f) {
  return `${CACHE_DIR}/${f.file}`;
}

function cachedExists(path) {
  try { fs.accessSync(path); return true; } catch { return false; }
}

// Load the font from a given source ('url("...")'); resolves either way.
function loadFromSource(f, source, origin) {
  return new Promise((resolve) => {
    wx.loadFontFace({
      family: f.family,
      source,
      global: true,
      scopes: ['webview', 'native'],
      desc: { weight: f.weight || 'normal', style: 'normal' },
      success: () => {
        console.log('[font] ✓ loaded:', f.family, f.weight || '', '·', origin);
        resolve(true);
      },
      fail: (e) => {
        console.error('[font] ✗ failed:', f.family, f.weight || '', '·', origin, '·', e?.errMsg);
        resolve(false);
      },
    });
  });
}

// Download the font to the local cache for next launch. Fire-and-forget.
function cacheToLocal(f) {
  const dest = localPathFor(f);
  wx.downloadFile({
    url: f.url,
    success: (res) => {
      if (res.statusCode !== 200 || !res.tempFilePath) return;
      try {
        fs.saveFileSync(res.tempFilePath, dest);
        console.log('[font] ⤓ cached:', f.family, f.weight || '');
      } catch (e) {
        console.warn('[font] cache-save failed:', f.family, '·', e?.message);
      }
    },
    fail: (e) => console.warn('[font] cache-download failed:', f.family, '·', e?.errMsg),
  });
}

async function loadOne(f) {
  const local = localPathFor(f);
  if (cachedExists(local)) {
    // Fast path — load straight from disk, no network, no flash.
    const ok = await loadFromSource(f, `url("${local}")`, 'cache');
    if (ok) return;
    // Cached file was corrupt/unreadable — drop it and fall back to network.
    try { fs.unlinkSync(local); } catch {}
  }
  // First launch (or cache miss): load over the network so THIS session still
  // gets the brand font, then save a copy so the next launch is instant.
  await loadFromSource(f, `url("${f.url}")`, 'network');
  cacheToLocal(f);
}

// Sequential, not parallel. iOS WeChat throttled 7 concurrent downloadFile
// calls during the first TLS handshake and all 7 failed with a generic
// "A network error occurred". Loading one at a time lets the first
// establish the connection that subsequent ones multiplex over.
//
// onPrimary fires once the Latin display fonts (Bear Serif / Lilita One / Toni
// Grotesk / League Gothic / Aleo — the first five, listed before DF Yuan) have
// loaded. Those drive the wordmark + headings, so the home page reveals brand
// text as soon as THEY land instead of waiting on the much larger CJK weights.
async function loadAll(onPrimary) {
  ensureCacheDir();
  const primaryCount = FONTS.filter((f) => f.family !== 'DF Yuan').length;
  let loaded = 0;
  for (const f of FONTS) {
    await loadOne(f);
    if (++loaded === primaryCount && typeof onPrimary === 'function') {
      try { onPrimary(); } catch {}
    }
  }
}

module.exports = { loadAll };
