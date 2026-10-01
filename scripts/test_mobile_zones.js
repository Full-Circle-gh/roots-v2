#!/usr/bin/env node
/**
 * §325 step O5 — DELIVERY ZONES ON THE PHONE.
 *
 *   node scripts/test_mobile_zones.js
 *
 * The desktop's zones table and drawer (public/retail-admin/06-delivery.js):
 * the list grouped by province, on/off per zone, edit, add one or many areas
 * from /china-regions (no map), duplicate, copy settings to other zones, and
 * delete — every body the desktop's.
 *
 * Writes are delivery:edit on the server and a DELETE is delivery:delete
 * (lib/cap-routes.js); the phone draws and runs each only for that key.
 *
 * The code is RUN, sliced out of public/m.html, so this needs no browser and
 * sits in the fast shard. Every write is asserted on method, path and body.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const DESK_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '06-delivery.js'), 'utf8');
const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}
const CODE = [
  sliceBetween('/* ── §325 O5 — DELIVERY ZONES ON THE PHONE', "reg('faqToggle',"),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
].join('\n');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const ZONES = () => [
  { id: 1, zone_type: 'gz_district', name_cn: '天河', name_en: 'Tianhe', match_district: '天河区', match_city: null, province_cn: '广州市', province_en: 'Guangzhou',
    base_fee: 8, free_threshold: 99, max_fee: 20, packing_fee_per_item: 0, packing_fee_cap: null, weight_first_kg_fee: null, weight_extra_kg_fee: null,
    is_active: 1, same_day_allowed: 1, same_day_surcharge: 5, min_lead_days: 0, max_lead_days: 14, slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120, day_only: 0 },
  { id: 2, zone_type: 'city', name_cn: '深圳', name_en: 'Shenzhen', match_district: null, match_city: '深圳市', province_cn: '广东省', province_en: 'Guangdong',
    base_fee: 12, free_threshold: null, max_fee: null, packing_fee_per_item: 1.5, packing_fee_cap: 20, weight_first_kg_fee: 10, weight_extra_kg_fee: 3,
    is_active: 1, same_day_allowed: 0, same_day_surcharge: 0, min_lead_days: 1, max_lead_days: 14, slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120, day_only: 1 },
  { id: 3, zone_type: 'city', name_cn: '江苏省', name_en: 'Jiangsu', match_district: null, match_city: '江苏省', province_cn: '江苏省', province_en: 'Jiangsu',
    is_province_wide: 1, base_fee: 18, free_threshold: 329, is_active: 0, day_only: 1 },
  { id: 4, zone_type: 'city', name_cn: '上海', name_en: 'Shanghai', match_district: null, match_city: '上海市', province_cn: '上海市', province_en: 'Shanghai',
    base_fee: 20, free_threshold: null, is_active: 1, day_only: 1 },
];
const REGIONS = { guangzhou_districts: [{ name_cn: '天河区', name_en: 'Tianhe' }, { name_cn: '越秀区', name_en: 'Yuexiu' }, { name_cn: '海珠区', name_en: 'Haizhu' }],
  cities: [{ name_cn: '深圳市', name_en: 'Shenzhen', province_cn: '广东省' }, { name_cn: '杭州市', name_en: 'Hangzhou', province_cn: '浙江省' }] };

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  let n = 0;
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (k) => `<i data-ic="${k}"></i>`, money: (c, v) => c + Number(v).toFixed(2),
    toggle: (on, cmd) => `<button class="toggle ${on ? 'on' : ''}" onclick="${cmd}"></button>`,
    searchBox: (inner) => inner, searchClearShow: () => {}, searchClearRun: () => {},
    mCan: (k) => (opts.caps ? opts.caps.includes(k) : true),
    state: { zones: opts.zones === undefined ? ZONES() : opts.zones, ask: null, askErr: null, focus: null,
      zn: { q: '', loading: false, readErr: null, regions: null, regionsBusy: false, busy: null, err: null, edit: null } },
    render: () => {}, reg: (k, f) => { CMD[k] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    api: (p) => {
      calls.reads.push(p);
      if (opts.readFails) return Promise.reject(new Error('HTTP 500'));
      if (p === '/china-regions') return Promise.resolve(REGIONS);
      return Promise.resolve(ZONES());
    },
    apiWrite: (p, body, method) => {
      n++;
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      if (opts.failWrite && opts.failWrite(n)) return Promise.reject(Object.assign(new Error('match_city_required'), { code: 'match_city_required' }));
      return Promise.resolve({ success: true });
    },
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, isNaN,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const type = (k, v) => CMD.znF(k, v);
  return { ctx, CMD, calls, type };
}

async function main() {
  console.log('\n1 · who may');
  {
    const A = '/api/retail-admin';
    is(requiredCapFor('POST', A + '/delivery-zones'), 'delivery:edit', 'adding a zone is delivery:edit on the server');
    is(requiredCapFor('PATCH', A + '/delivery-zones/3'), 'delivery:edit', 'editing or switching one is delivery:edit');
    is(requiredCapFor('DELETE', A + '/delivery-zones/3'), 'delivery:delete', 'deleting one is delivery:delete');
    has(src, "zones:'delivery:view',", 'the list opens on delivery:view, like the Delivery screen');
    const v = mk({ caps: ['delivery:view'] });
    const list = v.ctx.znListHtml();
    hasnt(list, 'znToggle', 'a viewer sees no switch');
    has(list, "APP.cmd('znOpen',1)", '…but can open a zone to read it');
    v.CMD.znOpen(1);
    const sh = v.ctx.sheetZone();
    hasnt(sh, "APP.cmd('znSave')", 'and the sheet has no Save'); hasnt(sh, "APP.cmd('znDel')", 'no Delete');
    hasnt(sh, "APP.cmd('znDup'", 'no Duplicate'); hasnt(sh, 'znApplyOpen', 'no Copy to others');
    has(sh, 'id="mZn_base" disabled', 'its fields are read-only');
    v.CMD.znClose();
    for (const c of ['znAdd', 'znApplyOpen']) v.CMD[c]();
    v.CMD.znDup(1); v.CMD.znToggle(1); v.CMD.znOpen(1); v.CMD.znSave(); v.CMD.znDel();
    is([v.calls.writes.length, v.ctx.state.ask], [0, null], 'every write refuses without delivery:edit (capability-denied)');
    const e = mk({ caps: ['delivery:view', 'delivery:edit'] });
    e.CMD.znOpen(1);
    hasnt(e.ctx.sheetZone(), "APP.cmd('znDel')", 'delivery:edit without delivery:delete: no Delete, as the desktop\'s data-cap');
    e.CMD.znDel();
    is(e.ctx.state.ask, null, '…and the command refuses');
  }

  console.log('\n2 · the list');
  {
    const { ctx, CMD } = mk();
    const h = ctx.znListHtml();
    const order = ['Guangzhou', 'Guangdong', 'Jiangsu', 'Shanghai'].map((g) => h.indexOf('>' + g + ' <'));
    ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'grouped by province: Guangzhou, Guangdong, then A→Z');
    has(h, '¥8.00 · Free over ¥99.00 · Same-day +¥5.00 · Time-slot', 'a Guangzhou district: base, free-over, same-day, slots');
    has(h, '¥10.00 +¥3.00/kg · Free over default · Day-only', 'a city by weight, free-over by default, day-only');
    has(h, 'Province', 'a province-wide row is marked');
    has(h, `<button class="toggle " onclick="APP.cmd('znToggle',3)">`, 'a switched-off zone shows off');
    CMD.znQ('shen');
    const f = ctx.znListHtml();
    has(f, '深圳', 'search matches the English name'); hasnt(f, '天河', '…and filters the rest');
    CMD.znQ('zzz');
    has(ctx.znListHtml(), 'No matches.', 'no match says so');
    const empty = mk({ zones: [] });
    has(empty.ctx.znListHtml(), 'No zones yet — click + Add zone above.', 'none at all says so');
    const ld = mk({ zones: null });
    has(ld.ctx.znListHtml(), 'Loading…', 'not read yet: loading');
    const er = mk({ zones: null, readFails: true });
    er.ctx.screenZones(); await tick();
    has(er.ctx.znListHtml(), 'Could not load this.', 'a failed read says so');
    has(er.ctx.znListHtml(), "APP.cmd('znReload')", 'and can be retried');
  }

  console.log('\n3 · on / off');
  {
    const m = mk();
    m.CMD.znToggle(3); await tick();
    is(m.calls.writes, [{ p: '/delivery-zones/3', method: 'PATCH', body: { is_active: 1 } }], 'PATCH /delivery-zones/:id {is_active}, as updateZone sends it');
    is(m.ctx.state.zones.find((z) => z.id === 3).is_active, 1, 'and the row follows');
    const f = mk({ failWrite: () => true });
    f.CMD.znToggle(1); await tick();
    has(String(f.ctx.state.zn.err), 'That did not save', 'a refused switch says so on the screen');
    is(f.ctx.state.zones.find((z) => z.id === 1).is_active, 1, 'and stays where it was');
  }

  console.log('\n4 · edit');
  {
    const m = mk();
    m.CMD.znOpen(1);
    const h = m.ctx.sheetZone();
    has(h, 'Edit zone', 'titled'); has(h, 'value="天河"', 'its fields are filled'); has(h, 'Allow same-day', 'a district offers same-day');
    m.type('base', '9.5'); m.type('name_en', ' Tianhe District '); m.type('free', '');
    m.CMD.znSave(); await tick();
    is(m.calls.writes[0], { p: '/delivery-zones/1', method: 'PATCH', body: {
      zone_type: 'gz_district', base_fee: 9.5, free_threshold: null, max_fee: 20, weight_first_kg_fee: null, weight_extra_kg_fee: null,
      packing_fee_per_item: 0, packing_fee_cap: null, min_lead_days: 0, max_lead_days: 14, slot_start_hour: 10, slot_end_hour: 20,
      slot_duration_minutes: 120, same_day_allowed: 1, same_day_surcharge: 5, day_only: 0, is_active: 1,
      match_district: '天河区', match_city: null, name_cn: '天河', name_en: 'Tianhe District' } }, 'PATCH with the desktop\'s whole body');
    is(m.calls.toasts, ['Zone saved'], 'confirmed'); is(m.ctx.state.zn.edit, null, 'and closed');
    const b = mk(); b.CMD.znOpen(2); b.type('pack', '1,5'); b.CMD.znSave();
    is(b.ctx.state.zn.edit.err, 'Enter a price — a number, 0 or more.', 'a typo is refused on the sheet, never saved as 0');
    b.type('pack', '1.5'); b.type('lead', '1.5'); b.CMD.znSave();
    is(b.ctx.state.zn.edit.err, 'Enter a whole number, 0 or more', 'days are whole');
    is(b.calls.writes.length, 0, 'and nothing was sent');
    const c = mk(); c.CMD.znOpen(1); c.CMD.znFlag('sd'); c.CMD.znSave(); await tick();
    is([c.calls.writes[0].body.same_day_allowed, c.calls.writes[0].body.same_day_surcharge], [0, 0], 'switching same-day off clears its fee');
    const d = mk(); d.CMD.znOpen(1); d.CMD.znFlag('sd'); d.type('sdfee', '6');
    is(d.ctx.state.zn.edit.f.sd, true, 'typing a same-day fee turns same-day back on (onSdFeeInput)');
  }

  console.log('\n5 · add, from the region catalogue');
  {
    const m = mk();
    m.CMD.znAdd(); await tick();
    is(m.calls.reads, ['/china-regions'], 'the catalogue is read on the way in');
    let h = m.ctx.sheetZone();
    has(h, 'Add zone', 'titled'); has(h, '越秀区 · Yuexiu', 'districts are offered');
    has(h, 'disabled style="opacity:.4" onclick="APP.cmd(\'znPickD\',0)"', 'a district that already has a zone cannot be picked again');
    m.CMD.znSave();
    is(m.ctx.state.zn.edit.err, 'Pick at least one district', 'nothing picked is refused');
    m.CMD.znPickD(1); m.CMD.znPickD(2); m.type('base', '10');
    h = m.ctx.sheetZone();
    has(h, '2 selected', 'counts what is picked');
    m.CMD.znSave(); await tick();
    is(m.calls.writes.map((w) => [w.p, w.method, w.body.match_district, w.body.name_cn, w.body.name_en, w.body.base_fee, w.body.min_lead_days, w.body.zone_type]),
      [['/delivery-zones', 'POST', '越秀区', '越秀', 'Yuexiu', 10, 0, 'gz_district'], ['/delivery-zones', 'POST', '海珠区', '海珠', 'Haizhu', 10, 0, 'gz_district']],
      'one POST per district, each named from the catalogue as the desktop names them');
    is(m.calls.toasts, ['2 zones added'], 'confirmed');
    const c = mk();
    c.CMD.znAdd(); await tick(); c.CMD.znType('city');
    c.CMD.znCityQ('hang');
    has(c.ctx.znCityPicksHtml(), '杭州市 · Hangzhou', 'a city is found by its English name');
    c.CMD.znPickC(0);
    c.CMD.znCityQ('深圳市'); c.CMD.znPickC(-1);
    has(String(c.ctx.state.zn.edit.err), '深圳市 already has a zone', 'a city with a zone is refused');
    c.CMD.znCityQ('Xiongan'); c.CMD.znPickC(-1);
    is(c.ctx.state.zn.edit.picksC, [{ name_cn: '杭州市', name_en: 'Hangzhou' }, { name_cn: 'Xiongan', name_en: '' }], 'a hand-typed city is kept, as the desktop keeps it');
    c.CMD.znSave(); await tick();
    is(c.calls.writes[0].body.match_city, '杭州市', 'POSTed by city');
    is([c.calls.writes[0].body.name_cn, c.calls.writes[0].body.min_lead_days, c.calls.writes[0].body.same_day_allowed], ['杭州', 3, 0], 'named, lead 3, no same-day for a city');
    const p = mk({ failWrite: (k) => k === 2 });
    p.CMD.znAdd(); await tick(); p.CMD.znPickD(1); p.CMD.znPickD(2); p.CMD.znSave(); await tick();
    has(String(p.ctx.state.zn.edit.err), 'Added 1, 1 failed', 'a partial add says how many landed');
    is(p.ctx.state.zn.edit.picksD, [], '…and the picks clear, so a retry does not add the first one twice');
  }

  console.log('\n6 · duplicate');
  {
    const m = mk();
    m.CMD.znDup(2); await tick();
    const e = m.ctx.state.zn.edit;
    is([e.mode, e.type, e.f.base, e.f.pack, e.f.cap, e.f.name_cn, e.f.w1], ['dup', 'city', '12', '1.5', '20', '', ''], 'pricing and scheduling come across; the area and names do not');
    has(m.ctx.sheetZone(), 'Duplicate of 深圳', 'titled as a copy');
    m.CMD.znCityQ('hang'); m.CMD.znPickC(0); m.CMD.znSave(); await tick();
    is([m.calls.writes[0].method, m.calls.writes[0].body.match_city, m.calls.writes[0].body.base_fee, m.calls.writes[0].body.packing_fee_cap], ['POST', '杭州市', 12, 20], 'saved as a new zone with the copied settings');
  }

  console.log('\n7 · copy settings to other zones');
  {
    const m = mk();
    m.CMD.znOpen(1); m.CMD.znApplyOpen();
    let h = m.ctx.sheetZone();
    has(h, 'Which fields', 'fields'); has(h, 'Use sparingly', 'the active switch warns');
    hasnt(h, "APP.cmd('znApplyT',1)", 'the zone being edited is not a target');
    m.CMD.znApplyGo();
    is(m.ctx.state.zn.edit.err, 'Pick at least one zone', 'no target is refused');
    m.CMD.znApplyPreset('city');
    is(m.ctx.state.zn.edit.apply.targets, [2, 3, 4], 'All cities');
    m.CMD.znApplyT(3); m.CMD.znApplyT(4);
    m.type('base', '7');
    m.CMD.znApplyGo();
    has(m.ctx.state.ask.body, '• 深圳', 'it asks, naming the zones');
    is(m.calls.writes, [], 'nothing before the confirm');
    m.ctx.state.ask.run(); await tick();
    is(m.calls.writes, [{ p: '/delivery-zones/2', method: 'PATCH', body: { base_fee: 7, free_threshold: 99, packing_fee_per_item: 0, packing_fee_cap: null,
      min_lead_days: 0, max_lead_days: 14, slot_start_hour: 10, slot_end_hour: 20, slot_duration_minutes: 120, day_only: 0 } }],
    'a city target gets pricing (no MAX) and scheduling (no same-day), the form\'s own figures');
    is(m.calls.toasts, ['Applied to 1 zone(s)'], 'confirmed');
    const g = mk(); g.CMD.znOpen(2); g.CMD.znApplyOpen(); g.CMD.znApplyBundle('scheduling'); g.CMD.znApplyBundle('active'); g.CMD.znApplyT(1);
    g.CMD.znApplyGo(); g.ctx.state.ask.run(); await tick();
    is(g.calls.writes[0].body, { base_fee: 12, free_threshold: null, max_fee: null, packing_fee_per_item: 1.5, packing_fee_cap: 20, is_active: 1 },
      'a Guangzhou target gets MAX; only the chosen bundles go');
    const f = mk({ failWrite: () => true }); f.CMD.znOpen(1); f.CMD.znApplyOpen(); f.CMD.znApplyPreset('all'); f.CMD.znApplyGo(); f.ctx.state.ask.run(); await tick();
    is(String(f.ctx.state.zn.edit.err), '0 ok, 3 failed', 'failures are counted on the sheet');
  }

  console.log('\n8 · delete');
  {
    const m = mk();
    m.CMD.znOpen(2); m.CMD.znDel();
    is([m.ctx.state.ask.title, m.ctx.state.ask.danger], ['Delete delivery zone "深圳"?', true], 'asks, in the desktop\'s words');
    is(m.calls.writes, [], 'nothing before the confirm');
    m.ctx.state.ask.run(); await tick();
    is(m.calls.writes, [{ p: '/delivery-zones/2', method: 'DELETE', body: {} }], 'DELETE /delivery-zones/:id');
    is(m.calls.toasts, ['Zone deleted'], 'confirmed');
  }

  console.log('\n9 · words');
  {
    const z = mk({ lang: 'zh' });
    const l = z.ctx.znListHtml();
    for (const w of ['广州', '满额免运', '同日', '按时段', '仅按日', '全省']) has(l, w, 'Chinese list: ' + w);
    z.CMD.znOpen(1);
    const s = z.ctx.sheetZone();
    for (const w of ['编辑配送区', '基础运费', '任意距离封顶', '每件包装费', '包装费上限', '按重量计费(可选)', '提前天数', '最远天数', '开放时间', '时段长度', '允许同日送达', '仅按日', '启用', '复制配送区', '复制设置到其他配送区']) has(s, w, 'Chinese sheet: ' + w);
    for (const d of ['Add zone · 添加配送区', 'Guangzhou district · 广州区/县', 'Other city · 其他城市', 'Base fee ¥ · 基础运费',
      'MAX flat ¥ · 任意距离封顶', 'Packing ¥/item · 每件包装费', 'Packing cap ¥ · 包装费上限', 'By weight (optional) · 按重量计费(可选)', 'Earliest lead (days) · 提前天数',
      'Furthest day · 最远天数', 'Kitchen hours · 开放时间', 'Slot length (min) · 时段长度', 'Allow same-day · 允许同日送达', 'Day-only (no time slots) · 仅按日',
      'Active · 启用', 'Copy settings to other zones · 复制设置到其他配送区', 'Which fields · 复制哪些字段', 'Which zones · 复制到哪些配送区',
      'All GZ · 所有广州区', 'All cities · 所有外地', 'Active toggle · 启用状态']) has(DESK_HTML, d, 'desktop: ' + d);
    for (const d of ["'Edit zone · 编辑配送区'", "'Zone saved · 配送区已保存'", 'Zone deleted · 配送区已删除', 'Pick at least one district · 请至少选一个区', 'Add at least one city · 请至少添加一个城市',
      'Duplicate · 复制配送区', 'No zones yet — click + Add zone above. · 暂无配送区,请点上方「+ 添加配送区」', 'Day-only · 仅按日', 'Time-slot · 按时段',
      "dzLangSpan('City-wide', '全市')", "dzLangSpan('Province', '全省')", 'Apply settings · 应用']) has(DESK, d, 'desktop: ' + d);
  }

  console.log('\n· the read-failure flag is not a load-shaped name');
  {
    // test_mobile_screens.js (slow shard) treats every load+Capital word as a
    // helper that must be defined; the zones read's flag was `loadErr` and so
    // read as a call to a missing loadErr(). It is `readErr`, as X4's is.
    const sm = (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    is((sm.match(/\bloadErr\b/g) || []).length, 0, 'no `loadErr` anywhere in the app');
    has(src, 'zn:{q:\'\', loading:false, readErr:null,', 'the zones slot carries readErr');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
