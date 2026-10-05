'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   THE EVENING BEFORE, THE KITCHEN'S GROUP IS TOLD WHAT TO MAKE — §432.
   ──────────────────────────────────────────────────────────────────────────
   §101 raises one kitchen request at the morning hour (06:00 by default) from
   what customers have already ordered, and it prints. That is the right time
   for the slip and the wrong time to find out: the kitchen plans the night
   before. Ash: a bot message in a group "a day before 8:30pm with the fresh
   meals need to prepare the next day", and "if after 8:30pm there are more
   orders coming in you can just push another message".

   ── THE LIST IS THE SLIP'S LIST, NOT A SECOND ONE ──────────────────────────

   The lines come from `owedLines` in lib/kitchen-morning-request.js — the
   function the 06:00 request is built from, called with the date that
   request will be raised for. So the evening message and the morning slip
   cannot disagree about what counts, only about WHEN they looked: an order at
   23:00 is on the slip and not in the 20:30 message. That gap is why the
   message says it is a preview, and why updates follow it.

   ── WHEN ───────────────────────────────────────────────────────────────────

   From the send time (20:30 by default) until the morning hour the slip
   prints at. The date the message is about is tomorrow before midnight and
   today after it — it is always "the morning the next slip prints", which is
   why the message names a date rather than saying "tomorrow".

   The first message in that window is the preview. After it, the list is
   re-read and an update is sent only when it CHANGED — and no sooner than
   UPDATE_GAP_MIN after the previous message, so a run of orders at 23:00 is
   one update, not six pings in a WeCom group at night.

   Nothing to make → nothing is sent (Ash: "stay quiet"). The one exception is
   a list that EMPTIES after a preview went out: the group was told to make
   something, and silence would leave them making it.

   No morning request (the hour is blank) → nothing is sent. There is no slip
   for the message to be a preview of, and its own text would say one prints.

   ── WHERE ──────────────────────────────────────────────────────────────────

   Its own WeCom group-bot webhook, NOT the new-order alert's: Ash keeps a
   separate group for this. Stored under the private `kitchen.` prefix so the
   public storefront config never serves it (a webhook key is a licence to
   post into that group).

   ── THE ONCE-GUARD IS THE DATABASE ─────────────────────────────────────────

   §101's reason, and the same table shape: a rebuilt container must not send
   the preview a second time. Every attempt is a `kitchen_prep_messages` row,
   claimed BEFORE the send so two ticks cannot both send, and closed with its
   outcome after. The comparison for "did it change" is against the last row
   that LANDED, so a failed update is retried rather than forgotten.
   ══════════════════════════════════════════════════════════════════════════ */

const morning      = require('./kitchen-morning-request');
const businessDate = require('./business-date');

const KEY_WEBHOOK = 'kitchen.prep_webhook';
const KEY_TIME    = 'kitchen.prep_time';

// Ash's time. An absent key is this; a blank key is off — the same split
// §101 draws for the morning hour, for the same reason.
const DEFAULT_TIME = '20:30';

// An evening setting. A time before noon would sit on the wrong side of the
// morning slip and make "which morning is this about" ambiguous.
const EARLIEST_HOUR = 12;

// The least time between two messages for the same morning, and the retry
// spacing after a send that failed.
const UPDATE_GAP_MIN = 30;
const RETRY_GAP_MIN  = 10;

// WeCom refuses a markdown body over 4096 bytes. Fresh lines are a handful;
// this is the guard for the day they are not.
const MAX_BYTES = 4000;

const WEBHOOK_HOST = 'qyapi.weixin.qq.com';

function _cfg(db, key) {
  try {
    const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!row) return undefined;
    try { return JSON.parse(row.value_json); } catch (e) { return row.value_json; }
  } catch (e) { return null; }
}

/* A WeCom group-bot URL, or null. The host is allowlisted exactly as the
   new-order webhook's is (routes/retail.js wecomWebhookUrl). */
function validWebhook(v) {
  const u = String(v == null ? '' : v).trim();
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' || p.hostname !== WEBHOOK_HOST) return null;
    return u;
  } catch (e) { return null; }
}

/* "HH:MM" → minutes after midnight, or null when it is not an evening time. */
function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < EARLIEST_HOUR || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/* The saved settings, as the screen shows them. `time` is '' when off. */
function loadSettings(db) {
  const rawTime = _cfg(db, KEY_TIME);
  const time = rawTime === undefined ? DEFAULT_TIME
    : (rawTime == null || rawTime === '') ? '' : String(rawTime);
  const hook = _cfg(db, KEY_WEBHOOK);
  return { webhook: hook == null ? '' : String(hook), time };
}

function _nextYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/* Which morning's slip the clock is in front of, or null outside the window.
   After the send time: tomorrow's. After midnight and before the morning
   hour: today's. Between the morning hour and the send time: none. */
function targetDate(parts, sendMin, morningHour) {
  const nowMin = parts.hour * 60 + parts.minute;
  if (nowMin >= sendMin) return _nextYmd(parts.ymd);
  if (parts.hour < morningHour) return parts.ymd;
  return null;
}

/* The slip's lines, reduced to what is compared and shown. Keyed on SKU, then
   name — the order §61 matches kitchen lines in. */
function snapshot(lines) {
  return (lines || []).map((l) => ({
    key: l.sku || l.product_name,
    en: l.product_name || '',
    cn: l.product_cn || '',
    qty: Number(l.qty_requested) || 0,
  }));
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((x) => [x.key, x.qty]));
  return b.every((x) => m.get(x.key) === x.qty);
}

function _name(l) {
  if (l.cn && l.en && l.cn !== l.en) return `${l.cn} ${l.en}`;
  return l.cn || l.en || l.key;
}

/* The markdown body. Both languages on every line, as every WeCom card in
   routes/retail.js is: the group is a room, not a person with a setting.
   Chinese — docs/tacet-delivery-vocabulary.md v1.314. */
function buildContent({ kind, date, lines, prev, morningHour }) {
  const slipAt = `${String(morningHour).padStart(2, '0')}:00`;
  const head = kind === 'update'
    ? `**🔄 待制作已更新 · To make, updated — ${date}**`
    : `**🍳 待制作 · To make — ${date}**`;
  const out = [head, `> 预览,最终清单于 ${slipAt} 打印 · Preview — the final list prints at ${slipAt}`];

  const before = new Map((prev || []).map((l) => [l.key, l]));
  if (!lines.length) out.push('> 目前无需制作 · Nothing to make now');
  for (const l of lines) {
    let line = `> ${_name(l)} × ${l.qty}`;
    if (kind === 'update') {
      const was = before.has(l.key) ? before.get(l.key).qty : 0;
      if (l.qty !== was) {
        const d = l.qty - was;
        line += ` <font color="warning">(${d > 0 ? '+' : '−'}${Math.abs(d)})</font>`;
      }
    }
    out.push(line);
  }
  // A line that was in the last message and is gone now is shown at zero, so
  // nobody keeps making it on the strength of the earlier one.
  if (kind === 'update') {
    const now = new Set(lines.map((l) => l.key));
    for (const p of prev || []) {
      if (!now.has(p.key)) out.push(`> ${_name(p)} × 0 <font color="comment">(−${p.qty})</font>`);
    }
  }

  let body = out.join('\n');
  while (Buffer.byteLength(body, 'utf8') > MAX_BYTES && out.length > 3) {
    out.splice(out.length - 1, 1);
    body = out.concat('> …').join('\n');
  }
  return body;
}

function _lastLanded(db, date) {
  const r = db.prepare(
    `SELECT lines_json FROM kitchen_prep_messages
      WHERE prep_date = ? AND ok = 1 ORDER BY id DESC LIMIT 1`
  ).get(date);
  if (!r) return null;
  try { return JSON.parse(r.lines_json) || []; } catch (e) { return []; }
}

/* Minutes since the last attempt for this morning, and whether it failed. A
   row still open (ok NULL) counts as sent — it is either in flight or was cut
   off mid-send, and neither is a reason to send again at once. */
function _lastAttempt(db, date, now) {
  const r = db.prepare(
    `SELECT ok, sent_at FROM kitchen_prep_messages
      WHERE prep_date = ? ORDER BY id DESC LIMIT 1`
  ).get(date);
  if (!r) return null;
  const at = Date.parse(String(r.sent_at).replace(' ', 'T') + 'Z');
  const mins = Number.isFinite(at) ? (now.getTime() - at) / 60000 : Infinity;
  return { mins, failed: r.ok === 0 };
}

/* Decide, and claim. Returns { skipped: <reason> } or
   { id, url, content, kind, date, lines }, having already written the row
   the send will close. Synchronous on purpose: everything here reads the
   tenant's handle, which a callback after the network round-trip no longer
   has. */
function planPrepMessage(db, opts = {}) {
  const { now = new Date(), tz = null } = opts;

  const s = loadSettings(db);
  const url = validWebhook(s.webhook);
  if (!url) return { skipped: 'no_webhook' };
  const sendMin = parseTime(s.time);
  if (sendMin == null) return { skipped: 'off' };
  const morningHour = morning.configuredHour(db);
  if (morningHour == null) return { skipped: 'morning_off' };

  const parts = businessDate.zoneParts(tz || businessDate.shopTimezone(db), now);
  const date = targetDate(parts, sendMin, morningHour);
  if (!date) return { skipped: 'not_due' };

  let last, prev;
  try {
    last = _lastAttempt(db, date, now);
    prev = _lastLanded(db, date);
  } catch (e) {
    // The table is missing on an un-migrated account: not one to post from.
    return { skipped: 'no_table' };
  }
  if (last && last.mins < (last.failed ? RETRY_GAP_MIN : UPDATE_GAP_MIN)) return { skipped: 'too_soon' };

  const lines = snapshot(morning.owedLines(db, { today: date }));
  let kind;
  if (prev == null) {
    if (!lines.length) return { skipped: 'nothing_to_make' };
    kind = 'preview';
  } else {
    if (sameList(prev, lines)) return { skipped: 'unchanged' };
    // Went from nothing to nothing is caught above; empty-after-something is
    // the one quiet case that still speaks (see the header).
    kind = 'update';
  }

  const content = buildContent({ kind, date, lines, prev, morningHour });
  const id = db.prepare(
    `INSERT INTO kitchen_prep_messages (prep_date, kind, lines_json, sent_at)
     VALUES (?, ?, ?, ?)`
  ).run(date, kind, JSON.stringify(lines),
    now.toISOString().replace('T', ' ').slice(0, 19)).lastInsertRowid;
  return { id, url, content, kind, date, lines };
}

/* Close the claimed row with what happened. */
function recordResult(db, id, r) {
  try {
    db.prepare('UPDATE kitchen_prep_messages SET ok = ?, error = ? WHERE id = ?')
      .run(r && r.ok ? 1 : 0, r && r.ok ? null : String((r && r.msg) || 'failed').slice(0, 300), id);
  } catch (e) { /* the send already happened or didn't; the row is advisory now */ }
}

/* Plan, send, record. `post(url, content)` resolves to {ok, msg} and never
   throws — routes/retail.js postWecomMarkdown, injected rather than copied. */
async function runPrepMessage(db, opts = {}) {
  const { post } = opts;
  const plan = planPrepMessage(db, opts);
  if (plan.skipped) return plan;
  let r;
  try { r = await post(plan.url, plan.content); }
  catch (e) { r = { ok: false, msg: e.message }; }
  recordResult(db, plan.id, r);
  return { ...plan, ok: !!(r && r.ok), error: r && r.ok ? null : (r && r.msg) };
}

/* ── The sweeper ───────────────────────────────────────────────────────────
   Every minute, per tenant, inside the tenant's scope — the morning sweeper's
   arrangement (lib/kitchen-morning-request.js) and for its reason. The handle
   is taken inside the scope and carried through the await, so the row is
   closed on the tenant it was claimed on. */
function startPrepMessageSweeper(ctx = {}, { intervalMs = 60_000 } = {}) {
  const { tdb, tenantAls, rawTenantDb, getTenantDb, ROOTS_TENANT_ID, DATA_ISOLATION_READY }
    = require('./tenant-db');
  const { post, onSent } = ctx;
  if (typeof post !== 'function') throw new Error('startPrepMessageSweeper needs post');

  const sweepScope = (label) => {
    let db;
    try { db = tdb(); } catch (e) { return; /* no handle for this scope: nothing can be read or sent, and the next tick tries again */ }
    runPrepMessage(db, { post })
      .then((res) => {
        if (!res || res.skipped) return;
        if (res.ok) console.log(`[kitchen.prep] ${label} ${res.kind} ${res.date} lines=${res.lines.length}`);
        else console.warn(`[kitchen.prep] ${label} ${res.kind} ${res.date} failed`, res.error);
        if (typeof onSent === 'function') {
          try { onSent(res, label); } catch (e) { /* onSent only logs; the send and its row are already done, so a logging fault must not surface as a send failure */ }
        }
      })
      .catch((e) => console.error(`[kitchen.prep] ${label} error`, e.message));
  };

  const activeNonRootsTenantIds = () => {
    try {
      return getTenantDb(ROOTS_TENANT_ID)
        .prepare("SELECT id FROM tenants WHERE status = 'active' AND id != ?")
        .all(ROOTS_TENANT_ID)
        .map((r) => Number(r.id))
        .filter(Boolean);
    } catch (e) {
      console.error('[kitchen.prep] tenant list failed', e.message);
      return [];
    }
  };

  const tick = () => {
    sweepScope('roots');
    if (DATA_ISOLATION_READY) {
      for (const id of activeNonRootsTenantIds()) {
        try { tenantAls.run(rawTenantDb(id), () => sweepScope('tenant ' + id)); }
        catch (e) { console.error('[kitchen.prep] tenant ' + id + ' failed', e.message); }
      }
    }
  };

  // Not at boot, for the morning sweeper's reason: a deploy at 20:31 would
  // otherwise send the moment the process came up.
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  KEY_WEBHOOK,
  KEY_TIME,
  DEFAULT_TIME,
  EARLIEST_HOUR,
  UPDATE_GAP_MIN,
  RETRY_GAP_MIN,
  validWebhook,
  parseTime,
  loadSettings,
  targetDate,
  snapshot,
  buildContent,
  planPrepMessage,
  recordResult,
  runPrepMessage,
  startPrepMessageSweeper,
};
