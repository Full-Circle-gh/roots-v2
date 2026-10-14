// Customers — the Customers tab in the admin (roster, search, CSV, one
// customer's record and history, edits, blocks, points and wallet adjustments,
// saved addresses, counter vouchers, referral code, direct message) and the
// customer's own profile in the mini app (read, update, avatar). Moved out of
// routes/retail.js unchanged (decisions §470); the code below the line is byte
// for byte what it was there.
//
// HOW THIS FILE IS WIRED. routes/retail.js mounts it with
//   router.use(require('./retail/customers')({ requireRetailAuth, requireRetailAdmin, stampSameCity, sniffImageMime }))
// at the spot this area used to start, so express tries these endpoints in the
// same order relative to each other. Those four helpers still live in
// retail.js and are handed in rather than required: retail.js is still loading
// when it requires this file, so `require('../retail')` here would come back
// empty. Everything else this area uses moved to lib/ first (decisions §477)
// and is required directly.
//
// scripts/test_retail_split_routes.js holds this file to its twenty-six
// endpoints and fails if one of them could answer a request an endpoint in
// another file also answers. scripts/test_retail_golden.js (area "customers")
// holds every answer they give.

const express = require('express');
const { logActivity } = require('../../middleware/auth');
const { tdb } = require('../../lib/tenant-db');
const editHistory = require('../../lib/edit-history');
const { withTransaction } = require('../../lib/db-transaction');
const addressPin = require('../../lib/address-pin');
const phoneCn = require('../../lib/phone-cn');
const wxSec = require('../../lib/wx-sec-check');   // WeChat 内容安全 — every customer-published surface
const { isRiskyText, refuseContent, submitImageSecCheck } = require('../../lib/wx-content-gate');
const { sweepExpiredPoints, pointsRedeemRate } = require('../../lib/loyalty');
const { counterGivable, counterVouchersFor, counterVoucherTerms } = require('../../lib/vouchers');
const { ADDRESS_PUBLIC_COLS, normalizeChinaAddress, geocodeAddressAsync } = require('../../lib/addresses');
const { notifyCustomer } = require('../../lib/customer-notify');
const { reconcileSignupVouchers, claimMigrationCredit } = require('../../lib/signup-rewards');
const { affiliateSettings, ensureReferralCode } = require('../../lib/referrals');
const { shopSqlShift } = require('../../lib/shop-clock');
const { BC_PAID_STATUSES } = require('../../lib/broadcast-audience');
const {
  normEmail, publicCustomer, grantedById, grantedByName, createOrReuseManualCustomer, historyTenantId,
} = require('../../lib/customers');

const router = express.Router();

// Filled by the mount call at the bottom. The pass-throughs below are what the
// code is written against, so they exist before anything is handed in.
const NEEDS = ['requireRetailAuth', 'requireRetailAdmin', 'stampSameCity', 'sniffImageMime'];
const deps = {};
const requireRetailAuth  = (req, res, next) => deps.requireRetailAuth(req, res, next);
const requireRetailAdmin = (req, res, next) => deps.requireRetailAdmin(req, res, next);
const stampSameCity      = (...a) => deps.stampSameCity(...a);
const sniffImageMime     = (...a) => deps.sniffImageMime(...a);

// ────────────────────────────────────────────────────────────────────────────
// §426 — the located vouchers this customer holds at this store, for the till
// to show the moment a customer is attached. Display only: the sale itself is
// priced by POST /api/retail-admin/orders, which picks the best one again.
router.get('/api/retail-admin/customers/:id/counter-vouchers', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const storeId = parseInt(req.query.store_id, 10);
  if (!(id > 0) || !(storeId > 0)) return res.status(400).json({ success: false, error: 'bad_request' });
  res.set('Cache-Control', 'no-store');
  // §428 — `givable`: this location's own vouchers the customer does not hold
  // yet, which the till offers to give. Beside `data`, not inside it, so a till
  // that predates §428 reads exactly what it always read.
  res.json({ success: true, data: counterVouchersFor([id], storeId).map(c => counterVoucherTerms(c.voucher)),
             givable: counterGivable(id, storeId).map(counterVoucherTerms) });
});

/* §428 — GIVE THIS LOCATION'S VOUCHER FROM THE TILL. The two guards Ash took
   when it was proposed, both enforced HERE rather than by what the till chooses
   to draw:
     · only a voucher limited to the till's own store — an online coupon, or
       another location's, is refused whatever is posted;
     · who gave it is recorded by name on the grant, and in the activity log.
   Idempotent: giving one the customer already holds is a success that changes
   nothing, which is what a double tap should be. */
router.post('/api/retail-admin/customers/:id/counter-vouchers', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const storeId = parseInt(req.body && req.body.store_id, 10);
  const voucherId = parseInt(req.body && req.body.voucher_id, 10);
  if (!(id > 0) || !(storeId > 0) || !(voucherId > 0)) return res.status(400).json({ success: false, error: 'bad_request' });
  const c = tdb().prepare('SELECT id, is_blocked FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'customer_not_found' });
  if (c.is_blocked) return res.status(409).json({ success: false, error: 'customer_blocked' });
  const v = counterGivable(id, storeId, { includeHeld: true }).find(x => x.id === voucherId);
  if (!v) return res.status(403).json({ success: false, error: 'not_this_location' });
  const info = tdb().prepare(
    `INSERT OR IGNORE INTO retail_customer_vouchers
       (customer_id, voucher_id, granted_by, granted_note, granted_by_name)
     VALUES (?, ?, ?, 'Given at the counter', ?)`
  ).run(id, voucherId, grantedById(req), grantedByName(req));
  logActivity(req.user.id, req.user.username, 'grant_counter', 'voucher', voucherId,
              { code: v.code, customer_id: id, store_id: storeId, granted: info.changes }, req.ip);
  res.json({ success: true, data: { granted: info.changes === 1 } });
});

// Manual customer create — staff key in a walk-in / phone-order customer that
// never signed up through the app. There's no WeChat/web identity, so we mint a
// synthetic `manual:<hex>` openid (keeps the UNIQUE NOT NULL constraint happy,
// same trick the web-auth flows use with 'web:'/'email:' prefixes).
//
// Reuse-by-phone: if the phone already belongs to a customer we return THAT
// record (reused:true) instead of creating a duplicate — and opportunistically
// backfill a blank name/email. This is also why a manual record unifies cleanly
// later: the phone-OTP login (upsert unifies by phone) lands the person on this
// same row when they first sign in themselves.
router.post('/api/retail-admin/customers', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const nickname = b.nickname == null ? '' : String(b.nickname).trim().slice(0, 60);
  const phone    = b.phone == null ? '' : String(b.phone).replace(/\s+/g, '').slice(0, 20);

  const made = createOrReuseManualCustomer({
    nickname: b.nickname, email: b.email, phone: b.phone, userId: req.user.id,
  });
  if (made.error) return res.status(400).json({ success: false, error: made.error });
  if (made.reused) {
    const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(made.id);
    logActivity(req.user.id, req.user.username, 'link_manual', 'retail_customer', made.id, { phone }, req.ip);
    return res.json({ success: true, reused: true, data: publicCustomer(fresh) });
  }
  const id = made.id;
  // Same post-create hooks the self-service flows run — apply any migration
  // credit / signup vouchers keyed to this phone. Best-effort.
  // Capture what these two actually MOVED, so the drawer can name it. Both
  // already knew; neither used to say. Without this the operator sees a
  // balance they didn't type and has no idea where it came from.
  let credit = null, vouchers = 0;
  if (phone) {
    try { credit = claimMigrationCredit(id); } catch (e) { console.warn('[retail-admin/customer create] migration claim failed:', e.message); }
    try { vouchers = reconcileSignupVouchers(id) || 0; } catch (e) { console.warn('[retail-admin/customer create] voucher reconcile failed:', e.message); }
  }
  const customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  logActivity(req.user.id, req.user.username, 'create_manual', 'retail_customer', id, { phone, nickname }, req.ip);
  res.json({
    success: true, reused: false, data: publicCustomer(customer),
    // Only ever non-zero when something genuinely transferred — the client
    // says nothing at all when all three are zero.
    carried: {
      balance:  Number(credit?.balance || 0),
      points:   Number(credit?.points  || 0),
      vouchers: vouchers,
    },
  });
});

// ─── Roster search ────────────────────────────────────────────────────────
// Lifted out of the handler below so scripts/test_customer_search.js can run
// the REAL predicate against a real (in-memory) database. A suite that rebuilds
// the WHERE clause is testing a different program.
//
// ── WHY A PHONE NUMBER COULD BE TYPED IN FULL AND STILL NOT FOUND ─────────
// The search was `phone LIKE '%<what you typed>%'` — one literal substring, run
// against one column. Three ways that misses a customer who is right there:
//
//   1. THE STORED NUMBER CARRIES SEPARATORS. '18327117510' is not a substring of
//      '183 2711 7510' or '183-2711-7510'. Five write paths normalize now
//      (docs/known-issues.md, RECIPIENT-PHONE-UNVALIDATED) — but normalizing on
//      write only tidies what was written after it shipped. Every row stored
//      before that, and every number that arrived by import, is still in
//      whatever shape a human typed it.
//   2. THE TYPED NUMBER CARRIES THEM. '+86 183 2711 7510' fails `^\d+$`, so it
//      took the non-numeric branch — which searched neither order ids nor saved
//      addresses — and then matched nothing anyway, because the '+86 ' is not in
//      the stored value either.
//   3. THE NUMBER IS ONLY ON THE ORDER. `retail_orders.recipient_phone` is an
//      order-time snapshot; a customer can have one there and a blank profile
//      phone with no saved address (a manual/POS order, or an address since
//      edited or deleted). Orders admin search already matches recipient_phone,
//      so the same number found the ORDER and not the PERSON.
//
// The raw LIKE is kept on every field it already covered — this only ADDS
// clauses, so nothing that matched before stops matching.
//
// Separators are stripped from the STORED value, not just from the query,
// because the mismatch can be on either side. ASCII shapes only: a number
// written with full-width punctuation would still be missed, which is recorded
// rather than fixed — no such value has been seen, and each extra REPLACE is
// paid on every row of a full-table scan.
const SEARCH_PHONE_DIGITS = (col) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')`;

// The digits to hunt for, or '' when the query isn't a phone number at all.
//
// 🔴 A QUERY IS ONLY TREATED AS A PHONE WHEN IT CONTAINS NOTHING BUT DIGITS AND
// PHONE PUNCTUATION. Matching a name's digits against phone columns would make
// "Wang 8" return everyone whose number contains an 8 — the digit clauses are
// substring matches and would swamp the real answer.
//
// Four digits is the floor because the last four is how staff actually search
// ("the 7510 one"), and it is short enough to be worth the noise. A country-code
// wrapper is unwrapped exactly as normalizeMigrationPhone does it, so a number
// typed as '+86 183…' finds a row stored bare.
function searchPhoneDigits(q) {
  const raw = String(q || '').trim();
  if (!raw || !/^[\d\s\-+().]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return '';
  if (digits.length === 13 && digits.startsWith('86'))   return digits.slice(2);
  if (digits.length === 14 && digits.startsWith('086'))  return digits.slice(3);
  if (digits.length === 15 && digits.startsWith('0086')) return digits.slice(4);
  return digits;
}

// { sql, params } for one search term, or null when there's nothing to search.
// The SQL is a single parenthesised OR-group, safe to AND into any WHERE built
// against retail_customers unaliased.
function customerSearchWhere(q) {
  const term = String(q || '').trim();
  if (!term) return null;

  const like = '%' + term + '%';
  // note and tags join the search because the whole point of writing "wholesale
  // — invoice monthly" on a record is being able to find it again (audit E-02).
  const ors = ['nickname LIKE ?', 'phone LIKE ?', 'openid LIKE ?', 'note LIKE ?', 'tags LIKE ?'];
  const params = [like, like, like, like, like];

  if (/^\d+$/.test(term)) {
    // numeric → the CUSTOMER's own id FIRST. An account with no nickname is
    // shown as '#<id>' on the till and in the drawer, so that is a number
    // staff read off a screen and type back — and it was the one lookup that
    // missed, because a bare number only ever reached order ids.
    ors.push('id = ?');
    params.push(parseInt(term, 10));
    // …and an order id or order number
    ors.push('id IN (SELECT customer_id FROM retail_orders WHERE id = ? OR order_no LIKE ?)');
    params.push(parseInt(term, 10), like);
    // …and a saved delivery-address phone (the recipient number can differ from
    // the customer's own profile phone, e.g. gifting/family orders)
    ors.push('id IN (SELECT customer_id FROM retail_customer_addresses WHERE phone LIKE ?)');
    params.push(like);
  } else {
    // non-numeric → order number too (e.g. "R26…")
    ors.push('id IN (SELECT customer_id FROM retail_orders WHERE order_no LIKE ?)');
    params.push(like);
  }

  const digits = searchPhoneDigits(term);
  if (digits) {
    const dlike = '%' + digits + '%';
    ors.push(`${SEARCH_PHONE_DIGITS('phone')} LIKE ?`);
    params.push(dlike);
    ors.push(`id IN (SELECT customer_id FROM retail_customer_addresses
                      WHERE ${SEARCH_PHONE_DIGITS('phone')} LIKE ?)`);
    params.push(dlike);
    // customer_id IS NULL on every Meituan / Gzgrocery / guest order, and those
    // rows can't name a customer — excluded so the IN list stays small rather
    // than for correctness (`id IN (…, NULL, …)` matches no id either way).
    ors.push(`id IN (SELECT customer_id FROM retail_orders
                      WHERE customer_id IS NOT NULL
                        AND ${SEARCH_PHONE_DIGITS('recipient_phone')} LIKE ?)`);
    params.push(dlike);
  }

  return { sql: '(' + ors.join(' OR ') + ')', params };
}

// Customer search — used by the voucher-grant modal in /retail-admin.
// Matches name, phone, or openid prefix. Returns 20 most recent matches.
// Customers list — used by both the voucher autocomplete (simple ?q) and the
// Customers admin tab (paginated, filterable). Backward compatible: same URL,
// same `data` field shape (plus extra columns), older callers ignore the new
// `page/pageSize/total` fields.
// The Customers filter clause, built in ONE place because THREE readers need
// to agree about it: the roster page, the COUNT that feeds its pager, and the
// CSV export. The export must return exactly the customers on screen — the
// operator picked those filters, and a file that quietly widened or narrowed
// them is a file nobody can check. Pagination and sort stay with the page
// reader below; an export has neither.
function buildCustomerFilter(query) {
  const q              = String(query.q || '').trim();
  // Comma-separated so the Tier column header can filter by several tiers at
  // once (e.g. "root,tree"); a single value still works the same as before.
  const tiers          = String(query.tier || '').trim().split(',').map(s => s.trim()).filter(Boolean);
  // Same pattern for the Channel filter. Values are SIGNUP channels —
  // 'wechat' | 'web' | 'manual' | 'unknown' — derived from openid by
  // CHANNEL_SQL below, which the SELECT and this WHERE both read so the icon
  // on a row and the filter that returns it can never disagree.
  const channels       = String(query.channel || '').trim().split(',').map(s => s.trim()).filter(Boolean);
  const segment        = String(query.segment || '').trim();
  // The roster asks for one segment at a time; the stat strip still calls this
  // with includeBlocked=1 (pageSize=1) purely to count every account.
  const includeBlocked = query.includeBlocked === '1' || segment === 'blocked';

  // ── Signup channel — WHERE THEY SIGNED UP, not where they last ordered ──
  //
  // Derived from `openid`, which is UNIQUE NOT NULL and whose prefix is written
  // by the insert site itself — so it cannot be lost, shared, or disagree with
  // anything. It IS the source of truth. `retail_customers.source` is
  // deliberately NOT backfilled from it: two fields carrying the same fact must
  // then agree forever, and on the day they diverge nobody can say which is
  // right. `source` stays as it is — written only by the admin create path,
  // which is correct and simply hasn't fired yet.
  //
  // This replaced a last-order-channel lookup that defaulted to 'wechat' for
  // anyone with no orders — a claim about origin made from no evidence, on 511
  // of 690 rows.
  //
  // `_reset_` is an ARCHIVE WRAPPER, not an origin: reset_test_customer stores
  // `_reset_<epoch>_<original openid>`, so unwrap it first and classify what is
  // underneath. (LIKE needs ESCAPE here — `_` is LIKE's single-char wildcard.)
  const OPENID_RAW =
    `CASE WHEN retail_customers.openid LIKE '\\_reset\\_%' ESCAPE '\\'
          THEN SUBSTR(retail_customers.openid, 8 + INSTR(SUBSTR(retail_customers.openid, 8), '_'))
          ELSE retail_customers.openid END`;
  // 🔴 NO CATCH-ALL `else`. The native WeChat shape is asserted explicitly
  // (28 chars, leading 'o', base64url charset). Anything matching nothing —
  // including a future signup path that forgets to namespace its synthetic
  // openid — comes back 'unknown' and renders NO icon. Classifying by exclusion
  // is how a wrong value ships and nobody notices.
  const CHANNEL_SQL = `CASE
      WHEN (${OPENID_RAW}) LIKE 'manual:%' THEN 'manual'
      WHEN (${OPENID_RAW}) LIKE 'web:%'    THEN 'web'
      WHEN (${OPENID_RAW}) LIKE 'google:%' THEN 'web'
      WHEN (${OPENID_RAW}) LIKE 'apple:%'  THEN 'web'
      WHEN (${OPENID_RAW}) LIKE 'email:%'  THEN 'web'
      WHEN (${OPENID_RAW}) LIKE 'wxweb:%'  THEN 'web'
      WHEN (${OPENID_RAW}) LIKE 'dev:%'    THEN 'wechat'
      WHEN LENGTH(${OPENID_RAW}) = 28
       AND (${OPENID_RAW}) GLOB 'o[A-Za-z0-9_-]*'  THEN 'wechat'
      ELSE 'unknown' END`;

  const where  = [];
  const params = [];
  if (!includeBlocked) where.push('is_blocked = 0');
  if (tiers.length)    { where.push(`tier_key IN (${tiers.map(() => '?').join(',')})`); params.push(...tiers); }
  if (channels.length) { where.push(`${CHANNEL_SQL} IN (${channels.map(() => '?').join(',')})`); params.push(...channels); }
  // Tag facet (audit E-02). Stored comma-separated, so matching wraps BOTH
  // sides in commas: ',vip,wholesale,' LIKE '%,vip,%' is true and
  // '%,vip,%' can never match 'vip-trial' the way a bare '%vip%' would.
  // Several tags are an OR — an operator asking for "vip, wholesale" wants
  // everyone in either group, which is what a facet chip row means everywhere
  // else on this screen.
  const tags = String(query.tags || '').trim().split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length) {
    where.push('(' + tags.map(() => "',' || COALESCE(tags,'') || ',' LIKE ?").join(' OR ') + ')');
    params.push(...tags.map(t => `%,${t},%`));
  }

  // Roster segments — the cuts an operator actually reaches for. Timestamps are
  // UTC text, so SQLite's datetime() comparisons work on them directly.
  //
  // "Sleeping" is ORDER recency, not login recency: someone who has bought
  // before but has placed no paid order in 60 days. That is exactly
  // audienceWhere()'s activity='lapsed', reused here verbatim so the roster
  // chip and a broadcast audience can never disagree about who is asleep.
  // Accounts that never ordered at all are NOT sleeping — the "Never ordered"
  // stat tile is their cut.
  const SEG_PAID_IN     = BC_PAID_STATUSES.map(() => '?').join(',');
  const SEG_PAID_EXISTS = `SELECT 1 FROM retail_orders o WHERE o.customer_id = retail_customers.id AND o.status IN (${SEG_PAID_IN})`;
  //
  // "New this week" is anchored to GUANGZHOU calendar days, not a rolling UTC
  // 168-hour window. The "New today" stat tile above the roster already counts
  // a GZ day (date(created_at,'+8 hours')); a rolling UTC window put the two
  // eight hours out of step on one screen, so a signup at 07:00 GZ today read
  // as "today" on the tile and as a day old on the roster. Today plus the
  // previous 6 GZ days, so today is always inside this week.
  if      (segment === 'blocked')  where.push('is_blocked = 1');
  else if (segment === 'new_week') where.push(`date(created_at, '${shopSqlShift()}') >= date('now', '${shopSqlShift()}', '-6 days')`);
  else if (segment === 'sleeping') {
    where.push(`EXISTS (${SEG_PAID_EXISTS})`);
    params.push(...BC_PAID_STATUSES);
    where.push(`NOT EXISTS (${SEG_PAID_EXISTS} AND o.placed_at >= datetime('now', '-60 days'))`);
    params.push(...BC_PAID_STATUSES);
  }

  // See customerSearchWhere above — name, phone (in whatever shape either side
  // wrote it), openid, order id / number, address phone, order recipient phone.
  const search = customerSearchWhere(q);
  if (search) { where.push(search.sql); params.push(...search.params); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { whereSql, params, CHANNEL_SQL, search, SEG_PAID_EXISTS };
}

// ── CSV: the customers the roster is showing, all of them ──────────────────
// Registered ABOVE /customers/:id on purpose: Express matches in order and
// `export.csv` would otherwise be parsed as a customer id.
//
// Same filters as the roster (buildCustomerFilter), no page window. This is the
// merchant's own contact list — the thing they need to mail a promotion, hand
// to an accountant, or take with them if they leave. BOM-prefixed UTF-8 so
// Excel renders the Chinese names correctly.
//
// Blocked customers follow the roster's rule exactly: absent unless the caller
// asked for them (?includeBlocked=1 or ?segment=blocked), because that is what
// the screen was showing when the button was pressed.
router.get('/api/retail-admin/customers/export.csv', requireRetailAdmin, (req, res) => {
  try {
    const { whereSql, params, CHANNEL_SQL } = buildCustomerFilter(req.query);
    const rows = tdb().prepare(
      `SELECT id, nickname, phone, email, openid, tier_key, tags, note,
              lifetime_spend, points_balance, balance, is_blocked,
              ${CHANNEL_SQL} AS channel,
              (SELECT COUNT(*) FROM retail_orders o WHERE o.customer_id = retail_customers.id) AS orders_count,
              datetime((SELECT MAX(o.placed_at) FROM retail_orders o WHERE o.customer_id = retail_customers.id), '${shopSqlShift()}') AS last_order_at,
              datetime(created_at,     '${shopSqlShift()}') AS joined_local,
              datetime(last_login_at,  '${shopSqlShift()}') AS last_seen_local
         FROM retail_customers
         ${whereSql}
        ORDER BY id ASC`
    ).all(...params);

    const yn = v => (Number(v) ? 'Yes' : 'No');
    const head = [
      'ID', 'Name', 'Phone', 'Email', 'Tier', 'Signed up via', 'Tags',
      'Orders', 'Lifetime spend', 'Points', 'Wallet balance',
      'Blocked', 'Joined (UTC+8)', 'Last order (UTC+8)', 'Last seen (UTC+8)', 'Note',
    ];
    const cell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push([
        r.id, r.nickname, r.phone, r.email, r.tier_key, r.channel, r.tags,
        r.orders_count, r.lifetime_spend, r.points_balance, r.balance,
        yn(r.is_blocked), r.joined_local, r.last_order_at, r.last_seen_local, r.note,
      ].map(cell).join(','));
    }
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers_${day}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) {
    console.error('[customers csv]', e);
    res.status(500).json({ success: false, error: 'customers_csv_failed', message: e.message });
  }
});

router.get('/api/retail-admin/customers', requireRetailAdmin, (req, res) => {
  // Sort and paging belong to the page reader; the filter itself is shared with
  // the CSV export (see buildCustomerFilter).
  const sort           = String(req.query.sort || 'recent_login');
  const dir            = req.query.dir === 'asc' ? 'ASC' : (req.query.dir === 'desc' ? 'DESC' : null);
  const page           = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize       = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset         = (page - 1) * pageSize;
  const { whereSql, params, CHANNEL_SQL, search, SEG_PAID_EXISTS } = buildCustomerFilter(req.query);


  // Column-header sort: one column at a time, either direction. `orders_count`
  // and `balance` (Orders / Wallet columns) aren't sortable columns on the
  // table itself — `orders_count` is a subquery alias in the SELECT list
  // below, which SQLite lets ORDER BY reference directly; `balance` is the
  // wallet column. Old sort-select values (recent_login etc.) are kept as
  // aliases so nothing else calling this endpoint breaks.
  const SORT_COLS = {
    name: 'nickname', tier: "CASE tier_key WHEN 'seed' THEN 0 WHEN 'sprout' THEN 1 WHEN 'root' THEN 2 WHEN 'tree' THEN 3 ELSE 0 END",
    orders: 'orders_count', spend: 'lifetime_spend', points: 'points_balance', wallet: 'balance', last_seen: 'last_login_at',
    recent_login: 'last_login_at', recent_signup: 'created_at', lifetime_spend: 'lifetime_spend', points_balance: 'points_balance',
  };
  const SORT_DEFAULT_DIR = {
    name: 'ASC', tier: 'DESC', orders: 'DESC', spend: 'DESC', points: 'DESC', wallet: 'DESC', last_seen: 'DESC',
    recent_login: 'DESC', recent_signup: 'DESC', lifetime_spend: 'DESC', points_balance: 'DESC',
  };
  const sortCol = SORT_COLS[sort] || SORT_COLS.last_seen;
  const sortDir = dir || SORT_DEFAULT_DIR[sort] || 'DESC';
  // "Never logged in" rows sort to the tail regardless of direction.
  const orderClause = (sort === 'last_seen' || sort === 'recent_login')
    ? `last_login_at IS NULL, last_login_at ${sortDir}, id DESC`
    : `${sortCol} ${sortDir}, id DESC`;

  const total = tdb().prepare(`SELECT COUNT(*) AS n FROM retail_customers ${whereSql}`).get(...params).n;

  // ── "nothing matched" is not "you have no customers" (§1.12) ───────────────
  // `total` is counted under the SAME whereSql as the rows, so total:0 says both
  // of those things in one number and a client testing !length cannot tell them
  // apart. This count drops every operator-chosen filter — q, tier, channel,
  // segment, the is_blocked default — and keeps only the tenant scoping that
  // tdb() itself applies. Between the two the client can distinguish three
  // states: matches; no matches but customers exist; no customers at all.
  //
  // Named for what it counts, not as a second kind of total, because a
  // `total_unfiltered` sitting beside `total` is one careless read away from
  // being used as the pagination denominator. `total` is untouched — the roster
  // pager, the stat strip and the voucher autocomplete all rely on it.
  const customersOnFile = tdb().prepare('SELECT COUNT(*) AS n FROM retail_customers').get().n;

  // ── A match the operator's own filters are hiding ──────────────────────────
  // Every segment except Blocked carries `is_blocked = 0`, so searching a
  // blocked customer's phone from the default view returns nothing and the empty
  // state says "nothing matches" — about a record that is on file, holds that
  // number, and is the one thing worth knowing. Same for a match sitting outside
  // the chosen tier / channel / segment.
  //
  // Only computed when a SEARCH found nothing: an empty tier filter isn't a
  // failed lookup, and this is a second full scan we shouldn't pay on every
  // page. Counted under the search term ALONE, which is exactly what makes the
  // client's sentence true — "your filters are hiding N".
  let hidden = null;
  if (search && total === 0) {
    const h = tdb().prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(is_blocked), 0) AS blocked
         FROM retail_customers WHERE ${search.sql}`
    ).get(...search.params);
    if (h.n) hidden = { total: h.n, blocked: h.blocked };
  }

  const rows = tdb().prepare(
    `SELECT id, nickname, phone, openid, email, tier_key, lifetime_spend,
            points_balance, balance, is_blocked, created_at, last_login_at, seen_at,
            note, tags,
            (SELECT COUNT(*) FROM retail_orders WHERE customer_id = retail_customers.id) AS orders_count,
            ${CHANNEL_SQL} AS channel
       FROM retail_customers
       ${whereSql}
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  // Returning rate — share of customers who've bought at least once who came
  // back for a second order. Only the stat-strip's grand-total call asks for
  // this (withReturning=1); the paginated roster fetch skips it.
  let returning = null;
  if (req.query.withReturning === '1') {
    const r = tdb().prepare(
      `SELECT COUNT(*) AS buyers, SUM(CASE WHEN cnt >= 2 THEN 1 ELSE 0 END) AS returners
         FROM (SELECT customer_id, COUNT(*) AS cnt FROM retail_orders GROUP BY customer_id)`
    ).get();
    returning = { buyers: r.buyers || 0, returners: r.returners || 0 };
  }

  // Real counts for every roster segment chip (withSegments=1 — only the
  // stat-strip's grand-total call asks). Each figure is queried with the SAME
  // predicate the corresponding `segment=` filter applies above, so a chip can
  // never promise a row count the roster then doesn't produce. Search / tier /
  // channel filters are deliberately NOT applied: the chips describe the whole
  // base, exactly as the Blocked chip always has.
  // Replaces the old client-side derivation of Blocked (total − Σ tier counts).
  let segments = null;
  if (req.query.withSegments === '1') {
    const seg = tdb().prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN is_blocked = 0 THEN 1 ELSE 0 END), 0) AS all_count,
         COALESCE(SUM(CASE WHEN is_blocked = 0 AND date(created_at, '${shopSqlShift()}') >= date('now', '${shopSqlShift()}', '-6 days') THEN 1 ELSE 0 END), 0) AS new_week,
         COALESCE(SUM(CASE WHEN is_blocked = 0
                            AND EXISTS (${SEG_PAID_EXISTS})
                            AND NOT EXISTS (${SEG_PAID_EXISTS} AND o.placed_at >= datetime('now', '-60 days'))
                       THEN 1 ELSE 0 END), 0) AS sleeping,
         COALESCE(SUM(CASE WHEN is_blocked = 1 THEN 1 ELSE 0 END), 0) AS blocked
       FROM retail_customers`
    ).get(...BC_PAID_STATUSES, ...BC_PAID_STATUSES);
    segments = { all: seg.all_count, new_week: seg.new_week, sleeping: seg.sleeping, blocked: seg.blocked };
  }

  // Every tag anybody on this account has actually used, so the filter offers
  // real groups rather than a list somebody has to remember. Built from the
  // stored comma-separated column with no schema of its own: a separate tag
  // table would be a second source of truth for the same fact, and the day it
  // disagreed with the column nobody could say which was right.
  const tagRows = tdb().prepare(
    "SELECT tags FROM retail_customers WHERE tags IS NOT NULL AND tags != ''"
  ).all();
  const tagCounts = new Map();
  for (const r of tagRows) {
    for (const t of String(r.tags).split(',')) {
      const k = t.trim();
      if (k) tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
    }
  }
  const tagVocabulary = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => ({ tag, count: n }));

  res.json({ success: true, data: rows, page, pageSize, total, customers_on_file: customersOnFile,
             hidden_by_filters: hidden, returning, segments, tag_vocabulary: tagVocabulary });
});

// Would a "save as a customer" tick attach this order to somebody already on
// file? Answers that BEFORE submit, so the form can warn while the operator is
// still typing instead of reporting it after the order is filed.
//
// 🔴 The WHERE and the ORDER BY are copied verbatim from the reuse branch in
// POST /api/retail-admin/customers. That is the whole point of this endpoint: it
// must name the row the POST would actually pick, so the warning and the outcome
// cannot disagree. If the reuse query ever changes, change it here in the same
// commit.
//
// Why the roster search could not do this job:
//   • it defaults to is_blocked = 0, while reuse matches a blocked record too —
//     so it would go quiet on exactly the case worth warning about;
//   • it is `phone LIKE '%…%'`, a substring superset, not the equality reuse uses;
//   • it cannot say WHICH of several matches reuse lands on (lowest id wins), and
//     sharing a number is the normal case here, not the edge.
//
// MUST stay registered above GET /customers/:id — otherwise Express reads
// "by-phone" as an :id.
router.get('/api/retail-admin/customers/by-phone', requireRetailAdmin, (req, res) => {
  const phone = String(req.query.phone || '').replace(/\s+/g, '').slice(0, 20);
  if (!phone) return res.status(400).json({ success: false, error: 'phone_required' });
  // Same shape the POST enforces, so a number this endpoint calls malformed is a
  // number the POST would also reject.
  if (!/^\+?[0-9]{7,15}$/.test(phone)) {
    return res.status(400).json({ success: false, error: 'bad_phone' });
  }

  // 🔴 The answer MUST NOT vary with is_blocked, and there is deliberately no
  // is_blocked in this WHERE. A blocked customer still owns the number, and reuse
  // will still attach to them. Filtering them out here would tell the operator
  // "no match" and then quietly file the order under the blocked record — the
  // same bug this endpoint exists to prevent, wearing a different costume.
  // is_blocked is RETURNED so the form can say "found, and that one is blocked".
  const match = tdb().prepare(
    `SELECT id, nickname, phone, is_blocked,
            (SELECT COUNT(*) FROM retail_orders WHERE customer_id = retail_customers.id) AS orders_count
       FROM retail_customers
      WHERE phone = ?
      ORDER BY id LIMIT 1`
  ).get(phone);

  // How many records carry this number. >1 means the operator is choosing blind
  // unless the form says so — reuse will silently take the lowest id.
  const shareCount = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_customers WHERE phone = ?'
  ).get(phone).n;

  res.json({ success: true, match: match || null, share_count: shareCount });
});

// ─── Customer admin (profile, analytics, edits, adjustments) ─────────────
// Full profile + behavioral aggregates for one customer. All counts are
// computed live so the column `lifetime_spend` (currently never written) is
// not used as a source of truth.
router.get('/api/retail-admin/customers/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });

  const customer = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ success: false, error: 'not_found' });

  // Mark the record seen by staff the first time ANYONE opens it — same shared
  // model as retail_orders.seen_at (one stamp, no operator identity, so NULL
  // means "nobody on this team has opened this", not "you haven't").
  // Idempotent: only the first open stamps it.
  if (!customer.seen_at) {
    const nowIso = new Date().toISOString();
    try { tdb().prepare('UPDATE retail_customers SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(nowIso, id); } catch {}
    customer.seen_at = nowIso;
  }

  const addresses = tdb().prepare(
    'SELECT * FROM retail_customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id DESC'
  ).all(id);

  const orders = tdb().prepare(
    `SELECT
       COUNT(*) AS orders_count,
       SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN 1 ELSE 0 END) AS completed_count,
       SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END) AS refunded_count,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       -- One money measure across the section: SUBTOTAL, the goods total before
       -- discounts and shipping. That is exactly what the list column
       -- lifetime_spend accumulates (see the order_earn handler), so the
       -- drawer's figure and the roster's figure now mean the same thing.
       -- KNOWN RESIDUAL, recorded not chased: lifetime_spend is only reversed
       -- by a FULL refund, never reduced by a PARTIAL one. So on a customer
       -- who has had a partial refund this live figure can sit slightly below
       -- the stored lifetime_spend. Pre-existing; not introduced here.
       COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN subtotal ELSE 0 END), 0) AS revenue,
       AVG(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN subtotal ELSE NULL END) AS aov,
       MAX(placed_at) AS last_order_at,
       MIN(placed_at) AS first_order_at
       FROM retail_orders WHERE customer_id = ?`
  ).get(id);

  const points = tdb().prepare(
    // These buckets are ALLOWLISTS, which is the right shape — but they are
    // knowingly INCOMPLETE. Five of the nine live sources fall into no bucket:
    // 'migration' (+10,735 points), 'poll_vote' (+39), 'refund_reverse' (-8),
    // 'refund_redeem' (+20) and 'order_addon_earn' (+1). So "earned" excludes
    // every migrated point.
    // Left alone deliberately (2026-07-26): what "earned" should MEAN for a
    // point the customer carried over rather than won is a definitional
    // question, not a bug, and it touches the same migration machinery as an
    // open question elsewhere — so it gets decided there, once, not patched
    // here. An incomplete allowlist UNDERSTATES rather than inventing a
    // figure, which is the safe direction to be wrong in.
    `SELECT
       COALESCE(SUM(CASE WHEN delta > 0 AND source IN ('order_earn','topup_bonus') THEN delta ELSE 0 END), 0) AS earned,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'order_redeem'                 THEN -delta ELSE 0 END), 0) AS redeemed,
       COALESCE(SUM(CASE WHEN delta < 0 AND source = 'expiry'                       THEN -delta ELSE 0 END), 0) AS expired,
       COALESCE(SUM(CASE WHEN source = 'admin_adjust'                                THEN delta ELSE 0 END), 0) AS admin_adjust
       FROM retail_points_transactions WHERE customer_id = ?`
  ).get(id);

  // Points due to expire in the next 30 days. This sums the EARNING rows only;
  // redemptions are separate negative rows and are not matched against the lots
  // they consumed, so the raw figure can exceed what the customer still holds —
  // earn 500 expiring, spend 400, and the balance reads 100 beside "500
  // expiring soon".
  //
  // ⚠ THE MIN() BELOW IS A DISPLAY CLAMP, NOT LOT-TRACKING. It makes the
  // printed figure a true statement — "you will lose AT MOST this" — because
  // you cannot lose more than you hold. It is NOT accounting: it does not know
  // which lots a redemption actually consumed, so do not read it as, or build
  // on it as, a settled expiry number. Real FIFO lot-tracking is a feature in
  // its own right and deliberately not attempted here.
  const expiringSoonRaw = tdb().prepare(
    `SELECT COALESCE(SUM(delta), 0) AS pts
       FROM retail_points_transactions
      WHERE customer_id = ? AND delta > 0
        AND expires_at IS NOT NULL AND expired_at IS NULL
        AND expires_at <= datetime('now', '+30 days')`
  ).get(id).pts;
  const expiringSoon = Math.max(0, Math.min(Number(expiringSoonRaw) || 0, Number(customer.points_balance) || 0));

  const topup = tdb().prepare(
    `SELECT
       -- 🔴 ALLOWLIST, not an exclusion list. retail_topup_transactions is an
       -- overloaded ledger: besides real gateway top-ups it also holds
       -- 'order_redeem' (a NEGATIVE wallet-spend row), 'refund_reverse'
       -- clawbacks and 'admin_adjust' operator credits. This used to exclude
       -- admin_adjust ONLY, so wallet SPENDING was summed as money coming in
       -- and the figure could go negative — customer 233 read "¥-0.49 topped
       -- up" from -38.80 + 23.11 + 15.20.
       -- 🔴 IT WAS ALSO UNDERSTATING, NOT ONLY GOING NEGATIVE — and that is the
       -- real reason the SHAPE matters rather than the result. Customer 713's
       -- genuine ¥1,000 wechat top-up was reported as ¥18.60: a -1,000
       -- 'order_redeem' and a +18.60 'refund_reverse' were summed alongside it,
       -- off by ¥981.40. A negative total looks wrong and gets caught; a small
       -- plausible positive does not, and would have sat there indefinitely.
       -- Naming what counts is the same rule the signup-channel derivation
       -- follows: classify by inclusion, because a denylist silently accepts
       -- every method invented after it was written. Matches
       -- topupCashReceived() above, which already gets this right.
       COALESCE(SUM(CASE WHEN status='success' AND payment_method IN ('wechat','alipay') THEN amount       ELSE 0 END), 0) AS topup_total,
       COALESCE(SUM(CASE WHEN status='success' AND payment_method IN ('wechat','alipay') THEN bonus_points ELSE 0 END), 0) AS bonus_pts_total,
       COALESCE(SUM(CASE WHEN status='success' AND payment_method='admin_adjust'                  THEN amount       ELSE 0 END), 0) AS admin_adjust_total
       FROM retail_topup_transactions WHERE customer_id = ?`
  ).get(id);

  const vouchers = tdb().prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN used_at IS NULL     THEN 1 ELSE 0 END), 0) AS unused,
       COALESCE(SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS used
       FROM retail_customer_vouchers WHERE customer_id = ?`
  ).get(id);

  const reviews = tdb().prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS avg_rating
       FROM retail_reviews WHERE customer_id = ?`
  ).get(id);

  // datetime() around the COLUMN, not just around 'now'. retail_auth_tokens
  // stores expires_at as a raw .toISOString() (see issueToken) — '2026-10-16
  // T06:22:40.123Z', with a 'T' and a 'Z'. datetime('now') returns SQLite's
  // own shape, '2026-09-16 06:22:40', with a SPACE. Compared as text those
  // agree on the first ten characters and then hit 'T' (0x54) against ' '
  // (0x20), and 'T' sorts higher — so EVERY token that expired earlier the
  // same day read as still active and got counted. Only over-counted: the
  // gate itself (requireRetailAuth) already wraps the column, which is why a
  // dead token was never honoured, only advertised. Every other reader of
  // this column in this file wraps it; this was the one that didn't.
  const sessions = tdb().prepare(
    "SELECT COUNT(*) AS n FROM retail_auth_tokens WHERE customer_id = ? AND datetime(expires_at) > CURRENT_TIMESTAMP"
  ).get(id).n;

  const topItems = tdb().prepare(
    // Grouped by PRODUCT IDENTITY, not by the name text snapshotted on the
    // line — otherwise renaming a product splits one customer's history into
    // two rows. Reports already group by i.product_id; this is the last query
    // in the file that didn't.
    //
    // Channel lines (meituan / eleme) can carry a NULL product_id when the
    // item never matched a catalogue product. Grouping on product_id alone
    // would collapse EVERY unmatched line — across all channels and all
    // products — into one meaningless row, so those fall back to the name
    // snapshot as their identity. Matched lines: one row per product.
    // Unmatched lines: one row per distinct name, which is the best identity
    // that exists for them.
    //
    // SKU resolves order-line snapshot → live product, the same COALESCE
    // fallback the order drawer uses. MAX() only because a grouped select
    // needs an aggregate; within a group the value is the same. Eleme never
    // writes a SKU, so absent is normal and comes back as '' — never a dash.
    `SELECT MAX(i.product_id) AS product_id,
            COALESCE(NULLIF(MAX(p.name_en), ''), MAX(i.name_en)) AS name_en,
            COALESCE(NULLIF(MAX(p.name_cn), ''), MAX(i.name_cn)) AS name_cn,
            COALESCE(MAX(COALESCE(NULLIF(i.sku, ''), NULLIF(p.sku, ''))), '') AS sku,
            SUM(i.qty) AS qty, SUM(i.line_total) AS spend
       FROM retail_order_items i
       JOIN retail_orders o ON o.id = i.order_id
       LEFT JOIN store_products p ON p.id = i.product_id
      WHERE o.customer_id = ?
        AND o.status NOT IN ('cancelled','refunded','pending_payment')
      GROUP BY CASE WHEN i.product_id IS NULL
                    THEN 'n:' || COALESCE(i.name_en, '') || '|' || COALESCE(i.name_cn, '')
                    ELSE 'p:' || i.product_id END
      ORDER BY qty DESC
      LIMIT 5`
  ).all(id);

  const ordersByMonth = tdb().prepare(
    `SELECT strftime('%Y-%m', placed_at) AS month,
            COUNT(*) AS n,
            -- SUBTOTAL, same measure as stats.orders.revenue above, so the
            -- chart's bars sum to the headline figure instead of overshooting
            -- it by shipping and undershooting it by discounts.
            COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','refunded','pending_payment') THEN subtotal ELSE 0 END), 0) AS revenue
       FROM retail_orders
      WHERE customer_id = ?
        AND placed_at >= datetime('now', '-12 months')
      GROUP BY month
      ORDER BY month`
  ).all(id);

  const recentOrders = tdb().prepare(
    `SELECT id, order_no, status, total, placed_at AS created_at
       FROM retail_orders
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 10`
  ).all(id);

  const recentPoints = tdb().prepare(
    `SELECT id, delta, balance_after, source, order_id, note, created_at, expires_at
       FROM retail_points_transactions
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 20`
  ).all(id);

  const recentTopups = tdb().prepare(
    `SELECT id, amount, bonus_points, payment_method, status, created_at, paid_at
       FROM retail_topup_transactions
      WHERE customer_id = ?
      ORDER BY id DESC LIMIT 10`
  ).all(id);

  // Days since last order — handy churn signal.
  let daysSinceLastOrder = null;
  if (orders.last_order_at) {
    const ms = Date.now() - new Date(orders.last_order_at + 'Z').getTime();
    daysSinceLastOrder = Math.max(0, Math.floor(ms / 86400000));
  }

  // Affiliate context: this customer's own invites + their referrer (if any).
  const referrer = customer.referred_by_customer_id ? tdb().prepare(
    'SELECT id, nickname, phone, referral_code FROM retail_customers WHERE id = ?'
  ).get(customer.referred_by_customer_id) : null;
  const referralsByMe = tdb().prepare(
    `SELECT r.id, r.status, r.reward_amount, r.code_used, r.joined_at, r.rewarded_at,
            r.first_paid_order_id,
            ci.id AS invitee_id, ci.nickname AS invitee_nickname, ci.phone AS invitee_phone
       FROM retail_referrals r
       JOIN retail_customers ci ON ci.id = r.invitee_id
      WHERE r.referrer_id = ?
      ORDER BY r.id DESC
      LIMIT 50`
  ).all(id);
  const referralsAgg = tdb().prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status='ordered' THEN 1 ELSE 0 END), 0) AS converted,
            COALESCE(SUM(CASE WHEN status='ordered' THEN reward_amount ELSE 0 END), 0) AS earned
       FROM retail_referrals WHERE referrer_id = ?`
  ).get(id);

  // ── Diagnostics — what's happening on this customer's phone ──────────
  // device_last_seen: newest log row that carries a device snapshot (every
  // 'session' log does; an 'error' may too), so support sees the customer's
  // app version / phone / OS even when nothing crashed. recent_client_logs:
  // the last events (errors first-class) for "it's broken" triage. error_count
  // (last 7d) is a quick at-a-glance health signal. Table is self-healing
  // across tenants but guard anyway so an older tenant DB never 500s here.
  // diagUnavailable distinguishes "the query ran and found no errors" from
  // "the query could not run at all". Without it the catch below returns the
  // same zeros a healthy customer produces, and the drawer renders a failure
  // as the reassuring "no errors in 7 days" — an all-clear nobody checked.
  let deviceLastSeen = null, recentClientLogs = [], clientErrors7d = 0, diagUnavailable = false;
  try {
    deviceLastSeen = tdb().prepare(
      `SELECT app_version, platform, device_model, system, wx_version, lib_version, created_at
         FROM retail_client_logs
        WHERE customer_id = ? AND (app_version IS NOT NULL OR device_model IS NOT NULL)
        ORDER BY id DESC LIMIT 1`
    ).get(id) || null;
    recentClientLogs = tdb().prepare(
      `SELECT id, kind, page, message, stack, app_version, platform, device_model,
              system, wx_version, scene, extra, created_at
         FROM retail_client_logs
        WHERE customer_id = ?
        ORDER BY id DESC LIMIT 25`
    ).all(id);
    clientErrors7d = tdb().prepare(
      `SELECT COUNT(*) AS n FROM retail_client_logs
        WHERE customer_id = ? AND kind = 'error'
          AND created_at >= datetime('now','-7 days')`
    ).get(id).n;
  } catch (e) {
    // Table absent on a stale tenant DB, or the read failed. Say so — do NOT
    // let it fall through as an all-clear.
    diagUnavailable = true;
    console.warn('[retail-admin/customer diagnostics] unavailable:', e.message);
  }

  res.json({
    success: true,
    data: {
      customer,
      addresses,
      stats: {
        orders: { ...orders, days_since_last_order: daysSinceLastOrder },
        points: { ...points, expiring_30d: expiringSoon },
        topup: topup,
        vouchers,
        reviews,
        active_sessions: sessions
      },
      top_items: topItems,
      orders_by_month: ordersByMonth,
      recent_orders: recentOrders,
      recent_points: recentPoints,
      recent_topups: recentTopups,
      affiliate: {
        referral_code: customer.referral_code,
        affiliate_blocked: customer.affiliate_blocked ? 1 : 0,
        referred_by:   referrer,
        invites:       referralsByMe,
        summary:       referralsAgg,
        // Ongoing repeat-order share. The mode travels with the customer so
        // the drawer can show the control only where it means something — in
        // 'everyone' mode this customer already earns it and a per-person
        // switch there would be a control that changes nothing.
        lifetime_mode:           affiliateSettings().lifetimeMode,
        lifetime_eligible:       customer.lifetime_eligible ? 1 : 0,
        lifetime_eligible_since: customer.lifetime_eligible_since || null,
      },
      diagnostics: {
        device_last_seen: deviceLastSeen,
        recent_logs:      recentClientLogs,
        error_count_7d:   clientErrors7d,
        unavailable:      diagUnavailable,   // true = the read failed, NOT "all clear"
      }
    }
  });
});

// ── A customer's version history (decisions §279) ────────────────────────
// The customer record saves itself on both surfaces, so its way back lives
// here, in the tenant's own database. The snapshot is the fields the editors
// autosave, in a FIXED key order (lib/edit-history compares JSON strings).
// THE PHONE NUMBER IS LEFT OUT ON PURPOSE: changing it claims migration credit
// and reconciles sign-up vouchers (below), so it keeps its own Save button and
// no Undo or restore may ever write it.
function customerSnapshot(c) {
  return {
    nickname: c.nickname || '', email: c.email || '',
    gender: c.gender == null ? '' : String(c.gender), birthday: c.birthday ? String(c.birthday).slice(0, 10) : '',
    note: c.note || '', tags: c.tags || '',
  };
}

const CUSTOMER_HISTORY_NOTES = new Set(['undo', 'restore']);

router.get('/api/retail-admin/customers/:id/history', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  if (!tdb().prepare('SELECT 1 FROM retail_customers WHERE id = ?').get(id)) {
    return res.status(404).json({ success: false, error: 'not_found' });
  }
  let rows = [];
  try { rows = editHistory.list(tdb(), historyTenantId(), 'customer', id); } catch (e) { rows = []; }
  const versions = rows.map((r, i) => {
    const s = r.snapshot, prev = rows[i + 1] ? rows[i + 1].snapshot : null;
    const changed = prev ? ['nickname', 'email', 'gender', 'birthday', 'note', 'tags'].filter(k => s[k] !== prev[k]) : [];
    return { id: r.id, at: r.at, by: r.by, isBaseline: r.isBaseline, note: r.note, changed, snapshot: s };
  });
  res.json({ success: true, versions });
});

// Edit safe profile fields. Phone is loosely validated; openid/unionid are
// never editable from here (they are WeChat-issued and changing them breaks
// future logins).
router.patch('/api/retail-admin/customers/:id', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const updates = [];
  const params  = [];
  const changed = {};

  const setStr = (col, max = 100) => {
    if (b[col] === undefined) return;
    const v = b[col] === null || b[col] === '' ? null : String(b[col]).slice(0, max);
    updates.push(`${col} = ?`); params.push(v); changed[col] = v;
  };
  setStr('nickname', 60);

  // Email — SAME check the create endpoint applies. This edit path had none at
  // all, so anything typed here was stored verbatim: create rejected
  // "wang@" and edit accepted it, which meant the validation was really just a
  // speed bump you got past by creating first and editing after.
  if (b.email !== undefined) {
    const raw = b.email;
    // normEmail returns '' for anything malformed, and lowercases what it
    // accepts — so this path now stores the same normalised form create does,
    // where it used to keep whatever was typed. Length cap kept from the
    // setStr() this replaced.
    const v = (raw === null || raw === '') ? null : (normEmail(raw).slice(0, 120) || '');
    if (raw && !v) return res.status(400).json({ success: false, error: 'bad_email' });
    updates.push('email = ?'); params.push(v); changed.email = v;
  }

  if (b.phone !== undefined) {
    const v = b.phone === null || b.phone === '' ? null : String(b.phone).replace(/\s+/g, '').slice(0, 20);
    if (v && !/^\+?[0-9]{7,15}$/.test(v)) {
      return res.status(400).json({ success: false, error: 'bad_phone' });
    }
    // 🔴 DUPLICATE-PHONE CHECK. Create dedupes by phone (it links to the
    // existing record instead of making a second one) — but this endpoint had
    // no such check, so create-then-edit walked straight around it and left two
    // customers holding one number. Everything keyed on phone then becomes
    // ambiguous: migration credit, signup vouchers, and create's own reuse
    // lookup, which takes `ORDER BY id LIMIT 1` and would silently pick one.
    // ⚠ ONLY FIRES WHEN THE NUMBER IS ACTUALLY CHANGING. 17 live customers
    // already share 4 numbers between them (legacy: 8 on one), from before any
    // check existed. Validating on every save would 409 those records for good
    // — an operator could not fix a typo in the NAME of a customer caught in a
    // pre-existing duplicate. The rule is "don't create NEW collisions", not
    // "refuse to touch old ones". Cleaning the existing 4 up is a data job, not
    // this endpoint's.
    //
    // The 4 groups as at 2026-07-26, so the next survey doesn't re-chase them:
    //   15360475622 → ids 76,224,239,332,352,360,382,721 — EIGHT records, and
    //                 ALSO NOT a real duplicate: all eight are test accounts
    //                 from ONE Android emulator (every auth token reads
    //                 "AOSP on Pixel"), created on seven days across six weeks.
    //                 All have zero orders, zero spend, zero addresses and no
    //                 email; six carry raw `wxid_*` nicknames (6 of only 10 in
    //                 the whole DB) and one is literally `wx_test11111`. Each
    //                 earned exactly 1 point from a poll_vote and never
    //                 returned — together they are 7 of the 39 poll votes on
    //                 record. Leave them: deleting touches poll votes and a
    //                 (zero-value) migration credit for no benefit.
    //                 ⚠ A survey that finds this cluster and chases it is
    //                 chasing a test. Investigated 2026-07-26.
    //   18613159912 → ids 57,64,233 — NOT a real duplicate: 233 is the `asher`
    //                 test account and 57/64 are the two `_reset_` archive rows
    //                 from that same test. Test data; leave it.
    //   18924071446 → ids 52,58,472
    //   19927404435 → ids 320,383,410
    if (v && v !== c.phone) {
      const clash = tdb().prepare(
        'SELECT id, nickname FROM retail_customers WHERE phone = ? AND id != ? ORDER BY id LIMIT 1'
      ).get(v, id);
      if (clash) {
        return res.status(409).json({
          success: false,
          error: 'phone_taken',
          customer_id: clash.id,
          nickname: clash.nickname || null,
        });
      }
    }
    updates.push('phone = ?'); params.push(v); changed.phone = v;
  }
  if (b.gender !== undefined) {
    const v = b.gender === null || b.gender === '' ? null : parseInt(b.gender, 10);
    if (v !== null && ![0, 1, 2].includes(v)) {
      return res.status(400).json({ success: false, error: 'bad_gender' });
    }
    updates.push('gender = ?'); params.push(v); changed.gender = v;
  }
  if (b.birthday !== undefined) {
    const v = b.birthday === null || b.birthday === '' ? null : String(b.birthday).slice(0, 10);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(400).json({ success: false, error: 'bad_birthday' });
    }
    updates.push('birthday = ?'); params.push(v); changed.birthday = v;
  }
  // ── The note and the tags (audit E-02) ───────────────────────────────────
  // A note is free text the operator types about a person — "allergic to nuts",
  // "always calls before collecting", "wholesale, invoice monthly". 2000
  // characters, the same ceiling an order's staff note takes. An empty string
  // clears it, which is a legitimate edit.
  if (b.note !== undefined) {
    if (b.note !== null && typeof b.note !== 'string') {
      return res.status(400).json({ success: false, error: 'note_invalid', message: 'A note must be text.' });
    }
    const v = (b.note == null || String(b.note).trim() === '') ? null : String(b.note).slice(0, 2000);
    updates.push('note = ?'); params.push(v); changed.note = v;
  }
  // Tags arrive as either an array or a comma-separated string; both are
  // normalised to ONE stored shape — comma-separated, trimmed, lowercased,
  // de-duplicated, no empties. Lowercased because "VIP" and "vip" are the same
  // mark to the person typing them and two different rows to a LIKE, and the
  // whole value of a tag is that it finds the group again.
  if (b.tags !== undefined) {
    const raw = Array.isArray(b.tags) ? b.tags : String(b.tags == null ? '' : b.tags).split(',');
    const seen = new Set();
    const list = [];
    for (const t of raw) {
      // Commas are the separator, so a tag cannot contain one — stripped rather
      // than rejected, because the operator typing "vip, wholesale" meant two
      // tags and an error there would be pedantry.
      const clean = String(t == null ? '' : t).replace(/,/g, ' ').trim().toLowerCase().slice(0, 40);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean); list.push(clean);
      if (list.length >= 20) break;     // a bounded list stays a list
    }
    const v = list.length ? list.join(',') : null;
    updates.push('tags = ?'); params.push(v); changed.tags = v;
  }

  // tier_key is intentionally not editable here — it's auto-derived from
  // lifetime_spend (see tierFromSpend / reconcileTier). Any tier_key in the
  // payload is silently ignored so older admin builds don't error.

  if (!updates.length) return res.json({ success: true, changed: {} });

  // History is best-effort: failing to record must never fail the save.
  const histTid = historyTenantId();
  try { editHistory.before(tdb(), histTid, 'customer', id, customerSnapshot(c)); }
  catch (e) { console.error('[customer history before]', e.message); }
  params.push(id);
  tdb().prepare(`UPDATE retail_customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  try {
    const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(id);
    const note = CUSTOMER_HISTORY_NOTES.has(b.history_note) ? b.history_note : null;
    if (fresh) editHistory.after(tdb(), histTid, 'customer', id, customerSnapshot(fresh),
      { id: req.user && req.user.id, name: req.user && req.user.username }, { note });
  } catch (e) { console.error('[customer history after]', e.message); }
  // If an admin set/changed this customer's phone, apply any unclaimed OUT1N
  // migration credit for it. Best-effort.
  if (Object.prototype.hasOwnProperty.call(changed, 'phone')) {
    try { claimMigrationCredit(id); }
    catch (e) { console.warn('[retail-admin/customer] migration claim failed:', e.message); }
    try { reconcileSignupVouchers(id); }
    catch (e) { console.warn('[retail-admin/customer] signup voucher reconcile failed:', e.message); }
  }
  logActivity(req.user.id, req.user.username, 'update', 'retail_customer', id, changed, req.ip);
  res.json({ success: true, changed });
});

// Block / unblock — toggling `is_blocked`. Blocking does not invalidate
// existing tokens; the caller should hit /force-logout if they want that too.
router.post('/api/retail-admin/customers/:id/block', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  const r = tdb().prepare('UPDATE retail_customers SET is_blocked = 1 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'block', 'retail_customer', id, { reason }, req.ip);
  res.json({ success: true });
});

router.post('/api/retail-admin/customers/:id/unblock', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('UPDATE retail_customers SET is_blocked = 0 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'unblock', 'retail_customer', id, {}, req.ip);
  res.json({ success: true });
});

// Affiliate-only opt-out — toggles `affiliate_blocked`. Unlike block/unblock
// above, the customer's account is untouched: they can still log in, order,
// and (if referred by someone else) redeem a friend's code. This only stops
// THEM acting as a referrer — see addColumn('retail_customers',
// 'affiliate_blocked') in database.js for the full contract (their code is
// refused on new applies, and no further referral or lifetime-share payout
// reaches them; nothing already paid is clawed back).
router.post('/api/retail-admin/customers/:id/affiliate-block', requireRetailAdmin, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  const r = tdb().prepare('UPDATE retail_customers SET affiliate_blocked = 1 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'affiliate_block', 'retail_customer', id, { reason }, req.ip);
  res.json({ success: true });
});

router.post('/api/retail-admin/customers/:id/affiliate-unblock', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('UPDATE retail_customers SET affiliate_blocked = 0 WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'affiliate_unblock', 'retail_customer', id, {}, req.ip);
  res.json({ success: true });
});

// Revoke every active auth token for the customer — forces re-login on
// next mini-app open.
router.post('/api/retail-admin/customers/:id/force-logout', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c  = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const r = tdb().prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(id);
  logActivity(req.user.id, req.user.username, 'force_logout', 'retail_customer', id, { revoked: r.changes }, req.ip);
  res.json({ success: true, revoked: r.changes });
});

// TESTING ONLY — "Reset to a new user". Lets staff (really: us, while QA-ing
// the onboarding flow) become a brand-new customer on their own phone without
// a second WeChat account. We DON'T delete the row (several child tables are
// ON DELETE RESTRICT, and we want the old data preserved): instead we archive
// the openid by prefixing it, so the next silent login can't match it and
// falls through to the INSERT path in POST /api/retail/auth → a fresh customer
// is created with the real openid again. Tokens are revoked too so the cached
// session on the device dies and re-login fires immediately.
router.post('/api/retail-admin/customers/:id/reset-test', requireRetailAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c  = tdb().prepare('SELECT id, openid FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  if (String(c.openid || '').startsWith('_reset_')) {
    return res.status(409).json({ success: false, error: 'already_reset' });
  }
  const archived = `_reset_${Date.now()}_${c.openid}`.slice(0, 256);
  // Returns the revoked-token count out of the transaction — the response
  // reports it, and it is only true once the DELETE committed.
  const revoked = await withTransaction(tdb(), (tx) => {
    tx.prepare('UPDATE retail_customers SET openid = ? WHERE id = ?').run(archived, id);
    const r = tx.prepare('DELETE FROM retail_auth_tokens WHERE customer_id = ?').run(id);
    return r.changes;
  });
  logActivity(req.user.id, req.user.username, 'reset_test_customer', 'retail_customer', id, { archived_openid: archived, revoked }, req.ip);
  res.json({ success: true, revoked });
});

// Manual points adjustment — writes an `admin_adjust` ledger row and
// updates the cached balance atomically. Reason is required so the audit
// trail is meaningful.
router.post('/api/retail-admin/customers/:id/points-adjust', requireRetailAdmin, express.json(), (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const delta  = parseInt(req.body?.delta, 10);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  const MAX_POINTS_ADJUST = 10000000;  // sanity cap: ±10M points per adjustment
  if (!id || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > MAX_POINTS_ADJUST) {
    return res.status(400).json({ success: false, error: 'bad_delta' });
  }
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });

  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  // Atomic, race-safe adjust: the balance is incremented and floor-checked in
  // a SINGLE conditional UPDATE (not read-then-write), so two concurrent
  // adjustments can't both pass a stale "would_go_negative" check or clobber
  // each other's write.
  let balanceAfter;
  try {
    const tx = tdb().transaction(() => {
      const upd = tdb().prepare(
        'UPDATE retail_customers SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ? AND COALESCE(points_balance, 0) + ? >= 0'
      ).run(delta, id, delta);
      if (upd.changes !== 1) { const e = new Error('would_go_negative'); e.code = 'WOULD_GO_NEGATIVE'; throw e; }
      balanceAfter = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, note)
         VALUES (?, ?, ?, 'admin_adjust', ?)`
      ).run(id, delta, balanceAfter, `[${req.user.username}] ${reason}`);
    });
    tx();
  } catch (e) {
    if (e.code === 'WOULD_GO_NEGATIVE') return res.status(409).json({ success: false, error: 'would_go_negative' });
    throw e;
  }
  logActivity(req.user.id, req.user.username, 'points_adjust', 'retail_customer', id, { delta, reason, balance_after: balanceAfter }, req.ip);
  res.json({ success: true, balance_after: balanceAfter });
});

// Manual wallet adjustment — writes a `payment_method='admin_adjust'` row
// to retail_topup_transactions (amount may be negative for clawback) and
// updates the cached balance atomically.
router.post('/api/retail-admin/customers/:id/wallet-adjust', requireRetailAdmin, express.json(), (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const deltaRaw = Number(req.body?.delta);
  const reason   = String(req.body?.reason || '').trim().slice(0, 200);
  const MAX_WALLET_ADJUST = 1000000;  // sanity cap: ±¥1,000,000 per adjustment
  if (!id || !Number.isFinite(deltaRaw) || deltaRaw === 0 || Math.abs(deltaRaw) > MAX_WALLET_ADJUST) {
    return res.status(400).json({ success: false, error: 'bad_delta' });
  }
  if (!reason) return res.status(400).json({ success: false, error: 'reason_required' });
  const delta = Math.round(deltaRaw * 100) / 100;  // store to cent precision
  if (delta === 0) return res.status(400).json({ success: false, error: 'bad_delta' });

  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });

  // Atomic, race-safe adjust: balance is incremented, rounded to cents, and
  // floor-checked in ONE conditional UPDATE, so concurrent adjustments can't
  // both pass a stale negative check or lose a write.
  let balanceAfter;
  try {
    const tx = tdb().transaction(() => {
      const upd = tdb().prepare(
        'UPDATE retail_customers SET balance = ROUND(COALESCE(balance, 0) + ?, 2) WHERE id = ? AND ROUND(COALESCE(balance, 0) + ?, 2) >= 0'
      ).run(delta, id, delta);
      if (upd.changes !== 1) { const e = new Error('would_go_negative'); e.code = 'WOULD_GO_NEGATIVE'; throw e; }
      balanceAfter = tdb().prepare('SELECT balance FROM retail_customers WHERE id = ?').get(id).balance;
      tdb().prepare(
        `INSERT INTO retail_topup_transactions
           (customer_id, amount, bonus_points, payment_method, status, paid_at, out_trade_no, raw_callback_json)
         VALUES (?, ?, 0, 'admin_adjust', 'success', CURRENT_TIMESTAMP, ?, ?)`
      ).run(id, delta, `adminadj:${req.user.id}:${Date.now()}`, JSON.stringify({ reason, by: req.user.username }));
    });
    tx();
  } catch (e) {
    if (e.code === 'WOULD_GO_NEGATIVE') return res.status(409).json({ success: false, error: 'would_go_negative' });
    throw e;
  }
  logActivity(req.user.id, req.user.username, 'wallet_adjust', 'retail_customer', id, { delta, reason, balance_after: balanceAfter }, req.ip);
  res.json({ success: true, balance_after: balanceAfter });
});

// One customer's saved addresses, and NOTHING ELSE.
//
// GET /api/retail-admin/customers/:id already returns these rows — but it also
// stamps seen_at the first time anyone opens it, and the New-order wizard's
// address prefill fires on every customer pick. Reading the profile route there
// would have marked customers as read on the Customers page as a side effect of
// starting an order, which is not what that stamp is supposed to mean: it says
// a human looked at the record, not that someone typed their name into a search
// box. It is also a page-sized read — orders by month, points, vouchers,
// reviews, sessions, diagnostics — to fill in three address fields.
//
// So: the same rows, the same ORDER BY, the same envelope key, and NO WRITE OF
// ANY KIND — no seen_at, no activity log, nothing. Anything that needs to
// record having looked at a customer belongs on the profile route, not here.
router.get('/api/retail-admin/customers/:id/addresses', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const addresses = tdb().prepare(
    'SELECT * FROM retail_customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id DESC'
  ).all(id);
  // Same key the profile route puts them under, so a caller reads
  // j.data.addresses without needing to know which route answered.
  res.json({ success: true, data: { addresses } });
});

// Address admin — create / edit / delete a customer's saved addresses.
// Mirrors the customer-side routes at /api/retail/addresses but scoped by
// path-param customer_id and gated by retail-admin auth.
router.post('/api/retail-admin/customers/:id/addresses', requireRetailAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  const a = normalizeChinaAddress(req.body || {});
  // Trimmed — see the customer-facing POST above; a whitespace-only field is an
  // empty one, whichever side of the admin boundary it was typed on.
  if (!String(a.recipient_name || '').trim() || !a.phone || !a.address) {
    return res.status(400).json({ success: false, error: 'missing_required' });
  }
  // Returns the new address id out of the transaction — the geocode kick-off,
  // the activity log and the response row all need it committed first.
  const newId = await withTransaction(tdb(), (tx) => {
    if (a.is_default) {
      tx.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    const info = tx.prepare(
      `INSERT INTO retail_customer_addresses
         (customer_id, recipient_name, phone, province, city, district,
          address, detail, postal_code, is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      String(a.recipient_name).slice(0, 60),
      String(a.phone).slice(0, 20),
      a.province ? String(a.province).slice(0, 40) : null,
      a.city     ? String(a.city).slice(0, 40)     : null,
      a.district ? String(a.district).slice(0, 40) : null,
      String(a.address).slice(0, 200),
      a.detail      ? String(a.detail).slice(0, 200)   : null,
      a.postal_code ? String(a.postal_code).slice(0, 16) : null,
      a.is_default ? 1 : 0
    );
    return info.lastInsertRowid;
  });
  // Same pipeline the customer-facing POST runs. Without it a staff-entered
  // address never got coordinates at all — so it could never be routed by real
  // distance, and its English text was never converted, leaving the conversion
  // to happen (or not) at waybill time.
  geocodeAddressAsync(newId, a);
  logActivity(req.user.id, req.user.username, 'create', 'retail_customer_address', newId, { customer_id: id }, req.ip);
  const row = tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(newId);
  res.json({ success: true, data: row });
});

router.put('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, express.json(), async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const existing = tdb().prepare(
    `SELECT id, province, city, district, address, detail, lat, lng, geo_source
       FROM retail_customer_addresses WHERE id = ? AND customer_id = ?`
  ).get(addrId, id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const incoming = req.body || {};
  const a = (incoming.province || incoming.city || incoming.district || incoming.address)
    ? normalizeChinaAddress(incoming)
    : incoming;
  // Same partial-update gap as the customer-facing PUT: a phone-only correction
  // skips normalizeChinaAddress entirely, so normalize where both branches land.
  if ('phone' in incoming) a.phone = phoneCn.normalizeForStorage(incoming.phone);
  // Staff correcting an address must not leave the old coordinates behind. They
  // describe the place the correction is moving AWAY from, and the next order
  // from this row would snapshot them straight onto a waybill.
  const adminTextChanged = addressPin.addressTextChanged(a, existing);
  // A map-picked pin is the exception — it is a location, not a description of
  // one, so a text fix doesn't invalidate it. Keep it, and mark the row so the
  // pin diagnostic surfaces it for a human to confirm.
  const adminKeepsPin = addressPin.keepsPinThroughTextEdit(existing);
  // Every statement runs on `tx`, the handle withTransaction hands in — §24.
  await withTransaction(tdb(), (tx) => {
    if (a.is_default) {
      tx.prepare('UPDATE retail_customer_addresses SET is_default = 0 WHERE customer_id = ?').run(id);
    }
    tx.prepare(
      `UPDATE retail_customer_addresses
          SET recipient_name = COALESCE(?, recipient_name),
              phone          = COALESCE(?, phone),
              province       = COALESCE(?, province),
              city           = COALESCE(?, city),
              district       = COALESCE(?, district),
              address        = COALESCE(?, address),
              detail         = COALESCE(?, detail),
              postal_code    = COALESCE(?, postal_code),
              is_default     = COALESCE(?, is_default),
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(
      a.recipient_name == null ? null : String(a.recipient_name).slice(0, 60),
      a.phone          == null ? null : String(a.phone).slice(0, 20),
      a.province       === undefined ? null : (a.province ? String(a.province).slice(0, 40) : ''),
      a.city           === undefined ? null : (a.city     ? String(a.city).slice(0, 40)     : ''),
      a.district       === undefined ? null : (a.district ? String(a.district).slice(0, 40) : ''),
      a.address        == null ? null : String(a.address).slice(0, 200),
      a.detail         === undefined ? null : (a.detail      ? String(a.detail).slice(0, 200)   : ''),
      a.postal_code    === undefined ? null : (a.postal_code ? String(a.postal_code).slice(0, 16) : ''),
      a.is_default     == null ? null : (a.is_default ? 1 : 0),
      addrId
    );
    if (adminTextChanged && !adminKeepsPin) {
      tx.prepare(
        `UPDATE retail_customer_addresses
            SET lat = NULL, lng = NULL, geo_source = NULL, geo_precision = NULL, geocoded_at = NULL
          WHERE id = ?`
      ).run(addrId);
    } else if (adminTextChanged && adminKeepsPin) {
      tx.prepare(
        `UPDATE retail_customer_addresses SET geo_precision = 'review' WHERE id = ?`
      ).run(addrId);
    }
  });
  if (adminTextChanged && !adminKeepsPin) {
    const merged = tdb().prepare(
      'SELECT province, city, district, address, detail FROM retail_customer_addresses WHERE id = ?'
    ).get(addrId);
    if (merged) geocodeAddressAsync(addrId, merged);
  }
  logActivity(req.user.id, req.user.username, 'update', 'retail_customer_address', addrId, { customer_id: id }, req.ip);
  const row = tdb().prepare(`SELECT ${ADDRESS_PUBLIC_COLS} FROM retail_customer_addresses WHERE id = ?`).get(addrId);
  res.json({ success: true, data: row });
});

router.delete('/api/retail-admin/customers/:id/addresses/:addrId', requireRetailAdmin, (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const addrId = parseInt(req.params.addrId, 10);
  const r = tdb().prepare('DELETE FROM retail_customer_addresses WHERE id = ? AND customer_id = ?').run(addrId, id);
  if (!r.changes) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_customer_address', addrId, { customer_id: id }, req.ip);
  res.json({ success: true });
});

// Reissue a customer's referral code (e.g., admin wants a new one after a
// public leak). Old code is dropped; existing referrals keep their
// code_used snapshot so history is unaffected.
router.post('/api/retail-admin/customers/:id/referral-code', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = tdb().prepare('SELECT id FROM retail_customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ success: false, error: 'not_found' });
  tdb().prepare('UPDATE retail_customers SET referral_code = NULL WHERE id = ?').run(id);
  const code = ensureReferralCode(id);
  logActivity(req.user.id, req.user.username, 'referral_code_reissue', 'retail_customer', id, { code }, req.ip);
  res.json({ success: true, data: { code } });
});

// Operator starts a direct-message thread with a specific customer. Reuses the
// feedback thread tables: the root row is the operator's opener (initiated_by
// 'admin', kind 'message') and the customer replies in-app exactly like a bug
// report. Drops the same in-app notification a reply does so the customer sees
// it next time they open the mini app / web shop. Returns the new thread id so
// the admin UI can open it straight into the existing thread drawer.
router.post('/api/retail-admin/customers/:id/message', requireRetailAdmin, express.json(), (req, res) => {
  const customerId = parseInt(req.params.id, 10);
  const body = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!customerId) return res.status(400).json({ success: false, error: 'customer_required' });
  if (!body)       return res.status(400).json({ success: false, error: 'message_required' });
  const customer = tdb().prepare('SELECT id, nickname FROM retail_customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ success: false, error: 'customer_not_found' });
  const authorName = (req.user && (req.user.display_name || req.user.username)) || null;
  const name = customer.nickname || ('#' + customer.id);
  try {
    // last_admin_msg_at + admin_read_at both stamped now: the operator just
    // wrote and read it, so the thread doesn't show as "needs reply" to staff.
    const info = tdb().prepare(
      `INSERT INTO retail_feedback
         (customer_id, customer_name, message, page_context, initiated_by, root_author_name, kind,
          last_admin_msg_at, admin_read_at)
       VALUES (?, ?, ?, 'admin-message', 'admin', ?, 'message', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(customerId, name, body, authorName);
    const id = info.lastInsertRowid;
    const snippet = body.length > 120 ? body.slice(0, 119) + '…' : body;
    notifyCustomer(customerId, {
      category: 'feedback',
      type: 'direct_message',
      title_en: 'New message',
      title_cn: '新消息',
      body_en: snippet,
      body_cn: snippet,
      ref_type: 'feedback',
      ref_id: id,
    });
    res.json({ success: true, data: { id } });
  } catch (e) {
    console.error('[retail-admin/customers message] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

router.get('/api/retail/customer', requireRetailAuth, (req, res) => {
  // Sweep expired earn batches lazily so the balance the customer sees
  // matches what they'd actually be able to redeem. Cheap when there's
  // nothing due, idempotent when called repeatedly.
  sweepExpiredPoints(req.customer.id);
  const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
  // same_city + local_run ride along (see stampSameCity) — the web storefront reads its
  // address book from this payload, and its shop grid needs the same pre-order
  // verdict the mini app gets from GET /api/retail/addresses.
  const addresses = stampSameCity(tdb().prepare(
    `SELECT id, recipient_name, phone, province, city, district, address, detail,
            postal_code, is_default, created_at, updated_at
       FROM retail_customer_addresses
      WHERE customer_id = ?
      ORDER BY is_default DESC, updated_at DESC`
  ).all(req.customer.id));
  const favoriteCount = tdb().prepare(
    'SELECT COUNT(*) AS n FROM retail_customer_favorites WHERE customer_id = ?'
  ).get(req.customer.id).n;
  res.json({
    success: true,
    // point_value_yuan (= 1 / points.redeemRate) lets the wallet show what the
    // points balance is worth at the real redeem rate, not a hardcoded ¥0.10.
    data: {
      ...publicCustomer(fresh), addresses, favorite_count: favoriteCount,
      point_value_yuan: 1 / pointsRedeemRate(),
    },
  });
});

// Customer profile update. Used by the WeChat-binding flow on the Me page:
// the user picks an avatar via <button open-type="chooseAvatar"> and types
// their nickname via <input type="nickname"> (both pull real WeChat data
// when granted).
//
// SECURITY: this endpoint deliberately does NOT accept `phone`. The phone is
// the key that unlocks OUT1N migration credit (balance + points), so it must
// only ever be set via the WeChat-verified getPhoneNumber path below
// (POST /api/retail/phone), which proves the caller actually owns the number.
// Accepting a free-form phone here would let any logged-in customer set a
// victim's number and steal their migrated balance/points.
router.patch('/api/retail/customer', requireRetailAuth, express.json(), async (req, res) => {
  const { nickname, avatar_url } = req.body || {};
  const sets = [];
  const params = [];
  if (typeof nickname === 'string') {
    const trimmed = nickname.trim().slice(0, 40);
    // A nickname is published content — it sits on the Me page and on every
    // review this customer writes — so WeChat requires it be checked.
    if (trimmed && await isRiskyText(req.customer, trimmed, wxSec.SCENE.PROFILE)) {
      return refuseContent(res);
    }
    sets.push('nickname = ?'); params.push(trimmed || null);
  }
  if (typeof avatar_url === 'string') {
    // The picture was already submitted to WeChat when it was uploaded. If the
    // verdict has landed and it failed, refuse to make it anyone's face.
    const mediaId = parseInt(String(avatar_url).split('/').pop(), 10);
    if (mediaId) {
      const row = tdb().prepare('SELECT sec_status FROM retail_media WHERE id = ?').get(mediaId);
      if (row && row.sec_status === 'risky') return refuseContent(res);
    }
    sets.push('avatar_url = ?'); params.push(avatar_url.slice(0, 512) || null);
  }
  if (!sets.length) return res.status(400).json({ success: false, error: 'no_fields' });
  params.push(req.customer.id);
  tdb().prepare(`UPDATE retail_customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const fresh = tdb().prepare('SELECT * FROM retail_customers WHERE id = ?').get(req.customer.id);
  res.json({ success: true, data: publicCustomer(fresh) });
});

// Find (or create) the canonical "avatars" media folder and return its id.
// Customer avatar uploads are auto-filed here so they stay out of Unsorted.
// Case-insensitive match reuses a hand-made "Avatars" folder if one exists.
function ensureAvatarsFolderId() {
  try {
    const existing = tdb().prepare(
      `SELECT id FROM retail_media_folders WHERE LOWER(name) = 'avatars' ORDER BY id ASC LIMIT 1`
    ).get();
    if (existing) return existing.id;
    const info = tdb().prepare(
      `INSERT INTO retail_media_folders (name) VALUES ('avatars')`
    ).run();
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[retail/avatar] ensureAvatarsFolderId failed:', e.message);
    return null; // fall back to Unsorted rather than blocking the upload
  }
}

// Customer-facing avatar upload. Body is JSON: { data: "data:image/...;base64,..." }.
// Reason: wx.uploadFile has its own AppID whitelist that customers can't
// control on the legacy preview AppID — sending base64 over wx.request
// reuses the request whitelist, which IS already provisioned.
router.post('/api/retail/customer/avatar', requireRetailAuth, express.json({ limit: '8mb' }), async (req, res) => {
  const { data } = req.body || {};
  if (typeof data !== 'string' || !data.startsWith('data:image/')) {
    return res.status(400).json({ success: false, error: 'bad_data_uri' });
  }
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return res.status(400).json({ success: false, error: 'bad_data_uri' });
  const sizeBytes = Math.floor(m[2].length * 3 / 4);
  if (sizeBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'too_large' });
  }
  // Verify the bytes are a real raster image (rejects SVG / spoofed mime) and
  // pin the stored mime + data URI to the sniffed type, not the client label.
  let mime, normData;
  try {
    const buf = Buffer.from(m[2], 'base64');
    mime = sniffImageMime(buf);
    if (!mime) return res.status(400).json({ success: false, error: 'bad_data_uri' });
    normData = `data:${mime};base64,${m[2]}`;
  } catch { return res.status(400).json({ success: false, error: 'bad_data_uri' }); }
  try {
    // File customer avatars into a dedicated "avatars" folder so they don't
    // clutter Unsorted (auto-created on first upload).
    const folderId = ensureAvatarsFolderId();
    const info = tdb().prepare(
      `INSERT INTO retail_media (filename, mime_type, size_bytes, data, uploaded_by, folder_id)
       VALUES (?, ?, ?, ?, NULL, ?)`
    ).run('avatar', mime, sizeBytes, normData, folderId);
    // Hand the stored picture to WeChat's content check before it becomes
    // anyone's face. The row has to exist first — WeChat fetches it over HTTP
    // from the public media URL. `sec_status` tells the app whether to wait.
    const secStatus = await submitImageSecCheck(info.lastInsertRowid, req.customer, wxSec.SCENE.PROFILE);
    res.json({
      success: true,
      data: { url: `/api/retail/media/${info.lastInsertRowid}`, sec_status: secStatus },
    });
  } catch (e) {
    console.error('[retail/avatar] insert failed:', e.message);
    res.status(500).json({ success: false, error: 'db_insert_failed' });
  }
});

module.exports = function mountCustomers(d) {
  for (const k of NEEDS) {
    if (typeof d[k] !== 'function') throw new Error('routes/retail/customers: ' + k + ' was not handed in');
  }
  Object.assign(deps, d);
  return router;
};
