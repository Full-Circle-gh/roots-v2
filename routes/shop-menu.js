// The public QR menu — docs/tacet-consolidation-decisions.md §41, §42, §44,
// §47. Step 5a of the location commerce module.
//
// WHAT THIS IS. One page, served at /s/:shopCode, that shows a shop's menu to
// a customer who has just scanned a QR code. No login, no session, no cookie,
// no cart and no ordering: ordering is Step 5b and is deliberately built
// behind this page rather than with it, so the menu can be reviewed and
// corrected while the order flow is written.
//
// IT IS A CUSTOMER SURFACE, NOT AN ADMIN ONE. It must look like the web
// storefront and the mini app, which share one visual language, and NOT like
// the Tacet admin, which has its own (docs/tacet-design-system.md). The two
// are different products with different readers.
//
// TENANT-THEMED, NOT ROOTS-HARDCODED (§0). There is no colour, font family,
// brand name, logo or currency symbol written into this file. Every one of
// them is read from the tenant's own storefront_config through the same
// lib/brand-theme.js map the mini app and the web storefront already share,
// so this page renders as a Roots page for Roots and as somebody else's page
// for somebody else, with no branch. The seeded Roots theme is a default, not
// a constant.
//
// SERVER-RENDERED IN ONE RESPONSE, on purpose. The customer is standing in a
// shop having just scanned a code, which is the worst possible moment for the
// blank first paint that a fetch-then-render shell gives. The precedent is the
// public tracking page in routes/retail.js, which is the one thing in this
// repo proven to render inside the WeChat in-app browser.
//
// LANGUAGE (§44, and the §26 narrowing). BOTH languages are in the DOM and CSS
// decides which is visible, rather than the server picking one. That is what
// makes the toggle a class swap instead of a reload — and a reload would
// re-run detection, which is exactly what §26's narrowing forbids once the
// reader has chosen. Resolution order: this session's toggle, then ?lang=,
// then the client's own language, then English. Detection selects the opening
// render ONLY and is never consulted again once the toggle is used.
//
// NOTHING BRANCHES ON THE USER AGENT. The page is the same bytes inside the
// WeChat browser and outside it. WeChat is the expected home, not a variant:
// a UA branch here would be a second page to keep correct, and the only
// WeChat-specific thing this page needs — the viewport line — is right for
// every phone. scripts/test_shop_menu.js holds that line.
//
// CHINESE IS COPIED, NEVER COMPOSED (§30). Every 中文 string on this page is
// already live on a customer surface in public/shop.html and is reused
// verbatim: 售罄 (sold out), 暂无商品 / 请稍后再来 (the empty menu), and the
// EN / 中 toggle labels. Category headings come from the tenant's own category
// tree and product names from the tenant's own catalogue, so neither is
// composed here either. The one label with no live source — a word for the
// uncategorised group — is NOT rendered: that group has no heading. See also
// the note on the not-found page below, which is the other place a string
// would otherwise have had to be minted.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { isShopCode } = require('../lib/shop-code');
const { getCategoryTree } = require('../lib/category-tree');
const { themeToCssVars, sanitizeTheme } = require('../lib/brand-theme');
const inventory = require('../lib/inventory');
// resolveProductImage and normalizeCurrency are retail.js's, exported for this
// file so the photo fallback and the money format cannot drift from the
// storefront's. routes/retail-shops.js requires retail.js the same way; both
// are mounted after it in server.js, so the module is fully loaded by then.
const { resolveProductImage, normalizeCurrency } = require('./retail');

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[shop-menu] sharp not available — menu photos serve full size:', e.message);
}

const router = express.Router();

// The channel a shop sale belongs to (§44: till and QR share one channel, and
// order source distinguishes them). Used here only to net off the right
// reservations; 'shop' carries no per-channel quota, so it reads the global
// remaining figure, which is what a menu should show.
const SHOP_CHANNEL = 'shop';

// Menu photo width. One size, because there is one layout and it is a phone.
const MENU_THUMB_W = 320;

// ─── small helpers ──────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One dotted storefront_config key, on the request's tenant scope. Same five
// lines routes/retail-setup.js uses; kept local so this file has no dependency
// on the setup route.
function cfg(key, dflt) {
  try {
    const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : dflt;
  } catch (e) { return dflt; }
}

// A bilingual span pair. BOTH sides are always emitted; CSS shows one. An
// empty side falls back to the other so a half-filled product never renders a
// blank line — the same pick() semantics public/shop.html uses. That fallback
// is a courtesy to a page already live, NOT a substitute for both names being
// present: scripts/check_shop_listing_names.js is the gate that stops a shop
// going live half-translated (§44).
function bi(en, cn) {
  const a = String(en == null ? '' : en).trim();
  const b = String(cn == null ? '' : cn).trim();
  const e = a || b, c = b || a;
  if (!e && !c) return '';
  return `<span class="l-en">${esc(e)}</span><span class="l-cn">${esc(c)}</span>`;
}

// Money in the tenant's own display currency. normalizeCurrency is retail.js's,
// so a tenant that sells in something other than yuan sees one figure format
// across the storefront, the till and this menu.
function money(n, cur) {
  const v = (Number(n) || 0).toFixed(cur.decimals);
  return cur.position === 'after' ? (v + cur.symbol) : (cur.symbol + v);
}

// The library faces this app self-hosts, family -> file under /assets/fonts.
// NOT a brand choice: it is which of lib/brand-fonts.js's library is installed,
// and a theme naming a family that is not here simply falls through to the CJK
// stack. A tenant's own uploaded face arrives instead as theme.fonts.*.url.
const INSTALLED_FACES = {
  'Bear Serif':    'BearSerif.otf',
  'Aleo':          'Aleo-Regular.otf',
  'Toni Grotesk':  'ToniGroteskPro.otf',
  'League Gothic': 'LeagueGothic.ttf',
  'Lilita One':    'LilitaOne.ttf',
  'DF Yuan':       'DFYuanW5.ttf',
};
const FACE_FORMAT = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };

// A display face whose DIGITS do not match its letters, and the library face
// that stands in for them. A price is the second thing a customer reads, so a
// menu whose numerals are thin and geometric beside chunky letters reads as a
// mistake. app.wxss states the problem and this is the same remedy: map the
// digits, the currency signs and the ampersand to the substitute by
// unicode-range. A family that is not here simply sets its own digits.
const DIGIT_SUBSTITUTE = { 'Bear Serif': 'Lilita One' };
const DIGIT_RANGE = 'U+0024-0026, U+0030-0039, U+00A5';

// @font-face rules for the two families THIS TENANT's theme names — an
// installed library face, or the tenant's own https upload. Nothing else is
// emitted, so a tenant on a stock system font ships no font bytes at all.
function fontFaces(fonts) {
  const seen = new Set();
  const out = [];
  for (const slot of ['display', 'body']) {
    const f = fonts && fonts[slot];
    if (!f || !f.family) continue;
    const fam = String(f.family).replace(/'/g, '');
    if (seen.has(fam)) continue;
    seen.add(fam);
    let url = null;
    if (f.source === 'upload' && typeof f.url === 'string' && /^https:\/\//i.test(f.url)) url = f.url;
    else if (INSTALLED_FACES[fam]) url = '/assets/fonts/' + INSTALLED_FACES[fam];
    if (!url) continue;
    const ext = (String(url).toLowerCase().match(/\.(woff2|woff|otf|ttf)(?:[?#]|$)/) || [])[1];
    const fmt = ext ? ` format('${FACE_FORMAT[ext]}')` : '';
    // The substitute goes FIRST and carries the narrow unicode-range, so the
    // full face below it covers everything the range does not claim.
    const sub = DIGIT_SUBSTITUTE[fam];
    if (sub && INSTALLED_FACES[sub]) {
      out.push(`@font-face{font-family:'${fam}';src:url('/assets/fonts/${INSTALLED_FACES[sub]}')` +
        ` format('${FACE_FORMAT[INSTALLED_FACES[sub].split('.').pop()]}');` +
        `unicode-range:${DIGIT_RANGE};font-display:swap;}`);
    }
    out.push(`@font-face{font-family:'${fam}';src:url('${url}')${fmt};font-display:swap;}`);
  }
  return out.join('');
}

// The tenant's theme, assembled from its dotted config keys and handed to the
// shared map. sanitizeTheme inside themeToCssVars fills every missing role, so
// a tenant that has never opened Brand Studio still gets a complete palette.
function themeBits() {
  const theme = {
    palette:  cfg('theme.palette', null),
    fonts:    cfg('theme.fonts', null),
    shape:    cfg('theme.shape', null),
    density:  cfg('theme.density', null),
    audience: cfg('theme.audience', null),
  };
  // SANITISE ONCE AND USE THAT FOR BOTH. Reading the raw config for the font
  // faces while themeToCssVars sanitised its own copy meant a tenant with no
  // saved theme — which is every tenant that has never opened Brand Studio,
  // Roots included — got the DEFAULT family names in the CSS variables and no
  // @font-face for them, so the brand face silently never loaded and the page
  // fell back to a system serif. The two must see the same theme.
  const clean = sanitizeTheme(theme);
  return { vars: themeToCssVars(clean), fonts: clean.fonts };
}

// The tenant's own wordmark text, used as the document title. NOT
// tenantBrandLabel(), which answers 'Roots' for tenant 1 as a literal — this
// page must carry no such literal, so it reads the same brand row the
// storefront's own footer does and falls back to nothing rather than a name.
function brandText() {
  const f = cfg('brand.me_footer', null);
  const w = f && typeof f === 'object' ? f.wordmark_text : null;
  return (typeof w === 'string' && w.trim()) ? w.trim() : '';
}

// ─── data ───────────────────────────────────────────────────────────────

// An opaque code -> the shop, only when the shop AND its location are both
// live. Every other outcome is null, and the caller renders one page for all
// of them (see notFoundPage).
function resolveShop(code) {
  return tdb().prepare(`
    SELECT s.id, s.location_id, s.public_code, s.display_name_en, s.display_name_cn,
           l.name_en AS location_name_en, l.name_cn AS location_name_cn
      FROM shops s
      JOIN retail_stores l ON l.id = s.location_id
     WHERE s.public_code = ? AND s.is_active = 1 AND COALESCE(l.is_active, 1) = 1
  `).get(code) || null;
}

function shopName(shop) {
  return {
    en: shop.display_name_en || shop.location_name_en || '',
    cn: shop.display_name_cn || shop.location_name_cn || '',
  };
}

// A shop's live menu, grouped for display.
//
// AVAILABILITY IS TWO DIFFERENT QUESTIONS (§42, §47):
//   made_here — the staff switch, and nothing else. There is no material stock
//               to consult and §43 defers ever having any.
//   stocked   — the staff switch AND counted units at THIS location. A product
//               with no shelf record here at all is SOLD OUT, not "untracked":
//               §47. The online store's own sellableStockSql takes the
//               opposite view for its own reasons and the two are meant to
//               differ; neither is to be changed to match the other.
function buildMenu(shop) {
  const listings = tdb().prepare(`
    SELECT sl.id, sl.store_product_id, sl.price, sl.fulfilment_mode, sl.is_available,
           sl.sort_position, p.name_en, p.name_cn, p.top_category, p.subcategory, p.updated_at,
           -- Does a photo EXIST for this product? Mirrors resolveProductImage,
           -- including its variant-sibling fallback, so the two never disagree.
           -- Asked here because the alternative is an <img> pointing at a route
           -- that 404s, which a phone draws as a broken-image glyph on the menu.
           (CASE WHEN (p.image_data IS NOT NULL AND p.image_data != '')
                   OR (p.image_url  IS NOT NULL AND p.image_url  != '')
                   OR (p.variant_group_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM store_products sib
                         WHERE sib.variant_group_id = p.variant_group_id
                           AND COALESCE(sib.is_active, 1) = 1
                           AND ((sib.image_data IS NOT NULL AND sib.image_data != '')
                             OR (sib.image_url  IS NOT NULL AND sib.image_url  != ''))))
                 THEN 1 ELSE 0 END) AS has_photo
      FROM shop_listings sl
      JOIN store_products p ON p.id = sl.store_product_id
     WHERE sl.shop_id = ? AND COALESCE(p.is_active, 1) = 1
     ORDER BY sl.sort_position ASC, sl.id ASC
  `).all(shop.id);
  if (!listings.length) return [];

  const stockedIds = listings.filter(r => r.fulfilment_mode === 'stocked').map(r => r.store_product_id);
  const avail = stockedIds.length
    ? inventory.getAvailableMap(shop.location_id, stockedIds, SHOP_CHANNEL)
    : new Map();

  for (const r of listings) {
    if (!r.is_available) { r.sold_out = true; continue; }
    if (r.fulfilment_mode !== 'stocked') { r.sold_out = false; continue; }
    const a = avail.get(r.store_product_id);
    r.sold_out = !a || a.available <= 0;      // absent shelf record IS sold out — §47
  }

  // TWO LEVELS, because that is what the shop already is. The tenant's own
  // category tree gives the rail its top categories and each section its
  // subcategory heading — the same shape miniapp/pages/shop reads, so a
  // customer who knows the online shop recognises this one.
  //
  // A listing with no subcategory sits in a section headed by its top
  // category; one with no top category at all falls to a trailing OTHER
  // band, exactly as the shop's own orphan handling does. Nothing is
  // invented for either: OTHER / 其他 and ALL / 全部 are the shop's own
  // labels, copied.
  const tree = getCategoryTree(tdb());
  const cats = [];
  const byTop = new Map();
  for (const t of tree) {
    const cat = { id: 'c' + cats.length, en: t.name, cn: t.name_cn || '', subs: t.subs || [], sections: [] };
    byTop.set(t.name, cat);
    cats.push(cat);
  }
  const other = { id: 'other', en: 'OTHER', cn: '其他', subs: [], sections: [] };

  for (const r of listings) {
    const cat = (r.top_category && byTop.get(r.top_category)) || other;
    const subNode = cat.subs.find(x => x.name === r.subcategory) || null;
    const key = subNode ? subNode.name : '';
    let sec = cat.sections.find(x => x.key === key);
    if (!sec) {
      sec = {
        key,
        en: subNode ? subNode.name : (cat === other ? '' : cat.en),
        cn: subNode ? (subNode.name_cn || '') : (cat === other ? '' : cat.cn),
        items: [],
      };
      cat.sections.push(sec);
    }
    sec.items.push(r);
  }
  // Sections follow the tree's own subcategory order, not the order products
  // happened to be listed in.
  for (const cat of cats) {
    const order = new Map(cat.subs.map((x, i) => [x.name, i]));
    cat.sections.sort((a, b) => (order.has(a.key) ? order.get(a.key) : -1) - (order.has(b.key) ? order.get(b.key) : -1));
  }
  const out = cats.filter(c => c.sections.length);
  if (other.sections.length) out.push(other);
  return out;
}

// The count beside a section heading, zero-padded to two digits — the shop's
// own countStr treatment.
function pad2(n) { return n < 10 ? '0' + n : String(n); }

// ─── page ───────────────────────────────────────────────────────────────

const VIEWPORT = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';

// NOTHING REACHING THE <style> ELEMENT MAY CLOSE IT.
//
// The values below are operator-authored config, not customer input, but they
// are not validated for this context: lib/brand-theme.js's cleanHex passes any
// string beginning "rgb" or "hsl" through whole, and cleanFont keeps 80
// characters of a family name having stripped only apostrophes. Neither is
// wrong — their consumers set CSS variables from JavaScript, where a stray
// angle bracket is inert. This page is the first to INLINE them into markup,
// so it is the first place where "</style>" in a palette value would be script
// on a public page. Stripped here rather than in brand-theme, because the
// hazard belongs to this context and not to the values.
function cssSafe(s) { return String(s == null ? '' : s).replace(/[<>]/g, ''); }

function styles(vars, faces) {
  // The shop's own visual language, not a second one invented for this page:
  // a 92px category rail on the oat ground with a lime active tab, a paler
  // content pane, letterspaced olive section kickers with a zero-padded count,
  // squared photo cards, and the sold-out bar laid across the bottom of the
  // photo. Values are the mini-app shop's (miniapp/pages/shop/shop.wxss,
  // converted from rpx at a 390px phone) and public/shop.html's, so a customer
  // who knows the online shop recognises the counter menu as the same shop.
  //
  // Every colour and family is still a token from the tenant's theme. The only
  // literals are neutral veils and the black sold-out scrim.
  return `${cssSafe(faces)}
:root{${cssSafe(vars)}}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--oat);color:var(--ink);font-family:var(--f-aleo);
  font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
.lang-en .l-cn,.lang-cn .l-en{display:none}

.bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;
  padding:calc(13px + env(safe-area-inset-top)) 14px 13px;
  background:var(--oat);border-bottom:2px solid var(--ink)}
.nm{flex:1;min-width:0;font-family:var(--f-bear);font-size:21px;line-height:1.1;
  overflow-wrap:anywhere}
.lang{flex:none;display:inline-flex;border:2px solid var(--ink);overflow:hidden;
  background:rgba(255,255,255,.72)}
.lang button{border:0;background:transparent;padding:6px 10px;font:inherit;
  font-family:var(--f-bear);font-size:13px;letter-spacing:.04em;color:var(--olive);cursor:pointer}
.lang button.on{background:var(--lime);color:var(--ink)}

.wrap{display:flex;align-items:stretch;min-height:100vh}

/* ── the rail ── */
.rail{position:sticky;top:0;flex:none;width:92px;height:100vh;overflow-y:auto;
  align-self:flex-start;background:var(--oat);border-right:2px solid var(--ink)}
.rail a{display:flex;align-items:center;gap:2px;padding:16px 5px;
  font-family:var(--f-bear);font-size:13px;line-height:1.15;color:var(--ink);
  text-align:center;text-decoration:none;text-transform:uppercase;
  border-bottom:1px solid rgba(0,0,0,.08)}
.rail a::before{content:'';flex:none;width:9px}
.rail a .lb{flex:1;min-width:0;overflow-wrap:anywhere}
.rail a .cv{flex:none;width:9px;color:var(--olive);font-size:13px;line-height:1}
.rail a.on{background:var(--lime)}
.rail a.on .cv{color:var(--ink)}

/* ── the menu ── */
.pane{flex:1;min-width:0;background:rgba(255,255,255,.62);
  padding-bottom:calc(30px + env(safe-area-inset-bottom))}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  padding:16px 14px 8px}
.kick{font-family:var(--f-bear);font-size:10.5px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--olive);overflow-wrap:anywhere}
.cnt{font-family:var(--f-bear);font-size:18px;letter-spacing:.04em;color:var(--olive);
  font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px 12px;padding:0 14px 6px}
.it{min-width:0}
.ph{position:relative;aspect-ratio:4/5;background:var(--oat);overflow:hidden}
.ph img{width:100%;height:100%;object-fit:cover}
.sold{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.78);color:#fff;
  font-family:var(--f-bear);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
  text-align:center;padding:5px 0}
.t{font-family:var(--f-bear);font-size:15px;line-height:1.25;margin-top:9px;
  overflow-wrap:anywhere}
.pr{font-family:var(--f-bear);font-size:19px;line-height:1;margin-top:7px;
  font-variant-numeric:tabular-nums}
.out .ph img{filter:grayscale(.5);opacity:.72}
.out .t,.out .pr{opacity:.5}

.empty{padding:64px 24px;text-align:center}
.empty .t{font-family:var(--f-bear);font-size:22px;line-height:1.2;margin:0}
.empty .s{margin-top:8px;color:var(--olive);font-size:14px}`;
}

// The pre-paint language script. It runs in <head>, before the body is
// painted, so the page never flashes the wrong language on its way to the
// right one. Order: this session's toggle wins, then an explicit ?lang=, then
// the client's own language, then English. Session storage, not a cookie:
// §44 wants the choice to hold for the session and this page sets no cookies.
function langScript(hasParam) {
  return `(function(){var K='shop_menu_lang',l=null;` +
    `try{l=sessionStorage.getItem(K)}catch(e){/* private mode throws on storage; open in English */}` +
    `if(l!=='en'&&l!=='cn'){l=${hasParam ? 'null' : '((navigator.language||\'\').toLowerCase().indexOf(\'zh\')===0?\'cn\':null)'}}` +
    `if(l==='en'||l==='cn'){var d=document.documentElement;` +
    `d.className='lang-'+l;d.setAttribute('lang',l==='cn'?'zh-CN':'en')}})();`;
}

const TOGGLE_SCRIPT = `(function(){var K='shop_menu_lang';` +
  `document.addEventListener('click',function(e){` +
  `var b=e.target.closest?e.target.closest('[data-lang]'):null;if(!b)return;` +
  `var l=b.getAttribute('data-lang');if(l!=='en'&&l!=='cn')return;` +
  `try{sessionStorage.setItem(K,l)}catch(x){/* private mode throws; the toggle still works, it just will not persist */}` +
  `var d=document.documentElement;d.className='lang-'+l;` +
  `d.setAttribute('lang',l==='cn'?'zh-CN':'en');` +
  `var n=document.querySelectorAll('[data-lang]');` +
  `for(var i=0;i<n.length;i++){var on=n[i].getAttribute('data-lang')===l;` +
  `if(on)n[i].className='on';else n[i].className=''}` +
  `},false)})();` +
  // The rail follows the scroll. Progressive enhancement only: without it the
  // rail is still a working list of anchors, which is the whole of its job.
  `(function(){var r=document.querySelectorAll('.rail a[data-cat]');if(!r.length||!window.IntersectionObserver)return;` +
  `var m={};for(var i=0;i<r.length;i++)m[r[i].getAttribute('data-cat')]=r[i];` +
  `var o=new IntersectionObserver(function(es){for(var i=0;i<es.length;i++){if(!es[i].isIntersecting)continue;` +
  `for(var k in m)m[k].className='';var a=m[es[i].target.id];if(a)a.className='on'}},{rootMargin:'-45% 0px -50% 0px'});` +
  `var c=document.querySelectorAll('.cat');for(var j=0;j<c.length;j++)o.observe(c[j]);})();`;

// EN / 中 — the storefront's own toggle labels, reused verbatim.
function toggle(lang) {
  return `<div class="lang">` +
    `<button type="button" data-lang="en"${lang === 'en' ? ' class="on"' : ''}>EN</button>` +
    `<button type="button" data-lang="cn"${lang === 'cn' ? ' class="on"' : ''}>中</button>` +
    `</div>`;
}

function shell({ lang, hasParam, title, vars, faces, body }) {
  return `<!doctype html><html lang="${lang === 'cn' ? 'zh-CN' : 'en'}" class="lang-${lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="${VIEWPORT}">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${styles(vars, faces)}</style>
<script>${langScript(hasParam)}</script>
</head><body>
${body}
<script>${TOGGLE_SCRIPT}</script>
</body></html>`;
}

// THE NOT-FOUND PAGE IS THE EMPTY-MENU PAGE, AND THAT IS DELIBERATE.
//
// A code that resolves to nothing, a shop switched off and a location switched
// off all return these same bytes with a 404. Two reasons, and the second is
// the load-bearing one:
//
//   1. There is no live or locked Chinese source for "that code is not a
//      shop", and §30 forbids composing one. The empty-menu pair IS live.
//
//   2. THE PAGE MUST NOT BE AN ORACLE FOR GUESSED CODES. The shop code is the
//      whole of what stands between one shop's menu and prices — in a
//      multi-tenant deployment, one tenant's and another's — and anybody
//      editing the address bar (lib/shop-code.js says the same). A reply that
//      distinguished "no such code" from "shop closed" would confirm which
//      guesses had hit a real shop. Customers scan; they never type a code, so
//      telling apart a wrong code and an empty menu buys a real customer
//      nothing and buys a guesser a great deal.
function notFoundPage(req, res) {
  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  const brand = brandText();
  // Never cached: a code that resolves to nothing today may be a live shop
  // tomorrow, and an intermediary holding this 404 would outlast the fix.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(404).type('html').send(shell({
    lang, hasParam: req.query.lang === 'cn' || req.query.lang === 'en',
    title: brand, vars, faces: fontFaces(fonts),
    body: `<div class="bar">${toggle(lang)}</div>
<div class="empty"><div class="t">${bi('No products yet.', '暂无商品')}</div>` +
      `<div class="s">${bi('Check back soon.', '请稍后再来')}</div></div>`,
  }));
}

// ─── routes ─────────────────────────────────────────────────────────────

router.get('/s/:shopCode', (req, res) => {
  const code = String(req.params.shopCode || '');
  // Refused before it can become a query — lib/shop-code.js asks for exactly
  // this, so a malformed path never reaches the database.
  if (!isShopCode(code)) return notFoundPage(req, res);
  const shop = resolveShop(code);
  if (!shop) return notFoundPage(req, res);

  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  const hasParam = req.query.lang === 'cn' || req.query.lang === 'en';
  const cur = normalizeCurrency(cfg('currency', null));
  const name = shopName(shop);
  const groups = buildMenu(shop);
  const brand = brandText();

  const head = `<div class="bar"><div class="nm">${bi(name.en, name.cn)}</div>${toggle(lang)}</div>`;

  // The rail: ALL, every category holding something, then OTHER. Anchors, not
  // tabs — a menu is short enough to scroll, and an anchor needs no state and
  // no script to work. ALL / 全部 and OTHER / 其他 are the shop's own labels.
  const rail = groups.length
    ? `<nav class="rail"><a href="#top" data-cat="top" class="on">${bi('ALL', '全部')}</a>` +
      groups.map(c => `<a href="#${c.id}" data-cat="${c.id}">` +
        `<span class="lb">${bi(c.en, c.cn)}</span><span class="cv">\u203a</span></a>`).join('') +
      `</nav>`
    : '';

  const card = (it) => {
    const src = `/s/${esc(code)}/i/${it.store_product_id}` +
      `?v=${encodeURIComponent(it.updated_at || '')}&w=${MENU_THUMB_W}`;
    // No photo → the empty frame, never an <img> that cannot resolve. A
    // product nobody has photographed is ordinary; a broken-image glyph beside
    // its name reads as a fault in the shop.
    const photo = it.has_photo
      ? `<img src="${src}" alt="" loading="lazy" decoding="async">`
      : '';
    return `<div class="it${it.sold_out ? ' out' : ''}">` +
      `<div class="ph">${photo}` +
      (it.sold_out ? `<div class="sold">${bi('Sold out', '售罄')}</div>` : '') +
      `</div>` +
      `<div class="t">${bi(it.name_en, it.name_cn)}</div>` +
      `<div class="pr">${esc(money(it.price, cur))}</div>` +
      `</div>`;
  };

  // The launch state. shops and shop_listings are both empty, so this is the
  // first thing anybody will see and it is a first-class state, not an edge
  // case. Strings are the storefront's own, live.
  const body = groups.length
    ? `<div class="wrap">${rail}<div class="pane">` +
      groups.map(c => `<section class="cat" id="${c.id}">` +
        c.sections.map(sec => `<div class="sec-h">` +
            `<div class="kick">${bi(sec.en, sec.cn)}</div>` +
            `<div class="cnt">${pad2(sec.items.length)}</div>` +
          `</div><div class="grid">${sec.items.map(card).join('')}</div>`).join('') +
        `</section>`).join('') +
      `</div></div>`
    : `<div class="empty"><div class="t">${bi('No products yet.', '暂无商品')}</div>` +
      `<div class="s">${bi('Check back soon.', '请稍后再来')}</div></div>`;

  // A menu is priced and stocked; it must never be served from an
  // intermediary's cache. The shop code is also not something to index.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('html').send(shell({
    lang, hasParam,
    title: [name.en || name.cn, brand].filter(Boolean).join(' · '),
    vars, faces: fontFaces(fonts), body: `<a id="top"></a>` + head + body,
  }));
});

// A menu photo.
//
// GATED ON "LISTED AT AN ACTIVE SHOP", NOT ON is_published — ruled 2026-09-06.
// is_published governs the ONLINE STORE; a shop listing governs the SHOP. They
// are different questions and tying them would mean a product could be on a
// counter menu with its photo refused, purely because nobody had also chosen
// to sell it on the website. The public storefront twin of this route
// (routes/retail.js, /api/retail/products/:id/image) keeps its own
// is_published gate and is unchanged.
const PHOTO_CACHE = new Map();
const PHOTO_CACHE_MAX = 300;

router.get('/s/:shopCode/i/:productId', async (req, res) => {
  const code = String(req.params.shopCode || '');
  const id = parseInt(req.params.productId, 10);
  if (!isShopCode(code) || !Number.isFinite(id) || id <= 0) return res.status(404).end();

  let w = parseInt(req.query.w, 10);
  w = (sharp && Number.isFinite(w)) ? Math.max(80, Math.min(1200, w)) : 0;
  const ver = String(req.query.v || '');

  let tkey = 'default';
  try { tkey = tdb().name || 'default'; } catch (e) { /* no tenant scope on this request; the default key is correct, not a fallback */ }
  const ckey = `${tkey}|${code}|${id}|w${w || 0}|${ver}`;
  const hit = PHOTO_CACHE.get(ckey);
  if (hit) {
    res.set('Content-Type', hit.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(hit.buf);
  }

  const gate = tdb().prepare(`
    SELECT 1 FROM shop_listings sl
      JOIN shops s          ON s.id = sl.shop_id
      JOIN retail_stores l  ON l.id = s.location_id
     WHERE s.public_code = ? AND sl.store_product_id = ?
       AND s.is_active = 1 AND COALESCE(l.is_active, 1) = 1
  `).get(code, id);
  const data = gate && resolveProductImage(id);
  if (!data) return res.status(404).end();

  const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(data);
  if (!m) return res.redirect(String(data));
  const mime = m[1] || 'application/octet-stream';
  let buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  let outMime = mime;
  if (w && /^image\//i.test(mime) && !/svg/i.test(mime)) {
    try {
      let pipe = sharp(buf).resize({ width: w, withoutEnlargement: true });
      if (/jpe?g/i.test(mime))    pipe = pipe.jpeg({ quality: 72, mozjpeg: true });
      else if (/png/i.test(mime)) pipe = pipe.png({ compressionLevel: 9, palette: true });
      const out = await pipe.toBuffer({ resolveWithObject: true });
      buf = out.data;
      outMime = 'image/' + out.info.format;
    } catch (e) { /* keep the original bytes */ }
  }
  if (PHOTO_CACHE.size >= PHOTO_CACHE_MAX) PHOTO_CACHE.delete(PHOTO_CACHE.keys().next().value);
  PHOTO_CACHE.set(ckey, { buf, mime: outMime });
  res.set('Content-Type', outMime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

module.exports = router;
