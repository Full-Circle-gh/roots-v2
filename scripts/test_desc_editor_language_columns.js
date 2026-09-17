#!/usr/bin/env node
/**
 * THE 中文 DESCRIPTION BOX DISAPPEARED, AND THE i18n WALKER WAS THE ONE HIDING IT.
 *
 * Reported from the live admin: a product open in the editor, Description
 * showing the ENGLISH box alone, and the right half of the card empty — no 中文
 * label, no box, nowhere to type the Chinese. Reproduced against the shipped
 * engine in Chromium before anything was changed.
 *
 * THE CAUSE. The Classic description editor is authored as two columns:
 *
 *     <div class="pd-desc-cols">
 *       <div><div class="pd-desc-lang">English</div><div id="pd-rte-en" contenteditable></div></div>
 *       <div><div class="pd-desc-lang">中文</div>   <div id="pd-rte-cn" contenteditable></div></div>
 *     </div>
 *
 * which is, character for character, the shape `tagBlockPair` hunts for: two
 * adjacent same-tag <div>s, one with no Chinese in it and one with no Latin.
 * That rule exists for stacked help text — an English paragraph above its
 * Chinese translation — and it stamps `data-lang-block="en"/"cn"` on the pair
 * so the injected `display:none!important` rule can hide the inactive side.
 * Here the "pair" was not a sentence written twice. It was the two EDITORS, and
 * hiding one of them left an operator with no box for the other language: in
 * English the 中文 box, in 中文 the English box. Same defect as the Finance
 * drill-downs (see the `data-no-i18n` notes in 22-finance.js) — the walker
 * mistaking data for markup — one screen further along.
 *
 * WHY IT LOOKED INTERMITTENT, which is why it survived. On a fresh load both
 * boxes are empty, so the CN wrapper's text is just "中文" — two characters,
 * under `tagBlockPair`'s six-character floor — and nothing is stamped. Opening
 * a product fills the boxes, but the MutationObserver only ever hands
 * `processSubtree` the <p>s that were inserted, never the wrappers above them.
 * It took the LANGUAGE TOGGLE: `applyLang` ends with
 * `processSubtree(document.body)`, a full re-walk, and THAT is the pass that
 * sees a filled CN wrapper beside a filled EN one and stamps them. The stamp
 * then sticks until reload. Open a product, press the toggle, and a box is gone.
 *
 * TWO GUARDS, AND BOTH ARE LOAD-BEARING. Verified in Chromium one at a time:
 *
 *   `[contenteditable]` in `isStructuralBlock` stops the two COLUMNS being
 *   paired. A rich-text box is interactive chrome for the same reason a <button>
 *   is — and it is only missing from that list because the admin's two
 *   contenteditables were written after it. With this alone the columns come
 *   back.
 *
 *   `data-no-i18n` on `.pd-desc-cols` stops the walker INSIDE the boxes, which
 *   the first guard does not reach. Without it a merchant who writes an English
 *   paragraph and a Chinese one in the same box loses the Chinese one to the
 *   same pairing rule, and — worse, because it is saved back to the product —
 *   `processNode` splits any line on its first " · " when the right half is
 *   Chinese, so "Made fresh · 每日新鲜" was silently cut down to "Made fresh"
 *   in the editor. Measured: with the attribute the line survives whole; with
 *   only the engine fix it does not.
 *
 * WHAT THIS FILE ASSERTS. The engine's own `isStructuralBlock` / `isENBlock` /
 * `isCNBlock` / `inSkippedContext` / `tagBlockPair` are sliced out of BOTH
 * shipped copies and run against a small DOM stub that reproduces the two
 * columns — the bug the way it would be seen, not a grep for the fix. It also
 * holds the two copies to being the same text, because the authoritative engine
 * is inline in retail-admin.html and the fallback in 10-extras.js, and a fix
 * applied to one of them is a fix that is half there.
 *
 * No browser: the stub is twenty lines and the shard stays fast.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const EXTRAS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '10-extras.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

/* Slice a `function name(...) { ... }` out of a source by brace balance. The
   engine is an IIFE inside a <script> in one case and inside a module in the
   other, so there is nothing to require — and copying the functions into this
   file would test the copy. */
function fnSource(src, name, label) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`function ${name} not found in ${label}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name} in ${label}`);
}

const NEEDED = ['inSkippedContext', 'isCNBlock', 'isENBlock', 'isStructuralBlock', 'tagBlockPair'];

function loadEngine(src, label) {
  const code = NEEDED.map((n) => fnSource(src, n, label)).join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(code + '\nthis.__fns = { ' + NEEDED.join(', ') + ' };', ctx);
  return ctx.__fns;
}

/* ── The DOM stub ──────────────────────────────────────────────────────────
   Only what these five functions actually touch: tagName, textContent, dataset,
   parentElement, the two element siblings, namespaceURI, and a querySelector
   that understands the one selector list in isStructuralBlock (bare tag names
   and `[attr]` presence). Deliberately small — a stub that grows features is a
   stub that starts having opinions of its own. */
function el(tag, opts = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    dataset: Object.assign({}, opts.dataset),
    attrs: Object.assign({}, opts.attrs),
    text: opts.text || '',
    children: [],
    parentElement: null,
  };
  (opts.children || []).forEach((c) => { c.parentElement = node; node.children.push(c); });
  Object.defineProperty(node, 'textContent', {
    get() { return this.text + this.children.map((c) => c.textContent).join(''); },
  });
  Object.defineProperty(node, 'previousElementSibling', {
    get() {
      const p = this.parentElement; if (!p) return null;
      return p.children[p.children.indexOf(this) - 1] || null;
    },
  });
  Object.defineProperty(node, 'nextElementSibling', {
    get() {
      const p = this.parentElement; if (!p) return null;
      return p.children[p.children.indexOf(this) + 1] || null;
    },
  });
  node.querySelector = function (sel) {
    const toks = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const hit = (n) => toks.some((t) => (t.startsWith('[')
      ? Object.prototype.hasOwnProperty.call(n.attrs, t.slice(1, -1))
      : n.tagName === t.toUpperCase()));
    const walk = (n) => {
      for (const c of n.children) { if (hit(c)) return c; const d = walk(c); if (d) return d; }
      return null;
    };
    return walk(this);
  };
  return node;
}

/* The description editor as retail-admin.html authors it, with both boxes
   filled the way pdOpen() fills them from a saved product. `guard` mirrors the
   `data-no-i18n` on the real wrapper. */
function descEditor({ guard, enText, cnText }) {
  const enBox = el('div', { attrs: { contenteditable: 'true' }, text: enText });
  const cnBox = el('div', { attrs: { contenteditable: 'true' }, text: cnText });
  const enCol = el('div', { children: [el('div', { text: 'English' }), enBox] });
  const cnCol = el('div', { children: [el('div', { text: '中文' }), cnBox] });
  const cols = el('div', {
    attrs: guard ? { 'data-no-i18n': '' } : {},
    dataset: guard ? { noI18n: '' } : {},
    children: [enCol, cnCol],
  });
  return { cols, enCol, cnCol };
}

const COPIES = [
  ['retail-admin.html (authoritative, inline)', HTML],
  ['retail-admin/10-extras.js (fallback)', EXTRAS],
];

for (const [label, src] of COPIES) {
  section(label);
  const fns = loadEngine(src, label);

  /* THE BUG. Both boxes filled, the walker offered the Chinese column exactly
     as applyLang's full-body re-walk offers it. Before the fix this stamped the
     pair and the column went to display:none. */
  {
    const { enCol, cnCol } = descEditor({
      guard: true,
      enText: 'Explore our house-made dips.',
      cnText: '一次尝遍多种自制酱料。',
    });
    fns.tagBlockPair(cnCol);
    yes(!cnCol.dataset.langBlock && !enCol.dataset.langBlock,
      'the two description columns are never stamped as a translation pair',
      `EN=${enCol.dataset.langBlock || '-'} CN=${cnCol.dataset.langBlock || '-'}`);
  }

  /* The engine guard on its own, with the markup attribute removed: the columns
     must still survive, because the attribute and the guard fix different
     halves and neither is the other's backup. */
  {
    const { enCol, cnCol } = descEditor({
      guard: false,
      enText: 'Explore our house-made dips.',
      cnText: '一次尝遍多种自制酱料。',
    });
    fns.tagBlockPair(cnCol);
    yes(!cnCol.dataset.langBlock && !enCol.dataset.langBlock,
      'isStructuralBlock alone keeps the columns, with no data-no-i18n on the wrapper',
      `EN=${enCol.dataset.langBlock || '-'} CN=${cnCol.dataset.langBlock || '-'}`);
    yes(fns.isStructuralBlock(cnCol),
      'a column holding a contenteditable box counts as interactive chrome');
  }

  /* Mirror case: the operator working in 中文 lost the ENGLISH box to the same
     stamp, so assert the pairing is refused when offered from that side too. */
  {
    const { enCol, cnCol } = descEditor({
      guard: true,
      enText: 'Explore our house-made dips.',
      cnText: '一次尝遍多种自制酱料。',
    });
    fns.tagBlockPair(cnCol);
    fns.tagBlockPair(enCol);
    yes(!enCol.dataset.langBlock,
      'the English column is not stamped either — the 中文 operator keeps its box');
  }

  /* The wrapper attribute closes the walker out of what the merchant typed. A
     <p> inside a box is what the MutationObserver actually hands over, and the
     guard has to hold from there, where isStructuralBlock cannot see the box. */
  {
    const { cols } = descEditor({ guard: true, enText: '', cnText: '' });
    const box = cols.children[0].children[1];
    const enP = el('p', { text: 'Explore our house-made dips.' });
    const cnP = el('p', { text: '一次尝遍多种自制酱料。' });
    [enP, cnP].forEach((p) => { p.parentElement = box; box.children.push(p); });
    fns.tagBlockPair(cnP);
    yes(!cnP.dataset.langBlock && !enP.dataset.langBlock,
      'a Chinese paragraph the merchant typed beside an English one stays visible',
      `EN=${enP.dataset.langBlock || '-'} CN=${cnP.dataset.langBlock || '-'}`);
    yes(fns.inSkippedContext(cnP),
      'data-no-i18n on the wrapper reaches a paragraph inside a box');
  }

  /* AND THE RULE STILL WORKS. A guard that turned pairing off everywhere would
     pass every assertion above and break the stacked help text this heuristic
     was written for, so prove the ordinary case is untouched. */
  {
    const enHelp = el('div', { text: 'Keep the languages apart: English on the left.' });
    const cnHelp = el('div', { text: '请分开填写:左边英文,右边中文。' });
    el('div', { children: [enHelp, cnHelp] });
    fns.tagBlockPair(cnHelp);
    yes(cnHelp.dataset.langBlock === 'cn' && enHelp.dataset.langBlock === 'en',
      'genuine stacked help text is still paired and still collapses to one language',
      `EN=${enHelp.dataset.langBlock || '-'} CN=${cnHelp.dataset.langBlock || '-'}`);
  }
}

/* ── The two copies must not drift ─────────────────────────────────────────
   The engine ships twice on purpose (inline for first paint, module as the
   fallback when the inline one is removed or throws). A fix landing in one of
   them is a fix that is present until the day the other runs. */
section('the inline engine and its fallback copy agree');
for (const name of NEEDED) {
  const a = fnSource(HTML, name, 'retail-admin.html');
  const b = fnSource(EXTRAS, name, '10-extras.js');
  yes(a === b, `${name}() is identical in both copies`,
    a === b ? '' : 'inline and fallback have diverged — fix both or neither');
}

/* ── The markup carries the guard ──────────────────────────────────────────
   Asserted on the real file, because the stub above can only prove what the
   attribute DOES, never that anybody put it there. */
section('retail-admin.html markup');
{
  const m = HTML.match(/<div class="pd-desc-cols"([^>]*)>/);
  yes(!!m, 'the description columns are still in the markup under .pd-desc-cols');
  yes(!!m && /\bdata-no-i18n\b/.test(m[1]),
    '.pd-desc-cols carries data-no-i18n',
    m ? `found: <div class="pd-desc-cols"${m[1]}>` : '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
