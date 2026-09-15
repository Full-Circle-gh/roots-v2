#!/usr/bin/env node
/**
 * The four checkout notices do not stack on top of one another.
 *
 *   node scripts/test_checkout_notice_stacking.js
 *
 * WHAT THE QUOTE CAN RETURN. `POST /api/retail/quote` computes four
 * customer-facing notices — batch_notice, preorder_notice, local_fresh_notice
 * and store_move_notice — and public/shop.html renders each as a persistent
 * banner plus a modal that auto-opens ONCE per checkout visit.
 *
 * WHY THIS SUITE EXISTS. Two of those four opened without asking whether a
 * modal was already up. `coNoticePopupOpen()` had existed since the third
 * notice shipped, and the third and fourth renderers used it; the first two,
 * written before it, never gained it. So a basket that raised two notices
 * dropped the second overlay on top of the first and buried it.
 *
 * AND THEY GENUINELY CO-OCCUR. Only preorder_notice and local_fresh_notice are
 * mutually exclusive — routes/retail.js says so at the call site, because their
 * address gates are complements. batch_notice is computed independently of all
 * three, so a cart holding a batch-made dish AND a sold-out backorder extra
 * raises two. The mini app has guarded exactly this since it shipped
 * (miniapp/pages/checkout/checkout.js: "a cart could hold both").
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE SHAPE RATHER THAN A RENDER. shop.html is
 * a page and routes/retail.js pulls in better-sqlite3, so neither can be
 * required here; both are read as source. That is the split
 * test_store_move_notice.js and test_recipient_phone.js already use for this
 * same page, for the same reason.
 *
 * THE RULE THIS HOLDS: every auto-open in this page asks the shared helper
 * first, and the helper knows every overlay. A fifth notice that joins the page
 * and forgets either half is what this is here to catch.
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
  console.log(`${ok ? '  \u2713' : '  \u2717'} ${name}`);
  if (!ok) failed++;
}

console.log('\nThe checkout notices, and the one door they all go through');

// ONE ENTRY PER NOTICE. Named so a failure says which notice lost its guard
// rather than "one of four".
const NOTICES = [
  { key: 'batch',      flag: 'batchSeen',      popup: 'coBatchPopup',      overlay: '#cobPop'  },
  { key: 'preorder',   flag: 'preorderSeen',   popup: 'coPreorderPopup',   overlay: '#copoPop' },
  { key: 'localFresh', flag: 'localFreshSeen', popup: 'coLocalFreshPopup', overlay: '#colfPop' },
  { key: 'storeMove',  flag: 'storeMoveSeen',  popup: 'coStoreMovePopup',  overlay: '#cosmPop' },
];

for (const n of NOTICES) {
  check(`${n.key}: the auto-open asks whether a modal is already up`, () => {
    const re = new RegExp(`if\\(!co\\.${n.flag}&&!coNoticePopupOpen\\(\\)\\)\\{`);
    return re.test(webSrc);
  });
  // Guarding the open is half of it; the helper it guards ON carries a
  // hardcoded list, and an overlay missing from that list is invisible to every
  // other notice that checks before opening itself.
  check(`${n.key}: \u2026and the helper knows this overlay`, () => {
    const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
    return !!m && m[0].includes(n.overlay);
  });
  // The banner is what makes yielding safe: a notice that skipped its pop is
  // still on screen, with a tap target back into the modal. Without that, the
  // guard would not be politeness, it would be suppression.
  check(`${n.key}: \u2026and the modal stays reachable from the banner`, () =>
    new RegExp(`addEventListener\\('click',${n.popup}\\)`).test(webSrc));
}

check('the helper lists exactly the four overlays, and no more', () => {
  const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
  if (!m) return false;
  const ids = (m[0].match(/#\w+Pop/g) || []).sort();
  return ids.length === 4 && ids.join(',') === ['#cobPop', '#copoPop', '#colfPop', '#cosmPop'].sort().join(',');
});

// An overlay that is present but hidden must not count as open, or the FIRST
// notice dismissed would silence every later one for the rest of the visit.
check('a dismissed overlay does not keep counting as open', () => {
  const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
  return !!m && /!el\.hidden/.test(m[0]);
});

// THE SERVER'S OWN WORD ON CO-OCCURRENCE. If batch and preorder ever became
// mutually exclusive the guard would be harmless; the point is that they are
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

// The mini app is the reference implementation here: it has carried this rule
// since it shipped, and the web client drifting from it is what this fixes.
check('the mini app still guards its own chain, so the two clients agree', () =>
  /const batchAutoShowing = data\.batch_notice && this\.data\.batchNoticePopup;/.test(miniSrc)
  && /data\.preorder_notice && [^\n]*&& !batchAutoShowing/.test(miniSrc));

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
