// Stock-request slip — the paper half of a transfer between two shops (§198).
//
// WHY THIS EXISTS. A store-to-store request has announced itself by push since
// #264, and `routes/restock.js` explained why it got nothing else: "a store
// transfer has its own paper trail and never reaches this roll." IT DID NOT
// HAVE ONE. The sentence described something nobody had built, and for as long
// as it stood it read as a decision that had been taken. Ash raised the gap as
// what it is — a request sent from Yuexiu to Tianhe printed nowhere, and the
// asking phone showed nothing either — and §51's argument for the kitchen slip
// applies here word for word: a shop floor is a room with full hands, noise and
// no phone on the bench, and what actually gets read there is a slip that comes
// out of a printer and beeps.
//
// NOTHING NEW IS WIRED FOR IT, and unlike §51 not even a printer. The kitchen
// needed an SN of its own because a kitchen request carries NO locations at all
// — routes/restock.js nulls both ends for anything with a kitchen on it — so
// there was nothing to key `printer.by_store` on. A transfer names both ends
// outright, so it routes on the same per-shop map a paid order's receipt has
// always used, and a tenant configures nothing at all to get this.
//
// WHICH PRINTER. The SUPPLIER's — `from_store_id`, the shop that has to walk to
// a freezer. Not the destination's: that end raised the request, it is already
// looking, and what it is waiting for is the goods.
//
// Config, under the private `printer.` prefix beside §51's:
//   printer.transfer_print_on   'sent' | 'off'; absent means 'sent'
//   printer.by_store            { "<storeId>": { sn, vendor, copies } } — shared
//                               with the order receipts, never a second map
//   printer.shop_name           the header, shared with every other slip
//
// DEFAULT ON, which is the one place this differs from a setting nobody would
// mind either way. A tenant who has never opened the printer page is exactly
// the tenant this report came from; making paper opt-in would have shipped the
// fix switched off for the person who asked for it.
//
// Best-effort throughout, exactly like the kitchen slip and the retail receipt
// it copies: a request must NEVER fail to reach the supplier because a printer
// is offline, out of paper or unconfigured. The outcome is recorded on the
// order (print_status / print_error / printed_at — the three columns §51 added)
// so a dropped slip is visible and reprintable rather than silent.

'use strict';

const feie = require('./feie');
const printers = require('./printers');
const { tdb, currentTenantId } = require('./tenant-db');
const { getTenantCreds } = require('./tenant-creds');

// 'sent' is the only event that prints. There is deliberately no 'prepared'
// twin of §51's: at `prepared` the goods have left the supplier, and the people
// who would read that slip are the people who just packed it.
const PRINT_ON = ['off', 'sent'];
const DEFAULT_PRINT_ON = 'sent';

function _cfg(conn, key, fallback) {
  try {
    const row = conn.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!row || row.value_json == null) return fallback;
    const v = JSON.parse(row.value_json);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// Read synchronously off the handle the caller holds, BEFORE any await — the
// network POST settles long after the request's tenant context is gone. Same
// rule, and the same reason, as lib/kitchen-print.js.
function loadTransferPrinterPrefs(conn) {
  const c = conn || tdb();
  const printOn = String(_cfg(c, 'printer.transfer_print_on', DEFAULT_PRINT_ON));
  const byStore = _cfg(c, 'printer.by_store', {});
  return {
    print_on: PRINT_ON.includes(printOn) ? printOn : DEFAULT_PRINT_ON,
    by_store: (byStore && typeof byStore === 'object') ? byStore : {},
    shop_name: String(_cfg(c, 'printer.shop_name', '') || '').trim(),
  };
}

// The supplying shop's printer row, or null. NO FALLBACK TO "the only printer
// configured", which is what printerForStore does for a paid order with no
// store on it. That fallback is right there and wrong here: an order with no
// store still has to print somewhere, while a transfer whose supplier has no
// printer must print NOWHERE — sending Tianhe's pick list to Yuexiu's counter
// is a slip that sends somebody to the wrong freezer.
function printerForSupplier(fromStoreId, prefs) {
  if (!fromStoreId) return null;
  const row = (prefs.by_store || {})[String(fromStoreId)];
  if (!row || !String(row.sn || '').trim()) return null;
  return {
    sn: String(row.sn).trim(),
    vendor: printers.resolve(row.vendor || null).id,
    copies: Math.max(1, Math.min(5, parseInt(row.copies, 10) || 1)),
  };
}

function shouldPrint(prefs, kind) {
  if (!prefs) return false;
  return prefs.print_on === kind;
}

// Read the order, its lines and the name of the shop it is FOR, off a handle
// held synchronously. Returns null for anything that is not a shop-to-shop
// request — a kitchen request has §51's roll and a request with no supplier
// named has no printer to route to.
function loadTicket(conn, orderId) {
  const o = conn.prepare(`SELECT id, rs_number, status, store_name, store_cn, notes,
      created_at, sent_at, from_store_id, to_store_id,
      COALESCE(from_role,'store')   AS from_role,
      COALESCE(to_role,'warehouse') AS to_role
    FROM restock_orders WHERE id = ?`).get(orderId);
  if (!o) return null;
  if (o.to_role === 'kitchen' || o.from_role === 'kitchen') return null;
  if (!o.from_store_id) return null;
  const items = conn.prepare(`SELECT product_name, product_cn, sku, qty_requested, unit, notes
    FROM restock_items WHERE restock_id = ? AND qty_requested > 0 ORDER BY id`).all(orderId);
  // The destination BY NAME. store_name is free text a caller may never have
  // set — the phone's Ask-for-stock screen sends neither half of it — so the
  // order's own location id answers first and the free text is the fallback
  // for rows written before #259 gave it one.
  let toName = '';
  if (o.to_store_id) {
    try {
      const r = conn.prepare('SELECT name_en, name_cn FROM retail_stores WHERE id = ?').get(o.to_store_id);
      if (r) toName = String(r.name_cn || r.name_en || '').trim();
    } catch { toName = ''; }
  }
  if (!toName) toName = String(o.store_cn || o.store_name || '').trim();
  return { order: o, items, toName };
}

// Reasons that mean NO PRINT WAS EVER ATTEMPTED. None is a failure, and
// recording one as a failure would put a red mark and a "print it again"
// button on a request that was never owed a slip. Kept beside §51's list for
// the same reason it keeps one: the automatic print and any later reprint must
// not drift on what counts as an attempt.
const NOT_AN_ATTEMPT = new Set([
  'print_off', 'no_store_printer', 'not_configured', 'not_a_transfer',
]);

function isPrintAttempt(result) {
  if (result && result.ok) return true;
  return !NOT_AN_ATTEMPT.has(String((result && result.msg) || ''));
}

// Persist the outcome on the order. `conn` is captured by the caller before the
// async print resolves. Shares §51's three columns deliberately: a request has
// at most one slip owed to it, so a second pair of columns would be two
// answers to "did this print".
function recordPrintResult(conn, orderId, result) {
  if (!isPrintAttempt(result)) return;
  const ok = !!(result && result.ok);
  const err = ok ? null : String((result && result.msg) || 'print_failed').slice(0, 200);
  try {
    conn.prepare(
      `UPDATE restock_orders
          SET print_status = ?,
              print_error  = ?,
              printed_at   = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE printed_at END
        WHERE id = ?`
    ).run(ok ? 'printed' : 'failed', err, ok ? 1 : 0, orderId);
  } catch (e) { console.warn('[transfer print record]', e.message); }
}

// Render + print one stock request at its supplier. Every DB read happens
// synchronously first; the returned promise covers only the network POST.
// Resolves with a reason rather than throwing, so a caller can report why
// nothing printed.
function printTransferRequest(orderId, kind, { conn, prefs, force } = {}) {
  const c = conn || tdb();
  const p = prefs || loadTransferPrinterPrefs(c);
  if (!force && !shouldPrint(p, kind)) return Promise.resolve({ ok: false, msg: 'print_off' });
  const t = loadTicket(c, orderId);
  if (!t) return Promise.resolve({ ok: false, msg: 'not_a_transfer' });
  const printer = printerForSupplier(t.order.from_store_id, p);
  if (!printer) return Promise.resolve({ ok: false, msg: 'no_store_printer' });
  // Creds for the SUPPLYING SHOP's own brand (§171) — a tenant running Feie at
  // one shop and Shangpeng at another prints at both.
  const integrations = getTenantCreds(currentTenantId()).integrations || {};
  if (!printers.resolve(printer.vendor).enabled(printers.credsFor(printer.vendor, integrations))) {
    return Promise.resolve({ ok: false, msg: 'not_configured' });
  }
  const content = feie.renderTransferRequest(t.order, t.items, p.shop_name, { toName: t.toName });
  return printers.printContent(content, printer, integrations);
}

// Fire-and-forget wrapper for the route. Captures the tenant handle and the
// creds-bearing context synchronously, then lets the POST settle on its own —
// a slow or offline printer never delays a request reaching the supplier.
// Logs both outcomes; records both on the order.
function autoPrintTransferRequest(orderId, kind) {
  let conn;
  try {
    conn = tdb();
    const prefs = loadTransferPrinterPrefs(conn);
    if (!shouldPrint(prefs, kind)) return;
    printTransferRequest(orderId, kind, { conn, prefs })
      .then(r => {
        if (r.ok) console.log('[transfer print]', orderId, kind, 'ok');
        else console.warn('[transfer print]', orderId, kind, r.msg);
        recordPrintResult(conn, orderId, r);
      })
      .catch(e => {
        console.warn('[transfer print]', orderId, kind, e.message);
        recordPrintResult(conn, orderId, { ok: false, msg: e.message });
      });
  } catch (e) { console.warn('[transfer print setup]', e.message); }
}

module.exports = {
  PRINT_ON,
  DEFAULT_PRINT_ON,
  isPrintAttempt,
  loadTransferPrinterPrefs,
  printerForSupplier,
  shouldPrint,
  loadTicket,
  recordPrintResult,
  printTransferRequest,
  autoPrintTransferRequest,
};
