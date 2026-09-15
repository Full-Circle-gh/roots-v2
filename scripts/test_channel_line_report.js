// A channel line's stock problem is classified, and said out loud
// (npm run test:channel-line-report).
//
// lib/channel-line-report.js decides which unresolved order lines are worth
// waking a merchant for. Getting that wrong in either direction is expensive:
// alert on the cutlery answer and it fires on nearly every Meituan order, which
// buries the real ones; miss a genuine combo and the thing this exists to
// surface stays invisible.
//
// The names below are REAL — every one of them is a line that failed to resolve
// on the live database, read on 2026-09-08
// (scripts/diagnose_channel_stock_damage.js, ro-query run 34233754687).
//
// Run: node scripts/test_channel_line_report.js

'use strict';

const { isOptionLine, classifyLines, alertText, belowZeroText } = require('../lib/channel-line-report');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

// ── A · the cutlery answer is never a product ────────────────────────────────
console.log('\nA · cutlery lines are options, not sales');
for (const n of ['无需餐具 No cutlery（0份）', '适量餐具 Cutlery based on product（1份）']) {
  check(`"${n}"`, isOptionLine(n) === true, 'classified as a real product');
}

// ── B · an orphaned heating option is noise ──────────────────────────────────
// This is what a real line looks like after Meituan has mangled the food name
// off the front of it: the option suffix, alone, with a stray bracket.
console.log('\nB · a name that is nothing but a heating option is noise');
for (const n of ['加热 Yes)', '加热Yes)', '加热', '(加热 Heat Up)']) {
  check(`"${n}"`, isOptionLine(n) === true, 'classified as a real product');
}

// ── C · THE ONE THAT MATTERS — a real product carrying a heating suffix ──────
// A `contains 加热` test would swallow all of these. They are genuine unsold
// goods, and classifying them as noise would hide exactly what this is for.
console.log('\nC · a real product with a heating suffix is NOT noise');
for (const n of [
  '藜麦沙拉+南瓜汤 Quinoa Salad+Pumpkin Soup（～630g） (加热Yes)',
  '皮塔饼（一个）Whole Wheat Pita（～80g） (加热 Heat Up)',
  'Whole-Wheat Pita皮塔面包(一个)(Yes)',
  '中东鹰嘴豆泥套餐 Hummus Combo',
  '杏仁酱 Almond butter-150g (2400)',
  '纯素咸芝士+玉米片Nachos  + Creamy Dip',
]) {
  check(`"${n.slice(0, 42)}"`, isOptionLine(n) === false, 'wrongly classified as noise');
}

// ── D · an empty or missing name decides nothing ─────────────────────────────
console.log('\nD · nothing is classified from an absent name');
for (const n of ['', '   ', null, undefined]) {
  check(JSON.stringify(n), isOptionLine(n) === false, 'classified from nothing');
}

// ── E · the split ────────────────────────────────────────────────────────────
console.log('\nE · classifyLines separates the three kinds');
{
  const { unresolved, optionNoise } = classifyLines([
    { productId: 42, name: 'Shawarma Wrap', qty: 1 },
    { productId: null, name: '无需餐具 No cutlery（0份）', qty: 1 },
    { productId: null, name: '中东鹰嘴豆泥套餐 Hummus Combo', qty: 1 },
  ]);
  check('the resolved line is in neither bucket', unresolved.length === 1 && optionNoise.length === 1,
    JSON.stringify({ unresolved, optionNoise }));
  check('the combo is the unresolved one', unresolved[0].name.includes('Hummus'), JSON.stringify(unresolved));
  check('the cutlery is the noise', optionNoise[0].name.includes('餐具'), JSON.stringify(optionNoise));
}

// ── F · the alert says what happened, in both languages ──────────────────────
console.log('\nF · the alert text');
{
  const none = alertText({ channel: 'eleme', storeCode: 'tianhe', orderNo: 'EL1', unresolved: [], oversold: [] });
  check('nothing to say means no alert', none === null, String(none));

  const t = alertText({
    channel: 'eleme', storeCode: 'tianhe', orderNo: 'EL20260908172919',
    unresolved: [{ nameEn: '纯素咸芝士+玉米片Nachos + Creamy Dip', qty: 1 }],
    oversold: [{ nameEn: 'Quinoa Salad', want: 1, have: 0 }],
  });
  check('carries the order number', t.includes('EL20260908172919'), t);
  check('names the channel in Chinese', t.includes('饿了么'), t);
  check('says the stock was not deducted, in Chinese', t.includes('库存未扣减'), t);
  check('says it in English too', t.includes('NOT deducted'), t);
  check('reports the oversell both ways', t.includes('库存不足') && t.includes('clamped at 0'), t);
  check('is two lines, 中文 then English', t.split('\n').length === 2, JSON.stringify(t));

  const mt = alertText({
    channel: 'meituan', storeCode: 'yuexiu', orderNo: 'MT1',
    unresolved: [{ nameEn: 'Something', qty: 2 }],
  });
  check('meituan names itself', mt.includes('美团外卖') && mt.includes('Meituan'), mt);
  check('an alert with no oversell omits that half', !mt.includes('库存不足'), mt);
}

// ── G · our own channels, which said nothing at all ───────────────────────
// The mini app, the web store and the counter till take a shelf below zero
// through lib/inventory.js's two commits, which do not clamp and must not —
// §84's negative is the only record that units are owed. Until 2026-09-15 they
// raised no alert of any kind, while Meituan and Eleme had raised one since
// 2026-09-08. These cases are about the DIFFERENCE between the two sentences:
// a platform line was refused the shelf, ours took it and left a debt.
console.log('\nG · a shelf our own commit took below zero');
{
  const none = belowZeroText({ channel: 'web', orderNo: 'ORD-1', lines: [] });
  check('a commit that stayed at or above zero says nothing', none === null, String(none));

  const till = belowZeroText({
    channel: 'shop', fulfilment: 'counter', orderNo: 'ORD-1042', storeName: '天河店',
    lines: [{ name: '青辣椒酱', nameEn: 'Zhoug', balance: -3 },
            { name: '甜菜根沙拉', nameEn: 'Beet Salad', balance: -1 }],
  });
  check('carries the order number', till.includes('ORD-1042'), till);
  check('a walk-in is named as the till, not as its channel',
    till.includes('前台收银') && till.includes('Counter till'), till);
  check('names the shop it happened in', till.includes('天河店'), till);
  check('the balance prints with its own sign, per line',
    till.includes('剩余 -3') && till.includes('Beet Salad -1'), till);
  check('says somebody is owed, in Chinese', till.includes('有客户订单等待'), till);
  check('…and in English', till.includes('are now owed'), till);
  // THE ONE THING THIS MUST NEVER SAY. The platform alert's wording is "已按 0
  // 计" / "clamped at 0" because the platform ingest refuses the shelf. Ours
  // wrote the negative deliberately; borrowing that sentence would report a
  // completed deduction as a refused one.
  check('never claims the line was clamped',
    !till.includes('已按 0 计') && !till.includes('clamped'), till);
  check('is two lines, 中文 then English', till.split('\n').length === 2, JSON.stringify(till));

  // Each half names the product in its OWN language — alertText cannot, because
  // its names arrive from a platform payload with no Chinese copy to prefer.
  const cnLine = till.split('\n')[0], enLine = till.split('\n')[1];
  check('the 中文 half uses the Chinese name', cnLine.includes('青辣椒酱'), cnLine);
  check('the English half uses the English name',
    enLine.includes('Zhoug') && !enLine.includes('青辣椒酱'), enLine);

  const web = belowZeroText({
    channel: 'web', fulfilment: 'delivery', orderNo: 'ORD-1043', storeName: '越秀区',
    lines: [{ name: '越式豆腐卷', nameEn: 'Tofu Roll', balance: -18 }],
  });
  check('a delivery is named by its channel', web.includes('网店') && web.includes('Web store'), web);
  const wechat = belowZeroText({
    orderNo: 'ORD-1044', lines: [{ nameEn: 'Anything', balance: -1 }],
  });
  check('an absent channel reads as the mini app, as the column default does',
    wechat.includes('微信'), wechat);
  const odd = belowZeroText({
    channel: 'not_a_channel', orderNo: 'ORD-1045', lines: [{ nameEn: 'Anything', balance: -1 }],
  });
  check('an unknown channel still alerts rather than throwing', !!odd, String(odd));
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
