// SKU token templates — the pure half of automatic SKU generation.
//
// A tenant writes a PATTERN in Settings → SKU codes, e.g. `B-{SUB}{SEQ:4}`, and
// this file turns it into a code. Nothing here touches the database, reads a
// counter, or knows what a material is: it parses, validates, renders and
// describes. lib/sku-rules.js is the half that resolves which pattern applies,
// claims the running number and guarantees the result is free.
//
// WHY A TEMPLATE AND NOT A FIXED SHAPE. Every tenant already numbers its own
// catalogue, and the shapes genuinely differ — a letter per category
// (B0001), a two-part code (FD-DF-0001), a year in the middle (24-B-001).
// Baking one shape in would have meant a second shape as soon as the second
// tenant asked, so the shape is data.
//
// TOKENS. Case-sensitive, always uppercase, always braced. Anything outside a
// brace is a literal and passes through untouched — that is how `-`, `/` and a
// fixed prefix are written.
//
//   {CAT}        the category's code      — the code set on the category rule
//   {SUB}        the subcategory's code   — the code set on the subcategory rule
//   {SEQ}        the running number, 4 digits by default
//   {SEQ:n}      the running number padded to n digits (1–9); {SEQ:0} = unpadded
//   {YY} {YYYY}  year of creation, 2 or 4 digits
//   {MM} {DD}    month / day of creation, 2 digits
//   {NAME:n}     first n letters of the English name, A–Z only, uppercased
//
// A pattern with no {SEQ} is legal but dangerous — every material in the scope
// renders the same string — so validate() returns it as a WARNING rather than
// an error, and lib/sku-rules.js's uniqueness retry is what actually stops the
// collision from being written.

'use strict';

// One entry per token. `re` matches the whole braced form including any
// argument; `render` receives (ctx, arg) and returns the substitution.
// Registered here and nowhere else — the settings screen builds its token
// palette from TOKENS, so a token added here shows up in the UI for free.
const TOKENS = [
  {
    name: 'CAT',
    re: /^CAT$/,
    label: ['Category code', '主分类代码'],
    hint: ['The code you set on the category — e.g. F for Food.', '在主分类上设置的代码 — 例如 食品 = F。'],
    render: ctx => up(ctx.categoryCode),
  },
  {
    name: 'SUB',
    re: /^SUB$/,
    label: ['Subcategory code', '子分类代码'],
    hint: ['The code you set on the subcategory — e.g. B for Dried fruits.', '在子分类上设置的代码 — 例如 干果 = B。'],
    render: ctx => up(ctx.subcategoryCode),
  },
  {
    name: 'SEQ',
    re: /^SEQ(?::(\d))?$/,
    label: ['Number', '流水号'],
    hint: ['The running number. {SEQ:4} pads to 0001; {SEQ:0} does not pad.', '流水号。{SEQ:4} 补零为 0001;{SEQ:0} 不补零。'],
    render: (ctx, arg) => {
      const n = Number(ctx.seq) || 0;
      const width = arg === undefined ? 4 : Number(arg);
      return width > 0 ? String(n).padStart(width, '0') : String(n);
    },
  },
  { name: 'YYYY', re: /^YYYY$/, label: ['Year (4)', '年份(4位)'], hint: ['2026', '2026'], render: ctx => String(ctx.date.getFullYear()) },
  { name: 'YY',   re: /^YY$/,   label: ['Year (2)', '年份(2位)'], hint: ['26', '26'],     render: ctx => String(ctx.date.getFullYear()).slice(-2) },
  { name: 'MM',   re: /^MM$/,   label: ['Month', '月份'],        hint: ['09', '09'],      render: ctx => pad2(ctx.date.getMonth() + 1) },
  { name: 'DD',   re: /^DD$/,   label: ['Day', '日期'],          hint: ['04', '04'],      render: ctx => pad2(ctx.date.getDate()) },
  {
    name: 'NAME',
    re: /^NAME(?::(\d))?$/,
    label: ['Name letters', '名称字母'],
    hint: ['First letters of the English name — {NAME:3} of "Dried Mango" is DRI.', '英文名称的首字母 — “Dried Mango” 的 {NAME:3} 为 DRI。'],
    render: (ctx, arg) => {
      const n = arg === undefined ? 3 : Number(arg);
      const letters = String(ctx.name || '').toUpperCase().replace(/[^A-Z]/g, '');
      return n > 0 ? letters.slice(0, n) : letters;
    },
  },
];

const up = s => String(s == null ? '' : s).trim().toUpperCase();
const pad2 = n => String(n).padStart(2, '0');

// The token names an operator may type, longest first — {NAME:3} must not be
// read as {NAME} followed by junk.
const TOKEN_NAMES = TOKENS.map(t => t.name).sort((a, b) => b.length - a.length);

// Characters a SKU may contain once rendered. Deliberately narrow: a code goes
// into URLs, CSV exports, channel catalogues and barcode labels, and a space or
// a Chinese character in any of those is a support ticket. Letters, digits and
// the three separators people actually use.
const SKU_SAFE = /^[A-Za-z0-9._/-]*$/;

const MAX_PATTERN = 60;   // the sku column is TEXT, but a 60-char code is not a code
const MAX_SKU = 60;       // matches maxlength on the material form's SKU field

// ── parse ───────────────────────────────────────────────────────────────────
// Splits a pattern into an array of parts: {type:'literal', text} and
// {type:'token', name, arg, raw}. An unclosed or unknown brace becomes
// {type:'bad', raw} rather than throwing — validate() reports it, render()
// drops it, and neither has to guess what the operator meant.
function parse(pattern) {
  const src = String(pattern == null ? '' : pattern);
  const parts = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '{') { buf += ch; continue; }
    const close = src.indexOf('}', i);
    if (close === -1) { buf += src.slice(i); break; }        // unclosed → literal tail
    const raw = src.slice(i, close + 1);
    const inner = src.slice(i + 1, close);
    if (buf) { parts.push({ type: 'literal', text: buf }); buf = ''; }
    const tok = TOKENS.find(t => t.re.test(inner));
    if (tok) {
      const m = inner.match(tok.re);
      parts.push({ type: 'token', name: tok.name, arg: m[1], raw });
    } else {
      parts.push({ type: 'bad', raw });
    }
    i = close;
  }
  if (buf) parts.push({ type: 'literal', text: buf });
  return parts;
}

// ── render ──────────────────────────────────────────────────────────────────
// ctx: { seq, categoryCode, subcategoryCode, name, date }
// Unknown tokens render as nothing. Everything is uppercased at the end so a
// pattern typed in lower case still produces one consistent catalogue.
function render(pattern, ctx) {
  const c = {
    seq: 1,
    categoryCode: '',
    subcategoryCode: '',
    name: '',
    date: new Date(),
    ...(ctx || {}),
  };
  if (!(c.date instanceof Date) || isNaN(c.date)) c.date = new Date();
  let out = '';
  for (const p of parse(pattern)) {
    if (p.type === 'literal') { out += p.text; continue; }
    if (p.type === 'bad') continue;
    const tok = TOKENS.find(t => t.name === p.name);
    out += tok ? tok.render(c, p.arg) : '';
  }
  return out.toUpperCase().slice(0, MAX_SKU);
}

// ── validate ────────────────────────────────────────────────────────────────
// Returns { ok, errors: [{code, message_en, message_cn}], warnings: [...] }.
// ERRORS block a save; WARNINGS are shown beside the field and saved anyway —
// a pattern the operator can defend is not this file's business to refuse.
function validate(pattern) {
  const errors = [];
  const warnings = [];
  const src = String(pattern == null ? '' : pattern);
  const add = (list, code, en, cn) => list.push({ code, message_en: en, message_cn: cn });

  if (!src.trim()) {
    add(errors, 'empty', 'A pattern is required.', '必须填写格式。');
    return { ok: false, errors, warnings };
  }
  if (src.length > MAX_PATTERN) {
    add(errors, 'too_long', `A pattern may be at most ${MAX_PATTERN} characters.`, `格式最多 ${MAX_PATTERN} 个字符。`);
  }

  const parts = parse(src);
  for (const p of parts) {
    if (p.type === 'bad') {
      add(errors, 'unknown_token',
        `${p.raw} is not a token. Available: ${TOKEN_NAMES.map(n => '{' + n + '}').join(', ')}.`,
        `${p.raw} 不是可用的占位符。可用:${TOKEN_NAMES.map(n => '{' + n + '}').join('、')}。`);
    }
    // A literal is what ends up in the code verbatim, so it carries the
    // character rule. Tokens render their own safe output.
    if (p.type === 'literal' && !SKU_SAFE.test(p.text)) {
      add(errors, 'unsafe_chars',
        'A SKU may only contain letters, digits and . _ / - — remove spaces and other characters.',
        'SKU 只能包含字母、数字与 . _ / -,请去掉空格及其他字符。');
    }
  }
  if (src.includes('{') && !parts.some(p => p.type === 'token' || p.type === 'bad')) {
    add(warnings, 'literal_brace', 'A { with no closing } is treated as ordinary text.', '未闭合的 { 将按普通字符处理。');
  }
  if (!parts.some(p => p.type === 'token' && p.name === 'SEQ')) {
    add(warnings, 'no_seq',
      'Without {SEQ} every item in this scope gets the same code, and the system will have to add a number to keep them apart.',
      '缺少 {SEQ} 时,该范围内所有条目将得到相同编码,系统会自动追加数字以示区分。');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// A code typed on a category or subcategory ("B"). Kept to the same safe set as
// a literal, and short — it is a prefix, not a name.
function validateCode(code) {
  const c = String(code == null ? '' : code).trim();
  if (!c) return { ok: true, value: '' };                    // a code is optional
  if (c.length > 8) return { ok: false, error: 'code_too_long' };
  if (!/^[A-Za-z0-9._/-]+$/.test(c)) return { ok: false, error: 'code_unsafe' };
  return { ok: true, value: c.toUpperCase() };
}

// ── the plain-language builder ──────────────────────────────────────────────
//
// A PATTERN IS NOT A THING AN OPERATOR SHOULD EVER SEE (Ash, 2026-09-04:
// "those kind of formula make it look very complicated for a regular user").
// The settings screen shows four ordinary controls — the letters a code starts
// with, how many digits, a separator, whether to include the year — and this
// pair of functions is the seam between those controls and the template the
// engine actually runs.
//
// SIMPLE IS A VIEW, NOT A SECOND FORMAT. There is still exactly one stored
// representation (`pattern`), so nothing downstream learns a second dialect:
// fromSimple() composes one, toSimple() reads one back, and a pattern that
// cannot be read back is not an error — it is a custom format, and the screen
// says so and offers its Advanced field instead. That is what keeps the power
// of the template without putting braces in front of a shopkeeper.
//
// The shape the four controls can describe:
//
//     [text][{CAT}|{SUB}]  sep  [{YY}|{YYYY}]  sep  {SEQ:n}
//
// which covers every scheme asked for so far (B0001, GEN-0001, PK-J004,
// F-26-0012) and deliberately not the exotic ones — {NAME}, a month, a token
// in the middle of a word. Those stay reachable, just not from the four
// controls.

const SEPARATORS = ['', '-', '.', '/', '_'];
const SEP_RE = /^[-._/]$/;

// Which code token a rule's own `code` renders through. A subcategory rule's
// code is its {SUB}; a category rule's and the fallback's are their {CAT} —
// see lib/sku-rules.js codesFor(), which is what actually resolves them.
function codeTokenFor(scope) { return scope === 'subcategory' ? '{SUB}' : '{CAT}'; }

// simple → pattern. `scope` is 'subcategory' | 'category' | 'default'.
function fromSimple(simple, scope) {
  const s = simple || {};
  const digits = Math.min(9, Math.max(0, Number(s.digits === undefined ? 4 : s.digits)));
  const sep = SEPARATORS.includes(s.sep) ? s.sep : '';
  const head = String(s.text || '') + (s.useCode ? codeTokenFor(scope) : '');
  const year = Number(s.year) === 4 ? '{YYYY}' : Number(s.year) === 2 ? '{YY}' : '';
  // Empty chunks drop out rather than leaving a leading or doubled separator —
  // a rule with no prefix must not produce "-0001".
  return [head, year, '{SEQ:' + digits + '}'].filter(x => x !== '').join(sep);
}

// pattern → simple, or null when the pattern is richer than the four controls
// can describe. Null is the signal to open the Advanced field, never an error:
// a pattern typed there is a legitimate thing to have.
function toSimple(pattern) {
  const parts = parse(pattern);
  if (!parts.length || parts.some(p => p.type === 'bad')) return null;

  const last = parts[parts.length - 1];
  if (last.type !== 'token' || last.name !== 'SEQ') return null;   // must end with the number
  const digits = last.arg === undefined ? 4 : Number(last.arg);

  let text = '';
  let useCode = false;
  let year = 0;
  const seps = [];

  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p.type === 'token') {
      if (p.name === 'CAT' || p.name === 'SUB') {
        if (useCode || year) return null;                 // the code leads, or it is custom
        useCode = true;
      } else if (p.name === 'YY' || p.name === 'YYYY') {
        if (year) return null;
        year = p.name === 'YY' ? 2 : 4;
      } else {
        return null;                                      // {NAME}, {MM}, {DD} → custom
      }
      continue;
    }
    // A literal BEFORE any token is the prefix text; after one it can only be a
    // separator, and every separator in the pattern has to be the same one.
    if (!useCode && !year) { text += p.text; continue; }
    if (!SEP_RE.test(p.text)) return null;
    seps.push(p.text);
  }
  if (seps.length && seps.some(x => x !== seps[0])) return null;

  let sep = seps[0] || '';
  // `GEN-{SEQ:4}` reads as prefix "GEN" with a dash, not as prefix "GEN-". Only
  // safe when the prefix is the ONLY thing before the number: with a code token
  // after it the dash sits inside the prefix and moving it would rebuild the
  // pattern wrongly (PK-{SUB}{SEQ:3} is not PK{SUB}-{SEQ:3}).
  if (!sep && !useCode && !year && SEP_RE.test(text.slice(-1))) {
    sep = text.slice(-1);
    text = text.slice(0, -1);
  }

  const simple = { text, useCode, year, sep, digits };
  // The round-trip is the test. If recomposing does not reproduce the stored
  // pattern character for character, this reading of it is wrong — say custom
  // rather than quietly rewrite what the operator has.
  return fromSimple(simple, useCode && /\{SUB\}/.test(pattern) ? 'subcategory' : 'category') === pattern
    ? simple
    : null;
}

// ── does a typed code fit the pattern? ──────────────────────────────────────
// Returns a REGEX SOURCE STRING, not a RegExp — it is handed to the browser in
// JSON so the material form can flag a hand-typed SKU that does not match the
// rule for its category. One implementation, used on both sides: a second
// matcher written in the client would drift from the renderer the first time a
// token was added, and the warning would then be wrong rather than absent.
//
// It is deliberately LOOSE where the pattern is loose. {CAT} with no code
// configured matches any run of safe characters, because there is nothing to
// compare against — the warning exists to catch "you typed a name in the SKU
// field", not to police a letter the operator never set.
function matchRegexSource(pattern, ctx) {
  const c = { categoryCode: '', subcategoryCode: '', ...(ctx || {}) };
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anyCode = '[A-Z0-9._/-]{1,8}';
  let out = '^';
  for (const p of parse(pattern)) {
    if (p.type === 'literal') { out += esc(p.text.toUpperCase()); continue; }
    if (p.type === 'bad') continue;
    switch (p.name) {
      case 'SEQ': {
        const w = p.arg === undefined ? 4 : Number(p.arg);
        // A padded number is at LEAST its width — the series runs past 9999.
        out += w > 0 ? `\\d{${w},}` : '\\d+';
        break;
      }
      case 'CAT': out += c.categoryCode ? esc(up(c.categoryCode)) : anyCode; break;
      case 'SUB': out += c.subcategoryCode ? esc(up(c.subcategoryCode)) : anyCode; break;
      case 'YYYY': out += '\\d{4}'; break;
      case 'YY': case 'MM': case 'DD': out += '\\d{2}'; break;
      case 'NAME': {
        const n = p.arg === undefined ? 3 : Number(p.arg);
        out += n > 0 ? `[A-Z]{0,${n}}` : '[A-Z]*';
        break;
      }
      default: break;
    }
  }
  // The collision suffix claim() adds to a pattern that cannot number itself is
  // part of the scheme, so a code wearing one is not a mismatch.
  return out + '(-\\d+)?$';
}

// What the settings screen shows in its token palette. Language is picked by
// the caller (`cuT`-style pairs), so this stays free of any i18n import.
function tokenCatalogue() {
  return TOKENS.map(t => ({
    name: t.name,
    insert: '{' + t.name + (t.name === 'SEQ' ? ':4' : t.name === 'NAME' ? ':3' : '') + '}',
    label_en: t.label[0], label_cn: t.label[1],
    hint_en: t.hint[0], hint_cn: t.hint[1],
  }));
}

module.exports = {
  parse, render, validate, validateCode, tokenCatalogue, matchRegexSource,
  fromSimple, toSimple, codeTokenFor, SEPARATORS,
  TOKEN_NAMES, MAX_PATTERN, MAX_SKU, SKU_SAFE,
};
