// Brand font loading. wx.loadFontFace makes the Roots brand fonts available
// across the whole app (global: true).
//
// FOUT fix — local caching:
//   On the very first launch each font is downloaded once into the mini-app's
//   user-data dir and the face is loaded off that local copy. Every launch
//   after that skips the network entirely, which is near-instant — so the
//   "wrong font while loading → right font once loaded" flash only ever
//   happens on the first run, not on every open.
//
//   Download once, not twice. This used to loadFontFace straight off the URL
//   and then fire a SEPARATE wx.downloadFile to populate the cache, so a cold
//   launch pulled all 9.4MB twice — and because the cache copy was
//   fire-and-forget it raced the sequential chain below, stealing bandwidth
//   from the very fetch the next font was waiting on. Downloading first and
//   loading off the file halves cold-launch bytes and keeps the chain serial.
//   Loading off the URL survives as the fallback when a download fails.
//
// The download domain (rootskitchenchina.com) must be on the WeChat mp
// console's "downloadFile legal domain" whitelist or the first fetch fails
// silently (and nothing gets cached).

const { BASE } = require('./api');

// Bump this whenever a font FILE changes so stale cached copies are dropped.
const CACHE_VERSION = 1;

// Order matters: the list is walked one file at a time (see loadAll), so every
// font waits on the bytes of the ones before it. Cheapest-useful-first, with
// the one heavyweight last of the Latin faces:
//
//   Bear Serif      47KB   headlines + the wordmark — the most visible face,
//                          so it leads despite not being the smallest
//   Lilita One      26KB
//   League Gothic   44KB
//   Aleo            71KB   body copy
//   Toni Grotesk   280KB   6x its neighbours; kickers, labels, buttons
//
// Toni Grotesk sat third and the two small faces behind it inherited its whole
// 280KB wait: League Gothic used to land 397KB in and Aleo 468KB in, against
// 117KB and 188KB now. It pays for that by arriving last itself (353KB → 468KB)
// — the right trade, since it buys three faces an earlier arrival and costs one
// a later one. On a page that reads the label before the font lands, the label
// must not reflow when it does: .add-label is white-space: nowrap for that.
const FONTS = [
  { family: 'Bear Serif',    file: 'BearSerif.otf'      },
  // Bear Serif's digits are thin/geometric — Lilita One is the chunky
  // numeral pair. Loaded under its own family so the unicode-range @font-face
  // in app.wxss can pick it up for digits + currency symbols.
  { family: 'Lilita One',    file: 'LilitaOne.ttf'      },
  { family: 'League Gothic', file: 'LeagueGothic.ttf'   },
  { family: 'Aleo',          file: 'Aleo-Regular.otf'   },
  { family: 'Toni Grotesk',  file: 'ToniGroteskPro.otf' },
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

// Fetch the font into the local cache. Resolves to the saved path, or null if
// the download or the save failed — callers fall back to the network URL.
// Awaited, not fire-and-forget: a background copy would race the sequential
// chain in loadAll for bandwidth.
function downloadToCache(f) {
  return new Promise((resolve) => {
    wx.downloadFile({
      url: f.url,
      success: (res) => {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          console.warn('[font] cache-download bad status:', f.family, '·', res.statusCode);
          return resolve(null);
        }
        try {
          const dest = fs.saveFileSync(res.tempFilePath, localPathFor(f));
          console.log('[font] ⤓ cached:', f.family, f.weight || '');
          resolve(dest || localPathFor(f));
        } catch (e) {
          console.warn('[font] cache-save failed:', f.family, '·', e?.message);
          resolve(null);
        }
      },
      fail: (e) => {
        console.warn('[font] cache-download failed:', f.family, '·', e?.errMsg);
        resolve(null);
      },
    });
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
  // First launch (or cache miss): pull the file down once, then load the face
  // off that copy — THIS session gets the brand font and the next launch is
  // instant, for one download instead of two.
  const saved = await downloadToCache(f);
  if (saved) {
    const ok = await loadFromSource(f, `url("${saved}")`, 'download');
    if (ok) return;
    // Downloaded bytes won't parse — bin them so the next launch refetches
    // rather than re-reading a file we already know is bad.
    try { fs.unlinkSync(saved); } catch {}
  }
  // Download blocked/failed, or the file it produced was unusable: load
  // straight off the URL so a brand font still lands this session.
  await loadFromSource(f, `url("${f.url}")`, 'network');
}

// Sequential, not parallel. iOS WeChat throttled 7 concurrent downloadFile
// calls during the first TLS handshake and all 7 failed with a generic
// "A network error occurred". Loading one at a time lets the first
// establish the connection that subsequent ones multiplex over.
//
// onPrimary fires once the Latin display fonts (Bear Serif / Lilita One /
// League Gothic / Aleo / Toni Grotesk — the first five, listed before DF Yuan)
// have loaded. Those drive the wordmark + headings, so the home page reveals
// brand text as soon as THEY land instead of waiting on the much larger CJK
// weights. Reordering within the five doesn't move this — it still waits on all
// 468KB — but it does move when each INDIVIDUAL face starts rendering, which is
// what the ungated pages (product, checkout, me) show.
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
