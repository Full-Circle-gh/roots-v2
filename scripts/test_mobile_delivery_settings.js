#!/usr/bin/env node
/**
 * §325 step O4 — DELIVERY SETTINGS ARE WRITTEN FROM THE PHONE.
 *
 *   node scripts/test_mobile_delivery_settings.js
 *
 * The desktop's Delivery panel (06-delivery.js; the Store pickup card in
 * 05-marketing.js), on the phone's Delivery screen:
 *   · the self-saving cards (§279) as live sheets, each write filed under the
 *     desktop's own card with ?history=, with Undo and Version history:
 *     Same-day cutoff, Store pickup, Pre-orders, Kitchen address;
 *   · the two switches (Bulk attach tracking, Box label), each its card;
 *   · the two Save-button cards as plain PUT /config with the desktop's whole
 *     bodies: Fees & minimum, Everywhere else — default delivery;
 *   · Holiday mode ON with its two-language message and a strong confirm
 *     saying what stops and what does not (§326.2).
 *
 * The code is RUN, sliced out of public/m.html with the real autosave engine
 * (public/tacet-autosave.js), so this needs no browser and sits in the fast
 * shard. Every write is asserted on its request: method, path and body.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const AUTOSAVE = fs.readFileSync(path.join(ROOT, 'public', 'tacet-autosave.js'), 'utf8');
const DESK_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');
const DESK_DLV = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '06-delivery.js'), 'utf8');
const DESK_MKT = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '05-marketing.js'), 'utf8');
const { configKeyCap } = require(path.join(ROOT, 'lib', 'cap-routes.js'));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function has(hay, needle, m) { if (String(hay).indexOf(needle) !== -1) ok(m); else bad(m, 'missing: ' + needle); }
function hasnt(hay, needle, m) { if (String(hay).indexOf(needle) === -1) ok(m); else bad(m, 'unexpectedly present: ' + needle); }
function is(a, b, m) { if (JSON.stringify(a) === JSON.stringify(b)) ok(m); else bad(m, 'expected ' + JSON.stringify(b) + '\n      got      ' + JSON.stringify(a)); }

function sliceFn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}

const CODE = [
  sliceBetween('/* ── §325 O4 — DELIVERY SETTINGS, WRITTEN FROM THE PHONE', "reg('faqToggle',"),
  sliceFn('dlvSettingsCard'),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  sliceBetween("reg('askLive', (id,v)=>{", "reg('askRun', key=>{"),
  sliceFn('liveHistorySheet'),
  'const cfgGet=(path,dflt)=>{ let v=state.cfg; for(const k of String(path).split(\'.\')){ if(v==null) return dflt; v=v[k]; } return v==null?dflt:v; };',
].join('\n');

const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const CFG = () => ({
  delivery: { holidayMode: false, holidayMessage: { en: '', cn: '' }, sameDayCutoffMinutes: 20, sameDayCutoffMessage: { en: '', cn: '' },
    kitchenAddress: '天河路 1 号', bulkTracking: false, boxLabel: true,
    defaultZone: { enabled: true, base_fee: 30, free_threshold: null, packing_fee_per_item: 1, packing_fee_cap: null, min_lead_days: 2, day_only: 1 } },
  fees: { freeShippingThreshold: 199, minOrder: 50, pickupPackingFee: 2 },
  pickup: { window: { open: '09:00', close: '21:00' }, leadMinutes: 30 },
  notice: { preorder: { min_days: 2, max_days: 4, kicker_en: '', kicker_cn: '', title_en: '', title_cn: '', message_en: '', message_cn: '' } },
});

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [] };
  const CMD = {};
  const fields = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`, money: (c, n) => c + Number(n).toFixed(2),
    toggle: (on, cmd) => `<button class="toggle ${on ? 'on' : ''}" onclick="${cmd}"></button>`,
    tdWhen: (v) => String(v), _tdL: () => 'x',
    mCan: (k) => { const ks = Array.isArray(k) ? k : [k]; return opts.caps ? ks.some((x) => opts.caps.includes(x)) : true; },
    state: { cfg: opts.cfg || CFG(), ask: null, askErr: null, dlvBusy: false, dlvErr: null, dlvSetErr: null, dlvOpening: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    askLiveRepaint: () => {}, dlvZoneFacts: () => null, canRoute: () => true,
    api: (p) => {
      calls.reads.push(p);
      if (opts.readFails) return Promise.reject(new Error('HTTP 500'));
      if (p.indexOf('/config/history') === 0) return Promise.resolve({ versions: opts.versions || [] });
      return Promise.resolve(JSON.parse(JSON.stringify(opts.server || CFG())));
    },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      if (opts.writeFails) return Promise.reject(Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] }));
      return Promise.resolve({ success: true });
    },
    document: { getElementById: (id) => (id.indexOf('ask-') === 0 ? { value: fields[id.slice(4)] || '' } : null) },
    setTimeout, clearTimeout,
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseInt, encodeURIComponent,
  };
  ctx.window = ctx;
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(AUTOSAVE, ctx);
  vm.runInContext(CODE, ctx);
  const run = (vals) => { Object.keys(fields).forEach((k) => delete fields[k]); Object.assign(fields, vals || {}); CMD.askRun(''); };
  return { ctx, CMD, calls, run };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

async function main() {
  console.log('\n1 · who may: the server\'s family, and the screen\'s key');
  {
    const keys = ['delivery.holidayMode', 'delivery.holidayMessage', 'delivery.sameDayCutoffMinutes', 'delivery.sameDayCutoffMessage',
      'delivery.kitchenAddress', 'delivery.bulkTracking', 'delivery.boxLabel', 'delivery.defaultZone', 'fees.freeShippingThreshold',
      'fees.minOrder', 'fees.pickupPackingFee', 'pickup.window', 'pickup.leadMinutes', 'notice.preorder'];
    for (const k of keys) {
      const need = configKeyCap(k);
      ok(need.includes('delivery:view') && need.includes('delivery:edit'), k + ' is the Delivery panel\'s family (delivery:view | delivery:edit …)');
    }
    has(src, "delivery:'delivery:view'", 'the phone\'s Delivery screen opens on delivery:view');
    const no = mk({ caps: ['orders:view'] });
    for (const c of ['dlvHoliday', 'dlvFees', 'dlvDefaultZone']) { no.CMD[c](); }
    no.CMD.dlvLive('cutoff'); no.CMD.dlvSwitch('bulk');
    is([no.ctx.state.ask, no.calls.writes.length, no.calls.reads.length], [null, 0, 0], 'without the panel\'s keys every command refuses: no sheet, no read, no write (capability-denied)');
    const card = no.ctx.dlvSettingsCard(false, 20);
    hasnt(card, "APP.cmd('dlv", 'and the rows are drawn as read-only lines — no setting opens, no switch flips');
    is([...card.matchAll(/APP\.cmd\('([\w$]+)'/g)].map((m) => m[1]), ['push'], '…the one tap left is the zones list, which is a read (§325 O5)');
    has(card, '20 min before close', '…which still say what is set');
  }

  console.log('\n2 · the rows say what is set');
  {
    const { ctx } = mk();
    const h = ctx.dlvSettingsCard(false, 20);
    for (const [s, m] of [['Holiday mode', 'holiday'], ['Off', 'holiday off'], ['20 min before close', 'cutoff'],
      ['Free over ¥199.00 · ¥50.00', 'fees'], ['09:00–21:00', 'pickup hours'], ['¥30.00', 'default zone fee'], ['2–4 days', 'pre-order window'],
      ['天河路 1 号', 'kitchen address'], ['Bulk attach tracking', 'bulk switch'], ['Box label', 'box switch']]) has(h, s, m);
    has(h, `<button class="toggle on" onclick="APP.cmd('dlvSwitch','box')">`, 'Box label is drawn on');
    has(h, `<button class="toggle " onclick="APP.cmd('dlvSwitch','bulk')">`, 'Bulk attach tracking is drawn off');
    for (const c of ["APP.cmd('dlvHoliday')", "APP.cmd('dlvLive','cutoff')", "APP.cmd('dlvFees')", "APP.cmd('dlvLive','pickup')",
      "APP.cmd('dlvDefaultZone')", "APP.cmd('dlvLive','preorder')", "APP.cmd('dlvLive','kitchen')"]) has(h, c, 'a row opens ' + c);
    const z = mk({ lang: 'zh' }).ctx.dlvSettingsCard(true, 20);
    for (const w of ['假日模式', '当日截单', '费用与起送', '到店自提', '其他地区 — 默认配送', '预订', '厨房地址(顾客可见)', '批量绑定运单号', '箱贴打印']) has(z, w, 'Chinese: ' + w);
  }

  console.log('\n3 · Holiday mode ON: the message in both languages, then a strong confirm');
  {
    const m = mk();
    m.CMD.dlvHoliday();
    const a = m.ctx.state.ask;
    has(a.body, 'same-day delivery is hidden, the calendar still works', 'the sheet says what it does');
    is(a.fields.map((f) => f.id), ['en', 'cn'], 'two message fields');
    is(a.confirmLabel, 'Turn on', 'the button turns it on');
    m.run({ en: 'Closed for Mid-Autumn', cn: '' });
    has(m.ctx.state.askErr, 'in English and in Chinese', 'a missing half is refused, on the sheet');
    is(m.calls.writes, [], 'and nothing is sent');
    m.run({ en: 'Closed for Mid-Autumn', cn: '中秋休息' });
    const c = m.ctx.state.ask;
    has(c.body, 'Customers can still place orders — same-day delivery is hidden, the calendar still works, and your message appears on checkout.',
      'the confirm names what stops (same-day) and what does not (orders, the calendar)');
    has(c.body, 'Shoppers are told: “Closed for Mid-Autumn”', 'and shows the message shoppers will read');
    is(c.danger, true, 'as a danger confirm');
    is(m.calls.writes, [], 'still nothing sent');
    m.run({}); await tick();
    is(plain(m.calls.writes), [{ p: '/config?history=delivery.holiday', method: 'PUT',
      body: { 'delivery.holidayMode': true, 'delivery.holidayMessage': { en: 'Closed for Mid-Autumn', cn: '中秋休息' } } }],
    'PUT /config?history=delivery.holiday with the desktop card\'s two keys');
    is(m.calls.toasts, ['Holiday mode is on — delivery is paused'], 'confirmed');
    is(m.ctx.state.cfg.delivery.holidayMode, true, 'and the screen now reads it on');
    // Already on: the same sheet edits the message, and saves without a second ask.
    const o = mk({ cfg: Object.assign(CFG(), { delivery: Object.assign(CFG().delivery, { holidayMode: true, holidayMessage: { en: 'Away', cn: '休假' } }) }) });
    o.CMD.dlvHoliday();
    is([o.ctx.state.ask.confirmLabel, o.ctx.state.ask.fields[0].value], ['Save', 'Away'], 'while on: Save, the message filled in');
    o.run({ en: 'Back Thursday', cn: '周四回来' }); await tick();
    is(plain(o.calls.writes[0].body), { 'delivery.holidayMode': true, 'delivery.holidayMessage': { en: 'Back Thursday', cn: '周四回来' } }, 'and writes it at once');
    const f = mk({ writeFails: true }); f.CMD.dlvHoliday(); f.run({ en: 'x', cn: 'y' }); f.run({}); await tick();
    has(String(f.ctx.state.dlvSetErr), 'Your role does not include this action.', 'a refusal says why, under the rows, and stays');
    is(f.calls.toasts, [], 'and toasts nothing');
    const z = mk({ lang: 'zh' }); z.CMD.dlvHoliday(); z.run({ en: 'x', cn: '' });
    has(z.ctx.state.askErr, '请先填写中英文两种提示', 'Chinese refusal');
  }

  console.log('\n4 · Fees & minimum — all three keys, always together, plain PUT');
  {
    const m = mk();
    m.CMD.dlvFees();
    is(m.ctx.state.ask.fields.map((f) => [f.id, f.value]), [['free', '199'], ['min', '50'], ['pack', '2']], 'opens on the stored figures');
    m.run({ free: '1o0', min: '50', pack: '2' });
    is(m.ctx.state.askErr, 'Enter a price — a number, 0 or more.', 'a typo is refused, never saved as 0');
    m.run({ free: '299', min: '0', pack: '3.5' }); await tick();
    is(plain(m.calls.writes), [{ p: '/config', method: 'PUT', body: { 'fees.freeShippingThreshold': 299, 'fees.pickupPackingFee': 3.5, 'fees.minOrder': 0 } }],
      'PUT /config with the desktop\'s saveDeliveryFees body');
    is(m.calls.toasts, ['Saved'], 'confirmed');
  }

  console.log('\n5 · Everywhere else — delivery.defaultZone, whole');
  {
    const m = mk();
    m.CMD.dlvDefaultZone();
    m.run({ on: '0', fee: '25', free: '', pack: '0', cap: '', lead: '3' }); await tick();
    is(plain(m.calls.writes[0]), { p: '/config', method: 'PUT', body: { 'delivery.defaultZone': { enabled: false, base_fee: 25, free_threshold: null,
      packing_fee_per_item: 0, packing_fee_cap: null, min_lead_days: 3, day_only: 1 } } }, 'blank Free over and cap are null, as on the desktop');
    const b = mk(); b.CMD.dlvDefaultZone(); b.run({ on: '1', fee: '-1', free: '', pack: '0', cap: '', lead: '3' });
    is(b.calls.writes.length, 0, 'a negative fee is refused');
  }

  console.log('\n6 · the two switches');
  {
    const m = mk();
    m.CMD.dlvSwitch('bulk');
    has(m.ctx.dlvSettingsCard(false, 20), 'Saving…', 'the switch says it is saving');
    await tick();
    is(plain(m.calls.writes), [{ p: '/config?history=delivery.bulktracking', method: 'PUT', body: { 'delivery.bulkTracking': true } }], 'Bulk attach tracking, filed under its card');
    m.CMD.dlvSwitch('box'); await tick();
    is(plain(m.calls.writes[1]), { p: '/config?history=delivery.boxlabel', method: 'PUT', body: { 'delivery.boxLabel': false } }, 'Box label off, filed under its card');
    const f = mk({ writeFails: true }); f.CMD.dlvSwitch('bulk'); await tick();
    has(f.ctx.dlvSettingsCard(false, 20), 'Your role does not include this action.', 'a refused switch says why under the rows');
    is(f.ctx.state.cfg.delivery.bulkTracking, false, 'and the switch stays where it was');
  }

  console.log('\n7 · the live cards save themselves, with Undo and Version history');
  {
    const m = mk({ server: Object.assign(CFG(), { delivery: Object.assign(CFG().delivery, { sameDayCutoffMinutes: 15 }) }) });
    m.CMD.dlvLive('cutoff');
    is(m.ctx.state.dlvOpening, 'cutoff', 'the row says it is loading');
    is(m.calls.reads, ['/config'], 'the sheet opens on a fresh read of /config');
    await tick();
    const L = m.ctx.state.ask.live;
    is(L.get('mins'), '15', 'filled from the server, not the stale copy');
    is(m.calls.writes, [], 'nothing is sent by opening');
    m.CMD.askLive('mins', '999'); m.CMD.askLive('en', ' Too late today '); await L.auto.flush(); await tick();
    is(plain(m.calls.writes[0]), { p: '/config?history=delivery.cutoff', method: 'PUT',
      body: { 'delivery.sameDayCutoffMinutes': 180, 'delivery.sameDayCutoffMessage': { en: 'Too late today', cn: '' } } },
    'clamped to 0–180 and trimmed, filed under delivery.cutoff');
    m.CMD.askLiveUndo(); await tick();
    is(plain(m.calls.writes[1]), { p: '/config?history=delivery.cutoff&note=undo', method: 'PUT',
      body: { 'delivery.sameDayCutoffMinutes': 15, 'delivery.sameDayCutoffMessage': { en: '', cn: '' } } }, 'Undo puts the visit\'s start back, noted as an undo');
    const h = mk({ versions: [{ id: 2, at: 'now', changed: ['delivery.kitchenAddress'], snapshot: { 'delivery.kitchenAddress': 'A' } },
      { id: 1, at: 'then', changed: [], snapshot: { 'delivery.kitchenAddress': 'B' }, isBaseline: true }] });
    h.CMD.dlvLive('kitchen'); await tick();
    h.CMD.askLiveHistory(); await tick();
    is(h.calls.reads, ['/config', '/config/history?card=delivery.kitchen'], 'Version history reads the card\'s own history');
    has(h.ctx.state.ask.options[0].label, 'Address', 'a version says what it changed');
    h.CMD.askRun('1'); h.CMD.askRun(''); await tick();
    is(plain(h.calls.writes.pop()), { p: '/config?history=delivery.kitchen&note=restore', method: 'PUT', body: { 'delivery.kitchenAddress': 'B' } },
      'restoring writes that version, noted as a restore');
    const f = mk({ readFails: true }); f.CMD.dlvLive('pickup'); await tick();
    is([f.ctx.state.ask, String(f.ctx.state.dlvSetErr)], [null, 'Could not load this.'], 'a failed read opens nothing and says so');
  }

  console.log('\n8 · the bodies are the desktop cards\'');
  {
    const p = mk(); p.CMD.dlvLive('pickup'); await tick();
    const P = p.ctx.state.ask.live;
    P.set('open', ''); P.set('close', '19:30'); P.set('lead', 'abc'); await P.auto.flush(); await tick();
    is(plain(p.calls.writes[0]), { p: '/config?history=pickup', method: 'PUT', body: { 'pickup.window': { open: '10:00', close: '19:30' }, 'pickup.leadMinutes': 0 } },
      'Store pickup: the window with its defaults, the lead as the desktop reads it');
    const o = mk(); o.CMD.dlvLive('preorder'); await tick();
    const O = o.ctx.state.ask.live;
    O.set('min', '9'); O.set('max', '3'); O.set('title_en', ' Back soon '); await O.auto.flush(); await tick();
    is(plain(o.calls.writes[0].body), { 'notice.preorder': { kicker_en: '', kicker_cn: '', title_en: 'Back soon', title_cn: '', message_en: '', message_cn: '', min_days: 3, max_days: 9 } },
      'Pre-orders: wholesale, blanks kept, a reversed window swapped');
    is(o.calls.writes[0].p, '/config?history=delivery.preorder', '…filed under delivery.preorder');
    O.set('min', ''); O.set('max', '6'); await O.auto.flush(); await tick();
    is([o.calls.writes[1].body['notice.preorder'].min_days, o.calls.writes[1].body['notice.preorder'].max_days], [6, 6], 'one day alone is a one-day window');
    O.set('max', ''); await O.auto.flush(); await tick();
    is([o.calls.writes[2].body['notice.preorder'].min_days, o.calls.writes[2].body['notice.preorder'].max_days], [null, null], 'both blank is no window');
  }

  console.log('\n9 · the words are the desktop\'s');
  {
    for (const s of ['Same-day cutoff · 当日截单', 'Cutoff · 截单时间', 'min before close · 分钟(关门前)', 'Message (English) · 英文消息',
      '消息(中文)· Message (Chinese)', '— optional, leave blank for the default', '— 可留空,使用默认文案',
      'Fees &amp; minimum · 费用与起送', 'Free-shipping threshold · 包邮门槛', 'Minimum order · 起送金额', 'Packing fee · 包装费',
      'Store pickup · 到店自提', 'Opens · 开始', 'Closes · 结束', 'Earliest pickup · 最早可取', 'Everywhere else — default delivery · 其他地区 — 默认配送',
      'Status · 状态', 'Flat fee · 统一运费', 'Free over · 满额免运', 'Packing / item · 每件包装费', 'Packing cap · 包装费上限', 'Lead time · 备货天数',
      'Pre-orders · 预订', 'Restock window · 预计补货时间', 'From · 最快(天)', 'To · 最慢(天)', 'Popup eyebrow · 弹窗小标题', 'Popup title · 弹窗标题',
      'Checkout notice · 结账提示', 'Kitchen address (customer-facing) · 厨房地址(顾客可见)', 'Address · 地址',
      'Bulk attach tracking · 批量绑定运单号', 'Box label · 箱贴打印',
      'Customers can still place orders — same-day delivery is hidden, the calendar still works, and your message appears on checkout. · 厨房放假时开启。顾客仍可下单 — 当日达被隐藏,日历仍可选,结账页显示您的提示。']) {
      has(DESK_HTML, s, 'desktop: ' + s);
    }
    for (const c of ["card: 'delivery.cutoff'", "card: 'delivery.kitchen'", "card: 'delivery.holiday'", "card: 'delivery.bulktracking'",
      "card: 'delivery.boxlabel'", "card: 'delivery.preorder'"]) has(DESK_DLV, c, 'the desktop card is named ' + c);
    has(DESK_MKT, "card: 'pickup'", 'and Store pickup is card \'pickup\'');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
