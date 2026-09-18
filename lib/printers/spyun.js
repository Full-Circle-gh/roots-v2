// Shangpeng (商鹏) cloud-printer adapter — spyun.net Open API v1.
//
// The second printer vendor this product speaks (decisions §171). Bought for
// the Yuexiu shop as an SP-T6-H; the adapter is not specific to that model.
//
// SAME SHAPE AS FEIE, DIFFERENT WIRE. Like Feieyun, the device is a 4G/WiFi
// 云打印机 bound to a vendor account and listening to the vendor's cloud. Our
// server never talks to the device: it POSTs the slip text to Shangpeng's API
// and the cloud pushes it to the printer. No LAN, no agent, no port forward.
//
// CREDENTIALS ARE ACCOUNT-LEVEL, NOT PER-DEVICE. This is worth stating plainly
// because the device label invites the opposite conclusion — it prints both an
// 编号(SN) and a 密钥(KEY), which reads like a credential pair:
//   SPYUN_APPID     — 开发者ID from the spyun.net developer console
//   SPYUN_APPSECRET — 开发者密钥 from the same console
// The label's KEY is the BINDING key (`pkey`): it adds the device to your
// account once, in the console or the app, and is never sent by this server.
// One account holds every printer; the SN says which one to print at. Exactly
// the trap lib/feie.js documents for Feieyun's USERKEY, one vendor over.
//
// API reference: https://developer.spyun.net/  (client-rendered; the endpoint
// and signature below were read off the published @xesam/cloud-vendor-spyun
// client and cross-checked against the base URL compiled into Shangpeng's own
// developer-console bundle).
//   POST v1/printer/print   → queue a slip (cached 48h if the device is offline)
//   GET  v1/printer/info    → device status (read-only; used to verify creds)
//   sign = MD5(<params sorted by key, joined k=v with &> + '&appsecret=' + secret)
//          — UPPERCASE hex. See the note on the signature below; the case is
//          not cosmetic and a lowercase digest is rejected outright.
//   success = errorcode === 0

'use strict';

const crypto = require('crypto');

const API_BASE = 'https://open.spyun.net/v1/printer/';

// Shangpeng does not publish a content ceiling the way Feieyun does (~5000
// bytes, enforced by rejecting the whole job). Hold the same figure rather
// than assume a larger one: a truncated slip beats a silently unprintable
// order, and no slip this product renders comes close to it in practice.
const MAX_CONTENT_BYTES = 5000;

// 58mm enlarged-line width. lib/feie.js measured 16 source columns off an
// FP-V58-D head; that is a MEASUREMENT OF A DEVICE, not of the protocol, and
// is not promised to hold on Shangpeng hardware. It lives here so a different
// answer for this vendor is a one-line change. Verify on a test print before
// trusting it (decisions §171).
const BIG_WIDTH = 16;

// ─── Markup translation ─────────────────────────────────────────────────
// Slips are rendered ONCE, in house markup, which is Feie's tag vocabulary
// (decisions §171). Every adapter translates on the way out. This table is
// that translation for Shangpeng.
//
// UNVERIFIED, AND DELIBERATELY SHAPED SO THAT BEING WRONG IS CHEAP. Both of
// Shangpeng's documentation sites are client-rendered single-page apps and
// would not open through this session's egress proxy, so the tag NAMES below
// could not be read from a primary source. They default to pass-through on
// the reading that the Chinese cloud-printer vendors share this convention —
// the tags, the 58mm column model and the <BR> line break are common across
// Feie, Xinye and Shangpeng client libraries.
//
// IF A TEST PRINT COMES BACK WITH LITERAL <CB> ON THE PAPER, THE FIX IS HERE
// AND ONLY HERE. Map the house tag to whatever the vendor does accept, or to
// '' to drop the styling and print the line plain. No renderer moves.
const TAG_MAP = {
  CB:   'CB',     // centre + enlarge  — order number, the biggest thing on the slip
  B:    'B',      // enlarge
  L:    'L',      // double height
  BOLD: 'BOLD',   // bold
  C:    'C',      // centre
};

// Rewrite house markup into this vendor's. A tag mapped to '' is dropped and
// its content printed plain — styling is the only thing that can be lost here,
// never the words.
function translate(content) {
  return String(content == null ? '' : content).replace(
    /<(\/?)(CB|BOLD|B|L|C)>/g,
    (whole, slash, tag) => {
      const to = TAG_MAP[tag];
      if (to === undefined) return whole;   // unknown house tag — leave alone
      return to ? `<${slash}${to}>` : '';
    }
  );
}

// ─── Transport ──────────────────────────────────────────────────────────

function enabled(c) {
  return !!(c && c.appid && c.appsecret);
}

// MD5 over every request parameter sorted by key, joined k=v with '&', with
// '&appsecret=<secret>' appended. `sign` itself is never part of the input.
//
// THE DIGEST IS UPPERCASE, AND THIS WAS ESTABLISHED AGAINST THE LIVE API, not
// assumed. The published @xesam/cloud-vendor-spyun client this transport was
// otherwise read from leaves the case to its injected signer, and a lowercase
// digest is rejected with `{"errorcode":-4,"errormsg":"签名错误"}` — a flat
// auth rejection that says nothing about case and would have read as bad
// credentials. Twelve candidate algorithms were put to GET v1/printer/info on
// 2026-09-18: eleven returned 签名错误 and exactly one — this one, uppercased —
// got through to a business-level answer. Do not "tidy" the toUpperCase away.
function sign(params, appsecret) {
  const base = Object.keys(params).sort()
    .map(k => k + '=' + params[k])
    .join('&');
  return crypto.createHash('md5')
    .update(base + '&appsecret=' + appsecret)
    .digest('hex')
    .toUpperCase();
}

// Byte-safe truncation — never splits a UTF-8 multi-byte sequence, which a
// plain String.slice() would risk doing mid-character. Same contract as the
// helper in lib/feie.js; duplicated rather than imported so the transport
// layers stay independent of each other.
function truncateBytes(s, maxBytes, marker = '') {
  s = String(s == null ? '' : s);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const cut = Buffer.from(s, 'utf8').slice(0, budget).toString('utf8').replace(/�+$/, '');
  return cut + marker;
}

// Low-level call. Returns { ok, msg, data }. Never throws on a vendor error
// response — callers treat printing as best-effort.
async function call(path, extra = {}, c, method = 'POST') {
  if (!enabled(c)) return { ok: false, msg: 'not_configured' };
  const params = {
    ...extra,
    appid: String(c.appid),
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  params.sign = sign(params, c.appsecret);
  const form = new URLSearchParams(params);
  let r, body;
  try {
    r = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
    });
    body = await r.json();
  } catch (e) {
    return { ok: false, msg: 'network_error: ' + e.message };
  }
  // Shangpeng: errorcode === 0 means success (Feieyun uses ret === 0).
  if (body && body.errorcode === 0) return { ok: true, msg: body.errormsg, data: body };
  const ec = body && body.errorcode;
  return {
    ok: false,
    msg: (body && (body.errormsg || body.errorcode)) || 'unknown_error',
    code: CODES[ec],       // undefined for anything not observed first-hand
    raw: body,
  };
}

// Vendor error codes normalised to names the UI can act on. ONLY the two that
// were seen first-hand against the live API on 2026-09-18 are listed; the rest
// of Shangpeng's catalogue is undocumented here and guessing at it would put
// confident wrong advice in front of an operator, which is worse than the raw
// Chinese message they already get.
//
//   2  打印机不存在  the SN is not registered on THIS account. In practice the
//                   likeliest cause is the wrong BRAND on the store row — an
//                   SN belonging to the other vendor's cloud looks exactly
//                   like a printer that does not exist. §171 addendum 2.
//  -4  签名错误      our signature was refused. Should be unreachable now the
//                   digest is uppercase; if it comes back, that regressed.
const CODES = {
  2: 'unknown_printer',
  '-4': 'bad_signature',
};

// Print a pre-rendered slip. `content` arrives in HOUSE markup and is
// translated here — callers never know which vendor they are talking to.
async function printContent(content, { sn, copies } = {}, c) {
  if (!sn) return { ok: false, msg: 'no_sn' };
  const body = truncateBytes(
    translate(content), MAX_CONTENT_BYTES, '\n…(内容过长已截断 truncated)\n'
  );
  const extra = { sn: String(sn), content: body };
  const n = parseInt(copies, 10);
  if (n > 1) extra.times = String(n);
  return call('print', extra, c);
}

module.exports = {
  id: 'spyun',
  label_en: 'Shangpeng',
  label_cn: '商鹏',
  // What the Integrations panel asks this tenant for. `secret: true` renders a
  // password field and rides the secret-box like every other stored secret.
  credFields: [
    { key: 'appid',     env: 'SPYUN_APPID',     label_en: 'Developer ID (APPID)',     label_cn: '开发者ID', secret: false },
    { key: 'appsecret', env: 'SPYUN_APPSECRET', label_en: 'Developer key (APPSECRET)', label_cn: '开发者密钥', secret: true },
  ],
  enabled,
  printContent,
  MAX_CONTENT_BYTES,
  BIG_WIDTH,
  // Exported for the test suite — the translation table is the one piece of
  // this adapter that is expected to need correcting from paper.
  TAG_MAP,
  translate,
  sign,
};
