#!/usr/bin/env node
/**
 * §412.7 — ONE CHINESE WORD PER THING.
 *
 *   node scripts/test_one_word_per_thing.js
 *
 * Ash settled five words that two surfaces said differently. This suite keeps
 * them settled: each retired word is gone from every screen that showed the
 * thing (the desktop, the phone, the page editors, the shop, the mini app and
 * the server's own labels), and the settled word is where the thing is named.
 *
 *   Holiday mode           假期模式     (the phone's 假日模式 retired)
 *   Delivery zones         配送区       (配送范围 / 配送区域 for zones retired;
 *                                        配送区域 stays for the CUSTOMER's
 *                                        delivery area in the shop and mini
 *                                        app's address pickers — another thing)
 *   Edit ship-to           修改收货地址 (修改收货信息 retired)
 *   Your store is open     店铺已开业   (你的店开张了 retired)
 *   Drafts (the chip)      草稿         (the desktop chip had no Chinese)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); } };

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const rel = d + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); }
    else if (/\.(html|js|wxml|json)$/.test(e.name)) files.push(rel);
  }
};
for (const d of ['public', 'miniapp', 'lib', 'routes']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const where = (re) => files.filter((f) => re.test(read(f)));

console.log('\n1 · the retired words are gone');
for (const [word, thing] of [['假日模式', 'holiday mode'], ['修改收货信息', 'Edit ship-to'], ['你的店开张了', 'Your store is open']]) {
  const hits = where(new RegExp(word));
  ok(!hits.length, `${thing}: no screen says ${word}`, hits.join(', '));
}
{
  // Zones: 配送范围 named the zones on the phone's Delivery summary card. It
  // stays where it means coverage (the mini app's "not in our delivery area",
  // the desktop's "Coverage & pricing"), so the check is on the zone phrases.
  const M = read('public/m.html');
  ok(!/'Delivery zones','配送范围'/.test(M) && !/个配送范围已停用/.test(M), 'zones: the phone\'s summary card no longer says 配送范围');
  const operator = ['public/m.html', 'public/retail-admin.html', 'lib/capabilities.js', 'lib/onboarding-steps.js', 'lib/recycle.js']
    .concat(files.filter((f) => f.startsWith('public/retail-admin/')));
  const hits = operator.filter((f) => /配送区域/.test(read(f)));
  ok(!hits.length, 'zones: no operator screen or server label calls them 配送区域', hits.join(', '));
}

console.log('\n2 · the settled words are where the thing is named');
{
  const M = read('public/m.html');
  ok(M.includes("T('Holiday mode','假期模式')"), 'phone: Holiday mode · 假期模式');
  ok(read('public/retail-admin.html').includes('Holiday mode · 假期模式'), 'desktop: Holiday mode · 假期模式');
  ok(M.includes("{label:T('Delivery zones','配送区')"), 'phone summary card: Delivery zones · 配送区');
  ok(read('public/retail-admin.html').includes('Delivery zones · 配送区<'), 'desktop: Delivery zones · 配送区');
  const caps = read('lib/capabilities.js');
  ok(caps.includes("labelCn: '查看配送区'") && caps.includes("labelCn: '编辑配送区'") && caps.includes("labelCn: '删除配送区'") && caps.includes("['Delivery zones', '配送区']"),
    'the permission labels: 配送区');
  const O = read('public/retail-admin/04-orders.js');
  ok((O.match(/cuT\('Edit ship-to', '修改收货地址'\)/g) || []).length === 5, 'desktop: every Edit ship-to button is 修改收货地址 (the drawer and the three quick panels)');
  ok((M.match(/T\('Edit ship-to','修改收货地址'\)/g) || []).length === 3, 'phone: Edit ship-to · 修改收货地址');
  ok(M.includes("T('Your store is open','店铺已开业'))};") && read('public/retail-admin/17-setup-guide.js').includes("cuT('Your store is open', '店铺已开业')"),
    'Your store is open · 店铺已开业, the phone\'s toast and the desktop guide');
  for (const f of ['public/retail-admin.html', 'public/retail-admin/10-extras.js']) {
    ok(/\n\s*'Drafts': '草稿',\n/.test(read(f)), `${f}: the Drafts chip says 草稿`);
  }
  ok(read('public/retail-admin.html').includes('id="ord-chip-drafts"') && /<span class="dot"><\/span>Drafts<span/.test(read('public/retail-admin.html')),
    'and the chip is the text node the table translates');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
