#!/usr/bin/env node
/**
 * §325 step O9 — FRESH BATCHES AND THE DELIVERY SET-UP WIZARD, ON THE PHONE.
 *
 *   node scripts/test_mobile_fresh_batches.js
 *
 * From the desktop's Delivery panel (public/retail-admin/06-delivery.js and the
 * #dlv-fresh / #dlvwiz markup in public/retail-admin.html):
 *   1. Fresh batches — saveBatchSchedule: one PUT /config carrying
 *      `batch.schedule` WHOLE plus `fresh.rescheduleCutoffHour` and
 *      `fresh.morningRequestHour`, every pre-save refusal in the desktop's
 *      words, the next-batch hint and the checkout popup preview;
 *   2. the set-up wizard — dlvWizFinish: three questions, one PUT /config with
 *      the desktop's body, offered only while delivery is not set up at all.
 * PUT /config is gated per key family (lib/cap-routes.js configKeyCap); both
 * are drawn for the Delivery panel's any-of.
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
const DESK_DLV = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '06-delivery.js'), 'utf8');
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
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}
function sliceBetween(from, to) {
  const a = src.indexOf(from);
  if (a === -1) throw new Error('not found in shipped source: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b === -1) throw new Error('end marker not found: ' + to);
  return src.slice(a, b);
}
const CODE = [
  sliceBetween('const DLV_WRITE=', 'const DLV_LIVE={'),
  sliceFn('dlvCfgPut'),
  sliceBetween('/* ── §325 O9 — FRESH BATCHES ON THE PHONE', '/* ── §325 O5 — DELIVERY ZONES ON THE PHONE'),
  sliceBetween("reg('askRun', key=>{", "reg('copyWaybill'"),
  'const cfgGet=(path,dflt)=>{ let v=state.cfg; for(const k of String(path).split(\'.\')){ if(v==null) return dflt; v=v[k]; } return v==null?dflt:v; };',
].join('\n');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const REFUSAL = () => Object.assign(new Error('forbidden_capability'), { refused: true, words: ['Your role does not include this action.', '您的角色不包含此操作。'] });
const SCHED = () => ({ enabled: true, anchor_date: '2026-09-01', interval_days: 3, skip_dates: ['2026-10-05'], cutoff_hour: 19, ready_hour: 11,
  lock_hour: null, preorder_open_hour: 0, preorder_qty: 5, preorder_channels: ['meituan'],
  kicker_en: '', kicker_cn: '', title_en: 'Baked for you', title_cn: '为您烘焙', message_en: '', message_cn: '', tip_en: '', tip_cn: '',
  local_kicker_en: '', local_kicker_cn: '', local_title_en: '', local_title_cn: '', local_message_en: '', local_message_cn: '' });
const CFG = () => ({ batch: { schedule: SCHED() }, fresh: { rescheduleCutoffHour: 21 }, delivery: { defaultZone: { enabled: false } } });

function mk(opts = {}) {
  const calls = { writes: [], reads: [], toasts: [], cmds: [] };
  const CMD = {};
  const ctx = {
    LANG: opts.lang || 'en', CUR: '¥',
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ic: (n) => `<i data-ic="${n}"></i>`, money: (c, n) => c + Number(n).toFixed(2),
    toggle: (on, cmd) => `<button class="toggle ${on ? 'on' : ''}" onclick="${cmd}"></button>`,
    mCan: (k) => { const ks = Array.isArray(k) ? k : [k]; return opts.caps ? ks.some((x) => opts.caps.includes(x)) : true; },
    canRoute: () => opts.zonesRoute !== false,
    state: { cfg: opts.cfg === undefined ? CFG() : opts.cfg, zones: opts.zones === undefined ? [] : opts.zones, ask: null, askErr: null, fb: null, dwiz: null },
    render: () => {}, reg: (n, f) => { CMD[n] = f; },
    showToast: (m) => calls.toasts.push(String(m)),
    APP: { cmd: (...a) => calls.cmds.push(a) },
    api: (p) => {
      calls.reads.push(p);
      if (p === '/config' && opts.readFails) return Promise.reject(new Error('HTTP 500'));
      if (p === '/delivery-zones') return Promise.resolve([{ id: 1, is_active: 1 }]);
      return Promise.resolve(JSON.parse(JSON.stringify(opts.server || CFG())));
    },
    apiWrite: (p, body, method) => {
      calls.writes.push({ p, method: method || 'POST', body: JSON.parse(JSON.stringify(body)) });
      if (opts.refuse) return Promise.reject(REFUSAL());
      if (opts.writeFails) return Promise.reject(Object.assign(new Error('HTTP 500'), { code: undefined }));
      return Promise.resolve({ success: true });
    },
    document: { getElementById: () => null },
    Object, Promise, Math, Number, String, Array, JSON, Error, Set, Map, Date, isNaN, parseInt, encodeURIComponent,
  };
  ctx.T = (en, zh) => (ctx.LANG === 'en' ? en : (zh || en));
  ctx.E = (en, zh) => ({ toString() { return ctx.T(en, zh); } });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, CMD, calls };
}
const open = async (m) => { m.CMD.fbOpen(); await tick(); return m.ctx.state.fb; };
const put = (body) => [{ p: '/config', method: 'PUT', body }];

async function main() {
  console.log('\n0 · who may');
  {
    const any = ['delivery:view', 'delivery:edit', 'settings:shop', 'stores:view'];
    for (const k of ['batch.schedule', 'fresh.rescheduleCutoffHour', 'fresh.morningRequestHour', 'delivery.enabled', 'delivery.coverage',
      'delivery.pricingMode', 'delivery.speed', 'delivery.sameDayCutoff', 'delivery.defaultZone']) {
      is(configKeyCap(k), any, 'PUT /config ' + k + ' is the Delivery panel\'s any-of');
    }
    const r = mk({ caps: ['orders:view'] });
    r.CMD.fbOpen(); await tick(); is([r.ctx.state.fb, r.calls.reads], [null, []], 'Fresh batches does not open without it');
    r.ctx.state.fb = { d: r.ctx.fbDraft(CFG()) }; r.CMD.fbSave(); await tick(); is(r.calls.writes, [], 'and Save sends nothing');
    has(src, "${row(T('Fresh batches','新鲜现做'), fbStatus(state.cfg),'fbOpen')}", 'the Delivery list carries the row (a writer opens it; for anyone else row() draws a read-only line)');
  }

  console.log('\n1 · the row and the sheet open on a fresh read');
  {
    const m = mk();
    is(m.ctx.fbStatus(CFG()), 'Every 3 days, order by 19:00', 'the row says the hub\'s status');
    is(m.ctx.fbStatus({ batch: { schedule: { enabled: false } } }), 'Off', 'or Off');
    is(m.ctx.fbStatus({}), 'Off', 'never set: Off');
    let release; const slow = mk(); slow.ctx.api = (p) => { slow.calls.reads.push(p); return new Promise((r) => { release = () => r(CFG()); }); };
    slow.CMD.fbOpen(); await tick();
    has(slow.ctx.sheetBatch(), 'Loading…', 'loading says so'); hasnt(slow.ctx.sheetBatch(), 'fbSave', 'with no Save'); release(); await tick();
    const f = await open(m);
    is(m.calls.reads, ['/config'], 'GET /config first');
    is([f.d.on, f.d.anchor, f.d.interval, f.d.cutoff, f.d.ready, f.d.preOpen, f.d.lock, f.d.qty, f.d.ch, f.d.skip, f.d.resched, f.d.morning],
      [true, '2026-09-01', '3', '19', '11', '', '', '5', ['meituan'], ['2026-10-05'], '21', '6'],
      'drafted the desktop\'s way: an unset lock and a 0 start stay blank, an unwritten morning hour reads 6');
    const s = m.ctx.sheetBatch();
    for (const t of ['On. A batch is made every 3 days, and orders close at 19:00.', 'Make every', 'A batch day', 'Order-by hour', 'Ready from the kitchen',
      'Pre-order opens', 'Pre-order cut-off', 'How many to offer', 'Channels', 'Skip these dates (vacations)', 'Lock at hour, evening before',
      'Morning request hour', 'Checkout popup', 'Outside Guangzhou', 'Inside Guangzhou', 'At checkout']) has(s, t, 'shows: ' + t);
    has(s, 'value="Baked for you"', 'the saved popup title'); has(s, 'placeholder="Next fresh batch"', 'a blank one shows the built-in wording');
    has(s, '2026-10-05', 'the skip date as a chip');
    const n = mk({ server: { batch: { schedule: { enabled: false } }, fresh: { morningRequestHour: null } } }); const nf = await open(n);
    is([nf.d.on, nf.d.interval, nf.d.cutoff, nf.d.morning, nf.d.resched], [false, '2', '20', '', '20'], 'an explicit blank morning hour stays blank (off); defaults 2 days, 20:00');
    has(n.ctx.sheetBatch(), 'Off. Nothing waits for a batch.', 'and the switch says Off');
    const x = mk({ readFails: true }); await open(x);
    has(x.ctx.sheetBatch(), 'Could not load this.', 'a failed read says so'); hasnt(x.ctx.sheetBatch(), 'fbSave', 'and offers no Save over empty boxes');
  }

  console.log('\n2 · Save sends the desktop\'s body');
  {
    const m = mk(); await open(m);
    m.CMD.fbSet('interval', '2'); m.CMD.fbSet('lock', '10'); m.CMD.fbSet('preOpen', '6'); m.CMD.fbSet('morning', '');
    m.CMD.fbCh('eleme'); m.CMD.fbCh('meituan'); m.CMD.fbSkipAdd('2026-10-01'); m.CMD.fbSkipAdd('2026-10-05'); m.CMD.fbSkipAdd('nope');
    m.CMD.fbSet('lmsg_en', ' Sold out — next batch {make_date} ');
    m.CMD.fbSave(); await tick();
    const want = Object.assign(SCHED(), { interval_days: 2, skip_dates: ['2026-10-01', '2026-10-05'], lock_hour: 10, preorder_open_hour: 6,
      preorder_channels: ['eleme'], local_message_en: 'Sold out — next batch {make_date}' });
    is(m.calls.writes, put({ 'fresh.rescheduleCutoffHour': 21, 'fresh.morningRequestHour': '', 'batch.schedule': want }),
      'PUT /config: batch.schedule whole, every field, plus the two fresh.* hours (blank morning = off)');
    is([m.calls.toasts, m.ctx.state.fb], [['Saved'], null], 'saved, and the sheet closes');
    const s = mk(); await open(s); s.CMD.fbSkipDel('2026-10-05'); s.CMD.fbSet('ready', ''); s.CMD.fbSet('qty', ''); s.CMD.fbSave(); await tick();
    const b = s.calls.writes[0].body['batch.schedule'];
    is([b.skip_dates, b.ready_hour, b.preorder_qty], [[], null, 0], 'a removed skip date goes; a blank ready hour is null (off); a blank quantity is 0');
    const off = mk(); await open(off); off.CMD.fbToggle(); off.CMD.fbSet('anchor', ''); off.CMD.fbSet('cutoff', 'x'); off.CMD.fbSave(); await tick();
    is([off.calls.writes[0].body['batch.schedule'].enabled, off.calls.writes[0].body['batch.schedule'].cutoff_hour], [false, 20],
      'switched off, the schedule saves without a batch day, and a garbled hour falls back to 20 — as the desktop does');
  }

  console.log('\n3 · the desktop\'s refusals, before anything is sent');
  {
    for (const [edits, want] of [
      [{ anchor: '' }, 'Pick a batch day first'],
      [{ cutoff: '24' }, 'Order-by hour must be 0–23'],
      [{ ready: 'x' }, 'Order-by hour must be 0–23'],
      [{ preOpen: '25' }, 'Pre-order start must be 0–23'],
      [{ lock: '-1' }, 'Order-by hour must be 0–23'],
      [{ preOpen: '11' }, 'Pre-orders must open before the cut-off'],
      [{ preOpen: '9', lock: '9' }, 'Pre-orders must open before the cut-off'],
      [{ qty: '-2' }, 'Enter a whole number, 0 or more'],
      [{ resched: '' }, 'Enter an hour 0–23'],
      [{ morning: '30' }, 'Enter an hour 0–23']]) {
      const m = mk(); await open(m);
      for (const [k, v] of Object.entries(edits)) m.CMD.fbSet(k, v);
      m.CMD.fbSave(); await tick();
      is([String(m.ctx.state.fb.saveErr), m.calls.writes], [want, []], JSON.stringify(edits) + ' → ' + want);
    }
    const r = mk({ refuse: true }); await open(r); r.CMD.fbSave(); await tick();
    is([String(r.ctx.state.fb.saveErr), r.ctx.state.fb.busy], ['Your role does not include this action.', false], 'a refusal says why and the sheet stays');
    const f = mk({ writeFails: true }); await open(f); f.CMD.fbSave(); await tick();
    is(String(f.ctx.state.fb.saveErr), 'That did not save. Nothing has changed — try again.', 'a failure says nothing changed');
    const b = mk(); b.ctx.apiWrite = (p, body, method) => { b.calls.writes.push({ p, method, body }); return new Promise(() => {}); };
    await open(b); b.CMD.fbSave(); await tick();
    has(b.ctx.sheetBatch(), 'Saving…', 'saving says so'); b.CMD.fbSave(); b.CMD.fbClose();
    is([b.calls.writes.length, b.ctx.state.fb !== null], [1, true], 'one send, and the sheet stays until it lands');
  }

  console.log('\n4 · the hint and the preview');
  {
    const m = mk(); const f = await open(m);
    const now = new Date(2026, 9, 2, 10, 0, 0);
    is(m.ctx.fbNextBatch(f.d, now), '2026-10-04', 'every 3 days from 2026-09-01 (… 28 Sep, 1 Oct, 4 Oct), the next batch after 2 Oct is 4 Oct');
    is(m.ctx.fbNextBatch(Object.assign({}, f.d, { skip: ['2026-10-04'] }), now), '2026-10-07', 'a skipped day rolls a whole interval');
    is([m.ctx.fbNextBatch(f.d, new Date(2026, 9, 4, 18, 0, 0)), m.ctx.fbNextBatch(f.d, new Date(2026, 9, 4, 19, 0, 0))], ['2026-10-04', '2026-10-07'], 'on a batch day it is today until the order-by hour, then the batch after');
    is(m.ctx.fbNextBatch(Object.assign({}, f.d, { anchor: '' }), now), null, 'no batch day, no date');
    const pv = m.ctx.fbPreview(f);
    has(pv, 'Baked for you', 'the typed title'); has(pv, 'Next fresh batch', 'a blank eyebrow previews the built-in one');
    has(pv, '{delivery_date}', '{delivery_date} stays a token — it is resolved at checkout');
    has(pv, '3 of these lines use the built-in wording.', 'and counts the lines that fell back');
    m.CMD.fbTab('gz'); has(m.ctx.fbPreview(m.ctx.state.fb), 'Some freshly-made items in your order are sold out right now.', 'the Guangzhou tab previews its own popup');
    has(m.ctx.sheetBatch(), 'The only placeholder is {make_date}.', 'and says which placeholder it has');
    const nod = mk(); const nf = await open(nod); nod.CMD.fbSet('anchor', '');
    has(nod.ctx.fbPreview(nf), 'Pick a batch day above to see the dates.', 'no batch day: says so');
    has(nod.ctx.fbPreview(nf), '{ship_date}', 'and leaves the token');
  }

  console.log('\n5 · the set-up wizard: only while delivery is not set up');
  {
    is(mk({ zones: [] }).ctx.dlvUnconfigured(), true, 'no zone, no default, never finished: not set up');
    is(mk({ zones: [{ is_active: 1 }] }).ctx.dlvUnconfigured(), false, 'a live zone: set up');
    is(mk({ zones: [{ is_active: 0 }] }).ctx.dlvUnconfigured(), true, 'only switched-off zones: still not');
    is(mk({ cfg: { delivery: { defaultZone: { enabled: true } } } }).ctx.dlvUnconfigured(), false, 'a national default on: set up');
    is(mk({ cfg: { delivery: { enabled: true } } }).ctx.dlvUnconfigured(), false, 'the wizard finished once: set up');
    is(mk({ zones: null }).ctx.dlvUnconfigured(), false, 'zones not read yet: say nothing');
    is(mk({ cfg: null }).ctx.dlvUnconfigured(), false, 'config not read yet: say nothing');
    const card = mk().ctx.dlvSetupCard();
    has(card, 'Delivery to their door', 'the card'); has(card, 'Off — not set up yet', 'its state'); has(card, "APP.cmd('dwizOpen')", 'and Set up delivery');
    const ro = mk({ caps: ['orders:view'] }).ctx.dlvSetupCard();
    has(ro, 'Off — not set up yet', 'a reader sees the state'); hasnt(ro, 'dwizOpen', 'and no button'); hasnt(ro, '3 quick questions', 'nor the sentence that leads to it');
    is(mk({ zones: [{ is_active: 1 }] }).ctx.dlvSetupCard(), '', 'set up: no card');
    has(src, '${dlvSetupCard()}', 'the Delivery screen draws it');
  }

  console.log('\n6 · the wizard\'s three questions and its body');
  {
    const m = mk(); m.CMD.dwizOpen();
    let s = m.ctx.sheetDlvWiz();
    has(s, 'Where do you deliver?', 'step 1'); has(s, 'Just my city', 'its three answers'); has(s, 'Anywhere in the country', '…');
    hasnt(s, 'aria-checked="true"', 'nothing pre-selected'); has(s, ' disabled onclick="APP.cmd(\'dwizNext\')"', 'Continue waits for a pick');
    hasnt(s, 'Your city', 'no city box: the desktop never sends what is typed there');
    m.CMD.dwizNext(); is(m.ctx.state.dwiz.step, 1, 'and does nothing without one');
    m.CMD.dwizPick('where', 'mars'); is(m.ctx.state.dwiz.where, null, 'an answer not offered is ignored');
    m.CMD.dwizPick('where', 'city'); m.CMD.dwizNext();
    s = m.ctx.sheetDlvWiz();
    has(s, 'What does delivery cost the customer?', 'step 2'); has(s, 'aria-checked="true"', 'One flat price starts ticked, as on the desktop');
    has(s, 'value="8"', 'charge 8'); has(s, 'value="99"', 'free over 99');
    m.CMD.dwizNext(); s = m.ctx.sheetDlvWiz();
    has(s, 'When does the order arrive?', 'step 3'); has(s, 'Turn delivery on', 'the last button says what it does');
    m.CMD.dwizBack(); is(m.ctx.state.dwiz.step, 2, 'Back goes back'); m.CMD.dwizNext();
    is(m.calls.writes, [], 'nothing sent until the last step');
    m.CMD.dwizNext(); await tick();
    is(m.calls.writes, put({ 'delivery.enabled': true, 'delivery.coverage': 'city', 'delivery.pricingMode': 'flat', 'delivery.speed': 'nextday',
      'delivery.defaultZone': { enabled: true, day_only: 1, base_fee: 8, free_threshold: 99, min_lead_days: 1, same_day_allowed: 0 } }),
      'city · flat · next day: the desktop\'s body, the national default seeded');
    is([m.calls.toasts, m.ctx.state.dwiz, m.calls.reads, m.calls.cmds], [['Delivery is on'], null, ['/delivery-zones'], []], 'on, and the zones read again');

    const run = async (where, price, when, vals) => {
      const x = mk(); x.CMD.dwizOpen(); x.CMD.dwizPick('where', where); x.CMD.dwizNext();
      x.CMD.dwizPick('price', price); for (const [k, v] of Object.entries(vals || {})) x.CMD.dwizSet(k, v);
      x.CMD.dwizNext(); x.CMD.dwizPick('when', when); x.CMD.dwizNext(); await tick(); return x;
    };
    let x = await run('country', 'weight', 'sameday', { w1: '12', wx: '4', cutoff: '15:30' });
    is(x.calls.writes[0].body, { 'delivery.enabled': true, 'delivery.coverage': 'country', 'delivery.pricingMode': 'weight', 'delivery.speed': 'sameday',
      'delivery.defaultZone': { enabled: true, day_only: 1, base_fee: 12, free_threshold: null, weight: { first_kg_fee: 12, extra_kg_fee: 4 }, min_lead_days: 0, same_day_allowed: 1 },
      'delivery.sameDayCutoff': '15:30' }, 'by weight, same day: the first kg is the floor, and the order-by time rides along');
    x = await run('country', 'free', 'slots');
    is(x.calls.writes[0].body['delivery.defaultZone'], { enabled: true, day_only: 0, base_fee: 0, free_threshold: null, min_lead_days: 0, same_day_allowed: 0 },
      'always free, customer picks a time: real slots, not the day-only calendar');
    x = await run('city', 'flat', 'courier', { free: '0' });
    is([x.calls.writes[0].body['delivery.defaultZone'].free_threshold, x.calls.writes[0].body['delivery.defaultZone'].min_lead_days], [null, 1], 'free over 0 is no threshold; courier is one day');
    x = await run('areas', 'flat', 'nextday');
    is([Object.keys(x.calls.writes[0].body), x.calls.cmds], [['delivery.enabled', 'delivery.coverage', 'delivery.pricingMode', 'delivery.speed'], [['push', 'zones']]],
      'chosen areas: no national default, and straight on to the zones');
    x = await run('city', 'zones', 'nextday');
    is([('delivery.defaultZone' in x.calls.writes[0].body), x.calls.cmds], [false, [['push', 'zones']]], 'a price per area: likewise');
    for (const [price, vals] of [['flat', { flat: 'abc' }], ['flat', { free: '' }], ['weight', { wx: '-1' }], ['zones', { flat: '' }]]) {
      const y = await run('city', price, 'nextday', vals);
      is([String(y.ctx.state.dwiz.err), y.calls.writes], ['Enter a price — a number, 0 or more.', []], price + ' ' + JSON.stringify(vals) + ': refused, nothing sent (money fails closed)');
    }
    const r = mk({ refuse: true }); r.CMD.dwizOpen(); r.CMD.dwizPick('where', 'city'); r.CMD.dwizNext(); r.CMD.dwizNext(); r.CMD.dwizNext(); await tick();
    is([String(r.ctx.state.dwiz.err), r.ctx.state.dwiz.busy, r.calls.toasts], ['Your role does not include this action.', false, []], 'a refusal stays on the sheet');
    const d = mk({ caps: ['orders:view'] }); d.CMD.dwizOpen(); is(d.ctx.state.dwiz, null, 'without the key the wizard does not open');
    d.ctx.state.dwiz = { step: 3, where: 'city', price: 'free', when: 'nextday', v: {} }; d.CMD.dwizNext(); await tick();
    is(d.calls.writes, [], 'and finishing sends nothing');
    const set = mk({ zones: [{ is_active: 1 }] }); set.CMD.dwizOpen(); is(set.ctx.state.dwiz, null, 'nor once delivery is set up');
  }

  console.log('\n7 · Chinese, and that the words are the desktop\'s');
  {
    const z = mk({ lang: 'zh' }); await open(z);
    has(z.ctx.sheetBatch(), '新鲜现做', 'title'); has(z.ctx.sheetBatch(), '开启。每 3 天制作一批,19:00 截单。', 'the switch line');
    z.CMD.dwizOpen(); has(z.ctx.sheetDlvWiz(), '你们送到哪里?', 'the wizard');
    is(z.ctx.fbStatus(CFG()), '每 3 天制作一批,19:00 截单', 'the row');
    const N = (s) => s.replace(/\s*\n\s*/g, ' ');
    const HTML = N(DESK_HTML), JS = N(DESK_DLV).replace(/cuT\( /g, 'cuT(');
    for (const [en, zh] of [['Fresh batches', '新鲜现做'], ['Batch schedule', '制作排期'], ['Make every', '每隔'], ['A batch day', '某个制作日'],
      ['Order-by hour', '当日截单'], ['Ready from the kitchen', '厨房已完成'], ['Pre-order opens', '预订开始'], ['Pre-order cut-off', '预订截单'],
      ['How many to offer', '预订可售数量'], ['Channels', '渠道'], ['Skip these dates (vacations)', '跳过这些日期(假期)'],
      ['Lock at hour, evening before', '前一晚锁定时间'], ['Morning request hour', '厨房制作请求时间'], ['Checkout popup', '结账弹窗'],
      ['Leave any field blank to use the default wording.', '任意字段留空则使用默认文案。'], ['Outside Guangzhou', '广州以外'], ['Inside Guangzhou', '广州市内'],
      ['Popup eyebrow', '弹窗小标题'], ['Popup title', '弹窗标题'], ['Checkout notice', '结账提示'], ['Freshness tip', '新鲜提示'], ['At checkout', '结账时'],
      ['Set up delivery', '设置配送'], ['Where do you deliver?', '你们送到哪里?'], ['Just my city', '只送本市'], ['A few areas I choose', '我指定的几个地区'],
      ['Anywhere in the country', '全国配送'], ['What does delivery cost the customer?', '顾客要付多少运费?'], ['One flat price', '统一运费'],
      ['By weight', '按重量计费'], ['Always free', '全部免运费'], ['A different price per area', '不同地区不同价'], ['When does the order arrive?', '订单什么时候送到?'],
      ['Same day', '当日达'], ['Next day', '次日达'], ['A few days — by courier', '几天内,快递寄送'], ['Customer picks a time', '顾客自选时间'],
      ['Back', '上一步'], ['Continue', '继续'], ['Delivery to their door', '送货上门'], ['Off — not set up yet', '未开启,尚未设置'], ['about 1 minute', '约 1 分钟']]) {
      has(HTML, en + ' · ' + zh, 'the desktop\'s own pair: ' + en);
    }
    for (const [en, zh] of [['Turn delivery on', '开启配送'], ['Delivery is on', '配送已开启'], ['Off. Nothing waits for a batch.', '关闭。没有订单需要等待制作。'],
      ['Pick a batch day above to see the dates.', '请先在上面选择一个制作日以显示日期。'], ['None', '无']]) {
      has(JS, `cuT('${en}', '${zh}')`, 'the desktop\'s own pair: ' + en);
    }
    for (const [en, zh] of [['Pick a batch day first', '请先选择一个制作日'], ['Order-by hour must be 0–23', '当日截单请输入 0–23 的小时'],
      ['Pre-order start must be 0–23', '预订开始请输入 0–23 的小时'], ['Pre-orders must open before the cut-off', '预订开始必须早于预订截单'],
      ['Enter a whole number, 0 or more', '请输入 0 或以上的整数'], ['Enter an hour 0–23', '请输入 0–23 的小时']]) {
      has(DESK_DLV, `'${en} · ${zh}'`, 'the desktop\'s own refusal: ' + en);
    }
  }

  console.log('\n8 · a store with no coordinates points at the phone\'s own store editor (X6)');
  {
    const SD = sliceFn('screenDelivery');
    const scr = (opts) => {
      const ctx = {
        LANG: opts.lang || 'en', state: { printer: {}, geo: { stores: { total: 3, geocoded: 3 - opts.missing, missing: opts.missing } }, cfg: {}, dlvBusy: false },
        T: (en, zh) => (ctx.LANG === 'en' ? en : (zh || en)), ic: (n) => `<i data-ic="${n}"></i>`, escAttr: String,
        loadPrinter: () => {}, loadGeo: () => {}, dlvZoneFacts: () => null, settingsGroupCard: () => '', dlvSetupCard: () => '',
        dlvSettingsCard: () => '', noteBar: (t) => t, desktopNote: () => '',
        canRoute: (k) => (k === 'storeone' ? !!opts.edit : true),
      };
      vm.createContext(ctx); vm.runInContext(SD, ctx); return ctx.screenDelivery();
    };
    const one = scr({ missing: 1, edit: true });
    has(one, 'One store has no coordinates, so it can never be the nearest one.', 'the warning keeps its first sentence');
    hasnt(one, 'on desktop', 'and no longer sends anyone to the desktop');
    has(one, "APP.cmd('push','operations')", 'it leads to Operations, where the store is edited');
    has(scr({ missing: 2, edit: true }), '2 stores have no coordinates, so they can never be the nearest one.', 'two stores');
    const ro = scr({ missing: 1, edit: false });
    has(ro, 'never be the nearest one', 'without stores:edit the fact is still said'); hasnt(ro, "'push','operations'", 'but no way in that would not work');
    const zh = scr({ missing: 1, edit: true, lang: 'zh' });
    has(zh, '1 家门店没有坐标，无法参与就近派单。', 'Chinese: the live sentence, its last clause dropped'); hasnt(zh, '电脑端', 'and no desktop');
    has(zh, '运营', 'the live Operations pair');
    is(scr({ missing: 0, edit: true }).includes('no coordinates'), false, 'every store located: nothing');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
