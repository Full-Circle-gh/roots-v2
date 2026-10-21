#!/usr/bin/env node
/**
 * test_settings_groups.js — Settings is nine groups named by the question the
 * tenant asks, every card keeps one visible line, and the rest opens from a
 * "?" (decisions §494, 2026-10-21).
 *
 *   node scripts/test_settings_groups.js
 *
 * THE FINDING. Eight panels named by mechanism: Push notifications held tax,
 * Operations held everything that had nowhere else to go, two logs sat beside
 * Shop tab as if they were settings, and every card showed a 150–260 character
 * paragraph in two languages all the time. A tenant could not find a setting
 * in a second.
 *
 * Read from the markup and the modules, not rendered: each claim is about
 * WHERE a thing is and WHAT the files state. No browser — fast shard.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('public/retail-admin.html');
const CSS  = read('public/retail-admin.css');
const CORE = read('public/retail-admin/01-core.js');
const OPS  = read('public/retail-admin/02-settings-ops.js');
const MKT  = read('public/retail-admin/05-marketing.js');
const DLV  = read('public/retail-admin/06-delivery.js');

const cfgStart = HTML.indexOf('<section id="tab-config">');
const CFG = HTML.slice(cfgStart, HTML.indexOf('\n  </section>', cfgStart));
const NOC = CFG.replace(/<!--[\s\S]*?-->/g, '');

function panelOf(needle) {
  const at = NOC.indexOf(needle);
  if (at < 0) return null;
  const open = NOC.lastIndexOf('class="sub-panel', at);
  const m = NOC.slice(open, open + 80).match(/id="(sub-[a-z-]+)"/);
  return m ? m[1] : null;
}
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

section('1 · nine groups, in the order a tenant asks');
{
  const navs = [...NOC.matchAll(/<button data-sub="([a-z-]+)"/g)].map((m) => m[1]);
  is(navs, ['store', 'shop', 'payments', 'delivery', 'push', 'printing', 'features', 'advanced', 'history'], 'the left list');
  const panels = [...NOC.matchAll(/class="sub-panel[^"]*" id="sub-([a-z-]+)"/g)].map((m) => m[1]);
  is(panels, navs, 'and the panels, in the same order');
  for (const gone of ['sub-ops', 'sub-cs', 'sub-sent', 'sub-sku']) yes(!NOC.includes('id="' + gone + '"'), gone + ' is gone');
  const sep = NOC.indexOf('class="settings-nav-sep"');
  yes(sep > NOC.indexOf('<button data-sub="features"') && sep < NOC.indexOf('<button data-sub="advanced"'),
    'a divider separates the seven a tenant changes from Advanced and History');
  yes(/<div class="settings-nav-rows">/.test(NOC), 'the rows sit in a wrapper, so the phone can lay them out as one scrolling row');
  yes(/<button data-sub="store" class="active"/.test(NOC) && /class="sub-panel active" id="sub-store"/.test(NOC), 'Store is the panel Settings opens on');
  yes(/<button data-sub="payments"[^>]*data-cap="settings:payments"/.test(NOC) && /<button data-sub="delivery"[^>]*data-cap="delivery:view"/.test(NOC),
    'Payments & tax and Delivery & pickup keep their capability gates');
  for (const [en, cn] of [['Store', '门店'], ['Online shop', '线上商城'], ['Payments &amp; tax', '收款与税费'], ['Delivery &amp; pickup', '配送与自提'],
    ['Notifications', '通知'], ['Printing', '打印'], ['Features', '功能开关'], ['Advanced', '高级'], ['History', '记录']]) {
    yes(NOC.includes(en + ' · ' + cn), 'the row reads ' + en + ' · ' + cn);
  }
}

section('2 · each thing lives where its question is asked');
{
  const where = {
    'id="ops-openclose"': 'sub-store', 'id="ops-stores-list"': 'sub-store', 'id="cfg-low-stock"': 'sub-store', 'id="qs-home"': 'sub-store',
    'id="cfg-shop-layout"': 'sub-shop', 'id="ppg-settings-card"': 'sub-shop', 'id="cs-cards"': 'sub-shop', 'id="cfg-cs-mode"': 'sub-shop', 'id="cfg-support-btn"': 'sub-shop',
    'id="cfg-currency"': 'sub-payments', 'id="cfg-tax-enabled"': 'sub-payments', 'id="alipay-manual-enabled"': 'sub-payments',
    'id="dlv-hub-holiday"': 'sub-delivery', 'id="kd100-key"': 'sub-delivery', 'id="jd-app_key"': 'sub-delivery', 'id="dlv-bulk-trk"': 'sub-delivery',
    'id="notif-template-card"': 'sub-push', 'id="wecom-app-corp_id"': 'sub-push', 'id="lowstock-digest-card"': 'sub-push', 'id="cfg-lowstock-digest"': 'sub-push', 'id="kprep-card"': 'sub-push', 'id="sysalert-card"': 'sub-push',
    'id="feie-stores"': 'sub-printing', 'id="feie-user"': 'sub-printing', 'id="dlv-jd-autoprint"': 'sub-printing', 'id="dlv-box-label"': 'sub-printing',
    'id="waste-settings-home"': 'sub-features', 'id="mat-settings-home"': 'sub-features', 'id="lowstock-settings-home"': 'sub-features', 'id="feat-links"': 'sub-features',
    'id="integrations-status"': 'sub-advanced', 'id="sku-root"': 'sub-advanced',
    'id="ch-table"': 'sub-history', 'id="nl-table"': 'sub-history', 'id="ops-recycle-body"': 'sub-history',
  };
  for (const [needle, panel] of Object.entries(where)) is(panelOf(needle), panel, needle + ' → ' + panel);
  const push = NOC.slice(NOC.indexOf('id="sub-push"'), NOC.indexOf('id="sub-printing"'));
  const toCust = push.indexOf('To customers · 发给顾客'), toTeam = push.indexOf('To your team · 发给团队');
  yes(toCust > 0 && toTeam > toCust, 'Notifications is two sections, customers first');
  yes(push.indexOf('id="notif-template-card"') > toCust && push.indexOf('id="notif-template-card"') < toTeam, 'the order-status template is under To customers');
  yes(push.indexOf('id="wecom-app-corp_id"') > toTeam, 'the new-order alert is under To your team');
  yes(!/Ownership · 归属/.test(NOC), 'no panel carries a card without a control');
  yes(!NOC.includes('<h3>Operations') && !NOC.includes('<h2>Operations'), 'nothing is called Operations any more');
}

section('3 · each panel reads its live parts when it opens');
{
  const sw = CORE.slice(CORE.indexOf('// ── Settings sub-nav switcher ──'), CORE.indexOf('// ── Live push (SSE)'));
  for (const [sub, fn] of [['store', 'loadStorePanel'], ['payments', 'loadAlipayManual'], ['delivery', "dlvGo('hub')"], ['delivery', 'loadShippingIntegrations'],
    ['printing', 'loadPrinterPrefs'], ['features', 'paintFeatureLinks'], ['advanced', 'loadIntegrationsStatus'], ['advanced', 'skuLoad'],
    ['history', 'chLoad'], ['history', 'nlLoad'], ['history', 'loadRecycle']]) {
    yes(new RegExp("sub === '" + sub + "'[^\\n]*" + fn.replace(/[()'.]/g, '\\$&')).test(sw), sub + ' → ' + fn);
  }
  yes(!/sub === 'ops'|sub === 'sent'|sub === 'sku'|sub === 'cs'/.test(sw), 'and nothing waits for a panel that is gone');
  const store = OPS.slice(OPS.indexOf('function loadStorePanel()'), OPS.indexOf('function _cfgCards()'));
  yes(/loadOpenClose\(\)/.test(store) && /loadOpsStores\(\)/.test(store), 'loadStorePanel reads open/closed and the store list');
  yes(!/function loadOpsPanel\(/.test(OPS), 'loadOpsPanel is gone with the panel');
  const tab = CORE.slice(CORE.indexOf("$$('.tabs [data-tab]').forEach(btn => btn.addEventListener('click'"), CORE.indexOf('function salesGo('));
  yes(/btn\.dataset\.tab === 'config'[\s\S]{0,200}#settings-nav button\.active[\s\S]{0,80}lit\.click\(\)/.test(tab),
    'opening the Settings tab runs the lit panel\'s loader — Store is live data');
  yes(/card: 'customer_service', root: '#cs-cards'/.test(MKT), 'the customer-service autosave card follows its six cards into Online shop');
  yes(/function settingsOpen\(sub, view\)/.test(CORE) && /dlvGo\(view\)/.test(CORE.slice(CORE.indexOf('function settingsOpen('), CORE.indexOf('function settingsOpen(') + 600)),
    'settingsOpen() opens a panel, and a Delivery sub-view, from anywhere');
  const links = MKT.slice(MKT.indexOf('function paintFeatureLinks()'), MKT.indexOf('function mountFeatureControls()'));
  yes(/FEATURE_PAGE\[f\.key\]/.test(links) && /goTab\(/.test(links) && !/data-feat-toggle/.test(links),
    'Features lists the switches that live on other pages with a door each — never a second switch');
  yes(/batch-enabled/.test(links) && /settingsOpen\('delivery', 'fresh'\)/.test(links), '…Fresh batches among them, opening its Delivery view');
}

section('4 · one visible line per card; the rest behind a "?"');
{
  const heads = (NOC.match(/<div class="group-card-head">/g) || []).length;
  const leads = (NOC.match(/class="muted card-lead"/g) || []).length;
  const qs = (NOC.match(/class="help-q"/g) || []).length;
  const helps = (NOC.match(/<div class="card-help" hidden>/g) || []).length;
  yes(heads >= 40, heads + ' card heads');
  yes(leads >= heads - 6, leads + ' of them carry a lead line', 'heads ' + heads);
  is(qs, helps, 'every "?" has a hidden help block, and every help block a "?" (' + qs + ')');
  yes(qs >= 30, 'most cards have more to say than one line (' + qs + ')');
  // a lead is one line: the English half stays short
  let long = 0;
  for (const m of NOC.matchAll(/class="muted card-lead">([\s\S]*?)<\/div>/g)) {
    const inner = m[1];
    const en = /data-lang-block="en">([\s\S]*?)<\/span>/.test(inner) ? inner.match(/data-lang-block="en">([\s\S]*?)<\/span>/)[1] : inner.split(' · ')[0];
    if (strip(en).length > 170) long++;
  }
  yes(long <= 3, 'no more than three leads run past 170 characters (' + long + ')');
  // the hidden text is still what search reads
  yes(/\.card-help p/.test(OPS.slice(OPS.indexOf('function cardKeywords('), OPS.indexOf('function cardKeywords(') + 500)),
    'the command palette indexes the folded help');
  yes(/card\.textContent/.test(OPS.slice(OPS.indexOf('function _cfgCards('), OPS.indexOf('function cfgSearch('))),
    'and the Settings search reads the whole card, hidden text included');
  // the controller
  const ctl = CORE.slice(CORE.indexOf('// ── The "?" on a settings card (decisions §494)'), CORE.indexOf('function settingsOpen('));
  yes(/closest\('\.help-q'\)/.test(ctl) && /addEventListener\('click'/.test(ctl), 'opens on tap or click, delegated off document');
  yes(!/mouseover|mouseenter|pointerenter/.test(ctl), 'never on hover alone — half the team is on a phone');
  yes(/e\.key === 'Escape'/.test(ctl) && /help-pop-x/.test(ctl), 'closes on Escape and on its ✕');
  yes(/cloneNode\(true\)/.test(ctl) && /onLangChange/.test(ctl), 'shows a clone of the hidden text and closes on a language change');
  yes(/aria-label', cuT\('What this does', '说明'\)/.test(ctl), 'the "?" is named for a screen reader, in the live language');
  yes(/aria-expanded/.test(ctl), 'and says whether it is open');
  yes(/\.help-pop \{[^}]*position: fixed/.test(CSS) && /\.help-pop\.on \{/.test(CSS), 'the popover is one fixed element that settles in');
  const phone = CSS.slice(CSS.indexOf('@media (max-width: 820px) {\n    .help-pop {'), CSS.indexOf('@media (prefers-reduced-motion: reduce) { .help-pop'));
  yes(/bottom: 0;/.test(phone) && /border-radius: 14px 14px 0 0/.test(phone), 'on a phone it is a bottom sheet');
  yes(/\.settings-nav-rows \{[^}]*flex-direction: row/.test(phone) && /overflow-x: auto/.test(phone), 'and the left list is one scrolling row of chips');
  yes(/\.help-pop, \.help-q \{ transition: none; \}/.test(CSS), 'motion respects prefers-reduced-motion');
}

section('5 · the design system, on every settings page');
{
  yes(!/gap:8px; font-weight:700/.test(NOC) && !/font-weight:600">Auto-send/.test(NOC), 'labels are Inter 500, never bold (§2)');
  yes(!/color:#991b1b/.test(NOC), 'no hardcoded red on a label');
  const btns = [...NOC.matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);
  yes(!btns.some((t) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}↻]/u.test(t)), 'no emoji in a button (§6: labels are verbs)');
  yes(!/>OFF · 关闭<|>ON · 开启</.test(NOC) && !/'ON · 开启' : 'OFF · 关闭'/.test(DLV), 'switch labels are sentence case (§1.16)');
  for (const [mod, name] of [[OPS, '02-settings-ops.js'], [MKT, '05-marketing.js']]) {
    yes(!/#d1fae5|#fee2e2|#fef3c7|#e5e7eb/.test(mod), name + ' paints no inline-styled chip');
    yes(!/LIVE · |NOT CONFIGURED|NOT SET|PENDING JD/.test(mod), name + ' has no shouting pill');
  }
  yes(/\.td-pill-sage/.test(CSS) && /\.td-pill-amber/.test(CSS) && /\.td-pill-quiet/.test(CSS), 'three pills: Sage on, Amber needs you, quiet otherwise (§1.10)');
  yes(/\.td-note-brick/.test(CSS) && /\.td-note-amber/.test(CSS) && /td-note td-note-brick/.test(OPS), 'the geocode errors are inline notes in the tint for their weight (§1.12)');
  yes(!/text-transform:uppercase/.test(OPS.slice(OPS.indexOf('async function loadPrinterPrefs()'), OPS.indexOf('function _renderThermal('))),
    'the per-store printer labels are the shared field label, not uppercase');
  yes(/\.sub-panel > h2\.settings-section \{[^}]*font-size: 18px/.test(CSS), 'a section inside a panel is the 18px Title step');
}

section('6 · nothing still names the old panels to the operator');
{
  const strings = (CORE + OPS + MKT + read('public/retail-admin/04-orders.js')).match(/'[^'\n]*Settings → [^'\n]*'/g) || [];
  yes(!strings.some((s) => /Operations|Push notifications|Customer service'/.test(s)), 'no JS string sends anyone to Operations or Push notifications', strings.filter((s) => /Operations|Push notifications/.test(s)).join('\n      '));
  yes(!/Settings › Operations/.test(HTML.replace(/<!--[\s\S]*?-->/g, '')), 'the support panel points at Online shop');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
