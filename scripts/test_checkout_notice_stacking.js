#!/usr/bin/env node
/**
 * The four checkout notices queue; they neither stack nor stand each other down.
 *
 *   node scripts/test_checkout_notice_stacking.js
 *
 * WHAT THE QUOTE CAN RETURN. `POST /api/retail/quote` computes four
 * customer-facing notices — batch_notice, preorder_notice, local_fresh_notice
 * and store_move_notice — and both clients render each as a persistent banner
 * plus a modal that auto-opens ONCE per checkout visit.
 *
 * WHY THIS SUITE EXISTS, AND WHAT CHANGED UNDER IT. It opened on the first half
 * of this problem: two of the four opened without asking whether a modal was
 * already up, so a basket that raised two dropped the second overlay on top of
 * the first and buried it. The fix then was to stand down — open only onto an
 * empty screen and leave the rest to their banner. That fixed the burying and
 * left the real complaint: Ash, on a cart holding one pre-order item and one
 * fresh-batch item, "there should be 2 pop up one after another however now
 * there is only one pop up coming up". A banner a customer taps past is not a
 * notice they read. So the notices now QUEUE: the first opens, and each close
 * pulls up the next one that still applies.
 *
 * AND THEY GENUINELY CO-OCCUR. Only preorder_notice and local_fresh_notice are
 * mutually exclusive — routes/retail.js says so at the call site, because their
 * address gates are complements. batch_notice is computed independently of all
 * three, so a cart holding a batch-made dish AND a sold-out backorder extra
 * raises two, which is exactly the cart the complaint came from.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE SHAPE RATHER THAN A RENDER. shop.html is
 * a page and routes/retail.js pulls in better-sqlite3, so neither can be
 * required here; both are read as source. That is the split
 * test_store_move_notice.js and test_recipient_phone.js already use for this
 * same page, for the same reason.
 *
 * THE RULE THIS HOLDS: every auto-open goes into the queue rather than opening
 * itself, and every close pulls the next one up. A fifth notice that joins the
 * page and forgets either half is what this is here to catch — forget the first
 * and it buries whatever is open; forget the second and it becomes a stopper,
 * silently swallowing every notice queued behind it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const webSrc = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
const miniSrc = fs.readFileSync(path.join(ROOT, 'miniapp/pages/checkout/checkout.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');

let failed = 0;
function check(name, fn) {
  let ok = false;
  try { ok = !!fn(); } catch (e) { ok = false; }
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) failed++;
}

console.log('\nThe checkout notices, and the queue they all go through');

// ONE ENTRY PER NOTICE. Named so a failure says which notice lost its place in
// the queue rather than "one of four".
const NOTICES = [
  { key: 'batch',      flag: 'batchSeen',      popup: 'coBatchPopup',      overlay: '#cobPop',  mini: 'batchNotice' },
  { key: 'preorder',   flag: 'preorderSeen',   popup: 'coPreorderPopup',   overlay: '#copoPop', mini: 'preorderNotice' },
  { key: 'localFresh', flag: 'localFreshSeen', popup: 'coLocalFreshPopup', overlay: '#colfPop', mini: 'localFreshNotice' },
  { key: 'storeMove',  flag: 'storeMoveSeen',  popup: 'coStoreMovePopup',  overlay: '#cosmPop', mini: 'storeMoveNotice' },
];

for (const n of NOTICES) {
  check(`${n.key}: the auto-open hands the modal to the queue`, () => {
    const re = new RegExp(`if\\(!co\\.${n.flag}\\)\\{ co\\.${n.flag}=true; coQueueNotice\\(${n.popup}\\); \\}`);
    return re.test(webSrc);
  });
  // Queueing is half of it; the queue only starts, and only moves on, when it
  // can see what is open — and an overlay missing from that list is invisible
  // to it, so the next notice lands on top of this one after all.
  check(`${n.key}: …and the open-check knows this overlay`, () => {
    const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
    return !!m && m[0].includes(n.overlay);
  });
  // The banner is the way back in for a notice the customer closed, and the
  // only way in for one the queue dropped because its quote had moved on.
  check(`${n.key}: …and the modal stays reachable from the banner`, () =>
    new RegExp(`addEventListener\\('click',${n.popup}\\)`).test(webSrc));
}

check('the open-check lists exactly the four overlays, and no more', () => {
  const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
  if (!m) return false;
  const ids = (m[0].match(/#\w+Pop/g) || []).sort();
  return ids.length === 4 && ids.join(',') === ['#cobPop', '#copoPop', '#colfPop', '#cosmPop'].sort().join(',');
});

// An overlay that is present but hidden must not count as open, or the FIRST
// notice dismissed would leave the queue believing a modal is still up and
// nothing would ever open again.
check('a dismissed overlay does not keep counting as open', () => {
  const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
  return !!m && /!el\.hidden/.test(m[0]);
});

// THE QUEUE ITSELF, BOTH HALVES. Opening only onto an empty screen is what
// stops the burying; advancing on close is what stops the standing-down from
// becoming silence.
check('web: the queue opens the next notice only onto an empty screen', () => {
  const m = webSrc.match(/function coQueueNotice\(fn\)\{[\s\S]*?\n\}/);
  return !!m && /co\.noticeQueue\.push\(fn\)/.test(m[0]) && /if\(!coNoticePopupOpen\(\)\) coNoticeNext\(\)/.test(m[0]);
});

// A renderer whose notice the latest quote dropped opens nothing. If the queue
// stopped on it, every notice behind it would be swallowed, so it walks on.
check('web: a notice that no longer applies does not stall the queue', () => {
  const m = webSrc.match(/function coNoticeNext\(\)\{[\s\S]*?\n\}/);
  return !!m && /while\(co\.noticeQueue\.length\)/.test(m[0]) && /if\(coNoticePopupOpen\(\)\) return/.test(m[0]);
});

check('web: every notice modal advances the queue when it closes', () => {
  const closes = webSrc.match(/const close=\(\)=>\{ov\.hidden=true;coNoticeClosed\(\);\};/g) || [];
  return closes.length === NOTICES.length;
});

// THE SERVER'S OWN WORD ON CO-OCCURRENCE. If batch and preorder ever became
// mutually exclusive the queue would be harmless; the point is that they are
// NOT, and only one pair is.
check('the server marks only preorder/local_fresh as complements', () =>
  /mutually exclusive with\s*\n\s*\/\/ preorder_notice by construction/.test(routeSrc));

check('batch_notice and preorder_notice are computed independently', () => {
  const at = routeSrc.indexOf('batch_notice: computeBatchNotice');
  if (at < 0) return false;
  const win = routeSrc.slice(at, at + 900);
  return /preorder_notice: computePreorderNotice/.test(win)
    && !/batch_notice[\s\S]{0,200}\?\s*null/.test(win);
});

// THE TWO CLIENTS AGREE. The same cart has to behave the same way in the mini
// app and in the web shop; a queue on one side and a stand-down on the other is
// the drift this pair of checks exists to catch.
check('the mini app queues its four notices too', () =>
  /enqueueNotices\(keys\)/.test(miniSrc)
  && NOTICES.every(n => new RegExp(`due\\.push\\('${n.key}'\\)`).test(miniSrc)));

check('the mini app opens the next notice only onto an empty screen', () => {
  const m = miniSrc.match(/enqueueNotices\(keys\) \{[\s\S]*?\n  \},/);
  return !!m && /if \(!this\.anyNoticePopupOpen\(\)\) this\.showNextNotice\(\);/.test(m[0]);
});

check('the mini app skips a notice its latest quote dropped', () => {
  const m = miniSrc.match(/showNextNotice\(\) \{[\s\S]*?\n  \},/);
  return !!m && /while \(q\.length\)/.test(m[0]) && /this\.data\[map\.notice\]/.test(m[0]);
});

check('every mini-app close handler advances the queue', () =>
  NOTICES.every(n => {
    const name = n.mini.charAt(0).toUpperCase() + n.mini.slice(1);
    const re = new RegExp(`close${name}\\(\\) \\{[^}]*${n.mini}Popup: false[^}]*\\}\\);\\s*\\n\\s*this\\.advanceNotices\\(\\);`);
    return re.test(miniSrc);
  }));

// The queue holds a timer, and this page is destroyed mid-flight by every
// success path (redirectTo order-success). A timer that outlives the page fires
// setData on an unloaded one, which WeChat warns about and keeps the page
// object alive for ~20s.
check('the mini app tears the queue timer down with the page', () =>
  /_clearPendingTimers\(\) \{[\s\S]*?_noticeQueueTimer[\s\S]*?\n  \},/.test(miniSrc)
  && /onUnload\(\) \{ this\._clearPendingTimers\(\); \}/.test(miniSrc));

// The Guangzhou-only popup takes priority and force-closes all four. Anything
// still queued behind them has to go with them, or closing one would reopen a
// notice on top of the popup that just replaced it.
check('the Guangzhou-only popup empties the queue it closes', () => {
  const at = miniSrc.indexOf('localOnlyPopup: true,');
  if (at < 0) return false;
  const win = miniSrc.slice(at, at + 1200);
  return /storeMoveNoticePopup: false,/.test(win) && /this\._noticeQueue = \[\];/.test(win);
});


// ─────────────────────────────────────────────────────────────────────────
// THE QUEUE, ACTUALLY DRIVEN. Everything above reads source, because neither
// shop.html nor routes/retail.js can be required. The mini-app page CAN be —
// under the same Page/wx shim scripts/test_preorder_local.js uses — so the
// behaviour Ash reported is exercised here rather than inferred from shape:
// a cart with one pre-order item and one fresh-batch item shows two modals,
// one after the other.
console.log('\nThe mini-app queue, driven');

function loadCheckoutPage() {
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  let captured = null;
  g.Page = (o) => { captured = o; return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {}, activeAddressId: null }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, { get: (t, k) => {
    if (k === 'getStorageSync') return () => null;
    if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
    if (k === 'getAccountInfoSync') return () => ({ miniProgram: { appId: 'wxtest' } });
    return () => {};
  } });
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'miniapp/pages/checkout/checkout.js'))];
    require(path.join(ROOT, 'miniapp/pages/checkout/checkout.js'));
  } finally {
    Object.assign(g, saved);
  }
  return captured;
}

const checkoutPage = loadCheckoutPage();

// A page instance with the four notices present and no modal up. The real
// setData merges a patch into this.data and re-renders; here the merge is the
// whole of it, which is all the queue reads.
function instance(notices) {
  const inst = Object.create(checkoutPage);
  inst.data = {
    localOnlyPopup: false,
    batchNotice: null, preorderNotice: null, localFreshNotice: null, storeMoveNotice: null,
    batchNoticePopup: false, preorderNoticePopup: false,
    localFreshNoticePopup: false, storeMoveNoticePopup: false,
  };
  for (const key of notices) inst.data[checkoutPage.NOTICE_KEYS[key].notice] = { title_en: key };
  inst.setData = (patch) => Object.assign(inst.data, patch);
  return inst;
}

// Which modals are up, in the queue's own order, so a failure prints what the
// customer would actually have seen.
function open(inst) {
  return Object.keys(checkoutPage.NOTICE_KEYS)
    .filter(k => inst.data[checkoutPage.NOTICE_KEYS[k].popup]);
}

// advanceNotices waits 240ms so the closed card can leave the screen. Run that
// timer now — the gap is a rendering courtesy, not part of the rule.
function closeNow(inst, fn) {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb) => { cb(); return 0; };
  try { fn.call(inst); } finally { global.setTimeout = realSetTimeout; }
}

check('ASH\'S CART: one pre-order item + one fresh batch = two modals in a row', () => {
  const inst = instance(['batch', 'preorder']);
  inst.enqueueNotices(['batch', 'preorder']);
  // First: the batch modal alone. The pre-order one must NOT be under it.
  if (open(inst).join(',') !== 'batch') return false;
  closeNow(inst, checkoutPage.closeBatchNotice);
  // Second: the pre-order modal, on its own, once the first is closed.
  return open(inst).join(',') === 'preorder';
});

check('and the second one closes to an empty screen, not a third', () => {
  const inst = instance(['batch', 'preorder']);
  inst.enqueueNotices(['batch', 'preorder']);
  closeNow(inst, checkoutPage.closeBatchNotice);
  closeNow(inst, checkoutPage.closePreorderNotice);
  return open(inst).length === 0;
});

check('three notices come up in the order the server computes them', () => {
  const inst = instance(['batch', 'localFresh', 'storeMove']);
  inst.enqueueNotices(['batch', 'localFresh', 'storeMove']);
  const seen = [];
  seen.push(open(inst).join(','));
  closeNow(inst, checkoutPage.closeBatchNotice);
  seen.push(open(inst).join(','));
  closeNow(inst, checkoutPage.closeLocalFreshNotice);
  seen.push(open(inst).join(','));
  return seen.join(' → ') === 'batch → localFresh → storeMove';
});

// A re-quote can drop a notice while the modal ahead of it is still up. The
// queue must walk past it to the next one rather than opening an empty card or
// stopping dead on it.
check('a notice the latest quote dropped is skipped, not stalled on', () => {
  const inst = instance(['batch', 'preorder', 'storeMove']);
  inst.enqueueNotices(['batch', 'preorder', 'storeMove']);
  inst.data.preorderNotice = null;   // the re-quote that retired it
  closeNow(inst, checkoutPage.closeBatchNotice);
  return open(inst).join(',') === 'storeMove';
});

check('closing the last modal with nothing queued reopens nothing', () => {
  const inst = instance(['batch']);
  inst.enqueueNotices(['batch']);
  closeNow(inst, checkoutPage.closeBatchNotice);
  closeNow(inst, checkoutPage.closeBatchNotice);
  return open(inst).length === 0;
});

// Enqueueing onto a modal that is already up — a second quote arriving while
// the customer reads the first notice — must not drop a second card on top.
check('a notice enqueued while a modal is up waits its turn', () => {
  const inst = instance(['batch', 'storeMove']);
  inst.enqueueNotices(['batch']);
  inst.enqueueNotices(['storeMove']);
  if (open(inst).join(',') !== 'batch') return false;
  closeNow(inst, checkoutPage.closeBatchNotice);
  return open(inst).join(',') === 'storeMove';
});

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
