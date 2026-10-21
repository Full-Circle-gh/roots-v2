#!/usr/bin/env node
/**
 * The sentence log (§493 rule 10) — what is kept, what may change, and what
 * the week's reading says.
 *
 *   node scripts/test_quick_stock_said.js
 *
 * lib/quick-stock-said.js shapes what the phone sends, holds the SQL the
 * routes run, and summarises a week. This file runs that SQL against an
 * in-memory SQLite with the table created from the same statement
 * database.js uses, so the log's statements are proven without the app:
 *   • a sentence is kept with only the fields it may carry;
 *   • an outcome moves forward and never off "confirmed";
 *   • another operator cannot change a row;
 *   • the listing joins product and store names and reads newest first;
 *   • the summary counts the cases that decide what to build next;
 *   • the CSV opens in Excel with its Chinese intact.
 */
'use strict';

const Database = require('better-sqlite3');
const said = require('../lib/quick-stock-said');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)})`);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE store_products (id INTEGER PRIMARY KEY, sku TEXT, name_en TEXT, name_cn TEXT);
  CREATE TABLE retail_stores (id INTEGER PRIMARY KEY, name_en TEXT, name_cn TEXT);
  INSERT INTO store_products VALUES (7,'1-10','Hummus Asli','鹰嘴豆泥'),(8,'1-15','Turkish Tomato Salad','土耳其番茄沙拉');
  INSERT INTO retail_stores VALUES (1,'Tianhe','天河'),(2,'Yuexiu','越秀');
`);
db.exec(said.SQL.create);

console.log('\nShaping what the phone sends');
{
  const row = said.shapeNew({ said: '  homeless 5 left  ', via: 'voice', lang: 'zh', read_by: 'model', product_id: 7,
    candidate_ids: [], store_id: '1', action: 'set', qty: 5, outcome: 'shown', picked_product_id: 99, user_key: 'b:999' }, 'b:1');
  eq(row.user_key, 'b:1', 'the operator is the session\'s, never the body\'s');
  eq(row.said, 'homeless 5 left', 'the sentence is trimmed');
  eq(row.via, 'voice', 'voice is kept');
  eq(row.lang, 'zh', 'the language is kept');
  eq(row.read_by, 'model', 'who read it is kept');
  eq(row.store_id, 1, 'a store id sent as a string is read');
  eq(row.picked_product_id, null, 'a pick cannot arrive with the sentence');
  eq(said.shapeNew({ said: '' }, 'b:1'), null, 'no sentence, no row');
  const junk = said.shapeNew({ said: 'x', via: 'shout', lang: 'fr', read_by: 'god', action: 'delete', qty: -1, outcome: 'confirmed', candidate_ids: [7, 'a', 8, 8, 9, 10, 11, 12] }, 'b:1');
  eq(junk.via, 'typed', 'an unknown via is typed');
  eq(junk.lang, null, 'an unknown language is none');
  eq(junk.read_by, 'none', 'an unknown reader is none');
  eq(junk.action, null, 'an unknown action is dropped');
  eq(junk.qty, null, 'a negative quantity is dropped');
  eq(junk.outcome, 'shown', 'a sentence cannot arrive already confirmed');
  eq(junk.candidate_ids, '[7,8,8,9,10]', 'candidates are integers, at most five');
  eq(said.shapeNew({ said: 'x'.repeat(400) }, 'b:1').said.length, 300, 'a sentence is cut at 300');
  eq(said.shapeOutcome({ outcome: 'confirmed', picked_product_id: '8' }).picked_product_id, 8, 'a pick sent as a string is read');
  eq(said.shapeOutcome({ outcome: 'shown' }), null, 'shown is not an outcome to move to');
  eq(said.shapeOutcome({}), null, 'nothing to change is null');
}

console.log('\nThe statements');
{
  const ins = db.prepare(said.SQL.insert);
  const a = ins.run(said.shapeNew({ said: 'homeless 5 left', via: 'voice', lang: 'en', read_by: 'model', product_id: 7, store_id: 1, action: 'set', qty: 5 }, 'b:1')).lastInsertRowid;
  const b = ins.run(said.shapeNew({ said: 'tomato 4', via: 'typed', read_by: 'phone', candidate_ids: [7, 8], store_id: 1, qty: 4 }, 'b:1')).lastInsertRowid;
  const c = ins.run(said.shapeNew({ said: 'zebra', via: 'voice', lang: 'zh', read_by: 'none', outcome: 'no_card' }, 'b:2')).lastInsertRowid;
  const upd = db.prepare(said.SQL.outcome);
  eq(upd.run({ id: a, user_key: 'b:1', outcome: 'confirmed', picked_product_id: null }).changes, 1, 'the operator confirms their row');
  eq(upd.run({ id: a, user_key: 'b:1', outcome: 'cancelled', picked_product_id: null }).changes, 0, 'and a confirmed row never moves back');
  eq(upd.run({ id: b, user_key: 'b:1', outcome: null, picked_product_id: 8 }).changes, 1, 'a pick lands without an outcome');
  eq(upd.run({ id: b, user_key: 'b:1', outcome: 'confirmed', picked_product_id: null }).changes, 1, 'then the confirm');
  eq(db.prepare('SELECT picked_product_id FROM quick_stock_said WHERE id = ?').get(b).picked_product_id, 8, 'and the pick is kept through it');
  eq(upd.run({ id: c, user_key: 'b:1', outcome: 'cancelled', picked_product_id: null }).changes, 0, 'another operator cannot touch a row');
  eq(upd.run({ id: c, user_key: 'b:2', outcome: 'cancelled', picked_product_id: null }).changes, 1, 'its own operator can');
  db.prepare("UPDATE quick_stock_said SET created_at = datetime('now', '-100 days') WHERE id = ?").run(c);
  db.prepare(said.SQL.prune).run();
  eq(db.prepare('SELECT COUNT(*) AS n FROM quick_stock_said').get().n, 2, 'a row older than 90 days is pruned');
  const rows = db.prepare(said.SQL.list).all({ days: 7, limit: 100 });
  eq(rows.length, 2, 'the week lists both');
  eq(rows[0].said, 'tomato 4', 'newest first');
  eq(rows[1].card_product, 'Hummus Asli', 'the card\'s product is named');
  eq(rows[1].card_sku, '1-10', 'with its sku');
  eq(rows[0].picked_product, 'Turkish Tomato Salad', 'the pick is named');
  eq(rows[1].store, 'Tianhe', 'and the store');
  eq(db.prepare(said.SQL.list).all({ days: 7, limit: 1 }).length, 1, 'the limit holds');
}

console.log('\nThe week\'s reading');
{
  const rows = [
    { outcome: 'confirmed', product_id: 7, picked_product_id: null, read_by: 'phone', via: 'voice', lang: 'en' },
    { outcome: 'confirmed', product_id: 7, picked_product_id: 8, read_by: 'model', via: 'voice', lang: 'zh' },
    { outcome: 'no_card', product_id: null, picked_product_id: null, read_by: 'none', via: 'voice', lang: 'zh' },
    { outcome: 'back', product_id: 8, picked_product_id: null, read_by: 'phone', via: 'typed', lang: null },
    { outcome: 'shown', product_id: 8, picked_product_id: null, read_by: 'model', via: 'typed', lang: null },
  ];
  const s = said.summarise(rows);
  eq(s.sentences, 5, 'five sentences');
  eq(s.confirmed, 2, 'two confirmed');
  eq(s.picked_other, 1, 'one of them after picking another product — the reader was wrong');
  eq(s.no_card, 1, 'one found nothing — the hearing was probably wrong');
  eq(s.back_or_cancelled, 1, 'one abandoned');
  eq(s.by_model, 2, 'two read by the model');
  eq(s.voice, 3, 'three by voice');
  eq(s.typed, 2, 'two typed');
  eq(s.zh, 2, 'two in Chinese');
  eq(s.en, 1, 'one in English');
}

console.log('\nThe CSV');
{
  const csv = said.toCsv([{ created_at: '2026-10-22 01:02:03', user_name: 'Rui', said: '鹰嘴豆泥, 剩 "3"', via: 'voice', lang: 'zh', read_by: 'phone',
    card_product: 'Hummus Asli', card_sku: '1-10', candidates: null, store: 'Tianhe', action: 'set', qty: 3, outcome: 'confirmed', picked_product: null, picked_sku: null }]);
  ok(csv.charCodeAt(0) === 0xfeff, 'a BOM, so Excel reads the Chinese');
  ok(csv.indexOf(said.CSV_COLUMNS.join(',')) === 1, 'the header row names every column');
  ok(csv.indexOf('"鹰嘴豆泥, 剩 ""3"""') > -1, 'a sentence with a comma and quotes is quoted and escaped');
  ok(csv.indexOf(',Rui,') > -1, 'the operator is a name');
  ok(/\r\n$/.test(csv), 'and every line ends the way Excel expects');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
