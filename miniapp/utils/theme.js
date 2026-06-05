// Resolve the user-configured mini-app page background.
//
// Stored in storefront_config under the dotted key `theme.page_bg`, edited
// in /cms (Theme picker in the topbar). Values are brand-color tokens
// ('oat-milk', 'lime-leaf', etc.) that map to the palette shared with the
// CMS preview. An empty / missing value means "use the legacy oat default"
// — the page wxss already has `background: var(--oat)` so returning '' lets
// that fall through.

const PAGE_BG_PALETTE = {
  'lime-leaf':      '#CCD900',
  'forest-kale':    '#365329',
  'olive-moss':     '#6A6E2D',
  'roasted-almond': '#C37F4E',
  'golden-corn':    '#F2CA6C',
  'oat-milk':       '#F2E7DF',
  'ink':            '#1a1a17',
  'pink-guava':     '#F4B8CB',
  'berry-punch':    '#E96174',
  'carrot-blaze':   '#FF6B0C',
  'papaya-glow':    '#FFAF60',
  'skyberry':       '#B2CFED',
  'lotus':          '#EEB8E4',
  'citrus-zest':    '#E7E74C',
  'pea-sprout':     '#7BBD3B',
};

/**
 * Read the configured page background from app.globalData.config.
 * Returns either a CSS color string ('#F2E7DF', '#CCD900', …) or '' to
 * signal "no override — let the page wxss default win".
 */
function getPageBg(app) {
  const cfg = app?.globalData?.config || {};
  const token = cfg?.theme?.page_bg;
  if (!token) return '';
  // Explicit transparent passes through — caller binds it inline so the
  // page-wxss `background: var(--oat)` rule still wins. To actually clear
  // the bg you need this token. The WeChat window `backgroundColor`
  // (oat #F2E7DF from app.json) then becomes the visible base layer.
  if (token === 'transparent') return 'transparent';
  // Raw hex / rgb / named CSS colors pass through verbatim, in case
  // we extend the picker later to accept a custom hex.
  if (typeof token === 'string' && /^(#|rgb|hsl)/i.test(token)) return token;
  return PAGE_BG_PALETTE[token] || '';
}

// CJK fallback tail appended to a brand font so Chinese glyphs always resolve
// (mirror of lib/brand-theme CJK_TAIL + the stacks in app.wxss).
const CJK_TAIL = "'DF Yuan', 'PingFang SC', 'Hiragino Sans GB', -apple-system, sans-serif";

/**
 * Build the CSS-variable override string for a tenant's brand theme, bound at
 * a page root (`<view style="{{themeVars}}">`) so the hardcoded app.wxss
 * tokens adopt the brand colours + fonts. Mirror of
 * lib/brand-theme.themeToCssVars (server). Returns '' when no theme is set, so
 * un-themed tenants render byte-identically to today.
 *
 * Wire-up per page (reference: home):
 *   const { buildThemeVars } = require('../../utils/theme');
 *   this.setData({ themeVars: buildThemeVars(app.globalData.config) });
 *   // wxml:  <view class="page-root" style="{{themeVars}}"> … </view>
 */
function buildThemeVars(config) {
  const t = (config && config.theme) || {};
  const p = t.palette || {};
  const f = t.fonts || {};
  if (!p.primary && !p.surface && !p.ink && !f.display && !f.body) return '';
  const fam = (font) => (font && font.family) ? `'${String(font.family).replace(/'/g, '')}', ${CJK_TAIL}` : '';
  const pairs = [];
  const push = (k, v) => { if (v) pairs.push(k + ':' + v); };
  push('--oat',    p.surface);
  push('--ink',    p.ink);
  push('--forest', p.primary);
  push('--lime',   p.accent);
  push('--olive',  p.muted);
  push('--f-bear', fam(f.display));
  push('--f-aleo', fam(f.body));
  return pairs.join(';');
}

module.exports = { getPageBg, PAGE_BG_PALETTE, buildThemeVars };
