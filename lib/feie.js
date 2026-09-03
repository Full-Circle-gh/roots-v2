// Feie (飞鹅) cloud-printer integration — feieyun.com Open API.
//
// The store's printer is a 4G/WiFi 云打印机 (e.g. model FP-V58-D, 58mm).
// It is bound to a Feieyun account and listens to Feieyun's cloud. Our
// server never talks to the device directly — it POSTs the receipt text
// to Feieyun's Open API and the cloud pushes it to the printer, which
// prints (and announces by voice) within a second or two. This is why a
// remote server printing to an on-site printer "just works": no LAN, no
// agent, no port forwarding.
//
// Account credentials live in process.env (hydrated from storefront_config
// at boot by database.js, mirrored on save by the Integrations PUT endpoint):
//   FEIE_USER  — Feieyun account login (the phone/email you sign in with)
//   FEIE_UKEY  — USERKEY from the open.feieyun.com developer console.
//                NOT the 密钥/KEY printed on the device label — that one
//                only binds the printer to your account in the app.
//
// Printer SNs are NOT account-wide: one account can hold many printers (one
// per store). Each store's SN (编号, from the device label) is configured
// per-store in storefront_config `printer.by_store` and passed explicitly to
// printContent — so a paid order prints only at the store that fulfils it.
//
// API reference: http://www.feieyun.com/open/index.html
//   apiname = Open_printMsg   → print immediately
//   sig     = sha1(USER + UKEY + stime)   (stime = unix seconds)

const crypto = require('crypto');
// What delivery/pickup/counter each MEAN. A counter sale is handed over at the
// till, so nothing on a slip may promise a future hand-over.
const { isCounter } = require('./fulfilment');

const API_URL = 'https://api.feieyun.cn/Api/Open/';

// Per-tenant integration creds (Platform readiness ⑤). feieEnabled/call take
// an explicit `c` = { user, ukey } resolved by the caller from
// getTenantCreds(tenantId).integrations.feie, so an order prints on the
// fulfilling tenant's OWN Feieyun account. `_env()` is the Roots/legacy
// fallback used only when no creds are passed.
function _env() {
  return { user: process.env.FEIE_USER || '', ukey: process.env.FEIE_UKEY || '' };
}

function feieEnabled(c) {
  c = c || _env();
  return !!(c.user && c.ukey);
}

function sign(user, ukey, stime) {
  return crypto.createHash('sha1').update(user + ukey + stime).digest('hex');
}

// Low-level call. Returns { ok, msg, data }. Never throws on a Feieyun
// error response — callers (auto-print) treat printing as best-effort.
// `c` = the tenant's feie creds { user, ukey }.
async function call(apiname, extra = {}, c) {
  c = c || _env();
  const user = c.user;
  const ukey = c.ukey;
  if (!user || !ukey) return { ok: false, msg: 'not_configured' };
  const stime = Math.floor(Date.now() / 1000);
  const form = new URLSearchParams({
    user,
    stime: String(stime),
    sig: sign(user, ukey, stime),
    apiname,
    ...extra,
  });
  let r, body;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
    });
    body = await r.json();
  } catch (e) {
    return { ok: false, msg: 'network_error: ' + e.message };
  }
  // Feieyun: ret === 0 means success.
  if (body && body.ret === 0) return { ok: true, msg: body.msg, data: body.data };
  return { ok: false, msg: (body && (body.msg || body.ret)) || 'unknown_error', raw: body };
}

// Feieyun rejects Open_printMsg outright once `content` exceeds ~5000 bytes
// (UTF-8) — the whole print fails, every retry included, until the content
// shrinks. A single runaway free-text field (customer note, refund reason —
// see truncateBytes() call sites in the templates below) is the realistic way
// a slip gets there, but this is the last line of defense: whatever produced
// the overflow, printing a truncated slip beats a permanently unprintable
// order. Byte-safe — never splits a UTF-8 multi-byte sequence, which a plain
// String.slice() would risk doing mid-character.
const MAX_CONTENT_BYTES = 5000;

function truncateBytes(s, maxBytes, marker = '') {
  s = String(s == null ? '' : s);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  // Node's utf8 decoder replaces a sequence left dangling by the byte cut
  // with U+FFFD — strip that before appending the marker.
  const cut = Buffer.from(s, 'utf8').slice(0, budget).toString('utf8').replace(/�+$/, '');
  return cut + marker;
}

// Free-text fields (customer note, refund reason) are the one part of a slip
// whose length checkout/admin input doesn't fully bound — cap them here so a
// single long one can't by itself push a slip toward Feieyun's 5000-byte
// ceiling. MAX_CONTENT_BYTES above is the last-resort net on the whole slip;
// this keeps the OTHER content (notably the money total, further down the
// slip) from being the part that gets cut when a note runs long.
const NOTE_MAX_BYTES = 600;
function noteText(s) {
  return truncateBytes(s, NOTE_MAX_BYTES, '…(过长已截断 truncated)');
}

// Print a pre-rendered content string on a given printer.
//   content — Feieyun-flavoured markup (see renderers below)
//   sn      — printer SN (defaults to env FEIE_SN)
//   copies  — number of copies (Feieyun `times`), default 1
async function printContent(content, { sn, copies } = {}, c) {
  if (!sn) return { ok: false, msg: 'no_sn' };
  const body = truncateBytes(String(content || ''), MAX_CONTENT_BYTES, '\n…(内容过长已截断 truncated)\n');
  const extra = { sn: String(sn), content: body };
  const n = parseInt(copies, 10);
  if (n > 1) extra.times = String(n);
  return call('Open_printMsg', extra, c);
}

// ─── 58mm layout helpers ────────────────────────────────────────────────
// 58mm thermal is nominally 32 half-width columns, but real FP-V58-D heads
// don't print the 32nd column — right-aligned values lost their last char
// (142.0→should be 142.00, "wecha"→wechat). Use 31 so the price column lands
// inside the printable area. CJK glyphs occupy 2 columns.
const WIDTH = 31;

function dispLen(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return n;
}

// "left .... right" padded to a full line (right-aligned price column).
function row(left, right) {
  left = String(left == null ? '' : left);
  right = String(right == null ? '' : right);
  const gap = WIDTH - dispLen(left) - dispLen(right);
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  // Wrap: left on its own line, right pushed to the next line right-aligned.
  const pad = WIDTH - dispLen(right);
  return left + '\n' + (pad > 0 ? ' '.repeat(pad) : '') + right;
}

function rule(ch = '-') {
  return ch.repeat(WIDTH);
}

function money(n) {
  // Full-width yuan sign U+FFE5 (￥), not Latin ¥ U+00A5 — Chinese thermal
  // printers render the full-width sign natively, but spit out two junk
  // marks for the Latin one. dispLen counts it as 2 columns (charCode > 0xff).
  return '￥' + Number(n || 0).toFixed(2);
}

// Format a paid_at / placed_at SQLite UTC string as local HH:MM display.
// SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC; shift into store-local time
// (UTC+8, same offset the slot/date helpers below use) before printing so
// the receipt clock matches what the operator and admin see, not raw UTC.
function fmtTime(s) {
  if (!s) return '';
  const norm = String(s).replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(norm) ? norm : norm + 'Z');
  if (isNaN(d.getTime())) return String(s).replace('T', ' ').slice(0, 16);
  const gz = new Date(d.getTime() + 8 * 3600000);
  return gz.toISOString().replace('T', ' ').slice(0, 16);
}

// Combine a CN + EN pair the way item names are shown: "中文 / English"
// when both exist and differ, otherwise whichever is present.
function bilingual(cn, en) {
  cn = cn && String(cn).trim();
  en = en && String(en).trim();
  if (cn && en && cn !== en) return cn + ' / ' + en;
  return cn || en || '';
}

// Parse the chosen-options snapshot into { q, a } pairs so the printed line
// is self-describing ("Heat up?: Yes" — NOT a bare "Yes"). The order line
// snapshots question_en/cn alongside the answer label (see retail.js cart
// resolve), so the question survives even if the option is later edited.
// Legacy/string entries (no question) come back as { q: '', a: <string> }.
function parseOptions(json) {
  if (!json) return [];
  const fmt = a => (a == null ? '' : String(a).trim());
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) {
      return v.map(o => {
        if (o && typeof o === 'object') {
          const q = bilingual(o.question_cn, o.question_en);
          const a = bilingual(o.label_cn, o.label || o.label_en);
          return { q, a: a || fmt(o.label) };
        }
        return { q: '', a: fmt(o) };
      }).filter(p => p.a);
    }
    if (v && typeof v === 'object') {
      return Object.values(v).map(x => ({ q: '', a: fmt(x) })).filter(p => p.a);
    }
  } catch { /* ignore */ }
  return [];
}

// Render one { q, a } option pair as a single printable line.
function optLine(op) {
  return op.q ? `${op.q}: ${op.a}` : op.a;
}

function itemName(it) {
  const cn = it.name_cn && String(it.name_cn).trim();
  const en = it.name_en && String(it.name_en).trim();
  if (cn && en && cn !== en) return cn + ' / ' + en;
  return cn || en || it.sku || '#' + (it.product_id || '');
}

// Break a bilingual item name at the " / " bilingual() already put there, so a
// long name splits BETWEEN languages instead of mid-word: "素食牛肉丸 / Plant-
// based beef ba" / "lls" becomes "素食牛肉丸" / "Plant-based beef balls".
//
// This is a semantic split at a separator the author supplied — NOT generic
// wrapping. A column-counting wrapper was surveyed and declined
// (`tacet-desktop-patterns.md` §1.21); this needs no column arithmetic beyond
// deciding whether to split at all.
//
// Splits ONLY when the name would otherwise overrun `limit`. A name that fits
// comes back as a single element, so every slip whose names already fit is
// byte-identical. A name with no " / " (one language, or a SKU fallback) comes
// back whole and wraps at the head exactly as it does today — nothing here
// truncates, and if one language alone still overruns it wraps as before.
function nameLines(name, limit = WIDTH) {
  name = String(name == null ? '' : name);
  if (dispLen(name) <= limit) return [name];
  const i = name.indexOf(' / ');           // first separator: bilingual() puts CN first
  if (i < 0) return [name];
  return [name.slice(0, i), name.slice(i + 3)];
}

function skuText(it) {
  return it.sku ? String(it.sku).trim() : '';
}

// Compare SKUs numerically segment-by-segment so "1-2" < "1-10" < "2-1"
// (a plain string compare puts "1-10" before "1-2"). Mirrors the admin
// order-detail SKU sort so printed receipts/packing slips read in the same
// order the packer sees on screen. Items with no SKU sink to the bottom.
function skuCompare(a, b) {
  const sa = a ? String(a).trim() : '', sb = b ? String(b).trim() : '';
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  const na = sa.split(/(\d+)/).filter(s => s !== '');
  const nb = sb.split(/(\d+)/).filter(s => s !== '');
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const pa = na[i], pb = nb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const da = /^\d+$/.test(pa), db = /^\d+$/.test(pb);
    if (da && db) {
      const diff = parseInt(pa, 10) - parseInt(pb, 10);
      if (diff) return diff;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

// Default print order = by SKU. Stable copy so we never mutate the caller's array.
function bySku(items) {
  return [...(items || [])].sort((a, b) => skuCompare(a.sku, b.sku));
}

// Refunded units on a line (clamped to the ordered qty). Stamped by the refund-
// settlement paths into retail_order_items.refunded_qty.
function refundedQty(it) {
  const q = Math.max(0, Number(it.qty) || 0);
  return Math.min(q, Math.max(0, Number(it.refunded_qty) || 0));
}
// Units still to ship = ordered minus refunded. 0 → fully refunded (drop it from
// the packing slip); a partial leaves the remainder to pack.
function shipQty(it) {
  return Math.max(0, (Number(it.qty) || 0) - refundedQty(it));
}

// A bundle line is one SKU on the wire but really N component products. The
// bundle's OWN sku is irrelevant to whoever packs/ships — they need each
// component's sku + how many to pull. Returns the printable component lines for
// a bundle line (or [] for a normal line). `pack_qty` is the total to pack
// (component qty × units bought), set server-side.
function bundleLines(it) {
  const comps = Array.isArray(it.bundle_components) ? it.bundle_components : [];
  if (!comps.length) return [];
  const out = ['  Inside · 套装内含:'];
  for (const c of comps) {
    const q = Number(c.pack_qty) || 0;
    const sku = skuText(c);
    const pfx = `  x${q}  `;
    const nl = nameLines(itemName(c), WIDTH - dispLen(pfx));
    out.push(pfx + nl[0]);
    // Continuation aligns under the name, not under the qty — derived from the
    // prefix width so it stays right if the prefix ever changes.
    for (const l of nl.slice(1)) out.push(' '.repeat(dispLen(pfx)) + l);
    if (sku) out.push(`<B>  SKU ${sku}</B>`);   // each component's own sku, enlarged
  }
  return out;
}

// Lines for one item. Quantity is enlarged when >1 (so a packer instantly
// sees "this isn't a single"); SKU is enlarged on its own line for fast
// scanning; `price` adds the qty×unit / line-total money row (receipt only).
function itemLines(it, { price } = {}) {
  const out = [];
  const q = Number(it.qty) || 0;
  // Name stays normal size (bold only) — keeps long/CJK names crisp on 58mm.
  // Only the quantity (when >1) and SKU are enlarged, together on one line.
  // One line per language when the glued pair would overrun (nameLines).
  for (const l of nameLines(itemName(it))) out.push(`<BOLD>${l}</BOLD>`);
  const comps = bundleLines(it);
  // Bundle: its own sku means nothing to the packer — show only the qty enlarged
  // and list each component's sku instead. Normal line: qty + own sku enlarged.
  const sku = comps.length ? '' : skuText(it);
  const big = (q > 1 ? `x${q}` : '') + (q > 1 && sku ? '  ' : '') + (sku ? `SKU ${sku}` : '');
  if (big) out.push(`<B>${big}</B>`);               // qty + SKU enlarged
  // Drop-ship line: the supplier ships this straight to the customer, so the
  // packer must NOT pull it from our own stock. Enlarged + flagged so it can't
  // be missed against the rest of the manifest.
  if (it.ship_from_supplier) out.push('<B>** 供应商直发 SUPPLIER-DIRECT · do not pack **</B>');
  if (it.size) out.push('  ' + String(it.size));
  out.push(...comps);                               // bundle component pack list
  // Each chosen option on its own line WITH its question, so the receipt
  // reads "Heat up?: Yes" instead of a bare, ambiguous "Yes".
  for (const op of parseOptions(it.options_json)) out.push('  ' + optLine(op));
  if (price) out.push(row(`  ${q} x ${money(it.unit_price)}`, money(it.line_total)));
  return out;
}

// Split packages: an order can ship as several parcels (retail_shipments —
// e.g. an out-of-GZ order splits into 'air' + 'land'). Group items by their
// shipment so each parcel prints as its own labelled block. Returns null for
// a single-package order so templates stay clean for the common case.
function groupByShipment(items, shipments) {
  if (!Array.isArray(shipments) || shipments.length <= 1) return null;
  const byId = new Map(shipments.map(s => [s.id, { id: s.id, mode: s.mode, label: s.label, items: [] }]));
  const other = [];
  for (const it of items) {
    const g = byId.get(it.shipment_id);
    if (g) g.items.push(it); else other.push(it);
  }
  const groups = [...byId.values()].filter(g => g.items.length);
  if (other.length) groups.push({ id: 0, mode: '', label: 'Other · 其他', items: other });
  for (const g of groups) g.items = bySku(g.items);   // print each parcel in SKU order
  return groups.length > 1 ? groups : null;
}

function pkgLabel(g) {
  if (g.label) return String(g.label);
  return ({ local: 'Local · 同城', air: 'Air · 空运', land: 'Land · 陆运' })[g.mode] || (g.mode || '');
}

const _MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _pad2 = n => String(n).padStart(2, '0');

// True when a timestamp lands at 00:00 Guangzhou (UTC+8) wall-clock — the
// signature of a DATE-ONLY pick (schedule-for-later day / day-only zone), which
// parses to local midnight, vs a real time-slot pick that carries a clock time.
// Mirrors _gzIsMidnight in routes/retail.js. Host-TZ independent (explicit +8h).
function isGzMidnight(ts) {
  if (!ts) return false;
  const s = String(ts);
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return false;
  const gz = new Date(d.getTime() + 8 * 3600000);
  return gz.getUTCHours() === 0 && gz.getUTCMinutes() === 0;
}

// Render a stored date/timestamp as a short Guangzhou (UTC+8) date for a slip:
//   "2026-06-23"            → "Jun 23"        (bare date — the date IS the value)
//   "2026-06-22T16:00:00Z"  → "Jun 23"        (GZ-midnight → date-only)
//   "...T08:00:00Z"         → "Jun 23 16:00"  (real time → date + GZ time)
// The +8h shift makes it host-TZ independent so a UTC server can't drift a day.
function fmtSlotDate(s) {
  if (!s) return '';
  const str = String(s).trim();
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (mDay) return `${_MON[+mDay[2] - 1]} ${_pad2(+mDay[3])}`;
  const d = new Date(/[TZ]/.test(str) ? str : str.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const gz = new Date(d.getTime() + 8 * 3600000);
  const date = `${_MON[gz.getUTCMonth()]} ${_pad2(gz.getUTCDate())}`;
  return (gz.getUTCHours() === 0 && gz.getUTCMinutes() === 0)
    ? date
    : `${date} ${_pad2(gz.getUTCHours())}:${_pad2(gz.getUTCMinutes())}`;
}

// A printed slot label can LEAD with a relative day word — "Tomorrow 10:00–12:00"
// / "明天 10:00–12:00" — frozen at the moment the customer checked out. The
// customer reads the slip on the actual delivery day, when "tomorrow" already
// means today: stale and confusing. Swap the leading relative word for the
// CONCRETE date resolved from scheduled_for (the absolute slot timestamp),
// matching the word's language so a Chinese slip stays Chinese and an English
// one stays English. Mirrors absolutizeSlotLabel() in 04-orders.js. Labels
// without a leading relative word (or with no usable scheduled_for) pass through.
function absolutizeSlot(label, scheduledForIso) {
  if (!label || !scheduledForIso) return label;
  const s = String(label);
  const m = /(today|tomorrow|yesterday|今天|明天|昨天)/i.exec(s);
  if (!m) return label;
  const str = String(scheduledForIso).trim();
  const mDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  // Bare date IS the date (no shift); a timestamp gets the +8h Guangzhou shift so
  // a UTC host can't drift the day — same rule as fmtSlotDate().
  const d = mDay
    ? new Date(Date.UTC(+mDay[1], +mDay[2] - 1, +mDay[3]))
    : new Date(/[TZ]/.test(str) ? str : str.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return label;
  const gz = mDay ? d : new Date(d.getTime() + 8 * 3600000);
  const isCn = /[今明昨]/.test(m[1]);
  const datePart = isCn
    ? `${gz.getUTCMonth() + 1}月${gz.getUTCDate()}日`
    : `${_MON[gz.getUTCMonth()]} ${_pad2(gz.getUTCDate())}`;
  return s.replace(m[1], datePart);   // swap the word in place, keep "Pickup …"/time tail
}
// The customer's free-text delivery_slot_label is usually already human
// ("Today 16:00–18:00", "Pickup Today 14:30"), but some rows store a raw ISO
// timestamp or a bare "YYYY-MM-DD" instead — reformat just those so the slip
// never leaks "2026-06-22T16:00:00.000Z". Mirrors humanizeSlotLabel in
// 04-orders.js. Anything else passes through untouched.
function humanizeSlot(label) {
  if (!label) return '';
  const s = String(label).trim();
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(s)) return fmtSlotDate(s) || s;
  return s;
}

// ── Ship-by / delivery line for printed slips. MIRRORS the admin's
// annotateShipBy() + shipByPlan() in public/retail-admin/04-orders.js — keep the
// precedence in sync. The print row is a raw retail_orders SELECT (*) so it has
// promised_*, delivery_slot_*, scheduled_for, delivery_slot_kind, but NOT the
// API-only ship_by_mode/dispatch_deadline. Returns { label, value } or null
// (null when there's no customer-facing date). The caller prints them on TWO
// lines — see pushShipBy(), which is what keeps the day on the paper.
// Labels are bilingual ("English 中文") to match the slip's other labels
// (Cutlery 餐具, 配货单, 空运) — the receipt is customer-facing.
//   pickup    → "Pickup 自提"      + <window>
//   batch     → "Arrives 预计送达" + ~<delivery_date>   (fresh-batch arrival estimate)
//   scheduled → "Deliver 送达"     + <slot/date>        (calendar/same-day pick — courier INCLUDED)
//   express   → null                                   (only an operator-internal 48h deadline)
// FOOTGUN history: this used to short-circuit `if (isCourier) return ''`, which
// dropped the delivery date from every air/land receipt EVEN when the customer
// scheduled a real date — so out-of-city scheduled orders printed no date at
// all. A courier shipment is NOT the same as an express ("ASAP") order; the
// customer's chosen date prints regardless of shipping mode. Only express /
// right-away / restock / unscheduled orders have nothing customer-facing.
function shipByPrintParts(o) {
  // 0 — Counter sale: nothing was promised, so nothing prints. The goods went
  // over the counter as the slip was cut; a "Deliver 送达" or "Pickup 自提" line
  // would name a future hand-over that already happened. Returned null rather
  // than left to fall through, because steps 2–4 below decide from the ABSENCE
  // of promised_ship_date / scheduled_for, and absence is a fragile reason for a
  // line this important to be missing.
  if (isCounter(o)) return null;
  // 1 — Pickup: the counter window.
  if (o.fulfillment_type === 'pickup') {
    const w = slotValue(o.delivery_slot_label, o.scheduled_for);
    return w ? { label: 'Pickup 自提', value: w } : null;
  }
  // 2 — Fresh batch: the customer-facing arrival estimate. The make-fresh SHIP
  // date is operator-only (it's on the packing slip), so the receipt shows the
  // arrival, not the ship date.
  if (o.promised_ship_date) {
    const arr = fmtSlotDate(o.promised_delivery_date) || fmtSlotDate(o.promised_ship_date);
    return arr ? { label: 'Arrives 预计送达', value: `~${arr}` } : null;
  }
  // 3 — A genuine customer-scheduled delivery date / slot. Mirrors the server's
  // annotateShipBy: a 'schedule' (calendar pick) or 'today' (same-day) kind is a
  // date the customer chose and we promised, so it prints on EVERY order —
  // courier shipments included. Express / right-away / restock orders (and the
  // legacy no-kind row whose slot sits at GZ midnight) carry only the operator's
  // internal send-by deadline, which is never shown to the customer.
  const kind = o.delivery_slot_kind;
  const explicitDate = (kind === 'schedule' || kind === 'today');
  const isAsap = kind === 'express' || kind === 'right_away' || kind === 'restock'
    || !o.scheduled_for
    || (kind == null && isGzMidnight(o.scheduled_for));
  if (explicitDate || !isAsap) {
    const slot = slotValue(o.delivery_slot_label, o.scheduled_for);
    if (slot) return { label: 'Deliver 送达', value: slot };
  }
  // 4a — Right-away is a REAL customer pick (as-soon-as-possible), not an absent
  // date like express/restock. Print it so the packer knows to move it fast,
  // mirroring the admin's shipByPlan() Right-away headline.
  if (kind === 'right_away') return { label: 'Deliver 送达', value: 'Right away 立即配送' };
  // 4b — Express / restock / nothing scheduled → no customer-facing date.
  // Express stores the system's earliest fulfillable day, not a day the customer
  // asked for, so it stays off the slip by design — a printed date is only ever
  // a genuinely scheduled (future or same-day) order.
  return null;
}

// Some clients bake the verb into delivery_slot_label — the web storefront's
// date picker saves "Deliver 2026-08-03" / "配送 2026-08-03" (shop.html rsDate),
// the mini-app's reschedule POST does the same, and pickup slots arrive as
// "Pickup Today 14:30". Printed under our own "Deliver 送达" / "Pickup 自提"
// label that reads "Deliver 送达  Deliver 2026-08-03": the word twice, and 11
// wasted columns shoving the actual date off the paper. Drop the leading verb —
// the label already says it, in both languages.
function stripSlotVerb(s) {
  if (!s) return '';
  return String(s).replace(/^(?:deliver(?:y)?|pick[\s-]?up|配送|送达|自提|自取)\s+/i, '').trim() || String(s);
}

// The customer-facing day for a slip: verb stripped FIRST so a "Deliver
// 2026-08-03" label reaches humanizeSlot as the bare date it is and prints as
// "Aug 03" like every other date on the slip (and in 12 enlarged columns
// instead of 20). Falls back to the absolute scheduled_for timestamp.
function slotValue(label, scheduledFor) {
  return humanizeSlot(absolutizeSlot(stripSlotVerb(label), scheduledFor))
    || fmtSlotDate(scheduledFor);
}

// Print the delivery day as TWO lines: label at normal size, then the day
// ENLARGED on its own line. Feieyun's <B> is double-WIDTH, so an enlarged line
// only fits ~15 half-width columns of the 31-column head (WIDTH) — the old
// single `<B>Deliver 送达  Aug 03</B>` ran 60+ columns and the head simply
// dropped what didn't fit, which is the END of the line: the date itself. The
// day is the one thing on this slip that must survive, so it gets the line to
// itself; a value still too long enlarged (a full slot window, "Right away
// 立即配送") falls back to normal-size bold, which fits all 31 columns.
function pushShipBy(L, o) {
  const sb = shipByPrintParts(o);
  if (!sb) return false;
  L.push(`<BOLD>${sb.label}</BOLD>`);
  L.push(dispLen(sb.value) * 2 <= WIDTH ? `<B>${sb.value}</B>` : `<BOLD>${sb.value}</BOLD>`);
  return true;
}

// ─── Templates ──────────────────────────────────────────────────────────
// Each renderer takes { order, items, shopName } and returns content with
// Feieyun markup: <CB>…</CB> center+enlarge, <B>…</B> enlarge, <C>…</C>
// center, <BR> ignored — we use real "\n" for line feeds.
const TEMPLATES = {
  // Full customer receipt — items, options, money breakdown, address.
  // Split orders print one labelled block per package (PKG 1/2 …).
  receipt(o, items, shopName, shipments) {
    const L = [];
    L.push(`<CB>${shopName || 'Order'}</CB>`);
    L.push(`<CB>${o.order_no}</CB>`);               // order no enlarged
    L.push(rule());
    L.push(`Time  ${fmtTime(o.paid_at || o.placed_at)}`);
    pushShipBy(L, o);
    // "To"/"Tel" name whoever is receiving a hand-over. On a counter sale the
    // buyer is standing at the till holding the goods, so the name staff typed
    // to satisfy the required field prints as "To  Walk-in" — noise on a till
    // receipt. Everything else stays: shop, order no, time, items, money, total.
    if (!isCounter(o)) {
      if (o.recipient_name) L.push(`To    ${o.recipient_name}`);
      if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
    }
    L.push(rule());
    // Keep refunded lines on the receipt (so the customer can see what changed),
    // but stamp them 已退款 and tally the refund for the money section below.
    let refundTotal = 0;
    const pushReceiptItem = (it) => {
      L.push(...itemLines(it, { price: true }));
      const rq = refundedQty(it);
      if (rq > 0) {
        const q = Number(it.qty) || 0;
        const unit = q > 0 ? (Number(it.line_total) || 0) / q : (Number(it.unit_price) || 0);
        const back = +(unit * rq).toFixed(2);
        L.push(`<B>已退款 REFUNDED x${rq}  -${money(back)}</B>`);
        refundTotal += back;
      }
    };
    const groups = groupByShipment(items, shipments);
    if (groups) {
      groups.forEach((g, i) => {
        // Header in two lines: "PKG 1/2" enlarged (short, never wraps), then
        // the mode label at normal size so a long bilingual label
        // ("Air shipment · 空运") fits on one line instead of breaking
        // mid-word — enlarged text is double-width and overflows 31 cols.
        L.push(`<B>PKG ${i + 1}/${groups.length}</B>`);
        L.push(`<BOLD>${pkgLabel(g)}</BOLD>`);
        for (const it of g.items) pushReceiptItem(it);
        if (i < groups.length - 1) L.push(rule());
      });
    } else {
      for (const it of bySku(items)) pushReceiptItem(it);
    }
    L.push(rule());
    // Total item count — a final check for the packer/courier that every
    // product is in the parcel. Counts the un-refunded units actually shipped.
    const totalUnits = items.reduce((n, it) => n + shipQty(it), 0);
    L.push(`<B>${row('Items 件数', String(totalUnits))}</B>`);
    // The money column must READ as the arithmetic that lands on TOTAL:
    // additions first (subtotal, shipping, packing), then deductions (voucher,
    // points, wallet). That is exactly the checkout formula —
    //   total = subtotal + shipping + packing - voucher - points - balance_used
    // (routes/retail.js:9776 grossTotal, :9847 total) — and until now the slip
    // printed only four of its six terms. packing_fee and balance_used were
    // charged, folded into TOTAL, and named nowhere, so the column silently
    // failed to add up: on TC000180, ¥323.00 - ¥25.84 = ¥297.16 against a
    // printed TOTAL of ¥303.56, the ¥6.40 difference being an unnamed packing
    // fee. Wallet is the worse of the two — it is unbounded, so the receipt
    // reconciled EXCEPT on the orders where the number matters most.
    // Labels stay English-only: nothing in this block carries a CN partner, and
    // adding one here would make these the only bilingual lines in the column.
    // Each is zero-suppressed like Shipping — a ¥0 line is noise on 58mm paper.
    L.push(row('Subtotal', money(o.subtotal)));
    if (Number(o.shipping_fee) > 0) L.push(row('Shipping', money(o.shipping_fee)));
    if (Number(o.packing_fee) > 0) L.push(row('Packing', money(o.packing_fee)));
    if (Number(o.voucher_amount) > 0) L.push(row('Voucher', '-' + money(o.voucher_amount)));
    if (Number(o.points_amount) > 0) L.push(row('Points', '-' + money(o.points_amount)));
    if (Number(o.balance_used) > 0) L.push(row('Wallet', '-' + money(o.balance_used)));
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
    // Refund summary: original TOTAL stays (what was charged), then the refunded
    // amount and the net the customer keeps paying.
    if (refundTotal > 0) {
      const net = Math.max(0, (Number(o.total) || 0) - refundTotal);
      L.push(row('Refunded 已退款', '-' + money(refundTotal)));
      L.push(`<L>${row('Net 退款后', money(net))}</L>`);
    }
    if (o.payment_method) L.push(row('Paid by', String(o.payment_method)));
    if (o.address_full) { L.push(rule()); L.push(o.address_full); }
    if (o.needs_cutlery) { L.push(rule()); L.push('<B>+ Cutlery 餐具</B>'); }
    if (o.customer_note) { L.push(rule()); L.push('Note: ' + noteText(o.customer_note)); }
    L.push(rule('='));
    L.push('<C>Thank you!</C>');
    L.push('\n\n');
    return L.join('\n');
  },

  // Packing / picking slip for the store/warehouse — what to pull and pack.
  // No prices; quantities + SKU enlarged. One block per package when split.
  packing(o, items, shopName, shipments) {
    const L = [];
    L.push(`<CB>PACKING 配货单</CB>`);
    L.push(`<CB>${o.order_no}</CB>`);               // order no enlarged
    L.push(`<C>${fmtTime(o.paid_at || o.placed_at)}</C>`);
    L.push(rule());
    // Fresh batch: the kitchen makes this on promised_ship_date — the packer
    // must NOT pull it off the shelf and ship early. Flag it loudly, plus the
    // ship-by / delivery line so the right thing leaves at the right time.
    // fmtSlotDate, not fmtTime: promised_ship_date is a DATE ('YYYY-MM-DD') and
    // fmtTime parses it as UTC midnight then shifts +8, so it printed the make
    // day with a fabricated `08:00` on the end — a clock time this system does
    // not hold and a packer could read as a deadline. fmtSlotDate has a
    // date-only branch and is already what the arrival line below uses.
    if (o.promised_ship_date) L.push(`<B>MAKE FRESH 当天现做 ${fmtSlotDate(o.promised_ship_date)}</B>`);
    if (pushShipBy(L, o)) L.push(rule());
    const pushItem = (it) => {
      // Fully refunded → nothing to pull; drop it entirely so staff don't ship it.
      if (shipQty(it) <= 0) return;
      const q = shipQty(it);                          // pack the un-refunded remainder
      const comps = bundleLines(it);
      // Bundle: skip its meaningless own sku, list each component's sku instead.
      const sku = comps.length ? '' : skuText(it);
      for (const l of nameLines(itemName(it))) L.push(`<BOLD>${l}</BOLD>`);  // one line per language
      // A partly-refunded line used to carry `** ‹r› refunded 已退款 · pack ‹q› **`
      // so a reduced qty would not look like a pick error. It was 32 display
      // columns against the 16 an enlarged line holds, so it printed as
      // `** 1 refunded 已` / `退款 · pack 2 **` — TWO lines carrying TWO
      // different numbers, each reading as a complete instruction, and 退款
      // opening line two reads as "refund" (§1.21).
      //
      // Removed rather than shortened. The packer needs one number and it is
      // already on the next line: `q` is shipQty() — ordered MINUS refunded —
      // so `x${q}` below is the count to pack and nothing else on this slip
      // states a different one. A short `** pack ‹q› **` would have put the
      // same number on two adjacent enlarged lines; the refund history it
      // dropped is on the customer's receipt (`:520`), which is where it
      // belongs. Decided by Ash 2026-08-08.
      const big = `x${q}` + (sku ? `  SKU ${sku}` : '');
      L.push(`<B>${big}</B>`);                        // qty + SKU enlarged
      if (it.size) L.push('     ' + String(it.size));
      comps.forEach(l => L.push(l));                  // bundle component pack list
      // Chosen options (dressing, spice…) ENLARGED, each on its own line WITH
      // its question: two same-SKU salads differ only by this, so the packer
      // must not miss it — and must know which question each answer belongs to.
      for (const op of parseOptions(it.options_json)) L.push(`<B>>> ${optLine(op)}</B>`);
    };
    const groups = groupByShipment(items, shipments);
    if (groups) {
      groups.forEach((g, i) => {
        L.push(`<B>PKG ${i + 1}/${groups.length}</B>`);
        L.push(`<BOLD>${pkgLabel(g)}</BOLD>`);
        g.items.forEach(pushItem);
        if (i < groups.length - 1) L.push(rule());
      });
    } else {
      bySku(items).forEach(pushItem);
    }
    L.push(rule());
    if (o.needs_cutlery) L.push('<B>+ cutlery 餐具</B>');
    // <BOLD>, not <B>. The note is free customer text, so where it breaks is
    // not knowable from here — and enlarged it had only 16 display columns,
    // which is 8 Chinese characters. A delivery instruction clause is 10-16,
    // so it could not fit and the head broke it mid-clause. That is how
    // "楼下保安室不要放" printed as "楼下保安室" / "不要放": line one names the
    // place and reads as an instruction to leave the parcel there, which is
    // the opposite of what the customer wrote (§1.21).
    // Normal width doubles the room to 31 — 15 characters, enough to hold a
    // whole negated predicate, so the negation stays with the verb it governs.
    // Of nine real notes measured, 7 still wrap here (only 2 fit whole): the
    // wrapping count is NOT the safety count. What spills is the tail of the
    // sentence, not the instruction. Deliberately NOT a wrapping algorithm:
    // no break rule can make a wrapped Chinese clause safe — break late and
    // the negation strands, break early and the object strands, and a
    // keep-with-next rescue was built and measured worse (§1.21). Width is the
    // fix. <BOLD> keeps the emphasis and loses only the doubling.
    if (o.customer_note) L.push('<BOLD>Note: ' + noteText(o.customer_note) + '</BOLD>');
    if (o.recipient_name || o.recipient_phone) {
      L.push(rule());
      L.push(`${o.recipient_name || ''}  ${o.recipient_phone || ''}`.trim());
    }
    if (o.address_full) L.push(o.address_full);
    L.push('\n\n');
    return L.join('\n');
  },

  // Minimal — order no (enlarged), items + qty (enlarged when >1), total.
  compact(o, items, shopName) {
    const L = [];
    L.push(`<CB>${o.order_no}</CB>`);
    L.push(`<C>${fmtTime(o.paid_at || o.placed_at)}</C>`);
    L.push(rule());
    for (const it of bySku(items)) {
      const q = Number(it.qty) || 0;
      for (const l of nameLines(itemName(it))) L.push(`<BOLD>${l}</BOLD>`);  // one line per language
      if (q > 1) L.push(`<B>x${q}</B>`);              // qty enlarged only when >1
      bundleLines(it).forEach(l => L.push(l));        // bundle component pack list
    }
    L.push(rule());
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
    L.push('\n\n');
    return L.join('\n');
  },

  // Date-change slip — a customer moved the delivery/pickup day AFTER their
  // receipt had already printed. The receipt is a snapshot taken when the order
  // was paid and nothing ever refreshes it, so the paper in the pile still shows
  // the old day (docs/receipt-booked-date-findings.md §7).
  //
  // Deliberately NOT a reprint of the receipt: a second full receipt would sit
  // in the pile indistinguishable from the one it replaces, and staff would have
  // to read two near-identical slips to find the one difference. This prints the
  // difference and nothing else — no items, no money, no address. The enlarged
  // "Date changed 改期" head and the near-empty body make it unmistakable at
  // arm's length, which is the whole point of the format.
  //
  // The old day is NOT on the order row (the reschedule UPDATE overwrites it),
  // so the caller stashes it on the order object as prev_scheduled_for /
  // prev_slot_label before rendering — the same carry-it-on-the-order pattern
  // renderAddon uses for addon_paid_at.
  //
  // Wording is locked in docs/tacet-delivery-vocabulary.md, "Date changed after
  // printing": 改期 (minted), 顾客预约 (reused, Time labels), 原定时间 (reused,
  // Plan kickers). 改期 is fulfilment-neutral by that lock — pickup and delivery
  // print the same head, and no pickup variant may be added.
  datechange(o) {
    const L = [];
    // Head split across TWO enlarged lines rather than the usual glued pair.
    // <CB> is double-WIDTH, so a glued "Date changed 改期" measures 34 of the
    // 31-column head and the head drops what doesn't fit — the END of the line,
    // i.e. the 改期 that names the slip. Same reason the PKG header splits its
    // mode label onto its own line. Split: 24 and 8 columns, both fit, and two
    // enlarged lines make a louder head than one truncated one. The words are
    // the locked ones verbatim; only the line break is ours.
    L.push(`<CB>Date changed</CB>`);
    L.push(`<CB>改期</CB>`);
    L.push(`<CB>${o.order_no || ''}</CB>`);          // which order to re-file
    L.push(rule());
    // The NEW day, in the two-line treatment pushShipBy uses: label at normal
    // size, day ENLARGED on its own line. <B> is double-WIDTH, so an enlarged
    // line only fits ~15 half-width columns of the 31-column head and a long
    // value would lose its tail — which is the date itself. Falls back to
    // normal-size bold when the value is too wide to enlarge.
    const now = slotValue(o.delivery_slot_label, o.scheduled_for);
    if (now) {
      L.push('<BOLD>Booked 顾客预约</BOLD>');
      L.push(dispLen(now) * 2 <= WIDTH ? `<B>${now}</B>` : `<BOLD>${now}</BOLD>`);
    }
    // The superseded day, deliberately NOT enlarged — it must read as the thing
    // being replaced, not compete with the day above it for the eye.
    const was = slotValue(o.prev_slot_label, o.prev_scheduled_for);
    if (was) {
      L.push('<BOLD>Previously 原定时间</BOLD>');
      L.push(was);
    }
    L.push(rule());
    // Name + phone so the slip can be matched to the original receipt in the
    // pile. Same bare-EN labels the receipt uses — no CN partner exists for
    // these two on any slip, and the vocabulary mints none.
    if (o.recipient_name) L.push(`To    ${o.recipient_name}`);
    if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
    L.push('\n\n');
    return L.join('\n');
  },
};

// `opts` is accepted but unused: it used to carry the co-brand credit footer,
// which is now removed product-wide. The parameter stays so the three call
// sites in routes/retail.js keep working untouched — receipt printing is live
// at physical stores and signature churn risks silent print failure.
function renderOrder(template, order, items, shopName, shipments, opts) {
  // A counter sale has nothing to pack. The template comes from the STORE's
  // printer config (printer.template), so a store set to 'packing' would print a
  // picking list for goods that left as they were rung up — waste that also
  // reads as an instruction to go and find them. Force those to the receipt,
  // which is the thing a walk-in actually needs. 'compact' is already a receipt
  // and is left alone.
  const t = (isCounter(order) && template === 'packing') ? 'receipt' : template;
  const fn = TEMPLATES[t] || TEMPLATES.receipt;
  return fn(order, items || [], shopName, shipments || []);
}

// Add-on slip — items ADDED to an order that was already paid (and likely
// already printed and being prepped). Deliberately NOT a TEMPLATES entry: it's
// never an operator-selectable receipt style, always this fixed delta layout.
// Prints ONLY the new items, headed loudly so staff fold them into the existing
// parcel instead of starting a fresh order. `order` carries order_no,
// recipient_*, and addon_paid_at (the time the difference was paid).
function renderAddon(order, items, shopName) {
  const o = order || {};
  const list = Array.isArray(items) ? items : [];
  const L = [];
  L.push(`<CB>${shopName || 'Order'}</CB>`);
  L.push(`<CB>+ ADD-ON 加单</CB>`);            // enlarged, centered
  L.push(`<CB>${o.order_no || ''}</CB>`);      // which order to add to
  L.push(rule());
  // Loud instruction: this is NOT a new order — add these to the existing one.
  L.push('<B>ADD to this order 补入原订单</B>');
  L.push('<B>Order already placed 此单已下</B>');
  if (o.addon_paid_at) L.push(`Time  ${fmtTime(o.addon_paid_at)}`);
  if (o.recipient_name)  L.push(`To    ${o.recipient_name}`);
  if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
  L.push(rule());
  let total = 0;
  for (const it of bySku(list)) {
    L.push(...itemLines(it, { price: true }));
    total += Number(it.line_total) || 0;
  }
  L.push(rule());
  L.push(`<L>${row('ADD-ON 加单合计', money(total))}</L>`);
  L.push(rule('='));
  L.push('<C>Add to the existing parcel</C>');
  L.push('<C>请并入原包裹</C>');
  L.push('\n\n');
  return L.join('\n');
}

// Refund-REQUEST slip — printed the moment a customer files a refund so staff
// see it on paper without watching the dashboard. Deliberately NOT a TEMPLATES
// entry (never an operator-selectable receipt style): always this fixed alert
// layout. Headed loudly so it can't be mistaken for a packing slip. `order`
// carries order_no, recipient_*, refund_reason, refund_amount_requested, total,
// refund_requested_at; `lines` (optional) is the itemized partial as enriched
// rows [{ qty, amount, name_cn, name_en, sku }].
function renderRefundRequest(order, lines, shopName) {
  const o = order || {};
  const list = Array.isArray(lines) ? lines : [];
  const L = [];
  L.push(`<CB>${shopName || 'Order'}</CB>`);
  // Two lines, EN then CN, both enlarged and both whole. Glued this was 19
  // display columns against the 16 an enlarged line holds (§1.20), so the head
  // broke it itself — and it broke AFTER `REFUND`, leaving `退款申请 REFUND`
  // reading as a refund that already happened and stranding `REQ` on its own.
  // This slip announces a request awaiting approval, so that reading is the
  // wrong one. Dropping `REQ` to fit `退款申请 REFUND` on one line was the
  // other option and was rejected for the same reason: it makes the misreading
  // permanent instead of accidental. EN leads to match the PARTIAL/FULL block
  // below — the two enlarged blocks on one slip must not disagree about which
  // language comes first. Still <CB>: this is the slip's identity marker and
  // only where it breaks has changed, not how loud it is.
  L.push(`<CB>REFUND REQ</CB>`);                  // 10 of 16, enlarged, centered
  L.push(`<CB>退款申请</CB>`);                      // 8 of 16
  L.push(`<CB>${o.order_no || ''}</CB>`);          // which order
  L.push(rule());
  if (o.refund_requested_at) L.push(`Time  ${fmtTime(o.refund_requested_at)}`);
  if (o.recipient_name)  L.push(`From  ${o.recipient_name}`);
  if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
  L.push(rule());
  // Full vs partial: a non-empty line list (or a requested amount short of the
  // order total) is a partial; otherwise treat it as a whole-order refund.
  const reqAmt = Number(o.refund_amount_requested) || 0;
  const isPartial = list.length > 0 || (reqAmt > 0 && reqAmt < (Number(o.total) || 0));
  // One language per line, both enlarged. Glued, these are 23 and 20 display
  // columns against the 16 an enlarged line holds (§1.20) — so the head broke
  // them itself, and on FULL it broke INSIDE 全额退款, leaving "全额" hanging
  // off the first line. Split at the space that was already there: 14/8 and
  // 11/8, every half inside 16. Same shape as the 改期 head (`794dc601`).
  const kind = isPartial ? ['PARTIAL refund', '部分退款'] : ['FULL refund', '全额退款'];
  L.push(`<B>${kind[0]}</B>`);
  L.push(`<B>${kind[1]}</B>`);
  if (list.length) {
    L.push(rule());
    for (const it of list) {
      for (const l of nameLines(itemName(it))) L.push(`<BOLD>${l}</BOLD>`);
      const q = Number(it.qty) || 0;
      const sku = skuText(it);
      const big = (q > 0 ? `x${q}` : '') + (q > 0 && sku ? '  ' : '') + (sku ? `SKU ${sku}` : '');
      if (big) L.push(`<B>${big}</B>`);
      if (it.amount != null) L.push(row('  refund', money(it.amount)));
    }
  }
  L.push(rule());
  // Amount the customer asked for (full order total when no explicit amount).
  // Label at normal size, amount enlarged on its own line — pushShipBy's shape.
  // NOT `<B>${row(label, amount)}</B>`: row() pads to exactly WIDTH, and WIDTH
  // doubled is 62 on a head that wraps at 32, so that form always broke — the
  // amount landed on the next line, right-aligned only because row()'s pad
  // spaces survived the wrap. Shortening the label cannot save it either;
  // label + amount is 22 columns against the 16 an enlarged line holds (§1.20).
  // Split, both fit with room: label 15 of 31 normal, ￥20.00 7 of 16 enlarged.
  // The amount line holds up to ￥99999999999.99 (16 exactly) before it wraps,
  // so no refund this business can take will break it.
  L.push('<BOLD>退款金额 Refund</BOLD>');
  L.push(`<B>${money(reqAmt > 0 ? reqAmt : o.total)}</B>`);
  if (o.refund_reason) {
    L.push(rule());
    L.push('Reason 原因:');
    L.push(noteText(o.refund_reason));
  }
  L.push(rule('='));
  L.push('<C>Review in admin · 后台处理</C>');
  L.push('\n\n');
  return L.join('\n');
}

// ── Refund RECEIPT — money already returned ────────────────────────────────
// Distinct from renderRefundRequest above, and the distinction is the whole
// reason this exists. That slip announces a request AWAITING approval, and its
// head is built at length to stop it ever reading as a refund that already
// happened. This one is the opposite fact: the money is back.
//
// It exists for the counter. A walk-in refunded at the till has the customer
// standing there with nothing to take away — the request slip is staff-facing
// ("Review in admin"), and no operator refund path printed anything at all, so
// the one person who needed paper never got any. It prints for every
// fulfilment type; a delivery customer is not present, but their copy is
// attached to the parcel record either way and costs one slip.
//
// §1.20 THROUGHOUT: an enlarged line holds 16 display columns, not 31, and a
// Chinese character is two of them. Every <B>/<CB> below is counted in the
// comment beside it, and the two languages sit on their own lines rather than
// glued — the same rule the request slip's head was rebuilt to satisfy.
// Normal-width lines are 31 and may glue, which is what the order receipt
// already does (`Refunded 已退款`).
function renderRefundReceipt(order, lines, shopName) {
  const o = order || {};
  const list = Array.isArray(lines) ? lines : [];
  const L = [];
  L.push(`<CB>${shopName || 'Order'}</CB>`);
  L.push(`<CB>REFUNDED</CB>`);                     // 8 of 16
  L.push(`<CB>已退款</CB>`);                        // 6 of 16
  L.push(`<CB>${o.order_no || ''}</CB>`);
  L.push(rule());
  // The moment the money went back, not the moment the order was placed.
  L.push(`Time  ${fmtTime(o.refund_paid_at || o.updated_at || o.paid_at)}`);
  // Same suppression the order receipt applies: on a counter sale the buyer is
  // at the till and the name staff typed to satisfy a required field prints as
  // "To  Guest", which is noise on a slip handed straight to them.
  if (!isCounter(o)) {
    if (o.recipient_name)  L.push(`To    ${o.recipient_name}`);
    if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
  }
  L.push(rule());
  // Partial refunds name what came back. A full refund needs no list — the
  // order number above already identifies everything.
  if (list.length) {
    for (const it of list) {
      for (const l of nameLines(itemName(it))) L.push(`<BOLD>${l}</BOLD>`);
      const q = Number(it.qty) || 0;
      const sku = skuText(it);
      const big = (q > 0 ? `x${q}` : '') + (q > 0 && sku ? '  ' : '') + (sku ? `SKU ${sku}` : '');
      if (big) L.push(`<B>${big}</B>`);
      if (it.amount != null) L.push(row('  refund', money(it.amount)));
    }
    L.push(rule());
  }
  // Label normal, amount enlarged on its own line — pushShipBy's shape, and the
  // same split the request slip uses. NOT `<B>${row(...)}</B>`: row() pads to
  // WIDTH, and WIDTH doubled wraps on every head.
  L.push('<BOLD>退款金额 Refund</BOLD>');
  const paid = Number(o.refund_amount_paid) > 0 ? Number(o.refund_amount_paid) : Number(o.total) || 0;
  L.push(`<B>${money(paid)}</B>`);                 // ￥99999999999.99 = 16 exactly
  // WHERE the money went. On a till refund this is the line the customer checks
  // — it has to match the wallet they paid with, and it is the only place the
  // slip says so.
  //
  // ENGLISH-ONLY LABELS, and the raw method value, both deliberate: this mirrors
  // the receipt's own `row('Paid by', String(o.payment_method))` (:599), which is
  // the line this one is the counterpart to. The bilingual rows on these slips
  // (退款金额 Refund, 已退款 REFUNDED) are locked pairs that already ship; Time /
  // To / Tel / Paid by are English-only. A 退回 or 单号 label here would be a
  // Chinese string composed for this slip rather than taken from one of those,
  // so it is not written. (退回 exists in lib/tracking.js only as 退回中 / 已退回,
  // meaning a PARCEL returning to sender — a different thing entirely.)
  if (o.refund_payout_method) L.push(row('Refund to', String(o.refund_payout_method)));
  if (o.refund_payout_ref)    L.push(row('Ref', String(o.refund_payout_ref)));
  L.push(rule('='));
  // Locked pair, verbatim from public/retail-admin/03-dashboard.js:1061.
  L.push('<C>Refund settled · 退款完成</C>');
  L.push('\n\n');
  return L.join('\n');
}

module.exports = {
  feieEnabled,
  call,
  printContent,
  renderOrder,
  renderAddon,
  renderRefundRequest,
  renderRefundReceipt,
  TEMPLATE_IDS: Object.keys(TEMPLATES),
};
