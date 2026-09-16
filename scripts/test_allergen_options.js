// The allergen card: what it offers, and what it already says when empty.
//
// THIS IS THE ONE BLOCK ON THE PRODUCT PAGE WHERE A WRONG WORD HAS A
// CONSEQUENCE, so two different things are held here.
//
// 1. PEANUTS AND TREE NUTS ARE SEPARATE ALLERGENS. Somebody allergic to
//    peanuts is often fine with almonds, and the reverse. The catalogue had
//    five words for nuts — `Nuts` 55, `Tree nuts` 36, `Other tree nuts` 15,
//    `Other nuts` 14, `Peanuts` 7 — and a customer reading `Nuts` cannot tell
//    which they are being warned about. Ash was asked about this one
//    specifically rather than having it decided from usage counts.
//
// 2. "NONE DECLARED" IS ALREADY BUILT IN, ON EVERY SURFACE. `lib/product-
//    blocks-read.js`, `public/shop/product-blocks.js` and the mini app's
//    product-blocks component each print `None declared` / `未声明` when the
//    contains row is blank. 66 cards type it by hand anyway — 43 as `None
//    declared`, 15 as `None`, 8 as `No known allergens` — which produces a
//    CHIP saying what the empty state would have said quietly. The three
//    surfaces must keep agreeing on that wording, or a product reads one way
//    on the counter menu and another in the app, which is exactly the
//    difference a customer with an allergy would notice.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');
const READ = fs.readFileSync(path.join(ROOT, 'lib/product-blocks-read.js'), 'utf8');
const SHOP = fs.readFileSync(path.join(ROOT, 'public/shop/product-blocks.js'), 'utf8');
const MINI = fs.readFileSync(path.join(ROOT, 'miniapp/components/product-blocks/product-blocks.js'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index, i);
}
const anchored = (src, n) => {
  const b = fnBody(src, n);
  assert.ok(b, `${n}() not found — the anchor moved, so this check proves nothing`);
  return b;
};
function literal(name) {
  const head = 'const ' + name + ' = ';
  const at = SRC.indexOf(head);
  assert.ok(at >= 0, name + ' is gone');
  const open = SRC.indexOf('[', at);
  let i = open, depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '[') depth++;
    else if (SRC[i] === ']') { depth--; if (!depth) break; }
  }
  return new Function('return ' + SRC.slice(open, i + 1) + ';')();
}

const LIST = literal('PA_ALLERGENS');

section('The decision with a consequence');

check('Peanuts and Tree nuts are both offered, separately', () => {
  const ens = LIST.map(a => a.en.toLowerCase());
  assert.ok(ens.includes('peanuts'), 'Peanuts is no longer offered');
  assert.ok(ens.includes('tree nuts'), 'Tree nuts is no longer offered');
});

check('the bare word "Nuts" is NOT offered', () => {
  /* It is the most-used word in the catalogue (55 cards) and most-used-wins
     does NOT apply here — Ash was asked about this one specifically. A
     customer reading "Nuts" cannot tell whether it means the thing they
     react to. */
  const ens = LIST.map(a => a.en.toLowerCase().trim());
  assert.ok(!ens.includes('nuts'),
    '"Nuts" is back in the allergen list. It was excluded deliberately: it does not tell a ' +
    'customer whether they are being warned about peanuts or tree nuts.');
  assert.ok(!ens.includes('other nuts') && !ens.includes('other tree nuts'),
    'an "Other …" variant is offered — those only make sense beside a named nut and belong in free text');
});

check('every term carries both languages', () => {
  assert.ok(LIST.length >= 6, 'the allergen list has shrunk below what the catalogue names');
  for (const a of LIST) {
    assert.ok(a.en && a.en.trim(), 'an allergen has no English');
    assert.ok(a.cn && a.cn.trim(), `"${a.en}" has no 中文 — a half-filled allergen line is the worst case here`);
    assert.ok(/[一-鿿]/.test(a.cn), `"${a.en}": "${a.cn}" has no CJK`);
  }
});

check('no term is offered twice', () => {
  const ens = LIST.map(a => a.en.toLowerCase());
  assert.strictEqual(new Set(ens).size, ens.length, 'an allergen is offered twice');
  const cns = LIST.map(a => a.cn);
  assert.strictEqual(new Set(cns).size, cns.length, 'two allergens share a 中文 term');
});

section('A chip ADDS. It can never take an allergen away.');

check('the handler only ever appends', () => {
  /* Un-ticking a checkbox against a free-form comma string would have to
     decide what to delete from `Tree nuts (hazelnuts)`. That is how an
     allergen line gets silently truncated, so there is no removal path at
     all — the text stays editable underneath and a person does the deleting. */
  const b = anchored(SRC, 'paAllergenAdd');
  assert.ok(!/\.splice\(|delete /.test(b),
    'paAllergenAdd has grown a removal path — an allergen must never be dropped by a click');
  /* .filter(Boolean) on the READ path drops empty strings between separators
     and is fine. Any other filter is choosing which terms survive. */
  const filters = (b.match(/\.filter\(([^)]*)\)/g) || []);
  for (const f of filters) {
    assert.strictEqual(f, '.filter(Boolean)',
      `paAllergenAdd filters the terms with ${f} — that decides which allergens survive a click`);
  }
  /* One .replace is legitimate and only one: trimming a separator somebody
     left dangling at the end of the field. Any other rewrite of the value is
     a way for a term to disappear, so the count is pinned rather than the
     shape. */
  const replaces = (b.match(/\.replace\(/g) || []).length;
  assert.strictEqual(replaces, 1,
    `paAllergenAdd rewrites the field ${replaces} times; only the trailing-separator trim is expected`);
  assert.ok(/\.replace\(\/\[,、，\]\\s\*\$\//.test(b),
    'the one rewrite is no longer the trailing-separator trim — check what it does before relaxing this');
  assert.ok(/el\.value = /.test(b), 'the handler no longer writes the field');
  /* NAMING THE FORBIDDEN METHODS IS NOT ENOUGH, learned by a mutation that
     walked past the list above: `v.split(term).join('')` removes a term using
     nothing this check had heard of. So the real invariant is pinned instead —
     THE FIELD IS ASSIGNED EXACTLY ONCE, inside push(), where the only thing
     that can happen to it is growing. A second assignment anywhere is a second
     thing that can happen to an allergen line. */
  const writes = (b.match(/\.value\s*=[^=]/g) || []).length;
  assert.strictEqual(writes, 1,
    `paAllergenAdd assigns the field ${writes} times; only push() may write it, and push() only appends`);
});

check('adding a term twice is a no-op, not a duplicate', () => {
  const b = anchored(SRC, 'paAllergenAdd');
  assert.ok(/have\.includes\(/.test(b), 'the handler does not check whether the term is already there');
  assert.ok(/toLowerCase\(\)/.test(b), 'the duplicate check is case-sensitive, so "Soy" and "soy" both land');
});

check('it fills BOTH languages, with each one’s own separator', () => {
  const b = anchored(SRC, 'paAllergenAdd');
  assert.ok(/push\(enI, en, ', '\)/.test(b), 'the English separator is not the comma the catalogue uses');
  assert.ok(/push\(cnI, cn, '、'\)/.test(b), 'the 中文 separator is not the 、 the catalogue uses');
  const split = /function _paSplitChips[^\n]*\n?/.exec(SRC) || [''];
  const line = SRC.slice(SRC.indexOf('function _paSplitChips'), SRC.indexOf('function _paSplitChips') + 200);
  assert.ok(/,、，/.test(line),
    'the splitter no longer reads both separators, so one language would render as a single chip');
});

check('each row fills only itself', () => {
  const b = anchored(SRC, 'paAllergenAdd');
  assert.ok(/closest\(['"`]\[data-pickscope\]['"`]\)/.test(b),
    'paAllergenAdd is not scoped — a chip in the may-contain row would write the contains row');
  assert.ok(!/document\.querySelector/.test(b), 'an unscoped document query is back');
});

section('"None declared" is built in, and the three surfaces must agree');

check('every surface prints the same empty state', () => {
  /* The counter menu, the web shop and the mini app each own a copy of this
     string. A product with a blank contains row reads the same on all three
     or it reads differently to a customer deciding whether they can eat it. */
  for (const [name, src] of [['lib/product-blocks-read.js', READ],
                             ['public/shop/product-blocks.js', SHOP],
                             ['miniapp/components/product-blocks', MINI]]) {
    assert.ok(/None declared/.test(src), `${name} no longer prints "None declared" for a blank contains row`);
    assert.ok(/未声明/.test(src), `${name} no longer prints 未声明 for a blank contains row`);
  }
});

check('the editor does not offer a fourth way to say it', () => {
  /* 66 cards type it by hand — `None declared` 43, `None` 15, `No known
     allergens` 8 — each producing a CHIP that says what the empty state says
     quietly. Offering it as a term would add a fifth. */
  const ens = LIST.map(a => a.en.toLowerCase());
  for (const bad of ['none', 'none declared', 'no known allergens']) {
    assert.ok(!ens.includes(bad),
      `"${bad}" is offered as an allergen term — leaving the row blank already prints it, ` +
      'and a chip saying it duplicates the empty state');
  }
});

check('the editor SAYS that blank is the way to declare nothing', () => {
  const body = anchored(SRC, '_paBlockEditorBody');
  const card = body.slice(body.indexOf("b.type === 'allergen_card'"));
  const cut = card.indexOf("b.type === 'how_to_use'");
  const block = cut > 0 ? card.slice(0, cut) : card;
  assert.ok(/None declared/.test(block) && /未声明/.test(block),
    'the allergen form no longer tells the office that an empty row already says "None declared"');
  assert.ok(/Peanuts and tree nuts are separate/.test(block),
    'the form no longer explains why "Nuts" is not on offer, so the next person will add it back');
});

section('Nothing rewrites a live card');

check('the list is consulted at edit time only', () => {
  for (const fn of ['peMount', 'paBlocksCollect']) {
    assert.ok(!/PA_ALLERGENS/.test(anchored(SRC, fn)),
      `${fn} consults the allergen list — the 55 cards that say "Nuts" must keep saying it`);
  }
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
