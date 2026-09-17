#!/usr/bin/env node
/**
 * Carrier event text, read by a customer who does not read Chinese.
 *
 *   node scripts/test_tracking_translation.js
 *
 * THE FINDING, reported by Ash from a live order. TC000756 — a JD parcel
 * from Guangzhou to Tianjin — was opened on the English side of the app.
 * Twelve carrier events. SIX of them rendered as raw Chinese:
 *
 *   您的快件在【广州花都集货分拣中心】分拣完成
 *   您的快件在【广州黄埔集货分拣中心】分拣完成
 *   货物已交付京东物流
 *   您的快件已由【广州黄村站】揽收完成
 *   京东快递已收取快件
 *   您的快件将由快递员王培贤上门取件,联系电话:16620303543
 *
 * lib/tracking.js DOES translate — it has been translating since the kd100
 * integration landed — but its rules were written against the kuaidi100
 * vocabulary, and JD, which is our PRIMARY carrier, spells half its
 * timeline differently. An unmatched event fell back to the original
 * Chinese by design, so the failure was silent: nothing errored, nothing
 * logged, the timeline just stopped being readable halfway down.
 *
 * Worse, the same strings reach BOTH surfaces. routes/retail.js builds
 * description_en once and the admin drawer, the customer order page and
 * the native pages/track screen all read it. What the office saw under an
 * English UI was exactly what the customer saw — which is why the report
 * came in from a screenshot of the office screen.
 *
 * THREE SEPARATE DEFECTS ARE PINNED HERE, because they failed for three
 * different reasons and a fix for one would not have caught the others:
 *
 *   1. MISSING RULES. The six above, plus the phrasings found alongside
 *      them in the same sweep (装车, 待揽件, 商家已发货, 前台, arrival
 *      without the 已 prefix).
 *   2. PILL / LINE DISAGREEMENT. STATUS_TEXT_RULES matched bare 派送中
 *      and TRANSLATION_RULES only matched 正在派送, so the status pill
 *      could read "Out for delivery" in English directly above an
 *      untranslated Chinese line saying the same thing. That looks broken
 *      in a way that neither half is individually wrong about.
 *   3. THE LOCATION FIELD WAS NEVER TOUCHED AT ALL. kd100's areaName and
 *      JD's opeCityName went from the carrier to the screen untranslated,
 *      so even a perfectly translated sentence ended "· 广州市".
 *
 * WHAT IS DELIBERATELY STILL CHINESE, asserted below so a later reader
 * does not "fix" it: FACILITY names inside the sentence. "Arrived at
 * 广州黄埔集货分拣中心" is the intended output. Facility names are proper
 * nouns, they romanise badly, and the Chinese is the string a customer
 * needs if they ring the carrier. Administrative place names (广州市) are
 * a different thing — they romanise cleanly and standardly — which is why
 * the location field is translated and the facility name is not.
 *
 * Not a browser suite — no Chromium, no layout, no DOM. It belongs in the
 * fast shard, and CLAUDE.md's standing instruction is that the slow shard
 * is not run.
 */
'use strict';

const t = require('../lib/tracking');

let pass = 0;
const failures = [];

function eq(label, got, want) {
  if (got === want) { pass++; return; }
  failures.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

function tr(cn)  { return t.translateEventDescription(cn); }
function loc(cn) { return t.translateLocation(cn); }

// ── 1. TC000756, the reported order, event for event ────────────────
// Verbatim from the screenshot, newest first. Every one must come back
// in English. This is the regression that started the work.
const TC000756 = [
  ['开始长途运输,距离下一站【天津散货分拣中心】2094KM',
   'Long-haul transit started — 2094KM to 天津散货分拣中心'],
  ['您的快件已离开【广州花都集货分拣中心】,正在发往下一站【天津散货分拣中心】',
   'Left 广州花都集货分拣中心 — heading to 天津散货分拣中心'],
  ['您的快件在【广州花都集货分拣中心】分拣完成', 'Sorted at 广州花都集货分拣中心'],
  ['您的快件已离开【广州黄埔集货分拣中心】,正在发往下一站【广州花都集货分拣中心】',
   'Left 广州黄埔集货分拣中心 — heading to 广州花都集货分拣中心'],
  ['您的快件在【广州黄埔集货分拣中心】分拣完成', 'Sorted at 广州黄埔集货分拣中心'],
  ['您的快件已到达【广州黄埔集货分拣中心】', 'Arrived at 广州黄埔集货分拣中心'],
  ['您的快件已离开【广州市-保利天汇项目接驳点】,正在发往下一站【广州黄埔集货分拣中心】',
   'Left 广州市-保利天汇项目接驳点 — heading to 广州黄埔集货分拣中心'],
  ['您的快件已到达【广州市-保利天汇项目接驳点】', 'Arrived at 广州市-保利天汇项目接驳点'],
  ['货物已交付京东物流', 'Handed over to JD Logistics'],
  ['您的快件已由【广州黄村站】揽收完成', 'Picked up at 广州黄村站'],
  ['京东快递已收取快件', 'Picked up by JD Express'],
  ['您的快件将由快递员王培贤上门取件,联系电话:16620303543',
   'Courier 王培贤 will collect your parcel — 16620303543'],
];
for (const [cn, want] of TC000756) eq(`TC000756 · ${cn}`, tr(cn), want);

// Belt and braces on the headline claim: not one line of that order may
// come back byte-identical to its Chinese input.
for (const [cn] of TC000756) {
  if (tr(cn) === cn) failures.push(`TC000756 · untranslated passthrough: ${cn}`);
  else pass++;
}

// ── 2. The rules that already worked must keep working ──────────────
// A translator change is exactly the kind that fixes six lines and
// quietly breaks nine others, so the pre-existing vocabulary is pinned.
const REGRESSION = [
  ['您的快件已签收,签收人:张三', 'Delivered, signed by 张三'],
  ['您的快件已本人签收',          'Delivered, signed in person'],
  ['您的快件已到达【上海转运中心】', 'Arrived at 上海转运中心'],
  ['您的快件已揽收',              'Package picked up'],
  ['您的快件已发车',              'Package departed'],
  ['您的快件已下单',              'Waybill created'],
  ['取件码:1-2-3456',            'Pickup code: 1-2-3456'],
  ['放门口',                      'Left at your door'],
  ['门卫代收',                    'Left with the doorman / security'],
  ['无人接听',                    'Courier could not reach you — please call back'],
  ['派送失败',                    'Delivery attempt failed'],
  ['正在派送',                    'Out for delivery'],
];
for (const [cn, want] of REGRESSION) eq(`kept working · ${cn}`, tr(cn), want);

// ── 3. Defect 2 — the pill and the line must agree ──────────────────
// Every phrasing statusFromEventText calls out_for_delivery must also
// translate to an out-for-delivery sentence. If it does not, the English
// pill sits above a Chinese line saying the same thing.
for (const cn of ['派送中', '正在派送', '派件中', '开始派送', '正在派送中']) {
  eq(`pill/line agree · ${cn}`, t.statusFromEventText(cn), 'out_for_delivery');
  const en = tr(cn);
  if (/[一-鿿]/.test(en)) {
    failures.push(`pill/line disagree · ${cn} → pill says out_for_delivery, line still Chinese: ${en}`);
  } else pass++;
}

// ── 4. Defect 3 — location names ────────────────────────────────────
eq('loc 广州市',            loc('广州市'),            'Guangzhou');
eq('loc 天津市',            loc('天津市'),            'Tianjin');
eq('loc 广东省广州市',       loc('广东省广州市'),       'Guangdong, Guangzhou');
eq('loc 内蒙古自治区',       loc('内蒙古自治区'),       'Inner Mongolia');
eq('loc 乌鲁木齐市',        loc('乌鲁木齐市'),        'Urumqi');
eq('loc 香港',              loc('香港'),              'Hong Kong');
// 州 is the SECOND character of these cities, not an administrative
// suffix. The first cut of the tokenizer split 广州 into 广 + 州 and
// returned the Chinese untouched; these four are that bug's gravestone.
eq('loc 苏州市',            loc('苏州市'),            'Suzhou');
eq('loc 潮州市',            loc('潮州市'),            'Chaozhou');
eq('loc 杭州市',            loc('杭州市'),            'Hangzhou');
eq('loc 温州市',            loc('温州市'),            'Wenzhou');
// Unknown, empty and already-latin inputs must pass through untouched.
eq('loc unknown → CN',      loc('番禺区'),            '番禺区');
eq('loc empty',             loc(''),                  '');
eq('loc null',              loc(null),                '');
eq('loc already latin',     loc('Guangzhou'),         'Guangzhou');
// A multi-part place with one unknown part falls back WHOLE, rather than
// rendering a half-English "Guangdong, Guangzhou, 天河区".
eq('loc partial → all CN',  loc('广东省广州市天河区'),  '广东省广州市天河区');

// ── 5. The English fallback for anything still unmatched ────────────
// An event no rule covers must not be a bare wall of Chinese. It leads
// with the English status the text implies and keeps the carrier's own
// words after it, so nothing is lost.
// 安排派送 is in STATUS_TEXT_RULES' out_for_delivery vocabulary but in no
// TRANSLATION_RULES pattern — exactly the gap defect 2 is about, here used
// to prove the fallback covers what the rule table does not.
const unmatched = '已安排派送,请留意';
const fb = tr(unmatched);
if (!/^Out for delivery · /.test(fb)) {
  failures.push(`fallback · expected an English status prefix, got: ${fb}`);
} else pass++;
// When not even a status can be read, the Chinese passes through as before
// — that is the honest answer, not a defect.
eq('fallback · no status readable', tr('测试文本无关内容'), '测试文本无关内容');

// ── 6. Facility names stay Chinese, on purpose ──────────────────────
const facility = tr('您的快件已到达【广州黄埔集货分拣中心】');
if (!facility.includes('广州黄埔集货分拣中心')) {
  failures.push(`facility name should stay Chinese, got: ${facility}`);
} else pass++;
if (!facility.startsWith('Arrived at ')) {
  failures.push(`facility line should still translate its verb, got: ${facility}`);
} else pass++;

// ── 7. Never throws, always a string ────────────────────────────────
for (const bad of [null, undefined, '', 0, {}, []]) {
  const out = tr(bad);
  if (typeof out !== 'string') failures.push(`translate(${JSON.stringify(bad)}) → not a string: ${typeof out}`);
  else pass++;
  const outL = loc(bad);
  if (typeof outL !== 'string') failures.push(`translateLocation(${JSON.stringify(bad)}) → not a string: ${typeof outL}`);
  else pass++;
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} check(s) failed, ${pass} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`PASS — tracking translation: ${pass} checks`);
