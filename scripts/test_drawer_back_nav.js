#!/usr/bin/env node
/**
 * test_drawer_back_nav.js — the way back between the order and customer drawers.
 *
 *   node scripts/test_drawer_back_nav.js
 *
 * THE FINDING (reported from the floor, 2026-09-09). Open an order, click the
 * Customer tile, and the customer drawer replaced it with no way back: the
 * operator had to close the drawer and find the order in the list again. The
 * OTHER direction had been complete since it was built — a customer's Recent
 * orders row leaves _ORDER_BACK_CUSTOMER behind, and the order drawer offers
 * "← Back to customer" plus a chevron, an Esc and a scrim click that all honour
 * it. Only the mirror was missing, and nothing in the suite noticed, because
 * nothing tested either half.
 *
 * So the rule this holds: THE TWO DRAWERS ARE SYMMETRIC. Whichever one you
 * arrived from, back returns you to it — on the same scroll position — and the
 * three dismissals (button, chevron, Esc/scrim) agree about where back is.
 *
 * Two things it is deliberately strict about, because both were live bugs of
 * this shape and neither shows up in a screenshot:
 *
 *   • BACK IS NOT ALWAYS BACK. A customer opened from the roster has no order
 *     behind it, and there the chevron has to be a plain close. A crumb left
 *     over from an earlier visit would send the operator to an order they never
 *     opened, which is worse than no button at all.
 *   • A RETURN IS NOT A DESCENT. customer → order → the order's Customer tile
 *     is the operator walking back. It hands off to cuBackToCustomer() rather
 *     than minting a second crumb, or the two drawers end up pointing at each
 *     other and "back" oscillates between them for ever.
 *
 * §2 drives the real functions, lifted whole into a sandbox: the state is five
 * module globals mutated across four functions in two files, which is exactly
 * the shape that reads correct and behaves wrong. cuOpenDetail() and openOrder()
 * are stubbed (they fetch), so §2's stub reproduces the ONE thing this depends
 * on — cuOpenDetail clears the crumb as it opens — and §0 checks the real
 * function against that contract rather than trusting the stub.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const CUST = fs.readFileSync(path.join(ROOT, 'public/retail-admin/08-customers.js'), 'utf8');
const ORD  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/04-orders.js'), 'utf8');

// ── §0 · the contract §2's stub stands in for ─────────────────────────────
section('0 · a fresh open is a fresh arrival');
{
  // orderGotoCustomer() sets the crumb AFTER calling cuOpenDetail(), relying on
  // cuOpenDetail clearing it first — so every other route into the drawer (a
  // roster row, a search hit, a marketing surface) leaves no crumb behind
  // without having to know the crumb exists. If that clear ever moves below the
  // first await, or goes away, the ordering silently inverts: the crumb set by
  // orderGotoCustomer would be wiped by its own callee a tick later.
  // Asked of the CODE, not the file text: both functions carry comments that
  // use the word "await" to explain this very ordering, and matching those
  // would cut the slice above the statement under test. The `[^:]` guard is the
  // house one — it keeps a '//' inside a URL from reading as a comment.
  const codeAfter = (src, from) => src.slice(from, src.indexOf('\n}\n', from))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const headOf = (src, sig) => {
    const from = src.indexOf(sig);
    const code = codeAfter(src, from);
    const firstAwait = code.indexOf('await');
    return firstAwait < 0 ? code : code.slice(0, firstAwait);
  };
  yes(CUST.indexOf('async function cuOpenDetail(') > 0, 'cuOpenDetail exists');
  yes(/_CUSTOMER_BACK_ORDER\s*=\s*null/.test(headOf(CUST, 'async function cuOpenDetail(')),
    'cuOpenDetail clears _CUSTOMER_BACK_ORDER before it awaits anything');
  yes(/_ORDER_BACK_CUSTOMER\s*=\s*null/.test(headOf(ORD, 'async function openOrder(')),
    'and openOrder does the same with _ORDER_BACK_CUSTOMER — the two match');
}

// ── §1 · the wiring, both drawers ─────────────────────────────────────────
section('1 · every dismissal on a drawer agrees about where back is');
{
  // The customer drawer's three doors. The ✕ is NOT one of them: a cross means
  // close, and an operator who wants the list should get the list.
  const cuDrawerAt = HTML.indexOf('id="cu-drawer"');
  yes(cuDrawerAt > 0, 'the customer drawer is in the page');
  const cuAside = HTML.slice(cuDrawerAt, HTML.indexOf('</aside>', cuDrawerAt));
  yes(/class="drawer-back"[^>]*onclick="cuDrawerBack\(\)"/.test(cuAside),
    'the customer drawer chevron routes through cuDrawerBack()');
  yes(/class="drawer-close"[^>]*onclick="closeDrawer\('#cu-drawer'\)"/.test(cuAside),
    "and its ✕ stays a plain close — a cross is not a back button");
  yes(/id="cu-scrim"[^>]*onclick="cuDrawerBack\(\)"/.test(HTML),
    'a click on the customer scrim dismisses the same way (mouse parity with Esc)');

  // The mirror, which was already right. Asserted here so a later change can't
  // "tidy" one side back to a bare close and leave the pair asymmetric again.
  const ordDrawerAt = HTML.indexOf('id="order-drawer"');
  const ordAside = HTML.slice(ordDrawerAt, HTML.indexOf('</aside>', ordDrawerAt));
  yes(/class="drawer-back"[^>]*onclick="orderDrawerBack\(\)"/.test(ordAside),
    'the order drawer chevron routes through orderDrawerBack()');
  yes(/id="order-scrim"[^>]*onclick="orderDrawerBack\(\)"/.test(HTML),
    'and so does its scrim');

  // Esc and outside-click share one dismissal path, so both drawers have to be
  // named in it — the order case shipped, the customer case is the fix.
  const dismiss = ORD.slice(ORD.indexOf('function dismissTopDrawer('),
    ORD.indexOf('\n}', ORD.indexOf('function dismissTopDrawer(')));
  yes(/order-drawer'\s*&&\s*_ORDER_BACK_CUSTOMER/.test(dismiss),
    'dismissTopDrawer steps an order back to its customer');
  yes(/cu-drawer'\s*&&\s*_CUSTOMER_BACK_ORDER/.test(dismiss),
    'and steps a customer back to its order');
}

// ── §2 · driven: the crumb, the scroll, and the two cases back is not back ─
section('2 · the round trip, against the real functions');
{
  const from = CUST.indexOf("// Jump from a customer's Recent-orders row");
  const to = CUST.indexOf('// Close the drawer and clear state');
  yes(from > 0 && to > from, 'the four navigation functions lifted out of 08-customers.js');
  const src = CUST.slice(from, to);
  for (const fn of ['cuGotoOrder', 'cuBackToCustomer', 'orderDrawerBack',
                    'orderGotoCustomer', 'cuBackToOrder', 'cuDrawerBack']) {
    yes(new RegExp('function ' + fn + '\\(').test(src), `  ${fn} is in the slice`);
  }

  // One context per case: this is module state, and a case that inherited the
  // last one's crumb would pass for the wrong reason.
  const mk = (state = {}) => {
    const log = [];
    const sandbox = {
      console,
      CU_CURRENT: state.CU_CURRENT || null,
      _OPEN_ORDER: state._OPEN_ORDER || null,
      _ORDER_BACK_CUSTOMER: state._ORDER_BACK_CUSTOMER || null,
      _ORDER_BACK_CUSTOMER_SCROLL: 0,
      _CUSTOMER_BACK_ORDER: state._CUSTOMER_BACK_ORDER || null,
      _CUSTOMER_BACK_ORDER_SCROLL: state._CUSTOMER_BACK_ORDER_SCROLL || 0,
      log,
      closeDrawer: (sel) => log.push(['closeDrawer', sel]),
      openOrder: (id, opts) => log.push(['openOrder', id, opts || null]),
      // Mirrors the real cuOpenDetail's first statement, and only that — see §0,
      // which holds the real one to it.
      cuOpenDetail: function (id, restore) {
        sandbox._CUSTOMER_BACK_ORDER = null;
        log.push(['cuOpenDetail', id, restore || null]);
      },
      document: {
        getElementById: (id) => (id === 'order-detail-mount'
          ? { scrollTop: state.orderScroll || 0 } : null),
        querySelector: (sel) => (sel === '#cu-drawer .drawer-body'
          ? { scrollTop: state.customerScroll || 0 } : null),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'cu-nav.js' });
    return sandbox;
  };

  // ── the case from the floor: an order opened from the list, then its
  //    Customer tile. Nothing was remembered here before.
  {
    const s = mk({ _OPEN_ORDER: { id: 632 }, orderScroll: 480 });
    s.orderGotoCustomer(1703);
    is(JSON.stringify(s.log[0]), JSON.stringify(['closeDrawer', '#order-drawer']),
      'the order drawer closes first (the two share a z-index and a position)');
    is(JSON.stringify(s.log[1]), JSON.stringify(['cuOpenDetail', 1703, null]),
      'the customer opens on top of the list');
    is(s._CUSTOMER_BACK_ORDER, 632, 'and the order is remembered — the crumb that was missing');
    is(s._CUSTOMER_BACK_ORDER_SCROLL, 480, 'along with where in the order we were standing');

    // ...and back.
    s.log.length = 0;
    s.cuDrawerBack();
    is(JSON.stringify(s.log[0]), JSON.stringify(['closeDrawer', '#cu-drawer']),
      'back closes the customer drawer');
    is(JSON.stringify(s.log[1]), JSON.stringify(['openOrder', 632, { scrollTop: 480 }]),
      'and re-opens THAT order on the row it was left on — not the top of it');
  }

  // ── a customer opened from the roster has nothing behind it.
  {
    const s = mk();
    s.cuDrawerBack();
    is(s.log.length, 1, 'a customer opened from the roster dismisses in one move');
    is(JSON.stringify(s.log[0]), JSON.stringify(['closeDrawer', '#cu-drawer']),
      'and that move is a plain close — back is only back when there is something behind');
    s.log.length = 0;
    s.cuBackToOrder();
    is(s.log.length, 0, 'cuBackToOrder with no crumb does nothing rather than opening order 0');
  }

  // ── a return, not a descent: customer → order → Customer tile.
  {
    const s = mk({ _OPEN_ORDER: { id: 632 }, _ORDER_BACK_CUSTOMER: 1703,
                   _ORDER_BACK_CUSTOMER_SCROLL: 0, orderScroll: 480 });
    s._ORDER_BACK_CUSTOMER_SCROLL = 210;
    s.orderGotoCustomer(1703);
    is(JSON.stringify(s.log[0]), JSON.stringify(['closeDrawer', '#order-drawer']),
      'walking back closes the order drawer');
    is(JSON.stringify(s.log[1]),
      JSON.stringify(['cuOpenDetail', 1703, { scrollTop: 210, openRecent: true }]),
      'and returns through cuBackToCustomer — Recent orders re-opened, scroll restored');
    is(s._CUSTOMER_BACK_ORDER, null,
      'no second crumb is minted, so the two drawers cannot point at each other');
  }

  // ── the same tile, a DIFFERENT customer (an order reassigned while open):
  //    that is a descent again, and it gets a crumb.
  {
    const s = mk({ _OPEN_ORDER: { id: 632 }, _ORDER_BACK_CUSTOMER: 1703, orderScroll: 96 });
    s.orderGotoCustomer(1999);
    is(JSON.stringify(s.log[1]), JSON.stringify(['cuOpenDetail', 1999, null]),
      'a tile naming someone else opens that someone else');
    is(s._CUSTOMER_BACK_ORDER, 632, 'and leaves a crumb back to the order');
  }

  // ── the mirror still works. It is the half that already shipped.
  {
    const s = mk({ CU_CURRENT: { customer: { id: 1703 } }, customerScroll: 310 });
    s.cuGotoOrder(632);
    is(JSON.stringify(s.log[1]), JSON.stringify(['openOrder', 632, null]),
      'a Recent-orders row still opens the order');
    is(s._ORDER_BACK_CUSTOMER, 1703, 'and still remembers the customer');
    s.log.length = 0;
    s.orderDrawerBack();
    is(JSON.stringify(s.log[1]),
      JSON.stringify(['cuOpenDetail', 1703, { scrollTop: 310, openRecent: true }]),
      'and its chevron still returns to them');
  }
}

// ── §3 · the control the operator actually sees ───────────────────────────
section('3 · the button, where it can be reached');
{
  const at = CUST.indexOf('const backToOrder = _CUSTOMER_BACK_ORDER');
  yes(at > 0, 'the button is gated on the crumb — no crumb, no control');
  const btn = CUST.slice(at, CUST.indexOf(": '';", at));
  yes(/onclick="cuBackToOrder\(\)"/.test(btn), 'it calls cuBackToOrder()');
  yes(btn.includes('Back to order · 返回订单'), 'it is labelled in both languages');
  // The label collapses to ONE language at render (the i18n engine), so an
  // arrow typed into the English half disappears under a Chinese UI. Drawn.
  yes(/<svg[^>]*>[\s\S]*<polyline/.test(btn) && !/←/.test(btn),
    'and the arrow is drawn, not typed into the English half where zh would drop it');

  // In the PINNED row, not the scrolling body: the customer drawer runs long
  // (stats, ledgers, addresses, a chart) and a back button that scrolls away
  // is the bug again for anyone who read to the bottom.
  const actions = CUST.slice(CUST.indexOf("$('#cu-drawer-actions').innerHTML"),
    CUST.indexOf('cuMessageCustomer()'));
  yes(actions.includes('${backToOrder}'),
    'it rides in the pinned action row, so a scroll to the foot cannot lose it');

  // On phones the chevron in the header IS this control, and a fourth button
  // wraps that row onto a second line.
  const hidden = HTML.indexOf('#cu-drawer .cu-back-order { display: none; }');
  yes(hidden > 0, 'phones hide the in-row twin');
  const mediaAt = HTML.lastIndexOf('@media', hidden);
  yes(/max-width:\s*720px/.test(HTML.slice(mediaAt, HTML.indexOf('{', mediaAt) + 1)),
    'and they hide it in the phone breakpoint — where the header chevron carries back');
}

// ── §4 · openOrder can be asked to land somewhere ─────────────────────────
section('4 · the scroll restore the return depends on');
{
  const at = ORD.indexOf('async function openOrder(');
  const body = ORD.slice(at, ORD.indexOf('\n}\n', at));
  yes(/opts\.scrollTop/.test(body) && /mount\.scrollTop\s*=\s*opts\.scrollTop/.test(body),
    'openOrder honours opts.scrollTop, which is what makes the return land where it left');
  yes(/requestAnimationFrame\(\(\)\s*=>\s*\{\s*mount\.scrollTop/.test(body),
    'set after a frame, so the mount has its scroll height before the offset is applied');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
