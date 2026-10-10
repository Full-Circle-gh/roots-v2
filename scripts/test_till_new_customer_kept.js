#!/usr/bin/env node
/**
 * The till's "add a new customer" fields survive the order poll.
 *
 *   node scripts/test_till_new_customer_kept.js
 *
 * §428 put a name and a phone field under "No matches" in the customer search.
 * render() runs every fifteen seconds on the order poll and again on every QR
 * order that lands, and each run redrew those two fields — so a cashier halfway
 * through a new customer's name had the keyboard go down and the name and phone
 * reset to what the search said. renderCustResults now draws them once per
 * search (and language) and leaves them alone after that.
 *
 * No browser. renderCustResults is cut out of public/till.html and run against a
 * box that counts how often its markup is replaced — the technique
 * scripts/test_till_knock.js uses on the same file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'till.html'), 'utf8');
const problems = [];
let checks = 0;
function ok(name, v) { checks++; if (!v) problems.push(name); }

function fn(name) {
  const re = new RegExp('\\n  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n');
  const m = src.match(re);
  if (!m) throw new Error('till.html has no function ' + name + '()');
  return m[0];
}

// The results box: an attribute bag, and a count of every time its markup is
// replaced — a replacement is what threw the half-typed fields away.
const box = {
  attrs: {}, writes: 0, html: '',
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
  set innerHTML(v) { this.writes++; this.html = v; },
  get innerHTML() { return this.html; },
};
const ctx = {
  S: { custRows: [], custQ: 'Li Wei' },
  _lang: 'en',
  document: { getElementById: (id) => (id === 'cust-rows' ? box : null) },
  esc: (s) => String(s), T: (k) => k, money: (n) => String(n),
};
vm.createContext(ctx);
vm.runInContext(fn('renderCustResults'), ctx);
const draw = () => vm.runInContext('renderCustResults()', ctx);

draw();
ok('nothing found: the new-customer fields are drawn', box.writes === 1 && box.html.indexOf('cnew-name') > -1);
draw(); draw(); draw();
ok('the poll repainting three more times leaves them alone', box.writes === 1);

ctx.S.custQ = '138 0000 1234'; draw();
ok('a different search draws them again, phone pre-filled', box.writes === 2 && box.html.indexOf('value="138 0000 1234"') > -1);
draw();
ok('...and then leaves those alone too', box.writes === 2);

ctx._lang = 'cn'; draw();
ok('a change of language draws them again, in that language', box.writes === 3);

ctx.S.custRows = [{ id: 9, nickname: 'Li Wei', phone: '138', points: 0, balance: 0 }]; draw();
ok('a search that finds somebody shows the rows', box.writes === 4 && box.html.indexOf('data-id="9"') > -1);
ctx.S.custRows = []; draw();
ok('and back to nothing found draws the fields fresh, not a stale skip', box.writes === 5 && box.html.indexOf('cnew-name') > -1);

ctx.S.custRows = null; draw();
ctx.S.custRows = []; draw();
ok('a cleared search, then nothing found, draws them fresh', box.writes === 7 && box.html.indexOf('cnew-name') > -1);

if (problems.length) {
  console.error(`${problems.length} of ${checks} failed:`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log(`ok — ${checks} till new-customer checks.`);
