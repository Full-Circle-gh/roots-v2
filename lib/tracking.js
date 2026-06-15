// Tracking helpers — carrier registry + status-code i18n + tracking-page URLs.
//
// Step 1 (where we are now): admin manually pastes a tracking number on a
// dispatched order; customer mini-app shows the carrier + number with a
// link to the carrier's public tracking page.
//
// Step 2 (next): wire 快递100 to pull live events into tracking_events_json
// and normalize each event into a tracking_status code below. The map here
// gives EN+CN labels for every code so non-Chinese customers don't see
// raw Chinese free-text.

// Carriers we support today. JD = our primary, SF = rare same-day overflow,
// the rest are the common ones an aggregator returns and we want labelled
// nicely if they ever come up.
const CARRIERS = [
  { code: 'jd',    name_en: 'JD Logistics',     name_cn: '京东物流',
    url: (n) => `https://www.jdl.com/orderSearch?waybillCodes=${encodeURIComponent(n)}` },
  { code: 'sf',    name_en: 'SF Express',       name_cn: '顺丰速运',
    url: (n) => `https://www.sf-express.com/chn/sc/dynamic_function/waybill/#search/bill-number/${encodeURIComponent(n)}` },
  { code: 'yto',   name_en: 'YTO Express',      name_cn: '圆通速递',
    url: (n) => `https://www.yto.net.cn/ytoOrderTrack/index.html?orderNo=${encodeURIComponent(n)}` },
  { code: 'sto',   name_en: 'STO Express',      name_cn: '申通快递',
    url: (n) => `https://www.sto.cn/Pages/wuliuChaxun.aspx?wuliuid=${encodeURIComponent(n)}` },
  { code: 'zto',   name_en: 'ZTO Express',      name_cn: '中通快递',
    url: (n) => `https://www.zto.com/express/expressCheck.html?txtbill=${encodeURIComponent(n)}` },
  { code: 'yunda', name_en: 'Yunda Express',    name_cn: '韵达快递',
    url: (n) => `https://www.yundaex.com/cn/index.php?act=search&no=${encodeURIComponent(n)}` },
  { code: 'ems',   name_en: 'EMS',              name_cn: '中国邮政 EMS',
    url: (n) => `https://www.ems.com.cn/mailtracking/e_you_search.html?mailNum=${encodeURIComponent(n)}` },
  { code: 'other', name_en: 'Other carrier',    name_cn: '其他承运商',
    url: () => null },
];

const CARRIER_BY_CODE = Object.fromEntries(CARRIERS.map(c => [c.code, c]));

// Normalized status codes. Whatever 快递100 / JD / SF return upstream gets
// mapped down to one of these so the customer-facing timeline UI only
// has eight states to render. Order here = timeline order.
const STATUS_CODES = [
  { code: 'placed',           label_en: 'Label created',     label_cn: '已下单' },
  { code: 'picked_up',        label_en: 'Picked up',         label_cn: '已揽收' },
  { code: 'in_transit',       label_en: 'In transit',        label_cn: '运输中' },
  { code: 'arrived_local',    label_en: 'At local hub',      label_cn: '到达派送区' },
  { code: 'out_for_delivery', label_en: 'Out for delivery',  label_cn: '派送中' },
  { code: 'delivered',        label_en: 'Delivered',         label_cn: '已签收' },
  { code: 'exception',        label_en: 'Delivery issue',    label_cn: '配送异常' },
  { code: 'returning',        label_en: 'Returning to sender', label_cn: '退回中' },
  { code: 'returned',         label_en: 'Returned',          label_cn: '已退回' },
];

const STATUS_BY_CODE = Object.fromEntries(STATUS_CODES.map(s => [s.code, s]));

// 快递100's numeric `state` field — we'll consume this verbatim once the
// aggregator is wired in step 2. Listed here so the mapping lives next to
// the labels it maps onto. Codes from
// https://api.kuaidi100.com/document/poll/state.html (truncated to the
// ones that actually occur on a delivery flow).
const KD100_STATE_TO_CODE = {
  0:  'in_transit',
  1:  'picked_up',
  2:  'exception',
  3:  'delivered',
  4:  'returned',
  5:  'out_for_delivery',
  6:  'returning',
  7:  'in_transit',          // 转单
  10: 'in_transit',          // 待清关
  11: 'in_transit',          // 清关中
  12: 'in_transit',          // 已清关
  13: 'exception',           // 清关异常
  14: 'exception',           // 拒签
};

function carrierByCode(code)        { return CARRIER_BY_CODE[code] || null; }
function trackingUrl(carrierCode, n) {
  const c = CARRIER_BY_CODE[carrierCode];
  if (!c || !n) return null;
  try { return c.url(n) || null; } catch { return null; }
}
function statusByCode(code)         { return STATUS_BY_CODE[code] || null; }
function kd100StateToCode(numericState) {
  return KD100_STATE_TO_CODE[numericState] || 'in_transit';
}

// Convenience: derive a normalized status code from the order's own
// workflow state, used as a fallback before any real tracking events
// have synced. Once 快递100 is wired this gets overwritten by the live
// feed; today it ensures the customer sees *something* immediately
// after staff attaches a waybill.
function deriveStatusFromOrder(orderStatus) {
  if (orderStatus === 'delivered')   return 'delivered';
  if (orderStatus === 'dispatched')  return 'in_transit';
  return null;
}

// ─── Status code from a single event's free Chinese text ─────────────
// 快递100 hands us a numeric `state` (kd100StateToCode) that already
// distinguishes out_for_delivery / exception / returning. JD's trace API
// does NOT — lib/jd.normalizeTrace only knows delivered-vs-not — so a JD
// parcel that's out with the courier or being returned would otherwise
// collapse to a flat 'in_transit'. This classifies the NEWEST event's text
// into the same status vocabulary so JD orders surface the right state
// (and icon) in the office orders list. Returns a STATUS_CODES code, or
// null when nothing more specific than plain transit is detectable.
//
// Ordered most-significant-first: a returned/returning parcel may still
// carry an earlier "out for delivery" line, so terminal/problem states win.
const STATUS_TEXT_RULES = [
  { code: 'delivered',        re: /已签收|签收成功|妥投|已送达本人|本人签收/ },
  { code: 'returned',         re: /已退回|退回完成|退件签收|退回件已签收/ },
  // NOTE: bare 已拦截 / 发起拦截 are JD phone-privacy courier coordination
  // messages, NOT sender returns. Only match when "拦截" is paired with "退回".
  { code: 'returning',        re: /退回中|拦截.*退回|退件中|开始退回|改退/ },
  { code: 'exception',        re: /派送失败|投递失败|配送异常|无法联系|联系不上|无人接听|电话无法接通|拒收|拒签|破损|疑似丢失/ },
  { code: 'out_for_delivery', re: /正在派送|派送中|派件中|出库派送|开始派送|正在为您派送|安排派送|派(?:件员|送员)|配送员.*(?:派送|配送)|由.*派送/ },
  { code: 'arrived_local',    re: /到达派送区|已到达.*(?:营业部|派送点|网点|网格站)|派送网点/ },
  { code: 'picked_up',        re: /已揽收|揽收成功|已取件/ },
];

function statusFromEventText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const r of STATUS_TEXT_RULES) {
    if (r.re.test(s)) return r.code;
  }
  return null;
}

// ─── Delivery-scenario classifier ────────────────────────────────────
// The kd100 numeric `state` field tells us delivered/in-transit/exception,
// but not WHAT KIND of delivery happened (signed in person? left at the
// door? dropped at a pickup point?). That distinction lives in the free
// Chinese text of `data[].context`. We pattern-match a small finite
// vocabulary to a typed scenario so the mini-app can render a banner
// that tells the customer where their package actually is + what they
// need to do (e.g. "Pickup code: 1-2-3456 at 菜鸟驿站").
//
// Order matters: most-specific scenarios match first. e.g. an event like
// "签收人:【菜鸟驿站XX代收点】" classifies as pickup_point, not in_person.
const SCENARIO_DEFS = [
  {
    code: 'pickup_point',
    icon: '🏪',
    label_en: 'Delivered to pickup point',
    label_cn: '已送达驿站',
    urgency: 'action_needed',
    test: (s) => /菜鸟驿站|驿站|自提点|代收点/.test(s),
    extract: extractPickupCodeAndLocation,
  },
  {
    code: 'locker',
    icon: '📦',
    label_en: 'Delivered to locker',
    label_cn: '已存入快递柜',
    urgency: 'action_needed',
    test: (s) => /快递柜|丰巢|速递易|智能柜/.test(s),
    extract: extractPickupCodeAndLocation,
  },
  {
    code: 'proxy',
    icon: '👥',
    label_en: 'Signed by someone else',
    label_cn: '他人代收',
    urgency: 'info',
    test: (s) => /代签|代收|他人|家人代收|前台代收/.test(s),
    extract: extractSigner,
  },
  {
    code: 'left_at_door',
    icon: '🚪',
    label_en: 'Left at your door',
    label_cn: '已放门口',
    urgency: 'info',
    // Negative lookahead so "放置在XX驿站" doesn't false-match here —
    // the pickup_point rule above would have caught it anyway, but
    // belt + suspenders.
    test: (s) => /门口|门卫|保安亭?|物业|前台(?!代收)/.test(s),
    extract: (s) => ({ location_label: (s.match(/放置?在([^,。;,\s]{1,15})/) || [])[1] || null }),
  },
  {
    code: 'in_person',
    icon: '👤',
    label_en: 'Delivered to you in person',
    label_cn: '已本人签收',
    urgency: 'info',
    test: (s) => /本人签收|当面签收|本人收|签收人[\s:：]*本人/.test(s),
    extract: extractSigner,
  },
  {
    code: 'no_contact',
    icon: '📞',
    label_en: 'Courier can\'t reach you',
    label_cn: '快递员联系不上你',
    urgency: 'urgent',
    test: (s) => /联系不上|无人接听|无法联系|未联系上|电话无法接通|拒接/.test(s),
    extract: () => ({}),
  },
  {
    code: 'out_for_delivery',
    icon: '🛵',
    label_en: 'Out for delivery',
    label_cn: '派送中',
    urgency: 'transit',
    test: (s) => /正在派送|派送中|出库派送|开始派送|派件中/.test(s),
    extract: () => ({}),
  },
];

function extractPickupCodeAndLocation(s) {
  // Pickup codes vary: "1-2-3456", "1234", "#1234". Be permissive.
  const code = (s.match(/取件码[\s:：是]*([0-9A-Za-z\-#]+)/) || [])[1] || null;
  // Pull just the location nickname — find the keyword (e.g. 菜鸟驿站),
  // take up to 10 chars before it, then strip common verb prefixes
  // ("送达XX" / "存放至XX") so we keep only the name itself.
  let loc = null;
  const KW = /(菜鸟驿站|驿站|快递柜|丰巢|速递易|智能柜|自提点|代收点)/;
  const m = s.match(KW);
  if (m) {
    const before = s.slice(Math.max(0, m.index - 10), m.index);
    const stripped = before.replace(/^.*?(?:送达|送至|送往|到达|存放至|存放在|存放|存入|放入|放至|已到|抵达)/, '');
    loc = (stripped + m[1]).trim();
  }
  return { pickup_code: code, location_label: loc };
}

function extractSigner(s) {
  const signer = (s.match(/签收人[\s:：]*([^,。;,()()【】\s]{1,12})/) || [])[1] || null;
  return { signer };
}

// ─── Event description translator (CN → EN) ─────────────────────────
// kd100 returns carrier events as free Chinese text. Non-Chinese readers
// see opaque strings like "您的快件已到达【广州黄埔集货分拣中心】" — they
// can guess from the timeline position but the detail is unreadable.
//
// We pattern-match the ~20 canonical phrases JD/SF/YTO/STO/EMS actually
// emit and substitute an English equivalent, preserving the location
// names (which are proper nouns and translate poorly anyway). For
// untranslated events we fall back to the original Chinese so the
// customer at least sees a timestamp + the carrier's words.
//
// Ordered: most-specific patterns first so e.g. "已签收,签收人:菜鸟驿站"
// classifies as a pickup-point delivery before the generic "signed by".
const TRANSLATION_RULES = [
  // Signed / delivered scenarios
  { cn: /您的快件已签收[,，]?\s*签收人[\s:：]*([^,。;,]+?)(?:[,，].*)?$/, en: (m) => `Delivered, signed by ${m[1]}` },
  { cn: /签收人[\s:：]*([^,。;,]+)/,                                  en: (m) => `Signed by ${m[1]}` },
  { cn: /您的快件已本人签收/,                                          en: ()  => 'Delivered, signed in person' },
  { cn: /本人签收/,                                                   en: ()  => 'Signed in person' },

  // Pickup point / locker (must come before generic delivery patterns)
  { cn: /已(?:送达|存放至|存入).*?([^,。;,]{1,16}?(?:菜鸟驿站|驿站|快递柜|丰巢|代收点|自提点)).*?取件码[\s:：]*([0-9A-Za-z\-#]+)/, en: (m) => `Delivered to ${m[1]}, pickup code: ${m[2]}` },
  { cn: /取件码[\s:：]*([0-9A-Za-z\-#]+)/,                            en: (m) => `Pickup code: ${m[1]}` },

  // Door / proxy
  { cn: /放门口|放置门口/,                                              en: ()  => 'Left at your door' },
  { cn: /放门卫|放置门卫|门卫代收|保安代收/,                              en: ()  => 'Left with the doorman / security' },
  { cn: /家人代收|前台代收|代签收?|他人代收/,                            en: ()  => 'Received on your behalf' },

  // Out for delivery
  { cn: /您的快件由([^,。;,]+?)派(?:件员|送员)?配送/,                    en: (m) => `Out for delivery by ${m[1]}` },
  { cn: /派(?:件员|送员)?([^,。;,\s]+)正在派送/,                        en: (m) => `Out for delivery by ${m[1]}` },
  { cn: /正在派送(?:中)?|开始派送|派件中/,                              en: ()  => 'Out for delivery' },

  // No-contact / exception
  { cn: /联系不上|无人接听|无法联系|电话无法接通|拒接/,                  en: ()  => 'Courier could not reach you — please call back' },
  { cn: /派送(?:失败|未成功)/,                                          en: ()  => 'Delivery attempt failed' },

  // Long-haul kick-off — JD prefixes the next-stop line with "开始长途运输"
  // plus a distance ("1421KM"). Preserve the distance + destination.
  { cn: /开始长途运输[，,]?\s*距离下一站【([^】]+)】\s*(\d+\s*KM)?/i,      en: (m) => `Long-haul transit started — ${m[2] ? m[2] + ' to ' : 'next stop: '}${m[1]}` },

  // Transit between facilities (location names preserved)
  { cn: /您的快件已离开【([^】]+)】[，,].*?发往下一站【([^】]+)】.*?$/,    en: (m) => `Left ${m[1]} — heading to ${m[2]}` },
  { cn: /您的快件已离开【([^】]+)】/,                                   en: (m) => `Left ${m[1]}` },
  { cn: /您的快件已到达【([^】]+)】/,                                   en: (m) => `Arrived at ${m[1]}` },
  { cn: /快件已到达【([^】]+)】/,                                       en: (m) => `Arrived at ${m[1]}` },
  // JD spells the network-station handoff "在【XX网格站】收货完成" rather
  // than "已到达", so it needs its own arrival rule.
  { cn: /(?:在)?【([^】]+)】收货完成/,                                  en: (m) => `Arrived at ${m[1]}` },
  { cn: /([^,。;,\s]+)分拣中心已收(?:箱|件)/,                          en: (m) => `Received at ${m[1]} sorting center` },
  { cn: /已收(?:箱|件)/,                                               en: ()  => 'Received at sorting center' },

  // Pickup / departure
  { cn: /您的快件已揽收|快件已揽收|已揽收/,                              en: ()  => 'Package picked up' },
  { cn: /您的快件已发车|已发车/,                                        en: ()  => 'Package departed' },
  { cn: /您的快件已下单|订单已生成/,                                    en: ()  => 'Waybill created' },

  // Status fallbacks
  { cn: /运输中/,                                                       en: ()  => 'In transit' },
  { cn: /已签收|签收成功/,                                              en: ()  => 'Delivered' },
];

// Translate one event-description string. Returns the original Chinese
// untouched if no rule matches — never throws, always returns a string.
function translateEventDescription(text) {
  // JD (and SF cold-chain) label the parcel by product line — "您的生鲜快件",
  // "您的冷链快件" — instead of the plain "您的快件" the rules below anchor on.
  // Collapse that modifier to the bare form once here so every 您的快件… rule
  // matches; the modifier carries no info we surface in English anyway.
  const cn = String(text || '').trim()
    .replace(/您的(?:生鲜|冷链|国际|特快|标快|经济|同城|医药)快件/g, '您的快件');
  if (!cn) return '';
  for (const rule of TRANSLATION_RULES) {
    const m = cn.match(rule.cn);
    if (m) {
      try { return rule.en(m); } catch { /* try next rule */ }
    }
  }
  return cn;  // Fallback: return the original Chinese
}

function classifyDeliveryEvent(context) {
  const s = String(context || '').trim();
  if (!s) return null;
  for (const def of SCENARIO_DEFS) {
    if (def.test(s)) {
      return {
        scenario:  def.code,
        icon:      def.icon,
        label_en:  def.label_en,
        label_cn:  def.label_cn,
        urgency:   def.urgency,
        ...def.extract(s),
      };
    }
  }
  return null;
}

// ─── 快递100 (Kuaidi100) free subscribe-push integration ─────────────
// Docs: https://api.kuaidi100.com/document/poll/subscribe.html
//
// Flow: when admin saves a tracking number, we POST a subscription to
// kd100. They poll the carrier and push every event change to our
// webhook URL. Free tier covers ~2000/day, well above our volume.
//
// Env config (set in /root/roots-v2/.env on prod):
//   KD100_CUSTOMER  — 客户编号 from api.kuaidi100.com
//   KD100_KEY       — 授权 key
//   KD100_CALLBACK  — our webhook URL (e.g. https://rootskitchenchina.com/api/retail/tracking/kd100/callback)
//   KD100_SECRET    — random string for deriving per-waybill salts (used to verify callbacks)

const crypto = require('crypto');

const KD100_URL = 'https://poll.kuaidi100.com/poll';

// Our internal carrier code → kd100 `company` value. Carriers not in
// this map can't be auto-subscribed; admin can still save the number
// manually and the customer will see the "View on carrier site" link.
// Carriers whose tracking we subscribe through 快递100. JD is deliberately
// NOT here: JD waybills pull events from JD's own trace API
// (syncJdTrackingForCustomer in routes/retail.js), so routing them through
// kd100 too would double-write tracking_events_json and race the JD sync.
// In practice this shop uses kd100 for SF deliveries.
const KD100_CARRIER_MAP = {
  sf:    'shunfeng',
  yto:   'yuantong',
  sto:   'shentong',
  zto:   'zhongtong',
  yunda: 'yunda',
  ems:   'ems',
  // JD's own merchant trace API (jingdong.ldop.receive.trace.get) is
  // account-scoped — it only returns events for waybills allocated under
  // our JD account. Hand-entered personal/C2C waybills (JDV0…) aren't in
  // it, so it answers "成功 · 0 events" forever. Route JD through kd100,
  // which reads the SAME public trace the jd.com page shows, by number.
  jd:    'jd',
};

// Per-tenant integration creds (Platform readiness ⑤). Every kd100 fn takes
// an explicit `c` = { customer, key, secret, callback } resolved by the caller
// from getTenantCreds(tenantId).integrations.kd100, so a tenant subscribes
// under ITS OWN kd100 account. `_envKd100()` is the Roots/legacy fallback used
// only by the global sweeper + the kd100 webhook (both Roots-scoped until ⑨);
// request handlers always pass explicit creds, so a tenant never falls back to
// Roots' env.
function _envKd100() {
  return {
    customer: process.env.KD100_CUSTOMER || '',
    key:      process.env.KD100_KEY || '',
    secret:   process.env.KD100_SECRET || '',
    callback: process.env.KD100_CALLBACK || '',
  };
}

function kd100Enabled(c) {
  c = c || _envKd100();
  return !!(c.customer && c.key && c.callback);
}

function kd100Salt(orderId, trackingNumber, c) {
  c = c || _envKd100();
  const secret = c.secret || 'roots-tracking-default-salt';
  return crypto.createHash('sha1')
    .update(`${secret}|${orderId}|${trackingNumber}`)
    .digest('hex')
    .slice(0, 16);
}

// Subscribe a waybill with kd100. Returns { ok, error? }. Fire-and-forget
// from the admin save path — failures are recorded on the order row so
// staff can retry from the tracking card. `c` = the tenant's kd100 creds.
async function subscribeWithKd100({ orderId, carrierCode, trackingNumber, recipientPhone }, c) {
  c = c || _envKd100();
  if (!kd100Enabled(c)) return { ok: false, error: 'kd100_not_configured' };
  const kdCarrier = KD100_CARRIER_MAP[carrierCode];
  if (!kdCarrier) return { ok: false, error: 'carrier_not_supported_by_kd100' };

  const salt = kd100Salt(orderId, trackingNumber, c);
  const param = {
    company: kdCarrier,
    number: trackingNumber,
    key: c.key,
    parameters: {
      callbackurl: c.callback,
      salt,
      resultv2: '1',     // richer state codes
      autoCom: '1',      // re-identify carrier if mismatched
    },
  };
  // SF and JD privatize the recipient number and require the last 4 digits
  // of the recipient phone to return trace events.
  if ((kdCarrier === 'shunfeng' || kdCarrier === 'jd') && recipientPhone) {
    param.parameters.phone = String(recipientPhone).replace(/\D/g, '').slice(-4);
  }
  const body = new URLSearchParams({
    schema: 'json',
    param:  JSON.stringify(param),
  }).toString();

  try {
    const r = await fetch(KD100_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (j.result === true || j.returnCode === '200') return { ok: true };
    // kd100 returns returnCode 501 / "重复订阅" when the waybill is ALREADY
    // subscribed — that's a healthy, idempotent success, not a failure. Treat
    // it as ok so re-attaching/re-saving a waybill doesn't flip a working
    // subscription back to "unsubscribed".
    if (j.returnCode === '501' || /重复订阅/.test(j.message || '')) return { ok: true, duplicate: true };
    return { ok: false, error: j.message || j.returnCode || 'unknown_kd100_error' };
  } catch (e) {
    return { ok: false, error: 'kd100_request_failed: ' + e.message };
  }
}

// Parse the JSON kd100 POSTs to our callback URL.
// Body is form-encoded: `param=<json>`. The JSON contains:
//   { status, billstatus, message, lastResult: { state, com, nu, data:[...] }, autoCheck }
// `data` is newest-event-first: [{ time, ftime, context, status, areaCode, areaName }, ...]
function parseKd100Callback(rawParamJson) {
  let p;
  try { p = typeof rawParamJson === 'string' ? JSON.parse(rawParamJson) : rawParamJson; }
  catch { return null; }
  if (!p || !p.lastResult) return null;
  const lr = p.lastResult;
  const events = (lr.data || []).map(d => ({
    time:           d.ftime || d.time || null,
    description_cn: d.context || '',
    location:       d.areaName || '',
    status_code:    d.status ? kd100StateToCode(parseInt(d.status, 10)) : null,
  }));
  const stateCode = kd100StateToCode(parseInt(lr.state, 10));
  return {
    company:    lr.com,
    number:     lr.nu,
    state_code: stateCode,
    events,
    delivered:  stateCode === 'delivered',
    finished:   p.billstatus === 'shutdown' || p.status === 'shutdown',
    message:    p.message,
  };
}

// Per-tenant callback URL (Platform readiness ⑨). kd100's async push must
// route back to the tenant whose books the waybill lives in. Like ③'s WeChat
// Pay notify URLs, the tenant is carried in the URL PATH (kd100 sends no
// header/session), and the receiving webhook validates the salt against THAT
// tenant's secret. Roots (#1) keeps its env-configured unsuffixed callback.
// The origin is the same single SaaS server — derived from Roots' own
// KD100_CALLBACK so there's no new config to set.
function kd100CallbackOrigin() {
  try { return new URL(process.env.KD100_CALLBACK).origin; }
  catch { return process.env.PUBLIC_ORIGIN || 'https://rootskitchenchina.com'; }
}
function kd100TenantCallbackUrl(tid) {
  return `${kd100CallbackOrigin()}/api/retail/tracking/kd100/callback/${tid}`;
}

// One batch sweep against a SINGLE tenant's DB using THAT tenant's creds.
// Picks up shipped orders that have a tracking number but no successful
// subscription, and re-tries — but only those whose last attempt has
// been at least `retryMinAgeMin` minutes ago, so we back off transient
// kd100 outages without hammering the API. Returns #re-subscribed.
async function sweepKd100Once(db, creds, { retryMinAgeMin = 10, batch = 20 } = {}) {
  if (!kd100Enabled(creds)) return 0;
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, tracking_carrier, tracking_number, recipient_phone
         FROM retail_orders
        WHERE tracking_number IS NOT NULL
          AND COALESCE(tracking_kd100_subscribed, 0) = 0
          AND tracking_last_error IS NOT NULL
          AND status IN ('dispatched', 'delivered')
          AND COALESCE(tracking_synced_at, '1970-01-01') < datetime('now', '-' || ? || ' minutes')
        ORDER BY id DESC
        LIMIT ?`
    ).all(retryMinAgeMin, batch);
  } catch (e) {
    console.error('[kd100.sweeper] query failed', e);
    return 0;
  }
  if (!rows.length) return 0;
  let done = 0;
  for (const r of rows) {
    if (!KD100_CARRIER_MAP[r.tracking_carrier]) continue;
    const result = await subscribeWithKd100({
      orderId: r.id, carrierCode: r.tracking_carrier,
      trackingNumber: r.tracking_number, recipientPhone: r.recipient_phone,
    }, creds);
    if (result.ok) {
      db.prepare("UPDATE retail_orders SET tracking_kd100_subscribed = 1, tracking_last_error = NULL, tracking_synced_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
      console.log(`[kd100.sweeper] re-subscribed order=${r.id} number=${r.tracking_number}`);
      done++;
    } else {
      db.prepare("UPDATE retail_orders SET tracking_last_error = ?, tracking_synced_at = CURRENT_TIMESTAMP WHERE id = ?").run(result.error, r.id);
    }
  }
  return done;
}

// Multi-tenant sweeper (Platform readiness ⑨). Every 30 min it walks EVERY
// active tenant — Roots included — and sweeps each in its own DB with its own
// kd100 account + per-tenant callback URL, mirroring how the broadcast
// scheduler already fans out across tenants. Replaces the old single-Roots-DB
// sweep so a tenant's transient kd100 failures get retried too.
//
// ctx = { mainDb, getTenantDb, getTenantCreds }. For backward-compat a bare
// better-sqlite3 handle is still accepted → legacy single-tenant Roots sweep.
function startKd100Sweeper(ctx, { intervalMs = 30 * 60_000, retryMinAgeMin = 10, batch = 20 } = {}) {
  const opts = { retryMinAgeMin, batch };
  const legacyDb = (ctx && typeof ctx.prepare === 'function') ? ctx : null;
  const tick = async () => {
    if (legacyDb) { await sweepKd100Once(legacyDb, _envKd100(), opts); return; }
    const { mainDb, getTenantDb, getTenantCreds } = ctx || {};
    if (!mainDb || !getTenantDb || !getTenantCreds) return;
    let tenants;
    try { tenants = mainDb.prepare("SELECT id FROM tenants WHERE status = 'active'").all(); }
    catch { await sweepKd100Once(mainDb, _envKd100(), opts); return; }   // tenants table not migrated yet
    for (const t of tenants) {
      try {
        const base = getTenantCreds(t.id).integrations.kd100;
        // Roots keeps its env callback; tenants get the path-scoped URL so
        // their async pushes route back to their own books.
        const creds = (t.id === 1) ? base : { ...base, callback: kd100TenantCallbackUrl(t.id) };
        if (!kd100Enabled(creds)) continue;
        await sweepKd100Once(getTenantDb(t.id), creds, opts);
      } catch (e) {
        console.error('[kd100.sweeper] tenant ' + t.id + ' failed', e);
      }
    }
  };
  setTimeout(() => tick().catch(e => console.error('[kd100.sweeper] tick threw', e)), 60_000);
  const handle = setInterval(() => tick().catch(e => console.error('[kd100.sweeper] tick threw', e)), intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  CARRIERS,
  STATUS_CODES,
  carrierByCode,
  trackingUrl,
  statusByCode,
  kd100StateToCode,
  deriveStatusFromOrder,
  statusFromEventText,
  KD100_CARRIER_MAP,
  kd100Enabled,
  kd100Salt,
  subscribeWithKd100,
  parseKd100Callback,
  kd100TenantCallbackUrl,
  sweepKd100Once,
  startKd100Sweeper,
  classifyDeliveryEvent,
  translateEventDescription,
};
