#!/usr/bin/env node
/**
 * Offline self-test for the Reports "Payment and delivery" card.
 *
 *   node scripts/test_reports_splits_i18n.js
 *
 * Reported from August: the card's channel group showed four rows where Finance
 * showed seven. The Mini app (¥98,147), Meituan and Manual rows were missing —
 * every second row — because the i18n walker's block-pair rule (`tagBlockPair`,
 * 10-extras.js) read an all-Chinese row next to an English-only one
 * (`gzgrocery`, `wechat_chat`, `pickup`) as one sentence in two languages and
 * hid a side. Finance hit the same rule first; see test_finance_summary.js.
 *
 * No network, no browser: the shipped render functions are sliced out of
 * 03-dashboard.js and run against stubs.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DASH = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const EXTRAS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '10-extras.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}

function slice(name) {
  const start = DASH.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' is no longer in 03-dashboard.js');
  const end = DASH.indexOf('\n}\n', start);
  return DASH.slice(start, end + 3);
}

const AUGUST = {
  payments: [
    { method: 'wechat', revenue: 89241 }, { method: 'alipay', revenue: 5140 },
    { method: 'meituan', revenue: 5056 }, { method: 'eleme', revenue: 141 },
  ],
  delivery: [{ mode: 'standard', orders: 320 }, { mode: 'unknown', orders: 46 }],
  revenue_by_channel: { rows: [
    { channel: 'wechat', revenue: 98147 }, { channel: 'gzgrocery', revenue: 17842 },
    { channel: 'meituan', revenue: 5056 }, { channel: 'wechat_chat', revenue: 3824 },
    { channel: 'manual', revenue: 777 }, { channel: 'pickup', revenue: 220 },
    { channel: 'eleme', revenue: 141 },
  ] },
};

function render(lang) {
  const host = { innerHTML: '' };
  const ctx = {
    DASH_DATA: AUGUST,
    cuT: (en, cn) => (lang === 'cn' ? cn : en),
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    escapeAttr: s => String(s).replace(/"/g, '&quot;'),
    dashMoney: n => '¥' + Number(n).toLocaleString('en-US'),
    dashNum: n => String(n),
    $: () => host,
  };
  vm.createContext(ctx);
  new vm.Script(slice('dashBarList') + slice('dashRenderSplits') + '\ndashRenderSplits();').runInContext(ctx);
  return host.innerHTML;
}

const rowLabels = html => [...html.matchAll(/<div class="k"[^>]*>([^<]*)/g)].map(m => m[1]);

it('the card host is closed to the i18n walker', () => {
  assert.ok(/dataset\.noI18n != null\) return true/.test(EXTRAS),
    'inSkippedContext no longer honours data-no-i18n — the guard below is inert');
  assert.ok(/<div id="db-splits"[^>]*\sdata-no-i18n/.test(HTML),
    '#db-splits is open to the walker again, and Chinese hides every second channel');
});

it('every label is picked by language, none left for the walker to split', () => {
  for (const lang of ['en', 'cn']) {
    const labels = rowLabels(render(lang));
    assert.ok(labels.length, 'no rows rendered');
    labels.forEach(l => assert.ok(!l.includes(' · '), `"${l}" is still an "EN · CN" string (${lang})`));
  }
});

it('all seven August channels render, with no raw keys', () => {
  const en = rowLabels(render('en'));
  ['Mini app', 'gzgrocery ERP', 'Meituan', 'WeChat message', 'Manual', 'Pick up']
    .forEach(n => assert.ok(en.includes(n), n + ' is missing'));
  ['wechat_chat', 'pickup'].forEach(k => assert.ok(!en.includes(k), 'raw key on screen: ' + k));
  const cn = rowLabels(render('cn'));
  ['小程序', '美团', '微信消息', '手动', '到店自取'].forEach(n => assert.ok(cn.includes(n), n + ' is missing'));
});

it('each group has its heading, so Eleme twice is explained', () => {
  const en = render('en'), cn = render('cn');
  ['Pay method', 'Delivery', 'Channel'].forEach(h => assert.ok(en.includes(`<div class="db-bars-h">${h}</div>`), h));
  ['付款方式', '配送', '渠道'].forEach(h => assert.ok(cn.includes(`<div class="db-bars-h">${h}</div>`), h));
});

it('the card is redrawn when the language is switched', () => {
  assert.ok(/onLangChange\(\(\) => \{[^}]*if \(DASH_DATA\) \{[^}]*dashRenderSplits\(\)/.test(DASH),
    'the Reports language hook no longer redraws the card — labels would stay in the old language');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
