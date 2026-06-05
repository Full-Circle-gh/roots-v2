// Per-tenant brand THEME: schema, sanitiser, defaults, and the mappings
// that turn a theme into (a) storefront_config entries and (b) the CSS
// variable overrides the mini-app injects at each page root.
//
// A theme is the small, stable object the brand designer produces and the
// storefront consumes:
//   {
//     palette:  { primary, accent, surface, ink, muted },   // hex strings
//     fonts:    { display:{source,family,url?}, body:{source,family,url?} },
//     shape:    { radius:'sharp'|'subtle'|'rounded', energy:'refined'|'balanced'|'bold' },
//     density:  'compact'|'normal'|'airy',
//     audience: 'chinese'|'international'|'mixed'
//   }
//
// Stored as dotted storefront_config keys (theme.palette, theme.fonts, …),
// served to the mini-app through the existing /config channel. Nothing here
// references the model vendor.

const { isHex, resolveColor } = require('./brand-tokens');

const RADIUS  = new Set(['sharp', 'subtle', 'rounded']);
const ENERGY  = new Set(['refined', 'balanced', 'bold']);
const DENSITY = new Set(['compact', 'normal', 'airy']);
const AUDIENCE = new Set(['chinese', 'international', 'mixed']);
const FONT_SOURCE = new Set(['library', 'upload']);

// CJK fallback tail appended to any brand font so Chinese glyphs always
// resolve even when the brand face is Latin-only (mirrors app.wxss).
const CJK_TAIL = "'DF Yuan', 'PingFang SC', 'Hiragino Sans GB', -apple-system, sans-serif";

// The Roots defaults — a tenant with no saved theme renders exactly as today.
function defaultTheme() {
  return {
    palette: {
      primary: '#365329',  // forest
      accent:  '#CCD900',  // lime
      surface: '#F2E7DF',  // oat
      ink:     '#1a1a17',  // ink
      muted:   '#6A6E2D',  // olive
    },
    fonts: {
      display: { source: 'library', family: 'Bear Serif' },
      body:    { source: 'library', family: 'Aleo' },
    },
    shape:   { radius: 'subtle', energy: 'balanced' },
    density: 'normal',
    audience: 'mixed',
  };
}

const PALETTE_ROLES = ['primary', 'accent', 'surface', 'ink', 'muted'];

function cleanHex(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  if (isHex(s)) return s.startsWith('#') ? s : '#' + s;
  // allow rgb()/hsl()/named pass-through, else fallback
  if (/^(rgb|hsl)/i.test(s)) return s;
  return fallback;
}

function cleanFont(raw, fallback) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const source = FONT_SOURCE.has(r.source) ? r.source : 'library';
  const family = (typeof r.family === 'string' && r.family.trim()) ? r.family.trim().slice(0, 80) : fallback.family;
  const out = { source, family };
  // Upload source carries a self-hosted URL; keep only same-origin-ish https.
  if (source === 'upload' && typeof r.url === 'string' && /^https:\/\//i.test(r.url)) {
    out.url = r.url.slice(0, 400);
  }
  return out;
}

// Coerce arbitrary (model-emitted) input to a valid theme. Never throws.
function sanitizeTheme(raw) {
  const d = defaultTheme();
  const o = (raw && typeof raw === 'object') ? raw : {};
  const p = (o.palette && typeof o.palette === 'object') ? o.palette : {};
  const palette = {};
  for (const role of PALETTE_ROLES) palette[role] = cleanHex(p[role], d.palette[role]);

  const f = (o.fonts && typeof o.fonts === 'object') ? o.fonts : {};
  const fonts = {
    display: cleanFont(f.display, d.fonts.display),
    body:    cleanFont(f.body,    d.fonts.body),
  };

  const s = (o.shape && typeof o.shape === 'object') ? o.shape : {};
  const shape = {
    radius: RADIUS.has(s.radius) ? s.radius : d.shape.radius,
    energy: ENERGY.has(s.energy) ? s.energy : d.shape.energy,
  };

  return {
    palette,
    fonts,
    shape,
    density:  DENSITY.has(o.density)   ? o.density   : d.density,
    audience: AUDIENCE.has(o.audience) ? o.audience  : d.audience,
  };
}

// theme -> dotted storefront_config entries [ [key, value], … ].
function themeToConfigEntries(theme) {
  const t = sanitizeTheme(theme);
  return [
    ['theme.palette',  t.palette],
    ['theme.fonts',    t.fonts],
    ['theme.shape',    t.shape],
    ['theme.density',  t.density],
    ['theme.audience', t.audience],
  ];
}

// theme -> CSS-variable override string applied at a page root so the
// hardcoded app.wxss tokens adopt the tenant's brand. Only the CORE chrome
// vars are overridden here (page surface / text / primary / accent / muted +
// the two font stacks); rich per-block colour comes from each block's own
// fields. The mini-app mirror (miniapp/utils/theme.js) must match this map.
function themeToCssVars(theme) {
  const t = sanitizeTheme(theme);
  const fam = (font) => `'${String(font.family).replace(/'/g, '')}', ${CJK_TAIL}`;
  const pairs = [
    ['--oat',    t.palette.surface],
    ['--ink',    t.palette.ink],
    ['--forest', t.palette.primary],
    ['--lime',   t.palette.accent],
    ['--olive',  t.palette.muted],
    ['--f-bear', fam(t.fonts.display)],
    ['--f-aleo', fam(t.fonts.body)],
  ];
  return pairs.map(([k, v]) => `${k}:${v}`).join(';');
}

module.exports = {
  defaultTheme,
  sanitizeTheme,
  themeToConfigEntries,
  themeToCssVars,
  PALETTE_ROLES,
  CJK_TAIL,
};
