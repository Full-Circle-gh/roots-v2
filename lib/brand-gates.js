// Deterministic design-quality gates, run on generated output BEFORE it is
// previewed or applied. Pure functions, no model calls. Three families:
//   1. Accessibility    — body text vs surface contrast (WCAG AA)
//   2. Palette discipline — limited distinct colours; system over chaos
//   3. Cultural safety  — conservative, audience-aware China-market advisories
//
// runGates() -> { ok, errors, warnings, findings }. `errors` should block a
// publish or trigger a repair pass; `warnings` are advisory (surfaced to the
// operator, never fatal).

const { contrastRatio, resolveColor, hexToRgb, btnText } = require('./brand-tokens');
const { sanitizeTheme } = require('./brand-theme');

const AA_NORMAL = 4.5;  // WCAG AA, normal text
const AA_LARGE  = 3.0;  // WCAG AA, large/bold text

function accessibilityChecks(theme) {
  const t = sanitizeTheme(theme);
  const out = [];
  const rBody = contrastRatio(t.palette.ink, t.palette.surface);
  if (rBody != null && rBody < AA_NORMAL) {
    out.push({
      level: rBody < AA_LARGE ? 'error' : 'warning',
      code: 'contrast_body',
      msg: `Body text vs background contrast is ${rBody.toFixed(2)}:1 (needs ${AA_NORMAL}:1).`,
      fields: ['palette.ink', 'palette.surface'],
    });
  }
  const rPrimary = contrastRatio(btnText(t.palette.primary), t.palette.primary);
  if (rPrimary != null && rPrimary < AA_LARGE) {
    out.push({
      level: 'warning', code: 'contrast_primary_label',
      msg: `Text on the primary colour is low-contrast (${rPrimary.toFixed(2)}:1).`,
      fields: ['palette.primary'],
    });
  }
  return out;
}

// Distinct colours used across block colour fields -> Map(hex -> count).
const COLOR_FIELD_RE = /(_color$|^bg$|^fg$|color)/i;
function collectBlockColors(blocks) {
  const seen = new Map();
  const walk = (v) => {
    if (!v || typeof v === 'string') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && COLOR_FIELD_RE.test(k) && val.trim()) {
          const hex = resolveColor(val).toLowerCase();
          if (/^#?[0-9a-f]{3,6}$/.test(hex)) seen.set(hex, (seen.get(hex) || 0) + 1);
        } else {
          walk(val);
        }
      }
    }
  };
  (blocks || []).forEach(walk);
  return seen;
}

function paletteDisciplineChecks(theme, blocks) {
  const out = [];
  const distinct = collectBlockColors(blocks).size;
  if (distinct > 10) {
    out.push({
      level: 'warning', code: 'too_many_colors',
      msg: `${distinct} distinct colours across blocks — consolidate toward the brand palette for a cleaner system.`,
    });
  }
  return out;
}

// Very low chroma (near-greyscale) test.
function isGreyish(hex) {
  const c = hexToRgb(resolveColor(hex));
  if (!c) return false;
  return (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) < 16;
}

// Conservative China-market advisories. STARTER ruleset (warnings only) to
// refine with the operator — cultural reads are nuanced + audience-dependent.
function culturalSafetyChecks(theme) {
  const t = sanitizeTheme(theme);
  const out = [];
  if (t.audience === 'chinese' || t.audience === 'mixed') {
    if (isGreyish(t.palette.accent) && isGreyish(t.palette.primary)) {
      out.push({
        level: 'warning', code: 'cn_monochrome',
        msg: 'Fully monochrome palette can read sombre/funereal to Chinese shoppers — consider one warm accent.',
      });
    }
  }
  return out;
}

function runGates(theme, blocks, _opts = {}) {
  const findings = [
    ...accessibilityChecks(theme),
    ...paletteDisciplineChecks(theme, blocks),
    ...culturalSafetyChecks(theme),
  ];
  const errors = findings.filter(f => f.level === 'error');
  const warnings = findings.filter(f => f.level === 'warning');
  return { ok: errors.length === 0, errors, warnings, findings };
}

module.exports = {
  runGates,
  accessibilityChecks,
  paletteDisciplineChecks,
  culturalSafetyChecks,
  collectBlockColors,
  isGreyish,
};
