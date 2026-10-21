#!/usr/bin/env node
/**
 * test_settings_payments_panel.js — the money cards have a room of their own,
 * and three things left Settings (decisions §494, 2026-10-21).
 *
 *   node scripts/test_settings_payments_panel.js
 *
 * THE FINDING. Currency, Tax and the manual-Alipay 收款码 sat inside the Push
 * notifications panel, where nobody looking for a money setting would open.
 * The Operations panel opened with an "Ownership" card that had no control on
 * it, and the geocoding card told a tenant to edit `/root/roots-v2/.env` and
 * restart pm2 — an instruction for whoever hosts Tacet, on a screen the tenant
 * reads. And the Push panel was the last one with a shared "Save settings" bar
 * at its foot, which three cards' help text had to point at.
 *
 * Read from the markup and the modules, not rendered: each claim here is about
 * WHERE a thing is, which the files state directly.
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

const HTML  = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const CORE  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/01-core.js'), 'utf8');
const OPS   = fs.readFileSync(path.join(ROOT, 'public/retail-admin/02-settings-ops.js'), 'utf8');
const MKT   = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'public/retail-admin/17-setup-guide.js'), 'utf8');
const CSS   = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');

const cfgStart = HTML.indexOf('<section id="tab-config">');
const CFG = HTML.slice(cfgStart, HTML.indexOf('</section>', cfgStart));

// Which Settings panel a piece of markup sits in.
function panelOf(needle) {
  const at = CFG.indexOf(needle);
  if (at < 0) return null;
  const open = CFG.lastIndexOf('class="sub-panel', at);
  const m = CFG.slice(open, open + 80).match(/id="(sub-[a-z-]+)"/);
  return m ? m[1] : null;
}

section('1 · Payments & tax is a panel, between Customer service and Delivery');
{
  const navs = [...CFG.matchAll(/<button data-sub="([a-z-]+)"/g)].map((m) => m[1]);
  is(navs, ['shop', 'push', 'cs', 'payments', 'delivery', 'ops', 'history', 'sent', 'sku'],
    'the left list, in order');
  const row = CFG.match(/<button data-sub="payments"([^>]*)>/);
  yes(row && /data-cap="settings:payments"/.test(row[1]),
    'the row opens on settings:payments, the key the server asks of its writes');
  yes(/<div class="sub-panel" id="sub-payments">\s*<h2>Payments &amp; tax · 收款与税费<\/h2>/.test(CFG),
    'and the panel carries the same name');
  const walk = OPS.slice(OPS.indexOf("document.querySelectorAll('#settings-nav button[data-sub]')"), OPS.indexOf('return items;', OPS.indexOf("document.querySelectorAll('#settings-nav button[data-sub]')")));
  yes(/btn\.style\.display === 'none'\) return;/.test(walk),
    'the command palette skips a panel the operator\'s role cannot open, as the Settings search already did');
}

section('2 · the three money cards live there, and nowhere else');
{
  is(panelOf('id="cfg-currency"'), 'sub-payments', 'Currency');
  is(panelOf('id="cfg-tax-enabled"'), 'sub-payments', 'Tax');
  is(panelOf('id="alipay-manual-enabled"'), 'sub-payments', 'Manual Alipay');
  const pay = CFG.slice(CFG.indexOf('id="sub-payments"'), CFG.indexOf('id="sub-delivery"'));
  is((pay.match(/class="group-card"/g) || []).length, 3, 'and they are the whole panel');
  yes((pay.match(/data-cap="settings:payments"/g) || []).length === 3,
    'each card still carries its own settings:payments gate (§412.2)');
  const push = CFG.slice(CFG.indexOf('id="sub-push"'), CFG.indexOf('id="sub-cs"'));
  yes(!/cfg-currency|cfg-tax-|alipay-manual/.test(push), 'Push notifications holds no money card');
}

section('3 · the card reads fresh when its panel opens, and the setup guide points there');
{
  const sw = CORE.slice(CORE.indexOf('// ── Settings sub-nav switcher ──'), CORE.indexOf('// ── Live push (SSE)'));
  yes(/sub === 'payments'[^\n]*loadAlipayManual\(\)/.test(sw),
    'opening Payments & tax reads the Alipay card (§325 D1: never save a form that did not load)');
  const opsLoad = OPS.slice(OPS.indexOf('function loadOpsPanel()'), OPS.indexOf('function _cfgCards()'));
  yes(!/loadAlipayManual\(\)/.test(opsLoad), 'and Operations no longer reads it for a card it does not show');
  const pay = SETUP.slice(SETUP.indexOf('function suPayWechat()'), SETUP.indexOf('function suScrollTo('));
  yes(/data-sub="payments"/.test(pay) && !/data-sub="ops"/.test(pay),
    'the setup guide\'s "choose how customers pay" opens Payments & tax');
}

section('4 · money keeps its button; the rest of Push saves itself');
{
  const pay = CFG.slice(CFG.indexOf('id="sub-payments"'), CFG.indexOf('id="sub-delivery"'));
  yes(/onclick="_saveAlipayManual\(this\)"/.test(pay), 'the Alipay card has its own Save, pinned to the card');
  yes(/onclick="saveTaxSettings\(\)"/.test(pay), 'so does Tax');
  yes(!/Save settings/.test(pay) && !/保存设置/.test(pay), 'and neither points at a bar that is not there');
  yes(!/class="save-bar"/.test(CFG) && !/saveConfig/.test(CFG), 'the shared Save bar is gone from Settings');
  yes(!/async function saveConfig\(/.test(MKT), 'and so is the function it drove');
  for (const [card, foot] of [['notif-template-card', 'notifications.order_status'], ['notif-webhook-card', 'notifications.group_bot'], ['sysalert-card', 'system_alerts']]) {
    is(panelOf('id="' + card + '"'), 'sub-push', card + ' is a Push card');
    yes(new RegExp('data-as-foot="' + foot.replace('.', '\\.') + '"').test(CFG), '…with a foot for its saved / Undo / history line');
    yes(new RegExp("card: '" + foot.replace('.', '\\.') + "', root: '#" + card + "'").test(MKT), '…and an autosave card whose root is the card, so its inputs are heard');
  }
  yes(/NOTIF_TEMPLATE_CARD, NOTIF_WEBHOOK_CARD, SYSALERT_CARD\]/.test(MKT.slice(MKT.indexOf('function CFG_CARDS()'), MKT.indexOf('function CFG_CARDS()') + 300)),
    'all three start once loadConfig has filled their fields (§279: nothing is sent before start)');
  yes(/qyapi\.weixin\.qq\.com/.test(MKT.slice(MKT.indexOf('function _wecomHookHold'), MKT.indexOf('const NOTIF_TEMPLATE_CARD'))),
    'a webhook on any other host is held with a sentence, not sent for the server to refuse');
  yes(!/Save settings/.test(CFG.slice(CFG.indexOf('id="sub-push"'), CFG.indexOf('id="sub-cs"'))),
    'no Push card tells the reader to use a main Save button');
}

section('5 · Operations: no banner without a control, no server file on a tenant screen');
{
  const ops = CFG.slice(CFG.indexOf('id="sub-ops"'), CFG.indexOf('id="sub-history"'));
  yes(!/Ownership · 归属/.test(ops) && !/Self-managed/.test(ops), 'the Ownership card is gone');
  yes(!/\.env/.test(ops) && !/AMAP_MAPS_KEY|TENCENT_MAPS_KEY|pm2/.test(ops), 'the geocoding card names no file, variable or process');
  yes(/地图密钥在服务器上配置/.test(ops), 'it says the key is the server\'s, in both languages');
  const status = OPS.slice(OPS.indexOf('async function loadIntegrationsStatus()'), OPS.indexOf('// COMMAND SEARCH PALETTE'));
  yes(!/\.env|pm2|AMAP_MAPS_KEY/.test(status), 'and the status painter does not either');
  yes(/td-pill td-pill-sage/.test(status) && /td-pill td-pill-amber/.test(status),
    'the key is a Sage or Amber pill (§1.10), not an inline-styled green or red one');
  // Scoped to the two painters this decision touched: the shipping-integration
  // chips further down the module still shout, and PR 2's design pass is where
  // they stop (§494 rule 6).
  const chip = OPS.slice(OPS.indexOf('function _alipayManualChip('), OPS.indexOf('async function loadAlipayManual()'));
  yes(!/KEY CONFIGURED|KEY MISSING|LIVE · |OFF · /.test(status + chip), 'no shouting pills on the two cards this changed (§1.16)');
  yes(/\.td-pill-sage\s*\{[^}]*--td-sage-tint/.test(CSS), 'the Sage pill exists beside the Amber one');
  const backfill = OPS.slice(OPS.indexOf('async function _geocodeBackfill()'), OPS.indexOf('// ── GZ-express excluded districts ──'));
  yes(!/\.env/.test(backfill), 'the key-missing toast names no file');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
