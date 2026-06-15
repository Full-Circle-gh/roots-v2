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

// Format a paid_at / placed_at SQLite UTC string as local-ish HH:MM display.
// SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC; we keep it simple and show it
// as-is with a trailing marker so the operator always sees a stable stamp.
function fmtTime(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
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
  return groups.length > 1 ? groups : null;
}

function pkgLabel(g) {
  if (g.label) return String(g.label);
  return ({ local: 'Local · 同城', air: 'Air · 空运', land: 'Land · 陆运' })[g.mode] || (g.mode || '');
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
    const deliverStr = o.delivery_slot_label
      || fmtTime(o.scheduled_for)
      || fmtTime(o.promised_delivery_date);
    if (deliverStr) L.push(`Deliver  ${deliverStr}`);
    if (o.recipient_name) L.push(`To    ${o.recipient_name}`);
    if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
    L.push(rule());
    const groups = groupByShipment(items, shipments);
    if (groups) {
      groups.forEach((g, i) => {
        // Header in two lines: "PKG 1/2" enlarged (short, never wraps), then
        // the mode label at normal size so a long bilingual label
        // ("Air shipment · 空运") fits on one line instead of breaking
        // mid-word — enlarged text is double-width and overflows 31 cols.
        L.push(`<B>PKG ${i + 1}/${groups.length}</B>`);
        L.push(`<BOLD>${pkgLabel(g)}</BOLD>`);
        for (const it of g.items) L.push(...itemLines(it, { price: true }));
        if (i < groups.length - 1) L.push(rule());
      });
    } else {
      for (const it of items) L.push(...itemLines(it, { price: true }));
    }
    L.push(rule());
    L.push(row('Subtotal', money(o.subtotal)));
    if (Number(o.shipping_fee) > 0) L.push(row('Shipping', money(o.shipping_fee)));
    if (Number(o.voucher_amount) > 0) L.push(row('Voucher', '-' + money(o.voucher_amount)));
    if (Number(o.points_amount) > 0) L.push(row('Points', '-' + money(o.points_amount)));
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
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
    const pushItem = (it) => {
      const q = Number(it.qty) || 0;
      const comps = bundleLines(it);
      // Bundle: skip its meaningless own sku, list each component's sku instead.
      const sku = comps.length ? '' : skuText(it);
      L.push(`<BOLD>${itemName(it)}</BOLD>`);        // name: normal size, bold
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
      items.forEach(pushItem);
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
    for (const it of items) {
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

module.exports = {
  feieEnabled,
  call,
  printContent,
  renderOrder,
  TEMPLATE_IDS: Object.keys(TEMPLATES),
};
