'use strict';

// Stock-drift backstop, shared across sales channels.
//
// Every channel's push queue is edge-triggered: a stock change enqueues one row,
// the daemon pushes it, done. That works right up until a push fails terminally —
// and then nothing ever looks at that product again. On Eleme a row dies in two
// ways, both at scripts/eleme-daemon.js:650-656:
//
//   • 'transient push failure — retries exhausted' (attempts hits 3)
//   • a refusal that explained itself (today: a name the catalogue does not carry)
//
// Either way the row lands in status='error' and NO code path re-reads it. The
// drain selects `status='pending' AND attempts < 3` (scripts/eleme-daemon.js:506);
// the orphan sweep only heals `status='processing'` (:686-687); the admin route
// counts error rows but never requeues them (routes/eleme-admin.js:458, :514).
// The product's Eleme stock freezes at whatever last landed and stays frozen until
// someone notices by eye. docs/eleme-findings.md finding 2 records this as open:
// "Eleme has no level-triggered reconciliation" — Meituan has a drift sweep and GZ
// Grocery has autoHeal; Eleme has neither.
//
// So the queue gets a level-triggered partner. This sweep compares the truth
// (retail_store_stock.physical_qty, or a roots bundle's component floor) against
// what we last got the channel to accept (last_pushed_qty) and re-enqueues the
// difference. It doesn't care WHY the earlier push died — a mismatch is a mismatch.
//
// ── Why this is a shared module and lib/meituan-drift-sweep.js still exists ─────
//
// The two are the same idea and are NOT being merged today. Meituan's sweep has
// months of production mileage on a channel that currently works; swapping it for
// a module with zero mileage buys nothing. lib/meituan-drift-sweep.js is untouched
// and keeps running exactly as it does. This module is wired to Eleme only, and
// Meituan is ported — if it is ported — once this has run for a few weeks.
//
// The same reasoning that gave lib/channel-sync-stale.js its own declared channel
// list applies here: a channel is an entry in a descriptor, not a copy of the file.
//
// ── What a descriptor must NOT assume ──────────────────────────────────────────
//
// Not every channel has the same columns or the same semantics:
//
//   • units_per_pack exists on meituan_product_map and eleme_product_map only
//     (database.js:5515-5522 declares PACK_MAPS with exactly those two).
//     guanyi_product_map has no such column, so `unitsColumn: null` must produce
//     SQL that does not mention one — a COALESCE against a column that isn't
//     there is a hard error, not a fallback.
//   • Channel combo listings (Meituan 套餐) exist on Meituan alone. `bundles` is
//     the hook for them and is null everywhere else. This is NOT the same thing
//     as a roots bundle product, which is handled in the core below for every
//     channel because store_products.bundle_items is channel-neutral.
//   • GZ Grocery is deliberately absent. Guanyi is an ERP: stock moves by
//     inbound/outbound document, so its last_pushed_qty is "the target we last
//     reconciled to" (database.js:5610) rather than a value the channel holds,
//     and scripts/guanyi-daemon.js:702-717 already runs its own drift check —
//     interlocked with pickup inference, which READS a downward drift as a
//     gzgrocery sale (:703-706). Re-pushing our number would erase that signal.
//     A Guanyi descriptor is not written until that interlock is designed.
//
// ── Churn guards, carried over deliberately ────────────────────────────────────
//
// A listing whose channel name no longer matches anything will fail forever, and a
// naive sweep would re-push it every cycle, burning browser time on a live
// risk-controlled session. Same two guards Meituan's sweep uses:
//
//   • Per-target cool-down (DRIFT_RETRY_HOURS): a target queued recently is left
//     alone, so a permanently-broken listing costs ~12 tries a day, not one every
//     10 seconds.
//   • Per-sweep cap (MAX_ROWS): a mass edit can't flood one cycle's batch.
//
// And a listing that stays broken is an operator problem, not a retry problem —
// anything drifting past CHRONIC_HOURS raises a latched ops alert so it gets seen
// rather than quietly re-tried forever.

const bundleStock = require('./bundle-stock');
const { packQty } = require('./pack-units');

const DRIFT_RETRY_HOURS = 2;   // don't re-queue the same target more often than this
const CHRONIC_HOURS     = 24;  // drifting this long won't fix itself — tell someone
const MAX_ROWS          = 40;  // cap per sweep (one push batch is 40 on every channel)

// Columns every channel's map and queue share, so they are not descriptor fields:
// meituan_product_map, eleme_product_map and guanyi_product_map all carry
// retail_store_id / product_id / store_code / last_pushed_qty / last_pushed_at,
// and all three *_sync_queue tables carry retail_store_id / product_id /
// store_code / new_qty / status / attempts / last_error / created_at.
// Only the things that genuinely differ are declared.

// Descriptors are code, not input — but they are interpolated into SQL, so the
// identifiers are checked rather than trusted. A typo becomes a boot-time throw
// instead of a query that means something else.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name, what) {
  if (!IDENT.test(String(name || ''))) {
    throw new Error(`[channel-drift-sweep] bad ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

// ── Eleme ─────────────────────────────────────────────────────────────────────
//
// last_pushed_qty is written in exactly one place, scripts/eleme-daemon.js:596-600,
// gated `if (ok && row.map_id)` — success only, per map row (per claim), holding
// packQty(new_qty, units_per_pack). So the comparison target exists on day one and
// its arithmetic is packQty's, which is why this module uses packQty rather than
// re-deriving the division. (lib/meituan-drift-sweep.js:146 uses Math.trunc, which
// disagrees with packQty on a negative shelf count — packQty clamps to 0, trunc
// does not — so a negative shelf count there drifts forever. That is a real defect
// in the Meituan sweep, recorded here and deliberately NOT fixed in this change.)
const ELEME = {
  key:               'eleme',
  label:             'Eleme',
  queueTable:        'eleme_sync_queue',
  mapTable:          'eleme_product_map',
  logTable:          'eleme_sync_log',
  // Eleme is in PACK_MAPS (database.js:5517), so a claim carries a pack size and a
  // 规格 key: one product may hold several options of one listing, each its own
  // stock box, each its own last_pushed_qty.
  unitsColumn:       'units_per_pack',
  syncEnabledColumn: 'sync_enabled',
  listingColumn:     'eleme_name',   // cached listing title, display only
  specLabelColumn:   'spec_name',    // which 规格 this claim holds, display only
  // No channel combo listings: there is no eleme_bundles table anywhere in the
  // schema. Roots bundle PRODUCTS are still handled — see the core below.
  bundles:           null,
  // ⚠️ PLACEHOLDER — NO ALERT COPY YET. DO NOT COMPOSE ONE. ⚠️
  //
  // The chronic-drift alert needs a bilingual CN/EN pair for Eleme. There is none:
  // docs/tacet-delivery-vocabulary.md holds no drift or sync wording (it locks
  // delivery/fulfilment words and says so), and the only such strings in the tree
  // are Meituan's own, at lib/meituan-drift-sweep.js:340-341 and :349. Swapping
  // 美团 for 饿了么 in those would be composing a new Chinese string, which
  // docs/tacet-consolidation-decisions.md:5208 forbids (vocabulary Rule 4, "never
  // compose new Chinese, copy from these tables" — §30 rule 3 applied to language).
  //
  // Until Ash supplies the pair, `alert: null` means the sweep still runs, still
  // re-enqueues, and still records chronic drift to eleme_sync_log where the admin
  // Eleme tab renders it — it just does not page the ops group, and it does NOT
  // set the latch. Not setting the latch matters: a latch closed while the message
  // was suppressed would swallow the first real alert once the copy lands.
  //
  // WHEN THE COPY ARRIVES, this becomes an object with two functions and nothing
  // else changes anywhere in this file:
  //
  //   alert: {
  //     chronic({ storeCode, count, hours, items }) -> string   // the 🔴
  //     clear({ storeCode })                        -> string   // the ✅
  //   }
  //
  // `items` is already sorted worst-first; each carries { sku, name, listing,
  // spec, was, now, hours, why }. `was` is null when nothing ever landed, and
  // `why` is the channel's own refusal verbatim or null. The descriptor renders
  // the lines itself — see alertChronic below for why the split is not made here.
  // lib/meituan-drift-sweep.js:329-349 is the shape of the equivalent Meituan
  // message, useful as a layout reference and NOT as a source to translate from.
  alert: null,
};

// ── The reads ────────────────────────────────────────────────────────────────
//
// The three reads below differ only in which queue rows they agree to look past,
// so the exclusion is built once here:
//
//   inFlight — ignore a target that already has a push queued or running. Right for
//              "what should I enqueue" and "what is stuck"; WRONG for "is this store
//              in sync", because a queued push is a promise, not a landed value.
//   cooldown — ignore a target tried inside the last DRIFT_RETRY_HOURS. Only the
//              enqueue read wants this; it is the churn guard, not a fact about sync.
//
// The cool-down is the QUEUE ITSELF, not a new timestamp column: a row's existence
// and its created_at are the whole memory, so there is nothing to migrate and
// nothing that can fall out of step with what the drain actually sees.
function skipQueued(d, { cooldown, inFlight }) {
  const parts = [];
  if (inFlight) parts.push(`q.status IN ('pending','processing')`);
  if (cooldown) parts.push(`q.created_at > datetime('now', '-${DRIFT_RETRY_HOURS} hours')`);
  if (!parts.length) return '';
  // A channel with its own combo listings puts bundle pushes in the same queue with
  // product_id NULL, so a product's cool-down must not be satisfied by a bundle row
  // that happens to share the store. A channel without them (Eleme) has no such
  // column to test.
  const match = d.bundles
    ? 'q.product_id = m.product_id AND q.bundle_id IS NULL'
    : 'q.product_id = m.product_id';
  return `AND NOT EXISTS (
             SELECT 1 FROM ${d.queueTable} q
              WHERE q.store_code = m.store_code
                AND ${match}
                AND (${parts.join(' OR ')})
           )`;
}

// What this claim's stock box SHOULD be holding, as SQL. Deliberately the same
// arithmetic as lib/pack-units.js packQty — MAX(stock, 0) then integer division —
// so the pre-filter and the JS re-test below cannot disagree about a row. Both
// halves floor, and both clamp a negative shelf count to 0, which is what the
// daemon actually writes (scripts/eleme-daemon.js:562).
function expectedQtySql(d) {
  const stock = 'CAST(MAX(COALESCE(s.physical_qty, 0), 0) AS INTEGER)';
  if (!d.unitsColumn) return stock;
  return `${stock} / MAX(COALESCE(m.${d.unitsColumn}, 1), 1)`;
}

// Claims whose live stock no longer matches what the channel last accepted.
//
// Two stages on purpose. The SQL narrows to candidates; the JS below re-tests each
// one and is authoritative. The split is not tidiness: a roots bundle's truth is
// its component floor, which lives inside store_products.bundle_items JSON where
// SQL cannot reach it, so every bundle row is let through the SQL arm unconditionally
// and decided in JS. For a NON-bundle the JS recomputes exactly the number the SQL
// already compared, so every row the query returned still qualifies.
function driftingProducts(db, d, storeCodes, { cooldown = true, inFlight = true } = {}) {
  const ph   = storeCodes.map(() => '?').join(',');
  const skip = skipQueued(d, { cooldown, inFlight });
  const enabled = d.syncEnabledColumn ? `AND m.${d.syncEnabledColumn} = 1` : '';
  const units   = d.unitsColumn ? `COALESCE(m.${d.unitsColumn}, 1)` : '1';
  const spec    = d.specLabelColumn ? `m.${d.specLabelColumn}` : 'NULL';
  const listing = d.listingColumn ? `m.${d.listingColumn}` : 'NULL';

  const rows = db.prepare(`
    SELECT m.retail_store_id, m.product_id, m.store_code,
           COALESCE(s.physical_qty, 0)            AS qty,
           p.bundle_items                         AS bundle_items,
           m.last_pushed_qty                      AS pushed_qty,
           ${units}                               AS units,
           ${spec}                                AS spec,
           ${listing}                             AS listing,
           COALESCE(p.name_cn, p.name_en, '?')    AS name,
           p.sku                                  AS sku,
           CAST((julianday('now') - julianday(COALESCE(m.last_pushed_at, m.created_at))) * 24
                AS INTEGER)                       AS drift_hours,
           -- Why the last attempt failed, in the channel's own words where it gave
           -- any. Without it the alert can only guess, and on Eleme the refusal is
           -- frequently a merchant-side state rather than anything wrong with the
           -- mapping (scripts/eleme-daemon.js:636-649 puts the channel's own
           -- sentence here on the FIRST attempt for a non-transient failure).
           (SELECT q.last_error FROM ${d.queueTable} q
             WHERE q.store_code = m.store_code
               AND q.product_id = m.product_id
             ORDER BY q.id DESC LIMIT 1)          AS last_error
      FROM ${d.mapTable} m
      LEFT JOIN retail_store_stock s ON s.store_id   = m.retail_store_id
                                    AND s.product_id = m.product_id
      LEFT JOIN store_products     p ON p.id = m.product_id
     WHERE m.store_code IN (${ph})
       ${enabled}
       -- A product the operator archived is not being sold, and a listing for a
       -- thing we no longer sell is not ours to keep in step. That matters more
       -- here than anywhere else, because this is the only path that re-queues a
       -- target on its own: every other enqueue needs either a stock movement —
       -- which an archived product does not get — or an operator's click. So an
       -- archived mapping whose name no longer matches a listing is re-queued
       -- every cycle, fails every time, and cannot be switched off from the
       -- screen, because the channel's mapping screen lists ACTIVE products only
       -- and the row is not there to find.
       --
       -- This is not hypothetical and it is not Meituan-specific. Product 254
       -- drifted that way for 1551 hours on Meituan, and while it did it held
       -- tianhe's chronic-drift latch closed for 28 days, so no NEW drift on that
       -- store could raise an alert either
       -- (docs/tacet-consolidation-decisions.md:88, §30 rule 5's worked example).
       -- Eleme's own drain filters on NEITHER is_active NOR sync_enabled
       -- (scripts/eleme-daemon.js:493-508); the sweep must, precisely because it
       -- is the path that creates work rather than the path that drains it.
       --
       -- COALESCE rather than a bare is_active: unknown reads as ACTIVE, so a
       -- mapping whose product row has gone missing keeps the behaviour the drain
       -- gives it today instead of being silently dropped. Same rule and same
       -- default as bundle-stock's bundlesContaining, for the same reason.
       --
       -- Level-triggered, so reactivating needs no cleanup: put the product back
       -- and the next sweep sees it again and re-queues whatever it missed.
       AND COALESCE(p.is_active, 1) = 1
       -- Against what THIS option should be holding, not the shelf count: a
       -- 6-bottle option is right when it reads floor(stock / 6), and comparing
       -- it to the raw count would report every multipack as permanently drifted
       -- and re-push it forever.
       AND (m.last_pushed_qty IS NULL
            OR m.last_pushed_qty <> ${expectedQtySql(d)}
            -- A roots bundle's truth is its component floor, not its own shelf
            -- row, and that floor lives inside bundle_items JSON where this
            -- comparison cannot reach it. Let every bundle row through and let
            -- the JS pass below decide. Without this arm the sweep is wrong in
            -- BOTH directions: it calls a correctly-pushed bundle drifted (shelf
            -- 51 vs pushed 13) and re-pushes the vestigial 51 forever, and it
            -- cannot see a bundle that genuinely drifted while its own shelf row
            -- happened to match. Eleme enqueues bundles by component floor too
            -- (lib/eleme-sync.js:52), so the same trap is live on this channel.
            OR (p.bundle_items IS NOT NULL AND TRIM(p.bundle_items) NOT IN ('', '[]')))
       ${skip}
     ORDER BY drift_hours DESC, m.product_id
  `).all(...storeCodes);

  const out = [];
  for (const r of rows) {
    const isBundleRow = bundleStock.parseBundleItems(r.bundle_items).length > 0;
    const qty = isBundleRow ? bundleStock.sellableAt(db, r.retail_store_id, r.product_id) : r.qty;
    // packQty, not a bare division: it is what the daemon writes into
    // last_pushed_qty, so it is the only figure a comparison against that column
    // may use. It is total — a missing, zero or junk pack size reads as 1.
    if (r.pushed_qty == null || r.pushed_qty !== packQty(qty, r.units)) {
      const { bundle_items, ...rest } = r;   // eslint-disable-line no-unused-vars
      out.push({ ...rest, qty });
    }
  }
  return out;
}

// A channel's OWN combo listings (Meituan 套餐), whose truth is a component floor
// rather than a stock row. Eleme has none, so this is a no-op there. Kept as a
// descriptor hook rather than omitted so that porting Meituan later is an entry,
// not a re-fork of this file.
function driftingBundles(db, d, storeCodes, opts = {}) {
  if (!d.bundles) return [];
  return d.bundles.drifting(db, storeCodes, { ...opts, DRIFT_RETRY_HOURS });
}

// ── The sweep ────────────────────────────────────────────────────────────────
//
// Re-enqueue everything that drifted, worst offenders first so they make it into
// the batch even when the cap bites.
//
// storeCodes MUST be only the stores this daemon owns. Meituan's two channel
// daemons share meituan_sync_queue and enqueuing for the sibling's store would
// have it push through a session that can't reach that store's backend. Eleme has
// one daemon today, but the rule is the same rule and costs nothing to keep.
function sweepStockDrift(db, descriptor, opts) {
  const d = validate(descriptor);
  const {
    storeCodes, log = () => {}, logSync = () => {},
    notifyMerchant = null, alerts = null,
  } = opts || {};
  if (!storeCodes || !storeCodes.length) return { enqueued: 0, chronic: [] };

  let enqueued = 0;
  const detail = [];

  // Read chronic drift BEFORE enqueuing, not after: the rows this sweep is about to
  // create are 'pending', and a pending row looks like work in flight — so checking
  // afterwards hides every chronic listing behind the retry it just scheduled, and
  // the alert never fires. Read first and the in-flight filter does the right thing:
  // whatever the PREVIOUS sweep queued has either landed (no longer drifting) or
  // failed terminally (no pending row left), so what survives here is genuine.
  const chronic = chronicDrift(db, d, storeCodes);
  // Paging is the part of this that reaches outside the process — a latch file
  // that cannot be written, an ops-alert transport that throws. None of that is a
  // reason to skip the re-enqueue below, which is the actual repair, so it is
  // fenced off rather than left to take the sweep down with it. (This runs inside
  // a daemon's main loop; an escaping throw is a crash and a pm2 restart.)
  if (alerts) {
    try {
      alertChronic({ storeCodes, chronic, db, d, notifyMerchant, alerts, logSync });
    } catch (e) {
      console.error(`[channel-drift-sweep:${d.key}] chronic alerting failed:`, e.message);
    }
  }

  try {
    const products = driftingProducts(db, d, storeCodes);
    const combos   = driftingBundles(db, d, storeCodes);

    const insProduct = db.prepare(`
      INSERT INTO ${d.queueTable}
        (retail_store_id, product_id, store_code, new_qty, status, last_error)
      VALUES (?, ?, ?, ?, 'pending', 'drift sweep — last push never landed')
    `);

    const tx = db.transaction(() => {
      // A product with several claimed options drifts once per option, but the
      // queue row is per PRODUCT — the drain fans it back out to every box
      // (scripts/eleme-daemon.js:493-508 joins one row per claim). One row each,
      // or a multipack would spend three of the sweep's row budget to say the
      // same thing.
      const queued = new Set();
      for (const p of products) {
        if (enqueued >= MAX_ROWS) break;
        const key = `${p.retail_store_id}:${p.product_id}`;
        if (queued.has(key)) continue;
        queued.add(key);
        // The SHELF figure, not this box's share of it. The drain re-derives per
        // box with packQty at push time (scripts/eleme-daemon.js:562), so sending
        // the per-box number here would divide it twice and a 6-pack claim would
        // walk its stock down every sweep.
        insProduct.run(p.retail_store_id, p.product_id, p.store_code, p.qty);
        enqueued++;
        detail.push({ store: p.store_code, sku: p.sku, name: p.name,
                      listing: p.listing || null, spec: p.spec || null,
                      was: p.pushed_qty, now: p.qty, hours: p.drift_hours });
      }
      if (d.bundles) {
        for (const c of combos) {
          if (enqueued >= MAX_ROWS) break;
          d.bundles.enqueue(db, c);
          enqueued++;
          detail.push({ store: c.store_code, name: c.name, bundle: true,
                        was: c.pushed_qty, now: c.qty, hours: c.drift_hours });
        }
      }
    });
    tx();

    if (enqueued) {
      const byStore = {};
      for (const dt of detail) (byStore[dt.store] = byStore[dt.store] || []).push(dt);
      for (const [sc, items] of Object.entries(byStore)) {
        log(sc, `drift sweep: re-enqueued ${items.length} stranded stock push(es)`);
        logSync(sc, 'drift_sweep', 'ok', { count: items.length, items: items.slice(0, 20) },
          `re-enqueued ${items.length} product(s) whose last push never landed`);
      }
    }
  } catch (e) {
    // Meituan's sweep console.errors here and stops, which makes a broken sweep
    // invisible to everyone who isn't reading pm2 logs — and a sweep that has
    // silently stopped running looks exactly like a channel with no drift. Write
    // it where an operator already looks: the channel's own sync log, which the
    // admin tab renders. One row per store in scope, because that log is per store
    // and a failure that produced nothing has no store of its own to name.
    console.error(`[channel-drift-sweep:${d.key}] sweep failed:`, e.message);
    for (const sc of storeCodes) {
      // The log write can fail for the same reason the sweep did (a database that
      // has gone away). The console line above is already out, so swallow rather
      // than turn a reported failure into an unreported crash.
      try {
        logSync(sc, 'drift_sweep', 'error', { error: String(e.message).slice(0, 300) },
          `drift sweep failed: ${String(e.message).slice(0, 200)}`);
      } catch { /* nothing left to tell it to */ }
    }
  }

  return { enqueued, chronic };
}

// Targets that have been wrong for longer than a retry cycle could explain —
// almost always a listing whose channel name stopped matching, or one that was
// mapped but never actually existed on the channel.
//
// Read WITHOUT the cool-down: a target we retried 20 minutes ago is still three
// weeks out of sync, and that is precisely what this alert exists to surface.
function chronicDrift(db, descriptor, storeCodes) {
  const d = validate(descriptor);
  try {
    const p = driftingProducts(db, d, storeCodes, { cooldown: false })
      .filter(r => (r.drift_hours || 0) >= CHRONIC_HOURS)
      .map(r => ({ store: r.store_code, sku: r.sku, name: r.name,
                   listing: r.listing || null, spec: r.spec || null,
                   was: r.pushed_qty, now: r.qty, hours: r.drift_hours,
                   why: r.last_error || null }));
    const b = driftingBundles(db, d, storeCodes, { cooldown: false })
      .filter(r => (r.drift_hours || 0) >= CHRONIC_HOURS)
      .map(r => ({ store: r.store_code, name: r.name, bundle: true,
                   was: r.pushed_qty, now: r.qty, hours: r.drift_hours }));
    return p.concat(b).sort((x, y) => (y.hours || 0) - (x.hours || 0));
  } catch (e) {
    console.error(`[channel-drift-sweep:${d.key}] chronic check failed:`, e.message);
    return [];
  }
}

// Does ANYTHING in this store still disagree with the channel — no age threshold,
// no cool-down, and counting in-flight rows as "not yet synced"? This is the bar
// the ✅ has to clear.
function anyDrift(db, descriptor, storeCode) {
  const d = validate(descriptor);   // exported, so it validates its own input
  try {
    const opts = { cooldown: false, inFlight: false };
    return driftingProducts(db, d, [storeCode], opts).length > 0
        || driftingBundles(db, d, [storeCode], opts).length > 0;
  } catch (e) {
    console.error(`[channel-drift-sweep:${d.key}] anyDrift check failed:`, e.message);
    return true; // can't prove it's clean → don't send an all-clear
  }
}

// One latched alert per store: fires when a store first has chronic drift, clears
// when it has none. Latched on disk (lib/alert-latch) so a deploy mid-incident
// still owes the ✅.
//
// Fire and clear deliberately read DIFFERENT things, because the obvious symmetric
// version flaps. Queuing a retry makes a target "in flight", which hides it from
// the chronic read — so a symmetric clear would announce "all back in sync" the
// instant this sweep scheduled the retries, before a single push had landed, and
// then go red again when they failed. Overnight, with the store shut and rows
// sitting pending for hours, it would do that every 30 minutes.
//
// So: fire on stranded old drift (in-flight work excluded — that's not stranded),
// clear only when nothing mismatches at all, in flight or not. Hysteresis, not
// symmetry: the ✅ means the numbers actually agree.
// `notifyMerchant` is injected by the daemon and is already bound to the
// account whose listings these are (audit P-01): drift on a shop's own
// products is that shop's to act on, not the platform's to watch.
function alertChronic({ storeCodes, chronic, db, d, notifyMerchant, alerts, logSync }) {
  const byStore = {};
  for (const c of chronic) (byStore[c.store] = byStore[c.store] || []).push(c);

  for (const sc of storeCodes) {
    const items = byStore[sc] || [];
    const key   = 'drift:' + sc;
    if (items.length) {
      if (alerts[key]) continue; // already reported — don't re-nag every sweep

      // The sync log is written whether or not the ops group can be paged: it is
      // the record, and the admin Eleme tab renders it. The page is the extra.
      // Structured detail, not prose — nothing here needs translating.
      logSync(sc, 'drift_chronic', 'error', { count: items.length, items: items.slice(0, 20) },
        `${items.length} listing(s) drifting over ${CHRONIC_HOURS}h — see each item's reason`);

      if (!d.alert || !notifyMerchant) {
        // No locked bilingual copy for this channel yet — see the descriptor. Say
        // so on the console and DO NOT latch: latching now would mean the first
        // real alert, once the copy lands, is swallowed as "already reported".
        console.error(`[channel-drift-sweep:${d.key}] ${sc}: ${items.length} listing(s) chronically `
          + `drifting (>=${CHRONIC_HOURS}h), NOT paged — no locked alert copy for this channel yet. `
          + `Logged to ${d.logTable} as drift_chronic.`);
        continue;
      }

      alerts[key] = true;
      // The descriptor owns EVERY human-facing word, per-item lines included —
      // including how to say "never synced" and how the channel's own refusal is
      // introduced. Splitting the headline from the lines would put half the copy
      // in here and guarantee that half gets composed rather than sourced.
      notifyMerchant(d.alert.chronic({ storeCode: sc, count: items.length, hours: CHRONIC_HOURS, items }));
    } else if (alerts[key] && !anyDrift(db, d, sc)) {
      // Nothing stranded AND nothing mismatched — the pushes really landed.
      alerts[key] = false;
      logSync(sc, 'drift_chronic', 'ok', null, 'all listings back in sync');
      if (d.alert && notifyMerchant) notifyMerchant(d.alert.clear({ storeCode: sc }));
    }
  }
}

// Checked once per call rather than at module load, so a descriptor built
// elsewhere gets the same guarantees as the one declared above.
function validate(d) {
  if (!d || typeof d !== 'object') throw new Error('[channel-drift-sweep] descriptor required');
  ident(d.key, 'key');
  ident(d.queueTable, 'queueTable');
  ident(d.mapTable, 'mapTable');
  if (d.unitsColumn)       ident(d.unitsColumn, 'unitsColumn');
  if (d.syncEnabledColumn) ident(d.syncEnabledColumn, 'syncEnabledColumn');
  if (d.listingColumn)     ident(d.listingColumn, 'listingColumn');
  if (d.specLabelColumn)   ident(d.specLabelColumn, 'specLabelColumn');
  return d;
}

module.exports = {
  sweepStockDrift, chronicDrift, anyDrift,
  ELEME,
  DRIFT_RETRY_HOURS, CHRONIC_HOURS, MAX_ROWS,
};
