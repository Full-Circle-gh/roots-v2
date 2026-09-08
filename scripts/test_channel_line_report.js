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

const { isOptionLine, classifyLines, alertText } = require('../lib/channel-line-report');

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

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
