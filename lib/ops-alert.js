'use strict';

// Best-effort ops alerting to a WeCom group robot (企业微信群机器人) webhook.
//
// The destination is configured in retail-admin → Settings → Push notifications →
// "System Alerts" — a DEDICATED WeCom group, deliberately kept SEPARATE from the
// order group. Stored in storefront_config as `system_alerts.enabled` +
// `system_alerts.wecom_webhook`. Disabled or unset = silently no-op: alerting NEVER
// blocks or crashes a daemon, and it NEVER falls back to the order webhook. Used to
// page ops the moment a Meituan/闪购 channel disconnects (login expired, risk-control,
// proxy down) or the storefront stops responding, and again on recovery.
//
// Set it up: create a NEW WeCom group → ··· → 添加群机器人 → copy the Webhook URL, paste
// it in Settings, toggle System Alerts on, and use "Send test" to verify it lands.
//
// Config is read via a lightweight READ-ONLY sqlite open — NOT require('../database'),
// which runs schema+migrations on load and would do so on every health-watchdog tick.
//
// THREE STATES, NOT TWO. "Alerting is switched off" and "the configuration could
// not be read" are different facts and used to collapse into the same message.
// After F1 renames data/roots.db every alert became
//   [ops-alert] SUPPRESSED (alerts disabled)
// which is not merely unhelpful, it is WRONG: it sends whoever reads it to
// retail-admin -> Settings to turn something back on that was never off. On the
// night that is the layer PART H reads to decide flip-or-roll-back.

const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, '..', 'data', 'roots.db');
// Cached read-only connections, KEYED BY PATH. One entry until this module
// learned to read a second account's settings (audit D-02); the inode
// revalidation below is per-path for exactly the same reason it existed for one.
const _ro = new Map();    // dbFile -> connection
const _roIno = new Map(); // dbFile -> the inode it was opened on

function roConfig(key) { return roConfigFrom(DB_FILE, key); }

function roConfigFrom(dbFile, key) {
  try {
    // REVALIDATE BEFORE USE, and this is not defensive habit — it is the whole
    // difference between alerting failing and alerting failing SILENTLY ON HALF
    // THE FLEET.
    //
    // F1 RENAMES data/roots.db rather than deleting it, and renaming a file does
    // not invalidate an open fd. Without this check a process that opened the
    // handle BEFORE the rename goes on reading the renamed inode and goes on
    // paging normally, while a process started AFTER it cannot open the path at
    // all and goes quiet. Alerts still arriving from four daemons read as a
    // working channel, so nobody checks the two whose pages are being dropped.
    // Partial silence is worse than total silence, because total silence is
    // noticed.
    //
    // One stat per call buys uniformity: the inode AT THE PATH is exactly what a
    // rename changes, so this detects it precisely and cheaply. Reopening per
    // call would also work and was rejected — it re-opens the database during an
    // incident, which is the moment the disk is least likely to answer.
    const st = fs.statSync(dbFile, { throwIfNoEntry: false });
    if (!st) throw new Error(`${dbFile} is not there (renamed or removed)`);
    const cached = _ro.get(dbFile);
    const cachedIno = _roIno.get(dbFile);
    if (cached && cachedIno !== undefined && st.ino !== cachedIno) {
      try { cached.close(); } catch (_) { /* a handle to a renamed file; closing it is not news */ }
      _ro.delete(dbFile);
      _roIno.delete(dbFile);
    }
    if (!_ro.has(dbFile)) {
      const Database = require('better-sqlite3');
      _ro.set(dbFile, new Database(dbFile, { readonly: true, fileMustExist: true }));
      _roIno.set(dbFile, st.ino);
    }
    const row = _ro.get(dbFile).prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return { ok: true, value: row ? JSON.parse(row.value_json) : null };
  } catch (e) {
    // Drop the handle so the next call reopens rather than reusing a broken one.
    // The staggered-failure hazard is handled by the inode check above, not here.
    _ro.delete(dbFile);
    _roIno.delete(dbFile);
    return { ok: false, why: (e && e.message) || String(e) };
  }
}


// ── the mirror file, and why the webhook does not live only in the database ──
//
// F1 renames data/roots.db. Everything above is about reporting that honestly;
// this is about surviving it. CONF_FILE is a small mirror of the two settings
// that decide whether anyone gets paged, written by this module whenever it
// reads them successfully, and read in preference to the database.
//
// WHERE IT LIVES MATTERS AS MUCH AS THAT IT EXISTS. Outside /root/roots-v2
// entirely:
//   * public/ is served at /assets, so a webhook under it would be world-
//     fetchable — an open channel into the ops group. That is not hypothetical:
//     2.14 MB of stale admin front-end was fetchable over HTTPS until 2026-08-23.
//   * the installer only ever COPIES, so anything inside the tree survives its
//     own deletion forever.
//   * a rollback rewrites the tree and would take the file with it.
//
// 0600 root:root, written atomically (temp + rename) so a half-written file is
// never observable and concurrent daemons cannot interleave.
//
// PRECEDENCE, AND THE ONE DEVIATION FROM "ABSENT MEANS THE THIRD STATE".
// The file wins when it is present. When it is ABSENT the database is used and
// the fact is reported — because a box that has not booted since this shipped
// has no file yet, and making that a hard fault would silence every alert on
// every such box for the sake of a rule. What must never happen is absent
// reading as SWITCHED OFF, and it does not: absent-and-database-unreadable is
// the third state, loudly.
//
// DISAGREEMENT IS REPORTED, NEVER RESOLVED QUIETLY. Two sources of truth is a
// bug the moment nobody can tell which one answered.
const CONF_FILE = '/root/ops-alert.conf';

function readConf() {
  let raw;
  try {
    raw = fs.readFileSync(CONF_FILE, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false };
    // Present but unreadable is NOT absent: permissions, a bad mount, a
    // truncated write. Say which.
    return { present: true, broken: true, why: (e && e.message) || String(e) };
  }
  try {
    const j = JSON.parse(raw);
    return { present: true, enabled: j.enabled === true, webhook: String(j.webhook || '') };
  } catch (e) {
    return { present: true, broken: true, why: `unparseable: ${(e && e.message) || e}` };
  }
}

// Keep the mirror in step. Called on every successful database read, so a fresh
// box heals itself the first time any process asks — which in practice is boot,
// because scripts/qingyun-daemon.js calls alertEnabled() in main(). Writes only
// when the content actually differs, so this is a no-op stat on the hot path.
function syncConf(enabled, webhook) {
  try {
    const want = JSON.stringify({ enabled: !!enabled, webhook: webhook || '' });
    let have = null;
    try { have = fs.readFileSync(CONF_FILE, 'utf8'); } catch (_) { /* absent */ }
    if (have === want) return;
    const tmp = `${CONF_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, want, { mode: 0o600 });
    fs.renameSync(tmp, CONF_FILE);          // atomic within the filesystem
  } catch (e) {
    // Never let mirroring break alerting. Say it once, at error level.
    console.error(`[ops-alert] could not write ${CONF_FILE}: ${(e && e.message) || e}`);
  }
}

// Resolve the System-Alerts webhook from settings.
//
// Returns { url, unreadable, why }. `url` is '' when the feature is off,
// unconfigured, or points anywhere other than qyapi.weixin.qq.com — all of which
// are DELIBERATE states. `unreadable` is true only when the configuration could
// not be read at all, which is a fault and must never be reported as a setting.
function normalise(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const url = /^https?:\/\//i.test(s)
      ? s
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${s}`;
    if (new URL(url).hostname !== 'qyapi.weixin.qq.com') return '';
    return url;
  } catch (_) { return ''; }
}

function webhookStatus() {
  const conf = readConf();
  const en = roConfig('system_alerts.enabled');
  const hook = en.ok && en.value === true ? roConfig('system_alerts.wecom_webhook') : null;
  const dbReadable = en.ok && (hook === null || hook.ok);
  const dbUrl = en.ok && en.value === true && hook && hook.ok ? normalise(hook.value) : '';

  if (conf.present && !conf.broken) {
    const fileUrl = conf.enabled ? normalise(conf.webhook) : '';
    // Two sources of truth is a bug the moment nobody can tell which answered.
    if (dbReadable && fileUrl !== dbUrl) {
      const describe = (u) => (u ? `enabled -> ...${u.slice(-8)}` : 'off/unset');
      console.error(`[ops-alert] ${CONF_FILE} and the database DISAGREE about where alerts go `
        + `— file: ${describe(fileUrl)}; database: ${describe(dbUrl)}. USING THE FILE, because it `
        + 'is the one that survives F1. If that is the wrong destination, fix the file — do not '
        + 'wait for the database to win, it will not.');
    }
    return { url: fileUrl, unreadable: false, source: CONF_FILE };
  }

  if (conf.present && conf.broken) {
    // Present and unreadable. Fall through to the database rather than going
    // silent, but never let this pass unremarked.
    console.error(`[ops-alert] ${CONF_FILE} exists and cannot be read (${conf.why}) `
      + '— falling back to the database.');
  }

  if (!en.ok) return { url: '', unreadable: true, why: en.why, source: 'database' };
  if (en.value !== true) { syncConf(false, ''); return { url: '', unreadable: false, source: 'database' }; }
  if (!hook.ok) return { url: '', unreadable: true, why: hook.why, source: 'database' };

  const raw = String(hook.value || '').trim();
  const url = normalise(raw);
  // The database answered, so refresh the mirror. A fresh box heals here.
  syncConf(!!url, url);
  return { url, unreadable: false, source: 'database' };
}

function webhookUrl() { return webhookStatus().url; }

// Anti-spam: drop an identical message seen within DEDUP_MS (a safety net on top
// of the daemons' own once-per-transition latches).
const DEDUP_MS = 60_000;
const lastSent = new Map(); // text -> epochMs

// Asia/Shanghai HH:mm, independent of server TZ — staff read local time.
function shTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// One POST. Returns { ok, retry, why } — never throws.
//
// WeCom answers HTTP 200 for everything it understands, INCLUDING a webhook key it
// refuses ({"errcode":93000,"errmsg":"invalid webhook url"}). This used to test
// res.ok alone, so a revoked, rotated or mistyped key reported every alert as
// delivered while nothing arrived — silently, forever, which is the one failure mode
// alerting must not have. errcode 0 is the only success.
const SEND_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url, content) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      // A daemon paging about a dead channel must not itself hang on the page.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (e) {
    // DNS/TLS/timeout. Worth another go: on 2026-08-07 a blip of about three minutes
    // took out all three daemons' alerts at once and every one was dropped on the
    // first try, leaving the page nowhere but a log line nobody reads.
    return { ok: false, retry: true, why: e.message || 'fetch failed' };
  }
  if (!res.ok) {
    return { ok: false, retry: res.status >= 500 || res.status === 429, why: `HTTP ${res.status}` };
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON — refused below */ }
  if (body && body.errcode === 0) return { ok: true };
  const code = body ? body.errcode : 'unparseable response';
  return { ok: false, retry: false, why: `errcode ${code}${body && body.errmsg ? ' ' + body.errmsg : ''}` };
}

// Retry the transient, give up at once on the refused. Exported for tests.
async function deliver(url, content) {
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    const r = await postOnce(url, content);
    if (r.ok) return { ok: true, attempts: attempt };
    if (!r.retry || attempt === SEND_ATTEMPTS) return { ok: false, attempts: attempt, why: r.why };
    await sleep(RETRY_BACKOFF_MS * attempt);
  }
  return { ok: false, attempts: SEND_ATTEMPTS, why: 'exhausted' };
}

// Fire-and-forget. Returns a promise that resolves true/false; callers may ignore.
async function sendOpsAlert(text) {
  const st = webhookStatus();
  const url = st.url;
  if (!text) return false;
  if (!url && st.unreadable) {
    // The fault case, and it must not read like the setting case. Name the file,
    // name the error, and say plainly that nobody was paged.
    console.error(`[ops-alert] CANNOT READ ALERT CONFIG (${st.why}) — alerting is NOT `
      + `switched off; ${DB_FILE} could not be read. NOBODY WAS PAGED: ${text}`);
    return false;
  }
  if (!url) {
    // A disabled webhook used to be an invisible no-op. That is fine for a
    // recovery notice and wrong for everything else: the callers that reach here
    // are reporting something nobody else will report — an order the courier
    // push gave up on, a channel that logged out. Losing the message silently
    // means the only record is a daemon log nobody is watching. Say so, at error
    // level, with the text intact, so it is still recoverable from the log.
    console.error(`[ops-alert] SUPPRESSED (alerts switched off in Settings): ${text}`);
    return false;
  }
  const now = Date.now();
  const prev = lastSent.get(text);
  if (prev && now - prev < DEDUP_MS) return false;
  lastSent.set(text, now);
  const content = `[${shTime()}] ${text}`;
  const r = await deliver(url, content);
  if (r.ok) return true;
  // Say what happened AND what was lost. The old line was just "send failed: fetch
  // failed", which names neither the alert nor whether anyone should act.
  console.error(`[ops-alert] NOT DELIVERED after ${r.attempts} attempt(s) (${r.why}): ${text}`);
  // It never landed, so it must not count as already-sent: leaving it in the dedup
  // map would make the caller's next attempt inside the window a silent no-op, and
  // the page would be lost a second time by our own anti-spam.
  lastSent.delete(text);
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
   THE MERCHANT'S OWN ALERTS (audit D-02 / P-01)

   Everything above resolves ONE destination — the platform's operations group —
   out of ONE database file, data/roots.db, opened by path. That is account 1's
   database. A second account's `system_alerts.*` settings live in their own
   file and were never read, so their alerts had nowhere to go: a merchant's
   storefront could stop responding and the message would be addressed to the
   first merchant's group or dropped.

   THE RULE, decided 2026-09-05: an alert about a MERCHANT'S day goes to that
   merchant, and falls back to the platform's group when they have not set a
   chat app up. A merchant who never configured one should still not have their
   own shop go down unnoticed — and the platform is the only party who can act
   on their behalf.

   WHAT STAYS ON sendOpsAlert, and this is the load-bearing half of the split:
   anything only the platform can act on. The box is down, a process crashed, a
   route 500'd, a merchant is REQUESTING something from you. Those are not the
   merchant's problem and telling them would be noise they cannot use.

   ── THE MIRROR FILE IS DELIBERATELY NOT EXTENDED TO TENANTS ──────────────
   /root/ops-alert.conf exists so the PLATFORM's destination survives F1
   renaming the main database. It holds one destination, at 0600 root:root, and
   mirroring every merchant's webhook into it would widen a secret store for no
   gain: a tenant read that fails falls back to sendOpsAlert, which reads the
   mirror, which is the path that survives. So the survivable channel stays
   survivable and the per-merchant one is best-effort by design, not by neglect.
   ══════════════════════════════════════════════════════════════════════════ */

// Which file holds an account's settings. Account 1 IS the main database — the
// same identity lib/tenant-db.js keeps, so tenant 1 resolves exactly as this
// module always has, mirror file and all.
function tenantDbFile(tenantId) {
  const id = parseInt(tenantId, 10);
  if (!Number.isFinite(id) || id === 1) return DB_FILE;
  return path.join(__dirname, '..', 'data', 'tenants', `${id}.db`);
}

// The merchant's own System-Alerts webhook, or '' when they have not set one up.
// No mirror, no third state: an unreadable tenant database is reported and then
// treated as "not configured", because the fallback below is a real destination
// and going silent to preserve a distinction would defeat the point.
function tenantWebhookUrl(tenantId) {
  const file = tenantDbFile(tenantId);
  if (file === DB_FILE) {
    // Account 1's destination IS the platform's, and it has the mirror. Reading
    // it twice by two routes is how the two would eventually disagree.
    return webhookStatus().url;
  }
  const en = roConfigFrom(file, 'system_alerts.enabled');
  if (!en.ok) {
    console.error(`[ops-alert] could not read account ${tenantId}'s alert settings (${en.why}) `
      + '— falling back to the platform group.');
    return '';
  }
  if (en.value !== true) return '';
  const hook = roConfigFrom(file, 'system_alerts.wecom_webhook');
  if (!hook.ok) {
    console.error(`[ops-alert] could not read account ${tenantId}'s alert webhook (${hook.why}) `
      + '— falling back to the platform group.');
    return '';
  }
  return normalise(hook.value);
}

/**
 * Send an alert about ONE MERCHANT'S day to that merchant, falling back to the
 * platform's group when they have no chat app configured.
 *
 * `tenantId` null or unknown means the caller could not name an account — which
 * is itself the platform's problem to look at — so it goes to the platform
 * group rather than being guessed at.
 *
 * Returns the same true/false sendOpsAlert does. Never throws.
 */
async function sendTenantAlert(tenantId, text) {
  if (!text) return false;
  let url = '';
  try { url = tenantWebhookUrl(tenantId); }
  catch (e) { console.error('[ops-alert] tenant webhook lookup threw:', (e && e.message) || e); }
  // Not configured, or unreadable, or no account named: the platform's group,
  // which is the whole of decision (b).
  //
  // The account is NAMED on the way out. A platform group reading "storefront
  // not responding" with no account on it is useless the moment there is more
  // than one merchant — and it also keeps sendOpsAlert's dedup honest, which
  // keys on the text alone and would otherwise drop the second merchant's
  // identical message inside the window.
  if (!url) return sendOpsAlert(forPlatform(tenantId, text));
  // Account 1 resolves to the platform's own webhook, so sending "directly"
  // would bypass the dedup window and the SUPPRESSED/unreadable reporting that
  // sendOpsAlert owns. Same destination, one code path.
  if (url === webhookStatus().url) return sendOpsAlert(text);

  const now = Date.now();
  const key = `${tenantId}|${text}`;
  const prev = lastSent.get(key);
  if (prev && now - prev < DEDUP_MS) return false;
  lastSent.set(key, now);
  const r = await deliver(url, `[${shTime()}] ${text}`);
  if (r.ok) return true;
  console.error(`[ops-alert] NOT DELIVERED to account ${tenantId} after ${r.attempts} attempt(s) `
    + `(${r.why}) — falling back to the platform group: ${text}`);
  lastSent.delete(key);
  // A merchant's chat app that refuses the message is the same situation as one
  // they never configured: somebody still has to know. The platform is also
  // told that the merchant's own channel is the reason they are seeing this,
  // because a refused webhook is itself something to go and fix.
  return sendOpsAlert(forPlatform(tenantId, text, `their own chat app refused it: ${r.why}`));
}

// Label a merchant's alert for the platform group.
function forPlatform(tenantId, text, why) {
  const who = (tenantId == null || tenantId === '') ? 'account not identified' : `account ${tenantId}`;
  return `[${who}${why ? ' — ' + why : ''}]\n${text}`;
}

function alertEnabled() { return !!webhookUrl(); }

// alertEnabled() keeps its boolean contract — scripts/qingyun-daemon.js calls it
// at boot. alertStatus() is the one to use when the REASON matters.
function alertStatus() {
  const st = webhookStatus();
  return { enabled: !!st.url, unreadable: !!st.unreadable, why: st.why || '',
           source: st.source || 'database' };
}

// ══════════════════════════════════════════════════════════════════════════
//  WHOSE PROBLEM IS IT? (audit P-01)
// ══════════════════════════════════════════════════════════════════════════
// Sixty-five call sites sent everything the system noticed about a merchant's
// day to one operations group — the platform's. For the first account those may
// be the same people, which is why nobody felt it. For anybody else, the
// merchant is not told their own storefront is down.
//
// The transport for that was decided (Q3, option b) and is above:
// sendTenantAlert reaches the account's own chat app and falls back to the
// platform's. What was still missing is the CLASSIFICATION — which of the two an
// alert is — and the answer was implicit at every one of the sixty-five sites.
//
// These three names make it explicit. They are deliberately not new transports:
// they are the vocabulary, so that reading a call site tells you who is meant to
// act, and so a reviewer can disagree with a choice instead of not seeing one.
//
// THE RULE USED TO CLASSIFY, stated so it can be argued with:
//
//   alertPlatform  nobody but us can fix it, and no merchant can act on it.
//                  A crashed process, an unhandled exception, the box out of
//                  memory, our proxy fleet down, a watchdog that stopped.
//
//   alertMerchant  it is about this merchant's trading day and their staff are
//                  the ones who act. Their marketplace account logged out and
//                  needs a scan. Their listings drifted. Their orders stopped
//                  arriving. Telling only us means telling nobody who can act.
//
//   alertBoth      the merchant must know their sync is down AND we must fix
//                  the thing that broke it. A browser crash-looping on the box
//                  is the shape: their day is affected, our machine is at fault.
//                  Used sparingly — everything sent twice is everything ignored.

/** Ours to fix, and no merchant can act on it. */
function alertPlatform(text) { return sendOpsAlert(text); }

/** Theirs to act on. Falls back to the platform group — see sendTenantAlert. */
function alertMerchant(tenantId, text) { return sendTenantAlert(tenantId, text); }

/**
 * Both, once each. Returns true if EITHER landed: the merchant hearing about
 * their own outage is the half that matters, and a platform group that missed
 * one line still has the logs.
 */
async function alertBoth(tenantId, text) {
  // ONE MESSAGE WHEN THERE IS ONE DESTINATION. A merchant with no chat app of
  // their own has sendTenantAlert fall back to the platform group — and account
  // 1's chat app IS the platform's. Calling both blindly would put the same
  // line in the same room twice, which is how a group gets muted.
  let own = '';
  try { own = tenantWebhookUrl(tenantId); } catch (e) { own = ''; }
  if (!own || own === webhookStatus().url) return alertPlatform(forPlatform(tenantId, text));
  // Sequential, not Promise.all: both paths share the dedup window, and firing
  // them together would race it and drop one at random.
  const toMerchant = await alertMerchant(tenantId, text);
  const toPlatform = await alertPlatform(forPlatform(tenantId, text, 'also sent to them'));
  return toMerchant || toPlatform;
}

module.exports = {
  sendOpsAlert, sendTenantAlert, alertEnabled, alertStatus, deliver, tenantDbFile,
  alertPlatform, alertMerchant, alertBoth, forPlatform,
};
