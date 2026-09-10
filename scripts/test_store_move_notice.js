#!/usr/bin/env node
/**
 * The "sent from another shop" notice reaches the WEB storefront too.
 *
 *   node scripts/test_store_move_notice.js
 *
 * WHAT THE NOTICE IS. routeOrder drops a closed location BEFORE it ranks, so a
 * Guangzhou delivery whose usual shop is shut moves to whoever is left and the
 * customer is never told why it might be slower. computeStoreMoveNotice in
 * routes/retail.js is that telling, and the quote has returned it as
 * `store_move_notice` since it was written.
 *
 * WHY THIS SUITE EXISTS. The quote returns FOUR customer-facing notices and
 * public/shop.html rendered three: batch_notice, preorder_notice and (as of
 * PR #446) local_fresh_notice. store_move_notice arrived in the payload and was
 * dropped on the floor, so a web shopper whose order had been rerouted by a
 * closed shop saw nothing while the identical cart in the mini app opened a
 * popup. That is the same half-finished shape PR #446 found and fixed for the
 * notice beside it, and this suite is written in that block's style.
 *
 * NO DB, NO NETWORK. routes/retail.js pulls in better-sqlite3 and shop.html is
 * a page, so neither can be required here; both are asserted against their own
 * source. That is the split scripts/test_recipient_phone.js uses for the same
 * page, for the same reason.
 *
 * THE COPY IS ENTIRELY THE OPERATOR'S. All six bilingual fields live in
 * storefront_config under `notice.store_move.*`; if any is blank the server
 * returns null and nothing renders. There is deliberately no fallback copy, so
 * the renderer must compose none either — which is an assertion below, not a
 * comment.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failed = 0;
function check(name, fn) {
  let ok = false;
  try { ok = !!fn(); } catch (e) { ok = false; }
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed++;
}

// ── The server still computes and still ships it ──────────────────────────
// Two assertions only, and both are about the CONTRACT the page renders
// against: the field's name in the payload, and the all-or-nothing rule that
// makes a missing translation show nothing rather than half a notice. The
// routing decisions behind it are not this suite's business.
console.log('── The quote payload (routes/retail.js)');
const apiSrc = read(path.join('routes', 'retail.js'));

check('the quote returns the notice under store_move_notice',
  () => /store_move_notice: storeMoveNotice,/.test(apiSrc));

check('all six operator fields are required, or the notice is null',
  () => {
    const m = apiSrc.match(/const STORE_MOVE_NOTICE_FIELDS = \[([^\]]*)\]/);
    if (!m) return false;
    const fields = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    return fields.length === 6 && /if \(!v\) return null;/.test(apiSrc);
  });

// ── The web storefront renders it ─────────────────────────────────────────
console.log('\n── The web storefront (public/shop.html)');
const webSrc = read(path.join('public', 'shop.html'));

check('the checkout markup has a slot for it beside the other three',
  () => /<div id="coStoreMove" style="padding:0 22px"><\/div>/.test(webSrc) &&
        /#coStoreMove\{order:2;\}/.test(webSrc));

check('the quote render pass calls the store-move renderer',
  () => /renderCoSlots\(d\);[^\n]*renderCoStoreMove\(d\);/.test(webSrc));

check('the renderer reads the server field, and stays silent without it',
  () => /function renderCoStoreMove/.test(webSrc) &&
        /const n=d&&d\.store_move_notice;\s*\n\s*if\(!n\)\{ box\.innerHTML=''; return; \}/.test(webSrc));

check('it auto-opens the popup once per checkout visit',
  () => /co\.storeMoveSeen=false;/.test(webSrc) &&
        /if\(!co\.storeMoveSeen&&!coNoticePopupOpen\(\)\)\{ co\.storeMoveSeen=true; coStoreMovePopup\(\); \}/.test(webSrc));

// The banner is the persistent half — the popup is dismissed once and the
// reason must still be reachable afterwards, which is what Details is for.
check('…and leaves a banner behind it with a way back in',
  () => /id="cosmMore"/.test(webSrc) &&
        /\$\('#cosmMore'\)\.addEventListener\('click',coStoreMovePopup\)/.test(webSrc));

// Guarding the auto-open is only half of it: the helper it guards ON has a
// hardcoded list of overlays, and a new modal that does not join the list is
// invisible to the two notices that check before opening themselves.
check('the anti-stacking helper knows about this overlay too',
  () => {
    const m = webSrc.match(/function coNoticePopupOpen\(\)\{[\s\S]*?\n\}/);
    return !!m && /#cosmPop/.test(m[0]);
  });

// Cut each function out at its first line-start `}`. A MISSING function must
// yield '' and not the tail of the file — indexOf returns -1 there, and a bare
// slice(-1) would hand back the last character of the page, against which
// "contains no item chips" and "never touches the submit button" both pass
// while nothing whatsoever has been written. Every check below that reads a
// body therefore asserts the body exists first.
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return '';
  const rest = src.slice(at);
  const end = rest.indexOf('\n}');
  return end < 0 ? '' : rest.slice(0, end);
}
const smRenderBody = bodyOf(webSrc, 'function renderCoStoreMove');
const smPopupBody = bodyOf(webSrc, 'function coStoreMovePopup');

check('the popup prints the operator\'s kicker, title and message',
  () => /function coStoreMovePopup/.test(webSrc) &&
        /n\.kicker_cn:n\.kicker_en/.test(smPopupBody) &&
        /n\.title_cn:n\.title_en/.test(smPopupBody) &&
        /n\.message_cn:n\.message_en/.test(smPopupBody));

// This notice is about where the order SHIPS FROM, not which items are
// affected, so the server sends no `items` array. The sibling popups map one
// into chips; copying that here would render an empty strip forever.
check('no item chips — this notice names no items and the server sends none',
  () => !!smPopupBody && !/copo-items/.test(smPopupBody) && !/copo-chip/.test(smPopupBody));

check('it never touches the submit button',
  () => !!smRenderBody && !!smPopupBody &&
        !/coPlace/.test(smRenderBody) && !/coPlace/.test(smPopupBody));

// The one rule that cannot be left to review. Every word a customer reads here
// is the operator's, pulled from storefront_config; the only Chinese the page
// may carry is the two UI words its sibling renderers already use, copied
// verbatim rather than composed. Any THIRD Chinese run in this block is a
// string somebody minted, which is exactly what must not happen.
const ALLOWED_CN = new Set(['详情', '知道了']);
check('no composed Chinese — only the two live UI words the siblings use',
  () => !!smRenderBody && !!smPopupBody &&
        ((smRenderBody + '\n' + smPopupBody).match(/[一-鿿]+/g) || [])
          .every((run) => ALLOWED_CN.has(run)));

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
