// Flash-sale (秒杀) helpers — single source of truth for "is this product
// on flash sale right now?" and "what price should we actually charge?".
//
// A flash sale is configured per product via four columns: flash_price,
// flash_starts_at, flash_ends_at, flash_stock_limit. We treat each product
// as having at most one active flash window at a time — to schedule another,
// just overwrite the four fields. The accumulator flash_sold is reset by the
// admin endpoint whenever the window changes.
//
// Status states used by the API:
//   active    — now is inside [starts_at, ends_at), price applies
//   upcoming  — now < starts_at, not charging yet but worth surfacing
//   ended     — now >= ends_at OR sold out, treat as no flash
//   none      — flash_price not set (the product has no flash configured)

function toMs(v) {
  if (!v) return null;
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' — Date() parses it as local time
  // on some engines, UTC on others. Force UTC by replacing the space with
  // 'T' and appending 'Z' when there's no zone info. This matches how we
  // write the column (toISOString() from the admin).
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
    v = v.replace(' ', 'T') + 'Z';
  }
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Returns { state, price, starts_at, ends_at, stock_limit, stock_sold,
//   stock_remaining, percent_sold } or null when the product has no flash
// price configured. `state` is one of 'active' | 'upcoming' | 'ended' | 'none'.
function flashStatus(product, nowMs) {
  if (!product) return null;
  const fp = Number(product.flash_price);
  if (!(fp > 0)) return null;  // no flash configured
  const now = nowMs ?? Date.now();
  const starts = toMs(product.flash_starts_at);
  const ends   = toMs(product.flash_ends_at);
  const limit  = product.flash_stock_limit == null ? null : Number(product.flash_stock_limit);
  const sold   = Number(product.flash_sold) || 0;
  const stockRemaining = (limit != null && Number.isFinite(limit)) ? Math.max(0, limit - sold) : null;
  const percentSold = (limit != null && limit > 0) ? Math.min(100, Math.round((sold / limit) * 100)) : null;

  let state;
  if (starts != null && now < starts) state = 'upcoming';
  else if (ends != null && now >= ends) state = 'ended';
  else if (stockRemaining === 0) state = 'ended';
  else state = 'active';

  return {
    state,
    price: fp,
    starts_at: product.flash_starts_at || null,
    ends_at: product.flash_ends_at || null,
    stock_limit: (limit != null && Number.isFinite(limit)) ? limit : null,
    stock_sold: sold,
    stock_remaining: stockRemaining,
    percent_sold: percentSold,
  };
}

// Resolve the price the customer should actually pay for one unit of
// this product, BEFORE per-option deltas. Returns { price, is_flash }.
// Pass the product row that includes flash_* columns + the chosen base
// price (sell_price / retail_price — the caller decides which is "retail").
function effectivePriceFor(product, basePrice, nowMs) {
  const base = Number(basePrice) || 0;
  const f = flashStatus(product, nowMs);
  if (f && f.state === 'active' && f.price < base) {
    return { price: f.price, is_flash: true, base_price: base, ends_at: f.ends_at };
  }
  return { price: base, is_flash: false, base_price: base, ends_at: null };
}

// Project the relevant flash fields onto the public product row + add
// derived `effective_price` and `flash` summary. Caller passes the
// already-selected base price field name (defaults to `price` since
// RETAIL_PRODUCT_COLS aliases `sell_price AS price`).
function decorateProduct(row, nowMs, baseField = 'price') {
  if (!row) return row;
  const base = Number(row[baseField]) || 0;
  const f = flashStatus(row, nowMs);
  if (f) {
    row.flash = f;
    if (f.state === 'active' && f.price < base) {
      row.effective_price = f.price;
      row.is_on_flash = true;
    } else {
      row.effective_price = base;
      row.is_on_flash = false;
    }
  } else {
    row.flash = null;
    row.effective_price = base;
    row.is_on_flash = false;
  }
  // Strip the internal storage columns from the public response — we
  // already exposed everything useful via `flash`. Keeps the wire shape
  // tidy and avoids leaking the raw counter.
  delete row.flash_price;
  delete row.flash_starts_at;
  delete row.flash_ends_at;
  delete row.flash_stock_limit;
  delete row.flash_sold;
  return row;
}

module.exports = {
  flashStatus,
  effectivePriceFor,
  decorateProduct,
};
