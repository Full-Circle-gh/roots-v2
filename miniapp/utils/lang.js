// Language preference. Resolution order on first launch:
//   1. user's explicit choice from /pages/me settings (stored as 'lang')
//   2. theme.language config from /api/retail/config (admin's default)
//   3. WeChat system language (zh_CN → cn, anything else → en)

const STORAGE_KEY = 'lang';

function detect() {
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    if (stored === 'en' || stored === 'cn') return stored;
  } catch {}
  try {
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    if ((info?.language || '').toLowerCase().startsWith('zh')) return 'cn';
  } catch {}
  return 'en';
}

function set(lang) {
  if (lang !== 'en' && lang !== 'cn') return;
  try { wx.setStorageSync(STORAGE_KEY, lang); } catch {}
  const app = getApp();
  if (app) app.globalData.lang = lang;
}

// Pick the right side of a bilingual {en, cn} pair, with fallback to the
// other language when the chosen one is empty.
function pick(en, cn, lang) {
  const a = (en || '').trim(), b = (cn || '').trim();
  if (lang === 'cn') return b || a;
  return a || b;
}

// Split a single mixed string like "Bakery 烘焙" into the language-specific
// side. Used for category names which are stored as one combined string
// in the categories table.
function splitMixed(s, lang) {
  const str = String(s || '');
  const m = str.match(/[一-鿿]/);
  if (!m) return str;
  const en = str.slice(0, m.index).trim();
  const cn = str.slice(m.index).trim();
  return lang === 'cn' ? (cn || en) : (en || cn);
}

module.exports = { detect, set, pick, splitMixed };
