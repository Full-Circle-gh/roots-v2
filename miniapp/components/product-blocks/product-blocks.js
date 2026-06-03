// product-blocks — Roots PDP v1 (Editorial direction).
// Renders the office-authored block array on the mini-app product page.
// Each block.type below has a bespoke visual per v1 design rules; data
// shapes are bilingual where applicable so the office writes both EN/CN
// and we pick the right side at render time.
//
// Supported types (10 + 1 deprecated alias):
//   spec_strip        Three meta facts in equal columns
//   hero_intro        Editorial paragraph + optional kicker + inline highlight
//   why               3–5 numbered claims
//   ingredients_chips Pill cloud, optional hero ingredient + % badges
//   ingredients_line  Editorial single-line with lime-dot separators
//   allergen_card     Contains / May contain segmented chip rows
//   how_to_use        6 or 8 usage moments as tiles
//   storage_box       Paired condition cards (one inverted)
//   notes_callout     Italic asterisk fine-print band
//   pull_quote        Editorial pullquote on oat-deep tint
//   stat_callout / big_stat  One hero number on a brand-colour slab
//   image_band        Full-bleed lifestyle photo + optional caption
//
// All bilingual `*_en` / `*_cn` pairs resolve via utils/lang.pick().
// Anything the office leaves empty is dropped from the render, so the
// page never shows half-filled blocks.

const lang = require('../../utils/lang');
const api = require('../../utils/api');

function _pick(en, cn, L) { return lang.pick(en, cn, L); }

// ── Per-block colour palette (mirrors the editor's PA_HEX / CMS DC_HEX) ──
// Office can tint a block's background / text / accent independently. Tokens
// resolve to the same brand hexes used across the storefront + product page.
const PB_HEX = {
  'lime-leaf': '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
  'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
  'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
  'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
  'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
  'white': '#FFFFFF',
};
// Block types that accept colour slots (big_stat keeps its own slab colour;
// image_band / nutrition opt out). Mirrors the editor's PA_DC_FIELDS keys.
const PB_COLOR_TYPES = {
  spec_strip: 1, hero_intro: 1, why: 1, ingredients_chips: 1, ingredients_line: 1,
  allergen_card: 1, how_to_use: 1, storage_box: 1, notes_callout: 1, pull_quote: 1,
  recipe_steps: 1, pairings: 1, faq: 1,
};
function _colorHex(tok) {
  if (!tok) return '';
  return PB_HEX[tok] || (/^#[0-9a-f]{3,6}$/i.test(tok) ? tok : '');
}
// Inline style for a block wrapper from its colour tokens. bg/fg apply
// directly; accent rides --pa-accent, which the WXSS honours via
// var(--pa-accent, <default>). Returns '' when nothing is set.
function _blockStyle(b) {
  if (!b || !PB_COLOR_TYPES[b.type]) return '';
  const out = [];
  const bg = _colorHex(b.bg_color), fg = _colorHex(b.fg_color), ac = _colorHex(b.accent_color);
  if (bg) out.push('background-color:' + bg, '--pa-bg:' + bg);
  if (fg) out.push('color:' + fg, '--pa-fg:' + fg);
  if (ac) out.push('--pa-accent:' + ac);
  return out.join(';');
}

// Resolve a stored media path to an absolute URL the mini-app can load.
// Office-uploaded images come back as relative /api/retail/media/:id; data:
// and absolute URLs pass through untouched. Mirrors utils/cart.absUrl.
function _absUrl(u) {
  if (!u) return '';
  if (/^(https?:|data:|wxfile:)/i.test(u)) return u;
  if (u.startsWith('/')) return api.BASE + u;
  return u;
}

// Comma / Chinese-comma split → trimmed strings.
function _splitChips(s) {
  return String(s || '')
    .split(/[,、，]/g)
    .map(x => x.trim())
    .filter(Boolean);
}

// Wrap the highlight phrase inside body text with a marker the WXML can
// segment on, so the highlighted run renders with .pb-ink-pull styling
// inline. If the phrase isn't in the body, we surface it as a "kicker"
// above the paragraph (per v1 rule: "If no highlight phrase, kicker
// carries the punch instead").
function _markHighlight(body, phrase) {
  if (!phrase || !body) return { text: body || '', kicker: '' };
  const idx = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx < 0) return { text: body, kicker: phrase };
  return {
    text: body.slice(0, idx) + '<<HL>>' + body.slice(idx, idx + phrase.length) + '<</HL>>' + body.slice(idx + phrase.length),
    kicker: '',
  };
}

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

// Each branch normalises one block's data to render-ready shape so the
// template stays declarative. Returning { type: '_skip' } drops the block
// (e.g. all fields empty, or unknown type → forward-compatibility with
// older mini-app builds receiving a newer block schema).
function _resolveBlock(b, L) {
  const t = b.type;

  if (t === 'spec_strip') {
    const cells = (Array.isArray(b.cells) ? b.cells : [b.cell1, b.cell2, b.cell3].filter(Boolean))
      .map(c => ({
        k: _pick(c.k_en, c.k_cn, L) || '',
        v: _pick(c.v_en, c.v_cn, L) || '',
      }))
      .filter(c => c.k || c.v);
    if (!cells.length) return { type: '_skip' };
    return { type: t, cells };
  }

  if (t === 'hero_intro') {
    const body      = _pick(b.body_en, b.body_cn, L) || '';
    const phrase    = _pick(b.highlight_en, b.highlight_cn, L) || '';
    // Office can ALSO author an explicit kicker (e.g. "The story") that
    // always renders above the paragraph regardless of highlight match.
    const explicitKicker = _pick(b.kicker_en, b.kicker_cn, L) || '';
    if (!body && !phrase && !explicitKicker) return { type: '_skip' };
    const marked = _markHighlight(body, phrase);
    return {
      type: t,
      kicker:       explicitKicker || marked.kicker,
      bodySegments: _segmentHighlighted(marked.text),
    };
  }

  if (t === 'why') {
    // Two accepted shapes: legacy { rows_en: [str], rows_cn: [str] } OR
    // newer { rows: [{ claim_en, claim_cn }] }. Office editor uses the
    // second; older saves use the first.
    let rows = [];
    if (Array.isArray(b.rows) && b.rows.length && typeof b.rows[0] === 'object') {
      rows = b.rows.map(r => _pick(r.claim_en, r.claim_cn, L)).filter(Boolean);
    } else {
      const en = Array.isArray(b.rows_en) ? b.rows_en : String(b.rows_en || '').split('\n');
      const cn = Array.isArray(b.rows_cn) ? b.rows_cn : String(b.rows_cn || '').split('\n');
      const max = Math.max(en.length, cn.length);
      for (let i = 0; i < max; i++) {
        const t2 = _pick((en[i] || '').trim(), (cn[i] || '').trim(), L);
        if (t2) rows.push(t2);
      }
    }
    rows = rows.filter(Boolean);
    if (!rows.length) return { type: '_skip' };
    return {
      type: t,
      head:   L === 'cn' ? '为什么选它' : 'Why people choose it',
      count:  String(rows.length).padStart(2, '0'),
      rows:   rows.map((claim, i) => ({
        n:     String(i + 1).padStart(2, '0'),
        claim,
        first: i === 0,
      })),
    };
  }

  if (t === 'ingredients_chips' || t === 'ingredients_line') {
    // Shared data: items = [{ name_en, name_cn, pct, lead }]
    const items = Array.isArray(b.items) ? b.items : [];
    const resolved = items
      .map(it => ({
        name: _pick(it.name_en, it.name_cn, L),
        pct:  it.pct != null && it.pct !== '' ? Number(it.pct) : null,
        lead: !!it.lead,
      }))
      .filter(it => it.name);
    if (!resolved.length) return { type: '_skip' };
    return {
      type: t,
      headLabel: L === 'cn' ? '配料表' : 'Ingredients',
      tag: t === 'ingredients_chips'
        ? `${resolved.length} ${L === 'cn' ? '项' : 'items'} · ${L === 'cn' ? '云标签' : 'chip cloud'}`
        : (L === 'cn' ? '编辑式排版' : 'editorial run'),
      items: resolved,
    };
  }

  if (t === 'allergen_card') {
    const contains    = _splitChips(_pick(b.contains_en,    b.contains_cn,    L));
    const mayContain  = _splitChips(_pick(b.may_contain_en, b.may_contain_cn, L));
    if (!contains.length && !mayContain.length) return { type: '_skip' };
    return {
      type: t,
      title:           L === 'cn' ? '过敏原' : 'Allergens',
      compliance:      'GB-7718',
      containsLabel:   L === 'cn' ? '含有' : 'Contains',
      mayContainLabel: L === 'cn' ? '可能含有微量' : 'May contain traces of',
      contains,
      mayContain,
      // Empty-contains state per v1 spec
      containsEmpty:   contains.length === 0,
      emptyText:       L === 'cn' ? '未声明' : 'None declared',
    };
  }

  if (t === 'how_to_use') {
    const tiles = (Array.isArray(b.tiles) ? b.tiles : [])
      .map(it => ({
        icon: it.icon || '',
        lbl:  _pick(it.label_en, it.label_cn, L),
        sub:  _pick(it.sub_en,   it.sub_cn,   L),
      }))
      .filter(it => it.lbl || it.icon);
    if (!tiles.length) return { type: '_skip' };
    // Per design rule "6 or 8 tiles, never 5 or 7" — favour 4-col when 8,
    // 3-col otherwise. Office authors any count; we just pick the grid.
    const cols = tiles.length >= 8 ? 4 : 3;
    return {
      type: t,
      head:  L === 'cn' ? '用法' : 'How to use',
      tag:   tiles.length + (L === 'cn' ? ' 种用法' : ' moments'),
      tiles,
      cols,
    };
  }

  if (t === 'storage_box') {
    // Two card slots: left + right. Each is independent so the office can
    // mix any pair (room temp / refrigerated / freezer / shelf life).
    const card = (c) => {
      if (!c) return null;
      const head = _pick(c.head_en, c.head_cn, L);
      // num is now bilingual (num_en/num_cn); fall back to the legacy single
      // `num` field for blocks saved before the split.
      const num  = (_pick(c.num_en, c.num_cn, L) || c.num || '').toString();
      const unit = _pick(c.unit_en, c.unit_cn, L);
      if (!head && !num && !unit) return null;
      return { icon: c.icon || '', head, num, unit, alt: !!c.alt };
    };
    const left  = card(b.left);
    const right = card(b.right);
    const note  = _pick(b.note_en, b.note_cn, L) || '';
    if (!left && !right && !note) return { type: '_skip' };
    return {
      type: t,
      head: L === 'cn' ? '储存' : 'Storage',
      tag:  L === 'cn' ? '保鲜方法' : 'keep it right',
      left, right, note,
    };
  }

  if (t === 'notes_callout') {
    const text = _pick(b.text_en, b.text_cn, L) || '';
    if (!text) return { type: '_skip' };
    return { type: t, text };
  }

  // Big stat — accept both the legacy `stat_callout` (v0 shape) and the
  // new `big_stat`. Renders identically.
  if (t === 'big_stat' || t === 'stat_callout') {
    const stat  = (b.stat || '').toString().trim();
    const what  = _pick(b.claim_en || b.what_en, b.claim_cn || b.what_cn, L) || '';
    const claim = _pick(b.sub_en   || b.claim_en, b.sub_cn   || b.claim_cn, L) || '';
    if (!stat && !what && !claim) return { type: '_skip' };
    return { type: 'big_stat', stat, what, claim, bg: b.bg || 'lime' };
  }

  if (t === 'pull_quote') {
    const text = _pick(b.text_en, b.text_cn, L) || '';
    const who  = _pick(b.who_en,  b.who_cn,  L) || '';
    if (!text && !who) return { type: '_skip' };
    return { type: t, text, who };
  }

  if (t === 'image_band') {
    const url = _absUrl(b.url);
    if (!url) return { type: '_skip' };
    const caption = _pick(b.caption_en, b.caption_cn, L) || '';
    // 'natural' keeps the image's own aspect (widthFix); the others crop to a
    // fixed shape (aspectFill). Unknown values fall back to 'wide'.
    const ratio = ['wide', 'square', 'tall', 'natural'].includes(b.ratio) ? b.ratio : 'wide';
    return { type: t, url, caption, ratio, fill: ratio !== 'natural' };
  }

  if (t === 'recipe_steps') {
    const steps = (Array.isArray(b.steps) ? b.steps : [])
      .map(s => ({ text: _pick(s.text_en, s.text_cn, L), time: _pick(s.time_en, s.time_cn, L) }))
      .filter(s => s.text);
    if (!steps.length) return { type: '_skip' };
    const title = _pick(b.title_en, b.title_cn, L) || (L === 'cn' ? '做法' : 'Method');
    return {
      type: t,
      head: title,
      tag: steps.length + (L === 'cn' ? ' 步' : ' steps'),
      steps: steps.map((s, i) => ({ n: String(i + 1).padStart(2, '0'), text: s.text, time: s.time })),
    };
  }

  if (t === 'pairings') {
    // Tiles derive their photo live from the public product-image endpoint, so
    // the cross-sell always reflects the current catalog. Name is a snapshot.
    const items = (Array.isArray(b.items) ? b.items : [])
      .filter(it => it && it.id)
      .map(it => ({
        id: it.id,
        name: _pick(it.name_en, it.name_cn, L) || '',
        img: api.BASE + '/api/retail/products/' + it.id + '/image',
      }));
    if (!items.length) return { type: '_skip' };
    return {
      type: t,
      head: _pick(b.title_en, b.title_cn, L) || (L === 'cn' ? '搭配推荐' : 'Goes well with'),
      items,
    };
  }

  if (t === 'faq') {
    const items = (Array.isArray(b.items) ? b.items : [])
      .map(it => ({ q: _pick(it.q_en, it.q_cn, L), a: _pick(it.a_en, it.a_cn, L) }))
      .filter(it => it.q && it.a)
      // First question opens by default; the rest start collapsed.
      .map((it, i) => ({ q: it.q, a: it.a, open: i === 0 }));
    if (!items.length) return { type: '_skip' };
    return {
      type: t,
      head: _pick(b.title_en, b.title_cn, L) || (L === 'cn' ? '常见问题' : 'Questions'),
      items,
    };
  }

  return { type: '_skip' };
}

Component({
  properties: {
    blocks: { type: Array,  value: [], observer() { this._resolveAll(); } },
    lang:   { type: String, value: 'en', observer() { this._resolveAll(); } },
    // page_template id (e.g. 'editorial_light') → drives the per-template visual
    // skin on the wrapper (pb-tpl-<id>). Empty = base styling.
    template: { type: String, value: '', observer() { this._applyTpl(); } },
  },
  data: {
    resolved: [],
    tplClass: '',
  },
  methods: {
    _resolveAll() {
      const L = this.data.lang || 'en';
      const arr = this.data.blocks || [];
      const resolved = arr
        .map((b, i) => ({ ...(_resolveBlock(b, L) || {}), _k: b.id || ('b' + i), _style: _blockStyle(b) }))
        .filter(b => b.type !== '_skip');
      this.setData({ resolved });
    },
    // FAQ accordion — toggle one item's open state. data-bi = block index in
    // resolved, data-qi = question index within that block.
    onFaqToggle(e) {
      const { bi, qi } = e.currentTarget.dataset;
      const open = !this.data.resolved[bi].items[qi].open;
      this.setData({ [`resolved[${bi}].items[${qi}].open`]: open });
    },
    // Pairings — tap a cross-sell tile to open that product's page.
    onPairTap(e) {
      const id = e.currentTarget.dataset.id;
      if (!id) return;
      wx.navigateTo({ url: '/pages/product/product?id=' + id });
    },
    _applyTpl() {
      const id = String(this.data.template || '').replace(/[^a-z0-9_-]/gi, '');
      this.setData({ tplClass: id ? ('pb-tpl-' + id) : '' });
    },
  },
  lifetimes: {
    attached() { this._applyTpl(); this._resolveAll(); },
  },
});
