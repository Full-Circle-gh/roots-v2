/* ShopProductBlocks — self-contained web (browser) port of the mini-app
 * PRODUCT design-block renderer (miniapp/components/product-blocks).
 *
 * Pure string templating: every <view> -> <div>, <text> -> <span>. No external
 * libs, no DOM access, no timers, no lazy fetch — product blocks are static
 * editorial content. Faithful to product-blocks.wxml / .wxss; classes are
 * prefixed spb- and the whole tree lives under .shop-product-blocks (styled in
 * product-blocks.css).
 *
 * Host contract (see shop.html):
 *   ShopProductBlocks.render(blocks, { lang })  -> HTML string
 *     blocks : array OR JSON string (the product's description_blocks)
 *     opts   : { lang: 'en' | 'cn' }
 *
 * Brand colour vars (--lime --forest …) + @font-face come from the host page.
 */
(function (global) {
  'use strict';

  // ── lang.pick ────────────────────────────────────────────────────────────
  function pickLang(en, cn, L) {
    var a = (en == null ? '' : String(en)).trim();
    var b = (cn == null ? '' : String(cn)).trim();
    if (L === 'cn') return b || a;
    return a || b;
  }

  // ── HTML escaping ─────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Inline-style attribute values (pre-built trusted token strings) — strip
  // only the quote that would break the attribute.
  function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  // ── Plant-based icon guard (mirror product-blocks.js PB_ICON_FIX) ─────────
  var PB_ICON_FIX = {
    '🍳': '🥘', '🥚': '🥘', '🧀': '🌱', '🧈': '🌱', '🥓': '🌱', '🍖': '🌱',
    '🍗': '🌱', '🥩': '🌱', '🍔': '🥗', '🌭': '🥗', '🍤': '🥗', '🦐': '🥗',
    '🦑': '🥗', '🦞': '🥗', '🦀': '🥗', '🐟': '🥗', '🐠': '🥗', '🍯': '🌿',
    '🥛': '🌿', '📡': '♨️',
  };
  function icon(s) { return PB_ICON_FIX[s] || (s || ''); }

  // ── Per-block colour palette (mirror PB_HEX / PB_COLOR_TYPES) ─────────────
  var PB_HEX = {
    'lime-leaf': '#CCD900', 'forest-kale': '#365329', 'olive-moss': '#6A6E2D',
    'roasted-almond': '#C37F4E', 'golden-corn': '#F2CA6C', 'oat-milk': '#F2E7DF',
    'ink': '#1a1a17', 'pink-guava': '#F4B8CB', 'berry-punch': '#E96174',
    'carrot-blaze': '#FF6B0C', 'papaya-glow': '#FFAF60', 'skyberry': '#B2CFED',
    'lotus': '#EEB8E4', 'citrus-zest': '#E7E74C', 'pea-sprout': '#7BBD3B',
    'white': '#FFFFFF',
  };
  // CSS-var equivalents (host page defines --forest etc.) — same mapping the
  // home renderer uses for brandColorVar; falls through to the hex otherwise.
  var PB_VAR = {
    'forest-kale': 'var(--forest)', 'lime-leaf': 'var(--lime)',
    'berry-punch': 'var(--berry)', 'carrot-blaze': 'var(--carrot)',
    'papaya-glow': 'var(--papaya)', 'oat-milk': 'var(--oat)', 'ink': 'var(--ink)',
    'olive-moss': 'var(--olive)', 'golden-corn': 'var(--corn)',
    'pink-guava': 'var(--pink)', 'skyberry': 'var(--sky)', 'lotus': 'var(--lotus)',
    'citrus-zest': 'var(--citrus)', 'pea-sprout': 'var(--pea)',
  };
  var PB_COLOR_TYPES = {
    spec_strip: 1, hero_intro: 1, why: 1, ingredients_chips: 1, ingredients_line: 1,
    allergen_card: 1, how_to_use: 1, storage_box: 1, notes_callout: 1, pull_quote: 1,
    recipe_steps: 1, pairings: 1, faq: 1,
  };
  function colorVal(tok) {
    if (!tok) return '';
    if (PB_VAR[tok]) return PB_VAR[tok];
    if (PB_HEX[tok]) return PB_HEX[tok];
    return /^#[0-9a-f]{3,6}$/i.test(tok) ? tok : '';
  }
  // Inline style for a block wrapper from its colour tokens (mirror _blockStyle).
  function blockStyle(b) {
    if (!b || !PB_COLOR_TYPES[b.type]) return '';
    var out = [];
    var bg = colorVal(b.bg_color), fg = colorVal(b.fg_color), ac = colorVal(b.accent_color);
    if (bg) { out.push('background-color:' + bg); out.push('--pa-bg:' + bg); }
    if (fg) { out.push('color:' + fg); out.push('--pa-fg:' + fg); }
    if (ac) { out.push('--pa-accent:' + ac); }
    return out.join(';');
  }

  // ── Misc helpers ──────────────────────────────────────────────────────────
  function splitChips(s) {
    return String(s == null ? '' : s)
      .split(/[,、，]/g).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function pad2(n) { return String(n).length < 2 ? ('0' + n) : String(n); }

  // Highlight phrase segmentation (mirror _markHighlight + _segmentHighlighted).
  function markHighlight(body, phrase) {
    if (!phrase || !body) return { text: body || '', kicker: '' };
    var idx = body.toLowerCase().indexOf(phrase.toLowerCase());
    if (idx < 0) return { text: body, kicker: phrase };
    return {
      text: body.slice(0, idx) + '<<HL>>' + body.slice(idx, idx + phrase.length) +
        '<</HL>>' + body.slice(idx + phrase.length),
      kicker: '',
    };
  }
  function segmentHighlighted(s) {
    var out = [], i = 0;
    while (i < s.length) {
      var a = s.indexOf('<<HL>>', i);
      if (a < 0) { out.push({ kind: 'plain', text: s.slice(i) }); break; }
      if (a > i) out.push({ kind: 'plain', text: s.slice(i, a) });
      var b = s.indexOf('<</HL>>', a);
      if (b < 0) { out.push({ kind: 'plain', text: s.slice(a) }); break; }
      out.push({ kind: 'hl', text: s.slice(a + 6, b) });
      i = b + 7;
    }
    return out;
  }

  // ── Per-type renderers (resolve + emit). Return '' to drop the block. ─────
  // Each receives the raw block `b`, the lang `L`, and the wrapper style attr.
  // The wrapper <div class="spb spb-<type>"> is added by renderOne().

  function rSpecStrip(b, L) {
    var src = Array.isArray(b.cells)
      ? b.cells
      : [b.cell1, b.cell2, b.cell3].filter(Boolean);
    var cells = src.map(function (c) {
      return { k: pickLang(c.k_en, c.k_cn, L) || '', v: pickLang(c.v_en, c.v_cn, L) || '' };
    }).filter(function (c) { return c.k || c.v; });
    if (!cells.length) return '';
    var inner = cells.map(function (c) {
      return '<div class="spb-spec-cell">' +
        (c.k ? '<div class="spb-spec-k">' + escapeHtml(c.k) + '</div>' : '') +
        (c.v ? '<div class="spb-spec-v">' + escapeHtml(c.v) + '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="spb-spec">' + inner + '</div>';
  }

  function rHeroIntro(b, L) {
    var body = pickLang(b.body_en, b.body_cn, L) || '';
    var phrase = pickLang(b.highlight_en, b.highlight_cn, L) || '';
    var explicitKicker = pickLang(b.kicker_en, b.kicker_cn, L) || '';
    if (!body && !phrase && !explicitKicker) return '';
    var marked = markHighlight(body, phrase);
    var kicker = explicitKicker || marked.kicker;
    var segs = segmentHighlighted(marked.text).map(function (seg) {
      var cls = seg.kind === 'hl' ? ' class="spb-ink-pull"' : '';
      return '<span' + cls + '>' + escapeHtml(seg.text) + '</span>';
    }).join('');
    return '<div class="spb-hero">' +
      (kicker ? '<div class="spb-hero-kicker">' + escapeHtml(kicker) + '</div>' : '') +
      '<div class="spb-hero-body">' + segs + '</div>' +
      '</div>';
  }

  function rWhy(b, L) {
    var rows = [];
    if (Array.isArray(b.rows) && b.rows.length && typeof b.rows[0] === 'object') {
      rows = b.rows.map(function (r) { return pickLang(r.claim_en, r.claim_cn, L); }).filter(Boolean);
    } else {
      var en = Array.isArray(b.rows_en) ? b.rows_en : String(b.rows_en || '').split('\n');
      var cn = Array.isArray(b.rows_cn) ? b.rows_cn : String(b.rows_cn || '').split('\n');
      var max = Math.max(en.length, cn.length);
      for (var i = 0; i < max; i++) {
        var t2 = pickLang((en[i] || '').trim(), (cn[i] || '').trim(), L);
        if (t2) rows.push(t2);
      }
    }
    rows = rows.filter(Boolean);
    if (!rows.length) return '';
    var head = L === 'cn' ? '为什么选它' : 'Why people choose it';
    var body = rows.map(function (claim, i) {
      return '<div class="spb-why-row' + (i === 0 ? ' first' : '') + '">' +
        '<span class="spb-why-n">' + escapeHtml(pad2(i + 1)) + '</span>' +
        '<span class="spb-why-claim">' + escapeHtml(claim) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="spb-why">' +
      '<div class="spb-why-head"><span class="spb-why-head-l">' + escapeHtml(head) + '</span></div>' +
      body +
      '</div>';
  }

  function resolveIngredients(b, L) {
    var items = Array.isArray(b.items) ? b.items : [];
    return items.map(function (it) {
      return {
        name: pickLang(it.name_en, it.name_cn, L),
        pct: (it.pct != null && it.pct !== '') ? Number(it.pct) : null,
        lead: !!it.lead,
      };
    }).filter(function (it) { return it.name; });
  }

  function rIngredientsChips(b, L) {
    var items = resolveIngredients(b, L);
    if (!items.length) return '';
    var headLabel = L === 'cn' ? '配料表' : 'Ingredients';
    var chips = items.map(function (it) {
      return '<div class="spb-chip' + (it.lead ? ' spb-chip-lead' : '') + '">' +
        '<span>' + escapeHtml(it.name) + '</span>' +
        (it.pct ? '<span class="spb-chip-pct">' + escapeHtml(it.pct) + '%</span>' : '') +
        '</div>';
    }).join('');
    return '<div class="spb-ing">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(headLabel) + '</span></div>' +
      '<div class="spb-ing-chips">' + chips + '</div>' +
      '</div>';
  }

  function rIngredientsLine(b, L) {
    var items = resolveIngredients(b, L);
    if (!items.length) return '';
    var headLabel = L === 'cn' ? '配料表' : 'Ingredients';
    var run = items.map(function (it, i) {
      return (i > 0 ? '<span class="spb-ing-line-sep"></span>' : '') +
        '<span>' + escapeHtml(it.name) + '</span>' +
        (it.pct ? '<span class="spb-ing-line-pct"> ' + escapeHtml(it.pct) + '%</span>' : '');
    }).join('');
    return '<div class="spb-ing">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(headLabel) + '</span></div>' +
      '<div class="spb-ing-line">' + run + '</div>' +
      '</div>';
  }

  function rAllergenCard(b, L) {
    var contains = splitChips(pickLang(b.contains_en, b.contains_cn, L));
    var mayContain = splitChips(pickLang(b.may_contain_en, b.may_contain_cn, L));
    if (!contains.length && !mayContain.length) return '';
    var title = L === 'cn' ? '过敏原' : 'Allergens';
    var containsLabel = L === 'cn' ? '含有' : 'Contains';
    var mayContainLabel = L === 'cn' ? '可能含有微量' : 'May contain traces of';
    var emptyText = L === 'cn' ? '未声明' : 'None declared';

    var containsChips = contains.length
      ? contains.map(function (c) {
          return '<span class="spb-al-chip spb-al-chip-strong">' + escapeHtml(c) + '</span>';
        }).join('')
      : '<span class="spb-allergen-empty">' + escapeHtml(emptyText) + '</span>';

    var mayRow = mayContain.length
      ? '<div class="spb-allergen-row">' +
          '<span class="spb-allergen-lbl">' + escapeHtml(mayContainLabel) + '</span>' +
          '<div class="spb-allergen-chips">' +
            mayContain.map(function (c) {
              return '<span class="spb-al-chip spb-al-chip-soft">' + escapeHtml(c) + '</span>';
            }).join('') +
          '</div>' +
        '</div>'
      : '';

    return '<div class="spb-allergen">' +
      '<div class="spb-allergen-card">' +
        '<div class="spb-allergen-top"><div class="spb-allergen-ttl">' +
          '<span class="spb-allergen-warn">!</span><span>' + escapeHtml(title) + '</span>' +
        '</div></div>' +
        '<div class="spb-allergen-row">' +
          '<span class="spb-allergen-lbl">' + escapeHtml(containsLabel) + '</span>' +
          '<div class="spb-allergen-chips">' + containsChips + '</div>' +
        '</div>' +
        mayRow +
      '</div>' +
    '</div>';
  }

  function rHowToUse(b, L) {
    var tiles = (Array.isArray(b.tiles) ? b.tiles : []).map(function (it) {
      return {
        icon: icon(it.icon),
        lbl: pickLang(it.label_en, it.label_cn, L),
        sub: pickLang(it.sub_en, it.sub_cn, L),
      };
    }).filter(function (it) { return it.lbl || it.icon; });
    if (!tiles.length) return '';
    var cols = tiles.length >= 8 ? 4 : 3;
    var head = L === 'cn' ? '用法' : 'How to use';
    var grid = tiles.map(function (t) {
      return '<div class="spb-how-tile">' +
        (t.icon ? '<span class="spb-how-ic">' + escapeHtml(t.icon) + '</span>' : '') +
        (t.lbl ? '<span class="spb-how-lbl">' + escapeHtml(t.lbl) + '</span>' : '') +
        (t.sub ? '<span class="spb-how-sub">' + escapeHtml(t.sub) + '</span>' : '') +
        '</div>';
    }).join('');
    return '<div class="spb-how">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(head) + '</span></div>' +
      '<div class="spb-how-grid' + (cols === 4 ? ' cols-4' : '') + '">' + grid + '</div>' +
      '</div>';
  }

  function rStorageBox(b, L) {
    function card(c) {
      if (!c) return null;
      var head = pickLang(c.head_en, c.head_cn, L);
      var num = (pickLang(c.num_en, c.num_cn, L) || c.num || '').toString();
      var unit = pickLang(c.unit_en, c.unit_cn, L);
      if (!head && !num && !unit) return null;
      if (!num && unit) { num = unit; unit = ''; }
      if (/°\s*$/.test(num) && unit) {
        unit = unit
          .replace(/^\s*°?\s*[cf]\b\.?\s*/i, '')
          .replace(/^\s*[℃℉]\s*/, '')
          .trim();
      }
      var numLong = num.replace(/\s+/g, '').length > 5;
      return { icon: icon(c.icon), head: head, num: num, numLong: numLong, unit: unit, alt: !!c.alt };
    }
    function cardHtml(c) {
      if (!c) return '';
      return '<div class="spb-storage-card' + (c.alt ? ' alt' : '') + '">' +
        (c.icon ? '<span class="spb-storage-ic">' + escapeHtml(c.icon) + '</span>' : '') +
        (c.head ? '<span class="spb-storage-head">' + escapeHtml(c.head) + '</span>' : '') +
        (c.num ? '<span class="spb-storage-num' + (c.numLong ? ' long' : '') + '">' + escapeHtml(c.num) + '</span>' : '') +
        (c.unit ? '<span class="spb-storage-unit">' + escapeHtml(c.unit) + '</span>' : '') +
        '</div>';
    }
    var left = card(b.left), right = card(b.right);
    var note = pickLang(b.note_en, b.note_cn, L) || '';
    if (!left && !right && !note) return '';
    var head = L === 'cn' ? '储存' : 'Storage';
    return '<div class="spb-storage">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(head) + '</span></div>' +
      '<div class="spb-storage-pair">' + cardHtml(left) + cardHtml(right) + '</div>' +
      (note ? '<div class="spb-storage-note">' + escapeHtml(note) + '</div>' : '') +
      '</div>';
  }

  function rNotesCallout(b, L) {
    var text = pickLang(b.text_en, b.text_cn, L) || '';
    if (!text) return '';
    return '<div class="spb-notes"><div class="spb-notes-p">' + escapeHtml(text) + '</div></div>';
  }

  function rBigStat(b, L) {
    var stat = (b.stat || '').toString().trim();
    var what = pickLang(b.claim_en || b.what_en, b.claim_cn || b.what_cn, L) || '';
    var claim = pickLang(b.sub_en || b.claim_en, b.sub_cn || b.claim_cn, L) || '';
    if (!stat && !what && !claim) return '';
    var bg = b.bg || 'lime';
    // bg is a brand var token (lime/forest/berry/…) -> var(--bg). Sanitise.
    var bgVar = /^[a-z]+$/i.test(bg) ? 'var(--' + bg + ')' : 'var(--lime)';
    return '<div class="spb-bigstat" style="background:' + attr(bgVar) + ';">' +
      '<div class="spb-bigstat-num">' + escapeHtml(stat) + '</div>' +
      (what ? '<div class="spb-bigstat-what">' + escapeHtml(what) + '</div>' : '') +
      (claim ? '<div class="spb-bigstat-claim">' + escapeHtml(claim) + '</div>' : '') +
      '</div>';
  }

  function rCalloutBanner(b, L) {
    var text = pickLang(b.text_en, b.text_cn, L) || '';
    var sub = pickLang(b.sub_en, b.sub_cn, L) || '';
    var ic = (b.icon || '').trim();
    if (!text && !sub && !ic) return '';
    return '<div class="spb-cbanner">' +
      (ic ? '<div class="spb-cbanner-icon">' + escapeHtml(ic) + '</div>' : '') +
      (text ? '<div class="spb-cbanner-text">' + escapeHtml(text) + '</div>' : '') +
      (sub ? '<div class="spb-cbanner-sub">' + escapeHtml(sub) + '</div>' : '') +
      '</div>';
  }

  function rPullQuote(b, L) {
    var text = pickLang(b.text_en, b.text_cn, L) || '';
    var who = pickLang(b.who_en, b.who_cn, L) || '';
    if (!text && !who) return '';
    return '<div class="spb-pullquote">' +
      '<div class="spb-pullquote-p">"' + escapeHtml(text) + '"</div>' +
      (who ? '<div class="spb-pullquote-who">' + escapeHtml(who) + '</div>' : '') +
      '</div>';
  }

  function rImageBand(b, L) {
    var u = b.url || '';
    if (u && !/^(https?:|data:|blob:)/i.test(u) && u.charAt(0) === '/') u = u; // same-origin pass-through
    if (!u) return '';
    var caption = pickLang(b.caption_en, b.caption_cn, L) || '';
    var ratio = ['wide', 'square', 'tall', 'natural'].indexOf(b.ratio) >= 0 ? b.ratio : 'wide';
    var fill = ratio !== 'natural';
    return '<div class="spb-image spb-image-' + ratio + '">' +
      '<img class="spb-image-img' + (fill ? ' spb-image-fill' : '') + '" src="' + attr(u) + '" alt="' + attr(caption) + '" loading="lazy"/>' +
      (caption ? '<div class="spb-image-cap">' + escapeHtml(caption) + '</div>' : '') +
      '</div>';
  }

  function rRecipeSteps(b, L) {
    var steps = (Array.isArray(b.steps) ? b.steps : []).map(function (s) {
      return { text: pickLang(s.text_en, s.text_cn, L), time: pickLang(s.time_en, s.time_cn, L) };
    }).filter(function (s) { return s.text; });
    if (!steps.length) return '';
    var head = pickLang(b.title_en, b.title_cn, L) || (L === 'cn' ? '做法' : 'Method');
    var body = steps.map(function (s, i) {
      return '<div class="spb-recipe-step">' +
        '<span class="spb-recipe-n">' + escapeHtml(pad2(i + 1)) + '</span>' +
        '<div class="spb-recipe-body">' +
          '<div class="spb-recipe-text">' + escapeHtml(s.text) + '</div>' +
          (s.time ? '<span class="spb-recipe-time">' + escapeHtml(s.time) + '</span>' : '') +
        '</div>' +
        '</div>';
    }).join('');
    return '<div class="spb-recipe">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(head) + '</span></div>' +
      body +
      '</div>';
  }

  function rFaq(b, L) {
    var items = (Array.isArray(b.items) ? b.items : []).map(function (it) {
      return { q: pickLang(it.q_en, it.q_cn, L), a: pickLang(it.a_en, it.a_cn, L) };
    }).filter(function (it) { return it.q && it.a; });
    if (!items.length) return '';
    var head = pickLang(b.title_en, b.title_cn, L) || (L === 'cn' ? '常见问题' : 'Questions');
    // Static render: use <details>/<summary> so it stays interactive without JS.
    var body = items.map(function (it, i) {
      return '<details class="spb-faq-item"' + (i === 0 ? ' open' : '') + '>' +
        '<summary class="spb-faq-q">' +
          '<span class="spb-faq-q-txt">' + escapeHtml(it.q) + '</span>' +
          '<span class="spb-faq-mark"></span>' +
        '</summary>' +
        '<div class="spb-faq-a">' + escapeHtml(it.a) + '</div>' +
        '</details>';
    }).join('');
    return '<div class="spb-faq">' +
      '<div class="spb-section-head"><span class="spb-section-h3">' + escapeHtml(head) + '</span></div>' +
      body +
      '</div>';
  }

  function rNutritionFacts(b, L) {
    var PARENT = ['energy', 'total fat', 'fat', 'carbohydrate', 'carbohydrates', '能量', '脂肪', '总脂肪', '碳水化合物'];
    var CHILD = ['saturated', 'saturated fat', 'unsaturated', 'unsaturated fat', 'sugars', '饱和脂肪', '不饱和脂肪', '糖'];
    function classify(label) {
      var k = String(label || '').trim().toLowerCase();
      if (PARENT.indexOf(k) >= 0) return 'parent';
      if (CHILD.indexOf(k) >= 0) return 'child';
      return 'normal';
    }
    var rows = (Array.isArray(b.rows) ? b.rows : []).map(function (r) {
      return {
        label: pickLang(r.label_en, r.label_cn, L),
        value: r.value || '',
        kind: classify((r.label_en || '').trim() || (r.label_cn || '').trim()),
      };
    }).filter(function (r) { return r.label || r.value; });
    if (!rows.length) return '';
    var basis = pickLang(b.basis_en, b.basis_cn, L) || '';
    var title = L === 'cn' ? '营养成分' : 'Nutrition';
    var body = rows.map(function (nr) {
      var cls = 'spb-nrow' + (nr.kind === 'parent' ? ' bold' : '') + (nr.kind === 'child' ? ' child' : '');
      return '<div class="' + cls + '">' +
        '<span class="spb-nrow-l">' + escapeHtml(nr.label) + '</span>' +
        '<span class="spb-nrow-r">' + escapeHtml(nr.value) + '</span>' +
        '</div>';
    }).join('');
    return '<div class="spb-nutrition"><div class="spb-nut-card">' +
      '<div class="spb-nut-top">' +
        '<span class="spb-nut-ttl">' + escapeHtml(title) + '</span>' +
        (basis ? '<span class="spb-nut-basis">' + escapeHtml(basis) + '</span>' : '') +
      '</div>' +
      body +
      '</div></div>';
  }

  // type -> { fn, cls }. cls is the wrapper modifier (spb-<cls>).
  var RENDERERS = {
    spec_strip:        { fn: rSpecStrip,        cls: 'spec_strip' },
    hero_intro:        { fn: rHeroIntro,        cls: 'hero_intro' },
    why:               { fn: rWhy,              cls: 'why' },
    ingredients_chips: { fn: rIngredientsChips, cls: 'ingredients_chips' },
    ingredients_line:  { fn: rIngredientsLine,  cls: 'ingredients_line' },
    allergen_card:     { fn: rAllergenCard,     cls: 'allergen_card' },
    how_to_use:        { fn: rHowToUse,         cls: 'how_to_use' },
    storage_box:       { fn: rStorageBox,       cls: 'storage_box' },
    notes_callout:     { fn: rNotesCallout,     cls: 'notes_callout' },
    big_stat:          { fn: rBigStat,          cls: 'big_stat' },
    stat_callout:      { fn: rBigStat,          cls: 'big_stat' },
    callout_banner:    { fn: rCalloutBanner,    cls: 'callout_banner' },
    pull_quote:        { fn: rPullQuote,        cls: 'pull_quote' },
    image_band:        { fn: rImageBand,        cls: 'image_band' },
    recipe_steps:      { fn: rRecipeSteps,      cls: 'recipe_steps' },
    faq:               { fn: rFaq,              cls: 'faq' },
    nutrition_facts:   { fn: rNutritionFacts,   cls: 'nutrition_facts' },
  };

  function renderOne(b, L) {
    if (!b || typeof b !== 'object') return '';
    var def = RENDERERS[b.type];
    if (!def) return '';                       // unknown type -> drop, no crash
    var inner;
    try { inner = def.fn(b, L); } catch (e) { inner = ''; }
    if (!inner) return '';
    var style = blockStyle(b);
    return '<div class="spb spb-' + def.cls + '"' +
      (style ? ' style="' + attr(style) + '"' : '') + '>' + inner + '</div>';
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function render(blocks, opts) {
    var L = (opts && opts.lang === 'cn') ? 'cn' : 'en';
    var arr = blocks;
    if (typeof arr === 'string') {
      try { arr = JSON.parse(arr); } catch (e) { arr = []; }
    }
    if (!Array.isArray(arr)) return '';
    var html = arr.map(function (b) { return renderOne(b, L); }).filter(Boolean).join('');
    if (!html) return '';
    return '<div class="shop-product-blocks">' + html + '</div>';
  }

  global.ShopProductBlocks = { render: render };

})(typeof window !== 'undefined' ? window : this);
