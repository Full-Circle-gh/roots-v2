'use strict';

// What a failed stock push actually means, in words an operator can act on. §105.
//
// THE PROBLEM THIS SOLVES IS NOT A MISSING MESSAGE — IT IS A DISCARDED ONE.
// Every failure path in lib/eleme-browser.js and lib/meituan-browser.js knew
// exactly why it was giving up: an HTTP status, a fetch error, Eleme's own error
// object, Meituan's own `{code, msg}`. Several of them even logged it. Then the
// wrapper functions between them and the daemon returned `{ ok, transient }` and
// the reason went nowhere, so the queue row — the one thing an operator reads —
// said "transient push failure — retries exhausted". That is not a reason; it is
// a count of how many times we gave up. `docs/channel-mapping-findings.md` F4
// measured it appearing 17–35 times a day, every day, for two weeks.
//
// §105 threads the reason out of those two files. THIS module is the other half:
// it turns the raw sentence into a stable CODE plus the detail worth keeping, so
// every surface can say the same thing about the same failure and the client can
// word it in the operator's own language.
//
// ── WHY A CODE AND NOT A TRANSLATED SENTENCE ─────────────────────────────────
//
// The raw text is written by the browser layer in English, and some of it is the
// PLATFORM's own Chinese (Meituan's `msg`). Translating here would mean either
// shipping English to a Chinese operator or inventing Chinese for a platform's
// own words. So this returns a code; `01-core.js` holds the bilingual sentence
// for each one, beside the rest of the channel vocabulary (§103 step 5), and the
// platform's own words ride along verbatim as `detail`.
//
// ── AND WHY THE RAW TEXT IS NEVER THROWN AWAY ────────────────────────────────
//
// An unrecognised failure is the one most worth reading, because it is the one
// nobody has seen before. `code: null` with the raw text intact is a better
// answer than a confident wrong category — the same rule §30 rule 4 applies to
// a check that cannot run.

// Ordered, because the first match wins and the specific tests must precede the
// general ones — "cannot reach Meituan (HTTP 502)" is an http failure, not a
// bare unreachable one, and both contain "cannot reach".
//
// Every pattern here is anchored on a string one of the two browser modules
// actually writes, or on a shape a platform actually returns. Nothing is
// speculative: a category nobody can produce is a category that will be wrong
// the first time something does.
const RULES = [
  // The platform answered, and refused. Its own sentence is the detail — it is
  // more accurate about its own refusal than anything we could write.
  { code: 'rejected',   re: /^(?:Meituan|Eleme) refused it:\s*(.*)$/i, detail: m => m[1].trim() },

  // A reply we could not use. The status is the whole detail.
  { code: 'http',       re: /HTTP\s*(\d{3})/i,                         detail: m => m[1] },

  // The session is gone. Not a fault to retry past — a person has to sign in.
  { code: 'signed_out', re: /signed out|not logged in|no ksid|session token/i },

  // We never got a usable answer at all.
  { code: 'unreachable', re: /cannot reach|fetch error|could not open|network|timed out|timeout/i },

  // The mapping points at an option the listing no longer carries. The most
  // actionable failure on either channel: re-pick the option and it is fixed.
  { code: 'option_gone', re: /no longer on (?:this|the) listing|chosen option is no longer/i },

  // The name matches nothing. Already surfaced before §105 — kept here so the
  // classifier is complete and every surface words it the same way.
  { code: 'name_not_found', re: /no listing on this store is named|no Meituan listing has the exact name/i },

  // Nothing to compare against, so no verdict about the mapping is possible.
  { code: 'unreadable', re: /listing could not be read|catalogue unavailable/i },

  // The row gave up counting rather than explaining. This is what EVERY failure
  // used to look like; it survives only for rows written before §105 shipped and
  // for a path that genuinely has nothing to say.
  { code: 'gave_up',    re: /retries exhausted|multiple retries|多次重试仍失败/i },
];

// `raw` is a queue row's `last_error` (or a sync log's `error_msg`).
// Returns { code, detail, raw, retrying } — `code` null when nothing matched,
// which is deliberate and means "show the raw text".
function classifyPushError(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { code: null, detail: null, raw: '', retrying: false };
  // The daemon appends this to a row it is still retrying. It is a fact about
  // the row's future, not about the failure, so it is stripped before matching
  // and carried separately.
  const retrying = /—\s*will retry\s*$/i.test(text);
  const body = retrying ? text.replace(/\s*—\s*will retry\s*$/i, '').trim() : text;
  for (const r of RULES) {
    const m = body.match(r.re);
    if (m) return { code: r.code, detail: r.detail ? r.detail(m) : null, raw: body, retrying };
  }
  return { code: null, detail: null, raw: body, retrying };
}

// ── THE PLATFORM'S OWN CODES, AND WHY THERE IS NO TRANSLATION TABLE ─────────
//
// §106 asked for the obvious next thing: take Meituan's numeric `code` and say
// what to do about it. Every code the tree has ever seen was looked up first,
// and the answer was that ALL THREE are already handled BEFORE an operator can
// see them:
//
//   10002  "SET REGION QUERY ERROR" — the session lost its store binding.
//          lib/meituan-browser.js `_isBindingError` catches it, flags the
//          binding lost and returns the row TRANSIENT, so it flushes after the
//          next login instead of dying.
//   30000  "参数异常:acctId ... null" — the same lost binding, a different
//          sentence. Same catcher, same outcome.
//   10048  a 套餐 combo whose component is out of stock. Meituan is right to
//          refuse, so `_apiSetSku` treats it as HANDLED (ok, no retry); the
//          combo re-queues when the component restocks.
//
// So a what-to-do line for any of them would be a sentence no operator can
// reach — dead code that reads like coverage. What SHIPS instead is the
// evidence path: this table records what is known, `meituanCodeOf` pulls the
// code back out of a rejection sentence, and
// scripts/report_reject_codes.js counts every code the logs actually carry and
// names the ones missing from here. The table grows when a real code turns up,
// not when somebody guesses one.
//
// Un-handled codes are NOT invisible meanwhile: a rejection carries Meituan's
// own `msg` verbatim to the queue row and to every screen, which is a better
// sentence than a category we invented for a code we had never seen.
const MEITUAN_CODES = {
  10002: { means: 'session lost its store binding (SET REGION QUERY ERROR)',
           handled: 'lib/meituan-browser.js _isBindingError — transient, flags binding lost' },
  30000: { means: '参数异常:acctId … null — the same lost binding, worded differently',
           handled: 'lib/meituan-browser.js _isBindingError — transient, flags binding lost' },
  10048: { means: '套餐 combo refused because a component is out of stock',
           handled: 'lib/meituan-browser.js _apiSetSku — treated as the correct end state' },
};

// The numeric code out of a rejection sentence, or null. The shape is the one
// `_apiSetSku` writes: "Meituan refused it: <msg> (code 10048)".
function meituanCodeOf(raw) {
  const m = String(raw == null ? '' : raw).match(/\(code\s+(-?\d+)\)/i);
  return m ? Number(m[1]) : null;
}

module.exports = { classifyPushError, RULES, MEITUAN_CODES, meituanCodeOf };
