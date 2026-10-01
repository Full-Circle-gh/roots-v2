#!/usr/bin/env node
/**
 * §325 M2 — PICTURES, VIDEO AND BUTTON LINKS IN THE PHONE PAGE EDITOR.
 *
 *   node scripts/test_mobile_editor_media.js
 *
 * The phone editor's sheet took text and sent everything else to desktop:
 * "Images, colours & advanced options for this block are tuned on desktop."
 * It now sets what the desktop inspector's picture, video and link pickers
 * set, field for field, in the inspector's words.
 *
 * The code is RUN, sliced out of public/cms-mobile.html and public/cms.html
 * into sandboxes (no browser: this suite stays in the fast shard). It pins:
 *   1. which fields each block gets, with the inspector's labels and hints —
 *      and that every label is the inspector's own pair;
 *   2. a picture: upload (to /cms/media, shrunk by the inspector's rules),
 *      the media library, a pasted link, remove — each committed through
 *      'setImage' so the editor measures the shape where the inspector does;
 *   3. a video: upload (to /cms/media/video), paste, remove, as a 'patch';
 *   4. refusals said where the operator is looking, nothing written;
 *   5. a link: the inspector's pages (suggested first), products and
 *      categories, a saved link kept, typed by hand;
 *   6. a hero's buttons: the list sent whole with the old single-button
 *      fields cleared; two boxes typed in turn both kept;
 *   7. the sheet is not redrawn under a box being typed in;
 *   8. the bridge: setImage commits as the inspector's picture field does;
 *      the lists and a hero's buttons are sent;
 *   9. the no-permission screen names the permission it checks.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');
const CD = fs.readFileSync(path.join(ROOT, 'public/cms.html'), 'utf8');

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
const tick = () => new Promise((r) => setImmediate(r));
const plain = (x) => JSON.parse(JSON.stringify(x));

const SRC = slice(CM, "/* ── §325 · THE COUPON BLOCK'S PICKER", '/* ── §299 · PROMO CARDS, ON THE PHONE');

// A stand-in element: keeps its HTML; one control per data-a="…"; the
// library's tiles by data-id.
function el(tag) {
  const e = {
    tag, html: '', kids: [], controls: {}, tiles: [], style: {}, className: '', textContent: '', clicked: 0,
    set innerHTML(v) {
      this.html = v; this.kids = []; this.controls = {};
      this.tiles = [...v.matchAll(/data-id="([^"]*)"/g)].map((m) => ({ dataset: { id: m[1] }, onclick: null }));
    },
    get innerHTML() { return this.html; },
    appendChild(k) { this.kids.push(k); },
    querySelector(sel) {
      const m = sel.match(/\[data-a=([a-z]+)\]/);
      const k = m && m[1];
      if (!k) return null;
      if (!new RegExp('data-a="' + k + '"').test(this.html)) return null;
      if (!this.controls[k]) this.controls[k] = { onclick: null, onchange: null, oninput: null };
      return this.controls[k];
    },
    querySelectorAll(sel) { return /data-id/.test(sel) ? this.tiles : []; },
    click() { this.clicked++; },
  };
  return e;
}
const TARGETS = {
  pages: [{ v: 'shop', en: 'Shop', cn: '商店' }, { v: 'coupons', en: 'Coupons', cn: '优惠券' }, { v: 'me', en: 'My account', cn: '我的' }],
  products: [{ id: 7, name_en: 'Hummus Asli', name_cn: '鹰嘴豆泥', sku: 'HUM-1', is_published: true }, { id: 8, name_en: 'Beet salad', name_cn: '', sku: '', is_published: false }],
  categories: [{ id: 'ready', name: 'Ready to Eat', name_cn: '即食' }],
};
function mk(opts = {}) {
  const sent = [], fetches = [], files = [];
  let renders = 0;
  const pickers = [];
  const ctx = {
    M: { lang: opts.lang || 'en', editId: 'b1', extra: opts.extra || null, frameColors: [], corners: [], targets: opts.targets === undefined ? TARGETS : opts.targets },
    cuT: (en, cn) => (opts.lang === 'cn' ? cn : en),
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    send: (cmd, x) => sent.push({ cmd, x }),
    renderEdit: () => { renders++; },
    document: {
      createElement: (t) => { const e = el(t); if (t === 'input') pickers.push(e); return e; },
      activeElement: opts.active || null,
    },
    fetch: async (u, o) => {
      fetches.push({ u, o });
      if (opts.fetch) return opts.fetch(u, o);
      throw new Error('offline');
    },
    FormData: class { constructor() { this.parts = []; files.push(this.parts); } append(k, v, n) { this.parts.push([k, v, n]); } },
    createImageBitmap: opts.bitmap || (async () => { throw new Error('no canvas in node'); }),
    location: {},
    Object, String, Array, JSON, Math, Promise, Error, RegExp,
  };
  vm.createContext(ctx);
  // Top-level const / let stay inside the script; hand the tables and the
  // upload state out by name.
  vm.runInContext(SRC + "\nthis.MEDIA = MEDIA; this.LINKS = LINKS; Object.defineProperty(this, '_med', { get: () => _med });", ctx);
  return { ctx, sent, fetches, files, pickers, renders: () => renders };
}
const draw = (ctx, blk, type) => { const body = el(); ctx.renderMedia(body, blk, type || blk.type); return body.kids; };
const res = (status, j) => ({ status, json: async () => j });

section('1 · which fields, in the inspector\'s words');
{
  it('hero: picture, desktop picture, video, its buttons — no single link', () => {
    const { ctx } = mk({ extra: { ctas: [] } });
    const kids = draw(ctx, { id: 'b1', type: 'hero_banner' });
    assert.ok(/<label>Picture<\/label>/.test(kids[0].html));
    assert.ok(/The banner becomes as tall as your picture\. Nothing is cut or stretched\./.test(kids[0].html));
    assert.ok(/<label>Desktop picture \(optional\)<\/label>/.test(kids[1].html));
    assert.ok(/<label>Video \(optional\)<\/label>/.test(kids[2].html));
    assert.ok(/<label>Buttons \(0\)<\/label>[\s\S]*No buttons\. The banner shows the image alone\./.test(kids[3].html));
    const split = draw(ctx, { id: 'b1', type: 'hero_banner', view: 'split' });
    assert.ok(/Shown as a square on the left side\./.test(split[0].html));
  });
  it('video banner: the clip, its poster, its tap link', () => {
    const { ctx } = mk();
    const kids = draw(ctx, { id: 'b1', type: 'video_banner' });
    assert.deepStrictEqual(kids.map((k) => (k.html.match(/<label>([^<]+)<\/label>/) || [])[1]), ['Video clip', 'Poster (optional)', 'Tap link (optional)']);
    assert.ok(/Upload an MP4, or paste a video link\./.test(kids[0].html));
  });
  it('recipe story, WeCom contact: their picture; every block with a button: its link', () => {
    const { ctx } = mk();
    assert.ok(/<label>Image<\/label>/.test(draw(ctx, { id: 'b1', type: 'recipe_story' })[0].html));
    assert.ok(/<label>QR code image<\/label>/.test(draw(ctx, { id: 'b1', type: 'wecom_contact' })[0].html));
    for (const [t, label] of [['announcement_bar', 'Link (optional)'], ['category_tabs', 'SEE ALL link'], ['flash_sale_strip', 'Button link'],
      ['coupon_block', 'Button link'], ['points_widget', 'Button link'], ['top_up', 'Tap target'], ['voting_block', 'Button link'],
      ['affiliate_block', 'Tap link (whole block)'], ['greeting', 'Button link'], ['kitchen_status', 'Button link'], ['countdown_timer', 'Button link']]) {
      const kids = draw(ctx, { id: 'b1', type: t });
      assert.strictEqual(kids.length, 1, t);
      assert.ok(new RegExp('<label>' + label.replace(/[()]/g, '\\$&') + '</label><select data-a="link">').test(kids[0].html), t);
    }
    assert.strictEqual(draw(ctx, { id: 'b1', type: 'spacer' }).length, 0);
    assert.strictEqual(draw(ctx, { id: 'b1', type: 'leaderboard' }).length, 0);
  });
  it('every label and hint is the inspector\'s own pair, and every link field and suggestion is the inspector\'s', () => {
    const MEDIA = mk().ctx.MEDIA, LINKS = mk().ctx.LINKS;
    const has = (en, cn) => CD.includes(`T('${en}', '${cn}')`) || CD.includes(`T("${en}", '${cn}')`);
    for (const [type, specs] of Object.entries(MEDIA)) {
      for (const s of specs) {
        assert.ok(has(s.en, s.cn), type + ' ' + s.en);
        const hints = typeof s.hint === 'function' ? [s.hint({ view: 'split' }), s.hint({})] : [s.hint];
        for (const h of hints) assert.ok(has(h[0], h[1]), type + ' hint ' + h[0].slice(0, 30));
        const call = s.kind === 'video' ? `videoPicker(b.${s.key}, url => updateBlock(b.id, { ${s.key}: url }))`
          : s.aspect ? `imgPicker(b.${s.key}, ({ url, aspect }) => updateBlock(b.id, { ${s.key}: url, ${s.aspect}: aspect }))`
          : `imgPicker(b.${s.key}, ({ url }) => updateBlock(b.id, { ${s.key}: url }))`;
        assert.ok(CD.includes(call), type + ' ' + call);
      }
    }
    for (const [type, rows] of Object.entries(LINKS)) {
      for (const [key, en, cn, hint, sug] of rows) {
        assert.ok(has(en, cn), type + ' ' + en);
        assert.ok(has(hint[0], hint[1]), type + ' hint');
        const s = typeof sug === 'function' ? "b.product_id ? null : 'shop'" : `'${sug}'`;
        assert.ok(CD.includes(`targetPicker({ value: b.${key}, onChange: v => updateBlockSilent(b.id, { ${key}: v }), suggest: ${s} })`), type + ' ' + key);
      }
    }
  });
  it('countdown and kitchen status have the button text their link needs', () => {
    for (const t of ['countdown_timer', 'kitchen_status']) {
      const line = CM.split('\n').find((l) => new RegExp('^\\s*' + t + ':\\s*\\[\\[').test(l));
      assert.ok(line && /'cta_label_en', 'Button label', '按钮文字'/.test(line) && /'cta_label_cn'/.test(line), t);
    }
  });
  it('in Chinese, the inspector\'s Chinese', () => {
    const { ctx } = mk({ lang: 'cn', extra: { ctas: [] } });
    const kids = draw(ctx, { id: 'b1', type: 'video_banner' });
    assert.ok(/<label>视频短片<\/label>/.test(kids[0].html) && /上传 MP4,或粘贴视频链接。/.test(kids[0].html));
    assert.ok(/<label>封面图\(可选\)<\/label>/.test(kids[1].html) && />图片</.test(kids[1].html) && />媒体库</.test(kids[1].html));
    assert.ok(/<label>点击跳转\(可选\)<\/label>/.test(kids[2].html) && /手动输入跳转目标/.test(kids[2].html));
  });
}

section('2 · a picture');
{
  it('empty: Picture and Media library, no Remove; set: its thumbnail, Replace, Remove', () => {
    const { ctx } = mk();
    const empty = draw(ctx, { id: 'b1', type: 'recipe_story' })[0];
    assert.ok(/data-a="up">Picture<\/button>/.test(empty.html) && /data-a="lib">Media library</.test(empty.html) && !/data-a="rm"/.test(empty.html));
    const set = draw(ctx, { id: 'b1', type: 'recipe_story', image_url: '/api/retail/media/5' })[0];
    assert.ok(/<img src="\/api\/retail\/media\/5"/.test(set.html) && /Replace picture/.test(set.html) && /data-a="rm">Remove</.test(set.html));
    assert.ok(/<input type="url" data-a="url" placeholder="https:\/\/…" value="\/api\/retail\/media\/5">/.test(set.html));
  });
  it('Remove and a pasted link commit through setImage, with the shape field where the inspector keeps one', () => {
    const { ctx, sent } = mk({ extra: { ctas: [] } });
    const [pic, desk] = draw(ctx, { id: 'b1', type: 'hero_banner', image_url: '/a.jpg', image_desktop_url: '/d.jpg' });
    pic.controls.rm.onclick();
    desk.controls.url.onchange({ target: { value: '  https://cdn.example/w.jpg ' } });
    assert.deepStrictEqual(plain(sent), [
      { cmd: 'setImage', x: { id: 'b1', key: 'image_url', url: '', aspectKey: 'image_aspect' } },
      { cmd: 'setImage', x: { id: 'b1', key: 'image_desktop_url', url: 'https://cdn.example/w.jpg', aspectKey: null } },
    ]);
  });
  it('an upload: POST /cms/media with the file, then setImage with the url it answered', async () => {
    const { ctx, sent, fetches, files, pickers } = mk({ fetch: async () => res(200, { success: true, data: { url: '/api/retail/media/88' } }) });
    const blk = { id: 'b1', type: 'wecom_contact' };
    const [f] = draw(ctx, blk);
    f.controls.up.onclick();
    const input = pickers[pickers.length - 1];
    assert.strictEqual(input.accept, 'image/*'); assert.strictEqual(input.clicked, 1);
    const file = { name: 'qr.png', type: 'image/png', size: 1000 };
    await ctx.mediaUpload(blk, ctx.MEDIA.wecom_contact[0], file);
    assert.strictEqual(fetches[0].u, '/api/retail-admin/cms/media');
    assert.deepStrictEqual({ method: fetches[0].o.method, credentials: fetches[0].o.credentials }, { method: 'POST', credentials: 'same-origin' });
    assert.deepStrictEqual(files[0], [['file', file, 'qr.png']]);
    assert.deepStrictEqual(plain(sent), [{ cmd: 'setImage', x: { id: 'b1', key: 'qr_image_url', url: '/api/retail/media/88', aspectKey: null } }]);
  });
  it('while it uploads the button says so and is disabled', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const { ctx } = mk({ fetch: async () => { await gate; return res(200, { success: true, data: { url: '/x' } }); } });
    const blk = { id: 'b1', type: 'recipe_story' };
    const p = ctx.mediaUpload(blk, ctx.MEDIA.recipe_story[0], { name: 'a.jpg', type: 'image/jpeg', size: 10 });
    const during = draw(ctx, blk)[0];
    assert.ok(/data-a="up" disabled>Uploading…<\/button>/.test(during.html));
    assert.ok(/data-a="lib" disabled>/.test(during.html));
    release(); await p;
    assert.ok(!/disabled/.test(draw(ctx, blk)[0].html));
  });
  it('a refusal is said under the field, in the phone app\'s words, and nothing is written', async () => {
    const { ctx, sent } = mk({ fetch: async () => res(400, { success: false, error: 'too_large' }) });
    const blk = { id: 'b1', type: 'recipe_story' };
    await ctx.mediaUpload(blk, ctx.MEDIA.recipe_story[0], { name: 'a.jpg', type: 'image/jpeg', size: 10 });
    assert.strictEqual(sent.length, 0);
    assert.ok(/<div class="pc-err">That photo is too large\. Try a smaller one\.<\/div>/.test(draw(ctx, blk)[0].html));
    const forbidden = mk({ fetch: async () => res(403, { success: false, error: 'forbidden' }) });
    await forbidden.ctx.mediaUpload(blk, forbidden.ctx.MEDIA.recipe_story[0], { name: 'a.jpg', type: 'image/jpeg', size: 10 });
    assert.ok(/pc-err">Upload failed: forbidden</.test(draw(forbidden.ctx, blk)[0].html));
    const offline = mk();
    await offline.ctx.mediaUpload(blk, offline.ctx.MEDIA.recipe_story[0], { name: 'a.jpg', type: 'image/jpeg', size: 10 });
    assert.ok(/pc-err">Upload failed</.test(draw(offline.ctx, blk)[0].html));
  });
  it('shrunk by the inspector\'s rules: a GIF and a small picture go as they are; a big one shrinks; a bigger result is dropped', async () => {
    const gif = { type: 'image/gif', size: 9e6 };
    assert.strictEqual(await mk().ctx.prepImage(gif), gif);
    const small = { type: 'image/jpeg', size: 400e3 };
    assert.strictEqual(await mk({ bitmap: async () => ({ width: 1200, height: 900 }) }).ctx.prepImage(small), small);
    const canvasFor = (blobSize, types) => ({
      width: 0, height: 0, getContext: () => ({ drawImage() {} }),
      toBlob(cb, type) { types.push(type); cb({ size: blobSize, type }); },
    });
    for (const [file, blobSize, wantType, same] of [
      [{ type: 'image/jpeg', size: 6e6 }, 800e3, 'image/jpeg', false],
      [{ type: 'image/png', size: 6e6 }, 800e3, 'image/webp', false],
      [{ type: 'image/jpeg', size: 6e6 }, 7e6, 'image/jpeg', true]]) {
      const types = [];
      const { ctx } = mk({ bitmap: async () => ({ width: 4000, height: 3000 }) });
      let made = null;
      ctx.document.createElement = (t) => (t === 'canvas' ? (made = canvasFor(blobSize, types)) : el(t));
      const out = await ctx.prepImage(file);
      assert.strictEqual(types[0], wantType);
      assert.deepStrictEqual([made.width, made.height], [1600, 1200]);
      assert.strictEqual(out === file, same);
    }
  });
}

section('3 · the media library');
{
  it('loading, then the pictures (clips left out); a tap uses it', async () => {
    const { ctx, sent, fetches } = mk({ fetch: async () => res(200, { success: true, data: [
      { id: 3, filename: 'a.jpg', mime_type: 'image/jpeg' }, { id: 4, filename: 'c.mp4', mime_type: 'video/mp4' }, { id: 5, filename: 'b.png', mime_type: 'image/png' }] }) });
    const blk = { id: 'b1', type: 'video_banner' };
    ctx.openLibrary(ctx.MEDIA.video_banner[1]);
    let body = el(); ctx.renderLibrary(body, blk);
    assert.ok(/Media library/.test(body.kids[0].html) && /data-a="cancel">Cancel</.test(body.kids[0].html));
    assert.strictEqual(body.kids[1].textContent, 'Loading…');
    await tick(); await tick(); await tick();
    assert.deepStrictEqual(fetches.map((f) => f.u), ['/api/retail-admin/cms/media']);
    body = el(); ctx.renderLibrary(body, blk);
    assert.deepStrictEqual(body.kids[1].tiles.map((t) => t.dataset.id), ['3', '5']);
    body.kids[1].tiles[1].onclick();
    assert.deepStrictEqual(plain(sent), [{ cmd: 'setImage', x: { id: 'b1', key: 'poster_url', url: '/api/retail/media/5', aspectKey: null } }]);
    assert.strictEqual(ctx._med.lib, null, 'the library closes');
  });
  it('empty, failed, and Cancel', async () => {
    const blk = { id: 'b1', type: 'recipe_story' };
    const empty = mk({ fetch: async () => res(200, { success: true, data: [{ id: 4, mime_type: 'video/mp4' }] }) });
    empty.ctx.openLibrary(empty.ctx.MEDIA.recipe_story[0]); await tick(); await tick(); await tick();
    let body = el(); empty.ctx.renderLibrary(body, blk);
    assert.strictEqual(body.kids[1].textContent, 'Nothing in the library');
    const bad = mk({ fetch: async () => res(500, { success: false, error: 'db' }) });
    bad.ctx.openLibrary(bad.ctx.MEDIA.recipe_story[0]); await tick(); await tick(); await tick();
    body = el(); bad.ctx.renderLibrary(body, blk);
    assert.strictEqual(body.kids[1].textContent, 'Could not load');
    body.kids[0].controls.cancel.onclick();
    assert.strictEqual(bad.ctx._med.lib, null);
  });
  it('the sheet hands itself to the library while it is open', () => {
    assert.ok(/if \(blk && _med\.lib\) \{ renderLibrary\(body, blk\); return; \}/.test(CM));
  });
}

section('4 · a video');
{
  it('upload to /cms/media/video, as an MP4, then a patch of the one field', async () => {
    const { ctx, sent, fetches, files } = mk({ fetch: async () => res(200, { success: true, data: { url: '/api/retail/media/9' } }) });
    const blk = { id: 'b1', type: 'video_banner' };
    const f = { name: 'clip.mp4', type: 'video/mp4', size: 5e6 };
    await ctx.mediaUpload(blk, ctx.MEDIA.video_banner[0], f);
    assert.strictEqual(fetches[0].u, '/api/retail-admin/cms/media/video');
    assert.strictEqual(files[0][0][1], f, 'a clip is sent as it is');
    assert.deepStrictEqual(plain(sent), [{ cmd: 'patch', x: { id: 'b1', patch: { video_url: '/api/retail/media/9' } } }]);
  });
  it('shown playing; no library; remove and paste are patches', () => {
    const { ctx, sent } = mk();
    const [v] = draw(ctx, { id: 'b1', type: 'video_banner', video_url: '/api/retail/media/9' });
    assert.ok(/<video src="\/api\/retail\/media\/9" muted loop playsinline autoplay><\/video>/.test(v.html));
    assert.ok(/Replace video/.test(v.html) && !/data-a="lib"/.test(v.html));
    v.controls.rm.onclick();
    v.controls.url.onchange({ target: { value: 'https://cdn.example/a.mp4' } });
    assert.deepStrictEqual(plain(sent), [
      { cmd: 'patch', x: { id: 'b1', patch: { video_url: '' } } },
      { cmd: 'patch', x: { id: 'b1', patch: { video_url: 'https://cdn.example/a.mp4' } } },
    ]);
  });
  it('a clip too large, or not an MP4, is said so', async () => {
    const blk = { id: 'b1', type: 'video_banner' };
    for (const [code, words] of [['too_large', 'Video too large \\(20MB max\\)'], ['not_a_video', "That file isn't an MP4 video"]]) {
      const { ctx, sent } = mk({ fetch: async () => res(400, { success: false, error: code }) });
      await ctx.mediaUpload(blk, ctx.MEDIA.video_banner[0], { name: 'x.mov', type: 'video/quicktime', size: 1 });
      assert.strictEqual(sent.length, 0);
      assert.ok(new RegExp('pc-err">' + words + '<').test(draw(ctx, blk)[0].html), code);
    }
  });
}

section('5 · a link');
{
  it('no link, then the pages with the block\'s suggestion first, products, categories', () => {
    const { ctx } = mk();
    const html = ctx.linkOptions('', 'coupons');
    assert.ok(html.startsWith('<option value="" selected>No link chosen — uses this block’s default.</option>'));
    assert.ok(/<optgroup label="Pages"><option value="coupons">Coupons · SUGGESTED<\/option><option value="shop">Shop<\/option><option value="me">My account<\/option><\/optgroup>/.test(html));
    assert.ok(/<optgroup label="Products"><option value="product:7">Hummus Asli · HUM-1<\/option><option value="product:8">Beet salad · DRAFT<\/option><\/optgroup>/.test(html));
    assert.ok(/<optgroup label="Categories"><option value="category:ready">Ready to Eat<\/option><\/optgroup>/.test(html));
  });
  it('a saved link in none of the lists is kept, named as the inspector names it', () => {
    const { ctx } = mk();
    assert.ok(/<option value="product:99" selected>Product #99<\/option>/.test(ctx.linkOptions('product:99')));
    assert.ok(/<option value="category:gone" selected>Category #gone<\/option>/.test(ctx.linkOptions('category:gone')));
    assert.ok(/<option value="\/pages\/x" selected>Custom · \/pages\/x<\/option>/.test(ctx.linkOptions('/pages/x')));
    assert.ok(/<option value="product:7" selected>/.test(ctx.linkOptions('product:7')));
  });
  it('before the lists arrive, the saved link is still shown and kept', () => {
    const { ctx } = mk({ targets: null });
    assert.ok(/<option value="coupons" selected>Custom · coupons<\/option>/.test(ctx.linkOptions('coupons')));
  });
  it('choosing writes the one field; typing by hand opens a box and writes it trimmed', () => {
    const { ctx, sent } = mk();
    ctx.M.lang = 'en';
    const [f] = draw(ctx, { id: 'b1', type: 'coupon_block', cta_target: 'shop' });
    assert.ok(/<option value="shop" selected>Shop<\/option>/.test(f.html));
    f.controls.link.onchange({ target: { value: 'coupons' } });
    f.controls.manualopen.onclick();
    const [g] = draw(ctx, { id: 'b1', type: 'coupon_block', cta_target: 'shop' });
    assert.ok(/<input type="text" data-a="manual" style="margin-top:8px" placeholder="shop · product:12 · category:5" value="shop">/.test(g.html));
    g.controls.manual.onchange({ target: { value: ' product:12 ' } });
    assert.deepStrictEqual(plain(sent), [
      { cmd: 'patch', x: { id: 'b1', patch: { cta_target: 'coupons' } } },
      { cmd: 'patch', x: { id: 'b1', patch: { cta_target: 'product:12' } } },
    ]);
  });
  it('a recipe story with a linked product suggests nothing, as the inspector', () => {
    const { ctx } = mk();
    const withP = draw(ctx, { id: 'b1', type: 'recipe_story', product_id: 7 })[1].html;
    assert.ok(!/SUGGESTED/.test(withP));
    assert.ok(/Shop · SUGGESTED/.test(draw(ctx, { id: 'b1', type: 'recipe_story' })[1].html));
  });
}

section('6 · a hero\'s buttons');
{
  const CTAS = [{ label_en: 'SHOP', label_cn: '购物', target: 'shop', style: 'primary' }, { label_en: 'More', label_cn: '', target: '', style: 'link' }];
  const hero = (ctx) => draw(ctx, { id: 'b1', type: 'hero_banner' }).slice(4);   // after 3 media fields and the heading
  it('each: both labels, style, link, remove; then Add button', () => {
    const { ctx } = mk({ extra: { ctas: CTAS } });
    const kids = draw(ctx, { id: 'b1', type: 'hero_banner' });
    assert.ok(/<label>Buttons \(2\)<\/label>/.test(kids[3].html));
    const [c1, c2, add] = hero(ctx);
    assert.ok(/data-a="en" value="SHOP"/.test(c1.html) && /data-a="cn" value="购物"/.test(c1.html));
    assert.ok(/<option value="primary" selected>Primary<\/option><option value="secondary">Secondary<\/option><option value="link">Link only<\/option>/.test(c1.html));
    assert.ok(/<option value="link" selected>Link only/.test(c2.html));
    assert.ok(/<label>Button link<\/label>/.test(c1.kids[0].html) && /<option value="shop" selected>/.test(c1.kids[0].html));
    assert.strictEqual(c1.kids[1].textContent, 'Remove');
    assert.strictEqual(add.textContent, 'Add button');
  });
  it('every change sends the whole list and clears the old single-button fields, as the inspector', () => {
    const { ctx, sent } = mk({ extra: { ctas: CTAS } });
    let [c1] = hero(ctx);
    c1.controls.style.onchange({ target: { value: 'secondary' } });
    const p = sent[0].x.patch;
    assert.deepStrictEqual(Object.keys(p), ['ctas', 'cta_label', 'cta_target']);
    assert.ok(p.cta_label === undefined && p.cta_target === undefined);
    assert.deepStrictEqual(plain(p.ctas), [Object.assign({}, CTAS[0], { style: 'secondary' }), CTAS[1]]);
    [c1] = hero(ctx);
    c1.kids[0].controls.link.onchange({ target: { value: 'coupons' } });
    assert.strictEqual(sent[1].x.patch.ctas[0].target, 'coupons');
  });
  it('two boxes typed in turn, with no redraw between, both keep their words', () => {
    const { ctx, sent } = mk({ extra: { ctas: CTAS } });
    const [c1] = hero(ctx);
    c1.controls.en.oninput({ target: { value: 'SHOP NOW' } });
    c1.controls.cn.oninput({ target: { value: '立即购物' } });
    assert.deepStrictEqual(plain(sent[1].x.patch.ctas[0]), { label_en: 'SHOP NOW', label_cn: '立即购物', target: 'shop', style: 'primary' });
  });
  it('remove takes that one; add appends the inspector\'s new button', () => {
    const { ctx, sent } = mk({ extra: { ctas: CTAS } });
    const [c1, , add] = hero(ctx);
    c1.kids[1].onclick();
    add.onclick();
    assert.deepStrictEqual(plain(sent[0].x.patch.ctas), [CTAS[1]]);
    assert.deepStrictEqual(plain(sent[1].x.patch.ctas), CTAS.concat([{ label: 'NEW BUTTON', target: '', style: 'primary' }]));
    assert.ok(CD.includes("const next = [...getCtas(b), { label: 'NEW BUTTON', target: '', style: 'primary' }];"));
  });
}

section('7 · the sheet is not redrawn under a box being typed in');
{
  const inSheet = (tag, type) => ({ tagName: tag, type, closest: (s) => (s === '#edit-body' ? {} : null) });
  it('a text box or text area in the sheet: typing; a select, a checkbox, a box elsewhere: not', () => {
    assert.strictEqual(mk({ active: inSheet('INPUT', 'text') }).ctx.typingInSheet(), true);
    assert.strictEqual(mk({ active: inSheet('INPUT', 'url') }).ctx.typingInSheet(), true);
    assert.strictEqual(mk({ active: inSheet('TEXTAREA') }).ctx.typingInSheet(), true);
    assert.strictEqual(mk({ active: inSheet('SELECT') }).ctx.typingInSheet(), false);
    assert.strictEqual(mk({ active: inSheet('INPUT', 'checkbox') }).ctx.typingInSheet(), false);
    assert.strictEqual(mk({ active: { tagName: 'INPUT', type: 'text', closest: () => null } }).ctx.typingInSheet(), false);
    assert.strictEqual(mk({ active: null }).ctx.typingInSheet(), false);
  });
  it('the block\'s echo and the lists skip the redraw while typing', () => {
    assert.ok(/if \(M\.editId != null && !typingInSheet\(\)\) \{\s*if \(M\.selectedBlock && M\.selectedBlock\.id === M\.editId\) renderEdit\(\);/.test(CM));
    assert.ok(/M\.targets = \{ pages: d\.pages \|\| \[\], products: d\.products \|\| \[\], categories: d\.categories \|\| \[\] \};\s*if \(M\.editId != null && !typingInSheet\(\)\) renderEdit\(\);/.test(CM));
  });
  it('opening a block asks for fresh lists and clears the last block\'s upload state', () => {
    assert.ok(/_med = \{ busy: null, err: \{\}, manual: \{\}, lib: null \};[^\n]*\n\s*send\('getSelected', \{ id \}\);[^\n]*\n\s*send\('getTargets'\);/.test(CM));
    assert.ok(/if \(blk && type !== 'promo_cards'\) renderMedia\(body, blk, type\);/.test(CM));
  });
  it('the note at the foot no longer sends pictures or colours to desktop', () => {
    assert.ok(!/Images, colours &amp; advanced options/.test(CM));
    assert.ok(/cuT\('<b>Advanced options<\/b> for this block are tuned on desktop\. ', '此模块的<b>高级选项<\/b>请在电脑上调整。'\)/.test(CM));
  });
}

section('8 · the bridge in cms.html');
{
  const CASES = slice(CD, "        case 'setImage': {", "        case 'pickCoupon': {");
  const EXTRA = slice(CD, "  // §325 — what the phone's edit sheet needs beside the block itself", '  const postSelected = ');
  function mkB() {
    const updates = [], posted = [], probed = [];
    const ctx = {
      state: { vouchers: [], products: [{ id: 7, name_en: 'Hummus', name_cn: '', sku: 'H', is_published: 1, price: 30, image_data: 'data:…' }], categories: [{ id: 'ready', name: 'Ready', name_cn: '即食', extra: 1 }] },
      TARGET_PAGES: [{ v: 'shop', en: 'Shop', cn: '商店' }],
      SHOW_ON_DEFAULTS: {}, showOnFor: () => 'both', liveCouponDisplay: () => null,
      getCtas: (b) => (b.ctas || []).map((c) => ({ label_en: c.label || '', label_cn: '', target: c.target || '', style: 'primary' })),
      probeImage: async (u) => { probed.push(u); return 1.5; },
      updateBlock: (id, patch) => updates.push({ id, patch }),
      POST: (m) => posted.push(m),
    };
    vm.createContext(ctx);
    vm.runInContext(EXTRA + '\nthis.selectedExtra=selectedExtra;\nthis.run=async (d)=>{ switch (d.cmd) {\n' + CASES + '} };', ctx);
    return { ctx, updates, posted, probed };
  }
  it('setImage: a shape field is measured, and cleared with the picture; a plain one is just set', async () => {
    const { ctx, updates, probed } = mkB();
    await ctx.run({ cmd: 'setImage', id: 'b1', key: 'image_url', url: ' /x.jpg ', aspectKey: 'image_aspect' });
    await ctx.run({ cmd: 'setImage', id: 'b1', key: 'image_url', url: '', aspectKey: 'image_aspect' });
    await ctx.run({ cmd: 'setImage', id: 'b1', key: 'poster_url', url: '/p.jpg', aspectKey: null });
    await ctx.run({ cmd: 'setImage', id: 'b1', key: '', url: '/p.jpg' });
    assert.deepStrictEqual(plain(updates), [
      { id: 'b1', patch: { image_url: '/x.jpg', image_aspect: 1.5 } },
      { id: 'b1', patch: { image_url: '', image_aspect: null } },
      { id: 'b1', patch: { poster_url: '/p.jpg' } },
    ]);
    assert.deepStrictEqual(probed, ['/x.jpg'], 'only a picture that is there is measured');
  });
  it('the inspector\'s picture field commits the same way', () => {
    assert.ok(/if \(!url\) \{ onSet\(\{ url: '', aspect: null \}\); return; \}\s*const aspect = await probeImage\(url\);\s*onSet\(\{ url, aspect \}\);/.test(CD));
  });
  it('getTargets: the inspector\'s pages, and its products and categories cut to what a choice needs', async () => {
    const { ctx, posted } = mkB();
    await ctx.run({ cmd: 'getTargets' });
    assert.deepStrictEqual(plain(posted), [{ evt: 'targets', pages: [{ v: 'shop', en: 'Shop', cn: '商店' }],
      products: [{ id: 7, name_en: 'Hummus', name_cn: '', sku: 'H', is_published: true }], categories: [{ id: 'ready', name: 'Ready', name_cn: '即食' }] }]);
  });
  it('a hero\'s selection carries its buttons as getCtas reads them', () => {
    const { ctx } = mkB();
    assert.deepStrictEqual(plain(ctx.selectedExtra({ type: 'hero_banner', ctas: [{ label: 'GO', target: 'shop' }] }).ctas), [{ label_en: 'GO', label_cn: '', target: 'shop', style: 'primary' }]);
    assert.ok(!('ctas' in ctx.selectedExtra({ type: 'spacer' })));
  });
}

section('9 · the no-permission screen names the permission it checks');
{
  it('content:edit, by the Roles screen\'s name for it; no `retail`', () => {
    const GATE = slice(CM, 'function gateNoPerm() {', 'function gateError(e) {');
    const els = { '#gate-spin': {}, '#gate-title': {}, '#gate-msg': {} };
    for (const lang of ['en', 'cn']) {
      const ctx = { $: (s) => els[s], cuT: (en, cn) => (lang === 'cn' ? cn : en), esc: (s) => String(s) };
      vm.createContext(ctx); vm.runInContext(GATE + '\ngateNoPerm();', ctx);
      if (lang === 'en') {
        assert.strictEqual(els['#gate-title'].textContent, 'You do not have permission to do that.');
        assert.strictEqual(els['#gate-msg'].innerHTML, 'Ask an admin to grant you the <code>Edit content (about/legal/FAQ/copy)</code> permission.');
      } else {
        assert.strictEqual(els['#gate-title'].textContent, '你没有执行该操作的权限。');
        assert.strictEqual(els['#gate-msg'].innerHTML, '请管理员授予你 <code>编辑内容(关于/条款/常见问题/文案)</code> 权限。');
      }
    }
    assert.ok(/caps && !caps\.includes\('content:edit'\)\) \{ gateNoPerm\(\); return; \}/.test(CM));
    const capsSrc = fs.readFileSync(path.join(ROOT, 'lib/capabilities.js'), 'utf8');
    assert.ok(/key: 'content:edit',[^\n]*labelEn: 'Edit content \(about\/legal\/FAQ\/copy\)', labelCn: '编辑内容\(关于\/条款\/常见问题\/文案\)'/.test(capsSrc));
  });
}

(async () => {
  for (const f of queue) await f();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
