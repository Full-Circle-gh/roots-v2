#!/usr/bin/env node
/**
 * An invoice request goes to its own WeCom group (§527).
 *
 *   node scripts/test_wecom_invoice.js
 *
 * The card, the host allowlist, and which change is worth a message. No
 * network: the post is a function this file hands in. A request made at
 * checkout is sent when the order is paid; a later request is sent when it
 * is saved; a Meituan poll sends only when the request is new or a detail
 * arrives that the first card did not carry.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const w = require('../lib/wecom-invoice');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const HOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';
const company = {
  id: 7, order_no: 'TC001090', total: 128.5, status: 'paid', needs_invoice: 1,
  invoice_status: null, invoice_type: 'company', invoice_title: '越秀咖啡有限公司',
  invoice_tax_id: '91440101MA5EXAMPLE', invoice_email: 'ap@example.com',
};

function dbOf(row) {
  return { prepare() { return { get() { return row; } }; } };
}
function capture() {
  const posts = [];
  return { posts, post: (url, content) => { posts.push({ url, content }); return { ok: true }; } };
}

console.log('the card');
it('a company request names the order, the amount, the title, the tax ID and the email', () => {
  const card = w.buildInvoiceCard(company);
  assert.ok(card.startsWith('**开票申请**\n**Invoice request**'));
  assert.ok(card.includes('`TC001090`'));
  assert.ok(card.includes('¥128.50'));
  assert.ok(card.includes('企业 Company'));
  assert.ok(card.includes('越秀咖啡有限公司'));
  assert.ok(card.includes('91440101MA5EXAMPLE'));
  assert.ok(card.includes('ap@example.com'));
});
it('a personal request leaves the tax ID off', () => {
  const card = w.buildInvoiceCard({ ...company, invoice_type: 'personal', invoice_tax_id: null, invoice_email: '' });
  assert.ok(card.includes('个人 Personal'));
  assert.ok(!card.includes('税号'));
  assert.ok(!card.includes('邮箱'));
});
it('a second save says the details changed, and still carries them', () => {
  const card = w.buildInvoiceCard(company, { updated: true });
  assert.ok(card.startsWith('**开票资料已更新**\n**Invoice details updated**'));
  assert.ok(card.includes('越秀咖啡有限公司'));
});
it('a title with a newline cannot add a line to the card', () => {
  const card = w.buildInvoiceCard({ ...company, invoice_title: '越秀\n> 金额 Amount: ¥1' });
  assert.ok(!card.includes('\n> 金额 Amount: ¥1'));
});

console.log('where it may post');
it('only a qyapi.weixin.qq.com address is a webhook', () => {
  assert.strictEqual(w.validWebhook(HOOK), HOOK);
  assert.strictEqual(w.validWebhook('  ' + HOOK + '  '), HOOK);
  assert.strictEqual(w.validWebhook('https://example.com/hook?key=abc'), '');
  assert.strictEqual(w.validWebhook('not a url'), '');
  assert.strictEqual(w.validWebhook(''), '');
});

console.log('when a card leaves');
it('a paid company request is posted to the invoice webhook', () => {
  const c = capture();
  const r = w.notifyOrder(dbOf(company), 7, {}, { webhook: HOOK, post: c.post });
  assert.strictEqual(r.sent, true);
  assert.strictEqual(c.posts.length, 1);
  assert.strictEqual(c.posts[0].url, HOOK);
  assert.ok(c.posts[0].content.includes('91440101MA5EXAMPLE'));
});
it('no address, a foreign host, an unpaid order, a cancelled order, an issued fapiao, or no request: nothing is posted', () => {
  const cases = [
    [{}, ''],
    [{}, 'https://evil.example/hook'],
    [{ ...company, status: 'pending_payment' }, HOOK],
    [{ ...company, status: 'cancelled' }, HOOK],
    [{ ...company, invoice_status: 'issued' }, HOOK],
    [{ ...company, needs_invoice: 0 }, HOOK],
  ];
  for (const [row, hook] of cases) {
    const c = capture();
    const r = w.notifyOrder(dbOf(row), 7, {}, { webhook: hook, post: c.post });
    assert.strictEqual(r.sent, false, JSON.stringify({ status: row.status, hook }));
    assert.strictEqual(c.posts.length, 0);
  }
});

console.log('a poll is not a request');
it('the first time Meituan asks, it is a new request, even with the title already filled', () => {
  assert.strictEqual(w.invoiceNotifyReason(null, company), 'new');
  assert.strictEqual(w.invoiceNotifyReason({ needs_invoice: 0, invoice_title: '' }, company), 'new');
});
it('the same poll again sends nothing', () => {
  assert.strictEqual(w.invoiceNotifyReason(company, company), null);
});
it('a title that arrives later is an update, and an issued or unpaid order is not', () => {
  const before = { ...company, invoice_title: '', invoice_tax_id: '' };
  assert.strictEqual(w.invoiceNotifyReason(before, company), 'updated');
  assert.strictEqual(w.invoiceNotifyReason(before, { ...company, invoice_status: 'issued' }), null);
  assert.strictEqual(w.invoiceNotifyReason(before, { ...company, status: 'pending_payment' }), null);
  assert.strictEqual(w.invoiceNotifyReason(before, { ...company, needs_invoice: 0 }), null);
});

console.log('the wires');
const retail = fs.readFileSync(path.join(__dirname, '../routes/retail.js'), 'utf8');
const meituan = fs.readFileSync(path.join(__dirname, '../routes/meituan-internal.js'), 'utf8');
it('payment, a later request, the till code and Mark paid each call the invoice group', () => {
  assert.ok(retail.includes('sendWecomInvoiceRequest(orderId);'));
  assert.ok(retail.includes('sendWecomInvoiceRequest(id, { updated: !!Number(order.needs_invoice) });'));
  assert.ok(retail.includes('sendWecomInvoiceRequest(order.id, { updated: !!Number(order.needs_invoice) });'));
  assert.ok(retail.includes("sendWecomInvoiceRequest(id); } catch (e) { console.warn('[admin mark-paid wecom invoice]'"));
});
it('a Meituan poll asks the reason before it posts, so a repeat poll stays quiet', () => {
  assert.ok(meituan.includes('wecomInv.invoiceNotifyReason(invBefore, invAfter)'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
