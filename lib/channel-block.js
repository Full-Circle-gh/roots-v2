'use strict';

// What is stopping a channel right now, per store. §106.
//
// A push that cannot get through usually has a CHANNEL-level cause, and the
// daemons have been recording it for as long as they have existed: a captcha
// waiting for a human (`verify_required`), the proxy unable to reach the
// platform (`proxy_down` / `proxy_stale`), a session that is signed out
// (`needs_login`), a queue that stopped draining (`queue_stalled`). Each one is
// written with the daemon's own sentence in `error_msg`.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// The algorithm was already written, once, inside `meituanStoreHealth` in
// routes/meituan-admin.js, and it has driven the Meituan tab's store lines for
// months. §105 gave every item its own failure sentence and then said "Cannot
// reach the sync service" on forty rows while THAT function, next door, already
// knew it was a captcha on 天河 since 09:14.
//
// Copying it into lib/channel-sync-items.js would have been the same mistake
// §103 step 5 spent a whole section undoing: a second copy of one rule is how
// two screens start disagreeing about one fact. So the rule moves here and both
// callers ask it. `routes/meituan-admin.js` keeps its exact semantics — the
// event lists, the recovery test and the fields it returns are unchanged, and
// scripts/test_channel_block.js pins that.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// A store is blocked when its most recent BLOCKING event (status='error') has
// not been overtaken by either a successful stock push or an explicit CLEARING
// event. Two ways to recover, because the daemons use both: some faults are
// cleared by an announcement (`verify_cleared`), others simply stop being true
// and the proof is that a push landed.
//
// ⚠️ ONLY status='error' ROWS COUNT. `poll_paused` is logged with status 'ok'
// and means "outside opening hours" — a closed store, not a broken one. Reading
// the event type alone turned 天河 amber the moment it shut for the night. That
// warning is carried over verbatim from the Meituan route, because it is the
// kind of thing that gets re-broken by someone tidying.

// Per channel: which log table, which events block, which clear it.
//
// The event names are the ones the daemons actually write — read out of
// scripts/meituan-daemon.js, scripts/eleme-daemon.js and
// scripts/guanyi-daemon.js rather than assumed to match each other. They do
// NOT: the first draft of this table gave Eleme Meituan's names and would have
// reported nothing at all for it, because Eleme calls a lost session
// `auth_required`. A channel whose daemon does not write a given event simply
// never produces that cause.
//
// Only faults that stop the STOCK PUSH are listed. Meituan's `sync_stalled` is
// about order READS and its `browser_down` about a process that restarts
// itself; neither is a reason to tell an operator their numbers are stuck.
const CHANNELS = {
  // `binding_lost` is a session that is signed in but has forgotten its shop;
  // the only fix is the same re-login, so it counts as signed out (§250). The
  // daemon's own `needs_login` / `login_restored` are new with §250 too — before
  // it, a rejected Meituan session was never logged at all.
  meituan: {
    logTable: 'meituan_sync_log',
    blocking: ['needs_login', 'binding_lost', 'verify_required', 'queue_stalled', 'proxy_stale', 'proxy_down'],
    clearing: ['login_restored', 'binding_cleared', 'verify_cleared', 'queue_resumed', 'poll_resumed', 'proxy_elected', 'proxy_up'],
  },
  // Eleme names the same two faults differently — `auth_required`, not
  // `needs_login` — and writes no proxy events at all. Taken from
  // scripts/eleme-daemon.js's four logSync calls, not from Meituan's list.
  eleme: {
    logTable: 'eleme_sync_log',
    blocking: ['auth_required', 'verify_required'],
    clearing: ['auth_recovered', 'verify_cleared'],
  },
  // GZ Grocery announces its recovery with the SAME event type as the fault,
  // status 'ok' ("session recovered"), so `needs_login` appears in both lists.
  // That is safe because clearing must be strictly LATER than the fault row: a
  // fault cannot clear itself, and a second fault re-blocks at its own stamp.
  guanyi: {
    logTable: 'guanyi_sync_log',
    blocking: ['needs_login', 'proxy_down'],
    clearing: ['needs_login', 'proxy_up'],
  },
};

// Identifiers are interpolated into SQL, so they are checked rather than
// trusted — a typo becomes a throw instead of a query that means something else.
// Same guard, same reason, as lib/channel-drift-sweep.js's `ident`.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The live blocking cause for one store on one channel, or null.
// { by, at, msg } — `by` is the event type (a stable code the client words),
// `at` when it started, `msg` the daemon's own sentence, which is the most
// specific thing anyone has written about this fault.
function channelBlock(db, channel, storeCode) {
  const d = CHANNELS[channel];
  if (!d || !storeCode) return null;
  if (!IDENT.test(d.logTable)) throw new Error(`[channel-block] bad table: ${d.logTable}`);
  try {
    const ph = d.blocking.map(() => '?').join(',');
    const ev = db.prepare(`
      SELECT event_type, error_msg, created_at
        FROM ${d.logTable}
       WHERE store_code = ? AND status = 'error' AND event_type IN (${ph})
       ORDER BY created_at DESC LIMIT 1
    `).get(storeCode, ...d.blocking);
    if (!ev) return null;

    // Recovered if a push has landed since, or a clearing event was announced.
    const ok = db.prepare(`SELECT MAX(created_at) AS t FROM ${d.logTable}
                            WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok'`)
      .get(storeCode).t || null;
    const cph = d.clearing.map(() => '?').join(',');
    const cleared = d.clearing.length
      ? (db.prepare(`SELECT MAX(created_at) AS t FROM ${d.logTable}
                      WHERE store_code = ? AND event_type IN (${cph})`)
          .get(storeCode, ...d.clearing).t || null)
      : null;
    // String compare is right: these are SQLite CURRENT_TIMESTAMP stamps, a
    // fixed-width UTC format that sorts lexicographically. The Meituan route
    // compares them the same way and has for months.
    const recovered = (ok && String(ok) > String(ev.created_at))
                   || (cleared && String(cleared) > String(ev.created_at));
    if (recovered) return null;
    return { by: ev.event_type, at: ev.created_at || null, msg: ev.error_msg || null };
  } catch (_) {
    // A missing log table is a channel this box does not run. Never a reason to
    // break the read that asked.
    return null;
  }
}

// The worst live cause across a channel's stores, for a card that speaks for the
// channel rather than for one shop. `stores` is [{ code, name, nameEn }].
// Returns null when nothing is blocked.
//
// Worst = earliest, not most recent: the one that has been stopping pushes
// longest is the one somebody has been ignoring.
function channelBlockFor(db, channel, stores) {
  let worst = null;
  for (const st of (stores || [])) {
    const b = channelBlock(db, channel, st.code);
    if (!b) continue;
    const row = { ...b, store: st.code, storeName: st.name || st.code, storeNameEn: st.nameEn || st.name || st.code };
    if (!worst || String(row.at || '') < String(worst.at || '')) worst = row;
  }
  return worst;
}

module.exports = { channelBlock, channelBlockFor, CHANNELS };
