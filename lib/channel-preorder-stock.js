'use strict';

/* §209 — A BOOKED ORDER'S STOCK STAYS ON THE SHELF UNTIL THE FOOD IS MADE.
   Ash: 饿了么的预定单，需要等到开始备餐的时候才会自动扣库存。

   An Eleme 预订单 is booked for a later window. The ingest took its stock the
   moment the daemon first saw the order, which on a lunchtime booking made for
   the evening means the goods leave every channel's count hours before anybody
   touches them — and the shelf then reads short to the customers standing in
   front of it.

   THIS FILE DECIDES ONE THING: has this booked order started, or is its stock
   still ours to sell? Two answers count as started, and the pair is deliberate:

     • THE LABEL, when Eleme says the food is being made or is already moving.
     • THE CLOCK, a set number of minutes before the booked delivery time.

   WHICHEVER COMES FIRST. Neither alone is enough. The label alone would hold
   stock indefinitely on an order Eleme never gives us a prep stage for — and
   measured against the live archive (scripts/diagnose_eleme_stage_replay.js)
   this shop's orders mostly carry a delivery-trace stage, not a kitchen one.
   The clock alone would ignore a kitchen that started early.

   WHAT DOES **NOT** COUNT AS STARTED, and it is the load-bearing exclusion:
   接单. `routes/eleme-internal.js` maps 已接单 to our 'preparing', correctly —
   the shop has taken the job — but a shop accepts a booked order the second it
   lands, hours before anyone cooks it. Treating acceptance as prep start would
   have left this whole feature deducting at exactly the moment it does today.
   So the labels below are narrower than that file's status map on purpose, and
   the two must not be merged: one answers "where is this order", this one
   answers "has the shelf lost these goods yet".

   The clock is Ash's number: TWO HOURS before the booked window (asked and
   answered 2026-09-21, "2 hours before"). It is a setting rather than a
   literal, keyed per channel, so a shop with a longer prep never needs code.
*/

// Ash's answer, and the value a store gets when the hold is switched on
// without a number beside it.
const DEFAULT_LEAD_MINUTES = 120;
/* §210 — THE HOLD SHIPS OFF, AND ASH DECIDED THAT AFTER SEEING WHAT IT COSTS.
   Asked why a pre-order should not simply deduct at order time, the honest
   answer is that it should: the shelf number is meant to say what we can still
   promise, and holding a booked order's goods for hours makes it overstate —
   two customers can buy the same last unit and the second one finds out at 6pm.

   The complaint the hold was written for — a booking making us look sold out —
   has a truthful answer already in the system: §85's pre-order window, which
   publishes `shelf + allowance` to a named channel during a window the operator
   sets, and caps itself as the shelf falls. Today's count stays true and the
   extra sales are allowed on purpose, rather than the count being wrong in the
   other direction for a few hours.

   So this file stays, tested and one setting away, and defaults to holding
   nothing. To switch it on for a channel:
     storefront_config['channel.preorder_stock_hold']
       = {"channels":["eleme"],"lead_minutes":120}
   The supported channels are the ones whose ingest calls it — Eleme today. */
const DEFAULT_CHANNELS = [];
const CFG_KEY = 'channel.preorder_stock_hold';

/* The setting, or the defaults. Shape:
     { "channels": ["eleme"], "lead_minutes": 120 }
   An ABSENT row holds nothing (§210), so a shop that never touches this setting
   deducts a booked order's stock at order time exactly as it always did. An
   empty `channels` says the same thing explicitly. */
function holdCfg(db, { channel } = {}) {
  let raw = null;
  try {
    const row = db.prepare("SELECT value_json FROM storefront_config WHERE key = ?").get(CFG_KEY);
    if (row && row.value_json) raw = JSON.parse(row.value_json);
  } catch (_) { raw = null; }

  const channels = raw && Array.isArray(raw.channels)
    ? raw.channels.map((c) => String(c))
    : DEFAULT_CHANNELS;
  const lead = raw != null && Number.isFinite(parseInt(raw && raw.lead_minutes, 10))
    ? Math.max(0, parseInt(raw.lead_minutes, 10))
    : DEFAULT_LEAD_MINUTES;

  return { on: !!channel && channels.includes(String(channel)), leadMinutes: lead };
}

/* Labels that mean THE FOOD IS BEING MADE, OR HAS LEFT.

   Every one of these is a claim about the goods, never about paperwork.
   备餐中 / 制作中 are the kitchen; 已出餐 / 已打包 are the food made; 取餐,
   骑手, 配送中, 已送达, 已完成 are it leaving or gone. 待接单, 已接单 and
   待配送 are all absent, and that is the point of the list: each of them can
   be true of a booking hours before a pan is lit.

   待备餐 ("queued to be prepared") does not match 备餐中 and must not — it is
   the waiting state this whole feature is about. */
const PREP_LABEL_CN = /备餐中|正在备餐|开始备餐|已备餐|备餐完成|制作中|正在制作|已制作|已出餐|出餐完成|已打包|打包完成|已取餐|已取货|已揽收|配送中|派送中|运输中|送出|已送达|已收餐|已收货|已完成|交易完成|已签收|妥投|骑手/;

/* The same list as an ASCII enum, because Eleme mixes the two spellings on the
   same order (routes/eleme-internal.js's status map says so and why). ACCEPT,
   CONFIRM and UNPROCESSED are deliberately missing for the 接单 reason above. */
const PREP_LABEL_ASCII = /COOK|MAKING|PREPARING|PREPARED|PACKED|PACKAGED|PICKED|TAKEN|DELIVERING|SHIPPING|IN_?DELIVERY|ON_?THE_?WAY|TRANSPORT|RIDER|KNIGHT|COURIER|COMPLET|FINISH|DELIVERED|RECEIVED|SETTLED|(^|_)SIGNED(_|$)|(^|_)DONE(_|$)/;

function prepStarted(statusDesc) {
  const d = String(statusDesc || '').trim();
  if (!d) return false;
  // A validity flag is not a stage — the same refusal, for the same reason, as
  // the status map's first arm.
  if (/^(valid|invalid|normal|unknown|default)$/i.test(d)) return false;
  if (PREP_LABEL_CN.test(d)) return true;
  if (/^[A-Za-z][A-Za-z0-9_\- ]*$/.test(d)) return PREP_LABEL_ASCII.test(d.toUpperCase());
  return false;
}

// 'YYYY-MM-DD HH:MM:SS' (UTC, as lib/eleme-browser.js toUtcStamp writes it) or
// an ISO string → ms. Null on anything this cannot read, which callers treat as
// "no booked time", never as "due now".
function stampMs(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

/* Has the clock reached prep time — the booked window less the lead? */
function dueByClock(preorderAt, leadMinutes = DEFAULT_LEAD_MINUTES, now = new Date()) {
  const at = stampMs(preorderAt);
  if (at == null) return false;
  const lead = Number.isFinite(leadMinutes) ? Math.max(0, leadMinutes) : DEFAULT_LEAD_MINUTES;
  return (now instanceof Date ? now.getTime() : Date.parse(now)) >= at - lead * 60000;
}

/* THE ONE QUESTION. True = leave the stock on the shelf.

   Every no-answer fails OPEN, to today's behaviour: no booked time, the channel
   not held, the label already past prep, the clock already there — all deduct
   now, exactly as the ingest always has. The hold is the narrow case. */
function shouldHold({ preorderAt, statusDesc, cfg, now = new Date() } = {}) {
  if (!cfg || !cfg.on) return false;
  if (!preorderAt) return false;
  if (prepStarted(statusDesc)) return false;
  if (dueByClock(preorderAt, cfg.leadMinutes, now)) return false;
  return true;
}

/* Is a held order due now? The mirror of shouldHold, for an order already on
   the shelf — it takes the label OR the clock, and asks nothing about config,
   because an order that is already held is held and must be released whatever
   the setting has since become. */
function dueForRelease({ preorderAt, statusDesc, leadMinutes = DEFAULT_LEAD_MINUTES, now = new Date() } = {}) {
  if (prepStarted(statusDesc)) return true;
  return dueByClock(preorderAt, leadMinutes, now);
}

// SQLite datetime() modifier for the sweep's WHERE clause: '-120 minutes'.
function leadModifier(leadMinutes = DEFAULT_LEAD_MINUTES) {
  const n = Number.isFinite(leadMinutes) ? Math.max(0, Math.round(leadMinutes)) : DEFAULT_LEAD_MINUTES;
  return `-${n} minutes`;
}

module.exports = {
  DEFAULT_LEAD_MINUTES, DEFAULT_CHANNELS, CFG_KEY,
  holdCfg, prepStarted, dueByClock, shouldHold, dueForRelease, leadModifier, stampMs,
};
