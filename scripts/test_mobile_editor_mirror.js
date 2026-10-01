#!/usr/bin/env node
/**
 * §325 M3 — THE DESKTOP INSPECTOR, MIRRORED ON THE PHONE.
 *
 *   node scripts/test_mobile_editor_mirror.js
 *
 * The phone page editor's sheet offered a curated handful of text fields per
 * block; everything else (sizes, behaviour, pickers, review and store lists,
 * a bundle's variants) was "tuned on desktop". The editor underneath now reads
 * its own inspector for the selected block (cms.html fcFormSnapshot) and the
 * phone draws it, every tap driving the very control it copies.
 *
 * No browser: the desktop's own form helpers (field, inspectorSection, txt,
 * num, txtPair, sel) and a real block form (buildReviewForm) are RUN against a
 * small stand-in DOM below, so the snapshot is taken of what the desktop
 * really builds. What it pins:
 *   1. the snapshot: sections, fields with label and hint, every control kind,
 *      in order, in the editor's language; colours, layout choices, Show on /
 *      Frame, data-mirror-skip and Delete left out; pickers by registration;
 *   2. the bridge: a phone tap sets the control and fires its own events, so
 *      the desktop's own handler writes (clamps and all); a stale tap is
 *      refused; values are read live when sent;
 *   3. the phone: each node drawn and each write's message;
 *   4. the sheet's own controls (coupon, pictures, links) keep their place.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CD = fs.readFileSync(path.join(ROOT, 'public/cms.html'), 'utf8');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');

let passed = 0, failed = 0;
const queue = [];
function section(t) { queue.push(() => console.log('\n' + t)); }
function it(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
const slice = (src, a, b) => {
  const s = src.indexOf(a), e = src.indexOf(b, s + 1);
  if (s < 0 || e < 0) throw new Error('slice not found: ' + a);
  return src.slice(s, e);
};
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ── A small stand-in DOM: enough of Element for the desktop's form helpers
      and the snapshot. innerHTML is kept as text (never parsed): the helpers
      only use it for icons and for wrappers the snapshot reads by class. */
class Txt { constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; } get textContent() { return this.nodeValue; } }
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { const want = on === undefined ? !this.set.has(c) : !!on; want ? this.set.add(c) : this.set.delete(c); return want; }
}
class El extends EventTarget {
  constructor(tag) {
    super();
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null;
    this.classList = new ClassList(this); this.dataset = {}; this.style = {}; this.attrs = {}; this._html = '';
    this.hidden = false; this._value = ''; this.checked = false; this.type = ''; this.placeholder = ''; this._mm = { min: '', max: '', step: '' };
    this.title = ''; this.disabled = false; this.rows = 0; this.maxLength = -1; this.selected = false; this.name = ''; this.tabIndex = 0;
  }
  // As in a browser, an input's min / max / step read back as text.
  get min() { return this._mm.min; } set min(v) { this._mm.min = String(v); }
  get max() { return this._mm.max; } set max(v) { this._mm.max = String(v); }
  get step() { return this._mm.step; } set step(v) { this._mm.step = String(v); }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get previousElementSibling() { if (!this.parentNode) return null; const c = this.parentNode.children; return c[c.indexOf(this) - 1] || null; }
  get nextElementSibling() { if (!this.parentNode) return null; const c = this.parentNode.children; return c[c.indexOf(this) + 1] || null; }
  get isConnected() { return true; }
  appendChild(c) { if (c.parentNode) c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1); c.parentNode = this; this.childNodes.push(c); return c; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = [new Txt(v)]; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.childNodes = []; parseInto(this, this._html); }
  insertAdjacentHTML() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((s) => {
      if (s.startsWith('.')) return this.classList.contains(s.slice(1));
      return this.tagName === s.toUpperCase();
    });
  }
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
  _all() { const out = []; const rec = (n) => n.children.forEach((c) => { out.push(c); rec(c); }); rec(this); return out; }
  querySelectorAll(sel) {
    if (sel.startsWith(':scope > ')) { const s = sel.slice(9); return this.children.filter((c) => c.matches(s)); }
    return this._all().filter((c) => c.matches(sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { this.dispatchEvent(new Event('click')); }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get value() {
    if (this.tagName === 'SELECT') { const o = this.options; const s = o.find((x) => x.selected) || o[0]; return s ? s.value : ''; }
    return this._value;
  }
  set value(v) {
    if (this.tagName === 'SELECT') { this.options.forEach((o) => { o.selected = String(o.value) === String(v); }); return; }
    this._value = String(v);
  }
}
// Just enough HTML for what the forms set through innerHTML: tags with a
// class, text, and the void / self-closed SVG parts.
const VOID = new Set(['br', 'img', 'input', 'path', 'circle', 'line', 'polyline', 'rect', 'hr']);
function parseInto(root, html) {
  const stack = [root];
  const re = /<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>\/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[5] != null) { const t = new Txt(m[5]); t.parentNode = top; top.childNodes.push(t); continue; }
    const el = new El(m[2]);
    const cls = /\sclass="([^"]*)"/.exec(m[3] || ''); if (cls) el.className = cls[1];
    top.appendChild(el);
    if (!(m[4] || VOID.has(m[2].toLowerCase()))) stack.push(el);
  }
}
const documentStub = { createElement: (t) => new El(t), createTextNode: (v) => new Txt(v), activeElement: null };

/* ── The desktop's own code, sliced out of cms.html ─────────────────────── */
const DESK = [
  slice(CD, 'const FIELD_INFO_SVG', '// Floating, viewport-clamped tooltip'),
  slice(CD, 'const inspectorOpen = ', 'function txt(value'),
  slice(CD, 'function txt(value', '// Single-language picker'),
  slice(CD, 'function pickLang(en, cn) {', 'function biLabel('),
  slice(CD, 'function splitT(label) {', '// Switch tooltip text'),
  slice(CD, 'function sel(value, options, onChange) {', '// Per-render registry of the colour controls'),
  slice(CD, '/* ── §325 M3 · THE INSPECTOR, MIRRORED FOR THE PHONE', '// Custom colour picker'),
  slice(CD, '// Migrate legacy single-review blocks', '// ── §296 · Promo cards'),
].join('\n');
const BRIDGE_LIVE = slice(CD, "  // §325 M3 — the inspector's controls (fcFormSnapshot), with each value read", '  const schedulePost = ');
const BRIDGE_CMDS = slice(CD, "        case 'ctl': {", "        case 'getState':");

function mkDesk(opts = {}) {
  const updates = [], posted = [];
  let inspectorRenders = 0;
  const ctx = {
    document: documentStub, Event, Object, Array, String, Number, Math, Set, Map, JSON, Promise,
    state: { lang: opts.lang || 'en', draft: [], selectedId: 'b1', designVariants: [] },
    B: (en, cn) => `<span class="i18n-en">${en}</span><span class="i18n-cn">${cn}</span>`,
    ICONS: { x: '<svg></svg>' },
    BRAND_COLOR_OPTIONS: [{ value: 'ink', label: 'Ink · 墨黑' }, { value: 'lime-leaf', label: 'Lime · 青柠' }],
    BTN_COLOR_OPTIONS: [{ value: '', label: 'Default · 默认' }, { value: 'ink', label: 'Ink · 墨黑' }, { value: 'lime-leaf', label: 'Lime · 青柠' }],
    dcResolveHex: (v) => (v === 'ink' || v === 'lime-leaf' ? '#111111' : null),
    colorSelect: () => { const e = new El('div'); e.className = 'color-select'; return e; },
    imgPicker: (url, onSet) => { const c = new El('div'); c.className = 'img-picker'; ctx.fcPickReg({ kind: 'image', el: c, value: url || '', set: (u) => onSet({ url: u, aspect: null }) }); return c; },
    updateBlock: (id, patch) => updates.push({ how: 'render', id, patch }),
    updateBlockSilent: (id, patch) => updates.push({ how: 'silent', id, patch }),
    renderPreview: () => {},
    renderInspector: () => { inspectorRenders++; },
    POST: (m) => posted.push(m),
    selectedBlock: () => ({ id: 'b1' }),
    schedulePost: () => {},
  };
  ctx.T = (en, cn) => (ctx.state.lang === 'cn' ? cn : en);
  vm.createContext(ctx);
  vm.runInContext(DESK + '\nthis.setBuf = (v) => { __fcPickRegBuf = v; };\nthis.fcPickReg = fcPickReg; this.field = field; this.inspectorSection = inspectorSection; this.fcSkip = fcSkip;' +
    '\nthis.txt = txt; this.num = num; this.txtPair = txtPair; this.sel = sel; this.buildReviewForm = buildReviewForm; this.fcFormSnapshot = fcFormSnapshot;' +
    '\n' + BRIDGE_LIVE + '\nthis.fcLive = fcLive; this.postForm = postForm;' +
    '\nthis.run = async (d) => { switch (d.cmd) {\n' + BRIDGE_CMDS + '} };', ctx);
  return { ctx, updates, posted, inspectorRenders: () => inspectorRenders };
}
// Builds the inspector body the way renderInspector does: registries on, the
// form, the universal chrome sections, then the snapshot.
function snap(d, build) {
  const body = new El('div');
  d.ctx.setBuf([]);
  build(body);
  d.ctx.fcFormSnapshot(body);
  d.ctx.setBuf(null);
  return body;
}
const kinds = (nodes) => nodes.map((n) => n.k + (n.items ? '[' + kinds(n.items) + ']' : ''));

section('1 · the snapshot of a real form (the review card)');
{
  const REV = { id: 'b1', type: 'review_card', view: 'carousel', kicker_en: 'Loved by', kicker_cn: '好评',
    reviews: [{ rating: 4, quote_en: 'Great', quote_cn: '很棒', author_name: 'Linda', author_subline_en: 'Gold', author_subline_cn: '金卡', avatar_url: '/a.png' },
      { rating: 5, quote_en: '', quote_cn: '', author_name: '', author_subline_en: '', author_subline_cn: '', avatar_url: '' }] };
  it('sections and fields in the inspector\'s order; colours and the layout choice left out', () => {
    const d = mkDesk();
    d.ctx.state.draft = [REV];
    snap(d, (body) => {
      d.ctx.buildReviewForm(body, REV);
      // what renderInspector would have captured for the Design sheet
      d.ctx.state.designVariants = [{ el: body.querySelector('.insp-sec-body').querySelector('select') }];
    });
    // the variant set is read at snapshot time, so take it again with it in place
    const body2 = snap(d, (body) => { d.ctx.buildReviewForm(body, REV); d.ctx.state.designVariants = [{ el: body.querySelector('.insp-sec-body').querySelector('select') }]; });
    assert.ok(body2);
    const nodes = d.ctx.state.formNodes;
    assert.deepStrictEqual(plain(nodes.map((n) => n.k + ':' + n.title)), ['sec:Content'], 'Style & layout holds only the layout choice; Colours only colours');
    const content = nodes[0].items;
    assert.deepStrictEqual(plain(content.map((n) => n.k + ':' + (n.label || ''))), ['field:Small heading', 'field:Reviews (2)']);
    assert.deepStrictEqual(plain(kinds(content[0].items)), ['input', 'input']);
    assert.deepStrictEqual(plain(content[0].items.map((n) => [n.tag, n.value, n.placeholder])), [['EN', 'Loved by', 'English'], ['中', '好评', '中文']]);
  });
  it('a list: each entry\'s controls, its remove button by its title, the add button', () => {
    const d = mkDesk();
    d.ctx.state.draft = [REV];
    snap(d, (body) => d.ctx.buildReviewForm(body, REV));
    const list = d.ctx.state.formNodes.find((n) => n.title === 'Content').items[1].items;
    const stars = list.filter((n) => n.k === 'field' && n.label === 'Stars (1–5)');
    assert.strictEqual(stars.length, 2);
    assert.deepStrictEqual(plain(stars[0].items[0]), Object.assign({ k: 'input', type: 'number', value: '4', placeholder: '', min: '1', max: '5', step: '', maxlength: 0, tag: '' }, { i: stars[0].items[0].i }));
    const texts = list.filter((n) => n.k === 'text').map((n) => n.text);
    assert.deepStrictEqual(plain(texts), ['REVIEW 1', 'REVIEW 2'], 'each entry\'s heading, one language');
    const buttons = list.filter((n) => n.k === 'button');
    assert.deepStrictEqual(plain(buttons.map((b) => [b.text, b.danger])), [['Remove this review', true], ['Remove this review', true], ['Add review', false]]);
    const avatar = list.find((n) => n.label === 'Avatar image');
    assert.strictEqual(avatar.help, 'Optional — a round picture next to the name.');
    assert.deepStrictEqual(plain(avatar.items.map((x) => [x.k, x.value])), [['image', '/a.png']]);
    const quote = list.find((n) => n.label === 'Quote');
    assert.deepStrictEqual(plain(quote.items.map((x) => [x.type, x.value, x.rows, x.tag])), [['textarea', 'Great', 3, 'EN'], ['textarea', '很棒', 3, '中']]);
    const author = list.find((n) => n.label === 'Author name');
    assert.deepStrictEqual(plain(author.items.map((x) => [x.type, x.value, x.placeholder])), [['text', 'Linda', 'Linda']]);
  });
  it('in Chinese, the inspector\'s Chinese', () => {
    const d = mkDesk({ lang: 'cn' });
    d.ctx.state.draft = [REV];
    snap(d, (body) => d.ctx.buildReviewForm(body, REV));
    const titles = d.ctx.state.formNodes.map((n) => n.title);
    assert.ok(titles.includes('内容'));
    const list = d.ctx.state.formNodes.find((n) => n.title === '内容').items.find((n) => /^评价/.test(n.label));
    assert.ok(list.items.some((n) => n.label === '星级(1–5)'));
    assert.ok(list.items.some((n) => n.k === 'button' && n.text === '删除此评价'));
  });
}

section('2 · what the snapshot leaves out, and pickers by registration');
{
  it('Show on, Frame, data-mirror-skip, Delete, colour pickers, the layout choice, hidden things', () => {
    const d = mkDesk();
    let layoutSel;
    snap(d, (body) => {
      const lay = d.ctx.inspectorSection(body, 'x', 'layout', 'Style & layout');
      layoutSel = d.ctx.sel('a', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], () => {});
      lay.appendChild(d.ctx.field('Layout', '', layoutSel));
      lay.appendChild(d.ctx.field('Limit', 'How many', d.ctx.num(6, () => {}, { min: 1, max: 24 })));
      d.ctx.inspectorSection(body, 'x', 'show', 'Show on').appendChild(d.ctx.field('Show on', '', d.ctx.sel('both', [{ value: 'both', label: 'Both' }, { value: 'web', label: 'Web' }], () => {})));
      d.ctx.inspectorSection(body, 'x', 'frame', 'Frame').appendChild(d.ctx.field('Frame', '', d.ctx.sel('', [{ value: '', label: 'none' }, { value: 'ink', label: 'Ink · 墨黑' }], () => {})));
      const col = d.ctx.inspectorSection(body, 'x', 'colours', 'Colours');
      col.appendChild(d.ctx.field('Background', '', d.ctx.sel('ink', [{ value: 'ink', label: 'Ink · 墨黑' }, { value: 'lime-leaf', label: 'Lime · 青柠' }], () => {})));
      const con = d.ctx.inspectorSection(body, 'x', 'content', 'Content');
      con.appendChild(d.ctx.fcSkip(d.ctx.field('Coupon', '', d.ctx.sel('', [{ value: '', label: '—' }, { value: '1', label: 'X' }], () => {}))));
      const gone = d.ctx.field('Hidden', '', d.ctx.txt('', () => {})); gone.style.display = 'none'; con.appendChild(gone);
      const dz = new El('div'); dz.className = 'danger-zone'; const del = new El('button'); del.textContent = 'Delete this block'; dz.appendChild(del); body.appendChild(dz);
      d.ctx.state.designVariants = [{ el: layoutSel }];
    });
    assert.deepStrictEqual(plain(d.ctx.state.formNodes.map((n) => [n.title, n.items.map((x) => x.label)])), [['Style & layout', ['Limit']]]);
    const lim = d.ctx.state.formNodes[0].items[0];
    assert.strictEqual(lim.help, 'How many');
    assert.deepStrictEqual([lim.items[0].min, lim.items[0].max, lim.items[0].value], ['1', '24', '6']);
  });
  it('a tick with its label beside it, as the voting block draws them', () => {
    const d = mkDesk();
    let box;
    snap(d, (body) => {
      const sec = d.ctx.inspectorSection(body, 'x', 'behaviour', 'Behaviour');
      const row = new El('div'); row.className = 'field';
      box = new El('input'); box.type = 'checkbox'; box.checked = true;
      const lbl = new El('label'); lbl.textContent = 'Hide block when no matching poll exists';
      row.appendChild(box); row.appendChild(lbl); sec.appendChild(row);
    });
    assert.deepStrictEqual(plain(d.ctx.state.formNodes[0].items[0].items), [{ k: 'check', checked: true, label: 'Hide block when no matching poll exists', i: 0 }]);
  });
  it('a product picker registers its pool and value; it is not read as markup', () => {
    const d = mkDesk();
    snap(d, (body) => {
      const sec = d.ctx.inspectorSection(body, 'x', 'content', 'Content');
      const wrap = new El('div'); wrap.className = 'product-picker';
      const search = new El('input'); search.type = 'text'; wrap.appendChild(search);
      d.ctx.fcPickReg({ kind: 'product', el: wrap, multi: true, value: [7], options: [{ id: 7, name_en: 'Hummus' }], set: () => {} });
      sec.appendChild(d.ctx.field('Products', 'Click to add or remove.', wrap));
    });
    const f = d.ctx.state.formNodes[0].items[0];
    assert.deepStrictEqual(plain(f.items), [{ k: 'product', value: [7], multi: true, suggest: null, options: [{ id: 7, name_en: 'Hummus' }], empty: '', i: 0 }]);
  });
  it('chips, with which are on', () => {
    const d = mkDesk();
    snap(d, (body) => {
      const sec = d.ctx.inspectorSection(body, 'x', 'content', 'Content');
      const chips = new El('div'); chips.className = 'chips';
      for (const [t, on] of [['Ready to Eat', true], ['Fresh', false]]) { const c = new El('div'); c.className = 'chip' + (on ? ' on' : ''); c.textContent = t; chips.appendChild(c); }
      sec.appendChild(d.ctx.field('Categories to show', '', chips));
    });
    assert.deepStrictEqual(plain(d.ctx.state.formNodes[0].items[0].items.map((n) => [n.k, n.text, n.on])), [['chip', 'Ready to Eat', true], ['chip', 'Fresh', false]]);
  });
  it('the desktop pickers really register, and the hero\'s buttons and the coupon\'s own fields are skipped', () => {
    for (const fn of ['productPicker', 'targetPicker', 'imgPicker', 'videoPicker']) {
      const body = slice(CD, 'function ' + fn + '(', '\n}\n');
      assert.ok(/fcPickReg\(\{ kind: '(product|link|image|video)'/.test(body), fn);
    }
    assert.ok(/btnWrap\.dataset\.mirrorSkip = '1';/.test(CD));
    assert.ok(/fcFormSnapshot\(body\);\s*__fcPickRegBuf = null;/.test(CD));
    assert.ok(/if \(window\.__fcPreviewEmbed\) \{ __fcColorRegBuf = \[\]; __fcPickRegBuf = \[\]; \}/.test(CD));
  });
}

section('3 · the bridge drives the very control');
{
  function built() {
    const d = mkDesk();
    const seen = [];
    snap(d, (body) => {
      const sec = d.ctx.inspectorSection(body, 'x', 'content', 'Content');
      sec.appendChild(d.ctx.field('Heading', '', d.ctx.txtPair('a', 'b', (v) => seen.push(['pair', v]))));
      sec.appendChild(d.ctx.field('Columns', '', d.ctx.num(3, (v) => seen.push(['num', v]), { min: 3, max: 5 })));
      sec.appendChild(d.ctx.field('Style', '', d.ctx.sel('x', [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], (v) => seen.push(['sel', v]))));
      const row = new El('div'); row.className = 'field';
      const box = new El('input'); box.type = 'checkbox'; box.addEventListener('change', () => seen.push(['check', box.checked]));
      const lbl = new El('label'); lbl.textContent = 'Tick'; row.appendChild(box); row.appendChild(lbl); sec.appendChild(row);
      const btn = new El('button'); btn.textContent = 'Add review'; btn.addEventListener('click', () => seen.push(['click'])); sec.appendChild(btn);
      const wrap = new El('div'); wrap.className = 'product-picker';
      d.ctx.fcPickReg({ kind: 'product', el: wrap, multi: false, value: null, options: [], set: (v) => seen.push(['product', v]) });
      sec.appendChild(d.ctx.field('Product', '', wrap));
    });
    const flat = []; const rec = (ns) => ns.forEach((n) => { if (n.i != null) flat.push(n); if (n.items) rec(n.items); }); rec(d.ctx.state.formNodes);
    return { d, seen, flat };
  }
  it('typing: the box gets the text and its own input fires — both languages sent, as the pair does', async () => {
    const { d, seen, flat } = built();
    await d.ctx.run({ cmd: 'ctl', i: flat[1].i, k: 'input', value: 'B2' });
    assert.deepStrictEqual(plain(seen), [['pair', { en: 'a', cn: 'B2' }]]);
    assert.strictEqual(d.inspectorRenders(), 0, 'a typed letter does not rebuild the inspector');
  });
  it('a number, a list, a tick, a button: each through its own handler; the inspector is read again', async () => {
    const { d, seen, flat } = built();
    await d.ctx.run({ cmd: 'ctl', i: flat[2].i, k: 'input', value: '9' });
    await d.ctx.run({ cmd: 'ctl', i: flat[3].i, k: 'select', value: 'y' });
    await d.ctx.run({ cmd: 'ctl', i: flat[4].i, k: 'check', value: true });
    await d.ctx.run({ cmd: 'ctl', i: flat[5].i, k: 'button', value: null });
    assert.deepStrictEqual(plain(seen), [['num', 9], ['sel', 'y'], ['check', true], ['click']]);
    assert.strictEqual(d.inspectorRenders(), 3);
  });
  it('a picker: its own setter', async () => {
    const { d, seen, flat } = built();
    await d.ctx.run({ cmd: 'pickSet', i: flat[6].i, k: 'product', value: 7 });
    assert.deepStrictEqual(plain(seen), [['product', 7]]);
  });
  it('a tap meant for another kind of control, or for none, is refused', async () => {
    const { d, seen, flat } = built();
    await d.ctx.run({ cmd: 'ctl', i: flat[3].i, k: 'button', value: null });
    await d.ctx.run({ cmd: 'ctl', i: 99, k: 'input', value: 'x' });
    await d.ctx.run({ cmd: 'pickSet', i: flat[6].i, k: 'image', value: '/x' });
    await d.ctx.run({ cmd: 'pickSet', i: flat[0].i, k: 'input', value: 'x' });
    assert.deepStrictEqual(seen, []);
  });
  it('values are read off the controls when sent, so typed text survives without a rebuild', async () => {
    const { d, flat } = built();
    await d.ctx.run({ cmd: 'ctl', i: flat[0].i, k: 'input', value: 'typed' });
    d.ctx.postForm();
    const sent = d.posted[d.posted.length - 1];
    assert.strictEqual(sent.evt, 'form'); assert.strictEqual(sent.blockId, 'b1');
    assert.strictEqual(sent.nodes[0].items[0].items[0].value, 'typed');
  });
  it('the bridge sends the form with every state, on select, and on getSelected', () => {
    assert.ok(/postState\(\); postSelected\(\); postDesign\(\); postForm\(\);/.test(CD));
    assert.ok(/case 'select':\s+selectBlock\(d\.id\); postSelected\(\); postForm\(\); break;/.test(CD));
    assert.ok(/case 'getSelected':postSelected\(\); postForm\(\); break;/.test(CD));
  });
}

/* ── 4 · the phone ──────────────────────────────────────────────────────── */
const PH = slice(CM, "/* ── §325 · THE COUPON BLOCK'S PICKER", '/* ── §299 · PROMO CARDS, ON THE PHONE');
function pel(tag) {
  const e = {
    tag, html: '', kids: [], controls: {}, style: {}, className: '', textContent: '', disabled: false, lastChild: null,
    set innerHTML(v) { this.html = v; this.kids = []; this.controls = {}; this.lastChild = null; },
    get innerHTML() { return this.html; },
    appendChild(k) { this.kids.push(k); this.lastChild = k; return k; },
    querySelector(sel) {
      const m = sel.match(/\[data-a=([a-z0-9]+)\]/); const k = m && m[1];
      if (!k || !new RegExp('data-a="' + k + '"').test(this.html)) return null;
      if (!this.controls[k]) this.controls[k] = { onclick: null, onchange: null, oninput: null };
      return this.controls[k];
    },
    querySelectorAll() { return []; },
    insertAdjacentHTML(_, h) { this.kids.push({ html: h }); },
  };
  return e;
}
function mkPhone(opts = {}) {
  const sent = [], media = [];
  const ctx = {
    M: { lang: opts.lang || 'en', editId: 'b1', extra: null, frameColors: [], corners: [], targets: null },
    cuT: (en, cn) => (opts.lang === 'cn' ? cn : en),
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    send: (cmd, x) => sent.push({ cmd, x }),
    renderEdit: () => {},
    document: { createElement: (t) => pel(t), activeElement: null },
    Object, String, Array, JSON, Math, Promise, Map, Set, RegExp,
  };
  vm.createContext(ctx);
  vm.runInContext(PH + '\nthis.MEDIA = MEDIA; this.LINKS = LINKS; const _rm = renderMedia; renderMedia = (body, blk, type) => { this.__media.push(type); body.appendChild({ html: "<M2:" + type + ">" }); };', Object.assign(ctx, { __media: media }));
  return { ctx, sent, media };
}
const draw = (ctx, blk, nodes) => { const body = pel(); const placed = ctx.renderMirror(body, blk, blk.type, nodes); return { body, placed }; };

section('4 · the phone draws the tree and sends each tap back');
{
  const NODES = [
    { k: 'sec', title: 'Style & layout', items: [
      { k: 'field', label: 'Limit (max products)', help: 'How many', items: [{ k: 'input', type: 'number', value: '6', min: '1', max: '24', step: '', placeholder: '', tag: '', i: 0 }] },
      { k: 'field', label: '', help: '', items: [{ k: 'check', checked: true, label: 'Hide block when no matching poll exists', i: 1 }] },
    ] },
    { k: 'sec', title: 'Content', items: [
      { k: 'field', label: 'Small heading', help: '', items: [
        { k: 'input', type: 'text', value: 'Hi', placeholder: 'English', tag: 'EN', i: 2 },
        { k: 'input', type: 'text', value: '你好', placeholder: '中文', tag: '中', i: 3 }] },
      { k: 'field', label: 'Source', help: '', items: [{ k: 'select', value: 'manual', options: [{ value: 'category', label: 'By category' }, { value: 'manual', label: 'Hand-picked products' }], i: 4 }] },
      { k: 'field', label: 'Categories to show', help: '', items: [{ k: 'chip', text: 'Ready', on: true, i: 5 }, { k: 'chip', text: 'Fresh', on: false, i: 6 }] },
      { k: 'field', label: 'Reviews (1)', help: '', items: [{ k: 'text', text: 'REVIEW 1' }, { k: 'button', text: 'Remove this review', danger: true, disabled: false, i: 7 }, { k: 'button', text: 'Add review', danger: false, disabled: false, i: 8 }] },
      { k: 'field', label: 'Quote', help: 'Press Enter for a line break.', items: [{ k: 'input', type: 'textarea', value: 'Great', rows: 3, tag: 'EN', placeholder: '', i: 9 }] },
    ] },
  ];
  it('sections, fields, hints, and every control kind, with the inspector\'s words', () => {
    const { ctx } = mkPhone();
    const { body, placed } = draw(ctx, { id: 'b1', type: 'review_card' }, NODES);
    assert.strictEqual(placed, false);
    const [lay, con] = body.kids;
    assert.ok(/<div class="mx-sec-t">Style &amp; layout<\/div>/.test(lay.html));
    const limit = lay.kids[0];
    assert.ok(/<label>Limit \(max products\)<\/label><div class="pc-hint"[^>]*>How many<\/div>/.test(limit.html));
    assert.ok(/<input type="number" data-a="v" min="1" max="24" value="6">/.test(limit.kids[0].html));
    assert.ok(/<input type="checkbox" data-a="v" checked><span>Hide block when no matching poll exists<\/span>/.test(lay.kids[1].kids[0].html));
    const heading = con.kids[0];
    assert.ok(/<span class="mx-tag">EN<\/span><input type="text" data-a="v" placeholder="English" value="Hi">/.test(heading.kids[0].html));
    assert.ok(/<span class="mx-tag">中<\/span>/.test(heading.kids[1].html));
    assert.ok(/<option value="manual" selected>Hand-picked products<\/option>/.test(con.kids[1].kids[0].html));
    const chips = con.kids[2].kids[0];
    assert.strictEqual(chips.className, 'mx-chips');
    assert.deepStrictEqual(chips.kids.map((c) => [c.className, c.textContent]), [['vchip on', 'Ready'], ['vchip', 'Fresh']]);
    const list = con.kids[3];
    assert.deepStrictEqual(list.kids.map((k) => [k.className, k.textContent]), [['mx-text', 'REVIEW 1'], ['pc-btn mx-btn danger', 'Remove this review'], ['pc-btn mx-btn', 'Add review']]);
    assert.ok(/<textarea rows="3" data-a="v">Great<\/textarea>/.test(con.kids[4].kids[0].html));
  });
  it('each tap: ctl with the control\'s number, its kind and its value', () => {
    const { ctx, sent } = mkPhone();
    const { body } = draw(ctx, { id: 'b1', type: 'review_card' }, NODES);
    const [lay, con] = body.kids;
    lay.kids[0].kids[0].controls.v.oninput({ target: { value: '8' } });
    lay.kids[1].kids[0].controls.v.onchange({ target: { checked: false } });
    con.kids[0].kids[1].controls.v.oninput({ target: { value: '您好' } });
    con.kids[1].kids[0].controls.v.onchange({ target: { value: 'category' } });
    con.kids[2].kids[0].kids[1].onclick();
    con.kids[3].kids[2].onclick();
    assert.deepStrictEqual(plain(sent), [
      { cmd: 'ctl', x: { i: 0, k: 'input', value: '8' } },
      { cmd: 'ctl', x: { i: 1, k: 'check', value: false } },
      { cmd: 'ctl', x: { i: 3, k: 'input', value: '您好' } },
      { cmd: 'ctl', x: { i: 4, k: 'select', value: 'category' } },
      { cmd: 'ctl', x: { i: 6, k: 'chip', value: null } },
      { cmd: 'ctl', x: { i: 8, k: 'button', value: null } },
    ]);
  });
  it('a product: one (or none) from a list, the inspector\'s ids sent back', () => {
    const { ctx, sent } = mkPhone();
    const opts = [{ id: 7, name_en: 'Hummus', name_cn: '鹰嘴豆泥', sku: 'H1', is_published: true }, { id: 8, name_en: 'Beet', name_cn: '', sku: '', is_published: false }];
    const { body } = draw(ctx, { id: 'b1', type: 'featured_item' }, [{ k: 'field', label: 'Product', items: [{ k: 'product', multi: false, value: 7, options: opts, i: 0 }] }]);
    const p = body.kids[0].kids[0];
    assert.ok(/<option value="">— none —<\/option><option value="7" selected>Hummus · H1<\/option><option value="8">Beet · DRAFT<\/option>/.test(p.html));
    p.controls.v.onchange({ target: { value: '8' } });
    p.controls.v.onchange({ target: { value: '' } });
    assert.deepStrictEqual(plain(sent), [{ cmd: 'pickSet', x: { i: 0, k: 'product', value: 8 } }, { cmd: 'pickSet', x: { i: 0, k: 'product', value: null } }]);
  });
  it('products: the chosen ones, each removable, and the rest to add', () => {
    const { ctx, sent } = mkPhone();
    const opts = [{ id: 7, name_en: 'Hummus', is_published: true }, { id: 8, name_en: 'Beet', is_published: true }, { id: 9, name_en: 'Kale', is_published: true }];
    const { body } = draw(ctx, { id: 'b1', type: 'product_grid' }, [{ k: 'product', multi: true, value: [9, 7], options: opts, i: 4 }]);
    const p = body.kids[0];
    assert.ok(/<span>Kale<\/span>[\s\S]*<span>Hummus<\/span>/.test(p.html));
    assert.ok(/<select data-a="add"><option value="" selected>— pick one —<\/option><option value="8">Beet<\/option><\/select>/.test(p.html));
    p.controls.rm0.onclick();
    p.controls.add.onchange({ target: { value: '8' } });
    assert.deepStrictEqual(plain(sent.map((s) => s.x.value)), [[7], [9, 7, 8]]);
  });
  it('no products: the inspector\'s own words', () => {
    const { ctx } = mkPhone();
    const { body } = draw(ctx, { id: 'b1', type: 'bundle' }, [{ k: 'product', multi: false, value: null, options: [], empty: 'No bundle products yet.', i: 0 }]);
    assert.ok(/No bundle products yet\./.test(body.kids[0].html));
  });
  it('a picture or link in a list (a review\'s avatar, a store\'s link): the sheet\'s picture and link fields, driving the inspector\'s', () => {
    const { ctx, sent } = mkPhone();
    const { body } = draw(ctx, { id: 'b1', type: 'review_card' }, [
      { k: 'field', label: 'Avatar image', items: [{ k: 'image', value: '/a.png', i: 2 }] },
      { k: 'field', label: 'Button link', items: [{ k: 'link', value: 'about', suggest: 'about', i: 3 }] }]);
    const pic = body.kids[0].kids[0];
    assert.ok(/<img src="\/a\.png"/.test(pic.html) && !/<label>/.test(pic.html), 'the field label is the inspector\'s, drawn once');
    pic.controls.rm.onclick();
    const link = body.kids[1].kids[0];
    link.controls.link.onchange({ target: { value: 'faq' } });
    assert.deepStrictEqual(plain(sent), [{ cmd: 'pickSet', x: { i: 2, k: 'image', value: '' } }, { cmd: 'pickSet', x: { i: 3, k: 'link', value: 'faq' } }]);
  });
  it('a block whose pictures and links the sheet draws itself: the sheet\'s, once, where the inspector\'s first one stands', () => {
    const { ctx, media } = mkPhone();
    const { body, placed } = draw(ctx, { id: 'b1', type: 'video_banner' }, [
      { k: 'field', label: 'Height (px)', items: [{ k: 'input', type: 'number', value: '300', i: 0 }] },
      { k: 'field', label: 'Video clip', items: [{ k: 'video', value: '', i: 1 }] },
      { k: 'field', label: 'Poster (optional)', items: [{ k: 'image', value: '', i: 2 }] },
      { k: 'field', label: 'Tap link (optional)', items: [{ k: 'link', value: '', i: 3 }] }]);
    assert.strictEqual(placed, true);
    assert.deepStrictEqual(media, ['video_banner']);
    assert.deepStrictEqual(body.kids.map((k) => (k.html.match(/<label>([^<]+)<\/label>|<M2:\w+>/) || [])[0]), ['<label>Height (px)</label>', '<M2:video_banner>']);
  });
  it('the sheet routes every block but promo cards through the mirror, the coupon picker first', () => {
    assert.ok(/if \(type === 'coupon_block'\) renderCouponPick\(body, blk\);[^\n]*\n[\s\S]{0,400}if \(form\) placed = renderMirror\(body, blk, type, form\);/.test(CM));
    assert.ok(/M\.form = \{ blockId: d\.blockId, nodes: d\.nodes \|\| \[\] \};\s*if \(M\.editId != null && M\.editId === d\.blockId && !typingInSheet\(\)\) renderEdit\(\);/.test(CM));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
