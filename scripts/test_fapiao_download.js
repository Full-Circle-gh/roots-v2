#!/usr/bin/env node
/**
 * A fapiao can be saved, not only viewed.
 *
 *   node scripts/test_fapiao_download.js
 *
 * View keeps the PDF inline. Download asks GET /api/retail/media/:id?download=1
 * for the same bytes as a file, with a filename the header cannot break out of.
 * The link builder is copied into the pages that cannot require the lib; the
 * copies have to stay the same function.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { fapiaoDownloadHref, wantsDownload, mediaContentDisposition } = require(path.join(ROOT, 'lib', 'media-disposition'));

const FN = 'function fapiaoDownloadHref(url) {';
function extract(src, file) {
  const start = src.indexOf(FN);
  assert.ok(start >= 0, 'missing ' + FN + ' in ' + file);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail('unclosed function in ' + file);
}

const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'media-disposition.js'), 'utf8');
const canonical = extract(libSrc, 'lib');
const copies = [
  'public/retail-admin/07-content-billing.js',
  'public/shop.html',
  'public/m.html',
  'miniapp/utils/fapiao-file.js',
];
for (const rel of copies) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.strictEqual(extract(src, rel), canonical, rel + ' drifted from lib/media-disposition.js');
}

assert.strictEqual(fapiaoDownloadHref('/api/retail/media/77'), '/api/retail/media/77?download=1');
assert.strictEqual(fapiaoDownloadHref('/api/retail/media/77?download=1'), '/api/retail/media/77?download=1');
assert.strictEqual(fapiaoDownloadHref('/api/retail/media/77?x=1'), '/api/retail/media/77?x=1&download=1');
assert.strictEqual(fapiaoDownloadHref('/api/retail/media/77#page'), '/api/retail/media/77?download=1#page');
assert.strictEqual(
  fapiaoDownloadHref('https://shop.example/api/retail/media/3'),
  'https://shop.example/api/retail/media/3?download=1'
);
assert.strictEqual(fapiaoDownloadHref('https://nnfp.example/inv.pdf'), 'https://nnfp.example/inv.pdf');
assert.strictEqual(fapiaoDownloadHref('/api/retail/media/77/sec-status'), '/api/retail/media/77/sec-status');
assert.strictEqual(fapiaoDownloadHref(''), '');

assert.strictEqual(wantsDownload({ download: '1' }), true);
assert.strictEqual(wantsDownload({ download: 'true' }), true);
assert.strictEqual(wantsDownload({}), false);
assert.strictEqual(wantsDownload({ download: '0' }), false);

assert.strictEqual(
  mediaContentDisposition('application/pdf', 'fapiao.pdf'),
  `attachment; filename="fapiao.pdf"; filename*=UTF-8''fapiao.pdf`
);
assert.strictEqual(
  mediaContentDisposition('image/jpeg', null),
  `attachment; filename="fapiao.jpg"; filename*=UTF-8''fapiao.jpg`
);
const hostile = mediaContentDisposition('application/pdf', 'a"\r\nSet-Cookie: x.pdf');
assert.ok(!/[\r\n]/.test(hostile), hostile);
assert.ok(hostile.startsWith('attachment; filename="'), hostile);
assert.ok(hostile.includes("filename*=UTF-8''"), hostile);

const retail = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
assert.ok(retail.includes('SELECT mime_type, filename, data FROM retail_media WHERE id = ?'));
assert.ok(retail.includes("asFile ? mediaContentDisposition(row.mime_type, row.filename) : 'inline'"));

const bill = fs.readFileSync(path.join(ROOT, 'public/retail-admin/07-content-billing.js'), 'utf8');
assert.ok(bill.includes("invT('Download', '下载')"));
assert.ok(bill.includes('fapiaoDownloadHref(o.invoice_file_url)'));
assert.ok(bill.includes("invT('View fapiao', '查看发票')"));
{
  const vm = require('vm');
  const start = bill.indexOf('function invoiceIsCompany');
  const end = bill.indexOf('async function markInvoiceIssued');
  assert.ok(start > 0 && end > start);
  const ctx = {
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    invT: (en) => en,
    window: {},
    acMoney: (n) => String(n),
  };
  vm.createContext(ctx);
  vm.runInContext(bill.slice(start, end), ctx);
  const html = ctx.renderInvoiceBlock({
    id: 9,
    invoice_status: 'issued',
    invoice_type: 'company',
    invoice_title: '以装国际贸易（上海）有限公司',
    invoice_tax_id: '91310115779325019N',
    invoice_email: 'sinai@fox-china.com.cn',
    invoice_file_url: '/api/retail/media/41',
    invoice_issued_at: '2026-11-04',
  });
  assert.ok(html.includes('View fapiao') && html.includes('>Download<'));
  assert.ok(html.includes('href="/api/retail/media/41"') && html.includes('target="_blank"'));
  assert.ok(html.includes('href="/api/retail/media/41?download=1" download'));
  const external = ctx.renderInvoiceBlock({
    id: 9, invoice_status: 'issued', invoice_type: 'personal',
    invoice_file_url: 'https://nnfp.example/view/abc',
  });
  assert.ok(external.includes('href="https://nnfp.example/view/abc" download'));
  assert.ok(!external.includes('nnfp.example/view/abc?download=1'));
}

const shop = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
assert.ok(shop.includes("fapiaoDownloadHref(file)") && shop.includes("cn?'下载':'Download'"));

const vocab = fs.readFileSync(path.join(ROOT, 'docs', 'tacet-delivery-vocabulary.md'), 'utf8');
assert.ok(vocab.includes('Download · 下载'));
assert.ok(vocab.includes('v1.404'));

const inv = fs.readFileSync(path.join(ROOT, 'miniapp/pages/invoices/invoices.js'), 'utf8');
assert.ok(inv.includes('onDownloadInvoice'));
assert.ok(!inv.includes('showMenu'), 'the viewer menu lives in the shared opener, not a view-only openDocument');
assert.ok(inv.includes('openCustomerFapiao'));
const opener = fs.readFileSync(path.join(ROOT, 'miniapp/utils/fapiao-file.js'), 'utf8');
assert.ok(opener.includes('showMenu: true'));

// The header the media route sets, over HTTP, for one stored PDF.
const http = require('http');
const express = require('express');
const app = express();
const pdf = Buffer.from('%PDF-1.1\n');
app.get('/api/retail/media/:id', (req, res) => {
  const asFile = wantsDownload(req.query);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', asFile ? mediaContentDisposition('application/pdf', 'fapiao.pdf') : 'inline');
  res.end(pdf);
});
const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  Promise.all([get('/api/retail/media/7'), get('/api/retail/media/7?download=1')]).then(([view, save]) => {
    assert.strictEqual(view.headers['content-disposition'], 'inline');
    assert.strictEqual(save.headers['content-disposition'], `attachment; filename="fapiao.pdf"; filename*=UTF-8''fapiao.pdf`);
    assert.strictEqual(view.headers['content-type'], 'application/pdf');
    assert.ok(save.body.equals(pdf) && view.body.equals(pdf));
    server.close();
    console.log('fapiao download: ok');
    console.log('  view   Content-Disposition: ' + view.headers['content-disposition']);
    console.log('  save   Content-Disposition: ' + save.headers['content-disposition']);
  }).catch((e) => { server.close(); console.error(e); process.exit(1); });
});
