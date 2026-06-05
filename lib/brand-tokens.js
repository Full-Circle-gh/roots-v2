// Canonical brand-colour tokens + colour helpers (server side).
//
// Single source of truth for the colour math the brand designer relies on.
// The mini-app keeps a MIRROR at miniapp/utils/brand-tokens.js because the
// WeChat bundler cannot reach this path; test/brand-tokens.sync.test.js
// asserts the two token tables stay identical so they never drift.

// token name -> hex. Mirrors the legacy COLOR_MAP previously inlined in
// block-renderer.js / theme.js / cms.html.
const TOKENS = {
  'lime-leaf':      '#CCD900', 'forest-kale':   '#365329', 'olive-moss':    '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn':   '#F2CA6C', 'oat-milk':      '#F2E7DF',
  'ink':            '#1a1a17', 'pink-guava':    '#F4B8CB', 'berry-punch':   '#E96174',
  'carrot-blaze':   '#FF6B0C', 'papaya-glow':   '#FFAF60', 'skyberry':      '#B2CFED',
  'lotus':          '#EEB8E4', 'citrus-zest':   '#E7E74C', 'pea-sprout':    '#7BBD3B',
  'white':          '#FFFFFF',
};

// Resolve a token (or pass through a raw #hex / rgb()/ named colour). Empty
// in -> empty out, so callers decide between "no colour" and a default.
function resolveColor(name) {
  if (!name) return '';
  return TOKENS[name] || name;
}

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function isHex(s) {
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(String(s || '').trim());
}

// Simple weighted brightness (0..255) — fast, used for the ink-vs-white
// label decision (mirrors block-renderer btnText()).
function luminance(hex) {
  const c = hexToRgb(resolveColor(hex));
  if (!c) return null;
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// Pick a readable label colour (ink vs white) for a given fill.
function btnText(bg) {
  const L = luminance(bg);
  if (L == null) return '#1a1a17';
  return L > 140 ? '#1a1a17' : '#FFFFFF';
}

// Proper WCAG relative luminance (0..1) for contrast-ratio checks.
function relLuminance(hex) {
  const c = hexToRgb(resolveColor(hex));
  if (!c) return null;
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

// WCAG contrast ratio between two colours (1..21). null if either unparseable.
function contrastRatio(a, b) {
  const la = relLuminance(a), lb = relLuminance(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { TOKENS, resolveColor, hexToRgb, isHex, luminance, btnText, relLuminance, contrastRatio };
