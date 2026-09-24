#!/usr/bin/env node
/**
 * The desktop Sales page's channel switches show live state or no state.
 *
 *   node scripts/test_sales_channel_switches.js
 *
 * THE BUG. retail-admin.html ships each channel card's switch pre-set on or
 * off (WeChat on, Eleme off, …). csLoad read /channel-status and repainted
 * them, but it swallowed a failed read and left the placeholders standing —
 * where they read exactly like live state. On 2026-09-24 the desktop showed
 * Eleme off at every store while the phone, reading the same table, showed it
 * open at Tianhe. Every other switch on that page was a placeholder too; none
 * had the "where it is live" line a real paint adds.
 *
 * No network, no DB, no browser. The functions are SLICED OUT of the shipped
 * public/retail-admin/01-core.js verbatim and run against a small fake page,
 * so editing the real code is what makes these move.
 *
 * What it locks down:
 *   1. 🔴 A FAILED READ SHOWS NO STATE. Every channel switch is blank and inert,
 *      the where-lines and the Locations section come off, and one line under
 *      the Channels kicker says so with a Retry. It retries on its own, a few
 *      times, only while the Sales tab is open.
 *   2. A reply with no channels in it is a failed read, not an empty page.
 *   3. A GOOD READ PAINTS REAL STATE — the case from the screenshots: Eleme
 *      open at Tianhe, Yuexiu's shop closed → half-lit, both stores named.
 *   4. A good read then a failed one blanks again — a painted page must not
 *      outlive the data behind it.
 *   5. An older read that lands late does not overwrite a newer one.
 *   6. A not-set-up channel is locked, not blank and not on.
 *   7. The note follows the language.
 *   8. salesInit blanks the switches BEFORE its first round-trip, and hooks the
 *      language switch once.
 *   9. The stylesheet draws the blank switch without a knob.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✓ ' + m); }
function bad(m, extra) { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); }
function check(cond, m, extra) { if (cond) ok(m); else bad(m, extra); }
function section(t) { console.log('\n' + t); }

// ── Slice the shipped source ──────────────────────────────────────────────
// Top-level functions in this file close on a `}` in column 0.
function slice(name) {
  let start = src.indexOf('\nfunction ' + name + '(');
  if (start === -1) start = src.indexOf('\nasync function ' + name + '(');
  if (start === -1) throw new Error('not found in shipped source: ' + name);
  const end = src.indexOf('\n}\n', start);
  if (end === -1) throw new Error('no column-0 close found for ' + name);
  return src.slice(start, end + 3);
}
// A one-line top-level declaration, by its opening text.
function line(prefix) {
  const start = src.indexOf('\n' + prefix);
  if (start === -1) throw new Error('declaration not found: ' + prefix);
  return src.slice(start, src.indexOf('\n', start + 1) + 1);
}

// ── A small fake page ─────────────────────────────────────────────────────
// Only what these functions touch: classList, a few selectors, insert/remove.
class El {
  constructor(tag, attrs) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.attrs = {}; this.className = ''; this.id = ''; this._html = '';
    this.disabled = false; this.onclick = null; this.title = '';
    Object.assign(this, attrs || {});
    const self = this;
    this.classList = {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (...cs) => { for (const c of cs) if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (...cs) => { self.className = self.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(' '); },
      toggle: (c, on) => { if (on === undefined) on = !self.classList.contains(c); if (on) self.classList.add(c); else self.classList.remove(c); return on; },
    };
  }
  set innerHTML(h) { this._html = String(h); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get innerHTML() { return this._html + this.children.map((c) => c.innerHTML).join(''); }
  get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); }
  set textContent(t) { this.innerHTML = String(t); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'disabled') this.disabled = true; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n, ref) {
    if (ref == null) return this.appendChild(n);
    const i = this.children.indexOf(ref);
    if (i === -1) throw new Error('NotFoundError: ref is not a child');
    if (n.parentNode) n.remove();
    n.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, n); return n;
  }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  remove() { const p = this.parentNode; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    const out = [];
    for (const el of this.walk()) {
      if (!matches(el, parts[parts.length - 1])) continue;
      // Descendant combinator: each earlier part must match some ancestor, in order.
      let k = parts.length - 2, a = el.parentNode;
      while (k >= 0 && a) { if (matches(a, parts[k])) k--; a = a.parentNode; }
      if (k < 0) out.push(el);
    }
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matches(el, compound) {
  const re = /(#[\w-]+)|(\.[\w-]+)|\[(\w+)([\^$]?)="([^"]*)"\]/g;
  let m, any = false;
  while ((m = re.exec(compound))) {
    any = true;
    if (m[1] && el.id !== m[1].slice(1)) return false;
    if (m[2] && !el.classList.contains(m[2].slice(1))) return false;
    if (m[3]) {
      const v = m[3] === 'id' ? el.id : el.getAttribute(m[3]);
      if (v == null) return false;
      if (m[4] === '^' && !v.startsWith(m[5])) return false;
      if (m[4] === '$' && !v.endsWith(m[5])) return false;
      if (!m[4] && v !== m[5]) return false;
    }
  }
  return any;
}

// The Sales tab as retail-admin.html ships it: the switches pre-set, exactly as
// the placeholders that stood in on 2026-09-24 (Eleme off, the rest on).
const SHIPPED = { wc: 'on', wb: 'on', mt: 'on', gy: 'on', el: '', ps: 'on' };
function buildPage() {
  const body = new El('body');
  const tab = body.appendChild(new El('section', { id: 'tab-sales', className: 'active' }));
  tab.appendChild(new El('div', { id: 'sales-ch-kicker', className: 'td-kicker' }));
  const grid = tab.appendChild(new El('div', { className: 'sales-grid' }));
  const card = (key, withToggle) => {
    const c = grid.appendChild(new El('div', { className: 'sales-ch' }));
    const top = c.appendChild(new El('div', { className: 'sales-ch-top' }));
    if (withToggle) {
      const b = top.appendChild(new El('button', { className: ('sales-toggle ' + SHIPPED[key] + ' is-locked').replace(/\s+/g, ' ').trim() }));
      b.setAttribute('disabled', '');
    }
    const met = c.appendChild(new El('div', { className: 'sales-ch-metrics' }));
    met.appendChild(new El('div', { id: 'sales-' + key + '-rev', className: 'm-n' }));
    c.appendChild(new El('div', { className: 'sales-ch-foot' }));
    return c;
  };
  for (const k of Object.keys(SHIPPED)) card(k, true);
  card('dr', false);  // Direct orders: no switch at all
  const byId = (id) => { for (const e of body.walk()) if (e.id === id) return e; return null; };
  return {
    body, tab,
    document: {
      body,
      getElementById: byId,
      createElement: (t) => new El(t),
      querySelectorAll: (s) => body.querySelectorAll(s),
      querySelector: (s) => body.querySelector(s),
    },
  };
}

// ── Sandbox ───────────────────────────────────────────────────────────────
const NAMES = ['csName', 'csChannel', 'csStoreName', 'csChannelCards', 'csMarkUnknown', 'csShowError',
  'csClearRetry', 'csLoad', 'csRender', 'csClearPoll', 'csRenderLocations', 'salesInit'];
const DECLS = ['const CS_KEY2CH', 'let _csData', 'let _csSeq', 'const CS_RETRY_MS', 'let _csPollTimer', 'let _salesLangHooked'];

function makeSandbox() {
  const page = buildPage();
  const timers = [];
  const langCbs = [];
  const sb = {
    LANG: 'en',
    console: { log() {}, warn() {}, error() {} },
    document: page.document,
    window: {},
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    api: async () => { throw new Error('api not stubbed'); },
    salesWireSetup: () => {},
    dashMoney: (n) => '¥' + n,
    acWrap: (s) => '¥' + s,
  };
  sb.cuT = (en, cn) => (sb.LANG === 'cn' ? cn : en);
  sb.window.onLangChange = (cb) => { langCbs.push(cb); };
  sb.onLangChange = sb.window.onLangChange;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(DECLS.map(line).join('') + NAMES.map(slice).join('\n')
    + '\nglobalThis.__state = () => ({ data: _csData, failed: _csFailed, retries: _csRetries });', sb);
  sb.window.csRetryNow = () => {};
  return { sb, page, timers, langCbs };
}

const cards = (page) => {
  const out = {};
  for (const card of page.document.querySelectorAll('#tab-sales .sales-ch')) {
    const rev = card.querySelector('[id^="sales-"][id$="-rev"]');
    if (!rev) continue;
    out[rev.id.split('-')[1]] = { card, btn: card.querySelector('.sales-toggle'), where: card.querySelector('.sales-ch-locs') };
  }
  return out;
};
const cls = (b) => b.className.split(/\s+/).filter(Boolean).sort().join(' ');

// The data behind the two screenshots: Tianhe trading, Yuexiu's shop closed,
// so every channel but Meituan is shut there.
const CELL = (code, en, open, shop) => ({ storeCode: code, name: en, nameEn: en, nameCn: en === 'Tianhe' ? '天河' : '越秀', open, shopOpen: shop });
function phoneData(over) {
  const channels = ['mini_app', 'web', 'meituan', 'eleme', 'gzgrocery', 'pos'].map((ch) => {
    const cells = ch === 'gzgrocery' ? [CELL('tianhe', 'Tianhe', true, true)]
      : [CELL('tianhe', 'Tianhe', true, true), CELL('yuexiu', 'Yuexiu', ch === 'meituan', false)];
    return { channel: ch, integrated: true, cells, cardOpen: cells.some((c) => c.open), ...((over || {})[ch] || {}) };
  });
  return { success: true, channels,
    locations: [{ storeCode: 'tianhe', name: 'Tianhe', nameEn: 'Tianhe', nameCn: '天河', shopOpen: true },
                { storeCode: 'yuexiu', name: 'Yuexiu', nameEn: 'Yuexiu', nameCn: '越秀', shopOpen: false }] };
}

function assertBlank(page, label) {
  const c = cards(page);
  let allBlank = true, detail = [];
  for (const [k, { btn, where }] of Object.entries(c)) {
    if (!btn) continue;
    const bad1 = !btn.classList.contains('unknown') || btn.classList.contains('on') || btn.classList.contains('partial') || !btn.disabled || btn.onclick || where;
    if (bad1) { allBlank = false; detail.push(k + ': ' + cls(btn) + (btn.disabled ? '' : ' (enabled)') + (where ? ' (+where)' : '')); }
  }
  check(allBlank, label, detail.join('; '));
}

(async () => {
  section('1 · 🔴 A failed read shows no state');
  {
    const { sb, page, timers } = makeSandbox();
    sb.api = async () => { throw new Error('502 Bad Gateway'); };
    await sb.csLoad();
    assertBlank(page, 'every channel switch is blank, inert, with no where-line — Eleme\'s shipped "off" and the rest\'s "on" are both gone');
    const err = page.document.getElementById('cs-err');
    check(err && /Could not read the shop status/.test(err.textContent), 'one line under the Channels kicker says the state could not be read');
    check(err && /Retry/.test(err.innerHTML), 'and offers a Retry');
    check(err && err.parentNode && err.parentNode.children.indexOf(err) === err.parentNode.children.indexOf(page.document.getElementById('sales-ch-kicker')) + 1,
      'the line sits directly under the Channels kicker');
    const tEl = cards(page).el.btn.title;
    check(/Could not read/.test(tEl), 'the Eleme switch\'s own tooltip says so too');
    check(!page.document.getElementById('cs-locations'), 'no Locations section is painted from nothing');
    const live = timers.filter((t) => t.live);
    check(live.length === 1 && live[0].ms === 3000, 'it retries on its own, first after 3s', JSON.stringify(live.map((t) => t.ms)));
    // Let every automatic retry fail: 3s, 10s, 30s, then it stops and waits for Retry.
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const t = timers.filter((x) => x.live).pop();
      if (!t) break;
      t.live = false; seen.push(t.ms); t.fn(); await new Promise((r) => setImmediate(r));
    }
    check(JSON.stringify(seen) === JSON.stringify([3000, 10000, 30000]), 'three automatic retries, backing off, then it stops', JSON.stringify(seen));
    check(page.document.querySelectorAll('#cs-err').length === 1, 'repeated failures keep ONE error line, not a stack of them');

    // Off the Sales tab, a failure schedules nothing.
    const { sb: sb2, page: page2, timers: timers2 } = makeSandbox();
    page2.tab.classList.remove('active');
    sb2.api = async () => { throw new Error('offline'); };
    await sb2.csLoad();
    check(timers2.filter((t) => t.live).length === 0, 'with the Sales tab closed, a failure schedules no retry');
  }

  section('2 · A reply with no channels is a failed read, not an empty page');
  {
    const { sb, page } = makeSandbox();
    sb.api = async () => ({ success: false, error: 'database is locked' });
    await sb.csLoad();
    assertBlank(page, 'a {success:false} reply blanks the switches rather than leaving the placeholders');
    check(!!page.document.getElementById('cs-err'), 'and shows the error line');
  }

  section('3 · A good read paints real state — the 2026-09-24 case');
  {
    const { sb, page } = makeSandbox();
    sb.api = async () => { throw new Error('first read fails'); };
    await sb.csLoad();
    sb.api = async () => phoneData();
    await sb.csLoad();
    const c = cards(page);
    check(cls(c.el.btn) === 'partial sales-toggle', 'Eleme open at Tianhe, shut at Yuexiu → half-lit', cls(c.el.btn));
    check(!c.el.btn.disabled && typeof c.el.btn.onclick === 'function', 'and it is a working switch again');
    check(c.el.where && /Tianhe/.test(c.el.where.textContent) && /Yuexiu/.test(c.el.where.textContent), 'its where-line names both stores');
    check(/sales-dot ok[^]*Tianhe/.test(c.el.where.innerHTML) && /closed[^]*Yuexiu/.test(c.el.where.innerHTML), 'Tianhe lit, Yuexiu marked closed');
    check(cls(c.mt.btn) === 'on sales-toggle', 'Meituan, open at both, is fully on', cls(c.mt.btn));
    check(cls(c.wc.btn) === 'partial sales-toggle', 'WeChat — shipped "on" — is half-lit, because Yuexiu is shut', cls(c.wc.btn));
    check(cls(c.gy.btn) === 'on sales-toggle', 'gzgrocery (Tianhe only) is on');
    check(!page.document.getElementById('cs-err'), 'the error line is gone');
    check(!!page.document.getElementById('cs-locations'), 'and the Locations section is painted');
  }

  section('4 · A good read then a failed one blanks again');
  {
    const { sb, page } = makeSandbox();
    sb.api = async () => phoneData();
    await sb.csLoad();
    sb.api = async () => { throw new Error('restarting'); };
    await sb.csLoad();
    assertBlank(page, 'a painted page does not outlive the data behind it');
    check(!page.document.getElementById('cs-locations'), 'the Locations section comes off with it');
    check(sb.__state().data === null, 'and the stale matrix is dropped');
  }

  section('5 · An older read that lands late does not overwrite a newer one');
  {
    const { sb, page } = makeSandbox();
    let releaseOld;
    const oldData = phoneData({ eleme: { cells: [CELL('tianhe', 'Tianhe', false, true), CELL('yuexiu', 'Yuexiu', false, false)], cardOpen: false } });
    sb.api = () => new Promise((r) => { releaseOld = () => r(oldData); });
    const first = sb.csLoad();
    sb.api = async () => phoneData();
    await sb.csLoad();
    releaseOld(); await first;
    check(cls(cards(page).el.btn) === 'partial sales-toggle', 'the newer answer stands', cls(cards(page).el.btn));

    const { sb: sb2, page: page2 } = makeSandbox();
    let failOld;
    sb2.api = () => new Promise((_, j) => { failOld = () => j(new Error('late failure')); });
    const first2 = sb2.csLoad();
    sb2.api = async () => phoneData();
    await sb2.csLoad();
    failOld(); await first2;
    check(cls(cards(page2).el.btn) === 'partial sales-toggle' && !page2.document.getElementById('cs-err'),
      'a late FAILURE of an older read does not blank a newer good paint');
  }

  section('6 · A not-set-up channel is locked, not blank and not on');
  {
    const { sb, page } = makeSandbox();
    sb.api = async () => phoneData({ eleme: { integrated: false } });
    await sb.csLoad();
    const b = cards(page).el.btn;
    check(cls(b) === 'is-locked sales-toggle' && b.disabled, 'Eleme not set up → locked, empty', cls(b));
  }

  section('7 · The note follows the language');
  {
    const { sb, page } = makeSandbox();
    sb.LANG = 'cn';
    sb.api = async () => { throw new Error('x'); };
    await sb.csLoad();
    const err = page.document.getElementById('cs-err');
    check(err && /无法读取营业状态/.test(err.textContent) && /重试/.test(err.textContent), 'in Chinese: 无法读取营业状态 · 重试');
  }

  section('8 · salesInit blanks first, and hooks the language switch once');
  {
    const { sb, page, langCbs } = makeSandbox();
    let summaryCalls = 0;
    sb.api = (url) => {
      if (/sales\/summary/.test(url)) { summaryCalls++; return new Promise(() => {}); }  // never lands
      return Promise.reject(new Error('unexpected ' + url));
    };
    sb.salesInit();  // not awaited: the summary never comes back
    assertBlank(page, 'the switches are blank before the summary round-trip returns');
    check(!page.document.getElementById('cs-err'), 'and not yet claiming a failure — it is loading');
    check(/Loading/.test(cards(page).el.btn.title), 'the switch\'s tooltip says it is loading');
    sb.salesInit();
    check(langCbs.length === 1, 'two opens of the tab register ONE language hook', String(langCbs.length));
    const before = summaryCalls;
    langCbs[0]('en');
    check(summaryCalls === before + 1, 'a language switch with the Sales tab open repaints it');
    page.tab.classList.remove('active');
    langCbs[0]('cn');
    check(summaryCalls === before + 1, 'and with the tab closed it does nothing (the next open repaints)');
  }

  section('9 · The stylesheet draws the blank switch without a knob');
  {
    check(/#tab-sales \.sales-toggle\.unknown \.knob\s*\{\s*display:\s*none/.test(css), '.sales-toggle.unknown hides the knob');
    check(/#tab-sales \.sales-cs-err\s*\{/.test(css), '.sales-cs-err is styled');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
