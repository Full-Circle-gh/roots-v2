#!/usr/bin/env node
/**
 * test_fapiao_auto_issue_flow.js — what the dormant 发票 auto-issue would send
 * and do, the day a tenant turns it on.
 *
 *   node scripts/test_fapiao_auto_issue_flow.js
 *
 * WHAT IT GUARDS. The Nuonuo auto-issue stays in the platform, dormant (§99
 * addendum 2, pinned by test_fapiao_no_auto_issue.js), for the first tenant
 * whose provider has an API. A mutation sweep of routes/retail.js (2026-10-14)
 * broke its four functions and the order-notification helper 25 ways; one was
 * caught. Among the ones that were not:
 *
 *   • the configured tax code, clerk and seller details silently replaced by
 *     blanks on the invoice;
 *   • a company's tax number dropped, or a person's invoice given one;
 *   • the per-order idempotency key and the unit price wrong;
 *   • an unpaid or cancelled order issued, or one already submitted issued a
 *     SECOND time;
 *   • "issued" written to an order Nuonuo has not finished;
 *   • an order with no customer (a till sale) notified to nobody.
 *
 * HOW. The real functions are lifted from the source (retailSource(), so they
 * are found in routes/retail.js or in lib/ after decisions §477 moves them) and
 * run over the real retail_orders / retail_order_items definitions, with a
 * stand-in Nuonuo that records every call, a stand-in config, and timers that
 * are recorded rather than run.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb } = require('./test-support/memory-db');
const { retailSource } = require('./test-support/retail-source');

const ROOT = path.join(__dirname, '..');
const SRC = retailSource();
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

function fnSrc(name) {
  const at = SRC.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(at >= 0, `function ${name} not found`);
  return SRC.slice(at, SRC.indexOf('\n}', at) + 2);
}

// ── world ─────────────────────────────────────────────────────────────────
const db = openTablesDb(DB_SRC, ['retail_orders', 'retail_order_items']);
let CFG = {};
const cfgValue = (k, d) => (k in CFG ? CFG[k] : d);
const CREDS = { appKey: 'k', salerTaxNum: '91440101TEST' };
let enabled = true;
const nuonuo = {
  calls: [],
  issueReply: { ok: true, serialNo: 'SN-1' },
  queryReply: { ok: true, done: true, pdfUrl: 'https://nn.test/inv.pdf', number: '0001' },
  nuonuoEnabled: () => enabled,
  issueInvoice: async (payload) => { nuonuo.calls.push(['issue', payload]); return nuonuo.issueReply; },
  queryResult: async (serial) => { nuonuo.calls.push(['query', serial]); return nuonuo.queryReply; },
};
const notices = [];
const timers = [];

const NAMES = ['fapiaoSettings', 'buildNuonuoOrder', 'finalizeInvoiceResult', 'maybeAutoIssueInvoice', 'notifyForOrder'];
const F = new Function('tdb', 'cfgValue', 'integ', '_nuonuo', 'notifyCustomer', 'currentTenantId', 'tenantAls',
  'rawTenantDb', 'setTimeout', 'console',
  `${NAMES.map(fnSrc).join('\n')}\nreturn { ${NAMES.join(', ')} };`)(
  () => db, cfgValue, () => ({ nuonuo: CREDS }), nuonuo, (cid, n) => notices.push({ cid, ...n }), () => 7,
  { run: (_d, fn) => fn() }, (tid) => tid, (fn, ms) => timers.push(ms), { error() {}, warn() {} });

const ins = db.prepare(`INSERT INTO retail_orders
  (id, order_no, customer_id, status, needs_invoice, invoice_type, invoice_title, invoice_tax_id, invoice_email, invoice_status, invoice_serial, total)
  VALUES (@id, @order_no, @customer_id, @status, @needs_invoice, @invoice_type, @invoice_title, @invoice_tax_id, @invoice_email, @invoice_status, @invoice_serial, 0)`);
const order = (o) => ins.run({ customer_id: 3, status: 'paid', needs_invoice: 1, invoice_type: 'company',
  invoice_title: 'ACME 有限公司', invoice_tax_id: '91TAXID', invoice_email: 'a@acme.test', invoice_status: null,
  invoice_serial: null, ...o });
const item = db.prepare(`INSERT INTO retail_order_items (order_id, name_en, name_cn, qty, line_total, unit_price)
                         VALUES (?, ?, ?, ?, ?, 0)`);
const row = (id) => db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(id);
const reset = () => { nuonuo.calls.length = 0; notices.length = 0; timers.length = 0; enabled = true;
  nuonuo.issueReply = { ok: true, serialNo: 'SN-1' };
  nuonuo.queryReply = { ok: true, done: true, pdfUrl: 'https://nn.test/inv.pdf', number: '0001' };
  CFG = { 'fapiao.autoIssue': true }; };

const pending = [];
const section = (t) => pending.push(() => console.log('\n' + t));
const it = (name, fn) => pending.push(async () => {
  reset();
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
});
let pass = 0, fail = 0;

// ══ 1. settings ════════════════════════════════════════════════════════════
section('1. the invoice settings are what the tenant configured');

it('configured values come through unchanged', () => {
  CFG = { 'fapiao.autoIssue': true, 'fapiao.invoiceLine': 'bs', 'fapiao.taxRate': 0.13, 'fapiao.taxCode': '1030101',
    'fapiao.clerk': '李', 'fapiao.saler': { name: 'Roots', tel: '020', address: '广州', account: 'BOC 1' } };
  assert.deepStrictEqual(F.fapiaoSettings(), { autoIssue: true, invoiceLine: 'bs', taxRate: '0.13', taxCode: '1030101',
    clerk: '李', saler: { name: 'Roots', tel: '020', address: '广州', account: 'BOC 1' } });
});
it('nothing configured: off, 普通发票 (pc), 6%, blanks — never undefined', () => {
  CFG = {};
  assert.deepStrictEqual(F.fapiaoSettings(), { autoIssue: false, invoiceLine: 'pc', taxRate: '0.06', taxCode: '',
    clerk: '', saler: { name: '', tel: '', address: '', account: '' } });
});
it('a seller saved as null still reads as blanks', () => {
  CFG = { 'fapiao.saler': null };
  assert.deepStrictEqual(F.fapiaoSettings().saler, { name: '', tel: '', address: '', account: '' });
});

// ══ 2. what goes to the tax bureau ═════════════════════════════════════════
section('2. the invoice sent to Nuonuo');

const SETTINGS = { invoiceLine: 'pc', clerk: '李', taxRate: '0.06', taxCode: '1030101',
  saler: { name: 'Roots', tel: '020', address: '广州', account: 'BOC 1' } };
it('one key per order (inv<id>), buyer and seller from the order and the settings', () => {
  const p = F.buildNuonuoOrder({ id: 42, order_no: 'TC001129', invoice_type: 'company', invoice_title: 'ACME',
    invoice_tax_id: '91TAXID', invoice_email: 'a@acme.test' }, [], SETTINGS, '91440101TEST');
  assert.strictEqual(p.senid, 'inv42');
  assert.strictEqual(p.orderNo, 'TC001129');
  assert.deepStrictEqual([p.buyerName, p.buyerTaxNum, p.buyerEmail], ['ACME', '91TAXID', 'a@acme.test']);
  assert.deepStrictEqual(p.saler, { taxNum: '91440101TEST', name: 'Roots', tel: '020', address: '广州', account: 'BOC 1' });
  assert.deepStrictEqual([p.invoiceLine, p.clerk], ['pc', '李']);
});
it('a personal invoice carries no tax number, even if one was typed', () => {
  const p = F.buildNuonuoOrder({ id: 1, invoice_type: 'personal', invoice_tax_id: '91TAXID' }, [], SETTINGS, 'X');
  assert.strictEqual(p.buyerTaxNum, '');
});
it('lines: tax-inclusive unit price = line total / qty; Chinese name first; the rate and code on each', () => {
  const p = F.buildNuonuoOrder({ id: 1 }, [
    { name_en: 'Wrap', name_cn: '卷饼', qty: 3, line_total: 90 },
    { name_en: 'Salad', name_cn: null, qty: 0, line_total: 25 },
    { name_en: null, name_cn: null, qty: 2, line_total: null },
  ], SETTINGS, 'X');
  assert.deepStrictEqual(p.items, [
    { name: '卷饼', price: 30, num: 3, taxRate: '0.06', taxCode: '1030101' },
    { name: 'Salad', price: 25, num: 1, taxRate: '0.06', taxCode: '1030101' },
    { name: 'Goods', price: 0, num: 2, taxRate: '0.06', taxCode: '1030101' },
  ]);
});

// ══ 3. auto-issue ══════════════════════════════════════════════════════════
section('3. auto-issue: only a paid order that wants one, and only once');

it('a paid order that wants an invoice is issued once, its serial kept, and the result polled', async () => {
  order({ id: 10, order_no: 'TC10' });
  item.run(10, 'Wrap', '卷饼', 2, 60);
  await F.maybeAutoIssueInvoice(10);
  assert.deepStrictEqual(nuonuo.calls.map((c) => c[0]), ['issue']);
  assert.strictEqual(nuonuo.calls[0][1].senid, 'inv10');
  assert.strictEqual(row(10).invoice_serial, 'SN-1');
  assert.strictEqual(row(10).invoice_auto_error, null);
  assert.deepStrictEqual(timers, [5000, 20000, 60000]);
});
it('dormant: auto-issue switched off, or no Nuonuo account → nothing sent', async () => {
  order({ id: 11, order_no: 'TC11' });
  CFG = {};
  await F.maybeAutoIssueInvoice(11);
  CFG = { 'fapiao.autoIssue': true }; enabled = false;
  await F.maybeAutoIssueInvoice(11);
  assert.strictEqual(nuonuo.calls.length, 0);
});
it('not issued: no invoice wanted, unpaid, cancelled, already issued, already submitted', async () => {
  order({ id: 12, order_no: 'TC12', needs_invoice: 0 });
  order({ id: 13, order_no: 'TC13', status: 'pending_payment' });
  order({ id: 14, order_no: 'TC14', status: 'cancelled' });
  order({ id: 15, order_no: 'TC15', invoice_status: 'issued' });
  order({ id: 16, order_no: 'TC16', invoice_serial: 'SN-OLD' });
  for (const id of [12, 13, 14, 15, 16, 999]) await F.maybeAutoIssueInvoice(id);
  assert.strictEqual(nuonuo.calls.length, 0, 'a second fapiao, or one for money never taken');
  assert.strictEqual(row(16).invoice_serial, 'SN-OLD');
});
it('no email: not sent, and the reason is written for the office queue', async () => {
  order({ id: 17, order_no: 'TC17', invoice_email: null });
  await F.maybeAutoIssueInvoice(17);
  assert.strictEqual(nuonuo.calls.length, 0);
  assert.strictEqual(row(17).invoice_auto_error, 'no_email');
});
it('Nuonuo refuses: no serial kept, the reason written, nothing polled', async () => {
  order({ id: 18, order_no: 'TC18' });
  nuonuo.issueReply = { ok: false, error: 'bad_tax_num' };
  await F.maybeAutoIssueInvoice(18);
  assert.strictEqual(row(18).invoice_serial, null);
  assert.strictEqual(row(18).invoice_auto_error, 'bad_tax_num');
  assert.deepStrictEqual(timers, []);
});

// ══ 4. finishing an issued invoice ═════════════════════════════════════════
section('4. finishing: "issued" only when Nuonuo says done, then the customer is told');

it('done: number, PDF and time stored, error cleared, and the customer notified once', async () => {
  order({ id: 20, order_no: 'TC20', invoice_serial: 'SN-20' });
  db.prepare("UPDATE retail_orders SET invoice_auto_error = 'old' WHERE id = 20").run();
  assert.deepStrictEqual(await F.finalizeInvoiceResult(20), { done: true });
  const r = row(20);
  assert.deepStrictEqual([r.invoice_status, r.invoice_number, r.invoice_file_url, r.invoice_auto_error],
    ['issued', '0001', 'https://nn.test/inv.pdf', null]);
  assert.ok(r.invoice_issued_at);
  assert.deepStrictEqual(notices.map((n) => [n.cid, n.type, n.ref_type, n.ref_id, n.body_en]),
    [[3, 'invoice_issued', 'invoice', 20, 'The invoice for order TC20 is ready']]);
});
it('still being issued (开具中): not marked, polled again later', async () => {
  order({ id: 21, order_no: 'TC21', invoice_serial: 'SN-21' });
  nuonuo.queryReply = { ok: true, done: false };
  assert.deepStrictEqual(await F.finalizeInvoiceResult(21), { done: false });
  assert.strictEqual(row(21).invoice_status, null);
  assert.strictEqual(notices.length, 0);
});
it('the query fails: the reason is written, not marked issued', async () => {
  order({ id: 22, order_no: 'TC22', invoice_serial: 'SN-22' });
  nuonuo.queryReply = { ok: false, error: 'timeout' };
  assert.deepStrictEqual(await F.finalizeInvoiceResult(22), { done: false });
  assert.strictEqual(row(22).invoice_auto_error, 'timeout');
  assert.strictEqual(row(22).invoice_status, null);
});
it('nothing to finish: no serial, already issued, or no such order → done, Nuonuo not asked', async () => {
  order({ id: 23, order_no: 'TC23' });
  order({ id: 24, order_no: 'TC24', invoice_serial: 'SN-24', invoice_status: 'issued' });
  for (const id of [23, 24, 999]) assert.deepStrictEqual(await F.finalizeInvoiceResult(id), { done: true });
  assert.strictEqual(nuonuo.calls.length, 0);
});
it('Nuonuo account gone: not done, not asked', async () => {
  order({ id: 25, order_no: 'TC25', invoice_serial: 'SN-25' });
  enabled = false;
  assert.deepStrictEqual(await F.finalizeInvoiceResult(25), { done: false });
  assert.strictEqual(nuonuo.calls.length, 0);
});

// ══ 5. telling the customer about an order ═════════════════════════════════
section('5. an order notice reaches the order\'s customer, or nobody');

it('the notice carries the order as its reference, and what the builder returned', () => {
  order({ id: 30, order_no: 'TC30', customer_id: 8 });
  F.notifyForOrder(30, (o) => ({ type: 'x', title_en: o.order_no }));
  assert.deepStrictEqual(notices, [{ cid: 8, ref_type: 'order', ref_id: 30, type: 'x', title_en: 'TC30' }]);
});
it('an order with no customer (a till sale), or no such order: nobody is notified', () => {
  order({ id: 31, order_no: 'TC31', customer_id: null });
  F.notifyForOrder(31, () => ({ type: 'x' }));
  F.notifyForOrder(999, () => ({ type: 'x' }));
  assert.strictEqual(notices.length, 0);
});
it('a builder that returns nothing sends nothing', () => {
  order({ id: 32, order_no: 'TC32' });
  F.notifyForOrder(32, () => null);
  assert.strictEqual(notices.length, 0);
});

(async () => {
  for (const step of pending) await step();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
