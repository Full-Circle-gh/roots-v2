#!/usr/bin/env node
/**
 * The counter till's way back — and the house rules the control has to keep.
 *
 *   node scripts/test_till_back.js
 *
 * public/till.html is a separate PAGE, not one of Tacet Mobile's pushed
 * screens, so nothing in it draws the control every pushed screen has. An
 * operator who took the Counter till shortcut out of the phone arrived at a
 * screen with no route home — and in an installed app there is no browser
 * chrome to press Back in either. This is the check that the control exists,
 * that it is offered to exactly the operators who have a home, and that it
 * cannot throw a sale away by accident.
 *
 *   • OFFERED WHEN THERE IS A HOME. /api/backend/me answers `home` — '/m' for
 *     an operator whose role is not stock-app-locked, null for one whose whole
 *     product is the stock app. A door offered to the second kind would open
 *     onto a redirect back out of the backend.
 *   • IT NAMES WHERE IT GOES. The label is the operator's own home screen,
 *     titled with their role's name, exactly as the phone titles it.
 *   • AN EMPTY TILL LEAVES ON THE TAP. That is the case the control is for.
 *   • A BASKET IS A SALE IN PROGRESS. Nothing is saved until Confirm, so a
 *     till with lines in it asks first — and a stray tap on the scrim answers
 *     "stay", never "leave".
 *   • THE QUESTION IS ASKED IN THE PAGE. §1: a native dialog is uppercase
 *     system chrome the product cannot style, quiet or translate. The same
 *     rule scripts/test_stock_screens.js holds Quick Stock to.
 *
 * The page runs against a stub server rather than a session: the till
 * self-auths, so its own fetches ARE its input, and what is under test is the
 * shipped file byte-for-byte. The exit is a real navigation, so the server
 * answers '/m' too and the case says whether it expected to land there.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { findChrome } = require('./lib/m-probe');

function runChrome(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout || '')));
  });
}

const APP = path.join(__dirname, '..', 'public', 'till.html');
const src = fs.readFileSync(APP, 'utf8');

const problems = [];
function fail(msg) { problems.push(msg); }

// ── Static: the decision belongs in the page ─────────────────────────────
const JS = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
for (const d of ['window.confirm(', 'window.alert(', 'window.prompt(']) {
  if (JS.includes(d)) fail(`${d} — a decision belongs in the page, not in a system dialog`);
}

const STORES = [{ id: 1, code: 'TIANHE', name_en: 'Tianhe', name_cn: '天河', is_active: 1 }];
const PRODUCTS = [{ id: 7, sku: '2-450', name_en: 'Hazelnut Spread', name_cn: '榛子酱', sell_price: 98, category_en: 'Dry', category_cn: '干货' }];
// available_wechat is the field the till actually reads (it nets off the safety
// buffer and live holds); a row without it counts as an empty shelf, and an
// empty shelf refuses the tap that would add the line.
const STOCK = [{ product_id: 7, available_wechat: 5, physical_qty: 5 }];

const ME_HOME = { user: { id: 1, username: 'a', role: 'manager', caps: null,
  home: '/m', homeLabel: { en: 'Manager', cn: '经理' } } };
const ME_NO_HOME = { user: { id: 2, username: 'b', role: 'kitchen', caps: null, home: null, homeLabel: null } };

// [name, me, land?, body] — `land` is whether this case expects to end up on
// the home screen. Assertions are stashed before any navigation, so a case that
// leaves still reports what it proved on the way out.
const CASES = [
  ['a home to go back to', ME_HOME, false, `
    var b = document.getElementById('hd-back');
    ok('the control is there', !b.hidden);
    ok('it names where it goes', b.getAttribute('aria-label') === 'Manager');
    ok('it sits at the head of the row', document.querySelector('.t-head').firstElementChild === b);`],

  ['no home — the stock app is the whole product', ME_NO_HOME, false, `
    ok('no control', document.getElementById('hd-back').hidden);`],

  ['an empty till leaves on the tap', ME_HOME, true, `
    document.getElementById('hd-back').click();
    ok('no question asked', document.getElementById('leavepick').hidden);`],

  ['a basket asks first', ME_HOME, false, `
    document.querySelector('[data-add]').click();
    document.getElementById('hd-back').click();
    ok('the question is up', !document.getElementById('leavepick').hidden);
    ok('it is in the page', document.querySelector('#leavepick .ssheet') !== null);
    ok('and it says so', document.getElementById('leavepick').innerText.indexOf('Leave without saving?') > -1);`],

  ['a stray tap on the scrim stays', ME_HOME, false, `
    document.querySelector('[data-add]').click();
    document.getElementById('hd-back').click();
    document.getElementById('leavepick').click();
    ok('the question is gone', document.getElementById('leavepick').hidden);
    ok('the basket is intact', document.querySelectorAll('.ln').length === 1);`],

  ['Cancel stays too', ME_HOME, false, `
    document.querySelector('[data-add]').click();
    document.getElementById('hd-back').click();
    document.querySelector('[data-leave="stay"]').click();
    ok('the question is gone', document.getElementById('leavepick').hidden);
    ok('the basket is intact', document.querySelectorAll('.ln').length === 1);`],

  ['answering Leave goes', ME_HOME, true, `
    document.querySelector('[data-add]').click();
    document.getElementById('hd-back').click();
    document.querySelector('[data-leave="go"]').click();
    ok('the basket was there to lose', document.querySelectorAll('.ln').length === 1);`],

  ['the question is Chinese in Chinese', ME_HOME, false, `
    document.getElementById('hd-lang').click();
    document.querySelector('[data-add]').click();
    document.getElementById('hd-back').click();
    var t = document.getElementById('leavepick').innerText;
    ok('asked in Chinese', t.indexOf('未保存就离开') > -1);
    ok('answered in Chinese', t.indexOf('离开') > -1);`],
];

function stub(me) {
  return `<script>
    window.__me = ${JSON.stringify(me)};
    window.fetch = function (url) {
      var u = String(url), body = { success: true, data: [] };
      if (u.indexOf('/api/backend/me') === 0) body = window.__me;
      else if (/\\/stores\\/\\d+\\/stock/.test(u)) body = { success: true, data: ${JSON.stringify(STOCK)} };
      else if (u.indexOf('/api/retail-admin/stores') === 0) body = { success: true, data: ${JSON.stringify(STORES)} };
      else if (u.indexOf('/api/retail-admin/products') === 0) body = { success: true, data: ${JSON.stringify(PRODUCTS)} };
      else if (u.indexOf('/api/retail-admin/channel-status') === 0) body = { success: true, channels: [] };
      return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body); } });
    };
  </script>`;
}

// The verdict is stashed in sessionStorage before anything navigates, and the
// landing page reads it back — so a case that leaves still reports what it
// proved on the way out.
const harness = (body) => `<script>
  addEventListener('load', function () { setTimeout(function () {
    var out = [];
    function ok(n, v) { out.push([n, !!v]); }
    try { ${body} } catch (e) { out.push(['threw: ' + e.message, false]); }
    var bad = out.filter(function (r) { return !r[1]; }).map(function (r) { return r[0]; });
    var v = bad.length ? ('BAD ' + bad.join(' ¦ ')) : ('GOOD ' + out.length);
    try { sessionStorage.setItem('probe', v); } catch (e) {}
    document.title = v;
  }, 300); });
</script>`;

const LANDED = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>home'
  + '<script>document.title = "LANDED " + (sessionStorage.getItem("probe") || "no verdict");</script>'
  + '</body></html>';

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      if (p === '/m') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LANDED); return; }
      const m = p.match(/^\/case\/(\d+)$/);
      if (!m || !CASES[+m[1]]) { res.writeHead(404).end('no'); return; }
      const [, me, , body] = CASES[+m[1]];
      const html = src
        .replace(/<script>\n\(function \(\) \{/, stub(me) + '\n<script>\n(function () {')
        .replace('</body>', harness(body) + '</body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    });
    // unref: a keep-alive socket left behind by the last browser would hold the
    // runner open after the last case, with nothing on screen to say why.
    srv.listen(0, '127.0.0.1', () => { srv.unref(); resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }); });
  });
}

(async function run() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run this check.'); process.exit(0); }
  const { srv, base } = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'till-probe-'));
  let asserted = 0;

  // AWAITED, never execFileSync. The browser is fetching the page under test
  // from the server two lines up, in this same process — and a synchronous
  // spawn blocks the event loop that server answers on, so every case sat there
  // until its own timeout with an empty page. The other probes here can use the
  // sync form because they load a file:// URL and need nothing served.
  for (let i = 0; i < CASES.length; i++) {
    const [name, , land] = CASES[i];
    let out = '';
    try {
      out = await runChrome(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        // The page under test is served from this process on 127.0.0.1, and a
        // browser that honours the machine's proxy sends that request away to
        // it and waits forever. Background networking goes for the same reason:
        // nothing here needs the network, and everything it tries costs a
        // timeout.
        '--no-proxy-server', '--disable-background-networking', '--no-first-run',
        '--user-data-dir=' + profile, '--window-size=500,940',
        '--virtual-time-budget=2500', '--dump-dom', base + '/case/' + i]);
    } catch (e) { fail(`${name} — chrome failed: ${e.message}`); console.log(`  ✗ ${name}`); continue; }
    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    const landed = title.startsWith('LANDED');
    const verdict = title.replace(/^LANDED /, '');
    const bad = [];
    if (landed !== land) bad.push(land ? 'it never went home' : 'it left when it should have stayed');
    if (!verdict.startsWith('GOOD')) bad.push(...verdict.replace(/^BAD /, '').split(' ¦ '));
    if (!bad.length) {
      const n = Number(verdict.slice(5)) || 0; asserted += n + 1;
      console.log(`  ✓ ${name} — ${n + 1} checks`);
    } else {
      console.log(`  ✗ ${name}`);
      for (const b of bad) console.log(`      ${b}`);
      fail(name);
    }
  }

  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`\nok — ${asserted} counter-till assertions across ${CASES.length} cases.`);
})();
