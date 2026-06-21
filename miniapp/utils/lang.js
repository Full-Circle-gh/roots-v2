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
  // Custom tab bar caches its labels per-language; nudge it so the
  // bottom bar updates without waiting for the next tab switch.
  try {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    const tb = page && page.getTabBar && page.getTabBar();
    if (tb && tb.refresh) tb.refresh();
  } catch {}
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

// Pick the language side of a bilingual variant label. The backend stores
// these as "EN · CN" (e.g. "Small · 小") using the " · " separator. Show only
// the side matching the mini-app language; fall back to the other side when
// empty, or to splitMixed() for older labels that lack the separator.
function pickLabel(raw, lang) {
  const str = String(raw || '').trim();
  if (!str) return '';
  const sep = str.indexOf(' · ');
  if (sep !== -1) {
    const en = str.slice(0, sep).trim();
    const cn = str.slice(sep + 3).trim();
    return lang === 'cn' ? (cn || en) : (en || cn);
  }
  return splitMixed(str, lang);
}

// Variant labels are now stored as two columns: `variant_label` (EN) and
// `variant_label_cn` (CN). Prefer the side matching the mini-app language;
// fall back to the other side when its column is empty. Each column may still
// hold a legacy glued "EN · CN" string, so we run it through pickLabel().
function pickVariantLabel(en, cn, lang) {
  const e = String(en || '').trim();
  const c = String(cn || '').trim();
  if (lang === 'cn') return pickLabel(c, lang) || pickLabel(e, lang);
  return pickLabel(e, lang) || pickLabel(c, lang);
}

// Localize a saved address's region to the active language. The server stores
// canonical Chinese in city/district plus English companions in
// city_en/district_en; show the matching side, falling back to the other when
// the companion is missing (foreign / freeform entries we couldn't translate).
function addrRegion(a, lang) {
  const o = a || {};
  const en = lang !== 'cn';
  return {
    city:     (en ? (o.city_en || o.city)         : (o.city || o.city_en))         || '',
    district: (en ? (o.district_en || o.district) : (o.district || o.district_en)) || '',
  };
}

module.exports = { detect, set, pick, splitMixed, pickLabel, pickVariantLabel, addrRegion };
