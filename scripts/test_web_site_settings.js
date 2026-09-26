#!/usr/bin/env node
/**
 * The editor stage is the website first, and the website has its own words — §273.
 *
 * Two things Ash asked for in one shot ("desktop first then phone. do all on
 * one shot"):
 *   §1 the website's own settings — title, menu, footer — are cleaned on the
 *      server (routes/integrations-admin.js normalizeWebSite), and nothing
 *      but a plain string, 'home', 'shop' or an http(s) address gets through
 *   §2 the web shop reads them for the header menu, the footer and the
 *      browser-tab title, and falls back to Home + Shop and the brand name
 *   §3 the editor's stage: Desktop first, the phone second, the Desktop
 *      button disabled off Home, and the frame wired both ways
 *   §4 the web shop in stage mode: a click on a block selects it in the
 *      editor, every other click is inert, and the draft arrives by message
 *
 * The server helper is lifted out of the shipped file and run, not re-typed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROUTE = read('routes/integrations-admin.js');
const SHOP = read('public/shop.html');
const CMS = read('public/cms.html');
const ADMIN = read('public/retail-admin/15-integrations.js');
const BLOCKS = read('public/shop/blocks.js');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

function slice(src, open, close) {
  const a = src.indexOf(open);
  if (a < 0) throw new Error(`not found: ${open}`);
  const b = src.indexOf(close, a);
  if (b < 0) throw new Error(`no close after: ${open}`);
  return src.slice(a, b + close.length);
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · the website\'s own words are cleaned on the way in');

const srv = { console };
vm.createContext(srv);
vm.runInContext(
  slice(ROUTE, 'const WEB_SITE_MAX = ', '    links,\n  };\n}') + '\nthis.normalizeWebSite = normalizeWebSite;',
  srv,
);
const N = srv.normalizeWebSite;

is(N(null), { title_en: '', title_cn: '', description_en: '', description_cn: '', nav: [], footer_en: '', footer_cn: '', links: [] },
  'nothing saved yet is a complete, empty shape (the shop never sees undefined)');
is(N({ title_en: '  Roots   Kitchen ', title_cn: '根源厨房' }).title_en, 'Roots Kitchen', 'a title is trimmed and its spaces folded');
is(N({ title_en: 'x'.repeat(200) }).title_en.length, 80, 'a title is capped at 80');
is(N({ description_en: 'y'.repeat(500) }).description_en.length, 200, 'a description is capped at 200');
{
  const out = N({ nav: [
    { label_en: 'Home', label_cn: '首页', target: 'home' },
    { label_en: 'Shop', target: 'shop' },
    { label_en: 'About', target: 'https://example.com/about' },
    { label_en: 'Bad', target: 'javascript:alert(1)' },
    { label_en: 'Bad2', target: 'category:3' },
    { label_en: '', label_cn: '', target: 'home' },
  ] });
  is(out.nav.map(n => n.target), ['home', 'shop', 'https://example.com/about'],
    'a menu link goes to home, shop or an http(s) address — a script, an unknown target or an unlabelled row is dropped');
  is(out.nav[1].label_cn, '', 'a missing Chinese label is an empty string, not undefined');
}
is(N({ nav: Array.from({ length: 10 }, (_, i) => ({ label_en: 'L' + i, target: 'home' })) }).nav.length, 6, 'the menu is capped at six links');
{
  const out = N({ links: [
    { label_en: 'Weibo', url: 'https://weibo.com/roots' },
    { label_en: 'Mail', url: 'mailto:hi@roots.cn' },
    { label_en: 'Plain', url: 'roots.cn' },
    { label_en: 'Quote', url: 'https://x.y/"onclick=' },
  ] });
  is(out.links.map(l => l.url), ['https://weibo.com/roots'], 'a footer link is an http(s) address and nothing else');
}
is(N({ links: Array.from({ length: 9 }, (_, i) => ({ label_en: 'L' + i, url: 'https://a.b/' + i })) }).links.length, 6, 'footer links are capped at six');
is(N({ nav: 'nope', links: { a: 1 } }).nav, [], 'a non-array where a list should be is an empty list');

yes(/router\.post\('\/api\/retail-admin\/channel-hub\/web\/site', requireRetailAdmin, express\.json\(\{ limit: '64kb' \}\)/.test(ROUTE),
  'the save route is admin-only and reads a bounded body');
yes(/webCfgSet\('web\.site', site\)/.test(ROUTE), 'it stores the cleaned shape, never the raw body');
yes(/site: normalizeWebSite\(webCfgGet\('web\.site', null\)\)/.test(ROUTE), 'the config page reads the same cleaned shape back');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the web shop wears the words, and falls back without them');

yes(/function renderSiteChrome\(\)/.test(SHOP) && /renderSiteChrome\(\);/.test(slice(SHOP, 'function applyLangToUI(){', '\n}')),
  'the header menu and footer are rebuilt whenever the language is applied');
yes(/\{label_en:'Home',label_cn:'首页',target:'home'\},\{label_en:'Shop',label_cn:'商品',target:'shop'\}/.test(SHOP),
  'with no menu saved the header still reads Home · 首页 and Shop · 商品');
yes(/a\.dataset\.nav='home'/.test(SHOP) && /a\.dataset\.nav='shop'/.test(SHOP), 'home and shop links keep the data-nav the router highlights');
yes(/if\(\/\^https\?:\\\/\\\/\/i\.test\(it\.target\|\|''\)\)\{ a\.href=it\.target; a\.target='_blank'; a\.rel='noopener'; \}/.test(SHOP),
  'an address link opens in a new tab with noopener');
yes(/else continue;/.test(slice(SHOP, 'function renderSiteChrome(){', 'nav.appendChild(a);')), 'anything else is skipped, never rendered as a link');
yes(/function siteTitle\(\)\{ const t=sitePick\(siteCfg\(\)\.title_en,siteCfg\(\)\.title_cn\); return t\|\|state\.brand; \}/.test(SHOP),
  'the tab title is the site title, else the brand name');
yes(/document\.title=siteTitle\(\);/.test(slice(SHOP, 'async function renderHome(){', 'const published')), 'the home route sets it');
yes(/meta\[name="description"\]/.test(SHOP) && /desc\.content=d;/.test(SHOP), 'the search description is written into a meta tag when set');
yes(/l\.target='_blank'; a\.rel='noopener'/.test(SHOP) === false && /a\.href=l\.url; a\.target='_blank'; a\.rel='noopener'/.test(SHOP),
  'footer links open in a new tab with noopener');
yes(!/document\.querySelector\('nav\.links \[data-nav=home\]'\)\.textContent/.test(SHOP),
  'the old hard-coded Home/Shop relabel is gone (it would throw on a custom menu)');

// ─────────────────────────────────────────────────────────────────────────
section('3 · the editor stage: Desktop first, the phone second');

yes(/stage: 'desktop',/.test(CMS), 'the stage preference defaults to desktop');
yes(/state\.stage = localStorage\.getItem\(STAGE_KEY\) \|\| 'desktop'/.test(CMS), '…and is read back as desktop when nothing was chosen');
yes(/function stageAllowed\(\) \{ return state\.page === 'home'; \}/.test(CMS), 'only Home may use the desktop stage');
yes(/return \(state\.stage === 'desktop' && stageAllowed\(\)\) \? 'desktop' : 'phone';/.test(CMS), 'off Home the phone stage is what shows');
yes(/b\.disabled = !stageAllowed\(\);/.test(CMS), 'the Desktop button is disabled off Home');
yes(/ifr\.src = '\/shop-preview\?draft=1&stage=1';/.test(CMS), 'the desktop stage is the real web shop in draft + stage mode');
yes(/width: 1280px;/.test(CMS) && /const scale = Math\.min\(1, w \/ 1280\);/.test(CMS), 'rendered 1280px wide and scaled to the canvas');
yes(/type: 'cms:draft',/.test(CMS) && /layout: state\.draft\.map\(b => \(\{ \.\.\.b, show_on: showOnFor\(b\) \}\)\)/.test(CMS),
  'every preview render posts the draft with show_on made explicit');
yes(/pushDraftToStage\(\);\n  renderStageBar\(\);/.test(slice(CMS, 'function renderPreview() {', "const mount = $('#phone-content');")), 'renderPreview() feeds the stage first');
yes(/if \(effectiveStage\(\) === 'desktop'\) \{ _phoneStale = true; return; \}/.test(CMS) && /else if \(_phoneStale\) \{\n    renderPreview\(\);/.test(CMS),
  'the hidden phone DOM is not rebuilt per keystroke on the desktop stage, and is rebuilt when the phone stage returns');
yes(/panel\.hidden = !\(id && \(wrap \|\| effectiveStage\(\) === 'desktop'\)\);/.test(CMS), 'the floating inspector still shows for a block selected on the desktop stage');
yes(/ev\.data\.type === 'cms:select'/.test(CMS) && /selectBlock\(ev\.data\.id\)/.test(CMS), 'a click in the frame selects the block in the editor');
yes(/ev\.source !== _stageIframe\.contentWindow\) return;/.test(CMS), '…and only the stage frame is listened to');
yes(/if \(!id \|\| effectiveStage\(\) === 'desktop'\) \{ tb\.style\.display = 'none'; return; \}/.test(CMS),
  'the phone\'s floating toolbar hides on the desktop stage and shows on the phone stage — the EFFECTIVE stage, so it is there off Home');
yes(/id="ds-sel"/.test(CMS) && /data-action="up"/.test(slice(CMS, 'id="ds-sel"', '</div>')), 'the stage bar carries the block actions instead');
yes(/applyStage\(\);\n  \/\/ Keep the live-mirror iframe in sync/.test(CMS) && /applyStage\(\);   \/\/ Desktop first/.test(CMS),
  'the stage is applied on first load and on every page switch');
yes(/const STAGE_KEY = 'cms_stage';/.test(CMS) && CMS.indexOf("const STAGE_KEY") < CMS.indexOf("localStorage.getItem(STAGE_KEY)"),
  'STAGE_KEY is declared before the boot code that reads it');

// ─────────────────────────────────────────────────────────────────────────
section('4 · the web shop as a stage');

yes(/STAGE_MODE=DRAFT_MODE&&new URLSearchParams\(location\.search\)\.get\('stage'\)==='1';/.test(SHOP), 'stage mode needs draft mode too');
yes(/ev\.data\.type==='cms:draft'&&STAGE_MODE/.test(SHOP) && /state\.config\.home\.layout=layout;/.test(SHOP),
  'the editor\'s draft replaces the home layout without a round trip');
yes(/if\(key===stageKey&&!langChanged&&parseHash\(\)\.seg\.length===0\)\{ stageHighlight\(true\); return; \}/.test(SHOP),
  'an unchanged layout (a click that only selected a block) is a highlight, not a re-render');
yes(/if\(idKey!==stageIdKey\)\{ stageIdKey=idKey; state\.homeProducts=null; \}/.test(SHOP),
  'products are re-fetched only when the set of products the layout names changed');
yes(/parent\.postMessage\(\{type:'cms:select',id\},location\.origin\)/.test(SHOP), 'a click on a block tells the editor which one');
yes(/if\(ev\.target\.closest\('a,button,form'\)\)\{ ev\.preventDefault\(\); ev\.stopPropagation\(\); \}/.test(SHOP), 'every other link and button is inert');
yes(/\},true\);/.test(slice(SHOP, "document.addEventListener('click',ev=>{", '},true);')), '…caught in the capture phase, before the shop\'s own handlers');
yes(/parent\.postMessage\(\{type:'cms:stage-ready'\},location\.origin\)/.test(SHOP), 'the page tells the editor when it is up');
yes(/data-block-id="' \+ attr\(b\.id \|\| ''\) \+ '"/.test(BLOCKS), 'every block carries its id in the DOM for the stage to find');
yes(/var hintPc = ownHint \|\| \(CN\(\) \? '微信扫码添加' : 'Scan with WeChat to add us'\);/.test(BLOCKS),
  'a WeCom hint the merchant wrote shows on both widths; only the default long-press line is swapped on a PC');
yes(/\.cms-stage \.sb-blk-outer\.cms-selected\{outline:2px solid #6E67AF/.test(SHOP), 'the selected block wears the editor\'s ring');

// ─────────────────────────────────────────────────────────────────────────
section('5 · the back-office card');

yes(/cuT\('Title, menu and footer', '标题、菜单与页脚'\)/.test(ADMIN), 'the Web store configuration page has the card');
yes(/'\/api\/retail-admin\/channel-hub\/web\/site', \{ method: 'POST', body: _webSite \|\| WC_SITE_EMPTY\(\) \}/.test(ADMIN), 'the page\'s one Save button saves it');
yes(/_webSite\[kind\]\.length >= 6\) return;/.test(ADMIN) === false && /\(_webSite\[kind\] \|\| \[\]\)\.length >= 6\) return;/.test(ADMIN), 'the card stops at six links, like the server');
yes(/const problems = wcSiteProblems\(\);\n    if \(problems\.length\) \{/.test(ADMIN) && ADMIN.indexOf('const problems = wcSiteProblems()') < ADMIN.indexOf("'/api/retail-admin/channel-hub/web/signin', { method: 'POST', body }"),
  'a row the server would drop is named to the operator before anything is sent');
yes(/u = 'https:\/\/' \+ u;/.test(ADMIN), 'a bare domain gets its https:// instead of being dropped');
yes(/failed\.push\(cuT\('sign-in', '登录'\)\)/.test(ADMIN) && /failed\.push\(cuT\('title, menu and footer', '标题、菜单与页脚'\)\)/.test(ADMIN),
  'the two writes are reported apart, so a failure names the part');

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
