// product-blocks — renders a designer-styled product page body from a JSON
// array of `{id, type, ...data}` blocks. Each block type has a bespoke
// visual treatment (see product-blocks.wxss). All bilingual fields are
// resolved here so the WXML can stay declarative.
//
// Currently supported block types:
//   hero_intro     — big editorial paragraph + pull-out highlight phrase
//   stat_callout   — giant stat number on a brand-color slab + claim line
//   allergen_card  — ⚠️ bordered card with Contains / May contain chips
//
// More types coming (ingredients cloud, how-to-use grid, storage status,
// photo strip, pull quote, divider…) — keep additions purely additive so
// the office can mix old + new blocks freely.

const lang = require('../../utils/lang');

function _pick(en, cn, L) { return lang.pick(en, cn, L); }

// Split a comma / Chinese-comma separated string into trimmed chip labels.
function _splitChips(s) {
  return String(s || '')
    .split(/[,、，]/g)
    .map(x => x.trim())
    .filter(Boolean);
}

// Wrap `phrase` inside `text` with markers so the WXML can split on
// "<<HL>>" / "<</HL>>" and render the wrapped portion with accent
// styling. Case-insensitive find. If the phrase isn't found inside the
// body the highlight renders as a leading pull-quote instead — see
// `highlight_loose` below.
function _markHighlight(body, phrase) {
  if (!phrase || !body) return { text: body || '', loose: '' };
  const idx = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx < 0) return { text: body, loose: phrase };
  return {
    text: body.slice(0, idx) + '<<HL>>' + body.slice(idx, idx + phrase.length) + '<</HL>>' + body.slice(idx + phrase.length),
    loose: '',
  };
}

// Tokenize a string containing `<<HL>>…<</HL>>` markers into an array of
// `{kind:'plain'|'hl', text}` segments for the WXML to render with the
// right styling. Keeps the template free of regex.
function _segmentHighlighted(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf('<<HL>>', i);
    if (a < 0) { out.push({ kind: 'plain', text: s.slice(i) }); break; }
    if (a > i) out.push({ kind: 'plain', text: s.slice(i, a) });
    const b = s.indexOf('<</HL>>', a);
    if (b < 0) { out.push({ kind: 'plain', text: s.slice(a) }); break; }
    out.push({ kind: 'hl', text: s.slice(a + 6, b) });
    i = b + 7;
  }
  return out;
}

function _resolveBlock(b, L) {
  const t = b.type;
  if (t === 'hero_intro') {
    const body      = _pick(b.body_en, b.body_cn, L) || '';
    const highlight = _pick(b.highlight_en, b.highlight_cn, L) || '';
    const marked    = _markHighlight(body, highlight);
    return {
      type: t,
      bodySegments: _segmentHighlighted(marked.text),
      // Loose highlight = phrase that doesn't appear inside the body; we
      // render it as a styled lead-in callout above the paragraph.
      looseHighlight: marked.loose,
    };
  }
  if (t === 'stat_callout') {
    return {
      type: t,
      stat:  String(b.stat || '').trim(),
      claim: _pick(b.claim_en, b.claim_cn, L) || '',
      sub:   _pick(b.sub_en,   b.sub_cn,   L) || '',
    };
  }
  if (t === 'allergen_card') {
    return {
      type: t,
      containsLabel:   L === 'cn' ? '含有' : 'CONTAINS',
      mayContainLabel: L === 'cn' ? '可能含有微量' : 'MAY CONTAIN TRACES OF',
      contains:    _splitChips(_pick(b.contains_en,     b.contains_cn,     L)),
      mayContain:  _splitChips(_pick(b.may_contain_en,  b.may_contain_cn,  L)),
    };
  }
  // Unknown type — render nothing (forward-compat: an editor on a newer
  // schema can save block types the older mini-app build doesn't know yet,
  // and they just silently no-op rather than throwing).
  return { type: '_skip' };
}

Component({
  properties: {
    blocks: { type: Array,  value: [], observer(v) { this._resolveAll(); } },
    lang:   { type: String, value: 'en', observer() { this._resolveAll(); } },
  },
  data: {
    resolved: [],
  },
  methods: {
    _resolveAll() {
      const L = this.data.lang || 'en';
      const blocks = this.data.blocks || [];
      const resolved = blocks
        .map((b, i) => ({ ...(_resolveBlock(b, L) || {}), _k: b.id || ('b' + i) }))
        .filter(b => b.type !== '_skip');
      this.setData({ resolved });
    },
  },
  lifetimes: {
    attached() { this._resolveAll(); },
  },
});
