// Kitchen production ticket — the paper half of the kitchen queue.
//
// WHY THIS EXISTS. A warehouse→kitchen request already announces itself: it
// fans out to every operator holding `restock:fulfil` and opens on
// /stock?go=queue (routes/restock.js PUSH_AUDIENCE). That reaches a phone. A
// kitchen is a room with wet hands, noise and no phone on the bench, and the
// thing that actually gets read there is a slip that comes out of a printer
// and beeps. This module prints one.
//
// NOTHING NEW WAS WIRED FOR IT. The store printers already run on Feieyun's
// cloud (lib/feie.js): the server POSTs the slip text and the cloud pushes it
// to the device, which prints and announces by voice. The kitchen's printer is
// one more device on the SAME account — so this is a second caller of an
// existing rail, not a second rail.
//
// WHY IT IS NOT ROUTED LIKE A STORE PRINTER. Retail slips resolve their
// printer from the order's store (`printer.by_store`, keyed on store id). A
// kitchen request has no locations at all — routes/restock.js nulls both ends
// for any order with a kitchen at either end, because a kitchen request is
// production and not a transfer between shelves. So there is nothing to key a
// map on, and the kitchen printer is a single SN of its own. Decided that way
// (decisions §47): one kitchen today, and a second one is a new decision rather
// than a config row nobody would have filled in.
//
// Config, all under the private `printer.` prefix in storefront_config so it is
// never exposed to the storefront (routes/retail.js PRIVATE_CONFIG_PREFIXES):
//   printer.kitchen_sn        the kitchen device's SN (编号, from its label)
//   printer.kitchen_print_on  'sent' | 'prepared' | 'both' | 'off'
//   printer.kitchen_copies    1–5
//   printer.shop_name         shared with the retail slips — the header
//
// WHEN IT PRINTS IS A TENANT'S CALL, NOT A CONSTANT. Roots wants the slip when
// the job ARRIVES and nothing when it is finished: the people who would read a
// completion slip are the people who just cooked it, and the person actually
// waiting to hear is at the other end of a push. Another tenant may run a
// spike of finished tickets. Hence `kitchen_print_on` rather than a hardcoded
// event — default 'sent', which is Roots'.
//
// Best-effort throughout, exactly like the retail auto-print it copies: a
// request must never fail to reach the queue because a printer is offline, out
// of paper, or unconfigured. The outcome is recorded on the order
// (print_status / print_error / printed_at) so a dropped slip is visible and
// reprintable rather than silent — the printer is the pattern being copied
// here, and a failed print that says nothing is the thing that pattern exists
// to prevent.

'use strict';

const feie = require('./feie');
const { tdb, currentTenantId } = require('./tenant-db');
const { getTenantCreds } = require('./tenant-creds');

// Which events print, per tenant. 'sent' is the default because it is Roots'
// answer and the one a kitchen with no opinion wants: paper when work arrives.
const PRINT_ON = ['off', 'sent', 'prepared', 'both'];
const DEFAULT_PRINT_ON = 'sent';

function _cfg(conn, key, fallback) {
  try {
    const row = conn.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    if (!row || row.value_json == null) return fallback;
    const v = JSON.parse(row.value_json);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// The kitchen printer's saved settings. Reads synchronously off the handle it
// is given — callers pass the request-scoped one BEFORE any await, because the
// network POST settles long after the request's tenant context is gone.
function loadKitchenPrinter(conn) {
  const c = conn || tdb();
  const printOn = String(_cfg(c, 'printer.kitchen_print_on', DEFAULT_PRINT_ON));
  const copies = parseInt(_cfg(c, 'printer.kitchen_copies', 1), 10);
  return {
    sn: String(_cfg(c, 'printer.kitchen_sn', '') || '').trim(),
    print_on: PRINT_ON.includes(printOn) ? printOn : DEFAULT_PRINT_ON,
    copies: Math.max(1, Math.min(5, Number.isFinite(copies) ? copies : 1)),
    shop_name: String(_cfg(c, 'printer.shop_name', '') || '').trim(),
  };
}

// Does this event print under this setting? 'both' is the only one that says
// yes twice; 'off' never does, which is also what an unconfigured SN means.
function shouldPrint(prefs, kind) {
  if (!prefs || !prefs.sn) return false;
  if (prefs.print_on === 'both') return kind === 'sent' || kind === 'prepared';
  return prefs.print_on === kind;
}

// Read the order and its lines off a handle held synchronously. Returns null
// for anything that is not a kitchen request — a store transfer has its own
// paper trail and must never surface on the kitchen's roll.
function loadTicket(conn, orderId) {
  const o = conn.prepare(`SELECT id, rs_number, status, store_name, store_cn, notes, purpose,
      sent_at, prepared_at,
      COALESCE(from_role,'store')   AS from_role,
      COALESCE(to_role,'warehouse') AS to_role
    FROM restock_orders WHERE id = ?`).get(orderId);
  if (!o || o.to_role !== 'kitchen') return null;
  const items = conn.prepare(`SELECT product_name, product_cn, sku, qty_requested, unit, notes
    FROM restock_items WHERE restock_id = ? AND qty_requested > 0 ORDER BY id`).all(orderId);
  return { order: o, items };
}

// Reasons that mean NO PRINT WAS EVER ATTEMPTED — this event is switched off,
// there is no printer, there are no credentials, or the order was never a
// kitchen request at all. None of them is a failed print, and recording one as
// a failure would put a red mark and a "print it again" button on a request
// that was never owed a slip. Kept here rather than at each call site so the
// automatic print and the manual reprint cannot drift on what counts.
const NOT_AN_ATTEMPT = new Set(['print_off', 'no_kitchen_printer', 'not_configured', 'not_a_kitchen_request']);

function isPrintAttempt(result) {
  if (result && result.ok) return true;
  return !NOT_AN_ATTEMPT.has(String((result && result.msg) || ''));
}

// Persist the outcome so the queue can show whether a slip printed and offer a
// reprint. `conn` is captured by the caller before the async print resolves.
// A result that never reached the printer is left alone — see NOT_AN_ATTEMPT.
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
  } catch (e) { console.warn('[kitchen print record]', e.message); }
}

// Render + print one kitchen request. Returns a promise covering only the
// network POST; every DB read happens synchronously first. Resolves with a
// reason rather than throwing, so a caller can report why nothing printed.
function printKitchenRequest(orderId, kind, { conn, prefs, force } = {}) {
  const c = conn || tdb();
  const p = prefs || loadKitchenPrinter(c);
  if (!force && !shouldPrint(p, kind)) return Promise.resolve({ ok: false, msg: 'print_off' });
  if (!p.sn) return Promise.resolve({ ok: false, msg: 'no_kitchen_printer' });
  const creds = (getTenantCreds(currentTenantId()).integrations || {}).feie;
  if (!feie.feieEnabled(creds)) return Promise.resolve({ ok: false, msg: 'not_configured' });
  const t = loadTicket(c, orderId);
  if (!t) return Promise.resolve({ ok: false, msg: 'not_a_kitchen_request' });
  const content = feie.renderKitchenRequest(t.order, t.items, p.shop_name, { kind });
  return feie.printContent(content, { sn: p.sn, copies: p.copies }, creds);
}

// Fire-and-forget wrapper for the route. Captures the tenant handle and the
// creds-bearing context synchronously, then lets the POST settle on its own —
// a slow or offline printer never delays a request reaching the queue. Logs
// both outcomes; records both on the order.
function autoPrintKitchenRequest(orderId, kind) {
  let conn;
  try {
    conn = tdb();
    const prefs = loadKitchenPrinter(conn);
    if (!shouldPrint(prefs, kind)) return;
    printKitchenRequest(orderId, kind, { conn, prefs })
      .then(r => {
        if (r.ok) console.log('[kitchen print]', orderId, kind, 'ok');
        else console.warn('[kitchen print]', orderId, kind, r.msg);
        recordPrintResult(conn, orderId, r);
      })
      .catch(e => {
        console.warn('[kitchen print]', orderId, kind, e.message);
        recordPrintResult(conn, orderId, { ok: false, msg: e.message });
      });
  } catch (e) { console.warn('[kitchen print setup]', e.message); }
}

module.exports = {
  PRINT_ON,
  isPrintAttempt,
  DEFAULT_PRINT_ON,
  loadKitchenPrinter,
  shouldPrint,
  loadTicket,
  recordPrintResult,
  printKitchenRequest,
  autoPrintKitchenRequest,
};
