// The tenant's printer settings as one object: whether paid orders, add-ons
// and refund requests print by themselves, each shop's printer, the kitchen's
// printer and its brand, the stock-request slip switch, the name on the slip,
// and the shop that prints every out-of-city order. Read from storefront_config
// printer.* rows. Moved out of routes/retail.js unchanged (decisions §477) so
// the delivery zone code can follow it. Pinned by scripts/test_printer_prefs.js.
'use strict';

const { tdb } = require('./tenant-db');
const _printers = require('./printers');
const _kprint = require('./kitchen-print');
const _tprint = require('./transfer-print');
const { tenantBrandLabel } = require('./tenant-brand');

function loadPrinterPrefs() {
  const get = (k, d) => {
    const r = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
    if (!r) return d;
    try { return JSON.parse(r.value_json); } catch { return d; }
  };
  const by_store = get('printer.by_store', {});
  const oocRaw = get('printer.out_of_city_store_id', null);
  const ooc = oocRaw != null && /^\d+$/.test(String(oocRaw)) ? parseInt(oocRaw, 10) : null;
  return {
    auto_print: get('printer.auto_print', true),
    // Independent of auto_print: whether to print the focused "add-on" slip
    // when a customer adds to an already-paid order. Default on.
    auto_print_addon: get('printer.auto_print_addon', true),
    // Independent toggle: print a "refund request" alert slip the moment a
    // customer files a refund. Default on.
    auto_print_refund: get('printer.auto_print_refund', true),
    // The KITCHEN's printer — one SN of its own, not a row in by_store. A
    // kitchen request carries no store id at either end (routes/restock.js
    // nulls both for anything with a kitchen on it), so there is nothing to
    // key the store map on. `kitchen_print_on` says which events print by
    // themselves: 'sent' (Roots' answer — paper when work arrives), 'prepared',
    // 'both', or 'off'. lib/kitchen-print.js is what reads these.
    kitchen_sn: String(get('printer.kitchen_sn', '') || '').trim(),
    // Which BRAND the kitchen's printer is (§171). Absent means Feie, which
    // is what every kitchen SN saved before §171 is.
    kitchen_vendor: _printers.resolve(get('printer.kitchen_vendor', null)).id,
    kitchen_print_on: get('printer.kitchen_print_on', _kprint.DEFAULT_PRINT_ON),
    kitchen_copies: get('printer.kitchen_copies', 1),
    // §198 — the stock-request slip, which needs NO printer of its own: it
    // routes on `by_store` below, keyed on the supplying shop. So this is one
    // switch and not a block: 'sent' or 'off', default ON, because the tenant
    // who has never opened this page is the one the report came from.
    transfer_print_on: get('printer.transfer_print_on', _tprint.DEFAULT_PRINT_ON),
    shop_name:  get('printer.shop_name', tenantBrandLabel()),
    by_store:   (by_store && typeof by_store === 'object') ? by_store : {},
    // Orders shipping OUTSIDE Guangzhou always print at this store's printer
    // (e.g. the Tianhe warehouse that handles all out-of-city fulfilment).
    // null → fall back to the order's own store routing.
    out_of_city_store_id: ooc,
  };
}

module.exports = { loadPrinterPrefs };
