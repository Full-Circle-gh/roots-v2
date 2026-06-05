// AI Brand Studio — pure-logic test suite (no model calls, no browser).
// Run: node scripts/test_brand.js   → exits non-zero on any failure.

const assert = require('assert');

const tokensSrv  = require('../lib/brand-tokens');
const tokensMini = require('../miniapp/utils/brand-tokens');
const brandTheme = require('../lib/brand-theme');
const gates      = require('../lib/brand-gates');
const designer   = require('../lib/brand-designer');
const themeMini  = require('../miniapp/utils/theme');
const gateway    = require('../lib/model-gateway');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  -', name); }
  catch (e) { console.error('  FAIL-', name, '\n       ', e.message); process.exitCode = 1; }
}

console.log('AI Brand Studio tests\n');

// ── token sync (server <-> mini-app) ──────────────────────────────────
test('server and mini-app TOKENS are byte-identical', () => {
  assert.deepStrictEqual(tokensSrv.TOKENS, tokensMini.TOKENS);
});

// ── CSS-var generators agree (server <-> mini-app) ────────────────────
test('themeToCssVars (server) === buildThemeVars (mini-app) for default theme', () => {
  const theme = brandTheme.defaultTheme();
  const srv  = brandTheme.themeToCssVars(theme);
  const mini = themeMini.buildThemeVars({ theme });
  assert.strictEqual(srv, mini);
});

test('buildThemeVars returns "" when no theme is set (un-themed tenants unchanged)', () => {
  assert.strictEqual(themeMini.buildThemeVars({}), '');
  assert.strictEqual(themeMini.buildThemeVars({ theme: {} }), '');
});

// ── contrast math ─────────────────────────────────────────────────────
test('contrast ink/oat is high, white/white is ~1', () => {
  assert.ok(tokensSrv.contrastRatio('#1a1a17', '#F2E7DF') > 10);
  assert.ok(tokensSrv.contrastRatio('#FFFFFF', '#FFFFFF') < 1.05);
});

// ── theme sanitiser ───────────────────────────────────────────────────
test('sanitizeTheme repairs bad input and fills defaults', () => {
  const s = brandTheme.sanitizeTheme({ palette: { primary: '2B5F3A', accent: 'nope' }, shape: { radius: 'wild' }, audience: 'mars' });
  assert.strictEqual(s.palette.primary, '#2B5F3A');     // # prepended
  assert.strictEqual(s.palette.accent, '#CCD900');       // invalid -> default
  assert.strictEqual(s.shape.radius, 'subtle');          // invalid enum -> default
  assert.strictEqual(s.audience, 'mixed');               // invalid enum -> default
});

test('themeToConfigEntries emits the five dotted theme.* keys', () => {
  const keys = brandTheme.themeToConfigEntries(brandTheme.defaultTheme()).map(e => e[0]);
  assert.deepStrictEqual(keys, ['theme.palette', 'theme.fonts', 'theme.shape', 'theme.density', 'theme.audience']);
});

// ── gates ─────────────────────────────────────────────────────────────
test('default theme passes all gates', () => {
  assert.strictEqual(gates.runGates(brandTheme.defaultTheme(), []).ok, true);
});

test('low body contrast is an error', () => {
  const t = brandTheme.defaultTheme(); t.palette.ink = '#EEEEEE'; t.palette.surface = '#FFFFFF';
  const r = gates.runGates(t, []);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'contrast_body'));
});

test('monochrome CN palette raises an advisory warning', () => {
  const t = brandTheme.defaultTheme(); t.palette.primary = '#333333'; t.palette.accent = '#888888'; t.audience = 'chinese';
  assert.ok(gates.runGates(t, []).warnings.some(w => w.code === 'cn_monochrome'));
});

// ── designer engine (pure parts) ──────────────────────────────────────
test('sanitizeLayout drops invalid types and unsafe strings, assigns ids', () => {
  const lay = designer.sanitizeLayout([
    { type: 'hero_banner', headline_en: 'Hi' },
    { type: 'NOT_REAL' },
    { type: 'spacer', x: 'javascript:alert(1)' },
    { type: 'product_grid', bg_color: '#fff' },
  ]);
  assert.deepStrictEqual(lay.map(b => b.type), ['hero_banner', 'product_grid']);
  assert.ok(lay.every(b => typeof b.id === 'string' && b.id));
});

test('composeBrief clamps and normalises inputs', () => {
  const b = designer.composeBrief({ audience: 'mars', words: ['A', 1, 'B'], language: 'klingon' });
  assert.strictEqual(b.audience, 'mixed');
  assert.deepStrictEqual(b.words, ['A', 'B']);
  assert.strictEqual(b.language, 'bilingual');
});

test('design tool exposes the curated block enum', () => {
  const tool = designer.buildDesignTool();
  assert.strictEqual(tool.name, 'emit_brand_design');
  assert.ok(tool.input_schema.properties.layout.items.properties.type.enum.length >= 12);
});

// ── white-label hygiene ───────────────────────────────────────────────
test('gateway.clientSafe strips usage/provider/raw/_detail', () => {
  const safe = gateway.clientSafe({ theme: {}, usage: { input_tokens: 9 }, provider: 'x', raw: {}, _detail: 'secret' });
  assert.deepStrictEqual(Object.keys(safe), ['theme']);
});

test('friendlyError messages never name a vendor', () => {
  for (const code of ['not_configured', 'empty', 'whatever']) {
    const m = designer.friendlyError(code).toLowerCase();
    assert.ok(!/anthropic|claude|openai|gpt|deepseek/.test(m), 'leaked vendor in: ' + m);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ', all green'}.`);
