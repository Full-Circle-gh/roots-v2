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

// Print a pre-rendered content string on a given printer.
//   content — Feieyun-flavoured markup (see renderers below)
//   sn      — printer SN (defaults to env FEIE_SN)
//   copies  — number of copies (Feieyun `times`), default 1
async function printContent(content, { sn, copies } = {}, c) {
  if (!sn) return { ok: false, msg: 'no_sn' };
  const extra = { sn: String(sn), content: String(content || '') };
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
    out.push(`  x${q}  ${itemName(c)}`);
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
  const name = itemName(it);
  // Name stays normal size (bold only) — keeps long/CJK names crisp on 58mm.
  // Only the quantity (when >1) and SKU are enlarged, together on one line.
  out.push(`<BOLD>${name}</BOLD>`);                 // name: normal size, bold
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
// API-only ship_by_mode/dispatch_deadline. Returns "Label  value" or '' (blank
// when there's no customer-facing date).
// Labels are bilingual ("English 中文") to match the slip's other labels
// (Cutlery 餐具, 配货单, 空运) — the receipt is customer-facing.
//   pickup    → "Pickup 自提  <window>"
//   batch     → "Arrives 预计送达  ~<delivery_date>"  (fresh-batch arrival estimate)
//   scheduled → "Deliver 送达  <slot/date>"           (calendar/same-day pick — courier INCLUDED)
//   express   → ''                                    (only an operator-internal 48h deadline)
// FOOTGUN history: this used to short-circuit `if (isCourier) return ''`, which
// dropped the delivery date from every air/land receipt EVEN when the customer
// scheduled a real date — so out-of-city scheduled orders printed no date at
// all. A courier shipment is NOT the same as an express ("ASAP") order; the
// customer's chosen date prints regardless of shipping mode. Only express /
// right-away / restock / unscheduled orders have nothing customer-facing.
function shipByPrintLine(o) {
  // 1 — Pickup: the counter window.
  if (o.fulfillment_type === 'pickup') {
    const w = humanizeSlot(absolutizeSlot(o.delivery_slot_label, o.scheduled_for)) || fmtSlotDate(o.scheduled_for);
    return w ? `Pickup 自提  ${w}` : '';
  }
  // 2 — Fresh batch: the customer-facing arrival estimate. The make-fresh SHIP
  // date is operator-only (it's on the packing slip), so the receipt shows the
  // arrival, not the ship date.
  if (o.promised_ship_date) {
    const arr = fmtSlotDate(o.promised_delivery_date) || fmtSlotDate(o.promised_ship_date);
    return arr ? `Arrives 预计送达  ~${arr}` : '';
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
    const slot = humanizeSlot(absolutizeSlot(o.delivery_slot_label, o.scheduled_for)) || fmtSlotDate(o.scheduled_for);
    if (slot) return `Deliver 送达  ${slot}`;
  }
  // 4 — Express / right-away / nothing scheduled → no customer-facing date.
  return '';
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
    const sbLine = shipByPrintLine(o);
    if (sbLine) L.push(`<B>${sbLine}</B>`);
    if (o.recipient_name) L.push(`To    ${o.recipient_name}`);
    if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
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
    L.push(row('Subtotal', money(o.subtotal)));
    if (Number(o.shipping_fee) > 0) L.push(row('Shipping', money(o.shipping_fee)));
    if (Number(o.voucher_amount) > 0) L.push(row('Voucher', '-' + money(o.voucher_amount)));
    if (Number(o.points_amount) > 0) L.push(row('Points', '-' + money(o.points_amount)));
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
    if (o.customer_note) { L.push(rule()); L.push('Note: ' + o.customer_note); }
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
    if (o.promised_ship_date) L.push(`<B>MAKE FRESH 当天现做 ${fmtTime(o.promised_ship_date)}</B>`);
    const sbLine = shipByPrintLine(o);
    if (sbLine) { L.push(`<B>${sbLine}</B>`); L.push(rule()); }
    const pushItem = (it) => {
      // Fully refunded → nothing to pull; drop it entirely so staff don't ship it.
      if (shipQty(it) <= 0) return;
      const q = shipQty(it);                          // pack the un-refunded remainder
      const comps = bundleLines(it);
      // Bundle: skip its meaningless own sku, list each component's sku instead.
      const sku = comps.length ? '' : skuText(it);
      L.push(`<BOLD>${itemName(it)}</BOLD>`);        // name: normal size, bold
      // Partial refund: tell the packer the original count so a reduced qty
      // doesn't look like a pick error.
      if (refundedQty(it) > 0) L.push(`<B>** ${refundedQty(it)} refunded 已退款 · pack ${q} **</B>`);
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
    if (o.customer_note) L.push('<B>Note: ' + o.customer_note + '</B>');
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
      L.push(`<BOLD>${itemName(it)}</BOLD>`);         // name: normal size
      if (q > 1) L.push(`<B>x${q}</B>`);              // qty enlarged only when >1
      bundleLines(it).forEach(l => L.push(l));        // bundle component pack list
    }
    L.push(rule());
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
    L.push('\n\n');
    return L.join('\n');
  },
};

function renderOrder(template, order, items, shopName, shipments) {
  const fn = TEMPLATES[template] || TEMPLATES.receipt;
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
  L.push(`<CB>退款申请 REFUND REQ</CB>`);          // enlarged, centered
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
  L.push(isPartial ? '<B>PARTIAL refund 部分退款</B>' : '<B>FULL refund 全额退款</B>');
  if (list.length) {
    L.push(rule());
    for (const it of list) {
      L.push(`<BOLD>${itemName(it)}</BOLD>`);
      const q = Number(it.qty) || 0;
      const sku = skuText(it);
      const big = (q > 0 ? `x${q}` : '') + (q > 0 && sku ? '  ' : '') + (sku ? `SKU ${sku}` : '');
      if (big) L.push(`<B>${big}</B>`);
      if (it.amount != null) L.push(row('  refund', money(it.amount)));
    }
  }
  L.push(rule());
  // Amount the customer asked for (full order total when no explicit amount).
  L.push(`<B>${row('退款金额 Refund', money(reqAmt > 0 ? reqAmt : o.total))}</B>`);
  if (o.refund_reason) {
    L.push(rule());
    L.push('Reason 原因:');
    L.push(String(o.refund_reason));
  }
  L.push(rule('='));
  L.push('<C>Review in admin · 后台处理</C>');
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
  TEMPLATE_IDS: Object.keys(TEMPLATES),
};
