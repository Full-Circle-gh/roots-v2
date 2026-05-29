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
// Credentials live in process.env (hydrated from storefront_config at boot
// by database.js, mirrored on save by the Integrations PUT endpoint):
//   FEIE_USER  — Feieyun account login (the phone/email you sign in with)
//   FEIE_UKEY  — USERKEY from the open.feieyun.com developer console.
//                NOT the 密钥/KEY printed on the device label — that one
//                only binds the printer to your account in the app.
//   FEIE_SN    — the printer's SN (编号), printed on the device label.
//
// API reference: http://www.feieyun.com/open/index.html
//   apiname = Open_printMsg   → print immediately
//   sig     = sha1(USER + UKEY + stime)   (stime = unix seconds)

const crypto = require('crypto');

const API_URL = 'https://api.feieyun.cn/Api/Open/';

function feieEnabled() {
  return !!(process.env.FEIE_USER && process.env.FEIE_UKEY && process.env.FEIE_SN);
}

function sign(user, ukey, stime) {
  return crypto.createHash('sha1').update(user + ukey + stime).digest('hex');
}

// Low-level call. Returns { ok, msg, data }. Never throws on a Feieyun
// error response — callers (auto-print) treat printing as best-effort.
async function call(apiname, extra = {}) {
  const user = process.env.FEIE_USER;
  const ukey = process.env.FEIE_UKEY;
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
async function printContent(content, { sn, copies } = {}) {
  const printerSn = sn || process.env.FEIE_SN;
  if (!printerSn) return { ok: false, msg: 'no_sn' };
  const extra = { sn: printerSn, content: String(content || '') };
  const n = parseInt(copies, 10);
  if (n > 1) extra.times = String(n);
  return call('Open_printMsg', extra);
}

// ─── 58mm layout helpers ────────────────────────────────────────────────
// 58mm thermal = 32 half-width columns. CJK glyphs occupy 2 columns.
const WIDTH = 32;

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
  return '¥' + Number(n || 0).toFixed(2);
}

// Format a paid_at / placed_at SQLite UTC string as local-ish HH:MM display.
// SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC; we keep it simple and show it
// as-is with a trailing marker so the operator always sees a stable stamp.
function fmtTime(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}

function parseOptions(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v)) {
      return v.map(o => (typeof o === 'string' ? o : (o && (o.label || o.label_cn || o.label_en)) || '')).filter(Boolean);
    }
    if (v && typeof v === 'object') {
      return Object.values(v).map(x => String(x)).filter(Boolean);
    }
  } catch { /* ignore */ }
  return [];
}

function itemName(it) {
  const cn = it.name_cn && String(it.name_cn).trim();
  const en = it.name_en && String(it.name_en).trim();
  if (cn && en && cn !== en) return cn + ' / ' + en;
  return cn || en || it.sku || '#' + (it.product_id || '');
}

// ─── Templates ──────────────────────────────────────────────────────────
// Each renderer takes { order, items, shopName } and returns content with
// Feieyun markup: <CB>…</CB> center+enlarge, <B>…</B> enlarge, <C>…</C>
// center, <BR> ignored — we use real "\n" for line feeds.
const TEMPLATES = {
  // Full customer receipt — items, options, money breakdown, address.
  receipt(o, items, shopName) {
    const L = [];
    L.push(`<CB>${shopName || 'Order'}</CB>`);
    L.push(`<C>${o.order_no}</C>`);
    L.push(rule());
    L.push(`Time  ${fmtTime(o.paid_at || o.placed_at)}`);
    if (o.recipient_name) L.push(`To    ${o.recipient_name}`);
    if (o.recipient_phone) L.push(`Tel   ${o.recipient_phone}`);
    L.push(rule());
    for (const it of items) {
      const qty = String(it.qty);
      L.push(`<BOLD>${itemName(it)}</BOLD>`);
      const opts = parseOptions(it.options_json);
      if (it.size) opts.unshift(String(it.size));
      if (opts.length) L.push('  ' + opts.join(', '));
      L.push(row(`  ${qty} x ${money(it.unit_price)}`, money(it.line_total)));
    }
    L.push(rule());
    L.push(row('Subtotal', money(o.subtotal)));
    if (Number(o.shipping_fee) > 0) L.push(row('Shipping', money(o.shipping_fee)));
    if (Number(o.voucher_amount) > 0) L.push(row('Voucher', '-' + money(o.voucher_amount)));
    if (Number(o.points_amount) > 0) L.push(row('Points', '-' + money(o.points_amount)));
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
    if (o.payment_method) L.push(row('Paid by', String(o.payment_method)));
    if (o.address_full) { L.push(rule()); L.push(o.address_full); }
    if (o.customer_note) { L.push(rule()); L.push('Note: ' + o.customer_note); }
    L.push(rule('='));
    L.push('<C>Thank you!</C>');
    L.push('\n\n');
    return L.join('\n');
  },

  // Packing / picking slip for the store/warehouse — what to pull and pack.
  // No prices; quantities and options enlarged for fast reading.
  packing(o, items, shopName) {
    const L = [];
    L.push(`<CB>PACKING 配货单</CB>`);
    L.push(`<C>${o.order_no}</C>`);
    L.push(`<C>${fmtTime(o.paid_at || o.placed_at)}</C>`);
    L.push(rule());
    for (const it of items) {
      const qty = String(it.qty);
      L.push(`<B>x${qty}  ${itemName(it)}</B>`);
      const opts = parseOptions(it.options_json);
      if (it.size) opts.unshift(String(it.size));
      if (opts.length) L.push('     ' + opts.join(', '));
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

  // Minimal — order no, items + qty, total only.
  compact(o, items, shopName) {
    const L = [];
    L.push(`<C>${o.order_no}</C>`);
    L.push(`<C>${fmtTime(o.paid_at || o.placed_at)}</C>`);
    L.push(rule());
    for (const it of items) L.push(`${it.qty} x ${itemName(it)}`);
    L.push(rule());
    L.push(`<L>${row('TOTAL', money(o.total))}</L>`);
    L.push('\n\n');
    return L.join('\n');
  },
};

function renderOrder(template, order, items, shopName) {
  const fn = TEMPLATES[template] || TEMPLATES.receipt;
  return fn(order, items || [], shopName);
}

module.exports = {
  feieEnabled,
  call,
  printContent,
  renderOrder,
  TEMPLATE_IDS: Object.keys(TEMPLATES),
};
