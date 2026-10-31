#!/usr/bin/env node
/**
 * A conversation on the computer shows on the phone, and the other way round.
 *
 *   node scripts/test_conversation_sync.js
 *
 * THE COMPLAINT. A reply typed on one device stayed on that device until the
 * other was reloaded. The thread was already one record. What did not move
 * was the news that it had changed: the live watermark looked at orders,
 * customers and stock, the computer's Feedback tab loaded once, and the
 * phone's inbox was fetched at boot.
 *
 * READS ONLY, plus an in-memory database that runs the watermark's own
 * SELECT, copied out of the server file so the two cannot drift. No browser.
 * Fast shard.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const RETAIL = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const FEEDBACK_ROUTE = fs.readFileSync(path.join(ROOT, 'routes', 'retail', 'feedback.js'), 'utf8');
const DESK = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '07-content-billing.js'), 'utf8');
const PHONE = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');
const SHOP = fs.readFileSync(path.join(ROOT, 'public', 'shop.html'), 'utf8');
const MINI_LIST = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'feedback', 'feedback.js'), 'utf8');
const MINI_THREAD = fs.readFileSync(path.join(ROOT, 'miniapp', 'pages', 'feedback-thread', 'feedback-thread.js'), 'utf8');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

function sliceFn(src, name) {
  const at = src.indexOf('function ' + name);
  assert.ok(at >= 0, name + ' is gone');
  const rest = src.slice(at + 1);
  const m = /\n(?:async )?function /.exec(rest);
  return src.slice(at, m ? at + 1 + m.index : src.length);
}

const sigFn = sliceFn(RETAIL, '_dashActivitySignature');

function selectFor(table) {
  // The signature function holds several SELECTs. Take the one that ends at
  // this table, not everything from the first SELECT in the function.
  const at = sigFn.search(new RegExp('FROM ' + table + '(?![_a-z])'));
  assert.ok(at >= 0, 'the watermark no longer selects from ' + table);
  const start = sigFn.lastIndexOf('SELECT', at);
  assert.ok(start >= 0, 'no SELECT for ' + table);
  return sigFn.slice(start, at + ('FROM ' + table).length);
}

console.log('\nThe watermark moves when a conversation moves, and not when someone only opens it');

it('the signature reads the thread and its turns', () => {
  assert.ok(/FROM retail_feedback(?![_a-z])/.test(sigFn), 'retail_feedback left the watermark');
  assert.ok(/FROM retail_feedback_messages/.test(sigFn), 'retail_feedback_messages left the watermark');
});

it('a read stamp is not part of the signature', () => {
  // Opening a thread writes these. If the signature moved on that write,
  // every open screen would re-read, write the stamp again, and nudge again.
  // The comment above the query names the columns on purpose; only the
  // SELECT itself is forbidden to carry them.
  const sql = selectFor('retail_feedback') + '\n' + selectFor('retail_feedback_messages');
  assert.ok(!/admin_read_at|customer_read_at/.test(sql),
    'a read stamp is in the conversation signature — that is a refresh loop');
});

it('handled, a new turn, and putting one back each change the signature; opening it does not', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE retail_feedback (
      id INTEGER PRIMARY KEY,
      handled_at TEXT,
      last_customer_msg_at TEXT,
      last_admin_msg_at TEXT,
      admin_read_at TEXT,
      customer_read_at TEXT
    );
    CREATE TABLE retail_feedback_messages (
      id INTEGER PRIMARY KEY,
      feedback_id INTEGER,
      body TEXT
    );
  `);
  const fSql = selectFor('retail_feedback');
  const mSql = selectFor('retail_feedback_messages');
  const sig = () => {
    const f = db.prepare(fSql).get();
    const m = db.prepare(mSql).get();
    return [f.n, f.mid, f.h, f.lc, f.la, m.n, m.mid].join('|');
  };
  const empty = sig();
  db.prepare(`INSERT INTO retail_feedback (last_customer_msg_at) VALUES ('2026-10-29 01:00:00')`).run();
  const opened = sig();
  assert.notStrictEqual(opened, empty, 'a new conversation did not move the watermark');
  db.prepare(`UPDATE retail_feedback SET admin_read_at = '2026-10-29 01:05:00', customer_read_at = '2026-10-29 01:05:00'`).run();
  assert.strictEqual(sig(), opened, 'opening the conversation moved the watermark');
  db.prepare(`INSERT INTO retail_feedback_messages (feedback_id, body) VALUES (1, 'on my way')`).run();
  db.prepare(`UPDATE retail_feedback SET last_admin_msg_at = '2026-10-29 01:06:00'`).run();
  const replied = sig();
  assert.notStrictEqual(replied, opened, 'a reply did not move the watermark');
  db.prepare(`UPDATE retail_feedback SET handled_at = '2026-10-29 01:07:00'`).run();
  const handled = sig();
  assert.notStrictEqual(handled, replied, 'marking it handled did not move the watermark');
  db.prepare(`UPDATE retail_feedback SET handled_at = NULL`).run();
  assert.notStrictEqual(sig(), handled, 'putting it back did not move the watermark');
  db.close();
});

console.log('\nThe computer and the phone both refetch, and a half-typed reply stays');

it('the computer subscribes, and the quiet refresh does not write the reply box', () => {
  assert.ok(/retailLiveSubscribe\(\s*_fbLiveNudge\s*\)/.test(DESK),
    'the Feedback tab is not on the live stream');
  const refresh = sliceFn(DESK, 'refreshOpenFeedbackThread');
  assert.ok(!/fb-reply-input[\s\S]{0,80}\.value\s*=/.test(refresh),
    'the quiet refresh writes the reply box — a sentence in flight would be replaced');
  assert.ok(/if\s*\(\s*FEEDBACK_LOADED\s*\)\s*return/.test(sliceFn(DESK, 'feedbackTabInit')),
    'the first-open guard is gone — the door double-loads again');
  assert.ok(/if\s*\(\s*FEEDBACK_LOADED\s*\)\s*\{\s*loadFeedback\(\{\s*silent:\s*true\s*\}\)/.test(DESK),
    'opening the Feedback tab again does not re-read the list');
});

it('the phone refetches on the nudge, the backstop, and a pull, and keeps the draft', () => {
  assert.ok(/function refreshConversation\(/.test(PHONE), 'refreshConversation is gone');
  const tick = sliceFn(PHONE, 'mLiveTick');
  const nudge = sliceFn(PHONE, 'mLiveRefreshAll');
  const pull = sliceFn(PHONE, 'refreshNow');
  for (const [name, body] of [['the 60s tick', tick], ['the nudge', nudge], ['a pull', pull]]) {
    assert.ok(/inboxOnScreen\(\)/.test(body) && /refreshConversation\(/.test(body),
      name + ' no longer refetches the conversation');
  }
  assert.ok(/if\(route==='inbox'\) loadInbox\(\)/.test(PHONE),
    'opening the inbox does not re-read it');
  assert.ok(/oninput="APP\.cmd\('fbDraft'/.test(PHONE),
    'the reply box does not keep what was typed across a redraw');
  const thread = sliceFn(PHONE, 'loadThread');
  assert.ok(/state\.thread\.draft/.test(thread),
    're-reading the thread drops the draft');
  assert.ok(/return api\('\/feedback\/'\s*\+\s*id\)/.test(thread),
    're-reading the thread does not hand its result back — the paint runs on the old turns');
});

console.log('\nThe customer\'s website and mini app re-read the same conversation');

it('both customer screens wait the same eight seconds, and a re-read does not stamp a thread already seen', () => {
  assert.strictEqual((SHOP.match(/FB_POLL_MS=8000/g) || []).length, 1, 'the website interval moved');
  assert.ok(/startFeedbackPoll\(/.test(SHOP) && /stopFeedbackPoll\(/.test(SHOP),
    'the website no longer re-reads an open conversation');
  assert.ok(/setInterval\(\(\) => this\.load\(true\), 8000\)/.test(MINI_THREAD),
    'the mini app thread no longer re-reads while it is open');
  assert.ok(/setInterval\(\(\) => this\.loadReports\(\), 8000\)/.test(MINI_LIST),
    'the mini app list no longer re-reads while it is open');
  const get = FEEDBACK_ROUTE.slice(
    FEEDBACK_ROUTE.indexOf("router.get('/api/retail/feedback/:id'"),
    FEEDBACK_ROUTE.indexOf("router.post('/api/retail/feedback/:id/reply'"));
  assert.ok(/if \(unread\)/.test(get),
    'the customer re-read stamps customer_read_at even when nothing is unread');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
