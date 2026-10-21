#!/usr/bin/env node
/**
 * test_mobile_settings_groups.js — the phone's Settings mirror the desktop's
 * nine groups, a "?" on every card, and the cards that save themselves
 * (decisions §494 rule 7, PR 3, 2026-10-21).
 *
 *   node scripts/test_mobile_settings_groups.js
 *
 * THE FINDING. The phone's Settings screen was one Store group holding eleven
 * doors, then Delivery, Notifications, Features, an "Automation" group with a
 * row that was a door to Operations wearing a value, and Preferences. The
 * desktop had just become nine groups named by the question a tenant asks;
 * the phone said the same things in a different order under different names.
 *
 * Read from the markup and driven in a sandbox where a rendered string is
 * enough: each claim is about the words and the order, not the pixels.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is  = (a, e, m) => (JSON.stringify(a) === JSON.stringify(e) ? ok(m) : bad(m, 'expected ' + JSON.stringify(e) + '\n      got      ' + JSON.stringify(a)));
const section = (t) => console.log('\n' + t);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const M = read('public/m.html');
const HTML = read('public/retail-admin.html');

function block(src, anchor) {
  const a = src.indexOf(anchor);
  if (a < 0) throw new Error('not found: ' + anchor);
  let d = 0;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced: ' + anchor);
}

section('1 · the nine groups, in the desktop\'s order and words');
{
  const fn = block(M, 'function screenSettings(){');
  const heads = [...fn.matchAll(/\{h:T\('([^']+)','([^']+)'\)/g)].map((m) => m[1] + ' · ' + m[2]);
  is(heads.slice(0, 9), ['Store · 门店', 'Online shop · 线上商城', 'Payments & tax · 收款与税费', 'Delivery & pickup · 配送与自提',
    'Notifications · 通知', 'Printing · 打印', 'Features · 功能开关', 'Advanced · 高级', 'History · 记录'], 'the nine, then the phone\'s own');
  is(heads.slice(9), ['Preferences · 偏好', 'App · 应用'], 'Preferences and App are this phone\'s and stay last');
  yes(!/Automation|自动化/.test(fn), 'no Automation group');
  // the same words as the desktop's left list
  const cfg = HTML.slice(HTML.indexOf('<section id="tab-config">'));
  for (const h of heads.slice(0, 9)) yes(cfg.includes(h.replace('&', '&amp;')), 'the desktop says ' + h + ' too');
  yes(/\]\.filter\(g=>g\.rows\.length\)/.test(fn), 'a group with no door for this role is left out, not shown empty');
}

section('2 · where each door went');
{
  const fn = block(M, 'function screenSettings(){');
  const groupOf = (needle) => {
    const at = fn.indexOf(needle);
    if (at < 0) return null;
    const m = [...fn.slice(0, at).matchAll(/\{h:T\('([^']+)'/g)];
    return m.length ? m[m.length - 1][1] : null;
  };
  for (const [needle, g] of [["'push','operations'", 'Store'], ["'push','team'", 'Store'], ["canRoute('brand')", 'Store'], ["mCanKnown('billing:view')", 'Store'],
    ["canRoute('shopdisplay')", 'Online shop'], ["canRoute('custservice')", 'Online shop'],
    ["'Payments & tax','收款与税费'),value:T('on desktop'", 'Payments & tax'],
    ["'push','delivery'", 'Delivery & pickup'], ['x7DeliveryRows()', 'Delivery & pickup'],
    ['NOTIFICATION_ROWS()', 'Notifications'], ["canRoute('pushcfg')", 'Notifications'],
    ["'push','printers'", 'Printing'], ["'Auto-print receipts','自动打印小票'", 'Printing'],
    ['FEATURE_ROWS()', 'Features'], ["'Routing','派单'", 'Advanced'], ["canRoute('skucodes')", 'Advanced'],
    ["canRoute('changes')", 'History'], ["canRoute('sent')", 'History']]) {
    is(groupOf(needle), g, needle + ' → ' + g);
  }
  yes(/SUBS\.printers=\{[^\n]*backLabel:\(\)=>T\('Settings','设置'\)/.test(M), 'Receipt printing comes back to Settings, where its door is');
}

section('3 · a "?" on every card that has more to say');
{
  yes(/function helpCut\(t\)/.test(M) && /const x7Help=t=>\{/.test(M), 'x7Help keeps the first sentence and folds the rest');
  yes(/reg\('helpOpen'/.test(M) && /reg\('closeHelp'/.test(M) && /function sheetHelp\(\)/.test(M), 'the "?" opens a sheet, and the sheet closes');
  yes(/if\(state\.help\) html \+= layer\('help', sheetHelp\(\)\);/.test(M), 'the sheet is painted with the other sheets');
  yes(/\.helpq\{/.test(M), 'the "?" has a look');
  // drive helpCut and x7Help in a sandbox
  const ctx = { T: (en) => en, escAttr: (x) => String(x == null ? '' : x).replace(/"/g, '&quot;'), String, RegExp, Object };
  vm.createContext(ctx);
  vm.runInContext(block(M, 'function helpCut(t)') + '\n' + M.slice(M.indexOf('const x7Help=t=>{'), M.indexOf('};', M.indexOf('const x7Help=t=>{')) + 2) + '\nthis.helpCut=helpCut;this.x7Help=x7Help;', ctx);
  const en = 'Get a card in your WeCom app the moment a new order is paid. Works even when this backend is closed.';
  is(en.slice(0, ctx.helpCut(en)), 'Get a card in your WeCom app the moment a new order is paid.', 'English cuts after the first full stop');
  const cn = '每当有新订单付款,立即在企业微信 App 收到一张卡片。即使后台没开也能收到。';
  is(cn.slice(0, ctx.helpCut(cn)), '每当有新订单付款,立即在企业微信 App 收到一张卡片。', 'Chinese cuts after the first 。');
  is(ctx.helpCut('Clear all three fields to turn off.'), 0, 'one sentence has nothing to fold');
  is(ctx.helpCut('Paste a waybill e.g. SF123. Live updates follow.'), 0, 'an abbreviation is not a sentence end (the text then shows whole)');
  const h = ctx.x7Help('Sends operational alerts to a dedicated WeCom group. Keep this separate from your order group.');
  yes(/Sends operational alerts to a dedicated WeCom group\. <button type="button" class="helpq"/.test(h), 'the lead, then the "?"');
  yes(/data-t="Sends operational alerts to a dedicated WeCom group\. Keep this separate from your order group\."/.test(h), 'the whole text rides on the button');
  yes(/onclick="APP\.cmd\('helpOpen',this\.dataset\.t\)"/.test(h), 'and opens the sheet on tap');
  yes(!/<button/.test(ctx.x7Help('Clear all three fields to turn off.')), 'a one-line hint gets no "?"');
}

section('4 · pills and words (§494 rule 6)');
{
  const pills = M.slice(M.indexOf('const X7_PILL='), M.indexOf('};', M.indexOf('const X7_PILL=')));
  yes(!/LIVE|NOT CONFIGURED|NOT SET|PENDING JD/.test(pills), 'no shouting pill');
  yes(/live:\['On','已启用','success'\]/.test(pills) && /off:\['Not set up','未配置','muted'\]/.test(pills) && /jdwait:\['Waiting for a JD account','待开通京东账号','warning'\]/.test(pills),
    'On is Sage, not set is quiet, waiting on JD is Amber');
  yes(/x7Head\(T\('System alerts','系统告警'\)/.test(M), 'System alerts is sentence case');
}

section('5 · the Notifications keys save themselves (§494 rule 3)');
{
  yes(/const X7_CFG_CARDS=\{/.test(M) && /card:'notifications\.order_status'/.test(M) && /card:'notifications\.group_bot'/.test(M) && /card:'system_alerts'/.test(M),
    'three cards, the desktop\'s three history names');
  yes(!/reg\('x7CfgSave'/.test(M) && !/x7Btn\('x7CfgSave'/.test(M), 'the one shared Save is gone');
  yes(/x7CfgAutoStart\(\);\n    render\(\);/.test(M), 'the engines start once the config is read, never before');
  yes(/reg\('x7In', \(k,v\)=>\{[^\n]*x7CfgTouch\(k\)/.test(M) && /reg\('x7Flip', k=>\{[^\n]*x7CfgTouch\(k\)/.test(M), 'a typed key or a flipped switch touches its card');
  yes(/if\(top==='pushcfg'&&typeof x7CfgFlush==='function'\) x7CfgFlush\(\);/.test(M), 'leaving the screen sends what is pending');
  yes(/visibilitychange',\(\)=>\{ if\(document\.hidden\) x7CfgFlush\(\); \}\)/.test(M), 'and so does the phone going into a pocket');
  yes(/x7CfgFoot\('template'\)/.test(M) && /x7CfgFoot\('webhook'\)/.test(M) && /x7CfgFoot\('alerts'\)/.test(M), 'each card has a foot: saved, saving, held, or why it failed, with Undo');
  yes(/function x7CfgFootRepaint\(k\)\{ const el=document\.getElementById/.test(M), 'the foot repaints in place — a full render would take the focus out of the box');
  yes(/function x7HookHold\(url\)/.test(M) && /qyapi\.weixin\.qq\.com/.test(block(M, 'function x7HookHold(url)')), 'a webhook off qyapi.weixin.qq.com is held, not sent');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
