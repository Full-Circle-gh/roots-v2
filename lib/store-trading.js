'use strict';

// "Is this location trading on this channel right now?" — ONE predicate, so
// nothing has to re-derive it and no two callers can answer it differently.
//
// This is NOT the same question as "is the store open at this hour". Opening
// hours (lib/store-hours.js) say when a trading store is between its own doors
// opening and closing; this says whether the location is operating on that
// channel AT ALL. A store closed for the night is still trading — it opens
// tomorrow. A store switched off indefinitely is not, and nothing about it
// should be treated as a live problem until someone switches it back on.
//
// WHERE THE TRUTH LIVES, AND WHY IT IS TWO TABLES
// -----------------------------------------------
// Meituan/闪购 keeps its own 营业/停业 state, read back off the merchant site by
// the daemons into store_business_status. Every other channel is ours to switch,
// and lives in channel_status (channel, store_code). Meituan is deliberately NOT
// mirrored into channel_status: two tables holding the same truth drift, and the
// stale one is always the one you read at the worst moment. So the split stays,
// and THIS FILE is the single place that knows about it — when the tables are
// consolidated, this is the one function that changes.
//
// For Meituan the operator's own command outranks the observed state: target_open
// is what a human just asked for and the daemon has not applied yet (it nulls the
// column once it lands). Reading is_open alone would call a just-closed store
// "trading" for as long as the daemon takes to catch up — which, for a store whose
// daemon is down, is forever. This mirrors storePushEnabled() in
// scripts/meituan-daemon.js and scripts/shangou-daemon.js exactly: same columns,
// same precedence, so the push gate and this predicate cannot disagree.
//
// Absent row = trading. A store nobody has ever switched is open for business,
// and a fresh or partially-migrated DB must never silently mute a live channel.

// Channel keys as the sync-queue registry (lib/channel-sync-stale.js) names them,
// mapped to the channel_status key the Sales-page close matrix writes. Meituan is
// absent on purpose — it is answered from store_business_status instead.
const CHANNEL_STATUS_KEY = {
  eleme: 'eleme',
  guanyi: 'gzgrocery',   // GZ Grocery is one store (tianhe); see below
  gzgrocery: 'gzgrocery',
  mini_app: 'mini_app',
  web: 'web',
  pos: 'pos',
};

// The shop-wide "this location isn't operating" switch, which beats any
// per-channel cell: lib/inventory.js's routing already drops a store with
// fulfillment_open = 0 from every candidate pool, so a channel cell reading
// "open" underneath it describes a shop that cannot take an order.
function fulfillmentClosed(db, storeCode) {
  try {
    const r = db.prepare('SELECT fulfillment_open FROM store_business_status WHERE store_code = ?').get(storeCode);
    return !!(r && r.fulfillment_open === 0);
  } catch { return false; }
}

// True when `storeCode` is trading on `channel`. Never throws: a missing table or
// a busy DB answers "trading", the same fail-open direction every other reader of
// these tables takes, because muting a live channel is the worse failure.
function isStoreTradingOnChannel(db, storeCode, channel) {
  if (!db || !storeCode || !channel) return true;
  try {
    if (fulfillmentClosed(db, storeCode)) return false;

    // Meituan / 闪购 — the POI's own state, command-then-observed.
    if (channel === 'meituan' || channel === 'shangou') {
      const r = db.prepare('SELECT target_open, is_open FROM store_business_status WHERE store_code = ?').get(storeCode);
      if (!r) return true;
      if (r.target_open === 0 || r.target_open === 1) return r.target_open === 1;
      if (r.is_open === 0 || r.is_open === 1) return r.is_open === 1;
      return true;
    }

    // GZ Grocery is a single-store channel (tianhe). It has a channel_status row
    // like the rest, so it is answered the same way rather than special-cased
    // into an unconditional yes — the effect is identical while a row exists,
    // and it keeps working if a second GZ Grocery store is ever added.
    const key = CHANNEL_STATUS_KEY[channel] || channel;
    const r = db.prepare('SELECT is_open FROM channel_status WHERE channel = ? AND store_code = ?').get(key, storeCode);
    return r ? r.is_open === 1 : true;
  } catch {
    return true;
  }
}

module.exports = { isStoreTradingOnChannel, CHANNEL_STATUS_KEY };
