#!/usr/bin/env node
/**
 * The voice assistant (§495) — what a plan may contain, what it suggests, and
 * which route each row calls.
 *
 *   node scripts/test_assistant_plan.js
 *
 * lib/assistant.js asks the model for a plan through one forced tool and then
 * keeps only what the tenant's catalogue holds. This file runs the pure half
 * with no model, against a catalogue built from an in-memory SQLite that
 * carries the real tables:
 *   • the catalogue reads stores, shops, made-here listings with their
 *     answers (and which are already off), and products;
 *   • an action pointing at an id that does not exist, a listing at the wrong
 *     shop, an answer the item does not offer, a negative or zero quantity, or
 *     a missing on/off is dropped;
 *   • a question keeps only options the catalogue holds;
 *   • switching an answer at one shop suggests the same answer on the shop's
 *     other made-here items — only where it is not already in that state,
 *     and never at another shop;
 *   • every row names a route that already exists, with the body it expects;
 *   • the words on a row name the shop, the item and the answer in both
 *     languages;
 *   • the prompt carries the catalogue, today's open/closed state, the
 *     person's own names and an earlier answer;
 *   • a question is answered from the records at plan time, by the rules the
 *     screens use (the order-date rule on the shop's clock, the low-stock
 *     rule, the shelf), only to an operator whose capabilities would let them
 *     open that screen, and a plan of only answers has no rows to approve.
 */
'use strict';

const Database = require('better-sqlite3');
const A = require('../lib/assistant');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, code TEXT, name_en TEXT, name_cn TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, timezone TEXT DEFAULT 'Asia/Shanghai');
  CREATE TABLE shops (id INTEGER PRIMARY KEY, location_id INTEGER, display_name_en TEXT, display_name_cn TEXT, is_active INTEGER DEFAULT 1);
  CREATE TABLE store_products (id INTEGER PRIMARY KEY, sku TEXT, name_en TEXT, name_cn TEXT, variant_label TEXT, variant_label_cn TEXT, is_active INTEGER DEFAULT 1,
    status TEXT DEFAULT 'Active', is_published INTEGER DEFAULT 1, low_stock_threshold INTEGER, stock_qty INTEGER DEFAULT 0);
  CREATE TABLE retail_orders (id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, store_id INTEGER, placed_at DATETIME, paid_at DATETIME, replacement_for_order_id INTEGER);
  CREATE TABLE retail_store_stock (store_id INTEGER, product_id INTEGER, physical_qty INTEGER, PRIMARY KEY (store_id, product_id));
  CREATE TABLE shop_listings (id INTEGER PRIMARY KEY, shop_id INTEGER, store_product_id INTEGER, fulfilment_mode TEXT, is_available INTEGER DEFAULT 1, sort_position INTEGER DEFAULT 0);
  CREATE TABLE retail_product_options (id INTEGER PRIMARY KEY, product_id INTEGER, question_en TEXT, sort_order INTEGER DEFAULT 0);
  CREATE TABLE retail_product_option_choices (id INTEGER PRIMARY KEY, option_id INTEGER, label_en TEXT, label_cn TEXT);
  CREATE TABLE shop_option_choices_off (shop_id INTEGER, store_product_id INTEGER, label TEXT, PRIMARY KEY (shop_id, store_product_id, label));
  CREATE TABLE store_business_status (store_code TEXT PRIMARY KEY, fulfillment_open INTEGER);
  CREATE TABLE storefront_config (key TEXT PRIMARY KEY, value_json TEXT);
  INSERT INTO retail_stores VALUES (1,'tianhe','Tianhe','天河',1,0,'Asia/Shanghai'),(2,'yuexiu','Yuexiu','越秀',1,1,'Asia/Shanghai');
  INSERT INTO shops VALUES (10,1,NULL,NULL,1),(20,2,NULL,NULL,1);
  INSERT INTO store_products (id,sku,name_en,name_cn,variant_label,variant_label_cn,is_active) VALUES (100,'OT-1','Open Toast','开放三明治',NULL,NULL,1),(101,'CS-1','Club Sandwich','俱乐部三明治',NULL,NULL,1),
    (102,'HP-1','Hummus Platter','鹰嘴豆泥拼盘','Large','大',1),(103,'1-50','Hummus classic','鹰嘴豆泥',NULL,NULL,1),(104,'BG-1','Bagel','贝果',NULL,NULL,1);
  -- today's orders, on the shop's clock: three paid at Yuexiu, one at Tianhe, one unpaid, one from yesterday
  INSERT INTO retail_orders (id,order_no,status,store_id,placed_at,paid_at) VALUES (1,'TC000001','paid',2,datetime('now'),datetime('now')),(2,'TC000002','preparing',2,datetime('now'),datetime('now')),
    (3,'TC000003','delivered',2,datetime('now','-1 hour'),datetime('now','-1 hour')),(4,'TC000004','paid',1,datetime('now'),datetime('now')),
    (5,'TC000005','pending_payment',2,datetime('now'),NULL),(6,'TC000006','paid',2,datetime('now','-2 days'),datetime('now','-2 days'));
  -- the shelf: hummus 3 at Yuexiu (low), bagel 40 at Yuexiu, hummus 12 at Tianhe, toast 0 at Yuexiu (out, not low)
  INSERT INTO retail_store_stock VALUES (2,103,3),(2,104,40),(1,103,12),(2,100,0);
  -- Yuexiu's menu: three made-here items, two with Whole wheat bread; one stocked item
  INSERT INTO shop_listings VALUES (1,20,100,'made_here',1,0),(2,20,101,'made_here',1,1),(3,20,102,'made_here',1,2),(4,20,104,'stocked',1,3);
  -- Tianhe also sells Open Toast made here
  INSERT INTO shop_listings VALUES (5,10,100,'made_here',1,0);
  INSERT INTO retail_product_options VALUES (1,100,'Bread',0),(2,101,'Bread',0),(3,102,'Crunchy side',0),(4,101,'Side',1);
  INSERT INTO retail_product_option_choices VALUES (1,1,'Whole wheat bread','全麦面包'),(2,1,'White bread','白面包'),
    (3,2,'Whole wheat bread','全麦面包'),(4,2,'Rye','黑麦'),(5,3,'Whole wheat crackers','全麦饼干'),(6,3,'Veggie sticks','蔬菜条'),
    (7,4,'Whole wheat bread','全麦面包');
  INSERT INTO shop_option_choices_off VALUES (20,101,'Whole wheat bread');
  INSERT INTO store_business_status VALUES ('tianhe',1),('yuexiu',0);
  INSERT INTO storefront_config VALUES ('store_status','{"online_open":true}');
`);
const cat = A.catalogue(db);

console.log('\nThe catalogue');
{
  eq(cat.stores.length, 2, 'two stores');
  eq(cat.shops.length, 2, 'two shops');
  eq(cat.shops.find(s => s.id === 20).name_en, 'Yuexiu', 'a shop without its own name wears its store\'s');
  eq(cat.listings.length, 4, 'four made-here listings, the stocked bagel left out');
  const ot = cat.listings.find(l => l.id === 1);
  eq(ot.answers.map(a => a.label).join(','), 'Whole wheat bread,White bread', 'Open Toast offers two answers');
  const cs = cat.listings.find(l => l.id === 2);
  eq(cs.answers.length, 2, 'Club Sandwich offers Whole wheat bread once, though two questions carry it');
  eq(cs.answers.find(a => a.label === 'Whole wheat bread').off, true, 'and it is already off at Yuexiu');
  eq(ot.answers.find(a => a.label === 'Whole wheat bread').off, false, 'while Open Toast\'s is on');
  eq(cat.products.length, 5, 'five products for stock');
  const text = A.catalogueText(cat);
  ok(text.indexOf('shop 20 | store 2 | Yuexiu | 越秀') > -1, 'the prompt lists the shop with its store');
  ok(text.indexOf('listing 2 | Club Sandwich / 俱乐部三明治 | CS-1 | Whole wheat bread / 全麦面包 [off]; Rye / 黑麦') > -1, 'and each item\'s answers, marking the one already off');
  ok(text.indexOf('listing 3 | Hummus Platter Large / 鹰嘴豆泥拼盘 大 |') > -1, 'a variant carries its size');
  const dyn = A.dynamicText({ cat, names: [{ heard: 'ramada', kind: 'store', target_id: 2 }], answers: { store_id: 2 }, lang: 'zh' });
  ok(dyn.indexOf('Tianhe is open, Yuexiu is closed; the online store is open') > -1, 'today\'s state is stated');
  ok(dyn.indexOf('"ramada" means store 2') > -1, 'the person\'s own names are passed on');
  ok(dyn.indexOf('store_id = 2') > -1, 'and an earlier answer');
  ok(dyn.indexOf('Chinese mode') > -1, 'and the language');
}

console.log('\nKeeping only what exists');
{
  let p = A.coercePlan({ say: 'ok', actions: [
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: true },
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'whole wheat bread', off: true },
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: '全麦面包', off: false },
    { type: 'answer_switch', shop_id: 10, listing_id: 1, label: 'Whole wheat bread', off: true },
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Rye', off: true },
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'White bread', off: 'yes' },
    { type: 'answer_switch', shop_id: 20, listing_id: 4, label: 'Whole wheat bread', off: true },
    { type: 'stock', store_id: 2, product_id: 103, mode: 'set', qty: 0 },
    { type: 'stock', store_id: 2, product_id: 103, mode: 'add', qty: 0 },
    { type: 'stock', store_id: 2, product_id: 999, mode: 'set', qty: 3 },
    { type: 'stock', store_id: 2, product_id: 103, mode: 'set', qty: -1 },
    { type: 'shop_open', scope: 'store', store_id: 2, open: false },
    { type: 'shop_open', scope: 'store', store_id: 9, open: false },
    { type: 'shop_open', scope: 'all', open: true },
    { type: 'shop_open', scope: 'online', open: false, message: 'Back at 5' },
    { type: 'shop_open', scope: 'store', store_id: 1 },
    { type: 'delete_everything' },
  ], question: null, unknown_names: [] }, cat);
  eq(p.actions.length, 7, 'seven kept of seventeen');
  eq(p.dropped, 10, 'ten dropped');
  eq(p.actions[0].label, 'Whole wheat bread', 'the answer as the item spells it');
  eq(p.actions[1].label, 'Whole wheat bread', 'a lower-case answer is the same answer');
  eq(p.actions[2].label + '/' + p.actions[2].off, 'Whole wheat bread/false', 'the Chinese label is the same answer, switched back on');
  eq(p.actions[3].type + ':' + p.actions[3].qty, 'stock:0', 'sold out is a count of 0');
  eq(p.actions[4].scope + ':' + p.actions[4].store_id, 'store:2', 'closing one store');
  eq(p.actions[5].scope, 'all', 'the whole business');
  eq(p.actions[6].message, 'Back at 5', 'the online store with a message');
  p = A.coercePlan({ say: 'which?', actions: [], question: { kind: 'store', text: 'Which store?', option_ids: [1, 2, 9, 2] }, unknown_names: ['Ramada', ''] }, cat);
  eq(p.question.option_ids.join(','), '1,2', 'a question keeps only real options, once each');
  eq(p.unknown_names.join(','), 'Ramada', 'and the name it could not place');
  p = A.coercePlan(null, cat);
  eq(p.actions.length + (p.question ? 1 : 0), 0, 'nothing in, nothing out');
}

console.log('\nWhat it suggests');
{
  const asked = [{ type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: true }];
  let s = A.suggest(cat, asked);
  eq(s.length, 0, 'Club Sandwich already has it off at Yuexiu, so nothing to suggest for off');
  const back = [{ type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: false }];
  s = A.suggest(cat, back);
  eq(s.length, 1, 'switching it back on suggests the sandwich, where it is off');
  eq(s[0].listing_id + ':' + s[0].off + ':' + s[0].suggested, '2:false:true', 'as a suggestion, same answer, same state');
  db.prepare('DELETE FROM shop_option_choices_off').run();
  const cat2 = A.catalogue(db);
  s = A.suggest(cat2, asked);
  eq(s.length, 1, 'with nothing off yet, switching off suggests the sandwich');
  ok(!s.some(x => x.shop_id === 10), 'and never Tianhe, which sells Open Toast too');
  const crackers = [{ type: 'answer_switch', shop_id: 20, listing_id: 3, label: 'Whole wheat crackers', off: true }];
  eq(A.suggest(cat2, crackers).length, 0, 'crackers are offered by one item only: nothing to suggest');
  const two = [...asked, { type: 'answer_switch', shop_id: 20, listing_id: 2, label: 'Whole wheat bread', off: true }];
  eq(A.suggest(cat2, two).length, 0, 'an item already in the plan is not suggested again');
}

console.log('\nThe routes and the words');
{
  const cat2 = A.catalogue(db);
  let c = A.toCmd({ type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: true }, cat2);
  eq(c.method + ' ' + c.path, 'PUT /api/retail-admin/shops/20/listings/1/choices/1/off', 'the §492 switch, by the choice id carrying the label');
  eq(c.body.off, true, 'off');
  c = A.toCmd({ type: 'stock', store_id: 2, product_id: 103, mode: 'set', qty: 0 }, cat2);
  eq(c.method + ' ' + c.path, 'PATCH /api/retail-admin/stores/2/stock/103', 'the stock route');
  eq(c.body.physical_qty, 0, 'an absolute count');
  c = A.toCmd({ type: 'stock', store_id: 2, product_id: 103, mode: 'add', qty: 5 }, cat2);
  eq(c.body.delta + ':' + c.body.reason, '5:kitchen_add', 'an add is a delta');
  c = A.toCmd({ type: 'shop_open', scope: 'store', store_id: 2, open: false }, cat2);
  eq(c.method + ' ' + c.path, 'POST /api/retail-admin/store-status/store/yuexiu', 'one store, by its code');
  c = A.toCmd({ type: 'shop_open', scope: 'all', open: true }, cat2);
  eq(c.path, '/api/retail-admin/store-status/master', 'everything');
  c = A.toCmd({ type: 'shop_open', scope: 'online', open: false, message: 'Back at 5' }, cat2);
  eq(c.path + ' ' + c.body.message_en, '/api/retail-admin/store-status/online Back at 5', 'the online store, with its message');
  let d = A.describe({ type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: true }, cat2);
  eq(d.en, 'Switch off Whole wheat bread on Open Toast at Yuexiu', 'the row in English');
  eq(d.zh, '在越秀关闭开放三明治的全麦面包', 'and in Chinese');
  d = A.describe({ type: 'answer_switch', shop_id: 20, listing_id: 3, label: 'Whole wheat crackers', off: false }, cat2);
  eq(d.en, 'Switch back on Whole wheat crackers on Hummus Platter Large at Yuexiu', 'a variant names its size');
  d = A.describe({ type: 'stock', store_id: 2, product_id: 103, mode: 'set', qty: 0 }, cat2);
  eq(d.en + ' · ' + d.zh, 'Mark Hummus classic sold out at Yuexiu · 将越秀的鹰嘴豆泥设为售罄', 'sold out');
  d = A.describe({ type: 'stock', store_id: 2, product_id: 103, mode: 'add', qty: 5 }, cat2);
  eq(d.en + ' · ' + d.zh, 'Add 5 Hummus classic at Yuexiu · 在越秀为鹰嘴豆泥加 5 件', 'an add');
  d = A.describe({ type: 'shop_open', scope: 'store', store_id: 2, open: false }, cat2);
  eq(d.en + ' · ' + d.zh, 'Close Yuexiu · 关闭越秀', 'close a store');
  const plan = A.buildPlan(A.coercePlan({ say: 'Switch off whole wheat bread on Open Toast at Yuexiu.', actions: [
    { type: 'answer_switch', shop_id: 20, listing_id: 1, label: 'Whole wheat bread', off: true }], question: null, unknown_names: [] }, cat2), cat2, 'en');
  eq(plan.actions.length, 2, 'the plan carries the asked row and the suggested one');
  eq(plan.actions[0].suggested + ':' + plan.actions[1].suggested, 'false:true', 'in that order');
  eq(plan.actions[1].label_en, 'Switch off Whole wheat bread on Club Sandwich at Yuexiu', 'the suggestion in words');
  ok(plan.actions.every(a => a.key && a.cmd && a.label_cn), 'every row has a key, a route and both languages');
  const q = A.buildPlan(A.coercePlan({ say: '?', actions: [], question: { kind: 'store', text: 'Which store?', option_ids: [1, 2] }, unknown_names: ['Ramada'] }, cat2), cat2, 'zh');
  eq(q.question.options.map(o => o.label).join(','), '天河,越秀', 'a question\'s options are named in the phone\'s language');
  eq(q.actions.length, 0, 'and a question has no rows');
}

console.log('\nQuestions, answered from the records');
{
  const cat2 = A.catalogue(db);
  const all = null;   // RBAC dark: every question answers
  let a = A.answerOne(db, { type: 'ask', what: 'orders_today', store_id: 2, product_id: null }, cat2, all);
  eq(a.n, 3, 'three paid orders today at Yuexiu — not the unpaid one, not yesterday\'s');
  eq(a.text_en, '3 orders today at Yuexiu', 'in English');
  eq(a.text_cn, '越秀今天 3 单', 'and in Chinese');
  a = A.answerOne(db, { type: 'ask', what: 'orders_today', store_id: null, product_id: null }, cat2, all);
  eq(a.n + ' ' + a.text_en, '4 4 orders today across all stores', 'four across all stores');
  a = A.answerOne(db, { type: 'ask', what: 'orders_today', store_id: 1, product_id: null }, cat2, all);
  eq(a.text_en, '1 order today at Tianhe', 'one order, singular');
  db.prepare("UPDATE retail_orders SET placed_at = datetime('now','-3 days'), paid_at = datetime('now','-3 days') WHERE store_id = 1").run();
  a = A.answerOne(db, { type: 'ask', what: 'orders_today', store_id: 1, product_id: null }, cat2, all);
  eq(a.text_en + ' · ' + a.text_cn, 'No orders yet today at Tianhe · 天河今天还没有订单', 'none yet');
  a = A.answerOne(db, { type: 'ask', what: 'low_stock', store_id: 2, product_id: null }, cat2, all);
  eq(a.n, 1, 'one product is low at Yuexiu: hummus at 3; the toast at 0 is out, not low; the bagel at 40 is fine');
  eq(a.text_en, 'Running low at Yuexiu: Hummus classic (3)', 'named with its count');
  eq(a.text_cn, '越秀库存偏低：鹰嘴豆泥（3）', 'in Chinese');
  a = A.answerOne(db, { type: 'ask', what: 'low_stock', store_id: 1, product_id: null }, cat2, all);
  eq(a.text_en, 'Nothing is running low at Tianhe.', 'nothing low at Tianhe');
  a = A.answerOne(db, { type: 'ask', what: 'low_stock', store_id: null, product_id: null }, cat2, all);
  ok(a.text_en.indexOf('Running low') === 0 || a.text_en.indexOf('Nothing') === 0, 'across all stores it answers by the digest\'s own rule');
  a = A.answerOne(db, { type: 'ask', what: 'stock_of', store_id: 2, product_id: 103 }, cat2, all);
  eq(a.text_en + ' · ' + a.text_cn, 'Hummus classic at Yuexiu: 3 · 越秀的鹰嘴豆泥：3', 'the shelf at one store');
  a = A.answerOne(db, { type: 'ask', what: 'stock_of', store_id: null, product_id: 103 }, cat2, all);
  eq(a.text_en, 'Hummus classic: Tianhe 12, Yuexiu 3', 'and at every store');
  a = A.answerOne(db, { type: 'ask', what: 'status', store_id: null, product_id: null }, cat2, all);
  eq(a.text_en, 'Tianhe is open; Yuexiu is closed; the online store is open', 'who is open');
  eq(a.text_cn, '天河营业中；越秀已关闭；网店营业中', 'in Chinese');
  a = A.answerOne(db, { type: 'ask', what: 'status', store_id: 2, product_id: null }, cat2, all);
  eq(a.text_en, 'Yuexiu is closed', 'one store');
  const clerk = new Set(['quickstock:recount']);
  a = A.answerOne(db, { type: 'ask', what: 'orders_today', store_id: 2, product_id: null }, cat2, clerk);
  eq(a.refused + ' ' + a.text_en, 'true You don’t have permission for this', 'a clerk cannot hear the order count');
  a = A.answerOne(db, { type: 'ask', what: 'stock_of', store_id: 2, product_id: 103 }, cat2, clerk);
  eq(a.refused, undefined, 'but can hear the shelf');
  ok(A.mayAsk(new Set(['dashboard:view']), 'orders_today') && !A.mayAsk(new Set(['till:use']), 'orders_today') && A.mayAsk(new Set(['till:use']), 'status'), 'the capability rule per question');
  const p = A.coercePlan({ say: 'ok', actions: [
    { type: 'ask', what: 'orders_today', store_id: 2 }, { type: 'ask', what: 'stock_of', store_id: 2, product_id: 103 },
    { type: 'ask', what: 'stock_of', store_id: 2 }, { type: 'ask', what: 'weather' }, { type: 'ask', what: 'status', store_id: 9 }], question: null, unknown_names: [] }, cat2);
  eq(p.actions.length, 2, 'a question without its product, an unknown question and an unknown store are dropped');
  const plan = A.buildPlan(p, cat2, 'en', A.answerAll(db, p.actions, cat2, all));
  eq(plan.actions.length, 0, 'questions are not rows');
  eq(plan.answers.length, 2, 'they are answers');
  eq(plan.answers[0].text_en, '3 orders today at Yuexiu', 'in order');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
