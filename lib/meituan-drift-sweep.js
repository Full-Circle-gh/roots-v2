'use strict';

// Stock-drift backstop for the Meituan channels (外卖 + 闪购).
//
// The push queue is edge-triggered: a stock change enqueues one row, the daemon
// pushes it, done. That works right up until a push fails terminally — and then
// nothing ever looks at that product again. There are two ways a row dies:
//
//   • 'transient push failure — retries exhausted' (attempts hits 3)
//   • the whole batch throws (browser/page died mid-push)
//
// Either way the row lands in status='error' and no code path re-reads it. The
// product's Meituan stock freezes at whatever last landed, and it stays frozen
// until someone notices by eye. On 2026-07-29 天河 had 13 products drifting this
// way — 云南孟连娜允咖啡豆 showing 6 on Meituan against 2 in the system, stuck since
// 23 June, and five listings that had NEVER pushed successfully at all. The queue
// held 502 error rows and zero pending: nothing was going to fix itself.
//
// So the queue gets a level-triggered partner. This sweep compares the truth
// (retail_store_stock.physical_qty / a bundle's component floor) against what we
// last got Meituan to accept (last_pushed_qty) and re-enqueues the difference. It
// doesn't care WHY the earlier push died — a mismatch is a mismatch.
//
// The thing to be careful about is churn. A listing whose Meituan name no longer
// matches anything will fail forever, and a naive sweep would re-push it every
// cycle, burning browser time on a live risk-controlled session. Two guards:
//
//   • Per-target cool-down (DRIFT_RETRY_HOURS): a target that was queued recently
//     is left alone, so a permanently-broken listing costs ~12 tries a day, not
//     one every 10 seconds.
//   • Per-sweep cap (MAX_ROWS): a mass edit can't flood one cycle's batch.
//
// And a listing that stays broken is an operator problem, not a retry problem —
// anything drifting past CHRONIC_HOURS raises a latched ops alert so it gets seen
// rather than quietly re-tried forever.

const bundles = require('./meituan-bundles');

const DRIFT_RETRY_HOURS = 2;   // don't re-queue the same target more often than this
const CHRONIC_HOURS     = 24;  // drifting this long won't fix itself — tell someone
const MAX_ROWS          = 40;  // cap per sweep (one push batch is 40)

// The three reads below differ only in which queue rows they agree to look past,
// so the exclusion is built once here:
//
//   inFlight — ignore a target that already has a push queued or running. Right for
//              "what should I enqueue" and "what is stuck"; WRONG for "is this store
//              in sync", because a queued push is a promise, not a landed value.
//   cooldown — ignore a target tried inside the last DRIFT_RETRY_HOURS. Only the
//              enqueue read wants this; it is the churn guard, not a fact about sync.
function skipQueued(col, { cooldown, inFlight }) {
  const parts = [];
  if (inFlight) parts.push(`q.status IN ('pending','processing')`);
  if (cooldown) parts.push(`q.created_at > datetime('now', '-${DRIFT_RETRY_HOURS} hours')`);
  if (!parts.length) return '';
  return `AND NOT EXISTS (
             SELECT 1 FROM meituan_sync_queue q
              WHERE q.store_code = ${col.store}
                AND ${col.match}
                AND (${parts.join(' OR ')})
           )`;
}

// Products whose live stock no longer matches what Meituan last accepted.
function driftingProducts(db, storeCodes, { cooldown = true, inFlight = true } = {}) {
  const ph = storeCodes.map(() => '?').join(',');
  const skip = skipQueued(
    { store: 'm.store_code', match: 'q.product_id = m.product_id AND q.bundle_id IS NULL' },
    { cooldown, inFlight });
  return db.prepare(`
    SELECT m.retail_store_id, m.product_id, m.store_code,
           COALESCE(s.physical_qty, 0)            AS qty,
           m.last_pushed_qty                      AS pushed_qty,
           COALESCE(m.units_per_pack, 1)          AS units,
           m.meituan_spec                         AS spec,
           COALESCE(p.name_cn, p.name_en, '?')    AS name,
           p.sku                                  AS sku,
           CAST((julianday('now') - julianday(COALESCE(m.last_pushed_at, m.created_at))) * 24
                AS INTEGER)                       AS drift_hours,
           -- Why the last attempt failed, in the channel's own words where it gave
           -- any. Without it the alert can only guess, and its guess ("the name
           -- probably doesn't match") sent us hunting a 货号 bug for 越秀's four
           -- listings when 闪购 had plainly said 商品正在审核中/被驳回.
           (SELECT q.last_error FROM meituan_sync_queue q
             WHERE q.store_code = m.store_code
               AND q.product_id = m.product_id
               AND q.bundle_id IS NULL
             ORDER BY q.id DESC LIMIT 1)          AS last_error
      FROM meituan_product_map m
      LEFT JOIN retail_store_stock s ON s.store_id  = m.retail_store_id
                                    AND s.product_id = m.product_id
      LEFT JOIN store_products    p ON p.id = m.product_id
     WHERE m.store_code IN (${ph})
       AND m.sync_enabled = 1
       -- Against what THIS option should be holding, not the shelf count: a
       -- 6-bottle option is right when it reads floor(stock / 6), and comparing
       -- it to the raw count would report every multipack as permanently
       -- drifted and re-push it forever.
       AND (m.last_pushed_qty IS NULL
            OR m.last_pushed_qty <> COALESCE(s.physical_qty, 0) / MAX(COALESCE(m.units_per_pack, 1), 1))
       ${skip}
     ORDER BY drift_hours DESC, m.product_id
  `).all(...storeCodes);
}

// Same idea for bundle listings, whose truth is the component floor rather than a
// stock row — so the comparison has to be computed per bundle in JS.
function driftingBundles(db, storeCodes, { cooldown = true, inFlight = true } = {}) {
  const ph = storeCodes.map(() => '?').join(',');
  const skip = skipQueued(
    { store: 'b.store_code', match: 'q.bundle_id = b.id' },
    { cooldown, inFlight });
  const rows = db.prepare(`
    SELECT b.*,
           CAST((julianday('now') - julianday(COALESCE(b.last_pushed_at, b.created_at))) * 24
                AS INTEGER) AS drift_hours
      FROM meituan_bundles b
     WHERE b.store_code IN (${ph})
       AND b.sync_enabled = 1
       ${skip}
     ORDER BY drift_hours DESC, b.id
  `).all(...storeCodes);

  const out = [];
  for (const b of rows) {
    // An empty shell has no truth to compare against — enqueueBundle skips it too,
    // so counting it as drift would alert forever on a half-configured listing.
    if (!bundles.hasComponents(db, b)) continue;
    const qty = bundles.bundleStock(db, b);
    if (b.last_pushed_qty == null || b.last_pushed_qty !== qty) {
      out.push({ bundle: b, qty, name: b.meituan_name, drift_hours: b.drift_hours });
    }
  }
  return out;
}

// Re-enqueue everything that drifted, newest damage last so the worst offenders
// make it into the batch even when the cap bites.
//
// storeCodes MUST be only the stores this daemon owns — the two channel daemons
// share meituan_sync_queue, and enqueuing for a store the sibling handles would
// have it push through a session that can't reach that store's backend.
function sweepStockDrift(db, opts) {
  const {
    storeCodes, channel = '', log = () => {}, logSync = () => {},
    sendOpsAlert = null, alerts = null,
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
  const chronic = chronicDrift(db, storeCodes);
  if (sendOpsAlert && alerts) alertChronic({ storeCodes, chronic, db, channel, sendOpsAlert, alerts, logSync });

  try {
    const products = driftingProducts(db, storeCodes);
    const combos   = driftingBundles(db, storeCodes);

    const insProduct = db.prepare(`
      INSERT INTO meituan_sync_queue
        (retail_store_id, product_id, store_code, new_qty, status, last_error)
      VALUES (?, ?, ?, ?, 'pending', 'drift sweep — last push never landed')
    `);
    const insBundle = db.prepare(`
      INSERT INTO meituan_sync_queue
        (retail_store_id, product_id, store_code, new_qty, status, meituan_name, bundle_id, last_error)
      VALUES (?, NULL, ?, ?, 'pending', ?, ?, 'drift sweep — last push never landed')
    `);

    const tx = db.transaction(() => {
      // A product with several claimed options drifts once per option, but the
      // queue row is per PRODUCT — the drain fans it back out to every box. One
      // row each, or a multipack would spend three of the sweep's row budget to
      // say the same thing.
      const queued = new Set();
      for (const p of products) {
        if (enqueued >= MAX_ROWS) break;
        const key = `${p.retail_store_id}:${p.product_id}`;
        if (queued.has(key)) continue;
        queued.add(key);
        insProduct.run(p.retail_store_id, p.product_id, p.store_code, p.qty);
        enqueued++;
        detail.push({ store: p.store_code, sku: p.sku, name: p.name, spec: p.spec || null,
                      was: p.pushed_qty, now: p.qty, hours: p.drift_hours });
      }
      for (const c of combos) {
        if (enqueued >= MAX_ROWS) break;
        insBundle.run(c.bundle.retail_store_id, c.bundle.store_code, c.qty,
                      c.bundle.meituan_name, c.bundle.id);
        enqueued++;
        detail.push({ store: c.bundle.store_code, name: c.name, bundle: true,
                      was: c.bundle.last_pushed_qty, now: c.qty, hours: c.drift_hours });
      }
    });
    tx();

    if (enqueued) {
      const byStore = {};
      for (const d of detail) (byStore[d.store] = byStore[d.store] || []).push(d);
      for (const [sc, items] of Object.entries(byStore)) {
        log(sc, `drift sweep: re-enqueued ${items.length} stranded stock push(es)`);
        logSync(sc, 'drift_sweep', 'ok', { count: items.length, items: items.slice(0, 20) },
          `re-enqueued ${items.length} product(s) whose last push never landed`);
      }
    }
  } catch (e) {
    console.error('[meituan-drift-sweep] sweep failed:', e.message);
  }

  return { enqueued, chronic };
}

// Targets that have been wrong for longer than a retry cycle could explain —
// almost always a listing whose Meituan name stopped matching, or one that was
// mapped but never actually existed on Meituan.
//
// Read WITHOUT the cool-down: a target we retried 20 minutes ago is still three
// weeks out of sync, and that is precisely what this alert exists to surface.
function chronicDrift(db, storeCodes) {
  try {
    const p = driftingProducts(db, storeCodes, { cooldown: false })
      .filter(r => (r.drift_hours || 0) >= CHRONIC_HOURS)
      .map(r => ({ store: r.store_code, sku: r.sku, name: r.name,
                   was: r.pushed_qty, now: r.qty, hours: r.drift_hours,
                   why: r.last_error || null }));
    const b = driftingBundles(db, storeCodes, { cooldown: false })
      .filter(r => (r.drift_hours || 0) >= CHRONIC_HOURS)
      .map(r => ({ store: r.bundle.store_code, name: r.name, bundle: true,
                   was: r.bundle.last_pushed_qty, now: r.qty, hours: r.drift_hours }));
    return p.concat(b).sort((x, y) => (y.hours || 0) - (x.hours || 0));
  } catch (e) {
    console.error('[meituan-drift-sweep] chronic check failed:', e.message);
    return [];
  }
}

// Does ANYTHING in this store still disagree with Meituan — no age threshold, no
// cool-down, and counting in-flight rows as "not yet synced"? This is the bar the
// ✅ has to clear.
function anyDrift(db, storeCode) {
  try {
    const opts = { cooldown: false, inFlight: false };
    return driftingProducts(db, [storeCode], opts).length > 0
        || driftingBundles(db, [storeCode], opts).length > 0;
  } catch (e) {
    console.error('[meituan-drift-sweep] anyDrift check failed:', e.message);
    return true; // can't prove it's clean → don't send an all-clear
  }
}

// One latched alert per store: fires when a store first has chronic drift, clears
// when it has none. Latched on disk so a deploy mid-incident still owes the ✅.
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
function alertChronic({ storeCodes, chronic, db, channel, sendOpsAlert, alerts, logSync }) {
  const byStore = {};
  for (const c of chronic) (byStore[c.store] = byStore[c.store] || []).push(c);

  for (const sc of storeCodes) {
    const items = byStore[sc] || [];
    const key   = 'drift:' + sc;
    if (items.length) {
      if (alerts[key]) continue; // already reported — don't re-nag every sweep
      alerts[key] = true;
      const lines = items.slice(0, 6).map(i => {
        const label = [i.sku, i.name].filter(Boolean).join(' ');
        const was   = i.was == null ? '从未同步/never synced' : i.was;
        // The channel's own refusal, when it gave one, beats any guess we could
        // print here — it is frequently a merchant-side state (a listing sitting in
        // 闪购's review queue, say) rather than anything wrong with the mapping.
        const why   = i.why ? `\n    ↳ ${String(i.why).slice(0, 120)}` : '';
        return `· ${label}: 系统 ${i.now} / 美团 ${was}${why}`;
      });
      const more = items.length > 6 ? `\n…以及其他 ${items.length - 6} 项 / and ${items.length - 6} more` : '';
      sendOpsAlert(
        `🔴 美团${channel} ${sc} 有 ${items.length} 个商品库存长期不同步（超过 ${CHRONIC_HOURS} 小时），需要人工看一下（下面是美团给的原因）\n` +
        `Meituan ${channel} ${sc}: ${items.length} listing(s) stuck out of sync for over ${CHRONIC_HOURS}h — needs a human; the channel's own reason is shown where it gave one\n` +
        lines.join('\n') + more
      );
      logSync(sc, 'drift_chronic', 'error', { count: items.length, items: items.slice(0, 20) },
        `${items.length} listing(s) drifting over ${CHRONIC_HOURS}h — see each item's reason`);
    } else if (alerts[key] && !anyDrift(db, sc)) {
      // Nothing stranded AND nothing mismatched — the pushes really landed.
      alerts[key] = false;
      sendOpsAlert(`✅ 美团${channel} ${sc} 库存已全部同步\nMeituan ${channel} ${sc} — all listings back in sync`);
      logSync(sc, 'drift_chronic', 'ok', null, 'all listings back in sync');
    }
  }
}

module.exports = { sweepStockDrift, chronicDrift, DRIFT_RETRY_HOURS, CHRONIC_HOURS, MAX_ROWS };
