#!/usr/bin/env node
/**
 * Recipient-phone handling — the rule, the write paths, the checkout notice,
 * the ops flag, and the push's first-failure stop.
 *
 *   node scripts/test_recipient_phone.js
 *
 * No DB, no network, no courier account. The pure decisions are exercised
 * directly; the CALL SITES that have to use them — five write paths, two
 * checkout surfaces, the enqueue hook, the daemon drain — are asserted against
 * their own source, because none of them can be required here (routes/retail.js
 * pulls in better-sqlite3, the daemon opens a browser, shop.html is a page).
 * That is the same split scripts/test_address_clients.js uses.
 *
 * The thing all of this is protecting: Qingyun's accepted phone format is NOT
 * documented (see docs/known-issues.md, RECIPIENT-PHONE-UNVALIDATED). Every
 * rule here is therefore advisory — it may warn, flag and stop retrying, and it
 * must never refuse a number at capture. Several tests below exist only to
 * prove we still can't.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const phoneCn = require('../lib/phone-cn');
const miniPhone = require('../miniapp/utils/phone');
const qingyunQueue = require('../lib/qingyun-queue');
const aliyun = require('../lib/aliyun-sms');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const retailSrc = read('routes/retail.js');
const daemonSrc = read('scripts/qingyun-daemon.js');

// The four shapes that actually failed in production, kept as data so the tests
// below assert against real refusals rather than invented ones. Orders 930/873
// and 868 were 8-digit HK-shaped numbers; 562 was 9 digits. See the survey.
const REFUSED_SHAPES = ['66112233', '66119988', '91912345', '787654321'];
const GOOD = '13800138000';

// ─────────────────────────────────────────────────────────────────────────
console.log('\nlib/phone-cn — the rule itself');

it('accepts an 11-digit mainland mobile', () => {
  assert.strictEqual(phoneCn.isMainlandMobile(GOOD), true);
});
it('accepts one written with spaces, dashes or full-width parens', () => {
  for (const s of ['138 0013 8000', '138-0013-8000', '（138）0013 8000', '138.0013.8000']) {
    assert.strictEqual(phoneCn.isMainlandMobile(s), true, s);
  }
});
it('unwraps +86 / 86 / 086 / 0086', () => {
  for (const s of ['+8613800138000', '8613800138000', '08613800138000', '008613800138000']) {
    assert.strictEqual(phoneCn.normalize(s), GOOD, s);
    assert.strictEqual(phoneCn.isMainlandMobile(s), true, s);
  }
});
it('rejects every shape Qingyun actually refused', () => {
  for (const s of REFUSED_SHAPES) {
    assert.strictEqual(phoneCn.isMainlandMobile(s), false, s);
  }
});
it('rejects empty, whitespace-only and non-mobile lengths', () => {
  for (const s of ['', '   ', null, undefined, '1380013800', '138001380000', '02087654321']) {
    assert.strictEqual(phoneCn.isMainlandMobile(s), false, JSON.stringify(s));
  }
});
it('never turns a foreign 13-digit number starting 86 into a mainland one', () => {
  // The unwrap is only sanctioned when what remains IS a mainland mobile.
  // Without that guard this would silently become a valid-looking 8600000000.
  assert.strictEqual(phoneCn.normalize('8600000000123'), '8600000000123');
  assert.strictEqual(phoneCn.isMainlandMobile('8600000000123'), false);
});

console.log('\nlib/phone-cn — normalizeForStorage never destroys what it got');
it('whitespace-only becomes empty, so presence checks can be honest', () => {
  assert.strictEqual(phoneCn.normalizeForStorage('   '), '');
  assert.strictEqual(phoneCn.normalizeForStorage('\t\n '), '');
});
it('tidies a mainland mobile to its canonical 11 digits', () => {
  assert.strictEqual(phoneCn.normalizeForStorage('+86 138-0013 8000'), GOOD);
});
it('stores an INTERNATIONAL number exactly as typed', () => {
  // Changed deliberately: this used to strip the separators ('+85266112233').
  // We do not know how other countries group their digits, so reformatting one
  // is guessing at a convention we have no source for. A value that announces
  // itself with a '+' is left alone.
  assert.strictEqual(phoneCn.normalizeForStorage('+852 6611 2233'), '+852 6611 2233');
  assert.strictEqual(phoneCn.normalizeForStorage(' 6611 2233 '), '66112233', 'no + → still tidied');
});

// ── A leading '+' is decisive (the NANP hole) ────────────────────────────
// '+1 415 555 2671' is eleven digits beginning 1 once the '+' is dropped, which
// is exactly the shape of a mainland mobile. The first version tested the digits
// and ignored the '+', so a US number was called mainland, stored as
// '14155552671', and never warned about — a number staff would then dial as if
// it were domestic.
it('a NANP number is not mainland, and keeps its + and its spacing', () => {
  assert.strictEqual(phoneCn.isMainlandMobile('+1 415 555 2671'), false);
  assert.strictEqual(phoneCn.normalizeForStorage('+1 415 555 2671'), '+1 415 555 2671');
  assert.strictEqual(phoneCn.isMainlandMobile('+14155552671'), false);
  assert.strictEqual(phoneCn.normalizeForStorage('+14155552671'), '+14155552671');
});
it('…but +86 wrapping a real mobile still unwraps', () => {
  assert.strictEqual(phoneCn.isMainlandMobile('+8613800138000'), true);
  assert.strictEqual(phoneCn.normalizeForStorage('+8613800138000'), GOOD);
  assert.strictEqual(phoneCn.isMainlandMobile('+86 138 0013 8000'), true);
  assert.strictEqual(phoneCn.normalizeForStorage('+86 138 0013 8000'), GOOD);
});
it('a + that is NOT +86 never loses a digit, whatever country it is', () => {
  for (const v of ['+1 415 555 2671', '+44 20 7946 0958', '+852 6611 2233', '+8612345678']) {
    assert.strictEqual(phoneCn.normalizeForStorage(v), v, v);
    assert.strictEqual(phoneCn.isMainlandMobile(v), false, v);
  }
});
it('a BARE 11-digit NANP number is read as mainland — documented, not accidental', () => {
  // Without the '+' the two are the same eleven digits and nothing in the value
  // says which was meant. For a Guangzhou grocery the mainland reading is the
  // likelier one, and the cost of being wrong is a warning that doesn't appear,
  // never a rejected order. Asserted so the choice is visible if it is revisited.
  assert.strictEqual(phoneCn.isMainlandMobile('14155552671'), true);
  assert.strictEqual(phoneCn.normalizeForStorage('14155552671'), '14155552671');
});
it('leaves a field containing WORDS exactly as typed (it is a note)', () => {
  assert.strictEqual(phoneCn.normalizeForStorage('13800138000 (work)'), '13800138000 (work)');
  assert.strictEqual(phoneCn.normalizeForStorage(' 门卫 13800138000 '), '门卫 13800138000');
});
it('never returns empty for something that had content', () => {
  for (const s of ['abc', '---', '(())', '+']) {
    assert.strictEqual(phoneCn.normalizeForStorage(s), s.trim(), s);
  }
});

console.log('\nlib/aliyun-sms — still consumes the shared rule, contract unchanged');
it("normalizeCnMobile keeps its ''-means-unusable contract", () => {
  assert.strictEqual(aliyun.normalizeCnMobile(GOOD), GOOD);
  assert.strictEqual(aliyun.normalizeCnMobile('+86 138 0013 8000'), GOOD);
  for (const s of REFUSED_SHAPES) assert.strictEqual(aliyun.normalizeCnMobile(s), '', s);
  assert.strictEqual(aliyun.normalizeCnMobile(''), '');
});
it('aliyun-sms no longer carries its own copy of the regex', () => {
  const src = read('lib/aliyun-sms.js');
  assert.ok(/require\('\.\/phone-cn'\)/.test(src), 'consumes lib/phone-cn');
  assert.ok(!/\\d\{10\}\$/.test(src.replace(/^\s*\/\/.*$/gm, '')),
    'the 11-digit rule must live in phone-cn only');
});

console.log('\nminiapp/utils/phone — the mini-app copy agrees with the server');
it('agrees with lib/phone-cn on every shape that matters', () => {
  const cases = [GOOD, ...REFUSED_SHAPES, '+8613800138000', '008613800138000',
                 '138 0013 8000', '', '   ', '8600000000123', '02087654321'];
  for (const s of cases) {
    assert.strictEqual(miniPhone.isMainlandMobile(s), phoneCn.isMainlandMobile(s),
      `disagreement on ${JSON.stringify(s)} — the two copies have drifted`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nwrite paths — normalization applied at every call site');

// Each entry is a site that writes a recipient phone. The survey found ten
// capture paths and no validation on any of them; these are the five that
// actually reach the database, and every one has to normalize.
it('normalizeChinaAddress normalizes phone (covers POST + both admin routes)', () => {
  const fn = retailSrc.slice(retailSrc.indexOf('function normalizeChinaAddress'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/'phone' in out/.test(body) && /phoneCn\.normalizeForStorage\(out\.phone\)/.test(body),
    'normalizeChinaAddress must normalize the phone it was handed');
});
it('BOTH partial-update PUTs normalize a phone-only edit', () => {
  // The bug this guards: `a = cond ? normalizeChinaAddress(incoming) : incoming`
  // means an edit that changes ONLY the phone never meets the normalizer — and
  // correcting a refused number is exactly that edit.
  const hits = retailSrc.match(/if \('phone' in incoming\) a\.phone = phoneCn\.normalizeForStorage\(incoming\.phone\);/g) || [];
  assert.strictEqual(hits.length, 2,
    'customer PUT + admin PUT — both branches of the partial update');
});
it('the out-of-funnel admin order patch normalizes too', () => {
  assert.ok(/const recipientPhone = \(body\.recipient_phone != null\)\s*\n\s*\? phoneCn\.normalizeForStorage\(body\.recipient_phone\)/.test(retailSrc),
    'retail_orders is written directly here — the funnel does not cover it');
});
it('no write path still stores a raw .trim() phone', () => {
  assert.ok(!/String\(body\.recipient_phone\)\.trim\(\)/.test(retailSrc),
    'the admin order patch used to store the trimmed original');
});

console.log('\npresence checks — a field of spaces is an empty field');
it('both address POSTs test the TRIMMED recipient name', () => {
  const hits = retailSrc.match(/!String\(a\.recipient_name \|\| ''\)\.trim\(\) \|\| !a\.phone \|\| !a\.address/g) || [];
  assert.strictEqual(hits.length, 2, 'customer POST + admin POST');
});
it('a whitespace-only phone now fails the presence check', () => {
  // The check is `!a.phone` on the value normalizeChinaAddress produced. Before
  // this work that value was the raw body string, so '   ' was truthy and sailed
  // through to the courier as an empty recipientPhone.
  assert.strictEqual(phoneCn.normalizeForStorage('   '), '');
  assert.ok(!phoneCn.normalizeForStorage('   '), 'falsy → missing_required');
});

console.log('\nno path REJECTS a phone for its format (the locked decision)');
it('nothing in the write paths refuses a number on isMainlandMobile', () => {
  // Ash's decision: checkout NEVER blocks on phone format. If someone later
  // wires the rule into a 400, this fails and they have to come back to it.
  const guarded = retailSrc.split('\n').filter(l =>
    /isMainlandMobile/.test(l) && /(res\.status\(4|return .*error:)/.test(l));
  assert.deepStrictEqual(guarded, [],
    'isMainlandMobile must never gate a request — it warns and flags only');
});
it('the mini-app address book still saves any number it is given', () => {
  const src = read('miniapp/pages/addresses/addresses.js');
  assert.ok(!/isMainlandMobile/.test(src),
    'the address book must not have gained a format check');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nops flag at enqueue — once per order, never on requeue');

it('the flag is gated on the INSERT actually creating the row', () => {
  // This IS the throttle. INSERT OR IGNORE reports changes=1 only the first
  // time; a requeue is an UPDATE and a re-run of the hook ignores, so both
  // leave changes at 0 and neither can page ops a second time.
  assert.ok(/const ins = tdb\(\)\.prepare\(\s*\n\s*"INSERT OR IGNORE INTO qingyun_push_queue/.test(retailSrc),
    'the enqueue INSERT must be captured');
  assert.ok(/if \(ins\.changes === 1\) maybeFlagUncallablePhone\(o, store\.code\);/.test(retailSrc),
    'flag only when a row was created');
});
it('the reconcile sweep in the daemon flags on the same gate', () => {
  assert.ok(/if \(enq\.run\(o\.id, storeCode\)\.changes === 1\) flagUncallablePhone\(o, storeCode\);/.test(daemonSrc),
    'the other enqueue point — cash/COD/mark-paid orders never touch the app hook');
});
it('both enqueue queries select the phone they are about to judge', () => {
  assert.ok(/SELECT id, order_no, recipient_phone, fulfillment_type/.test(retailSrc),
    'app-side hook');
  assert.ok(/SELECT o\.id, o\.order_no, o\.recipient_phone, o\.channel/.test(daemonSrc),
    'daemon reconcile sweep');
});
it('the flag returns early for a number a rider CAN call', () => {
  for (const src of [retailSrc, daemonSrc]) {
    assert.ok(/if \(phoneCn\.isMainlandMobile\(order\.recipient_phone\)\) return;/.test(src),
      'a good number must not page anyone');
  }
});
it('flagging never blocks the push', () => {
  // Both flag helpers are fire-and-forget: an ops webhook that is slow or down
  // must not fail the checkout that triggered it.
  //
  // SCOPED TO THE TWO HELPERS BY NAME, not counted file-wide. This used to
  // assert that `Promise.resolve(sendOpsAlert(` appeared exactly twice across
  // both files, which made it a census of every detached alert in the codebase
  // rather than a statement about these two. It went red on 2026-08-11 when
  // reconcileTier legitimately adopted the same idiom — a true assertion about
  // the wrong thing. What matters is that EACH of these helpers is detached;
  // how many other places also do it correctly is not this test's business.
  const bodyOf = (src, name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(i, -1, `${name} not found — it was renamed or removed`);
    const end = src.indexOf('\n}', i);
    assert.notStrictEqual(end, -1, `${name} is unterminated`);
    return src.slice(i, end + 2);
  };
  //
  // THE SENDER IS NOT PART OF THIS ASSERTION EITHER, for the same reason the
  // census was dropped. It named sendOpsAlert literally and went red when the
  // retail helper moved to sendTenantAlert — the merchant is the one who has to
  // call this customer, so the alert is theirs (audit D-02 / P-01). The
  // property under test is DETACHMENT: whichever channel it goes to, it must
  // not be awaited inside the push.
  for (const [src, name] of [[retailSrc, 'maybeFlagUncallablePhone'], [daemonSrc, 'flagUncallablePhone']]) {
    assert.ok(/Promise\.resolve\(send(?:Ops|Tenant)Alert\(/.test(bodyOf(src, name)),
      `${name} is not detached from the request — a slow webhook would hold up the push`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\npush refusal — a phone Qingyun rejected stops after ONE attempt');

const phoneErr = () => Object.assign(new Error('create failed (code 40001, 请输入合法的收货人电话)'),
  { qyCode: 40001, qyMsg: '请输入合法的收货人电话' });

it('classifies the real production rejection', () => {
  assert.strictEqual(qingyunQueue.isRecipientPhoneRejection(phoneErr()), true);
});
it('a phone rejection lands in error after exactly 1 attempt', () => {
  const out = qingyunQueue.pushFailureOutcome({ err: phoneErr(), attemptsBefore: 0, maxAttempts: 5 });
  assert.strictEqual(out.status, 'error');
  assert.strictEqual(out.attempts, 1);
  assert.strictEqual(out.phoneRefused, true);
});
it('its reason is renderable and says what to do', () => {
  const { lastError } = qingyunQueue.pushFailureOutcome({ err: phoneErr(), attemptsBefore: 0 });
  // The drawer prints last_error verbatim under "Push refused" (escaped, with
  // data-no-i18n), so it only has to be a plain string that reads as an answer.
  assert.strictEqual(typeof lastError, 'string');
  assert.ok(lastError.length > 0 && lastError.length <= 300, 'fits the column slice');
  assert.ok(/recipient phone/i.test(lastError), 'names the problem');
  assert.ok(/Retry/i.test(lastError), 'names the fix');
  assert.ok(/请输入合法的收货人电话/.test(lastError), 'keeps Qingyun’s own words as evidence');
});
it('a NON-phone failure still gets all five attempts', () => {
  const other = Object.assign(new Error('create failed (code 40001, 参数错误)'),
    { qyCode: 40001, qyMsg: '参数错误' });
  for (let before = 0; before < 4; before++) {
    const out = qingyunQueue.pushFailureOutcome({ err: other, attemptsBefore: before, maxAttempts: 5 });
    assert.strictEqual(out.status, 'pending', `attempt ${before + 1} must retry`);
    assert.strictEqual(out.phoneRefused, false);
  }
  assert.strictEqual(
    qingyunQueue.pushFailureOutcome({ err: other, attemptsBefore: 4, maxAttempts: 5 }).status,
    'error', 'and gives up on the fifth');
});
it('classifies conservatively — anything unclear keeps retrying', () => {
  const cases = [
    [Object.assign(new Error('x'), { qyCode: 40001, qyMsg: '参数错误' }), 'generic invalid-param'],
    [Object.assign(new Error('x'), { qyCode: 40001, qyMsg: '收货地址不合法' }), 'recipient but not phone'],
    [Object.assign(new Error('x'), { qyCode: 40001, qyMsg: '发货人电话有误' }), 'a phone, but not the RECIPIENT’s'],
    [new Error('create failed 请输入合法的收货人电话'), 'no structured code — Qingyun never answered'],
    // The case that actually exercises the qyCode guard. The line above cannot:
    // its text is on `.message`, and the classifier reads `.qyMsg`, so it is
    // already refused for having no message at all — deleting the qyCode check
    // left the whole suite green. Here the message IS the refusal text and only
    // the code is missing, which is what a transport failure carrying unlucky
    // text looks like. Misreading it terminal would give up after ONE attempt on
    // an order Qingyun never even saw.
    [Object.assign(new Error('x'), { qyMsg: '请输入合法的收货人电话' }),
      'refusal text but NO code — nothing proves Qingyun answered'],
    [Object.assign(new Error('x'), { qyCode: 40001, qyMsg: '' }), 'empty message'],
    [Object.assign(new Error('x'), { qyCode: 40001 }), 'no message at all'],
    [null, 'no error object'],
  ];
  for (const [err, why] of cases) {
    assert.strictEqual(qingyunQueue.isRecipientPhoneRejection(err), false, why);
  }
});
it('a geocoder hold is never mistaken for a phone refusal', () => {
  const held = Object.assign(new Error('geocoder unavailable — holding: phone home'), { geoHold: true });
  assert.strictEqual(qingyunQueue.isRecipientPhoneRejection(held), false);
  assert.strictEqual(qingyunQueue.shouldHoldForGeocoder(held), true);
});
it('the daemon uses the shared outcome, and the catch block is in the right ORDER', () => {
  assert.ok(/qingyunQueue\.pushFailureOutcome\(\{[\s\S]{0,120}attemptsBefore: row\.attempts/.test(daemonSrc),
    'daemon must not re-implement the decision');

  // Four branches, four different meanings, and each of the first three exits
  // with `continue`. They must appear in this order:
  //
  //   1. shouldHoldForGeocoder    — the provider is down. Give the attempt back.
  //   2. shouldMarkAwaitingChoice — the NAME search found several places and
  //                                 could not choose. Park it with the list.
  //   3. shouldMarkNeedsPoint     — nothing could be placed at all. Park it
  //                                 with a map; no attempt, no page.
  //   4. pushFailureOutcome       — a real failure. One attempt, or five.
  //
  // This is asserted because branches 3 and 4 were written a fortnight apart, on
  // separate branches, and first met in a rebase — the conflict landed exactly
  // here. A resolution that dropped any would fail silently: parked orders
  // would burn attempts and page ops, or a refused phone would retry four more
  // times. Positions, not just presence, because "both are in the file" was
  // already true of the broken resolutions.
  //
  // Branch 2 joined later, with POI-first resolution. Its marker is mutually
  // exclusive with branch 3's, so the order between those two cannot change
  // behaviour today — it is pinned anyway, because that exclusivity is a
  // property of the thrower and this file cannot see it.
  const holdAt    = daemonSrc.indexOf('shouldHoldForGeocoder');
  const choiceAt  = daemonSrc.indexOf('shouldMarkAwaitingChoice');
  const pointAt   = daemonSrc.indexOf('shouldMarkNeedsPoint');
  const outcomeAt = daemonSrc.indexOf('pushFailureOutcome');
  assert.ok(holdAt > -1, 'the geocoder hold branch is missing');
  assert.ok(choiceAt > -1, 'the awaiting_choice branch is missing');
  assert.ok(pointAt > -1, 'the needs_point branch is missing — a rebase dropped it');
  assert.ok(outcomeAt > -1, 'the failure outcome is missing');
  assert.ok(holdAt < choiceAt, 'a held row must not be parked for a choice');
  assert.ok(choiceAt < pointAt, 'when there is a list to pick from, the pick state wins');
  assert.ok(pointAt < outcomeAt,
    'a parked row must never reach the outcome — it would spend an attempt and page ops');

  // …and all three early branches really do exit, or the order above buys
  // nothing.
  const between = daemonSrc.slice(holdAt, outcomeAt);
  assert.strictEqual((between.match(/\n\s*continue;/g) || []).length, 3,
    'the hold, awaiting_choice and needs_point branches must each continue, not fall through');
});
it('createOrder failures carry the structured code the classifier needs', () => {
  assert.ok(/err\.qyCode = res\.code;/.test(daemonSrc) && /err\.qyMsg = res\.msg;/.test(daemonSrc),
    'without these the classifier can only regex a string we flattened ourselves');
});

console.log('\nretry after the number is fixed');
it('a phone-refused row is requeue- and retry-eligible', () => {
  // Both paths key off status='error' with no courier copy — which is exactly
  // what the first-failure stop produces. Correcting the phone through the
  // admin drawer requeues it; the Retry button does the same on demand.
  const row = { status: 'error', qingyun_order_id: null };
  assert.strictEqual(qingyunQueue.requeueEligible(row), true, 'order edit requeues it');
  assert.strictEqual(qingyunQueue.manualRetryEligible(row), true, 'Retry push works');
});
it('requeueing resets attempts, so the corrected number gets a full budget', () => {
  assert.ok(/SET status = 'pending', attempts = 0/.test(qingyunQueue.REQUEUE_SQL));
  assert.ok(/SET status = 'pending', attempts = 0/.test(qingyunQueue.MANUAL_RETRY_SQL));
});
it('a row that already produced a courier copy is never re-pushed', () => {
  const copied = { status: 'error', qingyun_order_id: 'QY123' };
  assert.strictEqual(qingyunQueue.requeueEligible(copied), false);
  assert.strictEqual(qingyunQueue.manualRetryEligible(copied), false);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\ncheckout notice — mini-app (real handler, stubbed runtime)');

// Same harness as scripts/test_address_clients.js: the page calls Page() at
// require time, so stubbing the WeChat globals hands back the real handlers.
function loadMiniPage(relPath) {
  const captured = {};
  const g = global;
  const saved = { Page: g.Page, wx: g.wx, getApp: g.getApp, App: g.App, Component: g.Component };
  g.Page = (o) => { Object.assign(captured, o); return o; };
  g.Component = (o) => o;
  g.App = (o) => o;
  g.getApp = () => ({ globalData: { lang: 'en', customer: {} }, authReady: Promise.resolve() });
  g.wx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'getStorageSync') return () => null;
      if (k === 'setStorageSync') return () => {};
      if (k === 'getSystemInfoSync') return () => ({ windowWidth: 375, statusBarHeight: 20 });
      return () => {};
    },
  });
  try {
    const full = path.join(ROOT, relPath);
    delete require.cache[require.resolve(full)];
    require(full);
    return captured;
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
}
function makeCtx(initial) {
  const ctx = {
    data: JSON.parse(JSON.stringify(initial)),
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split('.');
        let cur = ctx.data;
        while (parts.length > 1) { const p = parts.shift(); if (cur[p] == null) cur[p] = {}; cur = cur[p]; }
        cur[parts[0]] = v;
      }
    },
  };
  return ctx;
}

{
  const page = loadMiniPage('miniapp/pages/checkout/checkout.js');
  const base = (over = {}) => ({
    fulfillment: 'delivery', sameCityRider: true, riderPhoneWarn: false,
    riderPhoneFixOpen: false, riderPhoneDraft: '',
    address: { id: 1, phone: GOOD }, ...over,
  });
  const warnFor = (over) => {
    const ctx = makeCtx(base(over));
    page.syncRiderPhoneWarn.call(ctx);
    return ctx.data.riderPhoneWarn;
  };

  it('warns for a same-city rider order with an 8-digit number', () => {
    assert.strictEqual(warnFor({ address: { id: 1, phone: '66112233' } }), true);
  });
  it('warns for every shape Qingyun actually refused', () => {
    for (const s of REFUSED_SHAPES) {
      assert.strictEqual(warnFor({ address: { id: 1, phone: s } }), true, s);
    }
  });
  it('says nothing for a valid mainland number', () => {
    assert.strictEqual(warnFor({}), false);
    assert.strictEqual(warnFor({ address: { id: 1, phone: '+86 138 0013 8000' } }), false);
  });
  it('says nothing for PICKUP', () => {
    assert.strictEqual(
      warnFor({ fulfillment: 'pickup', address: { id: 1, phone: '66112233' } }), false);
  });
  it('says nothing when no same-city rider is carrying it', () => {
    // Out-of-city, later-day and marketplace orders all arrive here the same
    // way: the server's same_city_rider came back false.
    assert.strictEqual(
      warnFor({ sameCityRider: false, address: { id: 1, phone: '66112233' } }), false);
  });
  it('says nothing for an EMPTY phone — the form already owns that', () => {
    for (const p of ['', '   ']) {
      assert.strictEqual(warnFor({ address: { id: 1, phone: p } }), false, JSON.stringify(p));
    }
  });
  it('clears the notice and closes the fix box when the number is corrected', () => {
    const ctx = makeCtx(base({
      address: { id: 1, phone: GOOD }, riderPhoneWarn: true,
      riderPhoneFixOpen: true, riderPhoneDraft: '138',
    }));
    page.syncRiderPhoneWarn.call(ctx);
    assert.strictEqual(ctx.data.riderPhoneWarn, false);
    assert.strictEqual(ctx.data.riderPhoneFixOpen, false, 'a stale input must not linger');
    assert.strictEqual(ctx.data.riderPhoneDraft, '');
  });
  it('typing the phone re-checks it without waiting for a re-quote', () => {
    const src = read('miniapp/pages/checkout/checkout.js');
    assert.ok(/if \(field === 'phone'\) this\.syncRiderPhoneWarn\(\);/.test(src));
  });
  it('the notice never disables placing the order', () => {
    const wxml = read('miniapp/pages/checkout/checkout.wxml');
    const place = wxml.split('\n').filter(l => /riderPhoneWarn/.test(l) && /disabled/.test(l));
    assert.deepStrictEqual(place, [], 'riderPhoneWarn must not gate the submit button');
    assert.ok(/wx:if="\{\{riderPhoneWarn\}\}"/.test(wxml), 'and the notice is rendered');
  });
  it('the inline fix sends ONLY the phone, so it edits rather than duplicates', () => {
    const src = read('miniapp/pages/checkout/checkout.js');
    assert.ok(/api\.put\(`\/api\/retail\/addresses\/\$\{id\}`, \{ phone: next \}\)/.test(src),
      'a full-address PUT would look like a new address at submit time');
  });
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\ncheckout notice — web storefront (lifted from the page)');
{
  const html = read('public/shop.html');
  const grab = (name) => {
    const at = html.indexOf(`function ${name}(`);
    assert.ok(at > -1, `${name} not found in shop.html`);
    const open = html.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) break; }
    }
    return html.slice(at, i + 1);
  };
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    html.slice(html.indexOf('const CO_MAINLAND_MOBILE='), html.indexOf('function coInjectRiderPhoneStyle'))
    + '\n' + grab('coIsMainlandMobile'), sandbox);
  const isOk = (s) => vm.runInContext(`coIsMainlandMobile(${JSON.stringify(s)})`, sandbox);

  it('the web rule agrees with the server on every shape that matters', () => {
    const cases = [GOOD, ...REFUSED_SHAPES, '+8613800138000', '008613800138000',
                   '138 0013 8000', '', '   ', '8600000000123', '02087654321'];
    for (const s of cases) {
      assert.strictEqual(isOk(s), phoneCn.isMainlandMobile(s),
        `disagreement on ${JSON.stringify(s)} — shop.html has drifted`);
    }
  });
  it('renders nothing unless the server said a rider is carrying it', () => {
    const fn = grab('renderCoRiderPhone');
    assert.ok(/if\(!d\|\|!d\.same_city_rider\|\|!typed\|\|coIsMainlandMobile\(typed\)\)\{ box\.innerHTML=''; return; \}/.test(fn),
      'all four exits — no quote, no rider, no number, or a good number');
  });
  it('is wired into the quote render pass', () => {
    assert.ok(/renderCoPreorder\(d\); renderCoRiderPhone\(d\);/.test(html));
  });
  it('never disables Place order', () => {
    const fn = grab('renderCoRiderPhone') + grab('coSaveRiderPhone');
    assert.ok(!/coPlace/.test(fn), 'the notice must not touch the submit button');
  });
  it('the inline fix sends ONLY the phone', () => {
    assert.ok(/body:JSON\.stringify\(\{phone:next\}\)/.test(grab('coSaveRiderPhone')));
  });
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nquote — eligibility comes from the shared predicate, not a guess');
it('same_city_rider is computed with isQingyunSameCityToday', () => {
  assert.ok(/same_city_rider: inventory\.isQingyunSameCityToday\(\{/.test(retailSrc),
    'a client-side re-implementation of the gate would drift from the push');
});
it('it is reported for the FIRST-PARTY channel the route serves', () => {
  const at = retailSrc.indexOf('same_city_rider: inventory.isQingyunSameCityToday');
  const block = retailSrc.slice(at, at + 500);
  assert.ok(/channel: 'wechat'/.test(block), 'customer-facing quote is always first-party');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
