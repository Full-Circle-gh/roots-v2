#!/usr/bin/env node
/**
 * A sign-in code that never went out must not look like one that did.
 *
 *   node scripts/test_signin_code_delivery.js
 *
 * Audit P-02. Four call sites in routes/backend-auth.js sent a one-time code
 * and dropped the result:
 *
 *     try { await aliyunSms.sendOtpSms(u.phone, code, smsCreds); } catch (e) {}
 *     return res.json({ success: false, twofa: true, channel: 'sms', … });
 *
 * An expired Aliyun key, a mail provider refusing the account, a network blip —
 * all four produced the same screen as a code that arrived, and the operator sat
 * waiting for a text message that was never sent, shut out of their own admin,
 * with no record of it anywhere. These tests are what stops that coming back.
 *
 * No DB, no network, no express. The decision functions are lifted out of the
 * route file and run for real in a vm; the CALL SITES that must use them are
 * asserted against their own source, because requiring routes/backend-auth.js
 * pulls in better-sqlite3 and the whole database. Same split as
 * scripts/test_recipient_phone.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The send record must be observable without a database. notify-log is required
// lazily inside each sender for exactly this reason (a log must never be able to
// fail a send), so a cache entry planted here is what those requires resolve to.
const NOTIFY = require.resolve('../lib/notify-log');
const logged = [];
require.cache[NOTIFY] = {
  id: NOTIFY, filename: NOTIFY, loaded: true, exports: {
    logNotification: (row) => { logged.push(row); },
    logNotificationOn: (db, tenantId, row) => { logged.push(row); },
    RETENTION_DAYS: 90,
  },
};

const aliyun = require('../lib/aliyun-sms');

const authSrc  = read('routes/backend-auth.js');
const loginSrc = read('public/backend-login.html');

let pass = 0, fail = 0;
const queue = [];
function it(name, fn) { queue.push({ name, fn }); }
async function runAll() {
  for (const t of queue) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); pass++; }
    catch (e) { console.log(`  ✗ ${t.name}\n      ${e.message}`); fail++; }
  }
}

// ── Lifting the decisions out of the route file ───────────────────────────
// Brace-balanced from the declaration, so the test runs the REAL body rather
// than a copy of it that can drift.
function lift(src, name) {
  const at = src.search(new RegExp(`\\n(?:async )?function ${name}\\s*\\(`));
  assert.ok(at >= 0, `could not find function ${name} in the source`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(at + 1, i + 1);
}

// A sandbox with the two senders replaced. `_next` is what the fake senders
// return (or throw); nothing here touches Aliyun or a mail provider.
function sandbox(next) {
  const calls = [];
  const ctx = {
    console: { warn() {}, log() {} },
    aliyunSms: {
      async sendOtpSms(phone, code, c) {
        calls.push({ channel: 'sms', phone, code, creds: c });
        if (next instanceof Error) throw next;
        return next;
      },
    },
    emailSender: {
      async sendOtpEmail(to, code, creds, opts) {
        calls.push({ channel: 'email', to, code, opts });
        if (next instanceof Error) throw next;
        return next;
      },
    },
    emailBrandOpts: () => ({ brand: 'Roots', logoUrl: '' }),
  };
  vm.createContext(ctx);
  vm.runInContext(lift(authSrc, 'sendLoginCode') + '\n' + lift(authSrc, 'codeSendFailedMessage'), ctx);
  return { ctx, calls };
}

const USER = { id: 7, tenant_id: 1, phone: '13800138000', recovery_email: 'ops@example.com' };

// ─────────────────────────────────────────────────────────────────────────
console.log('\nsendLoginCode — the result is not dropped');

it('a delivered SMS reports ok', async () => {
  const { ctx, calls } = sandbox({ ok: true });
  const r = await ctx.sendLoginCode('sms', USER, '123456', { req: {}, smsCreds: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].code, '123456');
});

it('a refused SMS reports the failure and its reason', async () => {
  const { ctx } = sandbox({ ok: false, error: 'isv.MOBILE_NUMBER_ILLEGAL' });
  const r = await ctx.sendLoginCode('sms', USER, '123456', { req: {}, smsCreds: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'isv.MOBILE_NUMBER_ILLEGAL');
});

it('a sender that THROWS is still an ordinary failure, not a 500', async () => {
  const { ctx } = sandbox(new Error('socket hang up'));
  const r = await ctx.sendLoginCode('email', USER, '123456', { req: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /send_threw:.*socket hang up/);
});

it('a sender returning nothing at all is a failure, not a success', async () => {
  const { ctx } = sandbox(undefined);
  const r = await ctx.sendLoginCode('email', USER, '123456', { req: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'unknown');
});

it('the email carries the co-branding and the kind that separates the two uses', async () => {
  const { ctx, calls } = sandbox({ ok: true });
  await ctx.sendLoginCode('email', USER, '123456', { req: {}, kind: 'password_reset_code' });
  assert.strictEqual(calls[0].opts.brand, 'Roots');
  assert.strictEqual(calls[0].opts.kind, 'password_reset_code');
});

it('defaults to a sign-in code when no kind is named', async () => {
  const { ctx, calls } = sandbox({ ok: true });
  await ctx.sendLoginCode('email', USER, '123456', { req: {} });
  assert.strictEqual(calls[0].opts.kind, 'signin_code');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\ncodeSendFailedMessage — what the operator is told');

it('names the channel that failed, in both languages', async () => {
  const { ctx } = sandbox({ ok: true });
  const sms = ctx.codeSendFailedMessage('sms', false);
  const email = ctx.codeSendFailedMessage('email', false);
  assert.match(sms, /text message/);
  assert.match(sms, /短信/);
  assert.match(email, /email/);
  assert.match(email, /邮件/);
});

it('is a bilingual pair the login page can split on " · "', async () => {
  const { ctx } = sandbox({ ok: true });
  for (const ch of ['sms', 'email']) {
    for (const other of [true, false]) {
      const parts = ctx.codeSendFailedMessage(ch, other).split(' · ');
      assert.strictEqual(parts.length, 2, `${ch}/${other}: ${parts.length} halves`);
      assert.ok(/[一-鿿]/.test(parts[1]), 'the second half must be the Chinese one');
      assert.ok(!/[一-鿿]/.test(parts[0]), 'the first half must be the English one');
    }
  }
});

it('points at the other channel when there is one, and does not when there is not', async () => {
  const { ctx } = sandbox({ ok: true });
  assert.match(ctx.codeSendFailedMessage('sms', true), /try email instead/);
  assert.match(ctx.codeSendFailedMessage('email', true), /try SMS instead/);
  assert.match(ctx.codeSendFailedMessage('sms', false), /try again in a moment/);
  assert.doesNotMatch(ctx.codeSendFailedMessage('sms', false), /instead/);
});

it('does not repeat the provider’s error to the operator', async () => {
  const { ctx } = sandbox({ ok: true });
  // The Aliyun / Resend code means nothing to the person reading it, and it is
  // already in the send record for whoever goes looking.
  for (const ch of ['sms', 'email']) {
    assert.doesNotMatch(ctx.codeSendFailedMessage(ch, false), /isv\.|resend_|_threw/);
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe call sites — every one of them goes through it');

it('no send is wrapped in a bare catch any more', () => {
  assert.doesNotMatch(authSrc, /await\s+aliyunSms\.sendOtpSms\([^)]*\);\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/);
  assert.doesNotMatch(authSrc, /await\s+emailSender\.sendOtpEmail\([^)]*\);\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/);
});

it('every send in the file has its result looked at', () => {
  // Not "only sendLoginCode may send" — the phone- and email-verification
  // paths call the senders directly and have always checked the answer. The
  // rule is the one that was broken: a send whose result nothing reads.
  const lines = authSrc.split('\n');
  const sends = [];
  lines.forEach((line, i) => {
    if (/(sendOtpSms|sendOtpEmail)\s*\(/.test(line)) sends.push({ n: i + 1, line: line.trim() });
  });
  assert.ok(sends.length >= 4, `expected at least 4 send sites, found ${sends.length}`);
  for (const s of sends) {
    const used = /(?:const|let|var)\s+\w+\s*=\s*await/.test(s.line)   // r = await send(…)
              || /^[?:]\s*await/.test(s.line);                          // the ternary in sendLoginCode
    assert.ok(used, `backend-auth.js:${s.n} sends and drops the answer — ${s.line}`);
  }
});

it('all three code paths call it', () => {
  assert.strictEqual((authSrc.match(/\bsendLoginCode\s*\(/g) || []).length - 1, 3,
    'expected the sign-in, the channel picker and the password reset');
});

it('sign-in tells the operator when the code did not go out', () => {
  assert.match(authSrc, /sendFailed:\s*true,\s*error:\s*codeSendFailedMessage\(channel,\s*false\)/);
});

it('the channel picker hands the choice BACK when its channel fails', () => {
  // Otherwise `pending.channel` stays set, and the operator's next pick — the
  // one channel that still works — is answered with "your sign-in expired".
  const at = authSrc.indexOf('if (!sent.ok) {');
  assert.ok(at > 0, 'the picker no longer has a failure branch');
  const branch = authSrc.slice(at, at + 700);
  assert.match(branch, /pending\.channel\s*=\s*null/);
  assert.match(branch, /req\.session\.pending2fa\s*=\s*pending/);
  assert.match(branch, /codeSendFailedMessage\(channel,/);
});

it('a failed send does NOT sign the operator in without a code', () => {
  // The fail-open above it is for a channel that is not SET UP. A channel that
  // is on and momentarily failing must not become a two-step bypass.
  const at = authSrc.indexOf('const sent = await sendLoginCode(channel, u, code');
  assert.ok(at > 0);
  const after = authSrc.slice(at, authSrc.indexOf('// No deliverable channel', at));
  assert.doesNotMatch(after, /req\.session\.backendUserId\s*=/);
  assert.match(after, /success:\s*false,\s*twofa:\s*true/);
});

it('the password reset still answers the same for every username', () => {
  const at = authSrc.indexOf("router.post('/api/backend/password-reset/start'");
  assert.ok(at > 0);
  const handler = authSrc.slice(at, authSrc.indexOf("router.post('/api/backend/password-reset/confirm'"));
  assert.match(handler, /await sendLoginCode\('email'/);
  // Telling a stranger "that address bounced" is telling them the username
  // exists. The failure goes to the send record, not to the response.
  assert.doesNotMatch(handler, /sendFailed/);
  assert.strictEqual((handler.match(/res\.json\(generic\)/g) || []).length, 3);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe sign-in page shows it');

it('the code step opens with the reason on it instead of a false promise', () => {
  assert.match(loginSrc, /showTwofa\(j\.hint,\s*j\.sendFailed\s*\?\s*pickErr\(j\.error\)\s*:\s*''\)/);
  assert.match(loginSrc, /function showTwofa\(hint,\s*warn\)/);
});

it('showTwofa clears a stale warning when the next send works', () => {
  const at = loginSrc.indexOf('function showTwofa(hint, warn)');
  const body = loginSrc.slice(at, at + 500);
  assert.match(body, /else\s*\{\s*twofaErr\.classList\.remove\('show'\)/);
});

it('the channel picker leaves both buttons usable after a failure', () => {
  // Already true — the picker re-enables them on any non-success — and it is
  // the half that makes "try email instead" actionable, so it is asserted.
  const at = loginSrc.indexOf("fetch('/api/backend/login/2fa/channel'");
  const body = loginSrc.slice(at, at + 900);
  assert.match(body, /o\.disabled = false/);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nlib/aliyun-sms — the OTP path records what it did');

it('an unconfigured OTP template is a recorded failure, not a silent one', async () => {
  logged.length = 0;
  const r = await aliyun.sendOtpSms('13800138000', '123456', null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'aliyun_otp_not_configured');
  assert.strictEqual(logged.length, 1, 'the exit that fires when SMS two-step is on with no template must be recorded');
  assert.strictEqual(logged[0].channel, 'sms');
  assert.strictEqual(logged[0].kind, 'signin_code');
  assert.strictEqual(logged[0].ok, false);
});

it('the record masks the number down to its last four digits', async () => {
  logged.length = 0;
  await aliyun.sendOtpSms('13800138000', '123456', null);
  assert.strictEqual(logged[0].recipient, '•••• 8000');
  assert.doesNotMatch(String(logged[0].recipient), /13800138000/);
});

it('the code itself is never written to the record', async () => {
  logged.length = 0;
  await aliyun.sendOtpSms('13800138000', '424242', null);
  assert.doesNotMatch(JSON.stringify(logged[0]), /424242/);
});

it('a configured send is tagged by what it was, not by the Aliyun template code', () => {
  // sendSms falls back to the raw templateCode when nothing names the send —
  // 'SMS_123456789' identifies the template to Aliyun and nothing to a person.
  const src = read('lib/aliyun-sms.js');
  const at = src.indexOf('async function sendOtpSms');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(body, /kind:\s*'signin_code'/);
});

it('the email sender separates a sign-in code from a password reset', () => {
  const src = read('lib/email-sender.js');
  assert.match(src, /const kind = \(opts && opts\.kind\) \|\| 'signin_code'/);
  assert.match(src, /kind === 'password_reset_code' \? 'Password reset code' : 'Sign-in code'/);
});

// ─────────────────────────────────────────────────────────────────────────
runAll().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
});
