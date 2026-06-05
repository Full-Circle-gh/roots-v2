// Brand-colour tokens + helpers for the mini-app.
//
// MIRROR of lib/brand-tokens.js (server). The WeChat bundler cannot reach the
// server /lib path, so this is an intentional copy; test/brand.test.js asserts
// the TOKENS table here is byte-identical to the server's so they never drift.
// (New mini-app code should require THIS; block-renderer.js still has its own
// inline COLOR_MAP — refactoring it to use this is a verified follow-up.)

const TOKENS = {
  'lime-leaf':      '#CCD900', 'forest-kale':   '#365329', 'olive-moss':    '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn':   '#F2CA6C', 'oat-milk':      '#F2E7DF',
  'ink':            '#1a1a17', 'pink-guava':    '#F4B8CB', 'berry-punch':   '#E96174',
  'carrot-blaze':   '#FF6B0C', 'papaya-glow':   '#FFAF60', 'skyberry':      '#B2CFED',
  'lotus':          '#EEB8E4', 'citrus-zest':   '#E7E74C', 'pea-sprout':    '#7BBD3B',
  'white':          '#FFFFFF',
};

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

// ink-vs-white auto label by brightness (mirror of server btnText()).
function btnText(bg) {
  const c = hexToRgb(resolveColor(bg));
  if (!c) return '#1a1a17';
  const L = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return L > 140 ? '#1a1a17' : '#FFFFFF';
}

module.exports = { TOKENS, resolveColor, hexToRgb, btnText };
