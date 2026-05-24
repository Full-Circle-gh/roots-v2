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

module.exports = { getPageBg, PAGE_BG_PALETTE };
