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
// §284 — THE COURIER COULD NOT REACH THE CUSTOMER, in every wording a carrier
// has been seen to use for it. ONE PATTERN, THREE READERS: the live status
// below, the `no_contact` scenario, and the English translation — so the pill,
// the banner and the Needs-you alert can never disagree about whether a line
// means "nobody answered". It used to be three hand-copied lists, and all three
// missed 电话未接通 / 联系未果 / 联系不到 / a phone that is 关机, so a courier
// who wrote any of those raised nothing at all.
const NO_CONTACT_RE = /联系不上|联系不到|无法联系|未能?联系上|联系[^，,。；;]{0,6}未果|无人接听|未接听|无人应答|无法接通|未接通|电话未接|打不通|拒接|关机|停机|空号/;

const STATUS_TEXT_RULES = [
  { code: 'delivered',        re: /已签收|签收成功|妥投|已送达本人|本人签收/ },
  { code: 'returned',         re: /已退回|退回完成|退件签收|退回件已签收/ },
  // NOTE: bare 已拦截 / 发起拦截 are JD phone-privacy courier coordination
  // messages, NOT sender returns. Only match when "拦截" is paired with "退回".
  { code: 'returning',        re: /退回中|拦截.*退回|退件中|开始退回|改退/ },
  { code: 'exception',        re: new RegExp('派送失败|投递失败|配送异常|拒收|拒签|破损|疑似丢失|' + NO_CONTACT_RE.source) },
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
    test: (s) => NO_CONTACT_RE.test(s),
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
// Carrier names as they appear INSIDE an event sentence ("货物已交付京东物流").
// CARRIERS above is keyed by our own codes and only ever consulted for the
// order's own carrier; these are the words a carrier writes about itself
// mid-timeline, which is a different lookup. Longest form first so 京东物流
// beats 京东. An unrecognised carrier keeps its own words rather than
// guessing at a romanisation.
const CARRIER_WORD_EN = [
  [/京东物流/,      'JD Logistics'],
  [/京东快递/,      'JD Express'],
  [/京东/,          'JD'],
  [/顺丰速运|顺丰/, 'SF Express'],
  [/圆通速递|圆通/, 'YTO Express'],
  [/申通快递|申通/, 'STO Express'],
  [/中通快递|中通/, 'ZTO Express'],
  [/韵达快递|韵达/, 'Yunda Express'],
  [/中国邮政|邮政|EMS/i, 'China Post EMS'],
  [/德邦/,          'Deppon'],
  [/极兔|J&T/i,     'J&T Express'],
  [/菜鸟/,          'Cainiao'],
];

function carrierWordEn(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  for (const [re, en] of CARRIER_WORD_EN) if (re.test(s)) return en;
  return s;
}

// Short alias for the facility-name translator, so the rule lines below
// stay readable. Defined as a function declaration rather than a const so
// it is hoisted above the rule table that references it.
function fac(name) { return translateFacility(name); }

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
  { cn: /正在派送(?:中)?|派送中|开始派送|派件中/,                        en: ()  => 'Out for delivery' },

  // No-contact / exception
  { cn: NO_CONTACT_RE,                                                  en: ()  => 'Courier could not reach you — please call back' },
  { cn: /派送(?:失败|未成功)/,                                          en: ()  => 'Delivery attempt failed' },

  // Long-haul kick-off — JD prefixes the next-stop line with "开始长途运输"
  // plus a distance ("1421KM"). Preserve the distance + destination.
  { cn: /开始长途运输[，,]?\s*距离下一站【([^】]+)】\s*(\d+\s*KM)?/i,      en: (m) => `Long-haul transit started — ${m[2] ? m[2] + ' to ' : 'next stop: '}${fac(m[1])}` },

  // ── Air legs ────────────────────────────────────────────────────
  // JD routes long-haul by air and says so: "您的快件在【深圳市飞往北京】
  // 的航班上,已起飞". Found on TC000761, where it was the NEWEST event and
  // therefore the top line of the screen — the one a customer reads first.
  // The two city names here are administrative, not facilities, so they go
  // through translateLocation.
  { cn: /【([^】]+?)飞往([^】]+?)】的航班上[,，]?\s*已起飞/,
                                                                      en: (m) => `In flight — ${translateLocation(m[1])} to ${translateLocation(m[2])}, departed` },
  { cn: /【([^】]+?)飞往([^】]+?)】的航班上[,，]?\s*已降落/,
                                                                      en: (m) => `Flight landed — ${translateLocation(m[1])} to ${translateLocation(m[2])}` },
  { cn: /【([^】]+?)飞往([^】]+?)】的航班上/,                            en: (m) => `In flight — ${translateLocation(m[1])} to ${translateLocation(m[2])}` },
  { cn: /航班已起飞|已登机起飞/,                                        en: ()  => 'Flight departed' },
  { cn: /航班已降落|航班已到达/,                                        en: ()  => 'Flight landed' },

  // ── JD (京东物流) phrasings ──────────────────────────────────────
  // JD is our primary carrier and spells much of its timeline differently
  // from the kd100 vocabulary the rules above were written against, so
  // these lines fell straight through to raw Chinese on an EN customer's
  // screen. Every pattern below was taken off a real JD waybill
  // (TC000756), where 6 of 12 events were untranslated.
  { cn: /快递员([^,，。;;、\s]{1,12}?)上门取件[,，]?\s*(?:联系电话[\s:：]*)?([0-9-]{7,20})?/,
                                                                      en: (m) => `Courier ${m[1]} will collect your parcel${m[2] ? ' — ' + m[2] : ''}` },
  { cn: /已由【([^】]+)】揽收(?:完成)?/,                                en: (m) => `Picked up at ${fac(m[1])}` },
  { cn: /([^,，。;;、\s]{1,10}?(?:快递|物流|速运))已收取快件/,           en: (m) => `Picked up by ${carrierWordEn(m[1])}` },
  { cn: /已交付([^,，。;;、]*?(?:物流|快递|速运))/,                      en: (m) => `Handed over to ${carrierWordEn(m[1])}` },
  { cn: /【([^】]+)】\s*(?:分拣完成|完成分拣)/,                         en: (m) => `Sorted at ${fac(m[1])}` },
  { cn: /分拣完成|完成分拣/,                                            en: ()  => 'Sorting complete' },
  { cn: /【([^】]+)】\s*(?:完成装车|已装车)/,                           en: (m) => `Loaded at ${fac(m[1])}` },
  { cn: /完成装车|已装车/,                                              en: ()  => 'Loaded for transit' },
  { cn: /快件交给【?([^,，。;;、】]{1,12})】?[,，].*?正在为您派送/,       en: (m) => `Out for delivery by ${m[1]}` },
  { cn: /已放至前台|放至前台|放前台/,                                    en: ()  => 'Left at the front desk' },
  { cn: /待揽件|等待揽收|等待揽件/,                                      en: ()  => 'Awaiting pickup by the carrier' },
  { cn: /商家已发货|卖家已发货/,                                        en: ()  => 'Shipped by the merchant' },

  // Transit between facilities (location names preserved)
  { cn: /您的快件已离开【([^】]+)】[，,].*?发往下一站【([^】]+)】.*?$/,    en: (m) => `Left ${fac(m[1])} — heading to ${fac(m[2])}` },
  { cn: /您的快件已离开【([^】]+)】/,                                   en: (m) => `Left ${fac(m[1])}` },
  { cn: /您的快件已到达【([^】]+)】/,                                   en: (m) => `Arrived at ${fac(m[1])}` },
  { cn: /快件已?到达【([^】]+)】/,                                      en: (m) => `Arrived at ${fac(m[1])}` },
  // JD spells the network-station handoff "在【XX网格站】收货完成" rather
  // than "已到达", so it needs its own arrival rule.
  { cn: /(?:在)?【([^】]+)】收货完成/,                                  en: (m) => `Arrived at ${fac(m[1])}` },
  { cn: /([^,。;,\s]+)分拣中心已收(?:箱|件)/,                          en: (m) => `Received at ${fac(m[1] + '分拣中心')}` },
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
  // NO RULE MATCHED. Returning the bare Chinese — which is what this did
  // until now — hands a non-Chinese reader a line they cannot read at all,
  // with nothing but the timestamp to go on. The same text almost always
  // still implies a STATUS (statusFromEventText reads a wider vocabulary
  // than the rules above, which is how the pill could read "Out for
  // delivery" over an untranslated line and look broken). Lead with that
  // status so the line says WHERE the parcel is, and keep the carrier's
  // own words after it so nothing is lost and a Chinese speaker reading
  // the EN app still gets the detail.
  const code  = statusFromEventText(cn);
  const label = code ? (STATUS_BY_CODE[code] || {}).label_en : '';
  return label ? `${label} · ${cn}` : cn;
}

// ─── Location translator (CN → EN) ───────────────────────────────────
// Every event also carries a `location` — kd100's areaName, JD's
// opeCityName — and it was passed through untouched, so even a fully
// translated line ended "· 广州市". These are ADMINISTRATIVE place names,
// not facility names: unlike 【广州黄埔集货分拣中心】 they romanise
// cleanly and standardly, and a non-Chinese reader gets real information
// from them. Facility names inside the event sentence stay Chinese, as
// they always have — that is a separate and deliberate decision.
//
// Anything not in the table falls back to the original Chinese, and a
// multi-part place with ONE unknown part falls back WHOLE rather than
// rendering a half-English "Guangdong, 番禺区". That is deliberate: the
// data here is city-level (JD sends opeCityName, kd100 sends areaName), so
// a district we cannot name is rare, and a predictable all-or-nothing line
// reads better than a mixed one.
const PLACE_EN = {
  // Municipalities and provinces
  北京: 'Beijing',    上海: 'Shanghai',   天津: 'Tianjin',    重庆: 'Chongqing',
  广东: 'Guangdong',  河北: 'Hebei',      山西: 'Shanxi',     辽宁: 'Liaoning',
  吉林: 'Jilin',      黑龙江: 'Heilongjiang', 江苏: 'Jiangsu', 浙江: 'Zhejiang',
  安徽: 'Anhui',      福建: 'Fujian',     江西: 'Jiangxi',    山东: 'Shandong',
  河南: 'Henan',      湖北: 'Hubei',      湖南: 'Hunan',      广西: 'Guangxi',
  海南: 'Hainan',     四川: 'Sichuan',    贵州: 'Guizhou',    云南: 'Yunnan',
  陕西: 'Shaanxi',    甘肃: 'Gansu',      青海: 'Qinghai',    内蒙古: 'Inner Mongolia',
  西藏: 'Tibet',      宁夏: 'Ningxia',    新疆: 'Xinjiang',
  香港: 'Hong Kong',  澳门: 'Macau',      台湾: 'Taiwan',
  // Guangdong — where most of our parcels start
  广州: 'Guangzhou',  深圳: 'Shenzhen',   东莞: 'Dongguan',   佛山: 'Foshan',
  珠海: 'Zhuhai',     中山: 'Zhongshan',  惠州: 'Huizhou',    汕头: 'Shantou',
  湛江: 'Zhanjiang',  江门: 'Jiangmen',   肇庆: 'Zhaoqing',   茂名: 'Maoming',
  清远: 'Qingyuan',   韶关: 'Shaoguan',   梅州: 'Meizhou',    潮州: 'Chaozhou',
  揭阳: 'Jieyang',    汕尾: 'Shanwei',    河源: 'Heyuan',     阳江: 'Yangjiang',
  云浮: 'Yunfu',
  // The rest of the country, by where parcels actually go
  杭州: 'Hangzhou',   南京: 'Nanjing',    苏州: 'Suzhou',     无锡: 'Wuxi',
  宁波: 'Ningbo',     温州: 'Wenzhou',    武汉: 'Wuhan',      长沙: 'Changsha',
  成都: 'Chengdu',    西安: "Xi'an",      郑州: 'Zhengzhou',  济南: 'Jinan',
  青岛: 'Qingdao',    合肥: 'Hefei',      福州: 'Fuzhou',     厦门: 'Xiamen',
  南昌: 'Nanchang',   南宁: 'Nanning',    昆明: 'Kunming',    贵阳: 'Guiyang',
  太原: 'Taiyuan',    石家庄: 'Shijiazhuang', 沈阳: 'Shenyang', 大连: 'Dalian',
  长春: 'Changchun',  哈尔滨: 'Harbin',   兰州: 'Lanzhou',    西宁: 'Xining',
  银川: 'Yinchuan',   乌鲁木齐: 'Urumqi', 呼和浩特: 'Hohhot', 拉萨: 'Lhasa',
  海口: 'Haikou',     三亚: 'Sanya',      徐州: 'Xuzhou',     常州: 'Changzhou',
  南通: 'Nantong',    嘉兴: 'Jiaxing',    金华: 'Jinhua',     台州: 'Taizhou',
  绍兴: 'Shaoxing',   泉州: 'Quanzhou',   洛阳: 'Luoyang',    烟台: 'Yantai',
  潍坊: 'Weifang',    临沂: 'Linyi',      唐山: 'Tangshan',   保定: 'Baoding',
  廊坊: 'Langfang',
};

// Longest key first, so 内蒙古 beats 内…, 乌鲁木齐 beats 乌…, and 广州 is
// never mistaken for a 广 + 州 split. Built once at load.
const PLACE_KEYS = Object.keys(PLACE_EN).sort((a, b) => b.length - a.length);

// Administrative suffixes and separators to step over between names. NOTE
// the bare 州 is deliberately NOT here: it is the second character of 广州,
// 苏州, 杭州, 温州, 潮州… and treating it as a suffix split those cities in
// half. Only 自治州 is a suffix.
const PLACE_SKIP = /^(?:维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治县|省|市|区|县|盟|旗|[\s·・,，、-])+/;

// ─── Facility-name translator (CN → EN) ──────────────────────────────
// AMENDS AN EARLIER DECISION, on Ash's call. Facility names inside an
// event sentence were left in Chinese on the reasoning that they are
// proper nouns and that a customer ringing the carrier would need them.
// That reasoning does not survive contact with a real timeline: you quote
// a WAYBILL to a carrier, never a sorting centre, and meanwhile
//
//     Left 深圳航空分拣中心 — heading to 北京大兴航空分拣中心
//
// tells an English reader nothing, when what the line actually says is
// that the parcel flew from Shenzhen to Beijing. That is the single most
// useful fact on the screen and it was the one part still withheld.
//
// These names are structured, not arbitrary: [city][district][type].
// So parse them rather than transliterate — city and district from
// tables, type from the list below.
//
// ALL OR NOTHING. If any part is unknown the WHOLE name stays Chinese,
// exactly as translateLocation does. A half-English "Guangzhou 保利天汇
// 项目 Transfer Point" is worse than either language on its own.
//
// PICKUP POINTS ARE DELIBERATELY EXCLUDED — see translateEventDescription.
// 菜鸟驿站 / 快递柜 / 代收点 names are not passed through here, because
// the customer physically walks to one and has to match the name against
// a sign on a shopfront. That is the case the original "keep it Chinese"
// reasoning was actually right about.

// Longest first: 网格站 must beat 站, 航空分拣中心 must beat 分拣中心.
const FACILITY_TYPE_EN = {
  集货分拣中心: 'Consolidation Sorting Centre',
  航空分拣中心: 'Air Sorting Centre',
  散货分拣中心: 'Bulk Sorting Centre',
  分拣中心:     'Sorting Centre',
  分拨中心:     'Distribution Centre',
  转运中心:     'Transfer Centre',
  集散中心:     'Hub',
  中转场:       'Transfer Depot',
  配送中心:     'Delivery Centre',
  网格站:       'Delivery Station',
  配送站:       'Delivery Station',
  快递站:       'Parcel Station',
  营业部:       'Branch',
  服务部:       'Service Centre',
  接驳点:       'Transfer Point',
  操作部:       'Operations Centre',
  仓库:         'Warehouse',
  分部:         'Branch',
  站:           'Station',
  仓:           'Warehouse',
};
const FACILITY_TYPE_KEYS = Object.keys(FACILITY_TYPE_EN).sort((a, b) => b.length - a.length);

// District / sub-place names that appear between the city and the type.
// Not a general romanisation table — only the ones that actually turn up
// on our waybills, which is the districts of the cities we ship from and
// the hubs we ship through. An unlisted one keeps the name Chinese.
const DISTRICT_EN = {
  // Guangzhou
  黄埔: 'Huangpu',   花都: 'Huadu',    天河: 'Tianhe',   越秀: 'Yuexiu',
  海珠: 'Haizhu',    荔湾: 'Liwan',    白云: 'Baiyun',   番禺: 'Panyu',
  南沙: 'Nansha',    从化: 'Conghua',  增城: 'Zengcheng', 黄村: 'Huangcun',
  // Shenzhen
  宝安: "Bao'an",    龙岗: 'Longgang', 福田: 'Futian',   南山: 'Nanshan',
  罗湖: 'Luohu',     龙华: 'Longhua',  坪山: 'Pingshan', 光明: 'Guangming',
  // Beijing
  大兴: 'Daxing',    朝阳: 'Chaoyang', 海淀: 'Haidian',  通州: 'Tongzhou',
  顺义: 'Shunyi',    丰台: 'Fengtai',  昌平: 'Changping',
  // Shanghai
  奉贤: 'Fengxian',  浦东: 'Pudong',   青浦: 'Qingpu',   松江: 'Songjiang',
  嘉定: 'Jiading',   闵行: 'Minhang',
  // Generic qualifiers that sit in the same slot
  机场: 'Airport',   航空: 'Air',      国际: 'International',
};
const DISTRICT_KEYS = Object.keys(DISTRICT_EN).sort((a, b) => b.length - a.length);

// Separators and administrative suffixes that carry no name of their own.
const FACILITY_SKIP = /^(?:自治区|自治州|自治县|省|市|区|县|盟|旗|[\s·・,，、_/()()-])+/;

function translateFacility(text) {
  const cn = String(text || '').trim();
  if (!cn) return '';
  if (!/[\u4e00-\u9fff]/.test(cn)) return cn;

  const type = FACILITY_TYPE_KEYS.find(k => cn.endsWith(k));
  if (!type) return cn;                              // no recognised type
  const head = cn.slice(0, cn.length - type.length);
  if (!head) return cn;                              // bare type, nothing to name

  const parts = [];
  let i = 0;
  while (i < head.length) {
    const rest = head.slice(i);
    const skip = rest.match(FACILITY_SKIP);
    if (skip) { i += skip[0].length; continue; }
    const city = PLACE_KEYS.find(k => rest.startsWith(k));
    if (city) { parts.push(PLACE_EN[city]); i += city.length; continue; }
    const dist = DISTRICT_KEYS.find(k => rest.startsWith(k));
    if (dist) { parts.push(DISTRICT_EN[dist]); i += dist.length; continue; }
    return cn;                                       // one unknown part → all Chinese
  }
  if (!parts.length) return cn;
  return `${parts.join(' ')} ${FACILITY_TYPE_EN[type]}`;
}

function translateLocation(text) {
  const cn = String(text || '').trim();
  if (!cn) return '';
  if (!/[\u4e00-\u9fff]/.test(cn)) return cn;      // already latin, leave it
  const out = [];
  let i = 0;
  while (i < cn.length) {
    const rest = cn.slice(i);
    const skip = rest.match(PLACE_SKIP);
    if (skip) { i += skip[0].length; continue; }
    const hit = PLACE_KEYS.find(k => rest.startsWith(k));
    if (!hit) return cn;                             // one unknown part → keep it all
    out.push(PLACE_EN[hit]);
    i += hit.length;
  }
  return out.length ? out.join(', ') : cn;
}

// ─── Parcel lookup for a customer-facing tracking screen ─────────────
// retail_orders mirrors only the PRIMARY waybill of an order. On a SPLIT
// order the second parcel's number lives on its own retail_shipments row
// and is nowhere in retail_orders — so a lookup that reads only the order
// row cannot find it.
//
// That is not hypothetical. The mini app's per-parcel "View full tracking"
// passes THAT PARCEL'S waybill (order.js openShipmentLink), and both
// tracking routes looked it up with
//
//     FROM retail_orders WHERE order_no = ? AND tracking_number = ?
//
// so every non-primary parcel 404'd and the screen rendered its "Unable to
// load tracking" error state. The kd100 webhook already had this exact
// fallback — it learned the lesson when secondary-leg pushes were being
// dropped — and the read path never got it.
//
// Order row first: it is the common case, the only case on an unsplit
// order, and it is the row that carries the authoritative status.
//
// `db` is injected rather than required so this stays a pure function of
// its inputs and a test can hand it an in-memory database.
function resolveTrackedParcel(db, orderNo, number) {
  const onOrder = db.prepare(
    `SELECT order_no, status, customer_id,
            tracking_carrier, tracking_number, tracking_status,
            tracking_events_json, tracking_synced_at,
            tracking_scenario_data_json
       FROM retail_orders
      WHERE order_no = ? AND tracking_number = ?`
  ).get(orderNo, number);
  if (onOrder) return onOrder;

  // Not the primary waybill. Resolve through the parcel's own shipment row,
  // taking status/customer from the owning order so the caller's ownership
  // check and status fallback behave exactly as they do for the primary.
  return db.prepare(
    `SELECT o.order_no            AS order_no,
            o.status              AS status,
            o.customer_id         AS customer_id,
            s.tracking_carrier    AS tracking_carrier,
            s.tracking_number     AS tracking_number,
            s.tracking_status     AS tracking_status,
            s.tracking_events_json AS tracking_events_json,
            s.tracking_synced_at  AS tracking_synced_at,
            s.tracking_scenario_data_json AS tracking_scenario_data_json
       FROM retail_shipments s
       JOIN retail_orders o ON o.id = s.order_id
      WHERE o.order_no = ? AND s.tracking_number = ?
      ORDER BY s.id DESC
      LIMIT 1`
  ).get(orderNo, number) || null;
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
  NO_CONTACT_RE,
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
  translateLocation,
  translateFacility,
  resolveTrackedParcel,
};
