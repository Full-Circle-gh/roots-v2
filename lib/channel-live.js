// Is a store still trading on a given channel right now? One answer, read from
// the same two tables the Sales page's close matrix writes, shared by every
// channel daemon so they cannot disagree about who is open.
//
// The daemons already sleep outside opening hours (lib/store-hours). This is the
// other half, and it is not the same question: a store the operator has switched
// OFF — one channel, or the whole location — should not be polled, pushed to,
// logged into, swept or alerted about AT ALL, at any hour, until it is switched
// back on. A shop that is down "until further notice" otherwise keeps a browser,
// a proxy exit and a login session busy round the clock and pages ops daily about
// a session nobody is going to walk over and re-scan.
//
// Three sources, because the Sales page has three:
//   • store_business_status.fulfillment_open — the whole location's shutter. Not
//     a channel: a shop with nothing behind the door fulfils nothing, so this
//     closes every channel at once.
//   • channel_status.is_open — that channel's own cell (eleme, mini_app, web,
//     pos, gzgrocery…).
//   • store_business_status.is_open — Meituan's own 营业/停业, read back off the
//     merchant site. Meituan has no channel_status cell; its cell IS the
//     read-back. This mirrors csCellOpen() in routes/meituan-admin.js, which is
//     what the operator is looking at when they say the channel is closed.
//
// Deliberate: a store with a PENDING open/close command (store_business_status.
// target_open) is never reported closed on Meituan. That command is applied by
// the very daemon this gate parks, so parking on the state it is about to change
// would deadlock the store shut — closed, with no process left running to reopen
// it. The pending command holds the daemon awake exactly long enough to obey it.
//
// Unknown reads as OPEN everywhere — no row, NULL, missing table, busy db — so a
// new store, or an older schema, is never silently muted.
//
// Tenancy: reads the process's own database handle, like lib/store-hours, not the
// per-request tenant handle. The daemons run outside a request and already work
// this way; both files move together if that ever changes.

'use strict';

// Routed through the database seam (lib/db-seam.js) rather than holding the raw
// handle, so this module sits on the covered side of the boundary like the rest
// of the daemon reads. No converter is installed — a zero-cost passthrough today.
//
// Opened on FIRST READ, not at require time. buildSnapshot below is a pure
// function of two row sets, and keeping the handle lazy is what lets
// scripts/verify-channel-park.js exercise it anywhere — including a dev box with
// no compiled better-sqlite3 binding.
const { seam } = require('./db-seam');
let _db = null;
function getDb() {
  if (!_db) _db = seam(require('../database'));
  return _db;
}

// Re-read at most this often. Shorter than lib/store-hours' 10 minutes on
// purpose: reopening a store is a "we are trading again, now" action, and the
// operator is standing at the toggle waiting for stock to start flowing.
const CACHE_MS = Number(process.env.CHANNEL_LIVE_CACHE_MS || 60_000);

// Meituan's cell is the merchant-site read-back, not a channel_status row. Both
// Meituan daemons (外卖 meituan-daemon, 闪购 shangou-daemon) pass this key; they
// serve different stores, so the one per-store row is never contested.
const MEITUAN = 'meituan';

let cache = null;
let cachedAt = 0;

function emptySnapshot() {
  return {
    shuttered: new Set(),      // fulfillment_open = 0 → every channel closed
    closedByChannel: new Map(),// channel → Set(storeCode) with is_open = 0
    meituanClosed: new Set(),  // 停业 on Meituan, with no pending command
    channelsPerStore: new Map()// storeCode → Set(channel) that has a cell at all
  };
}

// The whole decision, as a pure function of the two tables' rows. Separated from
// the read so scripts/verify-channel-park.js can exercise the REAL logic against
// fixtures, offline — a mirror of this in a test would be free to drift from it.
//   channelRows: { channel, store_code, is_open }         from channel_status
//   statusRows:  { store_code, is_open, target_open, fulfillment_open }
//                                                          from store_business_status
function buildSnapshot(channelRows, statusRows) {
  const snap = emptySnapshot();
  const seenFor = (storeCode) => {
    let seen = snap.channelsPerStore.get(storeCode);
    if (!seen) { seen = new Set(); snap.channelsPerStore.set(storeCode, seen); }
    return seen;
  };
  for (const r of channelRows) {
    seenFor(r.store_code).add(r.channel);
    if (r.is_open === 0) {
      let closed = snap.closedByChannel.get(r.channel);
      if (!closed) { closed = new Set(); snap.closedByChannel.set(r.channel, closed); }
      closed.add(r.store_code);
    }
  }
  for (const r of statusRows) {
    if (r.fulfillment_open === 0) snap.shuttered.add(r.store_code);
    // A store with a Meituan status row has a Meituan cell on the Sales page.
    seenFor(r.store_code).add(MEITUAN);
    // NULL is_open = never read = unknown = open. A pending target_open keeps
    // the store awake so the daemon can apply it (see the header).
    if (r.is_open === 0 && r.target_open == null) snap.meituanClosed.add(r.store_code);
  }
  return snap;
}

// Read both tables in one pass. Committed only if every read lands: a half-built
// snapshot could report a store closed on the strength of one table, and
// "closed" is the answer that stops work.
function loadAll() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;

  let snap;
  try {
    const db = getDb();
    snap = buildSnapshot(
      db.prepare('SELECT channel, store_code, is_open FROM channel_status').all(),
      db.prepare('SELECT store_code, is_open, target_open, fulfillment_open FROM store_business_status').all()
    );
  } catch (e) {
    // Table missing / db busy — keep serving the last good read rather than
    // inventing closures, and treat a cold start as "everything open".
    return cache || emptySnapshot();
  }

  cache = snap;
  cachedAt = now;
  return snap;
}

// Drop the cache so the next question re-reads. Called when a daemon has just
// acted on a state change (an unpark) and wants its next tick to be honest, and
// by the verifier script.
function refresh() { cache = null; cachedAt = 0; return loadAll(); }

// Why this store is off this channel, or null when it is trading.
// 'location_closed' — the whole shop is shut (beats every cell)
// 'channel_closed'  — this one channel is switched off for this store
function closedReason(channel, storeCode, snapshot) {
  const snap = snapshot || loadAll();
  if (snap.shuttered.has(storeCode)) return 'location_closed';
  if (channel === MEITUAN) return snap.meituanClosed.has(storeCode) ? 'channel_closed' : null;
  const closed = snap.closedByChannel.get(channel);
  return closed && closed.has(storeCode) ? 'channel_closed' : null;
}

// The question a daemon asks: may I do work for this store on this channel?
function channelLive(channel, storeCode, snapshot) {
  return closedReason(channel, storeCode, snapshot) === null;
}

// Is the LOCATION trading at all — any sales channel still on? This is the
// Sales page's location card ("Closed — every channel off"), and it is what a
// non-sales daemon (delivery tracking) should follow: it doesn't belong to one
// channel, it belongs to the shop.
// A store with no cells on file is trading, same unknown-reads-as-open rule.
function storeLive(storeCode, snapshot) {
  const snap = snapshot || loadAll();
  if (snap.shuttered.has(storeCode)) return false;
  const cells = snap.channelsPerStore.get(storeCode);
  if (!cells || cells.size === 0) return true;
  for (const ch of cells) if (channelLive(ch, storeCode, snap)) return true;
  return false;
}

module.exports = { channelLive, storeLive, closedReason, refresh, buildSnapshot, MEITUAN, CACHE_MS };
