#!/usr/bin/env node
/**
 * Offline self-test for the two Inbox fires on "Needs you" — a customer review
 * nobody has answered, and a feedback thread waiting on a reply.
 *
 *   node scripts/test_inbox_fires.js
 *
 * The hole they close: a review or a bug report landed, the Inbox badge lit for
 * whoever happened to be looking at the topbar, and the front door of the
 * backend said nothing. Every other queue in the business — refunds, delivery,
 * invoices, restock — is gathered on one card, and the two queues where a
 * CUSTOMER is waiting on words were the two the card did not carry.
 *
 * No network, no keys, no browser. Both halves read the SHIPPED source:
 *   • the server half slices the real SQL out of routes/retail.js and runs it
 *     against in-memory tables built from database.js, so a change to either
 *     predicate moves these tests;
 *   • the client half slices the real pushes out of 03-dashboard.js and
 *     evaluates them against stubs — same technique as
 *     scripts/test_payment_mismatch.js.
 *
 * What it locks down:
 *   1. THE REVIEWS QUEUE IS THE PAGE'S QUEUE — the fire counts exactly what the
 *      Reviews page's own "Needs reply" chip counts. Seeded reviews are in
 *      neither (nobody is waiting on the other end of one); HIDDEN reviews are
 *      in both, because the page counts them and a fire that is quietly smaller
 *      than the list it opens is worse than no fire.
 *   2. THE FEEDBACK GUARD — a thread staff started themselves, which the
 *      customer has not answered, is NOT a fire. Its admin_read_at is null
 *      until somebody re-opens it, so the list's bare needs_reply rule would
 *      raise a fire about the operator's own unanswered message.
 *   3. THE CLOCK — both queues age from the CUSTOMER's turn: when the review
 *      was posted, when they last wrote in the thread. Never from the root of a
 *      thread staff opened, and never from a reply we sent.
 *   4. THE ROW'S WORDS — the reviews row names how many are low-rated, and says
 *      nothing at all when none of them are.
 *   5. THE GATES — capability (can this operator write the reply?) and feature
 *      (is this shop still running that queue?), each proven to silence the row.
 *   6. THE DOORS — the Inbox dropdown's own buttons, clicked. Not dashJumpTab:
 *      neither queue has had a rail button since Inbox moved to the topbar.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const ROOT = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const DASH_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '03-dashboard.js'), 'utf8');
const DATABASE_JS = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');

// ── Slicing the shipped source ────────────────────────────────────────────
// Every reader asserts it found its anchor, so a rename produces "not found in
// the shipped file" rather than a quietly-passing test.

/** A statement: from `anchor` to the first `;` that is OUTSIDE a string. */
function sliceStatement(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  let quote = null;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === ';') return src.slice(start, j + 1);
  }
  throw new Error(`no statement terminator after ${anchor}`);
}

/** A braced block (function or `if`): from `anchor` to its matching `}`. */
function sliceBlock(src, anchor, { from } = {}) {
  const base = from ? src.indexOf(from) : 0;
  assert.notStrictEqual(base, -1, `anchor comment not found: ${from}`);
  const start = src.indexOf(anchor, base);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

/** The first template literal after `anchor`, returned WITH its backticks. */
function sliceTemplate(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = src.indexOf('`', start + anchor.length);
  assert.notStrictEqual(open, -1, `no template literal after ${anchor}`);
  const close = src.indexOf('`', open + 1);
  assert.notStrictEqual(close, -1, `unterminated template literal after ${anchor}`);
  return src.slice(open, close + 1);
}

// ── The predicates, lifted out of routes/retail.js ────────────────────────
// EVALUATED, not pattern-matched: what runs below is the string the route hands
// to SQLite. The ONE shared clause (REVIEW_WAITING_SQL) plus every query that
// wraps it, so a change to the clause moves all of them at once — which is the
// property this whole file exists to hold.
const WAITING_SRC = sliceStatement(RETAIL_JS, 'const REVIEW_WAITING_SQL =');
const RV_OPEN_SRC = sliceStatement(RETAIL_JS, 'const RV_OPEN =');
const rvSql = (anchor) => vm.runInNewContext(
  `(() => { ${WAITING_SRC} ${RV_OPEN_SRC} return ${sliceTemplate(RETAIL_JS, anchor)}; })()`, {});
// The Reviews page's own two queries, read the same way — the whole point of the
// shared clause is that these are the SAME string, and only a test can hold that.
const pageSql = (anchor) => vm.runInNewContext(
  `(() => { ${WAITING_SRC} return ${sliceTemplate(RETAIL_JS, anchor)}; })()`, {});
const PAGE_SUMMARY_SQL = pageSql('const q1 = tdb().prepare(');
const PAGE_LOW_SQL = pageSql('summary.waiting_low = tdb().prepare(');
const DISMISS_SELECT_SQL = pageSql('const waiting = tdb().prepare(');
const RV_COUNT_SQL = rvSql('const rvCount = tdb().prepare(');
const RV_LOW_SQL = rvSql('const rvLow = tdb().prepare(');
const RV_ITEMS_SQL = rvSql('const rvItems = tdb().prepare(');

const FB_WAITING_SRC = sliceStatement(RETAIL_JS, 'const FB_WAITING =');
const fbSql = (anchor) => vm.runInNewContext(
  `(() => { ${FB_WAITING_SRC} return ${sliceTemplate(RETAIL_JS, anchor)}; })()`, {});
const FB_COUNT_SQL = fbSql('const fbCount = tdb().prepare(');
const FB_ITEMS_SQL = fbSql('const fbItems = tdb().prepare(');

// ── The database ──────────────────────────────────────────────────────────
const { openTablesDb, addForkedStoreProducts, driver } = require('./test-support/memory-db');
console.log(`  (sqlite driver: ${driver})`);

function freshDb() {
  const db = openTablesDb(DATABASE_JS, ['retail_reviews', 'retail_feedback', 'retail_customers']);
  return addForkedStoreProducts(db, SCHEMA_SQL, DATABASE_JS);
}

// One review. UNIQUE(customer_id, product_id, order_id) is real, so each seeded
// row gets its own triple unless the case is about a specific one.
let rseq = 0;
function seedReview(db, row = {}) {
  const r = {
    rating: 5, comment: 'Lovely.', reply: null, is_visible: 1,
    dismissed_at: null, created_at: '2026-08-20 09:00:00', ...row,
  };
  // The id is set explicitly and shared with the three FK columns: the returned
  // handle has to BE the row's id for the ordering assertions to mean anything,
  // and rseq keeps climbing across the fresh database each case opens.
  const n = ++rseq;
  db.prepare(`INSERT INTO retail_reviews
      (id, customer_id, product_id, order_id, rating, comment, reply, is_visible,
       dismissed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n, n, n, n, r.rating, r.comment, r.reply, r.is_visible,
      r.dismissed_at, r.created_at);
  return n;
}
const rvCount = (db) => db.prepare(RV_COUNT_SQL).get().n;
const rvLow = (db) => db.prepare(RV_LOW_SQL).get().n;
const rvItems = (db) => db.prepare(RV_ITEMS_SQL).all({ preview: 50 });

// One feedback thread. The defaults are a brand-new customer bug report — the
// case the fire exists for — and each fixture overrides the one field that
// makes it different.
let fseq = 0;
function seedThread(db, row = {}) {
  const r = {
    initiated_by: 'customer', kind: 'bug', message: 'Checkout kept my old pickup time.',
    created_at: '2026-08-22 08:00:00',
    // Seeded from created_at on insert for a customer report, exactly as the
    // live insert path does; null on a thread staff opened until the customer
    // writes back.
    last_customer_msg_at: undefined,
    last_admin_msg_at: null, admin_read_at: null, ...row,
  };
  if (r.last_customer_msg_at === undefined) {
    r.last_customer_msg_at = r.initiated_by === 'customer' ? r.created_at : null;
  }
  const n = ++fseq;
  db.prepare(`INSERT INTO retail_feedback
      (id, customer_id, customer_name, message, created_at, initiated_by, kind,
       last_customer_msg_at, last_admin_msg_at, admin_read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(n, n, 'Customer ' + n, r.message, r.created_at, r.initiated_by, r.kind,
      r.last_customer_msg_at, r.last_admin_msg_at, r.admin_read_at);
  return n;
}
const fbCount = (db) => db.prepare(FB_COUNT_SQL).get().n;
const fbItems = (db) => db.prepare(FB_ITEMS_SQL).all({ preview: 50 });
const fbIds = (db) => fbItems(db).map(r => r.id);

(async () => {

// ─────────────────────────────────────────────────────────────────────────
console.log('\n1 · the reviews queue is the Reviews page\'s queue');

it('a written review with no reply is in it', () => {
  const db = freshDb();
  seedReview(db);
  assert.strictEqual(rvCount(db), 1);
});

it('a RATING-ONLY review is not — there is nothing to answer', () => {
  // The clause that made this queue reachable. 12 of its 18 rows were these:
  // five stars, no words, sometimes a tag. Nobody is waiting on a reply to a
  // silence, so counting them made the one number the page exists to drive to
  // zero impossible to move.
  const db = freshDb();
  seedReview(db, { comment: null });
  assert.strictEqual(rvCount(db), 0);
});

it('and neither is a tags-only one — a tag is not a comment', () => {
  // The row renders as "No comment — tags only". The tags are the customer
  // picking from OUR list, not writing to us.
  const db = freshDb();
  seedReview(db, { comment: '' });
  seedReview(db, { comment: '   ' });
  assert.strictEqual(rvCount(db), 0);
});

it('a dismissed review is not in it, and nothing was published to get it out', () => {
  const db = freshDb();
  const id = seedReview(db, { dismissed_at: '2026-08-24 13:30:00' });
  assert.strictEqual(rvCount(db), 0);
  // The whole point of the column: the queue cleared and `reply` — the public
  // seller response — is untouched.
  const row = db.prepare('SELECT reply, reply_at FROM retail_reviews WHERE id = ?').get(id);
  assert.strictEqual(row.reply, null);
  assert.strictEqual(row.reply_at, null);
});

it('putting one back returns it to the queue', () => {
  const db = freshDb();
  const id = seedReview(db, { dismissed_at: '2026-08-24 13:30:00' });
  db.prepare('UPDATE retail_reviews SET dismissed_at = NULL WHERE id = ?').run(id);
  assert.strictEqual(rvCount(db), 1);
});

it('a review the shop answered is not', () => {
  const db = freshDb();
  seedReview(db, { reply: 'Thank you!' });
  assert.strictEqual(rvCount(db), 0);
});

it('a reply that is only whitespace is not an answer', () => {
  // TRIM, not `IS NOT NULL`: a save that posted an empty box would otherwise
  // clear the row off the card without a word reaching the customer.
  //
  // Spaces, deliberately — SQLite's TRIM() strips SPACES and nothing else, so a
  // reply of nothing but a newline survives both this rule and the Reviews
  // page's identical one. That is a shared quirk, not a divergence, and the two
  // must not be fixed one at a time.
  const db = freshDb();
  seedReview(db, { reply: '    ' });
  assert.strictEqual(rvCount(db), 1);
});

it('a HIDDEN review is still in it — the page counts it, so this must too', () => {
  // Hiding a review takes it off the storefront; it does not answer the person
  // who wrote it. If this ever diverges, the fire and the chip it opens stop
  // agreeing, and one of the two numbers is a lie.
  const db = freshDb();
  seedReview(db, { is_visible: 0 });
  assert.strictEqual(rvCount(db), 1);
});

it('seeded reviews cannot enter — the query never names their table', () => {
  // They live in retail_synthetic_reviews and are excluded from the page's
  // "Needs reply" count for the same reason: there is no customer on the other
  // end of one, so a reply is not owed.
  assert.ok(!/retail_synthetic_reviews/.test(RV_COUNT_SQL + RV_ITEMS_SQL),
    'the fire is reading the seeded-review table');
});

it('the low count is the unhappy ones, and only the unanswered ones', () => {
  const db = freshDb();
  seedReview(db, { rating: 1 });
  seedReview(db, { rating: 3 });
  seedReview(db, { rating: 4 });
  seedReview(db, { rating: 1, reply: 'Sorry — refunded.' });   // answered: neither count
  assert.strictEqual(rvCount(db), 3);
  assert.strictEqual(rvLow(db), 2, 'rating <= 3, among the unanswered only');
});

it('the items are oldest-first, so the age is the oldest thing waiting', () => {
  const db = freshDb();
  seedReview(db, { created_at: '2026-08-21 09:00:00' });
  const oldest = seedReview(db, { created_at: '2026-08-07 01:22:29' });
  seedReview(db, { created_at: '2026-08-22 09:00:00' });
  const rows = rvItems(db);
  assert.strictEqual(rows[0].id, oldest);
  assert.strictEqual(rows[0].waiting_since, '2026-08-07 01:22:29');
});

it('the clock is when the CUSTOMER posted it', () => {
  const db = freshDb();
  seedReview(db, { created_at: '2026-08-07 01:22:29' });
  assert.strictEqual(rvItems(db)[0].waiting_since, '2026-08-07 01:22:29');
});

it('the page, its count and the dashboard fire run the SAME clause', () => {
  // Not "equivalent" — the same text. Four readers used to carry four copies,
  // and a copy is how the fire and the chip it opens end up disagreeing about
  // one number. Every query below must contain the shared clause verbatim.
  const clause = vm.runInNewContext(`(() => { ${WAITING_SRC} return REVIEW_WAITING_SQL('r'); })()`, {});
  for (const [name, sql] of [
    ['dashboard count', RV_COUNT_SQL], ['dashboard items', RV_ITEMS_SQL],
    ['page summary', PAGE_SUMMARY_SQL], ['page low count', PAGE_LOW_SQL],
    ['bulk-dismiss set', DISMISS_SELECT_SQL],
  ]) {
    assert.ok(sql.includes(clause), `${name} is not using REVIEW_WAITING_SQL`);
  }
  // And the list route's chip filter, which pushes it through the UNION rewriter.
  assert.ok(/where\.push\('\(' \+ REVIEW_WAITING_SQL\('r'\) \+ '\)'\)/.test(RETAIL_JS),
    "the Needs-reply chip filter is not using the shared clause");
  // The clause is WRITTEN exactly once — inside REVIEW_WAITING_SQL, where the
  // alias is still a `${a}` placeholder — and nowhere is it spelled out against
  // a fixed alias. That second assertion is the one that catches the next
  // copy-paste: an alias-baked `r.reply IS NULL` is what a fifth reader looks
  // like when somebody adds one in a hurry.
  const defs = (RETAIL_JS.match(/\$\{a\}\.reply IS NULL OR TRIM\(\$\{a\}\.reply\) = ''/g) || []).length;
  assert.strictEqual(defs, 1, `the clause is written ${defs} times — exactly one definition may exist`);
  const baked = (RETAIL_JS.match(/r\.reply IS NULL/g) || []).length
              + (RETAIL_JS.match(/\(reply IS NULL OR TRIM\(reply\)/g) || []).length;
  assert.strictEqual(baked, 0, `${baked} hand-copied alias-baked copies of the clause survive`);
});

it('the bulk action reads its set from the DB, never from the client', () => {
  // A page of 50 cannot dismiss a queue of 300, and an id list built when the
  // page was drawn would sweep up a review a colleague answered since.
  const route = sliceBlock(RETAIL_JS, "router.post('/api/retail-admin/reviews/dismiss-waiting'");
  assert.ok(/const waiting = tdb\(\)\.prepare\(/.test(route), 'the set is not read from the database');
  assert.ok(!/req\.body[^;]*ids/.test(route), 'the route is taking an id list from the client');
  assert.ok(/queue_changed/.test(route), 'the stale-count guard is gone');
  assert.ok(!/reply\s*=/.test(route), 'the bulk action is writing to the PUBLIC reply column');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · the feedback queue, and the guard the list does not need');

it('a bug report nobody has opened is in it', () => {
  const db = freshDb();
  const id = seedThread(db);
  assert.deepStrictEqual(fbIds(db), [id]);
});

it('once an operator opens it, it leaves', () => {
  const db = freshDb();
  seedThread(db, { admin_read_at: '2026-08-22 09:00:00' });
  assert.deepStrictEqual(fbIds(db), []);
});

it('a customer follow-up after that read puts it back', () => {
  const db = freshDb();
  const id = seedThread(db, {
    admin_read_at: '2026-08-22 09:00:00',
    last_admin_msg_at: '2026-08-22 09:05:00',
    last_customer_msg_at: '2026-08-22 11:00:00',
  });
  assert.deepStrictEqual(fbIds(db), [id]);
});

it('a thread STAFF started, which the customer has not answered, is NOT a fire', () => {
  // The guard. admin_read_at is null on one of these until somebody re-opens
  // it, so the list's bare needs_reply rule reads the operator's own opener as
  // a customer waiting — a fire about our own unanswered message.
  const db = freshDb();
  seedThread(db, { initiated_by: 'admin', kind: 'message',
    message: 'Sorry about the late delivery — here is 20 off.',
    last_admin_msg_at: '2026-08-22 08:00:00' });
  assert.deepStrictEqual(fbIds(db), []);
});

it('but once the customer answers it, it is', () => {
  const db = freshDb();
  const id = seedThread(db, { initiated_by: 'admin', kind: 'message',
    last_admin_msg_at: '2026-08-22 08:00:00',
    last_customer_msg_at: '2026-08-22 10:00:00' });
  assert.deepStrictEqual(fbIds(db), [id]);
});

it('a staff thread the customer answered and we then read is quiet again', () => {
  const db = freshDb();
  seedThread(db, { initiated_by: 'admin',
    last_admin_msg_at: '2026-08-22 08:00:00',
    last_customer_msg_at: '2026-08-22 10:00:00',
    admin_read_at: '2026-08-22 10:30:00' });
  assert.deepStrictEqual(fbIds(db), []);
});

it('the queue is exactly the waiting threads, among all of them', () => {
  // Non-vacuous: every neighbour above is in the table, so a predicate that
  // lost a clause shows up here as an extra row.
  const db = freshDb();
  const wanted = seedThread(db);
  seedThread(db, { admin_read_at: '2026-08-22 09:00:00' });
  seedThread(db, { initiated_by: 'admin', last_admin_msg_at: '2026-08-22 08:00:00' });
  seedThread(db, { initiated_by: 'admin', last_customer_msg_at: '2026-08-22 10:00:00',
    admin_read_at: '2026-08-22 10:30:00' });
  assert.deepStrictEqual(fbIds(db), [wanted]);
  assert.strictEqual(fbCount(db), 1, 'the count and the list disagree');
});

it('the clock is the customer\'s latest turn, not the thread root', () => {
  const db = freshDb();
  seedThread(db, {
    created_at: '2026-08-19 10:02:00',
    admin_read_at: '2026-08-20 09:00:00',
    last_admin_msg_at: '2026-08-20 09:05:00',
    last_customer_msg_at: '2026-08-22 09:10:00',
  });
  assert.strictEqual(fbItems(db)[0].waiting_since, '2026-08-22 09:10:00');
});

it('the oldest waiting customer is first', () => {
  const db = freshDb();
  seedThread(db, { created_at: '2026-08-22 08:00:00' });
  const oldest = seedThread(db, { created_at: '2026-08-11 08:00:00' });
  assert.strictEqual(fbIds(db)[0], oldest);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · the fires the dashboard builds');

// The pushes, sliced out of tdAttnRender and run against stubs — so the words,
// the severity, the gates and the door are read off the shipped file.
const RV_FIRE_SRC = sliceBlock(DASH_JS, "if (rv.count && dashCardWants('reviews')",
  { from: '// Reviews nobody has answered' });
const FB_FIRE_SRC = sliceBlock(DASH_JS, "if (fb.count && dashCardWants('feedback')",
  { from: '// Feedback threads with the' });

function buildFire(src, prelude, ops, { can = true, feat = true, mins = 240 } = {}) {
  const fires = [];
  vm.runInNewContext(`${prelude} ${src}`, {
    fires, DASH_OPS: ops,
    dashCardWants: () => can,
    dashFeatOn: () => feat,
    cuT: (en) => en,                       // assert on the EN half
    tdOldestMins: (items) => ((items || []).length ? mins : null),
  });
  return fires[0] || null;
}
const reviewsFire = (reviews_unanswered, opts) => buildFire(RV_FIRE_SRC,
  'const rv = DASH_OPS.reviews_unanswered || { count: 0, low: 0, items: [] };',
  { reviews_unanswered }, opts);
const feedbackFire = (feedback_waiting, opts) => buildFire(FB_FIRE_SRC,
  'const fb = DASH_OPS.feedback_waiting || { count: 0, items: [] };',
  { feedback_waiting }, opts);

it('unanswered reviews raise an amber row that counts them', () => {
  const f = reviewsFire({ count: 18, low: 2, items: [{ id: 1 }] });
  assert.strictEqual(f.label, 'Reviews to answer');
  assert.strictEqual(f.n, 18);
  assert.strictEqual(f.sev, 'amber', 'work waiting is not a brick');
  assert.strictEqual(f.mins, 240);
});

it('and the row names how many are unhappy', () => {
  // Nine polite five-stars and nine one-stars are the same number and not the
  // same afternoon.
  assert.strictEqual(reviewsFire({ count: 9, low: 3, items: [{ id: 1 }] }).state, '3 low-rated');
});

it('with none low-rated it says nothing rather than "0 low-rated"', () => {
  assert.strictEqual(reviewsFire({ count: 9, low: 0, items: [{ id: 1 }] }).state, null);
});

it('an empty queue raises nothing at all', () => {
  assert.strictEqual(reviewsFire({ count: 0, low: 0, items: [] }), null);
  assert.strictEqual(feedbackFire({ count: 0, items: [] }), null);
});

it('an operator who cannot write the reply gets no fire they cannot put out', () => {
  assert.strictEqual(reviewsFire({ count: 5, low: 0, items: [{}] }, { can: false }), null);
  assert.strictEqual(feedbackFire({ count: 5, items: [{}] }, { can: false }), null);
});

it('a shop that switched the feature off is not nagged about its backlog', () => {
  assert.strictEqual(reviewsFire({ count: 5, low: 0, items: [{}] }, { feat: false }), null);
  assert.strictEqual(feedbackFire({ count: 5, items: [{}] }, { feat: false }), null);
});

it('waiting feedback raises its own row, with its own door', () => {
  const f = feedbackFire({ count: 3, items: [{ id: 1 }] });
  assert.strictEqual(f.label, 'Feedback to answer');
  assert.strictEqual(f.n, 3);
  assert.strictEqual(f.sev, 'amber');
  assert.strictEqual(f.go, 'dashOpenFeedback()');
});

it('the reviews door is the reviews door', () => {
  assert.strictEqual(reviewsFire({ count: 1, low: 0, items: [{}] }).go, 'dashOpenReviews()');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n4 · the doors — the Inbox dropdown, clicked');

const OPEN_INBOX_SRC = sliceBlock(DASH_JS, 'function dashOpenInbox(which)');

it('the door clicks the Inbox menu button, not goTab', () => {
  // For what the button does either side of the navigation: mark-seen and
  // close-menu. An operator who reached the queue from a fire has read it, so
  // the unseen badge has to clear the same way it does from the menu — goTab
  // alone leaves a red dot sitting on a list they have just worked.
  const clicked = [];
  const ctx = {
    document: {
      querySelector: (sel) => (/#tbInboxMenu \[data-tab="reviews"\]/.test(sel)
        ? { click: () => clicked.push(sel) } : null),
    },
  };
  vm.createContext(ctx);
  new vm.Script(`${OPEN_INBOX_SRC}; var __ok = dashOpenInbox('reviews');`).runInContext(ctx);
  assert.strictEqual(ctx.__ok, true);
  assert.strictEqual(clicked.length, 1);
});

it('a missing button is reported, not thrown', () => {
  const ctx = { document: { querySelector: () => null } };
  vm.createContext(ctx);
  new vm.Script(`${OPEN_INBOX_SRC}; var __ok = dashOpenInbox('reviews');`).runInContext(ctx);
  assert.strictEqual(ctx.__ok, false);
});

it('the click cannot load either tab twice', () => {
  // The click reaches the button's own listener AND, through the inline onclick,
  // goTab's TAB_INIT dispatch — both of which call the same init. That is only
  // safe because each init early-returns on its loaded flag. Lose the guard and
  // every door click becomes two of every fetch behind it.
  const CONTENT_JS = fs.readFileSync(
    path.join(ROOT, 'public', 'retail-admin', '07-content-billing.js'), 'utf8');
  const CORE_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '01-core.js'), 'utf8');
  for (const [init, flag] of [['reviewsTabInit', 'REVIEWS_LOADED'], ['feedbackTabInit', 'FEEDBACK_LOADED']]) {
    const body = sliceBlock(CONTENT_JS, `function ${init}()`);
    assert.ok(new RegExp(`if\\s*\\(${flag}\\)\\s*return`).test(body),
      `${init} lost its idempotence guard — the door now double-loads`);
    assert.ok(new RegExp(`${init}`).test(sliceBlock(CORE_JS, 'const TAB_INIT =')),
      `${init} is not registered in TAB_INIT`);
  }
});

it('nothing routes either queue through dashJumpTab any more', () => {
  // It queries `.tabs [data-tab=…]`, and neither queue has had a rail button
  // since Inbox moved to the topbar — so a jump through it silently did
  // nothing, which is exactly what the activity feed's jump-to-report did.
  assert.ok(!/dashJumpTab\(['"](reviews|feedback)['"]\)/.test(DASH_JS),
    'a queue is still being opened through the rail-only jump');
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})();
