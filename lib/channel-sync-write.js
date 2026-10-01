'use strict';

// §117 part two — the two writes the Channel sync page makes, for all three
// channels, in one place.
//
// WHY HERE AND NOT ON THE THREE CHANNEL ROUTES. §117 folds the per-channel sync
// views into one page, so that page needs to REPAIR and not only report. The
// three channel routes already carry a repair surface each, and they disagree
// in every particular: Meituan's /map takes `meituanName` through
// lib/meituan-map-write, Eleme's takes `elemeName` plus a spec pair and a
// `remove` flag, GZ Grocery's takes a `skuId` and has no store field at all
// because it has one store. Calling three shapes from one panel would put the
// difference in the panel, which is the thing §117 exists to remove.
//
// WHAT IS SHARED IS EXACTLY TWO VERBS, and only because all three channels
// already agreed on them underneath: every map table has `sync_enabled`, and
// every queue table takes (retail_store_id, product_id, store_code, new_qty,
// status). Naming a listing and claiming an option are NOT here and must not be
// added: those are where the channels genuinely differ, they need each
// channel's own catalogue picker, and the page sends the operator to the
// channel's own tab for them.
//
// THE PRE-ORDER KEY IS NOT THE CHANNEL KEY. GZ Grocery's channel key is
// `guanyi` everywhere in this codebase except lib/channel-publish, which knows
// it as `gzgrocery` — routes/guanyi-admin.js's own push-all passes that string.
// Get it wrong and §85's allowance is silently dropped from every GZ Grocery
// push, which looks like nothing at all until a pre-order window closes itself.
// The mapping lives in the table below and nowhere else.

const channelPublish = require('./channel-publish');
const cadence = require('./batch-cadence');

const CHANNELS = {
  meituan: { map: 'meituan_product_map', queue: 'meituan_sync_queue', publishKey: 'meituan',
             // Meituan's queue carries 套餐 rows too, keyed by bundle_id with a
             // NULL product_id. A product's pending row must not collapse onto
             // one of those, hence the guard. The other two have no bundles.
             bundleColumn: true },
  eleme:   { map: 'eleme_product_map',   queue: 'eleme_sync_queue',   publishKey: 'eleme',     bundleColumn: false },
  guanyi:  { map: 'guanyi_product_map',  queue: 'guanyi_sync_queue',  publishKey: 'gzgrocery', bundleColumn: false },
};

function configFor(channel) {
  return Object.prototype.hasOwnProperty.call(CHANNELS, String(channel)) ? CHANNELS[String(channel)] : null;
}

// Turn this product's sync on or off for one channel. Scoped to a store when
// one is named, and to every store the product is mapped at when one is not —
// which is what the Channel sync page sends, because its card is per channel
// and a card that silently changed one of two stores would be lying by
// omission.
function setSync(db, channel, productId, on, storeCode) {
  const c = configFor(channel);
  if (!c) return { ok: false, code: 'unknown_channel' };
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid)) return { ok: false, code: 'bad_product' };
  /* §325 S2j — AN ELEME MAPPING WITH NO LISTING NAME IS NEVER SWITCHED ON.
     Eleme matches a push by NAME and nothing else, and the daemon fills a
     missing one with the product's own Chinese name (scripts/eleme-daemon.js,
     `targetCn: row.map_eleme_name || row.name_cn`) — so a nameless mapping
     switched on pushes stock to whichever listing that name happens to match,
     or to none (docs/eleme-findings.md finding 6; finding 9 for the matcher).
     The Eleme panel refuses this on screen (14-eleme.js "Pick a listing name
     first"); this is the server saying the same thing to every caller — the
     Channel sync page and the phone's switch included. All or nothing: if any
     targeted store's mapping has no name, nothing is switched, and the answer
     names those stores. Switching OFF is always allowed. */
  if (on && channel === 'eleme') {
    const nameless = db.prepare(
      `SELECT DISTINCT store_code AS storeCode FROM eleme_product_map
        WHERE product_id = ? AND TRIM(COALESCE(eleme_name, '')) = ''${storeCode ? ' AND store_code = ?' : ''}
        ORDER BY store_code`).all(...(storeCode ? [pid, String(storeCode)] : [pid]));
    if (nameless.length) return { ok: false, code: 'no_listing_name', stores: nameless.map((r) => r.storeCode) };
  }
  const args = [on ? 1 : 0, pid];
  let sql = `UPDATE ${c.map} SET sync_enabled = ? WHERE product_id = ?`;
  if (storeCode) { sql += ' AND store_code = ?'; args.push(String(storeCode)); }
  const r = db.prepare(sql).run(...args);
  // No rows means no mapping, which is a different answer from "done": the
  // switch the operator flipped would spring back and they would be owed a
  // reason. The page turns this into one.
  if (!r.changes) return { ok: false, code: 'not_mapped' };
  return { ok: true, rows: r.changes, on: !!on };
}

// Queue one product's stock for one channel, at every store it is mapped and
// switched on at.
//
// A PENDING ROW IS REFRESHED, NEVER DUPLICATED. routes/meituan-admin.js's
// push-all carries the scar: a raw INSERT per click left "877 pending for 208
// products", none of them collapsing until they happened to share a batch. The
// same rule applies harder here, because this button sits next to a red row and
// gets pressed twice.
//
// A DEAD ERROR ROW IS WHAT THIS BUTTON IS FOR. The daemon only picks up
// `pending`, so an item whose last push errored sits there forever
// (docs/meituan-findings.md #6). A fresh pending row is both the retry and the
// fix: the verdict reads the LATEST queue row per (store, product), so the item
// leaves "needs attention" the moment this lands.
function pushNow(db, channel, productId) {
  const c = configFor(channel);
  if (!c) return { ok: false, code: 'unknown_channel' };
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid)) return { ok: false, code: 'bad_product' };

  // DISTINCT because Meituan and Eleme hold one map row per claimed 规格 and
  // the queue is keyed by (store, product), not by option: three claims are one
  // push, and without this they would be three.
  const targets = db.prepare(
    `SELECT DISTINCT retail_store_id AS storeId, store_code AS storeCode
       FROM ${c.map} WHERE product_id = ? AND sync_enabled = 1`).all(pid);
  if (!targets.length) return { ok: false, code: 'not_syncing' };

  // §85 — resolved ONCE for the click, the way lib/eleme-sync.js resolves it
  // once for a batch: a push that straddled the lock hour would otherwise send
  // the allowance to one store and not the other.
  const window = cadence.preorderWindow(db, { channel: c.publishKey });
  const guard = c.bundleColumn ? ' AND bundle_id IS NULL' : '';
  const refresh = db.prepare(
    `UPDATE ${c.queue} SET new_qty = ?, last_error = NULL
      WHERE retail_store_id = ? AND product_id = ? AND status = 'pending'${guard}`);
  const insert = db.prepare(
    `INSERT INTO ${c.queue} (retail_store_id, product_id, store_code, new_qty, status)
     VALUES (?, ?, ?, ?, 'pending')`);

  let queued = 0, refreshed = 0;
  db.transaction(() => {
    for (const t of targets) {
      const qty = channelPublish.publishableAt(db, t.storeId, pid, { channel: c.publishKey, window });
      if (refresh.run(qty, t.storeId, pid).changes > 0) { refreshed++; continue; }
      insert.run(t.storeId, pid, t.storeCode, qty);
      queued++;
    }
  })();
  return { ok: true, queued, refreshed, stores: targets.length };
}

module.exports = { CHANNELS, configFor, setSync, pushNow };
