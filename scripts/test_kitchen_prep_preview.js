#!/usr/bin/env node
/**
 * §432 — the evening before, the kitchen's WeCom group is told what to make.
 *
 *   node scripts/test_kitchen_prep_preview.js
 *
 * WHAT IS BEING PROTECTED, because "a message is sent" is the easy half:
 *
 *   • THE LIST IS THE SLIP'S LIST. The lines come from the same function the
 *     06:00 request is raised from, for the same date — so the message and
 *     the slip can differ only in when they looked, never in what counts.
 *   • THE PREVIEW IS SENT ONCE. The guard is a database row, so a restart at
 *     20:31 does not send it again.
 *   • AN UPDATE GOES ONLY WHEN THE LIST CHANGED, and not sooner than 30
 *     minutes after the last message — one update for a run of orders, not a
 *     ping per order in a group at night.
 *   • NOTHING TO MAKE IS SILENCE (Ash: "stay quiet") — except a list that
 *     empties after a preview, where silence would leave people making it.
 *   • THE WINDOW is the send time until the morning hour, across midnight,
 *     and the date named is the morning the slip prints.
 *   • THE WEBHOOK IS PRIVATE: the public config never serves it.
 *
 * Runs against the real sqlite database (data/roots.db, created by database.js
 * on require and gitignored), with the fixture shape of
 * test_kitchen_morning_request.js.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'database.js'));
const { tdb } = require(path.join(ROOT, 'lib', 'tenant-db.js'));
const morning = require(path.join(ROOT, 'lib', 'kitchen-morning-request.js'));
const prep = require(path.join(ROOT, 'lib', 'kitchen-prep-preview.js'));

const db = tdb();

let pass = 0, fail = 0;
const queue = [];
function it(name, fn) { queue.push({ name, fn }); }
const section = (t) => queue.push({ section: t });

// ── Fixtures ───────────────────────────────────────────────────────────────
const STORE = 9431;
const P_WRAP = 9531;   // batch-made
const P_BOWL = 9532;   // batch-made
const ORDER = 9631;

const TZ = 'Asia/Shanghai';
const DAY = '2031-04-07';          // the evening
const NEXT = '2031-04-08';         // the morning the slip prints
const at = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+08:00`);
const HOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-431';

function setCfg(key, v) {
  if (v === undefined) {
    db.prepare('DELETE FROM storefront_config WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(key, JSON.stringify(v));
}

function park(orderId, lines) {
  db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(orderId);
  db.prepare('DELETE FROM retail_orders WHERE id = ?').run(orderId);
  db.prepare(
    `INSERT INTO retail_orders (id, order_no, store_id, status, channel, subtotal, total)
     VALUES (?,?,?,'awaiting_restock','wechat',0,0)`
  ).run(orderId, `TP${orderId}`, STORE);
  const ins = db.prepare(
    `INSERT INTO retail_order_items (order_id, product_id, name_en, name_cn, qty, unit_price, line_total)
     VALUES (?,?,'x','x',?,0,0)`
  );
  for (const l of lines) ins.run(orderId, l.product_id, l.qty);
}

function clearOrders() {
  for (const id of [ORDER, ORDER + 1, ORDER + 2]) {
    db.prepare('DELETE FROM retail_order_items WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM retail_orders WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM retail_store_stock WHERE product_id IN (?,?)').run(P_WRAP, P_BOWL);
}
function clearMessages() {
  db.prepare('DELETE FROM kitchen_prep_messages WHERE prep_date IN (?,?)').run(DAY, NEXT);
}
function rows() {
  return db.prepare('SELECT * FROM kitchen_prep_messages WHERE prep_date IN (?,?) ORDER BY id').all(DAY, NEXT);
}

// Saved state of the tenant's own settings, put back at the end — this suite
// shares a dev database with every other one.
const SAVED = {};
for (const k of [prep.KEY_WEBHOOK, prep.KEY_TIME, 'fresh.morningRequestHour']) {
  const r = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(k);
  SAVED[k] = r ? JSON.parse(r.value_json) : undefined;
}

function baseline() {
  clearOrders(); clearMessages();
  setCfg(prep.KEY_WEBHOOK, HOOK);
  setCfg(prep.KEY_TIME, undefined);       // the default, 20:30
  setCfg('fresh.morningRequestHour', 6);
}

function seed() {
  clearOrders(); clearMessages();
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_WRAP, P_BOWL);
  db.prepare("DELETE FROM store_products WHERE sku IN ('9-531','9-532')").run();
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  db.prepare(
    `INSERT INTO retail_stores (id, code, name_en, name_cn, city, district, is_active, sort_order)
     VALUES (?,?,?,?,?,?,1,1)`
  ).run(STORE, 'tkp-a', 'Tianhe', '天河', '广州市', '天河区');
  const prod = db.prepare(
    `INSERT INTO store_products (id, name_en, name_cn, sku, sell_price, is_batch_made, is_published, is_active)
     VALUES (?,?,?,?,?,1,1,1)`
  );
  prod.run(P_WRAP, 'Pesto Wrap', '青酱卷', '9-531', 48);
  prod.run(P_BOWL, 'Beef Bowl', '牛肉饭', '9-532', 58);
}

const plan = (ymd, hhmm) => prep.planPrepMessage(db, { now: at(ymd, hhmm), tz: TZ });
const landed = (p) => { prep.recordResult(db, p.id, { ok: true }); return p; };

seed();

// ═══════════════════════════════════════════════════════════════════════════
section('1 · the evening preview');
{
  it('before the send time nothing is due', () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 18 }]);
    assert.deepStrictEqual(plan(DAY, '20:29'), { skipped: 'not_due' });
    assert.strictEqual(rows().length, 0);
  });

  it('at 20:30 eighteen parked wraps become one preview about tomorrow', () => {
    const p = plan(DAY, '20:30');
    assert.ok(p.id, JSON.stringify(p));
    assert.strictEqual(p.kind, 'preview');
    assert.strictEqual(p.date, NEXT, 'the date named is the morning the slip prints');
    assert.strictEqual(p.url, HOOK);
    assert.ok(p.content.includes(`**🍳 待制作 · To make — ${NEXT}**`), p.content);
    assert.ok(p.content.includes('> 预览,最终清单于 06:00 打印 · Preview — the final list prints at 06:00'));
    assert.ok(p.content.includes('> **SKU 9-531** 青酱卷 Pesto Wrap × 18'), p.content);
    const r = rows();
    assert.strictEqual(r.length, 1, 'the row is claimed before the send');
    assert.strictEqual(r[0].ok, null, 'in flight until the send answers');
    landed(p);
    assert.strictEqual(rows()[0].ok, 1);
  });

  it('the lines are exactly the slip\'s lines for that morning', () => {
    const slip = morning.owedLines(db, { today: NEXT });
    assert.deepStrictEqual(JSON.parse(rows()[0].lines_json), prep.snapshot(slip));
  });

  it('a restart a minute later does not send the preview again', () => {
    const p = plan(DAY, '20:31');
    assert.ok(p.skipped, 'skipped: ' + JSON.stringify(p));
    assert.strictEqual(rows().length, 1);
  });

  it('the same list, later, sends nothing', () => {
    assert.deepStrictEqual(plan(DAY, '21:30'), { skipped: 'unchanged' });
  });

  it('every line leads with its SKU; one without a SKU prints the name alone (§434)', () => {
    const c = prep.buildContent({
      kind: 'preview', date: NEXT, morningHour: 6,
      lines: prep.snapshot([
        { sku: '9-531', product_name: 'Pesto Wrap', product_cn: '青酱卷', qty_requested: 2 },
        { sku: null, product_name: 'Soup', product_cn: '汤', qty_requested: 1 },
      ]),
    });
    assert.ok(c.includes('> **SKU 9-531** 青酱卷 Pesto Wrap × 2'), c);
    assert.ok(c.includes('> 汤 Soup × 1'), c);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · orders after the preview');
{
  it('three more wraps within 30 minutes of the last message wait', () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 18 }]);
    landed(plan(DAY, '20:30'));
    park(ORDER + 1, [{ product_id: P_WRAP, qty: 3 }]);
    assert.deepStrictEqual(plan(DAY, '20:50'), { skipped: 'too_soon' });
  });

  it('then go as one update showing the new total and the change', () => {
    const p = plan(DAY, '21:00');
    assert.strictEqual(p.kind, 'update');
    assert.ok(p.content.includes(`**🔄 待制作已更新 · To make, updated — ${NEXT}**`), p.content);
    assert.ok(p.content.includes('> **SKU 9-531** 青酱卷 Pesto Wrap × 21 <font color="warning">(+3)</font>'), p.content);
    landed(p);
  });

  it('after midnight the update is still about the same morning', () => {
    park(ORDER + 2, [{ product_id: P_BOWL, qty: 4 }]);
    const p = plan(NEXT, '01:00');
    assert.strictEqual(p.kind, 'update');
    assert.strictEqual(p.date, NEXT);
    assert.ok(p.content.includes('> **SKU 9-532** 牛肉饭 Beef Bowl × 4 <font color="warning">(+4)</font>'), p.content);
    assert.ok(p.content.includes('> **SKU 9-531** 青酱卷 Pesto Wrap × 21'), 'unchanged lines are still listed');
    assert.ok(!/Pesto Wrap × 21 <font/.test(p.content), 'and carry no change marker');
    landed(p);
  });

  it('at the morning hour the slip takes over and the window shuts', () => {
    park(ORDER + 2, [{ product_id: P_BOWL, qty: 9 }]);
    assert.deepStrictEqual(plan(NEXT, '06:00'), { skipped: 'not_due' });
    assert.deepStrictEqual(plan(NEXT, '12:00'), { skipped: 'not_due' });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · nothing to make');
{
  it('stays quiet when nothing is owed', () => {
    baseline();
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'nothing_to_make' });
    assert.strictEqual(rows().length, 0, 'not even a row');
  });

  it('but a list that empties after a preview says so, at zero', () => {
    park(ORDER, [{ product_id: P_WRAP, qty: 5 }]);
    landed(plan(DAY, '20:30'));
    clearOrders();
    const p = plan(DAY, '21:00');
    assert.strictEqual(p.kind, 'update');
    assert.ok(p.content.includes('> 目前无需制作 · Nothing to make now'), p.content);
    assert.ok(p.content.includes('> **SKU 9-531** 青酱卷 Pesto Wrap × 0 <font color="comment">(−5)</font>'), p.content);
    landed(p);
  });

  it('and is quiet again after that', () => {
    assert.deepStrictEqual(plan(DAY, '22:00'), { skipped: 'unchanged' });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · a send that fails is retried, not forgotten');
{
  it('a failed preview is tried again after ten minutes, still as the preview', () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 7 }]);
    const p = plan(DAY, '20:30');
    prep.recordResult(db, p.id, { ok: false, msg: 'errcode 93000' });
    assert.strictEqual(rows()[0].ok, 0);
    assert.strictEqual(rows()[0].error, 'errcode 93000');
    assert.deepStrictEqual(plan(DAY, '20:35'), { skipped: 'too_soon' });
    const again = plan(DAY, '20:40');
    assert.strictEqual(again.kind, 'preview');
  });

  it('runPrepMessage sends through the injected poster and records the answer', async () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    const sent = [];
    const res = await prep.runPrepMessage(db, {
      now: at(DAY, '20:30'), tz: TZ,
      post: async (url, content) => { sent.push({ url, content }); return { ok: true }; },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].url, HOOK);
    assert.strictEqual(rows()[0].ok, 1);
  });

  it('a poster that throws is a failed row, not a crash', async () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    const res = await prep.runPrepMessage(db, {
      now: at(DAY, '20:30'), tz: TZ,
      post: async () => { throw new Error('ECONNRESET'); },
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(rows()[0].ok, 0);
    assert.strictEqual(rows()[0].error, 'ECONNRESET');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · settings');
{
  it('no webhook, or one not on qyapi.weixin.qq.com, sends nothing', () => {
    baseline();
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    setCfg(prep.KEY_WEBHOOK, '');
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'no_webhook' });
    setCfg(prep.KEY_WEBHOOK, 'https://evil.example.com/cgi-bin/webhook/send?key=x');
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'no_webhook' });
    setCfg(prep.KEY_WEBHOOK, 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x');
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'no_webhook' }, 'https only');
  });

  it('a never-saved time is 20:30; a blank one is off', () => {
    baseline();
    assert.strictEqual(prep.loadSettings(db).time, '20:30');
    setCfg(prep.KEY_TIME, '');
    assert.strictEqual(prep.loadSettings(db).time, '');
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'off' });
  });

  it('a saved time is used', () => {
    baseline();
    setCfg(prep.KEY_TIME, '19:15');
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    assert.deepStrictEqual(plan(DAY, '19:14'), { skipped: 'not_due' });
    assert.strictEqual(plan(DAY, '19:15').kind, 'preview');
  });

  it('with the morning request off there is no slip to preview, so nothing is sent', () => {
    baseline();
    setCfg('fresh.morningRequestHour', '');
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    assert.deepStrictEqual(plan(DAY, '20:30'), { skipped: 'morning_off' });
  });

  it('the preview names the morning hour actually set', () => {
    baseline();
    setCfg('fresh.morningRequestHour', 7);
    park(ORDER, [{ product_id: P_WRAP, qty: 2 }]);
    const p = plan(DAY, '20:30');
    assert.ok(p.content.includes('最终清单于 07:00 打印 · Preview — the final list prints at 07:00'), p.content);
    assert.deepStrictEqual(plan(NEXT, '07:00'), { skipped: 'not_due' });
  });

  it('only an evening time parses — before noon would blur which morning', () => {
    assert.strictEqual(prep.parseTime('20:30'), 20 * 60 + 30);
    assert.strictEqual(prep.parseTime('12:00'), 720);
    assert.strictEqual(prep.parseTime('11:59'), null);
    assert.strictEqual(prep.parseTime('24:00'), null);
    assert.strictEqual(prep.parseTime('20:60'), null);
    assert.strictEqual(prep.parseTime('8:30pm'), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · wiring, privacy and the record');
{
  // routes/retail.js and what moved out of it: PRIVATE_CONFIG_PREFIXES now sits
  // in lib/store-config.js (decisions §477).
  const retail = require('./test-support/retail-source').retailSource();
  const caps = require(path.join(ROOT, 'lib', 'cap-routes.js'));
  const html = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
  const mkt = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
  const vocab = fs.readFileSync(path.join(ROOT, 'docs/tacet-delivery-vocabulary.md'), 'utf8');
  const dec = fs.readFileSync(path.join(ROOT, 'docs/tacet-consolidation-decisions.md'), 'utf8');

  it('the kitchen. prefix is private, so the public config never serves the webhook', () => {
    const m = /const PRIVATE_CONFIG_PREFIXES = \[([^\]]*)\]/.exec(retail);
    assert.ok(m && m[1].includes("'kitchen.'"), 'kitchen. is in PRIVATE_CONFIG_PREFIXES');
    assert.ok(prep.KEY_WEBHOOK.startsWith('kitchen.') && prep.KEY_TIME.startsWith('kitchen.'));
  });

  it('the sender is started with postWecomMarkdown, injected not copied', () => {
    assert.ok(/_kprep\.startPrepMessageSweeper\(\{\s*post: postWecomMarkdown/.test(retail));
    assert.ok(!/fetch\(/.test(fs.readFileSync(path.join(ROOT, 'lib/kitchen-prep-preview.js'), 'utf8')),
      'the lib makes no network call of its own');
  });

  it('the save and the test are gated on Settings → Push\'s keys', () => {
    const want = JSON.stringify(caps.requiredCapFor('POST', '/api/retail-admin/wecom/test'));
    assert.strictEqual(JSON.stringify(caps.requiredCapFor('PUT', '/api/retail-admin/kitchen-prep-message')), want);
    assert.strictEqual(JSON.stringify(caps.requiredCapFor('POST', '/api/retail-admin/kitchen-prep-message/test')), want);
  });

  it('the card is on the Push page and loads with it', () => {
    assert.ok(html.includes('id="kprep-card"'));
    assert.ok(/loadWecomApp\(\);\s*loadKitchenPrep\(\);/.test(mkt));
  });

  it('every composed Chinese string is shipped and declared', () => {
    const composed = [
      '待制作已更新', '预览,最终清单于', '目前无需制作', '收到本条说明晚间待制作消息已接通',
      '厨房:晚间待制作消息', '请使用与新订单提醒不同的群。', '时间留空则关闭。',
      '请输入 12:00–23:59 之间的时间', '因此不会发送',
    ];
    const shipped = retail + html + mkt + fs.readFileSync(path.join(ROOT, 'lib/kitchen-prep-preview.js'), 'utf8');
    for (const s of composed) {
      assert.ok(shipped.includes(s), 'shipped: ' + s);
      assert.ok(vocab.includes(s), 'declared in the vocabulary: ' + s);
    }
  });

  it('§432 is recorded in the decisions file', () => {
    assert.ok(/## §432 — /.test(dec));
    assert.ok(dec.includes('kitchen.prep_webhook'), 'the config key is named in the record');
  });
}

// ── Run, then tear down ────────────────────────────────────────────────────
(async () => {
  for (const q of queue) {
    if (q.section) { console.log('\n' + q.section); continue; }
    try { await q.fn(); console.log(`  ✓ ${q.name}`); pass++; }
    catch (e) { console.log(`  ✗ ${q.name}\n      ${e.message}`); fail++; }
  }
  clearOrders(); clearMessages();
  for (const [k, v] of Object.entries(SAVED)) setCfg(k, v);
  db.prepare('DELETE FROM store_products WHERE id IN (?,?)').run(P_WRAP, P_BOWL);
  db.prepare('DELETE FROM retail_stores WHERE id = ?').run(STORE);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
