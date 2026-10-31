#!/usr/bin/env node
'use strict';

// Tests for lib/channel-block.js — what is stopping a channel right now (§106).
//
//   node scripts/test_channel_block.js
//
// Touches nothing real: every case builds its own :memory: database carrying
// the three sync-log tables in the shape the module reads.
//
// What is locked down, in order of how expensive it was to learn:
//
//   1. status='error' is the whole test. `poll_paused` is written with status
//      'ok' and means "outside opening hours" — reading the event type alone
//      turned 天河 amber the moment it shut for the night.
//   2. Two ways to recover, because the daemons use both: an explicit clearing
//      event, or a stock push that simply landed.
//   3. The Meituan tab's semantics are UNCHANGED by the extraction, with one
//      deliberate exception recorded below. Section 2 runs the tab's original
//      algorithm beside the shared one and demands they agree.
//   4. Worst = EARLIEST across a channel's stores: the fault that has been
//      stopping pushes longest is the one nobody has looked at.
//   5. The client defers an item's generic failure to the channel's cause, and
//      never the other way round.

const Database = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const { channelBlock, channelBlockFor, CHANNELS } = require('../lib/channel-block');
const { MEITUAN_CODES, meituanCodeOf, classifyPushError } = require('../lib/channel-push-reason');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push({ name, message: e.message }); console.log(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }
function section(t) { console.log(`\n${t}`); }

// ── Fixture ──────────────────────────────────────────────────────────────────

// Stamps are written explicitly: the rule compares them as strings, and a test
// that leaned on CURRENT_TIMESTAMP would order two rows written in the same
// second by luck.
const T = (n) => `2026-09-1${Math.floor(n / 24) % 10} ${String(n % 24).padStart(2, '0')}:00:00`;

function freshDb() {
  const db = new Database(':memory:');
  for (const t of ['meituan_sync_log', 'eleme_sync_log', 'guanyi_sync_log']) {
    db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, store_code TEXT,
      event_type TEXT, status TEXT, detail TEXT, error_msg TEXT, created_at DATETIME);`);
  }
  return db;
}
function log(db, table, storeCode, eventType, status, at, msg) {
  db.prepare(`INSERT INTO ${table} (store_code, event_type, status, error_msg, created_at)
              VALUES (?, ?, ?, ?, ?)`).run(storeCode, eventType, status, msg || null, at);
}

// ── 1. The rule ──────────────────────────────────────────────────────────────
section('1 · a store is blocked until something says otherwise');

check('a blocking event with status error is the cause, with the daemon’s own sentence', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'verify_required', 'error', T(9), '验证中心风控，同步已暂停');
  const b = channelBlock(db, 'meituan', 'tianhe');
  eq([b.by, b.at, b.msg], ['verify_required', T(9), '验证中心风控，同步已暂停']);
});

check('nothing logged is not a fault', () => {
  eq(channelBlock(freshDb(), 'meituan', 'tianhe'), null);
});

check('STATUS IS THE TEST — an ok row of a blocking type does not block', () => {
  // poll_paused is logged ok and means the shop is shut for the night. The type
  // alone turned 天河 amber every evening; the Meituan route's own comment
  // carries this warning and it is carried over verbatim.
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'needs_login', 'ok', T(9), 'signed in again');
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
});

check('a later successful stock push clears it — no announcement needed', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'proxy_down', 'error', T(9), 'proxy cannot reach Meituan');
  log(db, 'meituan_sync_log', 'tianhe', 'stock_push', 'ok', T(10), null);
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
});

check('a FAILED stock push does not clear it', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'proxy_down', 'error', T(9), 'proxy cannot reach Meituan');
  log(db, 'meituan_sync_log', 'tianhe', 'stock_push', 'error', T(10), 'cannot reach Meituan');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'proxy_down');
});

check('a clearing event clears it whatever its status', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'verify_required', 'error', T(9), 'captcha');
  log(db, 'meituan_sync_log', 'tianhe', 'verify_cleared', 'ok', T(10), null);
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
});

check('a clearing event BEFORE the fault clears nothing', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'verify_cleared', 'ok', T(8), null);
  log(db, 'meituan_sync_log', 'tianhe', 'verify_required', 'error', T(9), 'captcha');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'verify_required');
});

check('the LATEST fault is the one reported', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'proxy_down', 'error', T(8), 'proxy');
  log(db, 'meituan_sync_log', 'tianhe', 'needs_login', 'error', T(9), 'signed out');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'needs_login');
});

check('one store’s fault is not another’s', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'verify_required', 'error', T(9), 'captcha');
  eq(channelBlock(db, 'meituan', 'yuexiu'), null);
});

check('each channel reads its own log, and a channel nobody named is null', () => {
  const db = freshDb();
  log(db, 'eleme_sync_log', 'tianhe', 'auth_required', 'error', T(9), 'Eleme session missing/expired');
  eq(channelBlock(db, 'eleme', 'tianhe').by, 'auth_required');
  eq(channelBlock(db, 'meituan', 'tianhe'), null, 'Eleme’s fault must not appear on Meituan');
  eq(channelBlock(db, 'wechat', 'tianhe'), null, 'an unknown channel');
  eq(channelBlock(db, 'meituan', ''), null, 'no store code');
});

check('an event this channel’s daemon never writes is not a cause', () => {
  // GZ Grocery's daemon writes needs_login and proxy_down and nothing else.
  const db = freshDb();
  log(db, 'guanyi_sync_log', 'tianhe', 'verify_required', 'error', T(9), 'captcha');
  eq(channelBlock(db, 'guanyi', 'tianhe'), null);
  log(db, 'guanyi_sync_log', 'tianhe', 'needs_login', 'error', T(10), 'signed out');
  eq(channelBlock(db, 'guanyi', 'tianhe').by, 'needs_login');
});

check('CHANNELS HAVE DIFFERENT NAMES FOR THE SAME FAULT, and the table uses each channel’s own', () => {
  // The first draft of the descriptor gave Eleme Meituan's event names. It would
  // have found NOTHING on Eleme for ever, silently — Eleme calls a lost session
  // `auth_required`. Every name here is one a daemon's own logSync call writes.
  const db = freshDb();
  log(db, 'eleme_sync_log', 'tianhe', 'needs_login', 'error', T(9), 'Meituan’s word, not Eleme’s');
  eq(channelBlock(db, 'eleme', 'tianhe'), null);
  log(db, 'eleme_sync_log', 'tianhe', 'auth_required', 'error', T(10), 'Eleme session missing/expired');
  eq(channelBlock(db, 'eleme', 'tianhe').by, 'auth_required');
  log(db, 'eleme_sync_log', 'tianhe', 'auth_recovered', 'ok', T(11), 'Eleme session restored');
  eq(channelBlock(db, 'eleme', 'tianhe'), null, 'and its own recovery announcement clears it');
});

check('GZ Grocery announces recovery with the fault’s own event type, and that works', () => {
  // `needs_login` status 'ok' means "session recovered" in guanyi-daemon.js, so
  // it appears in both lists. A fault cannot clear itself (clearing must be
  // strictly later) and a second fault re-blocks at its own stamp.
  const db = freshDb();
  log(db, 'guanyi_sync_log', 'tianhe', 'needs_login', 'error', T(9), 'Guanyi session expired');
  eq(channelBlock(db, 'guanyi', 'tianhe').by, 'needs_login', 'the fault does not clear itself');
  log(db, 'guanyi_sync_log', 'tianhe', 'needs_login', 'ok', T(10), 'session recovered');
  eq(channelBlock(db, 'guanyi', 'tianhe'), null);
  log(db, 'guanyi_sync_log', 'tianhe', 'needs_login', 'error', T(11), 'expired again');
  eq(channelBlock(db, 'guanyi', 'tianhe').by, 'needs_login', 'and it blocks again on the next fault');
});

// §250 — one signed-out signal across all three channels. Before it Meituan
// never logged a rejected session, and a lost shop binding (whose own alert says
// "needs re-login") was read by nothing here.
check('Meituan: a rejected session blocks, and its own recovery clears it', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'needs_login', 'error', T(9), 'Meituan session signed out');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'needs_login');
  log(db, 'meituan_sync_log', 'tianhe', 'login_restored', 'ok', T(10), 'signed in again');
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
});

check('Meituan: a lost shop binding blocks as a sign-out, and binding_cleared clears it', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'binding_lost', 'error', T(9), 'lost store binding — needs re-login');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'binding_lost');
  log(db, 'meituan_sync_log', 'tianhe', 'binding_cleared', 'ok', T(10), 'store binding restored');
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
});

check('the Meituan daemon and browser actually write the events the table reads', () => {
  const daemon = fs.readFileSync(path.join(__dirname, 'meituan-daemon.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '..', 'lib', 'meituan-browser.js'), 'utf8');
  ok(/logSync\(storeCode, 'needs_login', 'error'/.test(daemon), 'the daemon never logs needs_login');
  ok(/logSync\(storeCode, 'login_restored', 'ok'/.test(daemon), 'the daemon never logs its recovery');
  ok(/noteLoginResult\(storeCode, browser\.signedOut\)/.test(daemon), 'the order poll does not report the flag');
  ok(/this\.signedOut = true/.test(browser), 'the browser never raises the flag');
  for (const ev of ['needs_login', 'binding_lost']) ok(CHANNELS.meituan.blocking.includes(ev), `${ev} does not block`);
  for (const ev of ['login_restored', 'binding_cleared']) ok(CHANNELS.meituan.clearing.includes(ev), `${ev} does not clear`);
});

check('every surface words a lost binding as signed out', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  ok(/case 'binding_lost':/.test(read('public/retail-admin/01-core.js')), 'desktop block sentence');
  ok(/case 'binding_lost':/.test(read('public/m.html')), 'phone block sentence');
  ok(/by === 'binding_lost'/.test(read('public/retail-admin/03-dashboard.js')), 'desktop Home');
  ok(/by==='binding_lost'/.test(read('public/m.html')), 'phone Home');
  ok(/binding_lost:\s*\['is signed out'/.test(read('public/retail-admin/11-meituan.js')), 'Meituan tab');
});

check('the Eleme tab reads the daemon’s signal, not only whether a session file exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eleme-admin.js'), 'utf8');
  ok(/channelBlock\(db, 'eleme', st\.code\)/.test(src), 'elemeStoreHealth ignores auth_required');
});

check('a missing log table is a channel this box does not run, not an error', () => {
  const db = new Database(':memory:');
  eq(channelBlock(db, 'meituan', 'tianhe'), null);
  eq(channelBlockFor(db, 'meituan', [{ code: 'tianhe' }]), null);
});

check('every table name in the descriptor is an identifier, never interpolated text', () => {
  // The table names go into SQL. The guard is what stops a typo becoming a query
  // that means something else; this is the same rule lib/channel-drift-sweep.js
  // applies to its own identifiers.
  for (const [key, d] of Object.entries(CHANNELS)) {
    ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.logTable), key + ' has a non-identifier table: ' + d.logTable);
    ok(d.blocking.length, key + ' blocks on nothing');
    for (const e of d.blocking.concat(d.clearing)) ok(/^[a-z_]+$/.test(e), key + ' has an odd event name: ' + e);
  }
});

check('every event name in the table is one a daemon actually writes', () => {
  // The guard for the mistake above: a descriptor is a list of strings, and a
  // wrong string produces silence rather than an error. So the writers' own
  // source is the check. `meituan_sync_log` has TWO writers — the 外卖 daemon
  // and the 闪购 one, which is where its needs_login rows come from — so each
  // channel is checked against everything that writes its table.
  const WRITERS = {
    meituan: ['scripts/meituan-daemon.js', 'scripts/shangou-daemon.js'],
    eleme: ['scripts/eleme-daemon.js'],
    guanyi: ['scripts/guanyi-daemon.js'],
  };
  for (const [key, desc] of Object.entries(CHANNELS)) {
    const src = WRITERS[key].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    for (const ev of desc.blocking.concat(desc.clearing)) {
      ok(src.includes(`'${ev}'`), `${key}: ${WRITERS[key].join(' / ')} never writes '${ev}'`);
    }
    ok(src.includes(`'stock_push'`), `${key}: the recovery test reads stock_push and nothing writes it`);
  }
});

// ── 2. The Meituan tab’s semantics, unchanged ────────────────────────────────
//
// The algorithm lived inside meituanStoreHealth in routes/meituan-admin.js and
// drove the Meituan tab's store lines for months. §106 moved it out so the
// Channel sync page could ask the same question. The risk of a move like that is
// a quiet change of meaning, so the ORIGINAL is reproduced here and both are run
// over the same fixtures.
//
// ⚠️ ONE DELIBERATE DIFFERENCE, and it is a fix rather than a slip: the shared
// list also blocks on `proxy_down`, which the tab's private list omitted even
// though the daemon logs it as an error reading "proxy cannot reach Meituan —
// sync paused". A store in that state pushes nothing and the tab called it fine.
section('2 · the extraction did not change what the Meituan tab means');

const MT_BLOCKING_BEFORE = ['needs_login', 'verify_required', 'queue_stalled', 'proxy_stale'];
const MT_CLEARING_BEFORE = ['verify_cleared', 'queue_resumed', 'poll_resumed', 'proxy_elected', 'proxy_up'];
function blockedBefore(db, storeCode) {
  const ph = MT_BLOCKING_BEFORE.map(() => '?').join(',');
  const ev = db.prepare(`SELECT event_type, error_msg, created_at FROM meituan_sync_log
                          WHERE store_code = ? AND status = 'error' AND event_type IN (${ph})
                          ORDER BY created_at DESC LIMIT 1`).get(storeCode, ...MT_BLOCKING_BEFORE);
  if (!ev) return null;
  const okAt = db.prepare(`SELECT MAX(created_at) AS t FROM meituan_sync_log
                            WHERE store_code = ? AND event_type = 'stock_push' AND status = 'ok'`).get(storeCode).t || null;
  const cph = MT_CLEARING_BEFORE.map(() => '?').join(',');
  const cleared = db.prepare(`SELECT MAX(created_at) AS t FROM meituan_sync_log
                               WHERE store_code = ? AND event_type IN (${cph})`).get(storeCode, ...MT_CLEARING_BEFORE).t || null;
  if ((okAt && String(okAt) > String(ev.created_at)) || (cleared && String(cleared) > String(ev.created_at))) return null;
  return { by: ev.event_type, at: ev.created_at || null, msg: ev.error_msg || null };
}

// One fixture per shape the tab has actually met.
const CASES = [
  ['nothing at all', []],
  ['a captcha', [['verify_required', 'error', 9, 'captcha']]],
  ['a captcha, then cleared', [['verify_required', 'error', 9, 'captcha'], ['verify_cleared', 'ok', 10, null]]],
  ['a captcha, then a push landed', [['verify_required', 'error', 9, 'captcha'], ['stock_push', 'ok', 10, null]]],
  ['signed out', [['needs_login', 'error', 9, 'signed out']]],
  ['a stalled queue', [['queue_stalled', 'error', 9, 'nothing draining'], ['poll_resumed', 'ok', 8, null]]],
  ['the shop shut for the night', [['poll_paused', 'ok', 20, null]]],
  ['a stale proxy, re-elected', [['proxy_stale', 'error', 9, 'stale'], ['proxy_elected', 'ok', 11, null]]],
  ['two faults', [['proxy_stale', 'error', 8, 'stale'], ['needs_login', 'error', 9, 'signed out']]],
];
for (const [label, rows] of CASES) {
  check(`same verdict as before · ${label}`, () => {
    const db = freshDb();
    for (const [ev, st, h, msg] of rows) log(db, 'meituan_sync_log', 'tianhe', ev, st, T(h), msg);
    eq(channelBlock(db, 'meituan', 'tianhe'), blockedBefore(db, 'tianhe'));
  });
}

check('the ONE difference is proxy_down, and it is the fix §106 intended', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'proxy_down', 'error', T(9), 'proxy cannot reach Meituan — sync paused');
  eq(blockedBefore(db, 'tianhe'), null, 'the tab used to call this store fine');
  eq(channelBlock(db, 'meituan', 'tianhe').by, 'proxy_down', 'and now it says what is wrong');
});

// ── 3. Speaking for a channel rather than a store ────────────────────────────
section('3 · the worst live cause across a channel’s stores');

const STORES = [{ code: 'tianhe', name: '天河', nameEn: 'Tianhe' }, { code: 'yuexiu', name: '越秀', nameEn: 'Yuexiu' }];

check('EARLIEST wins — the fault nobody has looked at, not the freshest one', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'yuexiu', 'needs_login', 'error', T(11), 'signed out');
  log(db, 'meituan_sync_log', 'tianhe', 'verify_required', 'error', T(9), 'captcha');
  const b = channelBlockFor(db, 'meituan', STORES);
  eq([b.by, b.store, b.storeName, b.storeNameEn], ['verify_required', 'tianhe', '天河', 'Tianhe']);
});

check('a channel with nothing wrong says nothing', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'stock_push', 'ok', T(10), null);
  eq(channelBlockFor(db, 'meituan', STORES), null);
});

check('a store not in the list is not asked about', () => {
  // The caller passes only the stores TRADING on that channel; a shop that does
  // not sell on Meituan cannot block Meituan.
  const db = freshDb();
  log(db, 'meituan_sync_log', 'panyu', 'needs_login', 'error', T(9), 'signed out');
  eq(channelBlockFor(db, 'meituan', STORES), null);
  eq(channelBlockFor(db, 'meituan', []), null);
  eq(channelBlockFor(db, 'meituan', null), null);
});

check('a store with no name falls back to its code on both sides', () => {
  const db = freshDb();
  log(db, 'meituan_sync_log', 'tianhe', 'needs_login', 'error', T(9), 'signed out');
  const b = channelBlockFor(db, 'meituan', [{ code: 'tianhe' }]);
  eq([b.storeName, b.storeNameEn], ['tianhe', 'tianhe']);
});

// ── 4. The client defers to it, in one direction ─────────────────────────────
//
// Both the desktop's rule and the phone's twin are LIFTED out of the shipped
// files and run. A copy re-declared here would keep passing after somebody
// edited the product.
section('4 · an item’s generic failure defers to the channel’s cause');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CORE = read('public/retail-admin/01-core.js');
const PHONE = read('public/m.html');

function desktop(lang) {
  const m = CORE.match(/function chCauseSentence\(channel, code, detail\)[\s\S]*?\nwindow\.chCauseFor = chCauseFor;/);
  ok(m, 'the cause block was not found in 01-core.js — the anchor has drifted');
  const src = m[0].replace(/window\.\w+ = \w+;/g, '');
  return new Function('cuT', 'csChannelName', src + '; return { chCauseFor, chCauseLine, chBlockSentence };')(
    (en, cn) => (lang === 'cn' ? cn : en),
    (k) => (k === 'meituan' ? (lang === 'cn' ? '美团' : 'Meituan') : k === 'eleme' ? (lang === 'cn' ? '饿了么' : 'Eleme') : 'GZ Grocery'));
}
function phone(lang) {
  const m = PHONE.match(/function csBlockSentence\(ch,by\)\{[\s\S]*?\nfunction csBlockLine\(ch,blk\)\{[\s\S]*?\n\}/);
  ok(m, 'the block sentences were not found in public/m.html — the anchor has drifted');
  const cause = PHONE.match(/function csCause\(ch,c\)\{[\s\S]*?\n\}/);
  ok(cause, 'csCause was not found in public/m.html');
  const src = 'function csChName(k){return k===\'meituan\'?T(\'Meituan\',\'美团\'):k===\'eleme\'?T(\'Eleme\',\'饿了么\'):\'GZ Grocery\';}\n'
    + cause[0] + '\n' + m[0];
  return new Function('T', 'fmtDay', src + '; return { csCauseFor, csCause, csBlockSentence, csBlockLine };')(
    (en, cn) => (lang === 'cn' ? cn : en), (s) => String(s).slice(11, 16));
}

check('a captcha on the channel answers an item that only knows it could not connect', () => {
  const d = desktop('en');
  const cell = { error_code: 'unreachable', error: 'cannot reach Meituan' };
  eq(d.chCauseLine('meituan', cell), 'Cannot reach the sync service.');
  eq(d.chCauseFor('meituan', cell, { by: 'verify_required' }),
     'Meituan is asking for a captcha — a human has to pass it on the sync machine. Sync is paused.');
});

check('a REFUSAL keeps its own words — the channel cause never overwrites one', () => {
  // "Meituan refused it: 商品已下架" is a fact about this item that no channel
  // fault explains. Deferring here would lose the only actionable sentence.
  const d = desktop('en');
  const cell = { error_code: 'rejected', error_detail: '商品已下架 (code 8003)' };
  eq(d.chCauseFor('meituan', cell, { by: 'verify_required' }), 'Meituan returned: 商品已下架 (code 8003)');
  const gone = { error_code: 'option_gone' };
  eq(d.chCauseFor('meituan', gone, { by: 'needs_login' }),
     'The option this product is mapped to is no longer on the listing. Pick it again.');
});

check('no channel fault, no change', () => {
  const d = desktop('en');
  const cell = { error_code: 'unreachable', error: 'cannot reach Meituan' };
  eq(d.chCauseFor('meituan', cell, null), d.chCauseLine('meituan', cell));
  eq(d.chCauseFor('meituan', cell, { by: 'poll_paused' }), d.chCauseLine('meituan', cell),
     'an event with no sentence must not blank the item’s own');
});

check('an item with NO cause of its own takes the channel’s', () => {
  // The `gave_up` and null rows — everything written before §105 — are exactly
  // the ones the channel explains best.
  const d = desktop('en');
  eq(d.chCauseFor('meituan', { error_code: null, error: null }, { by: 'needs_login' }),
     'The sync service is signed out of Meituan. Sign in again.');
  eq(d.chCauseFor('meituan', { error_code: 'gave_up' }, { by: 'queue_stalled' }),
     'Stock updates stopped going out.');
});

check('the phone says the same thing, in both languages', () => {
  for (const lang of ['en', 'cn']) {
    const d = desktop(lang), p = phone(lang);
    for (const by of ['verify_required', 'needs_login', 'auth_required', 'proxy_down', 'proxy_stale', 'queue_stalled']) {
      eq(p.csBlockSentence('meituan', by), d.chBlockSentence('meituan', by), `${lang} · ${by}`);
    }
    const cell = { error_code: 'unreachable' };
    eq(p.csCauseFor('meituan', cell, { by: 'verify_required' }), d.chCauseFor('meituan', cell, { by: 'verify_required' }));
    eq(p.csCauseFor('meituan', cell, null), p.csCause('meituan', cell), 'no fault, the item’s own words');
  }
});

check('the phone’s card names the store and when it started', () => {
  const p = phone('en');
  eq(p.csBlockLine('meituan', { by: 'needs_login', at: '2026-09-12 09:14:00', storeName: '天河', storeNameEn: 'Tianhe' }),
     'The sync service is signed out of Meituan. Sign in again. · Tianhe · since 09:14');
  eq(p.csBlockLine('meituan', { by: 'poll_paused', at: '2026-09-12 09:14:00' }), '',
     'an event with no sentence renders nothing rather than a bare timestamp');
  eq(p.csBlockLine('meituan', null), '');
});

check('every event a descriptor can report has a sentence on both surfaces', () => {
  // A blocking event with no sentence would render an empty brick line. The
  // sentence table and the event lists have to grow together.
  const d = desktop('en'), p = phone('en');
  for (const [key, desc] of Object.entries(CHANNELS)) {
    for (const ev of desc.blocking) {
      ok(d.chBlockSentence(key, ev), `${key}/${ev} has no desktop sentence`);
      ok(p.csBlockSentence(key, ev), `${key}/${ev} has no phone sentence`);
    }
  }
});

// ── 5. The platform’s own codes ──────────────────────────────────────────────
//
// §106 asked for a code → what-to-do table and the evidence said there is
// nothing to write: all three codes the tree knows are handled before an
// operator can see them. What ships instead is the evidence path — the table
// records what is known, and scripts/report_reject_codes.js names what is not.
section('5 · the Meituan codes that are known, and the ones that are not');

check('the code comes back out of the sentence the browser layer writes', () => {
  eq(meituanCodeOf('Meituan refused it: 套餐中有商品已售罄 (code 10048)'), 10048);
  eq(meituanCodeOf('Meituan refused it: 商品不存在 (code 8003)'), 8003);
  eq(meituanCodeOf('cannot reach Meituan (HTTP 502)'), null, 'an HTTP status is not a business code');
  eq(meituanCodeOf('Meituan refused it: 参数异常'), null, 'a refusal with no code');
  eq(meituanCodeOf(null), null);
});

check('every known code says what it means AND where it is already handled', () => {
  const codes = Object.keys(MEITUAN_CODES);
  ok(codes.length >= 3, 'expected the three codes the tree has met');
  for (const c of codes) {
    ok(/^\d+$/.test(c), 'a code that is not a number: ' + c);
    ok(MEITUAN_CODES[c].means, c + ' has no meaning recorded');
    ok(/\.js/.test(MEITUAN_CODES[c].handled || ''), c + ' does not name the file that handles it');
  }
});

check('the tally only counts stated refusals, never our own giving up', () => {
  // What the report script keys on. "retries exhausted" is a count of our
  // attempts; it must never be filed as something the platform said.
  eq(classifyPushError('Meituan refused it: 商品不存在 (code 8003)').code, 'rejected');
  eq(classifyPushError('transient push failure — retries exhausted').code, 'gave_up');
  eq(classifyPushError('cannot reach Meituan (HTTP 502)').code, 'http');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
