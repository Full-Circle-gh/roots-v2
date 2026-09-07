#!/usr/bin/env node
// A supplier whose name carries a quote could not be opened on the Invoices tab.
//
// THE DEFECT. The group row's onclick built its argument as
//   esc(g.supplier).replace(/'/g, "\\'")
// — html-escaping FIRST, JS-escaping SECOND. esc() already turns a literal '
// into the entity &#39;, so by the time .replace(/'/g, ...) ran there was no
// bare ' left for it to find; the replace was a no-op. The browser then
// parsed the onclick="...('${key}')" attribute, HTML-DECODED it (turning
// &#39; straight back into a bare '), and handed the result to the JS parser
// as the onclick body. A supplier name with an apostrophe — an English store
// name, a name typed with a curly quote normalised to straight — broke out
// of the single-quoted JS string literal, threw a SyntaxError on click, and
// the row never opened. Reported from the floor as "some suppliers are
// unable to open the detailed information."
//
// THE FIX. JS-escape (backslash, then quote) BEFORE html-escaping, so the
// quote survives as a literal ' for esc() to turn into &#39;, which the
// browser's attribute decode turns back into the \' the JS string needs.
//
// This test has two legs: (1) the fixed ORDER is actually in the source —
// esc() wrapping the JS-escape, not the other way round — via source-text
// assertions, the pattern the rest of this suite family already uses; (2)
// that ORDER, run for real against the real escapeHtml, survives the exact
// round trip a browser performs (encode into the attribute → decode out of
// it → parse as JS) for names carrying every character either escaping pass
// treats specially, and hands the click back the name that was clicked.
//
// USAGE   node scripts/test_invoice_supplier_apostrophe.js
// EXIT    0 every assertion held · 1 an assertion failed

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, msg, got) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (got === undefined ? '' : ' — got ' + JSON.stringify(got))); }
};

// escapeHtml, exactly as 01-core.js defines it — what esc() resolves to in
// every part of the app, 16-purchasing.js and app.html included.
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
const escMatch = CORE_SRC.match(/function escapeHtml\(s\) \{[^\n]*\}/);
if (!escMatch) { console.error('escapeHtml not found in 01-core.js — source moved'); process.exit(1); }
// eslint-disable-next-line no-eval
const escapeHtml = eval('(' + escMatch[0].replace('function escapeHtml', 'function') + ')');

// A single-pass decode, matching how a browser resolves entities in an
// attribute value in one sweep rather than recursively.
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function htmlDecodeAttr(s) { return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITY[e]); }

// Every character either escaping pass treats specially, in one name.
const TRICKY_NAMES = [
  `O'Brien's Bakery`,
  `Tony "Slice" Pizza`,
  `A & B Trading <Ltd>`,
  `back\\slash Co`,
  `蜜丹儿's 旗舰店`,
];

// The fixed shape: JS-escape (backslash, then quote) INSIDE esc(), so esc()
// is the last thing to touch the string before it lands in the template —
// mirrors the order asserted against the source below.
function buildKey(name) {
  return escapeHtml(name.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

function checkRoundTrip(label, toggleFnName) {
  console.log(`\n${label}`);
  for (const name of TRICKY_NAMES) {
    const key = buildKey(name);
    // Reproduce exactly what the template writes, then what the browser
    // does with it: parse the attribute (HTML-decode), execute the JS body.
    const attrHtml = `onclick="${toggleFnName}('${key}')"`;
    const decoded = htmlDecodeAttr(attrHtml).replace(/^onclick="|"$/g, '');

    let captured, err = null;
    try {
      // eslint-disable-next-line no-new-func
      const run = new Function(toggleFnName, `${decoded};`);
      run((sup) => { captured = sup; });
    } catch (e) { err = e; }

    ok(!err, `the decoded onclick is valid JS for ${JSON.stringify(name)}`, err && err.message);
    ok(!err && captured === name, `the row that opens is the row that was clicked — ${JSON.stringify(name)}`, captured);
  }
}

console.log('1. retail-admin/16-purchasing.js — the Invoices tab group row');
{
  const UI_SRC = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '16-purchasing.js'), 'utf8');
  ok(UI_SRC.includes(`esc(g.supplier.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"))`),
    'the group row escapes the JS quote before esc(), not after');
  ok(!/esc\(g\.supplier\)\.replace\(\/'\/g/.test(UI_SRC),
    'the old order — esc() first, quote-replace second — is gone (it never found a quote to replace)');
}
checkRoundTrip('   round trip against the real escapeHtml', 'puInvToggleGroup');

console.log("\n2. app.html — Finance's own copy of the same group row");
{
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  ok(APP_SRC.includes(`esc(g.supplier.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"))`),
    'the group row escapes the JS quote before esc(), not after');
  ok(!/esc\(g\.supplier\)\.replace\(\/'\/g/.test(APP_SRC),
    'the old order — esc() first, quote-replace second — is gone (it never found a quote to replace)');
}
checkRoundTrip('   round trip against the real escapeHtml', '_finToggleInvSupplier');

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
