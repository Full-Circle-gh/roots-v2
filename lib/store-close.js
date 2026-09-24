'use strict';

// Opening and closing a location on a sales channel — ONE named operation.
//
// THIS IS THE ONLY THING PERMITTED TO WRITE store_business_status.target_open OR
// channel_status.is_open. A raw write to either column anywhere else is a defect,
// and `grep -rn "target_open\|channel_status" routes/ lib/` is how you find one.
//
// It is one operation rather than a helper the write paths politely call, because
// closing a channel is not only a flag: the queued stock pushes for that location
// have to go too, and a rule that lives in four callers is a rule that holds until
// someone writes a fifth. There were four Meituan write paths when this was
// written (the Meituan tab's own toggle, the store-status master flip, the
// per-store switch, and the Sales-page close matrix) and only ONE of them cleared
// the queue — which is how 越秀 ended up holding 187 pushes for a store that had
// been switched off for days.
//
// WHY THE QUEUE IS CLEARED ON CLOSE, NOT DRAINED ON REOPEN
// --------------------------------------------------------
// Bringing a location back from a standing closure means a physical restock and
// recount. Every quantity queued before the closure describes a shop that no
// longer exists, so replaying them on reopen would publish a stale picture before
// anyone has counted a shelf. Clearing on close also means the queue never holds
// rows nobody will ever want — so the dashboard's stale-sync row has nothing to
// trip over even if the trading predicate is wrong somewhere.
//
// pending, processing AND error are all cleared. The original Meituan-only clear
// took pending and processing but not error, which is exactly why a closed store
// kept terminal rows forever: they are the ones no retry will ever remove.

// §85 — the published figure, so a close/reopen cannot withdraw a window.
const channelPublish = require('./channel-publish');

// channel → { queue, log } table names. A channel absent here has no stock queue
// of its own (mini_app, web, pos are served straight from retail_store_stock), so
// there is nothing to clear and nothing to refill — the flag write still happens.
const CHANNEL_TABLES = {
  meituan:   { queue: 'meituan_sync_queue', log: 'meituan_sync_log' },
  shangou:   { queue: 'meituan_sync_queue', log: 'meituan_sync_log' },  // 闪购 shares Meituan's queue, split by store
  eleme:     { queue: 'eleme_sync_queue',   log: 'eleme_sync_log' },
  gzgrocery: { queue: 'guanyi_sync_queue',  log: 'guanyi_sync_log' },
  guanyi:    { queue: 'guanyi_sync_queue',  log: 'guanyi_sync_log' },
};

// Drop every push queued for this (channel, store) that will never be wanted, and
// leave a record of how many went. Returns the row count so the caller can report
// it. Never throws — a queue that cannot be cleared must not block the close
// itself, which is the operator-visible half of the action.
function clearQueueForCell(db, channel, storeCode) {
  const t = CHANNEL_TABLES[channel];
  if (!t) return 0;
  let n = 0;
  try {
    const r = db.prepare(
      `DELETE FROM ${t.queue} WHERE store_code = ? AND status IN ('pending','processing','error')`
    ).run(storeCode);
    n = r.changes || 0;
  } catch { return 0; }
  if (!n) return 0;
  // Recorded, never silent: a close that quietly discards 187 queued pushes is
  // indistinguishable from one that discarded none, and the difference matters
  // when someone later asks why a reopened store had nothing waiting.
  try {
    db.prepare(
      `INSERT INTO ${t.log} (store_code, event_type, status, detail, error_msg)
       VALUES (?, 'queue_cleared', 'ok', ?, NULL)`
    ).run(storeCode, JSON.stringify({ channel, store_code: storeCode, rows_cleared: n, at: new Date().toISOString() }));
  } catch { /* the clear itself already happened; the log is the nice-to-have */ }
  console.log(`[store-close] cleared ${n} queued push(es) for ${channel}/${storeCode}`);
  return n;
}

// Reopening queues a fresh FULL push of current stock, rather than replaying the
// rows the close dropped. Meituan only — no other channel refills on reopen today,
// and inventing one would publish a snapshot on a channel whose operators have
// never been shown one. Per-row quantity via bundle-stock so a bundle reopens with
// its component floor rather than the vestigial shelf row.
function refillQueueForCell(db, channel, storeCode) {
  if (channel !== 'meituan' && channel !== 'shangou') return 0;
  // THE QUANTITY IS §85's PUBLISHED FIGURE, not the shelf. Outside a window it
  // is the same floored shelf sellableAt returned; inside one it keeps the
  // allowance, so a close-and-reopen cannot silently withdraw the morning's
  // pre-orders.
  //
  // THIS COMMENT LIVES OUT HERE BECAUSE IT USED TO LIVE INSIDE THE TEMPLATE
  // LITERAL BELOW. `//` is not a SQLite comment — it is `--` — so the statement
  // never parsed, prepare() threw on every call, and setChannelOpen's
  // best-effort catch swallowed it as "queue step failed". Every Meituan reopen
  // since has queued nothing at all: the refill this function exists for has
  // never once run. A comment that stops the code working is not a comment, and
  // the catch that hid it is the reason it went unnoticed for so long.
  const mapped = db.prepare(`
    SELECT m.product_id, m.retail_store_id, m.store_code
      FROM meituan_product_map m
     WHERE m.store_code = ? AND m.sync_enabled = 1 AND m.meituan_name IS NOT NULL
  `).all(storeCode).map(m => ({ ...m, qty: channelPublish.publishableAt(db, m.retail_store_id, m.product_id, { channel: 'meituan' }) }));
  const ins = db.prepare(`
    INSERT INTO meituan_sync_queue (retail_store_id, product_id, store_code, new_qty, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  for (const m of mapped) ins.run(m.retail_store_id, m.product_id, m.store_code, m.qty);
  return mapped.length;
}

// Open or close ONE location on ONE channel.
//
//   db        — tenant db handle
//   channel   — 'meituan' | 'eleme' | 'gzgrocery' | 'mini_app' | 'web' | 'pos'
//   storeCode — retail_stores.code
//   open      — true to open, false to close
//   by        — who asked (audit column)
//
// Returns { channel, storeCode, open, cleared, refilled }.
function setChannelOpen(db, { channel, storeCode, open, by }) {
  if (!db || !channel || !storeCode) throw new Error('setChannelOpen: db, channel and storeCode are required');
  const isOpen = !!open;
  const who = by || 'backend';

  if (channel === 'meituan' || channel === 'shangou') {
    // If the new toggle matches the last CONFIRMED on-box state (is_open), there
    // is nothing left to apply — clear any stale target_open rather than leaving
    // a command queued that just re-affirms reality. This is what makes an
    // on-then-off toggle (before the daemon gets to the first one) drop
    // "applying…" immediately, instead of leaving a no-op command stuck pending
    // — which otherwise reads as permanently "applying" whenever the daemon
    // can't log in to clear it itself.
    const cur = db.prepare('SELECT is_open FROM store_business_status WHERE store_code=?').get(storeCode);
    const noopToggle = cur && cur.is_open != null && cur.is_open === (isOpen ? 1 : 0);
    const targetOpen = noopToggle ? null : (isOpen ? 1 : 0);
    db.prepare(`INSERT INTO store_business_status (store_code, target_open, target_by, target_at, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(store_code) DO UPDATE SET target_open=excluded.target_open, target_by=excluded.target_by,
                  target_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`)
      .run(storeCode, targetOpen, who);
  } else {
    db.prepare(`INSERT INTO channel_status (channel, store_code, is_open, updated_at, updated_by)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(channel, store_code) DO UPDATE SET is_open=excluded.is_open,
                  updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by`)
      .run(channel, storeCode, isOpen ? 1 : 0, who);
  }

  // The queue side is best-effort on purpose: the flag above is what the operator
  // just asked for and it must land even if the queue work trips.
  let cleared = 0, refilled = 0;
  try {
    if (isOpen) refilled = refillQueueForCell(db, channel, storeCode);
    else cleared = clearQueueForCell(db, channel, storeCode);
  } catch (e) {
    console.error(`[store-close] queue step failed for ${channel}/${storeCode}:`, e.message);
  }
  return { channel, storeCode, open: isOpen, cleared, refilled };
}

// ── The shop, over its channels (§253) ─────────────────────────────────────
//
// store_business_status.fulfillment_open is the shop-wide switch: at 0 every
// channel at that shop reads closed whatever its own cell says. The two
// functions below are the only writers of it that also move the cells, and
// they keep the two in step so no cell stored before a close can come back
// unmasked on a reopen nobody asked it to join.

function shopIsOpen(db, storeCode) {
  const r = db.prepare('SELECT fulfillment_open FROM store_business_status WHERE store_code=?').get(storeCode);
  return !(r && r.fulfillment_open === 0);
}

// Whether the operator last asked for this cell to be open — the pending
// Meituan command first, then the last read, then the stored cell. Absent
// anywhere = open, the same default every reader uses.
function channelWantedOpen(db, channel, storeCode) {
  if (channel === 'meituan' || channel === 'shangou') {
    const r = db.prepare('SELECT is_open, target_open FROM store_business_status WHERE store_code=?').get(storeCode);
    if (!r) return true;
    if (r.target_open != null) return r.target_open === 1;
    return r.is_open != null ? r.is_open === 1 : true;
  }
  const r = db.prepare('SELECT is_open FROM channel_status WHERE channel=? AND store_code=?').get(channel, storeCode);
  return r ? r.is_open === 1 : true;
}

// The channels remembered at the last close, or null when none are.
function rememberedChannels(db, storeCode) {
  const r = db.prepare('SELECT reopen_channels FROM store_business_status WHERE store_code=?').get(storeCode);
  if (!r || !r.reopen_channels) return null;
  try {
    const v = JSON.parse(r.reopen_channels);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
  } catch { return null; }
}

function writeShop(db, storeCode, open, remember) {
  db.prepare(`INSERT INTO store_business_status (store_code, fulfillment_open, reopen_channels, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(store_code) DO UPDATE SET fulfillment_open=excluded.fulfillment_open,
                reopen_channels=excluded.reopen_channels, updated_at=CURRENT_TIMESTAMP`)
    .run(storeCode, open ? 1 : 0, remember == null ? null : JSON.stringify(remember));
}

// The location master. `channels` is every channel that serves this store.
//
// CLOSE remembers which of them were live, then closes them all and the shop.
// Closing a shop that is already closed keeps what was remembered the first
// time — a second close must not overwrite it with "nothing was live".
//
// OPEN brings back what the last close remembered; with nothing remembered (a
// shop closed some other way, or one that closed with every channel already
// off) it opens every channel. Channels outside that set are written CLOSED,
// not left alone, so a cell stored while the shop was masked cannot slip back.
//
// Returns { open, channels } — the channels now open.
function setShopOpen(db, { storeCode, channels, open, by }) {
  if (!db || !storeCode || !Array.isArray(channels)) throw new Error('setShopOpen: db, storeCode and channels are required');
  if (!open) {
    const remember = shopIsOpen(db, storeCode)
      ? channels.filter((ch) => channelWantedOpen(db, ch, storeCode))
      : rememberedChannels(db, storeCode);
    for (const ch of channels) setChannelOpen(db, { channel: ch, storeCode, open: false, by });
    writeShop(db, storeCode, false, remember);
    return { open: false, channels: [] };
  }
  let want = channels;
  if (!shopIsOpen(db, storeCode)) {
    const mem = (rememberedChannels(db, storeCode) || []).filter((ch) => channels.includes(ch));
    if (mem.length) want = mem;
  }
  for (const ch of channels) setChannelOpen(db, { channel: ch, storeCode, open: want.includes(ch), by });
  writeShop(db, storeCode, true, null);
  return { open: true, channels: want };
}

// Open ONE channel at a store. At a trading shop that is just the cell. At a
// closed shop it opens the shop with ONLY this channel: every other channel in
// `channels` is written closed first, and the memory is cleared because the
// operator has just said what they want live.
//
// Returns { shopOpened } — true when the shop itself was reopened.
function openOneChannel(db, { storeCode, channel, channels, by }) {
  if (!db || !storeCode || !channel || !Array.isArray(channels)) throw new Error('openOneChannel: db, storeCode, channel and channels are required');
  if (shopIsOpen(db, storeCode)) {
    setChannelOpen(db, { channel, storeCode, open: true, by });
    return { shopOpened: false };
  }
  for (const ch of channels) setChannelOpen(db, { channel: ch, storeCode, open: ch === channel, by });
  writeShop(db, storeCode, true, null);
  return { shopOpened: true };
}

module.exports = {
  setChannelOpen, clearQueueForCell, refillQueueForCell, CHANNEL_TABLES,
  setShopOpen, openOneChannel, shopIsOpen, rememberedChannels,
};
