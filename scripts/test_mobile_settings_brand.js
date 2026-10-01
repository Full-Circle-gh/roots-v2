#!/usr/bin/env node
/**
 * §325 X4 — THE BRAND AND THE BRAND STUDIO, ON THE PHONE.
 *
 *   node scripts/test_mobile_settings_brand.js
 *
 * Two desktop pages the phone did not have: public/backend-brand.html (the
 * logo and the brand name) and public/brand-studio.html (an AI-drafted palette,
 * fonts and Home layout, applied as a DRAFT). Every write is asserted on its
 * method, path and every body field; the studio's option values are read out
 * of the desktop page and compared, because they are what the designer is
 * sent. The phone code is RUN, sliced out of public/m.html into a sandbox with
 * a fake server, a fake file reader and a fake canvas. No browser — fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8');
const STUDIO = fs.readFileSync(path.join(ROOT, 'public/brand-studio.html'), 'utf8');
const BRAND = fs.readFileSync(path.join(ROOT, 'public/backend-brand.html'), 'utf8');

let passed = 0, failed = 0;
const pending = [];
function section(t) { pending.push(() => console.log('\n' + t)); }
function it(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
  });
}
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, 'slice not found: ' + from);
  return src.slice(a, b);
}
function block(src, anchor) {
  const a = src.indexOf(anchor);
  assert.ok(a >= 0, 'not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}
const line = (src, anchor) => { const a = src.indexOf(anchor); assert.ok(a >= 0, anchor); return src.slice(a, src.indexOf('\n', a)); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const SRC = [
  line(M, 'function E(en, zh)'),
  line(M, 'function tmOneLang(m)'),
  slice(M, 'const ROUTE_CAP={', '/* Fail-OPEN on null'),
  slice(M, 'const MCAN_MONEY_ONLY=', '/* NAMED FOR THE JOB'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X1 — WHAT THE SHOP DID', '/* §325 X1 ends */'),
  slice(M, '/* ══════════════════════════════════════════════════════════════════════════\n   §325 X4 — THE BRAND', '/* §325 X4 ends */'),
].join('\n');

function mk(opts = {}) {
  const calls = { api: [], writes: [], toasts: [], renders: 0, timers: [], canvas: null };
  const CMD = {};
  class FakeReader {
    readAsDataURL(f) {
      if (opts.readFails) { this.onerror && this.onerror(); return; }
      this.result = f.data; this.onload && this.onload();
    }
  }
  class FakeImage {
    set src(v) { this._src = v; if (opts.imgFails) { this.onerror && this.onerror(); return; } this.width = opts.w || 2048; this.height = opts.h || 1024; this.onload && this.onload(); }
  }
  const ctx = {
    LANG: opts.lang || 'en', API: '/api/retail-admin',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    ic: (n) => `<i data-ic="${n}"></i>`,
    SUBS: {}, DB: { products: [] },
    state: {
      caps: opts.caps === undefined ? ['settings:shop', 'ai:generate'] : opts.caps,
      ask: null, ops: null,
      chl: { rows: null, seq: 0 }, nlg: { rows: null, seq: 0 }, elm: { cat: {}, seq: 0 },
      brand: { data: null, tried: false, readErr: null, busy: null, name: '', nameTouched: false, nameErr: null, logoErr: null },
      bst: { about: '', audience: 'mixed', language: 'bilingual', words: [], cust: [], colour: '', type: '', busy: false, err: null, seq: 0,
        result: null, applyBusy: false, applyErr: null, applyMsg: null },
    },
    render: () => { calls.renders++; },
    reg: (n, f) => { CMD[n] = f; },
    push: () => {}, showToast: (m) => calls.toasts.push(String(m)),
    recapNoMoney: () => false, featOn: () => true, tdWhen: () => '', _tdL: () => ({}),
    api: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiRaw: (p) => new Promise((res, rej) => { calls.api.push({ p, res, rej }); }),
    apiWrite: (p, body, method) => new Promise((res, rej) => {
      calls.writes.push({ p, body: plain(body), method: method || 'POST', res, rej });
    }),
    FileReader: FakeReader, Image: FakeImage,
    document: {
      getElementById: () => null,
      createElement: () => (calls.canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: (t) => 'data:' + t + ';base64,PNG' }),
    },
    setTimeout: (f, ms) => { calls.timers.push({ f, ms }); return calls.timers.length; },
    clearTimeout: () => {},
    location: { href: '' },
    URLSearchParams, Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, RegExp, encodeURIComponent, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  vm.createContext(ctx);
  new vm.Script(SRC + '\nthis.ROUTE_CAP=ROUTE_CAP;this.BST=[BST_WORDS,BST_CUST,BST_AUDIENCE,BST_LANGUAGE,BST_COLOUR,BST_TYPE];').runInContext(ctx);
  const text = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { ctx, CMD, calls, text, b: ctx.state.brand, s: ctx.state.bst };
}
const tick = () => new Promise((r) => setImmediate(r));
const w = (h, i) => ({ p: h.calls.writes[i].p, method: h.calls.writes[i].method, body: h.calls.writes[i].body });
const REFUSED = () => { const e = new Error('refused'); e.refused = true; e.words = ['You don’t have permission for this', '你没有此操作的权限']; return e; };
async function loaded(opts, brand) {
  const h = mk(opts);
  h.ctx.SUBS.brand.render();
  h.calls.api[0].res({ success: true, brand: brand || { name: 'Roots', brandLogoUrl: '/api/backend/brand/1/logo?v=1' } });
  await tick();
  return h;
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · who reaches them');
{
  it('Brand carries the desktop link\'s key; the studio carries the server\'s', () => {
    const { ctx } = mk();
    assert.strictEqual(ctx.ROUTE_CAP.brand, 'settings:shop');
    assert.strictEqual(ctx.ROUTE_CAP.brandstudio, 'ai:generate');
    assert.ok(/<a href="\/backend\/brand" data-cap="settings:shop">/.test(fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8')));
    assert.ok(/brand.*'ai:generate'|'ai:publish' : 'ai:generate'/.test(fs.readFileSync(path.join(ROOT, 'lib/cap-routes.js'), 'utf8')));
  });
  it('the Settings row is drawn only where Brand opens', () => {
    assert.ok(/canRoute\('brand'\)\?\[\{label:T\('Brand','品牌'\),cmd:"APP\.cmd\('push','brand'\)"/.test(block(M, 'function screenSettings(){')));
  });
  it('without settings:shop nothing is written; without ai:generate the studio is neither drawn nor run', async () => {
    const h = await loaded({ caps: ['ai:generate'] });
    h.CMD.brandNameSave(); h.CMD.brandLogoClear();
    assert.strictEqual(h.calls.writes.length, 0);
    const g = await loaded({ caps: ['settings:shop'] });
    assert.ok(!/Open the brand studio/.test(g.text(g.ctx.SUBS.brand.render())));
    g.CMD.bstGo();
    assert.strictEqual(g.calls.writes.length, 0);
  });
}

section('2 · the brand: reading it');
{
  it('reads the desktop page\'s endpoint, says Loading, then the logo, the name and the studio\'s door', async () => {
    const h = mk();
    assert.ok(/Loading…/.test(h.text(h.ctx.SUBS.brand.render())));
    assert.strictEqual(h.calls.api[0].p, '/api/backend/brand');
    h.calls.api[0].res({ success: true, brand: { name: 'Roots', brandLogoUrl: '/api/backend/brand/1/logo?v=1' } }); await tick();
    const html = h.ctx.SUBS.brand.render();
    assert.ok(/<img src="\/api\/backend\/brand\/1\/logo\?v=1"/.test(html));
    assert.ok(/value="Roots"/.test(html));
    const t = h.text(html);
    assert.ok(t.includes('Upload logo') && t.includes('Remove') && t.includes('Brand name') && t.includes('Open the brand studio'));
    assert.ok(t.includes('Your logo and name lead the admin, sign-in page and customer emails.'));
  });
  it('no logo: no Remove', async () => {
    const h = await loaded({}, { name: '', brandLogoUrl: null });
    assert.ok(!/Remove/.test(h.text(h.ctx.SUBS.brand.render())));
  });
  it('a failed read says so and offers Try again, which reads again', async () => {
    const h = mk(); h.ctx.SUBS.brand.render();
    h.calls.api[0].rej(new Error('HTTP 500')); await tick();
    assert.ok(/Could not load this\./.test(h.text(h.ctx.SUBS.brand.render())));
    h.CMD.brandRetry();
    assert.strictEqual(h.calls.api.length, 2);
  });
  it('every entry re-reads, and a half-typed name is not carried over', () => {
    assert.ok(/route==='brand'\)\{ const b=state\.brand; b\.tried=false; b\.nameTouched=false;/.test(block(M, 'function push(route)')));
  });
}

section('3 · the brand: the name');
{
  it('Save sends the trimmed name, says it is saving, and confirms with a toast', async () => {
    const h = await loaded();
    h.CMD.brandName('  Roots Deli  ');
    h.CMD.brandNameSave();
    assert.deepStrictEqual(w(h, 0), { p: '/api/backend/brand', method: 'PUT', body: { name: 'Roots Deli' } });
    assert.ok(/Saving…/.test(h.text(h.ctx.SUBS.brand.render())));
    h.CMD.brandNameSave();
    assert.strictEqual(h.calls.writes.length, 1, 'one save at a time');
    h.calls.writes[0].res({ success: true, brand: { name: 'Roots Deli', brandLogoUrl: null } }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Saved']);
    assert.strictEqual(h.b.name, 'Roots Deli');
  });
  it('the field holds at most 60 characters, as the desktop\'s does and the server keeps', () => {
    const h = mk(); h.CMD.brandName('x'.repeat(80));
    assert.strictEqual(h.b.name.length, 60);
    assert.ok(/maxlength="60"/.test(slice(M, 'function screenBrand()', 'SUBS.brand=')));
  });
  it('the server\'s refusal in this language, a permission refusal in its words, a dropped line in the page\'s', async () => {
    const h = await loaded({ lang: 'zh' });
    h.CMD.brandNameSave();
    h.calls.writes[0].rej(new Error('Name is too long · 名称过长')); await tick();
    assert.ok(h.text(h.ctx.SUBS.brand.render()).includes('名称过长'));
    assert.deepStrictEqual(h.calls.toasts, []);
    const r = await loaded(); r.CMD.brandNameSave(); r.calls.writes[0].rej(REFUSED()); await tick();
    assert.ok(r.text(r.ctx.SUBS.brand.render()).includes('You don’t have permission for this'));
    const n = await loaded(); n.CMD.brandNameSave(); n.calls.writes[0].rej(new TypeError('Failed to fetch')); await tick();
    assert.ok(n.text(n.ctx.SUBS.brand.render()).includes('Network error — please try again'));
  });
}

section('4 · the brand: the logo');
{
  it('a raster image is drawn no larger than 512px and sent as PNG', async () => {
    const h = await loaded({ w: 2048, h: 1024 });
    h.CMD.brandLogo({ files: [{ type: 'image/jpeg', data: 'data:image/jpeg;base64,J' }], value: 'x' });
    assert.strictEqual(h.calls.canvas.width, 512); assert.strictEqual(h.calls.canvas.height, 256);
    assert.deepStrictEqual(w(h, 0), { p: '/api/backend/brand', method: 'PUT', body: { logo: 'data:image/png;base64,PNG' } });
    h.calls.writes[0].res({ success: true, brand: { name: 'Roots', brandLogoUrl: '/api/backend/brand/1/logo?v=2' } }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Logo updated']);
    assert.ok(/logo\?v=2/.test(h.ctx.SUBS.brand.render()));
  });
  it('a small image is not enlarged', async () => {
    const h = await loaded({ w: 200, h: 100 });
    h.CMD.brandLogo({ files: [{ type: 'image/png', data: 'data:image/png;base64,P' }] });
    assert.strictEqual(h.calls.canvas.width, 200);
  });
  it('an SVG is sent as it is', async () => {
    const h = await loaded();
    h.CMD.brandLogo({ files: [{ type: 'image/svg+xml', data: 'data:image/svg+xml;base64,S' }] });
    assert.deepStrictEqual(w(h, 0).body, { logo: 'data:image/svg+xml;base64,S' });
    assert.strictEqual(h.calls.canvas, null);
  });
  it('not an image, an unreadable file, an unreadable image: said in place, nothing sent', async () => {
    const a = await loaded(); a.CMD.brandLogo({ files: [{ type: 'application/pdf', data: 'x' }] });
    assert.ok(a.text(a.ctx.SUBS.brand.render()).includes('Please choose an image file'));
    const b = await loaded({ readFails: true }); b.CMD.brandLogo({ files: [{ type: 'image/png', data: 'x' }] });
    assert.ok(b.text(b.ctx.SUBS.brand.render()).includes('Couldn’t read that file'));
    const c = await loaded({ imgFails: true }); c.CMD.brandLogo({ files: [{ type: 'image/png', data: 'x' }] });
    assert.ok(c.text(c.ctx.SUBS.brand.render()).includes('Couldn’t read that image'));
    assert.strictEqual(a.calls.writes.length + b.calls.writes.length + c.calls.writes.length, 0);
  });
  it('Remove sends logo:null, unconfirmed as on the desktop', async () => {
    const h = await loaded();
    h.CMD.brandLogoClear();
    assert.strictEqual(h.ctx.state.ask, null);
    assert.deepStrictEqual(w(h, 0).body, { logo: null });
    h.calls.writes[0].res({ success: true, brand: { name: 'Roots', brandLogoUrl: null } }); await tick();
    assert.deepStrictEqual(h.calls.toasts, ['Logo removed']);
  });
}

// ─────────────────────────────────────────────────────────────────────────
section('5 · the brand studio: the form is the desktop\'s');
{
  const deskList = (name) => vm.runInNewContext(slice(STUDIO, `const ${name} = [`, '];').replace(`const ${name} = `, '') + ']');
  const deskOpts = (id) => {
    const sel = slice(STUDIO, `<select id="${id}">`, '</select>');
    return [...sel.matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  };
  it('the words, the customer types and the four selects send the desktop\'s values', () => {
    const [words, cust, aud, lang, colour, type] = plain(mk().ctx.BST);
    assert.deepStrictEqual(words.map((x) => x[0]), plain(deskList('WORD_OPTS')));
    assert.deepStrictEqual(cust.map((x) => x[0]), plain(deskList('CUST_OPTS')));
    assert.deepStrictEqual(aud.map((x) => x[0]), deskOpts('audience'));
    assert.deepStrictEqual(lang.map((x) => x[0]), deskOpts('language'));
    assert.deepStrictEqual(colour.map((x) => x[0]), deskOpts('colourDirection'));
    assert.deepStrictEqual(type.map((x) => x[0]), deskOpts('typographyFeel'));
  });
  it('Design my brand sends every field, in the desktop\'s shape', () => {
    const h = mk();
    h.CMD.bstField('about', 'plant-based bakery');
    h.CMD.bstField('audience', 'chinese'); h.CMD.bstField('language', 'cn');
    h.CMD.bstPick('words', 'Warm'); h.CMD.bstPick('words', 'Calm'); h.CMD.bstPick('words', 'Warm');
    h.CMD.bstPick('cust', 'families');
    h.CMD.bstField('colour', 'Earthy'); h.CMD.bstField('type', 'Classic serif');
    h.CMD.bstGo();
    assert.deepStrictEqual(w(h, 0), { p: '/brand/generate', method: 'POST', body: {
      about: 'plant-based bakery', audience: 'chinese', language: 'cn', words: ['Calm'], customerType: ['families'],
      colourDirection: 'Earthy', typographyFeel: 'Classic serif' } });
    assert.ok(/Designing your storefront…/.test(h.text(h.ctx.SUBS.brandstudio.render())));
    h.CMD.bstGo();
    assert.strictEqual(h.calls.writes.length, 1, 'one design at a time');
  });
  it('in Chinese, the shown words are Chinese and the sent values are not', () => {
    const h = mk({ lang: 'zh' });
    const html = h.ctx.SUBS.brandstudio.render();
    assert.ok(/APP\.cmd\('bstPick','words','Warm'\)"><span>温暖<\/span>/.test(html));
    assert.ok(/<option value="Earthy">大地色<\/option>/.test(html));
    assert.ok(h.text(html).includes('设计我的品牌'));
  });
}

section('6 · the brand studio: the job, the result, Apply');
{
  const RESULT = { theme: { palette: { primary: '#365329', accent: '#9a7b3f', surface: '#fff' }, fonts: { display: { family: 'Fraunces' }, body: { family: 'Inter' } },
    shape: { radius: 'soft', energy: 'calm' }, density: 'airy', audience: 'mixed' },
    layout: [{ type: 'hero' }, { type: 'grid' }], warnings: [{ code: 'contrast_body', msg: 'Body text contrast is 3.1:1.' }] };
  async function started(opts) {
    const h = mk(opts);
    h.CMD.bstGo();
    h.calls.writes[0].res({ success: true, data: { job_id: 'job_1', state: 'designing' } }); await tick();
    return h;
  }
  it('polls the job every two seconds until it is ready, then shows what was drafted', async () => {
    const h = await started();
    assert.strictEqual(h.calls.timers[0].ms, 2000);
    h.calls.timers[0].f();
    assert.strictEqual(h.calls.api[0].p, '/brand/job/job_1');
    h.calls.api[0].res({ id: 'job_1', state: 'designing', progress: 'Designing your storefront…' }); await tick();
    h.calls.timers[1].f();
    h.calls.api[1].res({ id: 'job_1', state: 'ready', result: RESULT }); await tick();
    assert.strictEqual(h.s.busy, false);
    const t = h.text(h.ctx.SUBS.brandstudio.render());
    assert.ok(t.includes('Your brand') && t.includes('primary #365329') && t.includes('accent #9a7b3f'), t);
    assert.ok(t.includes('Fonts — display: Fraunces · body: Inter'));
    assert.ok(t.includes('Shape: soft / calm · density: airy · audience: mixed'));
    assert.ok(t.includes('Body text contrast is 3.1:1.'));
    assert.ok(t.includes('1. hero') && t.includes('2. grid'));
  });
  it('a missed poll is tried again rather than failing the job', async () => {
    const h = await started();
    h.calls.timers[0].f(); h.calls.api[0].rej(new Error('HTTP 502')); await tick();
    assert.strictEqual(h.calls.timers.length, 2);
    assert.strictEqual(h.s.busy, true);
  });
  it('the job\'s own error is said; sixty polls without an answer is said too', async () => {
    const h = await started();
    h.calls.timers[0].f(); h.calls.api[0].res({ state: 'error', error: 'The design service is busy — please try again.' }); await tick();
    assert.ok(h.text(h.ctx.SUBS.brandstudio.render()).includes('The design service is busy — please try again.'));
    const t = await started();
    for (let i = 0; i < 60; i++) { t.calls.timers[i].f(); t.calls.api[i].res({ state: 'designing' }); await tick(); }
    assert.ok(t.text(t.ctx.SUBS.brandstudio.render()).includes('This is taking a while — please try again.'));
    assert.strictEqual(t.s.busy, false);
  });
  it('a refused or failed start is said where the button is; the model\'s name never is', async () => {
    const r = mk(); r.CMD.bstGo(); r.calls.writes[0].rej(REFUSED()); await tick();
    assert.ok(r.text(r.ctx.SUBS.brandstudio.render()).includes('You don’t have permission for this'));
    const c = mk(); c.CMD.bstGo(); c.calls.writes[0].rej(new Error('anthropic overloaded')); await tick();
    const t = c.text(c.ctx.SUBS.brandstudio.render());
    assert.ok(t.includes('The design service is busy — please try again.') && !/anthropic/i.test(t));
  });
  it('Apply as draft sends the drafted theme and layout, and says it is a draft', async () => {
    const h = await started();
    h.calls.timers[0].f(); h.calls.api[0].res({ state: 'ready', result: RESULT }); await tick();
    h.CMD.bstApply();
    assert.deepStrictEqual(w(h, 1), { p: '/brand/apply', method: 'POST', body: { theme: RESULT.theme, layout: RESULT.layout } });
    assert.ok(/Saving draft…/.test(h.text(h.ctx.SUBS.brandstudio.render())));
    h.calls.writes[1].res({ success: true, data: { draft: true } }); await tick();
    assert.ok(h.text(h.ctx.SUBS.brandstudio.render()).includes('Saved as a draft — preview it in the Mini App Editor.'));
    const f = await started();
    f.calls.timers[0].f(); f.calls.api[0].res({ state: 'ready', result: RESULT }); await tick();
    f.CMD.bstApply(); f.calls.writes[1].rej(new Error('apply_failed')); await tick();
    assert.ok(f.text(f.ctx.SUBS.brandstudio.render()).includes('apply_failed'));
  });
  it('Start over returns to the form, and a job still running is left behind', async () => {
    const h = await started();
    h.CMD.bstAgain();
    h.calls.timers[0].f();
    assert.strictEqual(h.calls.api.length, 0, 'the old job is no longer polled');
    assert.ok(/Design my brand/.test(h.text(h.ctx.SUBS.brandstudio.render())));
  });
  it('the desktop page\'s endpoints, as written there', () => {
    for (const p of ["'/api/retail-admin/brand/generate'", "'/api/retail-admin/brand/job/'", "'/api/retail-admin/brand/apply'"]) assert.ok(STUDIO.includes(p), p);
    assert.ok(BRAND.includes("fetch('/api/backend/brand', { method:'PUT'"));
  });
}

(async () => {
  for (const f of pending) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
